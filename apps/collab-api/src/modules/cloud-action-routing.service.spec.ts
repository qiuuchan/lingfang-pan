import { describe, expect, it, vi } from 'vitest';
import { CloudActionRoutingService, cloudRoutingBucket } from './cloud-action-routing.service';

const target = { package_id: 'pkg-1', release_id: 'rel-1', sha256: 'a'.repeat(64), action_id: 'image.generate', action_contract_version: '1.0.0', action_surface_sha256: 'b'.repeat(64) };

function harness() {
  const now = new Date('2026-07-16T00:00:00.000Z');
  const deployments = new Map([
    ['stable', { id: 'stable', teamId: 'author-team', packageId: 'pkg-1', releaseId: 'rel-1', sha256: target.sha256, actionId: target.action_id, actionContractVersion: target.action_contract_version, actionSurfaceSha256: target.action_surface_sha256, environment: 'PRODUCTION', status: 'READY' }],
    ['candidate', { id: 'candidate', teamId: 'author-team', packageId: 'pkg-1', releaseId: 'rel-1', sha256: target.sha256, actionId: target.action_id, actionContractVersion: target.action_contract_version, actionSurfaceSha256: target.action_surface_sha256, environment: 'PRODUCTION', status: 'READY' }],
  ]);
  let route: any = null;
  const routing = {
    findUnique: vi.fn(async ({ where, include }: any) => {
      const found = where.id ? route?.id === where.id ? route : null : route;
      if (!found || !include) return found;
      return { ...found, stableDeployment: deployments.get(found.stableDeploymentId), candidateDeployment: found.candidateDeploymentId ? deployments.get(found.candidateDeploymentId) : null };
    }),
    create: vi.fn(async ({ data }: any) => (route = { id: 'route-1', createdAt: now, updatedAt: now, ...data })),
    updateMany: vi.fn(async ({ where, data }: any) => {
      if (!route || route.id !== where.id || route.generation !== where.generation) return { count: 0 };
      route = { ...route, ...data, generation: route.generation + 1, updatedAt: now };
      return { count: 1 };
    }),
  };
  const prisma: any = {
    cloudActionRouting: routing,
    cloudActionDeployment: { findFirst: vi.fn(async ({ where }: any) => {
      const row = deployments.get(where.id);
      return row && row.teamId === where.teamId && row.status === where.status && row.releaseId === where.releaseId && row.actionId === where.actionId && row.actionContractVersion === where.actionContractVersion && row.actionSurfaceSha256 === where.actionSurfaceSha256 && row.environment === where.environment ? row : null;
    }) },
    pluginRelease: { findFirst: vi.fn(async ({ where }: any) => where.package?.ownerTeamId ? { id: 'rel-1' } : { package: { ownerTeamId: 'author-team' } }) },
  };
  const auth: any = { ensurePermission: vi.fn(async () => ({})), ensureCurrentTeam: vi.fn(async () => ({ teamId: 'author-team' })) };
  return { service: new CloudActionRoutingService(prisma, auth), prisma, auth, route: () => route };
}

describe('CloudActionRoutingService', () => {
  it('creates generation 1 and updates only with the expected generation', async () => {
    const h = harness();
    const created = await h.service.update('u1', target.release_id, target.action_id, { action_contract_version: target.action_contract_version, action_surface_sha256: target.action_surface_sha256, environment: 'PRODUCTION', stable_deployment_id: 'stable', candidate_deployment_id: 'candidate', candidate_percent: 25, expected_generation: 0 });
    expect(created.routing).toMatchObject({ generation: 1, stable_deployment_id: 'stable', candidate_deployment_id: 'candidate', candidate_percent: 25 });
    await expect(h.service.update('u1', target.release_id, target.action_id, { action_contract_version: target.action_contract_version, action_surface_sha256: target.action_surface_sha256, environment: 'PRODUCTION', stable_deployment_id: 'stable', candidate_percent: 0, expected_generation: 0 })).rejects.toMatchObject({ code: 'conflict' });
    const rolledBack = await h.service.update('u1', target.release_id, target.action_id, { action_contract_version: target.action_contract_version, action_surface_sha256: target.action_surface_sha256, environment: 'PRODUCTION', stable_deployment_id: 'stable', candidate_percent: 0, expected_generation: 1 });
    expect(rolledBack.routing).toMatchObject({ generation: 2, candidate_deployment_id: null, candidate_percent: 0 });
  });

  it('freezes a deterministic candidate or stable deployment without following later routing changes', async () => {
    const h = harness();
    await h.service.update('u1', target.release_id, target.action_id, { action_contract_version: target.action_contract_version, action_surface_sha256: target.action_surface_sha256, environment: 'PRODUCTION', stable_deployment_id: 'stable', candidate_deployment_id: 'candidate', candidate_percent: 100, expected_generation: 0 });
    const candidate = await h.service.freeze('consumer', target, 'PRODUCTION', 'run-1', 'image');
    expect(candidate).toMatchObject({ deployment_id: 'candidate', routing_generation: 1, node_path: 'image' });
    expect(cloudRoutingBucket('run-1', 'image', 1)).toBe(cloudRoutingBucket('run-1', 'image', 1));
    await h.service.update('u1', target.release_id, target.action_id, { action_contract_version: target.action_contract_version, action_surface_sha256: target.action_surface_sha256, environment: 'PRODUCTION', stable_deployment_id: 'stable', candidate_percent: 0, expected_generation: 1 });
    expect(candidate.deployment_id).toBe('candidate');
    const stable = await h.service.freeze('consumer', target, 'PRODUCTION', 'run-2', 'image');
    expect(stable).toMatchObject({ deployment_id: 'stable', routing_generation: 2 });
  });

  it('rejects cross-team or non-ready deployments when managing routing', async () => {
    const h = harness();
    h.auth.ensureCurrentTeam.mockResolvedValue({ teamId: 'other-team' });
    await expect(h.service.update('u2', target.release_id, target.action_id, { action_contract_version: target.action_contract_version, action_surface_sha256: target.action_surface_sha256, environment: 'PRODUCTION', stable_deployment_id: 'stable', expected_generation: 0 })).rejects.toMatchObject({ code: 'cloud_endpoint_not_ready' });
  });
});
