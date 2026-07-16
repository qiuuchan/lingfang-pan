import { describe, expect, it, vi } from 'vitest';
import { WorkflowRunService } from './workflow-run.service';
const release = { id: 'wr1', sha256: 'a'.repeat(64), status: 'PUBLISHED' };
const target = (id: string) => ({ package_id: `p-${id}`, release_id: `r-${id}`, sha256: 'b'.repeat(64), action_id: id, action_contract_version: '1.0.0', action_surface_sha256: 'c'.repeat(64) });
const schema = { type: 'object', properties: {}, required: [], additionalProperties: false };
const definition = { definition_version: '1', input_schema: schema, output_schema: schema, nodes: [{ node_id: 'image', declared_version_range: '^1.0.0', depends_on: [], input_bindings: [], retry_limit: 0, target: target('image') }, { node_id: 'video', declared_version_range: '^1.0.0', depends_on: ['image'], input_bindings: [], retry_limit: 0, target: target('video') }, { node_id: 'music', declared_version_range: '^1.0.0', depends_on: ['image'], input_bindings: [], retry_limit: 0, target: target('music') }], output_bindings: [] };
const plan = { plan_version: '1', workflow_release_id: 'wr1', workflow_release_sha256: release.sha256, definition_sha256: 'd'.repeat(64), execution_target: 'DESKTOP', execution_scope: 'PRODUCTION', max_parallelism: 3, nodes: definition.nodes.map((node) => ({ ...node, execution_semantics: 'read_only', cloud_capable: true })), output_bindings: [], desktop_executor: { session_id: 's1', inventory_sha256: 'e'.repeat(64) } };
const runRow = (attempts: unknown[] = []) => ({ id: 'run1', teamId: 't1', principalUserId: 'u1', workflowReleaseId: 'wr1', executionScope: 'PRODUCTION', executionTarget: 'DESKTOP', status: 'RUNNING', requestScopeSha256: 'f'.repeat(64), idempotencyKey: 'k1', requestDigest: '1'.repeat(64), inputDigest: '2'.repeat(64), rootLogicalExecutionId: 'run1', planSha256: '3'.repeat(64), frozenPlan: plan, input: {}, output: null, policyRevision: 2, authorizationDecision: {}, rootRunId: null, parentStepAttemptId: null, triggerKind: 'MANUAL', deadlineAt: new Date('2099-01-01T00:00:00.000Z'), resultRetainUntil: new Date('2099-01-08T00:00:00.000Z'), desktopExecutorSessionId: 's1', desktopInventorySha256: 'e'.repeat(64), startedAt: new Date('2026-07-16T00:00:00.000Z'), completedAt: null, errorCode: '', errorMessage: '', createdAt: new Date('2026-07-16T00:00:00.000Z'), updatedAt: new Date('2026-07-16T00:00:00.000Z'), attempts });
describe('WorkflowRunService', () => {
  it('authorizes root once and creates image READY with video/music pending', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'run1' }); const findFirst = vi.fn().mockResolvedValue(runRow());
    const prisma = { workflowRelease: { findUnique: vi.fn().mockResolvedValue({ pluginReleaseId: 'wr1', definitionSha256: 'd'.repeat(64), definitionJson: definition, cloudEligible: true, maxParallelism: 3, pluginRelease: release, nodes: definition.nodes.map((node) => ({ nodeId: node.node_id, declaredVersionRange: '^1.0.0', executionSemantics: 'read_only', cloudCapable: true })) }) }, workflowRun: { findUnique: vi.fn().mockResolvedValue(null), create, findFirst }, $transaction: vi.fn(async (fn: any) => fn({ workflowRun: { create }, automationOutbox: { create: vi.fn() }, automationSchedule: { updateMany: vi.fn() } })) };
    const authorizeRelease = vi.fn().mockResolvedValue({ decision: { policy_revision: 2 } });
    const service = new WorkflowRunService(prisma as never, { ensureCurrentTeam: vi.fn().mockResolvedValue({ teamId: 't1' }) } as never, { authorizeRelease } as never, {} as never, { validate: vi.fn().mockResolvedValue({ id: 's1', inventorySha256: 'd'.repeat(64) }) } as never);
    await service.start('u1', { workflow_release_id: 'wr1', sha256: release.sha256, execution_target: 'DESKTOP', execution_scope: 'PRODUCTION', input: {}, idempotency_key: 'k1', deadline_at: '2099-01-01T00:00:00.000Z' });
    expect(authorizeRelease).toHaveBeenCalledOnce(); const attempts = create.mock.calls[0][0].data.attempts.create as Array<{ nodeId: string; status: string }>; expect(attempts.map((item) => [item.nodeId, item.status])).toEqual([['image', 'READY'], ['video', 'PENDING'], ['music', 'PENDING']]);
  });
  it('creates a new attempt for a retryable read-only failure', async () => {
    const attempt = { id: 'a1', runId: 'run1', nodeId: 'image', fullNodePath: 'image', attempt: 0, status: 'RUNNING', actionInvocationId: 'i1', executionSemantics: 'read_only', retryLimit: 2, effectKey: null, packageId: 'p', releaseId: 'r', releaseSha256: 'a'.repeat(64), actionId: 'image', actionContractVersion: '1.0.0', actionSurfaceSha256: 'b'.repeat(64), run: { id: 'run1', status: 'RUNNING', rootLogicalExecutionId: 'root1' } };
    const create = vi.fn().mockResolvedValue({}); const prisma = { workflowStepAttempt: { findUnique: vi.fn().mockResolvedValue(attempt), updateMany: vi.fn().mockResolvedValue({ count: 1 }), create }, workflowRun: { findFirst: vi.fn().mockResolvedValue(runRow()) } };
    const service = new WorkflowRunService(prisma as never, { ensureCurrentTeam: vi.fn().mockResolvedValue({ teamId: 't1' }) } as never, {} as never, { failWorkflowAttempt: vi.fn().mockResolvedValue({}) } as never, {} as never);
    await service.failStep('u1', 'a1', 'action_execution_failed', 'failed');
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ attempt: 1, status: 'READY', requestKey: 'run1:image:1' }) });
  });
  it('lists team runs through the snake_case summary serializer', async () => {
    const findMany = vi.fn().mockResolvedValue([runRow()]);
    const service = new WorkflowRunService({ workflowRun: { findMany } } as never, { ensureCurrentTeam: vi.fn().mockResolvedValue({ teamId: 't1' }) } as never, {} as never, {} as never, {} as never);
    const result = await service.list('u1', { limit: 20, status: 'RUNNING' });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { teamId: 't1', status: 'RUNNING' }, take: 21 }));
    expect(result).toEqual({ runs: [expect.objectContaining({ id: 'run1', workflow_release_id: 'wr1', execution_target: 'DESKTOP', attempt_counts: expect.any(Object), created_at: '2026-07-16T00:00:00.000Z' })], next_cursor: null });
    expect(result.runs[0]).not.toHaveProperty('authorizationDecision');
    expect(result.runs[0]).not.toHaveProperty('requestDigest');
    expect(result.runs[0]).not.toHaveProperty('desktopExecutorSessionId');
  });
  it('returns a non-writing preflight plan and stable diagnostics', async () => {
    const workflow = { pluginReleaseId: 'wr1', definitionSha256: 'd'.repeat(64), definitionJson: definition, cloudEligible: true, maxParallelism: 3, pluginRelease: release, nodes: definition.nodes.map((node) => ({ nodeId: node.node_id, declaredVersionRange: '^1.0.0', executionSemantics: 'read_only', cloudCapable: true })) };
    const authorizeRelease = vi.fn().mockResolvedValue({ decision: { policy_revision: 2 } });
    const service = new WorkflowRunService({ workflowRelease: { findUnique: vi.fn().mockResolvedValue(workflow) } } as never, { ensureCurrentTeam: vi.fn().mockResolvedValue({ teamId: 't1' }) } as never, { authorizeRelease } as never, {} as never, {} as never);
    const result = await service.preflight('u1', { workflow_release_id: 'wr1', sha256: release.sha256, execution_target: 'CLOUD', execution_scope: 'PRODUCTION', input: {}, deadline_at: '2099-01-01T00:00:00.000Z' });
    expect(result.eligible).toBe(true);
    expect(result.plan).toEqual(expect.objectContaining({ plan_version: '1', workflow_release_id: 'wr1', execution_target: 'CLOUD', desktop_executor: null }));
    expect(result.diagnostics).toEqual([]);
    expect(authorizeRelease).toHaveBeenCalledOnce();
  });
  it('fires a schedule with one compound policy decision and atomically writes run plus outbox', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'scheduled-run' }); const outboxCreate = vi.fn().mockResolvedValue({});
    const workflow = { pluginReleaseId: 'wr1', definitionSha256: 'd'.repeat(64), definitionJson: definition, cloudEligible: true, maxParallelism: 3, pluginRelease: release, nodes: definition.nodes.map((node) => ({ nodeId: node.node_id, declaredVersionRange: '^1.0.0', executionSemantics: 'read_only', cloudCapable: true })) };
    const prisma = { workflowRelease: { findUnique: vi.fn().mockResolvedValue(workflow) }, workflowRun: { findUnique: vi.fn().mockResolvedValue(null), findFirst: vi.fn().mockResolvedValue(runRow()), create }, $transaction: vi.fn(async (fn: any) => fn({ workflowRun: { create }, automationOutbox: { create: outboxCreate }, automationSchedule: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) } })) };
    const authorizeRelease = vi.fn().mockResolvedValue({ decision: { policy_revision: 2 } });
    const cloudRouting = { freeze: vi.fn(async (_user: string, _target: unknown, environment: string, _run: string, node: string) => ({ node_path: node, deployment_id: `dep-${node}`, routing_generation: 1, environment })) };
    const service = new WorkflowRunService(prisma as never, { ensureCurrentTeam: vi.fn().mockResolvedValue({ teamId: 't1' }) } as never, { authorizeRelease } as never, {} as never, {} as never, cloudRouting as never);
    await service.startScheduled('u1', { id: 'schedule-1', teamId: 't1', generation: 4, workflowReleaseId: 'wr1', workflowReleaseSha256: release.sha256, inputJson: {}, kind: 'DAILY' }, new Date('2026-07-20T10:00:00.000Z'), 'occurrence-1');
    expect(authorizeRelease).toHaveBeenCalledTimes(1);
    expect(authorizeRelease.mock.calls[0][2]).toEqual(['execute_cloud', 'run_workflow', 'trigger_schedule']);
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ triggerKind: 'SCHEDULE', scheduleId: 'schedule-1', scheduleGeneration: 4, occurrenceKey: 'occurrence-1' }) });
    expect(outboxCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ kind: 'ENQUEUE_RUN', generation: 4 }) });
  });
  it('creates a nested child from the immutable subplan and inherits trusted execution context', async () => {
    const childNode = { ...definition.nodes[0], node_id: 'leaf', target: target('leaf'), execution_semantics: 'idempotent', cloud_capable: true };
    const subplan = { workflow_release_id: 'child-workflow', workflow_release_sha256: '9'.repeat(64), definition_sha256: '8'.repeat(64), max_parallelism: 1, nodes: [childNode], output_bindings: [] };
    const rootPlan = { ...plan, workflow_subplans: [subplan] };
    const parentAttempt = { id: 'parent-attempt', runId: 'run1', nodeId: 'child', fullNodePath: 'child', attempt: 0 };
    const create = vi.fn().mockResolvedValue({ id: 'child-run' });
    const service = new WorkflowRunService({ workflowRun: { findUnique: vi.fn().mockResolvedValue(null), create } } as never, {} as never, {} as never, {} as never, {} as never);
    const parent = { ...runRow(), frozenPlan: rootPlan, rootLogicalExecutionId: 'root-logical', authorizationDecision: { inherited: true }, cloudBindings: [] };

    const childRunId = await (service as any).createChildRun(parent, parentAttempt, { prompt: 'demo' }, subplan, rootPlan);

    expect(childRunId).toBe('child-run');
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({
      workflowReleaseId: 'child-workflow',
      principalUserId: 'u1',
      executionTarget: 'DESKTOP',
      executionScope: 'PRODUCTION',
      rootRunId: 'run1',
      parentStepAttemptId: 'parent-attempt',
      desktopExecutorSessionId: 's1',
      desktopInventorySha256: 'e'.repeat(64),
      authorizationDecision: { inherited: true },
      attempts: { create: [expect.objectContaining({ nodeId: 'leaf', fullNodePath: 'child/leaf', effectKey: 'root-logical:child/leaf' })] },
    }) });
  });
});
