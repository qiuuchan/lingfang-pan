import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { ActionInvocationService } from './action-invocation.service';
const target = { package_id: 'p1', release_id: 'r1', sha256: 'a'.repeat(64), action_id: 'generate', action_contract_version: '1.0.0', action_surface_sha256: 'b'.repeat(64) };
const input = { target, input: { prompt: 'hello' }, request_idempotency_key: 'request-1', deadline_at: '2099-01-01T00:00:00.000Z', caller: { kind: 'DESKTOP' as const, id: 'desktop-session' } };
const row = (overrides = {}) => ({ id: 'i1', teamId: 't1', kind: 'STANDARD', status: 'AUTHORIZED', packageId: 'p1', releaseId: 'r1', releaseSha256: target.sha256, actionId: 'generate', actionContractVersion: '1.0.0', actionSurfaceSha256: target.action_surface_sha256, policyRevision: 1, requiredOperations: ['invoke_action'], input: input.input, inputSha256: 'x', output: null, deadlineAt: new Date(input.deadline_at), createdAt: new Date(), startedAt: null, completedAt: null, errorCode: '', errorMessage: '', ...overrides });
describe('ActionInvocationService', () => {
  it('authorizes exactly once and persists an AUTHORIZED invocation', async () => {
    const create = vi.fn().mockImplementation(({ data }) => row({ ...data, inputSha256: data.inputSha256 }));
    const authorize = vi.fn().mockResolvedValue({ decision: { policy_revision: 1 }, required_operations: ['invoke_action'], action: { input_schema: { type: 'object', additionalProperties: false, required: ['prompt'], properties: { prompt: { type: 'string' } } }, output_schema: { type: 'object', additionalProperties: false, properties: {} }, execution: { runtime_type: 'nodejs', entry: 'index.js', export: 'generate' } } });
    const service = new ActionInvocationService({ actionInvocation: { findUnique: vi.fn().mockResolvedValue(null), create } } as never, { ensureCurrentTeam: vi.fn().mockResolvedValue({ teamId: 't1' }) } as never, { authorize } as never);
    const result = await service.create('u1', input);
    expect(authorize).toHaveBeenCalledOnce(); expect(create).toHaveBeenCalledOnce(); expect(result.status).toBe('AUTHORIZED');
  });
  it('returns the existing row without a second authorization for an identical request', async () => {
    const existing = row({ inputSha256: createHash('sha256').update('{"prompt":"hello"}').digest('hex') });
    const prisma = { actionInvocation: { findUnique: vi.fn().mockResolvedValue(existing), create: vi.fn() } } as any;
    const authorize = vi.fn(); const service = new ActionInvocationService(prisma, { ensureCurrentTeam: vi.fn().mockResolvedValue({ teamId: 't1' }) } as never, { authorize } as never);
    await expect(service.create('u1', input)).resolves.toMatchObject({ id: 'i1' });
    expect(authorize).not.toHaveBeenCalled(); expect(prisma.actionInvocation.create).not.toHaveBeenCalled();
  });
  it('claim uses an AUTHORIZED compare-and-swap barrier', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 }); const findUniqueOrThrow = vi.fn().mockResolvedValue(row({ status: 'RUNNING', startedAt: new Date() }));
    const service = new ActionInvocationService({ actionInvocation: { updateMany, findFirst: vi.fn().mockResolvedValue(row({ status: 'RUNNING', startedAt: new Date() })) } } as never, { ensureCurrentTeam: vi.fn().mockResolvedValue({ teamId: 't1' }) } as never, {} as never);
    await service.claim('u1', 'i1'); expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 'i1', teamId: 't1', status: 'AUTHORIZED' }) }));
  });
  it('desktop claim is bound to the authenticated principal and DESKTOP caller kind', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const service = new ActionInvocationService({ actionInvocation: { updateMany, findFirst: vi.fn().mockResolvedValue(row({ status: 'RUNNING', startedAt: new Date() })) } } as never, { ensureCurrentTeam: vi.fn().mockResolvedValue({ teamId: 't1' }) } as never, {} as never);
    await service.claimDesktop('u1', 'i1');
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 'i1', teamId: 't1', principalUserId: 'u1', callerKind: { in: ['DESKTOP', 'ACTION'] }, status: 'AUTHORIZED' }) }));
  });

  it('inherits principal, kind and caller from a running parent invocation', async () => {
    const parent = row({
      id: 'parent-1',
      status: 'RUNNING',
      principalUserId: 'u1',
      rootInvocationId: 'parent-1',
      parentInvocationId: null,
      callChain: [{ invocation_id: 'parent-1', target }],
    });
    const create = vi.fn().mockImplementation(({ data }) => row({ ...data, inputSha256: data.inputSha256 }));
    const tx = {
      actionInvocation: {
        findFirst: vi.fn().mockResolvedValue(parent),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        count: vi.fn().mockResolvedValue(1),
        create,
      },
    };
    const prisma = {
      actionInvocation: {
        findFirst: vi.fn().mockResolvedValue(parent),
        findUnique: vi.fn().mockResolvedValue(null),
      },
      $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
    };
    const authorize = vi.fn().mockResolvedValue({ decision: { policy_revision: 1 }, required_operations: ['invoke_action'], action: { input_schema: { type: 'object', additionalProperties: false, required: ['prompt'], properties: { prompt: { type: 'string' } } }, output_schema: { type: 'object', additionalProperties: false, properties: {} } } });
    const service = new ActionInvocationService(prisma as never, { ensureCurrentTeam: vi.fn().mockResolvedValue({ teamId: 't1' }) } as never, { authorize } as never);
    const nestedTarget = { ...target, release_id: 'r2', action_id: 'encode', action_surface_sha256: 'c'.repeat(64) };

    await service.create('u1', { ...input, target: nestedTarget, parent_invocation_id: 'parent-1', caller: { kind: 'CLOUD', id: 'spoofed' } });

    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', caller: 'ACTION', invocationKind: 'STANDARD', target: nestedTarget }));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      principalUserId: 'u1',
      callerKind: 'ACTION',
      callerId: 'parent-1',
      rootInvocationId: 'parent-1',
      parentInvocationId: 'parent-1',
    }) }));
  });

  it('rejects exact target cycles before authorization', async () => {
    const parent = row({
      id: 'parent-1', status: 'RUNNING', principalUserId: 'u1', rootInvocationId: 'parent-1',
      parentInvocationId: null, callChain: [{ invocation_id: 'parent-1', target }],
    });
    const authorize = vi.fn();
    const service = new ActionInvocationService({ actionInvocation: { findFirst: vi.fn().mockResolvedValue(parent) } } as never, { ensureCurrentTeam: vi.fn().mockResolvedValue({ teamId: 't1' }) } as never, { authorize } as never);
    await expect(service.create('u1', { ...input, parent_invocation_id: 'parent-1' })).rejects.toMatchObject({ code: 'action_cycle_detected' });
    expect(authorize).not.toHaveBeenCalled();
  });

  it('rejects a nested chain deeper than the portable limit', async () => {
    const chain = Array.from({ length: 8 }, (_, index) => ({
      invocation_id: `invocation-${index}`,
      target: { ...target, release_id: `release-${index}`, action_surface_sha256: String(index).padStart(64, '0') },
    }));
    const parent = row({
      id: 'invocation-7', status: 'RUNNING', principalUserId: 'u1', rootInvocationId: 'invocation-0',
      parentInvocationId: 'invocation-6', callChain: chain,
    });
    const service = new ActionInvocationService({ actionInvocation: { findFirst: vi.fn().mockResolvedValue(parent) } } as never, { ensureCurrentTeam: vi.fn().mockResolvedValue({ teamId: 't1' }) } as never, {} as never);
    const nestedTarget = { ...target, release_id: 'release-8', action_id: 'encode', action_surface_sha256: 'f'.repeat(64) };
    await expect(service.create('u1', { ...input, target: nestedTarget, parent_invocation_id: 'invocation-7' })).rejects.toMatchObject({ code: 'action_depth_exceeded' });
  });

  it('serializes nested creation at the root and rejects excess active concurrency', async () => {
    const parent = row({
      id: 'parent-1', status: 'RUNNING', principalUserId: 'u1', rootInvocationId: 'root-1',
      parentInvocationId: 'root-1', callChain: [{ invocation_id: 'root-1', target: { ...target, release_id: 'root-release' } }, { invocation_id: 'parent-1', target }],
    });
    const tx = {
      actionInvocation: {
        findFirst: vi.fn().mockResolvedValue(parent),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        count: vi.fn().mockResolvedValue(16),
        create: vi.fn(),
      },
    };
    const prisma = {
      actionInvocation: { findFirst: vi.fn().mockResolvedValue(parent), findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
    };
    const authorize = vi.fn().mockResolvedValue({ decision: { policy_revision: 1 }, required_operations: ['invoke_action'], action: { input_schema: { type: 'object', additionalProperties: false, required: ['prompt'], properties: { prompt: { type: 'string' } } } } });
    const service = new ActionInvocationService(prisma as never, { ensureCurrentTeam: vi.fn().mockResolvedValue({ teamId: 't1' }) } as never, { authorize } as never);
    const nestedTarget = { ...target, release_id: 'r2', action_id: 'encode', action_surface_sha256: 'c'.repeat(64) };
    await expect(service.create('u1', { ...input, target: nestedTarget, parent_invocation_id: 'parent-1' })).rejects.toMatchObject({ code: 'action_concurrency_exceeded' });
    expect(tx.actionInvocation.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'root-1', teamId: 't1' } }));
    expect(tx.actionInvocation.create).not.toHaveBeenCalled();
  });
  it('terminalizes a workflow invocation and its step with one transaction CAS', async () => {
    const invocationUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const attemptUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
      actionInvocation: {
        findFirst: vi.fn().mockResolvedValue(row({ status: 'RUNNING', executionBinding: { output_schema: { type: 'object', additionalProperties: false, required: ['value'], properties: { value: { type: 'string' } } } } })),
        updateMany: invocationUpdate,
      },
      workflowStepAttempt: {
        findFirst: vi.fn().mockResolvedValue({ id: 'attempt-1', runId: 'run-1', status: 'RUNNING', run: { teamId: 't1', executionScope: 'PRODUCTION', resultRetainUntil: new Date('2099-01-08T00:00:00.000Z') } }),
        updateMany: attemptUpdate,
      },
    };
    const transaction = vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx));
    const acquireHandoffPendingTx = vi.fn().mockResolvedValue(0);
    const service = new ActionInvocationService({ $transaction: transaction } as never, { ensureCurrentTeam: vi.fn().mockResolvedValue({ teamId: 't1' }) } as never, {} as never, { acquireHandoffPendingTx } as never);
    await service.completeWorkflowAttempt('u1', 'i1', 'attempt-1', { value: 'ok' });
    expect(transaction).toHaveBeenCalledOnce();
    expect(acquireHandoffPendingTx).toHaveBeenCalledWith(tx, expect.objectContaining({ invocationId: 'i1', runId: 'run-1', attemptId: 'attempt-1', output: { value: 'ok' } }));
    expect(invocationUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 'i1', status: 'RUNNING' }), data: expect.objectContaining({ status: 'SUCCEEDED' }) }));
    expect(attemptUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 'attempt-1', actionInvocationId: 'i1', status: 'RUNNING' }), data: expect.objectContaining({ status: 'SUCCEEDED', leaseTokenSha256: null }) }));
  });
  it('aborts the workflow terminal transaction when either CAS loses', async () => {
    const tx = {
      actionInvocation: { findFirst: vi.fn().mockResolvedValue(row({ status: 'RUNNING', executionBinding: { output_schema: { type: 'object', additionalProperties: false, properties: {} } } })), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      workflowStepAttempt: { findFirst: vi.fn().mockResolvedValue({ id: 'attempt-1', runId: 'run-1', status: 'RUNNING', run: { teamId: 't1', executionScope: 'PRODUCTION', resultRetainUntil: new Date('2099-01-08T00:00:00.000Z') } }), updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    };
    const transaction = vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx));
    const service = new ActionInvocationService({ $transaction: transaction } as never, { ensureCurrentTeam: vi.fn().mockResolvedValue({ teamId: 't1' }) } as never, {} as never, { acquireHandoffPendingTx: vi.fn().mockResolvedValue(0) } as never);
    await expect(service.completeWorkflowAttempt('u1', 'i1', 'attempt-1', {})).rejects.toMatchObject({ code: 'conflict' });
    expect(transaction).toHaveBeenCalledOnce();
  });
});
