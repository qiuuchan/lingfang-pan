import { Graph, alg } from '@dagrejs/graphlib';
import {
  WorkflowDefinitionV1,
  WORKFLOW_MAX_EXPANDED_NODES,
  WORKFLOW_MAX_NESTING_DEPTH,
  WORKFLOW_MAX_PARALLEL,
  type WorkflowBinding,
  type WorkflowDefinitionV1 as Definition,
  type WorkflowFrozenSubplan,
} from '@lingfang/contract/src/plugin-workflow.ts';

export type WorkflowDiagnostic = { code: string; path: string; message: string };
export type WorkflowPlan = { definition: Definition; order: string[]; ready_sets: string[][]; max_parallelism: number };
export type WorkflowClosureRelease = WorkflowFrozenSubplan;
export type WorkflowClosureDiagnostic = WorkflowDiagnostic & { release_path: string[] };
export type WorkflowClosureResult = {
  subplans: WorkflowFrozenSubplan[];
  expanded_node_count: number;
  diagnostics: WorkflowClosureDiagnostic[];
};
const RESERVED_TYPES = new Set(['artifact_ref', 'platform_credential_ref', 'runtime_artifact_grant', 'runtime_artifact_hold']);

export function buildWorkflowPlan(input: unknown): { plan?: WorkflowPlan; diagnostics: WorkflowDiagnostic[] } {
  const parsed = WorkflowDefinitionV1.safeParse(input);
  if (!parsed.success) return { diagnostics: parsed.error.issues.map((issue) => ({ code: 'workflow_invalid', path: issue.path.join('.'), message: issue.message })) };
  const definition = parsed.data; const diagnostics: WorkflowDiagnostic[] = []; const graph = new Graph({ directed: true });
  definition.nodes.forEach((node) => graph.setNode(node.node_id));
  definition.nodes.forEach((node) => node.depends_on.forEach((dependency) => graph.setEdge(dependency, node.node_id)));
  if (!alg.isAcyclic(graph)) diagnostics.push({ code: 'workflow_cycle_detected', path: 'nodes', message: `workflow contains a cycle: ${alg.findCycles(graph).map((cycle) => cycle.join(' -> ')).join('; ')}` });
  definition.nodes.forEach((node, index) => node.input_bindings.forEach((binding, bindingIndex) => {
    if (binding.source.kind === 'node_output' && !node.depends_on.includes(binding.source.node_id)) diagnostics.push({ code: 'workflow_mapping_invalid', path: `nodes.${index}.input_bindings.${bindingIndex}`, message: 'node output source must be an explicit dependency' });
    if (binding.source.kind === 'literal' && containsReservedIdentity(binding.source.value)) diagnostics.push({ code: 'workflow_mapping_invalid', path: `nodes.${index}.input_bindings.${bindingIndex}.source.value`, message: 'literal contains a reserved runtime identity' });
  }));
  definition.output_bindings.forEach((binding, index) => { if (binding.source.kind === 'literal' && containsReservedIdentity(binding.source.value)) diagnostics.push({ code: 'workflow_mapping_invalid', path: `output_bindings.${index}.source.value`, message: 'literal contains a reserved runtime identity' }); });
  findPointerConflicts(definition).forEach((path) => diagnostics.push({ code: 'workflow_mapping_invalid', path, message: 'target JSON pointers overlap' }));
  if (diagnostics.length) return { diagnostics };
  const order = alg.topsort(graph); const readySets = topologicalReadySets(graph);
  if (readySets.some((set) => set.length > WORKFLOW_MAX_PARALLEL)) return { diagnostics: [{ code: 'workflow_limit_exceeded', path: 'nodes', message: `workflow requires more than ${WORKFLOW_MAX_PARALLEL} parallel nodes` }] };
  return { plan: { definition, order, ready_sets: readySets, max_parallelism: Math.max(...readySets.map((set) => set.length)) }, diagnostics: [] };
}

/**
 * Resolves the exact workflow-release closure used by publish/preflight.
 * The resolver returns null for ordinary action releases. Ranges are never
 * passed to it: traversal follows only each node's frozen target.release_id.
 */
