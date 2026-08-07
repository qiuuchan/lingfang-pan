import { describe, expect, it, vi } from 'vitest';
import { PluginGovernanceService } from './plugin-governance.service';

const surface = 'a'.repeat(64);
const release = {
  id: 'r1',
  packageId: 'p1',
  sha256: 'b'.repeat(64),
  status: 'PUBLISHED',
  sourceKind: 'API',
  packagePolicySurfaceSha256: surface,
  aiPolicyVersion: 1,
  aiPolicyStatus: 'PASSED',
  marketReviewStatus: 'APPROVED',
  manifest: { runtime_type: 'client', capabilities: [] },
  package: {
    ownerTeamId: 'team-1',
    authorUserId: 'owner-1',
    governanceStatus: 'ACTIVE',
    listing: { status: 'ACTIVE', priceCents: 0 },
  },
};

function policy(
  operations: Array<'invoke_action' | 'run_workflow'> = ['invoke_action', 'run_workflow']
) {
  return {
    schema_version: 1 as const,
    enforcement_mode: 'ENFORCE' as const,
    allowed_source_kinds: [],
    denied_capability_kinds: [],
    rules: [
      {
        rule_id: 'package-allow',
        effect: 'ALLOW' as const,
        operations,
        target: { kind: 'PACKAGE' as const, package_id: 'p1', approved_surface_sha256: surface },
      },
    ],
  };
}

function harness(
  options: {
    role?: string;
    userId?: string;
    grants?: Array<{ subjectKind: 'USER' | 'ROLE'; effect: 'ALLOW' | 'DENY' }>;
  } = {}
) {
  const findUnique = vi.fn().mockResolvedValue(release);
  const entitlementCount = vi.fn().mockResolvedValue(0);
  const grantFindMany = vi.fn().mockResolvedValue(options.grants ?? []);
  const auditCreate = vi.fn().mockResolvedValue({});
  const prisma = {
    pluginRelease: { findUnique },
    pluginEntitlement: { count: entitlementCount },
    pluginGrant: { findMany: grantFindMany },
    auditLog: { create: auditCreate },
  };
  const auth = {
    ensureCurrentTeam: vi.fn().mockResolvedValue({
      teamId: 'team-1',
      teamRoleId: options.role === 'TEAM_ADMIN' ? 'admin-role' : 'member-role',
      role: options.role ?? 'MEMBER',
    }),
  };
  const policies = { active: vi.fn().mockResolvedValue({ revision: 7, document: policy() }) };
  const service = new PluginGovernanceService(prisma as never, auth as never, policies as never);
  return { service, prisma, auth, policies };
}

describe('PluginGovernanceService', () => {
  it('loads release, entitlement, grants, and policy once for a compound requiredOperations set', async () => {
    const h = harness();
    const result = await h.service.authorizeRelease(
      'member-1',
      {
        releaseId: release.id,
        packageId: release.packageId,
        sha256: release.sha256,
      },
      ['run_workflow', 'invoke_action', 'invoke_action']
    );

    expect(result.decision.allowed).toBe(true);
    expect(result.decision.required_operations).toEqual(['invoke_action', 'run_workflow']);
    expect(result.decision.operation_results).toHaveLength(2);
    expect(h.prisma.pluginRelease.findUnique).toHaveBeenCalledOnce();
    // Team-owned packages have entitlement by provenance; no marketplace
    // entitlement query is needed, while the remaining facts are each loaded once.
    expect(h.prisma.pluginEntitlement.count).not.toHaveBeenCalled();
    expect(h.prisma.pluginGrant.findMany).toHaveBeenCalledOnce();
    expect(h.policies.active).toHaveBeenCalledOnce();
    expect(h.prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it.each([
    { role: 'TEAM_ADMIN', userId: 'admin-1' },
    { role: 'OWNER', userId: 'owner-1' },
  ])('$role does not bypass an explicit user DENY at runtime', async ({ role, userId }) => {
    const h = harness({ role, userId, grants: [{ subjectKind: 'USER', effect: 'DENY' }] });
    await expect(
      h.service.authorizeRelease(
        userId,
        {
          releaseId: release.id,
          packageId: release.packageId,
          sha256: release.sha256,
        },
        ['invoke_action']
      )
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(h.prisma.pluginGrant.findMany).toHaveBeenCalledOnce();
    expect(h.prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'plugin.policy.decision_denied' }),
      })
    );
  });

  it('preserves user-over-role grant precedence while resolving package grants once', async () => {
    const h = harness({
      grants: [
        { subjectKind: 'USER', effect: 'ALLOW' },
        { subjectKind: 'ROLE', effect: 'DENY' },
      ],
    });
    const result = await h.service.authorizeRelease(
      'member-1',
      {
        releaseId: release.id,
        packageId: release.packageId,
        sha256: release.sha256,
      },
      ['invoke_action']
    );
    expect(result.decision.allowed).toBe(true);
    expect(result.decision.reason_code).toBe('allowed');
    expect(h.prisma.pluginGrant.findMany).toHaveBeenCalledOnce();
  });
});
