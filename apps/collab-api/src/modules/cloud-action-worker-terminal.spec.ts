import { describe, expect, it, vi } from 'vitest';
import { ActionInvocationService } from './action-invocation.service';

function harness() {
  const invocation = {
    id: 'inv-1',
    teamId: 'team-1',
    status: 'RUNNING',
    cloudDeploymentId: 'dep-1',
    packageId: 'pkg-1',
    releaseId: 'rel-1',
    releaseSha256: 'a'.repeat(64),
    actionId: 'generate',
    actionContractVersion: '1.0.0',
    actionSurfaceSha256: 'b'.repeat(64),
    executionBinding: {
      output_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['url'],
        properties: { url: { type: 'string' } },
      },
    },
    startedAt: new Date(Date.now() - 20),
  };
  const attempt = { id: 'attempt-1', status: 'RUNNING', run: { executionScope: 'PRODUCTION' } };
  const invocationUpdate = vi.fn(async () => ({ count: 1 }));
  const attemptUpdate = vi.fn(async () => ({ count: 1 }));
  const usageCreate = vi.fn(async ({ data }: any) => data);
  const tx: any = {
    actionInvocation: { findFirst: vi.fn(async () => invocation), updateMany: invocationUpdate },
    workflowStepAttempt: { findFirst: vi.fn(async () => attempt), updateMany: attemptUpdate },
    cloudUsageEvent: { create: usageCreate },
  };
  const prisma: any = { $transaction: vi.fn(async (fn: any) => fn(tx)) };
  const service = new ActionInvocationService(
    prisma,
    { ensureCurrentTeam: vi.fn(async () => ({ teamId: 'team-1' })) } as never,
    {} as never
  );
  return { service, invocationUpdate, attemptUpdate, usageCreate };
}

describe('ActionInvocationService Cloud terminal transaction', () => {
  it('CAS-completes invocation and attempt and appends usage in one transaction', async () => {
    const h = harness();
    await h.service.completeCloudWorkflowAttempt(
      'user-1',
      'inv-1',
      'attempt-1',
      { url: 'artifact://result' },
      { requestBytes: 10, responseBytes: 20, endpointHttpStatus: 200 }
    );
    expect(h.invocationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { in: ['RUNNING'] } }),
        data: expect.objectContaining({ status: 'SUCCEEDED' }),
      })
    );
    expect(h.attemptUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'RUNNING' }),
        data: expect.objectContaining({ status: 'SUCCEEDED', deliveryState: 'DELIVERED' }),
      })
    );
    expect(h.usageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sourceKind: 'WORKFLOW_ATTEMPT',
          sourceId: 'attempt-1',
          deploymentId: 'dep-1',
          outcome: 'SUCCEEDED',
        }),
      })
    );
  });

  it('CAS-fails result-unknown side effects and records UNKNOWN delivery usage', async () => {
    const h = harness();
    await h.service.failCloudWorkflowAttempt('user-1', 'inv-1', 'attempt-1', {
      code: 'cloud_result_unknown',
      message: 'unknown',
      outcome: 'RESULT_UNKNOWN',
    });
    expect(h.invocationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED', errorCode: 'cloud_result_unknown' }),
      })
    );
    expect(h.attemptUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED', deliveryState: 'UNKNOWN' }),
      })
    );
    expect(h.usageCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ outcome: 'RESULT_UNKNOWN' }) })
    );
  });

  it('CAS-cancels both records and writes canceled usage', async () => {
    const h = harness();
    await h.service.cancelCloudWorkflowAttempt('user-1', 'inv-1', 'attempt-1');
    expect(h.invocationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'CANCELED' }) })
    );
    expect(h.attemptUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'CANCELED' }) })
    );
    expect(h.usageCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ outcome: 'CANCELED' }) })
    );
  });
});
