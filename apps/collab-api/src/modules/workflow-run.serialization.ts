import type {
  WorkflowExecutionPlan,
  WorkflowJsonValue,
  WorkflowRunDetail,
  WorkflowRunSummary,
  WorkflowStepAttemptDTO,
} from '@lingfang/contract';
import type { Prisma } from '@prisma/client';

export type WorkflowRunWithAttempts = Prisma.WorkflowRunGetPayload<{
  include: { attempts: true };
}>;

function jsonValue(value: Prisma.JsonValue | null): WorkflowJsonValue | null {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Workflow JSON contains a non-finite number');
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => jsonValue(item) as WorkflowJsonValue);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (item === undefined) throw new Error(`Workflow JSON contains undefined at ${key}`);
    return [key, jsonValue(item) as WorkflowJsonValue];
  }));
}

function runError(code: string, message: string): WorkflowRunSummary['error'] {
  if (!code && !message) return null;
  return { code, message };
}

function attemptCounts(attempts: WorkflowRunWithAttempts['attempts']): WorkflowRunSummary['attempt_counts'] {
  const counts: WorkflowRunSummary['attempt_counts'] = {
    pending: 0,
    ready: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    canceled: 0,
  };
  for (const attempt of attempts) {
    switch (attempt.status) {
      case 'PENDING': counts.pending += 1; break;
      case 'READY': counts.ready += 1; break;
      case 'RUNNING': counts.running += 1; break;
      case 'SUCCEEDED': counts.succeeded += 1; break;
      case 'FAILED': counts.failed += 1; break;
      case 'SKIPPED': counts.skipped += 1; break;
      case 'CANCELED': counts.canceled += 1; break;
    }
  }
  return counts;
}

function triggerKind(value: string): WorkflowRunSummary['trigger_kind'] {
  if (value === 'MANUAL' || value === 'SCHEDULE') return value;
  throw new Error(`Unsupported workflow trigger kind: ${value}`);
}

export function publicWorkflowRunSummary(row: WorkflowRunWithAttempts): WorkflowRunSummary {
  return {
    id: row.id,
    workflow_release_id: row.workflowReleaseId,
    root_run_id: row.rootRunId,
    parent_step_attempt_id: row.parentStepAttemptId,
    execution_target: row.executionTarget,
    execution_scope: row.executionScope,
    trigger_kind: triggerKind(row.triggerKind),
    status: row.status,
    plan_sha256: row.planSha256,
    attempt_counts: attemptCounts(row.attempts),
    deadline_at: row.deadlineAt.toISOString(),
    result_retain_until: row.resultRetainUntil.toISOString(),
    created_at: row.createdAt.toISOString(),
    started_at: row.startedAt?.toISOString() ?? null,
    completed_at: row.completedAt?.toISOString() ?? null,
    error: runError(row.errorCode, row.errorMessage),
  };
}

export function publicWorkflowStepAttempt(row: WorkflowRunWithAttempts['attempts'][number]): WorkflowStepAttemptDTO {
  return {
    id: row.id,
    run_id: row.runId,
    node_id: row.nodeId,
    full_node_path: row.fullNodePath,
    attempt_number: row.attempt,
    status: row.status,
    target: {
      package_id: row.packageId,
      release_id: row.releaseId,
      sha256: row.releaseSha256,
      action_id: row.actionId,
      action_contract_version: row.actionContractVersion,
      action_surface_sha256: row.actionSurfaceSha256,
    },
    execution_semantics: row.executionSemantics as WorkflowStepAttemptDTO['execution_semantics'],
    retry_limit: row.retryLimit,
    action_invocation_id: row.actionInvocationId,
    request_idempotency_key: row.requestKey,
    effect_idempotency_key: row.effectKey,
    output: jsonValue(row.output),
    created_at: row.createdAt.toISOString(),
    started_at: row.startedAt?.toISOString() ?? null,
    completed_at: row.completedAt?.toISOString() ?? null,
    error: runError(row.errorCode, row.errorMessage),
  };
}

export function publicWorkflowRunDetail(row: WorkflowRunWithAttempts): WorkflowRunDetail {
  return {
    ...publicWorkflowRunSummary(row),
    input: jsonValue(row.input) as WorkflowJsonValue,
    output: jsonValue(row.output),
    plan: jsonValue(row.frozenPlan) as WorkflowExecutionPlan,
    attempts: row.attempts.map(publicWorkflowStepAttempt),
  };
}
