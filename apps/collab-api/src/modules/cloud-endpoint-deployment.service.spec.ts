import { describe, expect, it, vi } from 'vitest';
import {
  CloudActionDeploymentService,
  CLOUD_ENDPOINT_VERIFY_TYPE,
} from './cloud-action-deployment.service';
import { CloudEndpointSecretCipher } from './cloud-endpoint-secret-cipher';
import { signCloudResponse } from './cloud-signature';

const target = {
  package_id: 'pkg-1',
  release_id: 'rel-1',
  sha256: 'a'.repeat(64),
  action_id: 'image.generate',
  action_contract_version: '1.0.0',
  action_surface_sha256: 'b'.repeat(64),
  environment: 'PRODUCTION' as const,
};

function harness(options: { cloudCapable?: boolean; teamId?: string } = {}) {
  const rows = new Map<string, any>();
  const now = new Date('2026-07-16T00:00:00.000Z');
  const tx: any = {
    cloudActionRouting: { count: vi.fn(async () => 0) },
    actionInvocation: { count: vi.fn(async () => 0) },
    workflowRunCloudBinding: { count: vi.fn(async () => 0) },
    cloudActionDeployment: {
      create: vi.fn(async ({ data }: any) => {
        const row = {
          supersedesDeploymentId: null,
          lastHealthAt: null,
          lastHealthOk: null,
          lastHealthErrorCode: '',
          createdAt: now,
          updatedAt: now,
          ...data,
        };
        rows.set(row.id, row);
        return row;
      }),
      findFirst: vi.fn(async ({ where }: any) => {
        const candidates = [...rows.values()];
        return (
          candidates.find(
            (row) =>
              (!where.id || row.id === where.id) &&
              (!where.teamId || row.teamId === where.teamId) &&
              (!where.status || row.status === where.status)
          ) ?? null
        );
      }),
      findMany: vi.fn(async ({ where }: any) =>
        [...rows.values()].filter(
          (row) =>
            row.teamId === where.teamId &&
            row.releaseId === where.releaseId &&
            row.actionId === where.actionId
        )
      ),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const row = rows.get(where.id);
        const allowed =
          typeof where.status === 'string'
            ? row?.status === where.status
            : where.status?.in?.includes(row?.status);
        if (!row || row.teamId !== where.teamId || !allowed) return { count: 0 };
        Object.assign(row, data, { updatedAt: now });
        return { count: 1 };
      }),
    },
    pluginRelease: {
      findFirst: vi.fn(async ({ where }: any) =>
        where.package?.ownerTeamId === (options.teamId ?? 'team-1') ? { id: 'rel-1' } : null
      ),
    },
    auditLog: { create: vi.fn(async ({ data }: any) => data) },
  };
  const prisma: any = { ...tx, $transaction: vi.fn(async (fn: any) => fn(tx)) };
  const auth: any = {
    ensurePermission: vi.fn(async () => ({ perms: new Set(['team.plugin.edit_draft']) })),
    ensureCurrentTeam: vi.fn(async () => ({ teamId: options.teamId ?? 'team-1' })),
  };
  const actions: any = {
    resolve: vi.fn(async () => ({ action: { cloud_capable: options.cloudCapable ?? true } })),
  };
  const cipher = CloudEndpointSecretCipher.forTest(Buffer.alloc(32, 7));
  let responseSecret = '';
  const http: any = {
    validateUrl: vi.fn((raw: string) => new URL(raw)),
    request: vi.fn(async (request: any) => {
      const requestBody = JSON.parse(request.body.toString('utf8'));
      const responseBody = Buffer.from(JSON.stringify({ ...requestBody, ok: true }), 'utf8');
      const timestamp = Number(request.headers['x-lingfang-timestamp']);
      const nonce = request.headers['x-lingfang-nonce'];
      const invocationId = request.headers['x-lingfang-invocation-id'];
      const deploymentId = request.headers['x-lingfang-deployment-id'];
      return {
        statusCode: 200,
        headers: {
          'content-type': 'application/json',
          'x-lingfang-response-signature': signCloudResponse(
            { statusCode: 200, timestamp, nonce, invocationId, deploymentId, body: responseBody },
            responseSecret
          ),
        },
        body: responseBody,
        resolvedAddress: { address: '8.8.8.8', family: 4 },
      };
    }),
  };
  const service = new CloudActionDeploymentService(prisma, auth, actions, cipher, http);
  return {
    service,
    prisma,
    auth,
    actions,
    http,
    rows,
    setResponseSecret: (value: string) => {
      responseSecret = value;
    },
  };
}

