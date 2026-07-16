import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { RuntimeArtifactService } from './runtime-artifact.service';
beforeEach(() => { process.env.RUNTIME_ARTIFACT_SIGNING_SECRET = 'x'.repeat(32); });
describe('RuntimeArtifactService', () => {
  it('creates invocation artifacts with a host-owned object key and signed ref', async () => {
    const invocation = { id: 'i1', teamId: 't1', principalUserId: 'u1', kind: 'STANDARD', status: 'RUNNING', deadlineAt: new Date(Date.now() + 60_000) };
    const tx = {
      actionInvocation: { findUnique: vi.fn().mockResolvedValue(invocation) },
      runtimeArtifact: {
        create: vi.fn(async ({ data }) => ({ id: 'a1', ...data })),
        findUnique: vi.fn().mockResolvedValue({ id: 'a1', status: 'ACTIVE' }),
      },
      runtimeArtifactGrant: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn(async ({ data }) => ({ id: 'g1', ...data })) },
    };
    const prisma = { actionInvocation: { findFirst: vi.fn().mockResolvedValue(invocation) }, $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)) };
    const store = { promote: vi.fn().mockResolvedValue(undefined), delete: vi.fn().mockResolvedValue(undefined) };
    const service = new RuntimeArtifactService(prisma as never, { ensureCurrentTeam: vi.fn().mockResolvedValue({ teamId: 't1' }) } as never, store as never);
    const result = await service.createFromInvocation('u1', 'i1', { data_base64: 'UE5H', media_type: 'image/png' });
    expect(store.promote).toHaveBeenCalledWith(expect.any(String), expect.stringMatching(/^runtime-artifacts\/t1\//), expect.stringMatching(/^[a-f0-9]{64}$/));
    expect(result).toMatchObject({ type: 'artifact_ref', artifact_id: 'a1', media_type: 'image/png', size_bytes: 3, authorization: { team_id: 't1', handle: expect.any(String) } });
  });
  it('materializes only a signed ref granted to the current invocation', async () => {
    const bytes = Buffer.from('PNG');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const signer = new RuntimeArtifactService({} as never, {} as never, {} as never);
    const ref = signer.toRef({ id: 'a1', teamId: 't1', mediaType: 'image/png', sizeBytes: 3, sha256 });
    const prisma = {
      actionInvocation: { findFirst: vi.fn().mockResolvedValue({ id: 'i1', teamId: 't1', kind: 'STANDARD' }) },
      runtimeArtifact: { findFirst: vi.fn().mockResolvedValue({ id: 'a1', teamId: 't1', executionKind: 'STANDARD', status: 'ACTIVE', objectKey: 'runtime/a1', mediaType: 'image/png', sizeBytes: 3, sha256: ref.sha256 }) },
      runtimeArtifactGrant: { findFirst: vi.fn().mockResolvedValue({ id: 'g1' }) },
    };
    const service = new RuntimeArtifactService(prisma as never, { ensureCurrentTeam: vi.fn().mockResolvedValue({ teamId: 't1' }) } as never, { download: vi.fn().mockResolvedValue({ kind: 'stream', stream: Readable.from([bytes]), sizeBytes: 3 }) } as never);
    await expect(service.materializeForInvocation('u1', 'i1', ref)).resolves.toMatchObject({ data_base64: 'UE5H', media_type: 'image/png', size_bytes: 3, sha256: ref.sha256 });
    expect(prisma.actionInvocation.findFirst).toHaveBeenCalledWith({ where: expect.objectContaining({ principalUserId: 'u1', status: 'RUNNING' }) });
  });
  it('atomically binds workflow input only when a live concrete source grant exists', async () => {
    const signer = new RuntimeArtifactService({} as never, {} as never, {} as never);
    const ref = signer.toRef({ id: 'a1', teamId: 't1', mediaType: 'image/png', sizeBytes: 12, sha256: 'a'.repeat(64) });
    const grantCreate = vi.fn(async ({ data }) => ({ id: 'run-grant', ...data }));
    const holdCreate = vi.fn(async ({ data }) => ({ id: 'run-hold', ...data }));
    const tx = {
      runtimeArtifact: { findFirst: vi.fn().mockResolvedValue({ id: 'a1', status: 'ACTIVE', sha256: 'a'.repeat(64), mediaType: 'image/png', sizeBytes: 12 }), findUnique: vi.fn().mockResolvedValue({ id: 'a1', status: 'ACTIVE' }) },
      actionInvocation: { findFirst: vi.fn().mockResolvedValue({ id: 'inv1', principalUserId: 'u1' }) },
      workflowRun: { findFirst: vi.fn() },
      runtimeArtifactGrant: { findMany: vi.fn().mockResolvedValue([{ id: 'source-invocation-grant', targetKind: 'INVOCATION', targetId: 'inv1' }]), findUnique: vi.fn().mockResolvedValue(null), create: grantCreate },
      runtimeArtifactHold: { findUnique: vi.fn().mockResolvedValue(null), create: holdCreate },
    };
    const service = new RuntimeArtifactService({} as never, {} as never, {} as never);
    await expect(service.bindWorkflowInputsTx(tx as never, { runId: 'run1', teamId: 't1', principalUserId: 'u1', kind: 'STANDARD', value: { image: ref }, retainUntil: new Date('2099-01-01') })).resolves.toBe(1);
    expect(grantCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ targetKind: 'WORKFLOW_RUN', targetId: 'run1' }) });
    expect(holdCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ purpose: 'RUN_INPUT', holderId: 'run1:RUN_INPUT:/image' }) });
  });
  it('does not treat same-team ownership as workflow input authority', async () => {
    const signer = new RuntimeArtifactService({} as never, {} as never, {} as never);
    const ref = signer.toRef({ id: 'a1', teamId: 't1', mediaType: 'image/png', sizeBytes: 12, sha256: 'a'.repeat(64) });
    const tx = { runtimeArtifact: { findFirst: vi.fn().mockResolvedValue({ id: 'a1', status: 'ACTIVE', sha256: 'a'.repeat(64), mediaType: 'image/png', sizeBytes: 12 }) }, runtimeArtifactGrant: { findMany: vi.fn().mockResolvedValue([]) } };
    await expect(signer.bindWorkflowInputsTx(tx as never, { runId: 'run1', teamId: 't1', principalUserId: 'u1', kind: 'STANDARD', value: { image: ref }, retainUntil: new Date('2099-01-01') })).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('requires initiator or team admin plus a live final-output grant to download', async () => {
    const store = { download: vi.fn().mockResolvedValue({ kind: 'stream', stream: {}, sizeBytes: 12 }) };
    const prisma = {
      workflowRun: { findFirst: vi.fn().mockResolvedValue({ id: 'run1', teamId: 't1', principalUserId: 'owner', status: 'SUCCEEDED', executionScope: 'PRODUCTION', resultRetainUntil: new Date('2099-01-01') }) },
      runtimeArtifact: { findFirst: vi.fn().mockResolvedValue({ id: 'a1', objectKey: 'runtime/a1', executionKind: 'STANDARD', status: 'ACTIVE' }) },
      runtimeArtifactGrant: { findFirst: vi.fn().mockResolvedValue({ id: 'g1' }) },
    };
    const member = new RuntimeArtifactService(prisma as never, { ensureCurrentTeam: vi.fn().mockResolvedValue({ teamId: 't1', role: 'MEMBER' }) } as never, store as never);
    await expect(member.authorizeWorkflowResult('stranger', 'run1', 'a1')).rejects.toMatchObject({ code: 'forbidden' });
    const admin = new RuntimeArtifactService(prisma as never, { ensureCurrentTeam: vi.fn().mockResolvedValue({ teamId: 't1', role: 'TEAM_ADMIN' }) } as never, store as never);
    await expect(admin.authorizeWorkflowResult('admin', 'run1', 'a1')).resolves.toMatchObject({ artifact: { id: 'a1' } });
    expect(prisma.runtimeArtifactGrant.findFirst).toHaveBeenCalledWith({ where: expect.objectContaining({ targetId: 'run1:FINAL_OUTPUT' }) });
  });
  it('signs refs and detects metadata tampering', async () => {
    const service = new RuntimeArtifactService({} as never, {} as never); const ref = service.toRef({ id: 'a1', teamId: 't1', mediaType: 'image/png', sizeBytes: 12, sha256: 'a'.repeat(64) });
    expect(ref.authorization.handle).toBeTruthy();
    const tampered = { ...ref, size_bytes: 13 };
    const prisma = { actionInvocation: { findFirst: vi.fn() } };
    const resolver = new RuntimeArtifactService(prisma as never, { ensureCurrentTeam: vi.fn().mockResolvedValue({ teamId: 't1' }) } as never);
    await expect(resolver.resolveForInvocation('u1', 'i1', tampered)).rejects.toMatchObject({ code: 'forbidden' }); expect(prisma.actionInvocation.findFirst).not.toHaveBeenCalled();
  });
  it('refuses to reopen a released hold', async () => {
    const tx = { runtimeArtifact: { findUnique: vi.fn().mockResolvedValue({ id: 'a1', status: 'ACTIVE' }) }, runtimeArtifactHold: { findUnique: vi.fn().mockResolvedValue({ id: 'h1', releasedAt: new Date(), retainUntil: new Date(Date.now() + 10000) }) } };
    const service = new RuntimeArtifactService({ $transaction: (fn: any) => fn(tx) } as never, {} as never);
    await expect(service.acquireHold('a1', 'STANDARD', 'WORKFLOW_RUN', 'run1', 'EDGE', { edge: 'e1' }, new Date(Date.now() + 20000))).rejects.toMatchObject({ code: 'conflict' });
  });
  it('composite kind lookup prevents a PREVIEW artifact from receiving a STANDARD grant', async () => {
    const tx = { runtimeArtifact: { findUnique: vi.fn().mockResolvedValue(null) } };
    const service = new RuntimeArtifactService({ $transaction: (fn: any) => fn(tx) } as never, {} as never);
    await expect(service.grantInvocation('a1', 'STANDARD', 'i1', { invocation: 'i1' }, new Date(Date.now() + 10000))).rejects.toMatchObject({ code: 'not_found' });
    expect(tx.runtimeArtifact.findUnique).toHaveBeenCalledWith({ where: { id_executionKind: { id: 'a1', executionKind: 'STANDARD' } } });
  });
  it('binds a source-authorized STANDARD artifact to a canonical shared value grant and hold', async () => {
    const signer = new RuntimeArtifactService({} as never, {} as never);
    const ref = signer.toRef({ id: 'a1', teamId: 't1', mediaType: 'image/png', sizeBytes: 12, sha256: 'a'.repeat(64) });
    const tx = {
      actionInvocation: { findUnique: vi.fn().mockResolvedValue({ id: 'i1', teamId: 't1', kind: 'STANDARD', status: 'RUNNING' }) },
      runtimeArtifact: {
        findFirst: vi.fn().mockResolvedValue({ id: 'a1', teamId: 't1', executionKind: 'STANDARD', status: 'ACTIVE', mediaType: 'image/png', sizeBytes: 12, sha256: 'a'.repeat(64), createdAt: new Date() }),
        findUnique: vi.fn().mockResolvedValue({ id: 'a1', status: 'ACTIVE' }),
      },
      runtimeArtifactGrant: {
        findFirst: vi.fn().mockResolvedValue({ id: 'source' }),
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn(async ({ data }) => ({ id: 'shared-grant', ...data })),
      },
      runtimeArtifactHold: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn(async ({ data }) => ({ id: 'hold', ...data })) },
    };
    const service = new RuntimeArtifactService({} as never, {} as never);
    await expect(service.bindSharedValueTx(tx as never, 'i1', ref, 'ns:1:key:2', { value_revision: '2' }, new Date(Date.now() + 60_000))).resolves.toMatchObject({ grant: { targetKind: 'SHARED_VALUE', targetId: 'ns:1:key:2' } });
    expect(tx.runtimeArtifactHold.create).toHaveBeenCalledWith({ data: expect.objectContaining({ holderKind: 'SHARED_VALUE', holderId: 'ns:1:key:2' }) });
  });
  it('never accepts PREVIEW invocation as a shared value source', async () => {
    const tx = { actionInvocation: { findUnique: vi.fn().mockResolvedValue({ id: 'i1', teamId: 't1', kind: 'PREVIEW', status: 'RUNNING' }) } };
    const service = new RuntimeArtifactService({} as never, {} as never);
    const ref = service.toRef({ id: 'a1', teamId: 't1', mediaType: 'image/png', sizeBytes: 12, sha256: 'a'.repeat(64) });
    await expect(service.bindSharedValueTx(tx as never, 'i1', ref, 'target', {}, new Date(Date.now() + 60_000))).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('rejects binding an artifact whose platform shared-retention cap already elapsed', async () => {
    process.env.PLUGIN_SHARED_ARTIFACT_RETENTION_DAYS = '1';
    const service = new RuntimeArtifactService({} as never, {} as never);
    const ref = service.toRef({ id: 'a1', teamId: 't1', mediaType: 'image/png', sizeBytes: 12, sha256: 'a'.repeat(64) });
    const tx = {
      actionInvocation: { findUnique: vi.fn().mockResolvedValue({ id: 'i1', teamId: 't1', kind: 'STANDARD', status: 'RUNNING' }) },
      runtimeArtifact: { findFirst: vi.fn().mockResolvedValue({ id: 'a1', teamId: 't1', executionKind: 'STANDARD', status: 'ACTIVE', mediaType: 'image/png', sizeBytes: 12, sha256: 'a'.repeat(64), createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) }) },
      runtimeArtifactGrant: { findFirst: vi.fn() },
    };
    await expect(service.bindSharedValueTx(tx as never, 'i1', ref, 'target', {}, new Date(Date.now() + 60_000))).rejects.toMatchObject({ code: 'shared_artifact_expired' });
    expect(tx.runtimeArtifactGrant.findFirst).not.toHaveBeenCalled();
    delete process.env.PLUGIN_SHARED_ARTIFACT_RETENTION_DAYS;
  });
  it('repairs missing canonical shared grant and hold without requiring the source invocation', async () => {
    const retainUntil = new Date(Date.now() + 60_000);
    const tx = {
      runtimeArtifact: {
        findUnique: vi.fn().mockResolvedValue({ id: 'a1', status: 'ACTIVE', retainUntil: new Date(0) }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      runtimeArtifactGrant: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn(async ({ data }) => ({ id: 'g1', ...data })) },
      runtimeArtifactHold: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn(async ({ data }) => ({ id: 'h1', ...data })) },
    };
    const service = new RuntimeArtifactService({} as never, {} as never);
    await expect(service.reconcileSharedValueTx(tx as never, 'a1', 'ns:1:key:2', { value_revision: '2' }, retainUntil)).resolves.toMatchObject({
      grant: { targetKind: 'SHARED_VALUE', targetId: 'ns:1:key:2' },
      hold: { holderKind: 'SHARED_VALUE', holderId: 'ns:1:key:2', purpose: 'SHARED_VALUE' },
    });
    expect(tx.runtimeArtifact.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { retainUntil } }));
  });
  it('does not exchange a shared grant when its retention hold is missing or released', async () => {
    const tx = {
      actionInvocation: { findUnique: vi.fn().mockResolvedValue({ id: 'reader', teamId: 't1', kind: 'STANDARD', status: 'RUNNING' }) },
      runtimeArtifactGrant: { findFirst: vi.fn().mockResolvedValue({ id: 'shared-grant' }) },
      runtimeArtifactHold: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    const service = new RuntimeArtifactService({} as never, {} as never);
    await expect(service.exchangeSharedValueTx(tx as never, 'reader', 'a1', 'ns:1:key:2', { value_revision: '2' }, new Date(Date.now() + 60_000))).rejects.toMatchObject({ code: 'shared_artifact_expired' });
  });
  it('reconciles a crash-window HANDOFF_PENDING hold into a canonical EDGE hold', async () => {
    const pending = { id: 'pending-1', artifactId: 'artifact-1', executionKind: 'STANDARD', holderKind: 'WORKFLOW_RUN', holderId: 'run-1:attempt-1', purpose: 'HANDOFF_PENDING', scopeDigest: 'scope', holderKey: 'pending-key', retainUntil: new Date('2099-01-08T00:00:00.000Z'), releasedAt: null, createdAt: new Date('2026-07-16T00:00:00.000Z') };
    const destinationCreate = vi.fn(async ({ data }) => ({ id: 'edge-1', ...data }));
    const releasePending = vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
      runtimeArtifact: { findUnique: vi.fn().mockResolvedValue({ id: 'artifact-1', status: 'ACTIVE' }) },
      runtimeArtifactHold: { findMany: vi.fn().mockResolvedValue([pending]), findUnique: vi.fn().mockResolvedValue(null), create: destinationCreate, updateMany: releasePending },
    };
    const prisma = {
      runtimeArtifactHold: { findMany: vi.fn().mockResolvedValue([pending]) },
      workflowStepAttempt: { findUnique: vi.fn().mockResolvedValue({ id: 'attempt-1', runId: 'run-1', nodeId: 'image', status: 'SUCCEEDED', run: { id: 'run-1', status: 'RUNNING', frozenPlan: { nodes: [{ node_id: 'image', depends_on: [] }, { node_id: 'video', depends_on: ['image'] }] }, resultRetainUntil: new Date('2099-01-08T00:00:00.000Z') } }) },
      $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
    };
    const service = new RuntimeArtifactService(prisma as never, {} as never);
    await expect(service.reconcileHandoffPending()).resolves.toEqual({ converted: 1, released: 0 });
    expect(destinationCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ artifactId: 'artifact-1', holderKind: 'WORKFLOW_RUN', holderId: 'run-1:attempt-1:video', purpose: 'EDGE' }) });
    expect(releasePending).toHaveBeenCalledWith({ where: { id: 'pending-1', releasedAt: null }, data: { releasedAt: expect.any(Date) } });
  });
  it('pins a signed workflow output ref before terminal projection', async () => {
    const signer = new RuntimeArtifactService({} as never, {} as never);
    const ref = signer.toRef({ id: 'artifact-1', teamId: 'team-1', mediaType: 'image/png', sizeBytes: 12, sha256: 'a'.repeat(64) });
    const holdCreate = vi.fn(async ({ data }) => ({ id: 'pending-1', ...data }));
    const tx = {
      actionInvocation: { findUnique: vi.fn().mockResolvedValue({ id: 'invocation-1', teamId: 'team-1', kind: 'STANDARD', status: 'RUNNING' }) },
      runtimeArtifact: {
        findFirst: vi.fn().mockResolvedValue({ id: 'artifact-1', teamId: 'team-1', executionKind: 'STANDARD', status: 'ACTIVE', mediaType: 'image/png', sizeBytes: 12, sha256: 'a'.repeat(64) }),
        findUnique: vi.fn().mockResolvedValue({ id: 'artifact-1', status: 'ACTIVE' }),
      },
      runtimeArtifactGrant: { findFirst: vi.fn().mockResolvedValue({ id: 'source-grant' }) },
      runtimeArtifactHold: { findUnique: vi.fn().mockResolvedValue(null), create: holdCreate },
    };
    const service = new RuntimeArtifactService({} as never, {} as never);
    await expect(service.acquireHandoffPendingTx(tx as never, { invocationId: 'invocation-1', runId: 'run-1', attemptId: 'attempt-1', output: { image: ref }, retainUntil: new Date('2099-01-08T00:00:00.000Z') })).resolves.toBe(1);
    expect(holdCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ artifactId: 'artifact-1', executionKind: 'STANDARD', holderKind: 'WORKFLOW_RUN', holderId: 'run-1:attempt-1', purpose: 'HANDOFF_PENDING' }) });
  });
  it('releases transient run holds but preserves final output retention on success', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 3 });
    const service = new RuntimeArtifactService({} as never, {} as never);
    await service.releaseRunHoldsTx({ runtimeArtifactHold: { updateMany } } as never, 'run-1', true);
    expect(updateMany).toHaveBeenCalledWith({ where: { holderKind: 'WORKFLOW_RUN', holderId: { startsWith: 'run-1:' }, purpose: { in: ['RUN_INPUT', 'EDGE', 'HANDOFF_PENDING'] }, releasedAt: null }, data: { releasedAt: expect.any(Date) } });
  });
});
