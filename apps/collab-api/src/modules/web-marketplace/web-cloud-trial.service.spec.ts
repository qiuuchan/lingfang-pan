import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../common';
import { WebCloudTrialService } from './web-cloud-trial.service';

const IDS = {
  user: '11111111-1111-4111-8111-111111111111',
  team: '22222222-2222-4222-8222-222222222222',
  package: '33333333-3333-4333-8333-333333333333',
  release: '44444444-4444-4444-8444-444444444444',
  invocation: '55555555-5555-4555-8555-555555555555',
  deployment: '66666666-6666-4666-8666-666666666666',
};

const inputSchema = {
  type: 'object',
  properties: { prompt: { type: 'string', maxLength: 100 } },
  required: ['prompt'],
  additionalProperties: false,
};

const target = {
  package_id: IDS.package,
  release_id: IDS.release,
  sha256: 'a'.repeat(64),
  action_id: 'image.generate',
  action_contract_version: '1.0.0',
  action_surface_sha256: 'b'.repeat(64),
};

const action = {
  ...target,
  name: '生成图片',
  description: '',
  input_schema: inputSchema,
  output_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  previewable: true,
  cloud_capable: true,
  execution_semantics: 'read_only',
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: IDS.invocation,
    teamId: IDS.team,
    principalUserId: IDS.user,
    kind: 'PREVIEW',
    callerKind: 'WEB',
    status: 'AUTHORIZED',
    packageId: target.package_id,
    releaseId: target.release_id,
    releaseSha256: target.sha256,
    actionId: target.action_id,
    actionContractVersion: target.action_contract_version,
    actionSurfaceSha256: target.action_surface_sha256,
    requestIdempotencyKey: 'request-1',
    inputSha256: '70d9a74cbeb1625447301727f16f1ebc5b8faaa18220dcbe44360596e981295e',
    policyRevision: 3,
    output: null,
    deadlineAt: new Date('2026-07-16T00:02:00.000Z'),
    createdAt: new Date('2026-07-16T00:00:00.000Z'),
    startedAt: null,
    completedAt: null,
    errorCode: '',
    errorMessage: '',
    ...overrides,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    release_id: target.release_id,
    release_sha256: target.sha256,
    action_contract_version: target.action_contract_version,
    action_surface_sha256: target.action_surface_sha256,
    input: { prompt: '海边日落' },
    request_idempotency_key: 'request-1',
    ...overrides,
  };
}

function setup(
  options: { existing?: ReturnType<typeof row> | null; loaded?: ReturnType<typeof row>[] } = {}
) {
  const loaded = [...(options.loaded ?? [row()])];
  const findFirst = vi.fn().mockImplementation(({ where }: { where: Record<string, unknown> }) => {
    if (where.id) return Promise.resolve(loaded.shift() ?? null);
    return Promise.resolve(options.existing ?? null);
  });
  const count = vi
    .fn()
    .mockResolvedValueOnce(0)
    .mockResolvedValueOnce(0)
    .mockResolvedValueOnce(1)
    .mockResolvedValueOnce(1);
  const prisma = {
    marketplaceListing: {
      findFirst: vi.fn().mockResolvedValue({
        currentRelease: {
          id: IDS.release,
          sha256: target.sha256,
          actionSurfaceManifest: [action],
        },
      }),
    },
    actionInvocation: { findFirst, count },
    automationOutbox: { upsert: vi.fn().mockResolvedValue({}) },
  };
  const auth = { ensureCurrentTeam: vi.fn().mockResolvedValue({ teamId: IDS.team }) };
  const actions = { resolve: vi.fn().mockResolvedValue({ target, action }) };
  const routing = {
    freeze: vi.fn().mockResolvedValue({ deployment_id: IDS.deployment, routing_generation: 7 }),
  };
  const invocations = {
    create: vi.fn().mockResolvedValue({ id: IDS.invocation, status: 'AUTHORIZED' }),
    cancel: vi.fn().mockResolvedValue({}),
  };
  return {
    prisma,
    auth,
    actions,
    routing,
    invocations,
    service: new WebCloudTrialService(
      prisma as never,
      auth as never,
      actions as never,
      routing as never,
      invocations as never
    ),
  };
}