describe('CloudActionDeploymentService', () => {
  it('creates DRAFT without network, returns the secret once, and exposes only a host', async () => {
    const h = harness();
    const result = await h.service.create('user-1', {
      target,
      deployment_key: 'primary',
      endpoint_url: 'https://api.example.com/v1/action?mode=cloud',
    });
    expect(result.deployment).toMatchObject({
      status: 'DRAFT',
      endpoint_host: 'api.example.com',
      target,
    });
    expect(result.endpoint_secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(h.http.request).not.toHaveBeenCalled();
    const stored = [...h.rows.values()][0];
    expect(stored.secretCiphertext).not.toContain(result.endpoint_secret);
    expect(JSON.stringify(result.deployment)).not.toContain('endpointUrl');
    expect(JSON.stringify(result.deployment)).not.toContain('/v1/action');
  });

  it('verifies a signed exact-target challenge before transitioning to READY', async () => {
    const h = harness();
    const created = await h.service.create('user-1', {
      target,
      deployment_key: 'primary',
      endpoint_url: 'https://api.example.com/v1/action',
    });
    h.setResponseSecret(created.endpoint_secret);
    const result = await h.service.verify('user-1', created.deployment.id);
    expect(result.deployment.status).toBe('READY');
    expect(result.deployment.last_health_ok).toBe(true);
    expect(result).not.toHaveProperty('endpoint_secret');
    const request = h.http.request.mock.calls[0][0];
    expect(JSON.parse(request.body.toString('utf8'))).toMatchObject({
      type: CLOUD_ENDPOINT_VERIFY_TYPE,
      deployment_id: created.deployment.id,
      target,
    });
    expect(request.headers['x-lingfang-action-surface-sha256']).toBe(target.action_surface_sha256);
  });

  it('rotates into a superseding DRAFT while leaving the READY deployment intact, then disables only the owned row', async () => {
    const h = harness();
    const created = await h.service.create('user-1', {
      target,
      deployment_key: 'primary',
      endpoint_url: 'https://api.example.com/action',
    });
    h.setResponseSecret(created.endpoint_secret);
    await h.service.verify('user-1', created.deployment.id);
    const rotated = await h.service.rotateSecret('user-1', created.deployment.id);
    expect(rotated.deployment).toMatchObject({
      status: 'DRAFT',
      supersedes_deployment_id: created.deployment.id,
      secret_version: 2,
    });
    expect(rotated.endpoint_secret).not.toBe(created.endpoint_secret);
    expect(h.rows.get(created.deployment.id).status).toBe('READY');
    const disabled = await h.service.disable('user-1', created.deployment.id);
    expect(disabled.deployment.status).toBe('DISABLED');
    const listed = await h.service.list('user-1', target.release_id, target.action_id);
    expect(listed.deployments).toHaveLength(2);
    expect(JSON.stringify(listed)).not.toContain('endpoint_secret');
    expect(JSON.stringify(listed)).not.toContain('secretCiphertext');
  });

  it('rejects non-cloud-capable exact actions before writing a deployment', async () => {
    const h = harness({ cloudCapable: false });
    await expect(
      h.service.create('user-1', {
        target,
        deployment_key: 'primary',
        endpoint_url: 'https://api.example.com/action',
      })
    ).rejects.toMatchObject({ code: 'cloud_endpoint_target_mismatch' });
    expect(h.rows.size).toBe(0);
  });

  it('does not expose another team deployment by id', async () => {
    const h = harness();
    const created = await h.service.create('user-1', {
      target,
      deployment_key: 'primary',
      endpoint_url: 'https://api.example.com/action',
    });
    h.auth.ensureCurrentTeam.mockResolvedValue({ teamId: 'team-2' });
    await expect(h.service.disable('user-2', created.deployment.id)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('retires only after routing and nonterminal execution bindings are closed', async () => {
    const h = harness();
    const created = await h.service.create('user-1', {
      target,
      deployment_key: 'primary',
      endpoint_url: 'https://api.example.com/action',
    });
    h.prisma.cloudActionRouting.count.mockResolvedValueOnce(1);
    await expect(h.service.retire('user-1', created.deployment.id)).rejects.toMatchObject({
      status: 409,
      code: 'cloud_deployment_in_use',
    });
    h.prisma.actionInvocation.count.mockResolvedValueOnce(1);
    await expect(h.service.retire('user-1', created.deployment.id)).rejects.toMatchObject({
      code: 'cloud_deployment_in_use',
    });
    h.prisma.workflowRunCloudBinding.count.mockResolvedValueOnce(1);
    await expect(h.service.retire('user-1', created.deployment.id)).rejects.toMatchObject({
      code: 'cloud_deployment_in_use',
    });
    const retired = await h.service.retire('user-1', created.deployment.id);
    expect(retired.deployment.status).toBe('RETIRED');
    await expect(h.service.retire('user-1', created.deployment.id)).resolves.toMatchObject({
      deployment: { status: 'RETIRED' },
    });
  });
});