export async function buildWorkflowClosure(
  root: WorkflowClosureRelease,
  resolveWorkflow: (releaseId: string) => WorkflowClosureRelease | null | Promise<WorkflowClosureRelease | null>,
): Promise<WorkflowClosureResult> {
  const diagnostics: WorkflowClosureDiagnostic[] = [];
  const subplans = new Map<string, WorkflowFrozenSubplan>();
  let expandedNodeCount = 0;

  const visit = async (workflow: WorkflowClosureRelease, path: string[], nestedDepth: number): Promise<void> => {
    if (nestedDepth > WORKFLOW_MAX_NESTING_DEPTH) {
      diagnostics.push({
        code: 'workflow_limit_exceeded',
        path: 'nodes',
        message: `workflow nesting exceeds ${WORKFLOW_MAX_NESTING_DEPTH}: ${path.join(' -> ')}`,
        release_path: path,
      });
      return;
    }
    expandedNodeCount += workflow.nodes.length;
    if (expandedNodeCount > WORKFLOW_MAX_EXPANDED_NODES) {
      diagnostics.push({
        code: 'workflow_limit_exceeded',
        path: 'nodes',
        message: `expanded workflow contains more than ${WORKFLOW_MAX_EXPANDED_NODES} nodes: ${path.join(' -> ')}`,
        release_path: path,
      });
      return;
    }
    for (const node of workflow.nodes) {
      const child = await resolveWorkflow(node.target.release_id);
      if (!child) continue;
      const childPath = [...path, child.workflow_release_id];
      if (path.includes(child.workflow_release_id)) {
        diagnostics.push({
          code: 'workflow_recursion',
          path: `nodes.${node.node_id}`,
          message: `workflow dependency cycle: ${childPath.join(' -> ')}`,
          release_path: childPath,
        });
        continue;
      }
      if (!subplans.has(child.workflow_release_id)) subplans.set(child.workflow_release_id, child);
      await visit(child, childPath, nestedDepth + 1);
    }
  };

  await visit(root, [root.workflow_release_id], 0);
  return {
    subplans: [...subplans.values()].sort((left, right) => left.workflow_release_id.localeCompare(right.workflow_release_id)),
    expanded_node_count: expandedNodeCount,
    diagnostics,
  };
}

