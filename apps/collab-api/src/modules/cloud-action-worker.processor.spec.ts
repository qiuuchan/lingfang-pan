import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../common';
import { CloudActionWorkerProcessor } from './cloud-action-worker.processor';

const job = { run_id: 'run-1', attempt_id: 'attempt-1', invocation_id: 'invocation-1', plan_sha256: 'a'.repeat(64) };
function row(overrides: Record<string, unknown> = {}) {
  return { id: 'attempt-1', runId: 'run-1', actionInvocationId: 'invocation-1', status: 'RUNNING', executionSemantics: 'read_only', run: { id: 'run-1', status: 'RUNNING', executionTarget: 'CLOUD', planSha256: job.plan_sha256, principalUserId: 'user-1', deadlineAt: new Date(Date.now() + 60_000) }, ...overrides };
}
function harness(attempt = row()) {
  const prisma: any = { workflowStepAttempt: { findUnique: vi.fn(async ({ select }: any) => select ? { status: attempt.status } : attempt) } };
  const invocations: any = { claim: vi.fn(async () => ({})), completeCloudWorkflowAttempt: vi.fn(async () => ({ ok: true })), failCloudWorkflowAttempt: vi.fn(async () => ({ ok: true })), cancelCloudWorkflowAttempt: vi.fn(async () => ({ ok: true })) };
  const gateway: any = { invoke: vi.fn(async () => ({ output: { ok: true }, request_bytes: 12, response_bytes: 8, endpoint_http_status: 200 })) };
  return { processor: new CloudActionWorkerProcessor(prisma, invocations, gateway), prisma, invocations, gateway };
}

describe('CloudActionWorkerProcessor', () => {
  it('claims through ActionInvocationService, invokes only the gateway, then settles success', async () => {
    const h = harness();
    await expect(h.processor.process(job)).resolves.toEqual({ outcome: 'SUCCEEDED', attempt_id: 'attempt-1' });
    expect(h.invocations.claim).toHaveBeenCalledWith('user-1', 'invocation-1');
    expect(h.gateway.invoke).toHaveBeenCalledTimes(1);
    expect(h.invocations.completeCloudWorkflowAttempt).toHaveBeenCalledWith('user-1', 'invocation-1', 'attempt-1', { ok: true }, { requestBytes: 12, responseBytes: 8, endpointHttpStatus: 200 });
  });

  it('cancels before claim when the frozen run is closing', async () => {
    const h = harness(row({ run: { ...row().run, status: 'CANCELING' } }));
    await expect(h.processor.process(job)).resolves.toEqual({ outcome: 'CANCELED', attempt_id: 'attempt-1' });
    expect(h.invocations.cancelCloudWorkflowAttempt).toHaveBeenCalledOnce();
    expect(h.invocations.claim).not.toHaveBeenCalled();
    expect(h.gateway.invoke).not.toHaveBeenCalled();
  });

  it('marks uncertain side effects failed without any automatic retry or second gateway call', async () => {
    const h = harness(row({ executionSemantics: 'side_effect' }));
    h.gateway.invoke.mockRejectedValue(new AppError(504, 'cloud_timeout', 'timeout'));
    await expect(h.processor.process(job)).resolves.toEqual({ outcome: 'RESULT_UNKNOWN', attempt_id: 'attempt-1' });
    expect(h.gateway.invoke).toHaveBeenCalledTimes(1);
    expect(h.invocations.failCloudWorkflowAttempt).toHaveBeenCalledWith('user-1', 'invocation-1', 'attempt-1', expect.objectContaining({ code: 'cloud_result_unknown', outcome: 'RESULT_UNKNOWN' }));
    expect(h.invocations.completeCloudWorkflowAttempt).not.toHaveBeenCalled();
  });

  it('rejects tampered job relationships before claim or gateway execution', async () => {
    const h = harness();
    await expect(h.processor.process({ ...job, plan_sha256: 'b'.repeat(64) })).rejects.toMatchObject({ code: 'cloud_endpoint_target_mismatch' });
    expect(h.invocations.claim).not.toHaveBeenCalled();
    expect(h.gateway.invoke).not.toHaveBeenCalled();
  });
});
