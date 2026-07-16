import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AppError, forbidden, notFound } from '../common';
import { AuthService } from './auth.service';
import { PLUGIN_AI_POLICY_VERSION } from './plugin-ai-policy';
import { evaluatePluginGovernance, type PluginGovernanceFacts, type PluginPolicyDecision } from './plugin-governance-evaluator';
import { PluginGovernancePolicyService } from './plugin-governance-policy.service';

type Operation = PluginGovernanceFacts['requiredOperations'][number];

@Injectable()
export class PluginGovernanceService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(PluginGovernancePolicyService) private readonly policies: PluginGovernancePolicyService,
  ) {}

  async authorizeRelease(userId: string, expected: { releaseId: string; packageId?: string; sha256?: string }, requiredOperations: Operation[], options: { enforce?: boolean; policyOverride?: PluginGovernanceFacts['policy']; action?: { action_id: string; action_contract_version: string; action_surface_sha256: string }; workflow?: { workflow_release_id: string; workflow_plan_sha256: string } } = {}): Promise<{ decision: PluginPolicyDecision; source: 'team' | 'marketplace'; release: NonNullable<Awaited<ReturnType<PluginGovernanceService['loadRelease']>>> }> {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const release = await this.loadRelease(expected.releaseId);
    if (!release || release.status === 'YANKED') throw notFound('插件发行版不存在或已撤回');
    if ((expected.packageId && release.packageId !== expected.packageId) || (expected.sha256 && release.sha256 !== expected.sha256)) throw new AppError(409, 'plugin_release_mismatch', '本机插件版本与平台发行版不一致，请重新下载');
    const source = release.package.ownerTeamId === membership.teamId ? 'team' as const : 'marketplace' as const;
    const entitlementAllowed = source === 'team' || (release.package.listing?.status === 'ACTIVE' && release.package.listing.priceCents === 0) || await this.prisma.pluginEntitlement.count({ where: { teamId: membership.teamId, packageId: release.packageId } }) > 0;
    const grants = source === 'team'
      ? await this.prisma.pluginGrant.findMany({
        where: {
          teamId: membership.teamId,
          packageId: release.packageId,
          OR: [
            { subjectKind: 'USER', subjectId: userId },
            ...(membership.teamRoleId ? [{ subjectKind: 'ROLE' as const, subjectId: membership.teamRoleId }] : []),
          ],
        },
        select: { subjectKind: true, effect: true },
      })
      : [];
    const grantEffect = (kind: 'USER' | 'ROLE') => {
      const matching = grants.filter((grant) => grant.subjectKind === kind);
      if (matching.some((grant) => grant.effect === 'DENY')) return 'DENY' as const;
      if (matching.some((grant) => grant.effect === 'ALLOW')) return 'ALLOW' as const;
      return undefined;
    };
    const active = await this.policies.active(membership.teamId);
    const manifest = release.manifest && typeof release.manifest === 'object' ? release.manifest as Record<string, unknown> : {};
    const capabilities = Array.isArray(manifest.capabilities) ? manifest.capabilities.flatMap((item) => item && typeof item === 'object' && typeof (item as { kind?: unknown }).kind === 'string' ? [(item as { kind: string }).kind] : []) : [];
    const decision = evaluatePluginGovernance({
      resource: { team_id: membership.teamId, package_id: release.packageId, release_id: release.id, sha256: release.sha256, source_kind: release.sourceKind, runtime_type: typeof manifest.runtime_type === 'string' ? manifest.runtime_type : 'client', package_policy_surface_sha256: release.packagePolicySurfaceSha256, declared_capabilities: capabilities, ...(options.action ? { action: options.action } : {}), ...(options.workflow ? { workflow: options.workflow } : {}) },
      requiredOperations, policyRevision: active.revision, policy: options.policyOverride === undefined ? active.document as PluginGovernanceFacts['policy'] : options.policyOverride,
      platformAllowed: release.status === 'PUBLISHED' && release.aiPolicyVersion === PLUGIN_AI_POLICY_VERSION && release.aiPolicyStatus === 'PASSED' && (source === 'team' || release.marketReviewStatus === 'APPROVED'),
      entitlementAllowed, userGrant: grantEffect('USER'), roleGrant: grantEffect('ROLE'),
    });
    if (!decision.allowed && options.enforce !== false) {
      await this.prisma.auditLog.create({ data: { actorUserId: userId, action: 'plugin.policy.decision_denied', targetType: 'PluginRelease', targetId: release.id, metadata: decision as object } });
      if (!entitlementAllowed) throw new AppError(402, 'payment_required', '当前团队尚未购买该插件');
      if (release.aiPolicyVersion !== PLUGIN_AI_POLICY_VERSION || release.aiPolicyStatus !== 'PASSED') throw new AppError(409, 'plugin_ai_policy_required', '插件发行版尚未通过当前 AI 使用政策检查');
      throw forbidden(decision.reason);
    }
    return { decision, source, release };
  }

  private loadRelease(releaseId: string) { return this.prisma.pluginRelease.findUnique({ where: { id: releaseId }, include: { package: { include: { listing: true } } } }); }
}