export function readyWorkflowNodes(definition: Definition, states: Record<string, string>): string[] { return definition.nodes.filter((node) => states[node.node_id] === 'PENDING' && node.depends_on.every((id) => states[id] === 'SUCCEEDED')).map((node) => node.node_id).sort(); }
export type WorkflowReducerState = { status: 'RUNNING' | 'FAILING' | 'CANCELING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED'; nodes: Record<string, { status: 'PENDING' | 'READY' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED' | 'CANCELED'; attempt: number; retry_limit: number; execution_semantics: 'read_only' | 'idempotent' | 'side_effect' }> };
export type WorkflowReducerEvent = { type: 'step_succeeded'; node_id: string } | { type: 'step_failed'; node_id: string; retryable: boolean } | { type: 'cancel_requested' } | { type: 'closing_settled' };
export type WorkflowReducerEffect = { type: 'retry'; node_id: string; attempt: number } | { type: 'cancel_running'; node_ids: string[] } | { type: 'skip_pending'; node_ids: string[] };
export function reduceWorkflowRun(state: WorkflowReducerState, event: WorkflowReducerEvent): { state: WorkflowReducerState; effects: WorkflowReducerEffect[] } {
  const next = structuredClone(state); const effects: WorkflowReducerEffect[] = [];
  if (['SUCCEEDED', 'FAILED', 'CANCELED'].includes(next.status)) return { state: next, effects };
  if (event.type === 'step_succeeded') { const node = next.nodes[event.node_id]; if (node?.status === 'RUNNING') node.status = 'SUCCEEDED'; if (next.status === 'RUNNING' && Object.values(next.nodes).every((item) => item.status === 'SUCCEEDED')) next.status = 'SUCCEEDED'; }
  if (event.type === 'step_failed') { const node = next.nodes[event.node_id]; if (node?.status !== 'RUNNING') return { state: next, effects }; node.status = 'FAILED'; const canRetry = event.retryable && node.execution_semantics !== 'side_effect' && node.attempt < node.retry_limit && next.status === 'RUNNING'; if (canRetry) { node.attempt += 1; node.status = 'READY'; effects.push({ type: 'retry', node_id: event.node_id, attempt: node.attempt }); } else { next.status = 'FAILING'; const pending = Object.entries(next.nodes).filter(([, item]) => item.status === 'PENDING' || item.status === 'READY').map(([id]) => id); const running = Object.entries(next.nodes).filter(([, item]) => item.status === 'RUNNING').map(([id]) => id); pending.forEach((id) => { next.nodes[id].status = 'SKIPPED'; }); effects.push({ type: 'skip_pending', node_ids: pending }, { type: 'cancel_running', node_ids: running }); } }
  if (event.type === 'cancel_requested' && next.status === 'RUNNING') { next.status = 'CANCELING'; const pending = Object.entries(next.nodes).filter(([, item]) => item.status === 'PENDING' || item.status === 'READY').map(([id]) => id); const running = Object.entries(next.nodes).filter(([, item]) => item.status === 'RUNNING').map(([id]) => id); pending.forEach((id) => { next.nodes[id].status = 'CANCELED'; }); effects.push({ type: 'skip_pending', node_ids: pending }, { type: 'cancel_running', node_ids: running }); }
  if (event.type === 'closing_settled' && Object.values(next.nodes).every((item) => !['PENDING', 'READY', 'RUNNING'].includes(item.status))) { if (next.status === 'FAILING') next.status = 'FAILED'; if (next.status === 'CANCELING') next.status = 'CANCELED'; }
  return { state: next, effects };
}
export function materializeBindings(bindings: WorkflowBinding[], workflowInput: unknown, nodeOutputs: Record<string, unknown>): unknown { let result: unknown = {}; for (const binding of bindings) { const value = binding.source.kind === 'literal' ? structuredClone(binding.source.value) : binding.source.kind === 'workflow_input' ? pointerGet(workflowInput, binding.source.source_pointer) : pointerGet(nodeOutputs[binding.source.node_id], binding.source.source_pointer); result = pointerSet(result, binding.target_pointer, value); } return result; }

function topologicalReadySets(graph: Graph): string[][] { const pending = new Set(graph.nodes()); const done = new Set<string>(); const sets: string[][] = []; while (pending.size) { const ready = [...pending].filter((node) => (graph.predecessors(node) ?? []).every((dependency) => done.has(dependency))).sort(); if (!ready.length) break; sets.push(ready); ready.forEach((node) => { pending.delete(node); done.add(node); }); } return sets; }
function containsReservedIdentity(value: unknown): boolean { if (Array.isArray(value)) return value.some(containsReservedIdentity); if (!value || typeof value !== 'object') return false; const record = value as Record<string, unknown>; if (typeof record.type === 'string' && RESERVED_TYPES.has(record.type)) return true; return Object.values(record).some(containsReservedIdentity); }
function findPointerConflicts(definition: Definition): string[] { const conflicts: string[] = []; const check = (bindings: WorkflowBinding[], prefix: string) => { const pointers = bindings.map((binding) => binding.target_pointer); pointers.forEach((pointer, index) => pointers.slice(index + 1).forEach((other) => { if (pointer === other || pointer.startsWith(`${other}/`) || other.startsWith(`${pointer}/`)) conflicts.push(`${prefix}.${index}.target_pointer`); })); }; definition.nodes.forEach((node, index) => check(node.input_bindings, `nodes.${index}.input_bindings`)); check(definition.output_bindings, 'output_bindings'); return conflicts; }
function decodePointer(pointer: string): string[] { return pointer === '' ? [] : pointer.slice(1).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~')); }
function pointerGet(value: unknown, pointer: string): unknown { let current = value; for (const part of decodePointer(pointer)) { if (!current || typeof current !== 'object' || !(part in current)) throw new Error(`JSON pointer does not exist: ${pointer}`); current = (current as Record<string, unknown>)[part]; } return structuredClone(current); }
function pointerSet(root: unknown, pointer: string, value: unknown): unknown { const parts = decodePointer(pointer); if (!parts.length) return structuredClone(value); const result = root && typeof root === 'object' ? root as Record<string, unknown> : {}; let current = result; parts.forEach((part, index) => { if (index === parts.length - 1) current[part] = structuredClone(value); else { const next = current[part]; current[part] = next && typeof next === 'object' && !Array.isArray(next) ? next : {}; current = current[part] as Record<string, unknown>; } }); return result; }