describe('WebCloudTrialService', () => {
  it('creates a PREVIEW invocation and returns the complete shared projection', async () => {
    const h = setup();
    const result = await h.service.start(IDS.user, IDS.package, target.action_id, request());
    expect(h.invocations.create).toHaveBeenCalledWith(
      IDS.user,
      expect.objectContaining({
        preview: true,
        input: { prompt: '海边日落' },
        request_idempotency_key: 'request-1',
        caller: { kind: 'WEB', id: IDS.user },
        cloud_binding: {
          deployment_id: IDS.deployment,
          routing_generation: 7,
          environment: 'PREVIEW',
        },
      })
    );
    expect(result).toMatchObject({
      invocation_id: IDS.invocation,
      status: 'AUTHORIZED',
      target,
      quota_remaining: 4,
      daily_limit: 5,
      concurrency_limit: 1,
      concurrent_active: 1,
      policy_decision_id: 'policy-revision:3',
      output: null,
      error: null,
    });
    expect(h.prisma.automationOutbox.upsert).toHaveBeenCalledOnce();
  });

  it('returns an owned idempotent retry before quota and routing checks', async () => {
    const existing = row();
    const h = setup({ existing });
    const result = await h.service.start(IDS.user, IDS.package, target.action_id, request());
    expect(result.invocation_id).toBe(IDS.invocation);
    expect(h.routing.freeze).not.toHaveBeenCalled();
    expect(h.invocations.create).not.toHaveBeenCalled();
  });

  it('fails closed on stale release/action identities from an opened page', async () => {
    const h = setup();
    await expect(
      h.service.start(
        IDS.user,
        IDS.package,
        target.action_id,
        request({ release_sha256: 'c'.repeat(64) })
      )
    ).rejects.toMatchObject<AppError>({ status: 409, code: 'web_preview_release_changed' });
    expect(h.actions.resolve).not.toHaveBeenCalled();
  });

  it('isolates reads and cancellation to the invoking principal and Web PREVIEW kind', async () => {
    const missing = setup({ loaded: [] });
    await expect(missing.service.get(IDS.user, IDS.invocation)).rejects.toMatchObject<AppError>({
      status: 404,
    });
    await expect(missing.service.cancel(IDS.user, IDS.invocation)).rejects.toMatchObject<AppError>({
      status: 404,
    });
    expect(missing.invocations.cancel).not.toHaveBeenCalled();
    expect(missing.prisma.actionInvocation.findFirst).toHaveBeenCalledWith({
      where: {
        id: IDS.invocation,
        teamId: IDS.team,
        principalUserId: IDS.user,
        kind: 'PREVIEW',
        callerKind: 'WEB',
      },
    });
  });

  it('uses the invocation terminal CAS for cancel and returns the persisted terminal row', async () => {
    const canceled = row({
      status: 'CANCELED',
      completedAt: new Date('2026-07-16T00:00:10.000Z'),
      errorCode: 'action_cancelled',
      errorMessage: 'Action invocation 已取消',
    });
    const h = setup({ loaded: [row(), canceled] });
    h.prisma.actionInvocation.count = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    const result = await h.service.cancel(IDS.user, IDS.invocation);
    expect(h.invocations.cancel).toHaveBeenCalledWith(IDS.user, IDS.invocation);
    expect(result).toMatchObject({
      status: 'CANCELED',
      concurrent_active: 0,
      error: { code: 'action_cancelled', message: 'Action invocation 已取消' },
    });
  });

  it('propagates a lost terminal CAS without fabricating a canceled projection', async () => {
    const h = setup({ loaded: [row()] });
    h.invocations.cancel.mockRejectedValue(
      new AppError(409, 'conflict', 'Action invocation 已终止')
    );
    await expect(h.service.cancel(IDS.user, IDS.invocation)).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
    });
    expect(h.prisma.actionInvocation.findFirst).toHaveBeenCalledTimes(1);
  });
});
