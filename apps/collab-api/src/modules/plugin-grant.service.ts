import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { badRequest, forbidden, notFound } from '../common';
import { AuthService } from './auth.service';
import { SYSTEM_TEAM_ADMIN_ROLE_CODE } from './permissions/permission-codes';

/** 插件授权行序列化：转 HTTP 响应（对齐 contract PluginGrantRow camelCase）。 */
function publicGrant(grant: {
  id: string;
  teamId: string;
  pluginId?: string | null;
  packageId?: string | null;
  subjectKind: 'USER' | 'ROLE';
  subjectId: string;
  effect: 'ALLOW' | 'DENY';
  createdBy: string | null;
  createdAt: Date;
}) {
  return {
    id: grant.id,
    teamId: grant.teamId,
    pluginId: grant.pluginId ?? null,
    packageId: grant.packageId ?? null,
    subjectKind: grant.subjectKind,
    subjectId: grant.subjectId,
    effect: grant.effect,
    createdBy: grant.createdBy,
    createdAt: grant.createdAt.toISOString(),
  };
}

@Injectable()
export class PluginGrantService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  /** 列出某插件在当前团队的全部授权。需 team.plugin.grant.manage 权限。 */
  async listGrants(userId: string, packageId: string) {
    await this.auth.ensurePermission(userId, 'team.plugin.grant.manage');
    const m = await this.resolveCurrentTeam(userId);
    const pluginPackage = await this.prisma.pluginPackage.findUnique({ where: { id: packageId } });
    if (!pluginPackage || pluginPackage.ownerTeamId !== m.teamId) throw notFound('插件包不存在');
    const grants = await this.prisma.pluginGrant.findMany({
      where: { teamId: m.teamId, packageId },
      orderBy: { createdAt: 'desc' },
    });
    return { grants: grants.map(publicGrant) };
  }

  /** 设置/更新插件授权（upsert 语义：同 teamId+pluginId+subjectKind+subjectId 存在则更新 effect）。 */
  async setGrant(userId: string, packageId: string, input: { subjectKind: 'USER' | 'ROLE'; subjectId: string; effect: 'ALLOW' | 'DENY' }) {
    await this.auth.ensurePermission(userId, 'team.plugin.grant.manage');
    const m = await this.resolveCurrentTeam(userId);
    const pluginPackage = await this.prisma.pluginPackage.findUnique({ where: { id: packageId } });
    if (!pluginPackage || pluginPackage.ownerTeamId !== m.teamId) throw notFound('插件包不存在');

    // 校验主体有效性
    if (input.subjectKind === 'USER') {
      const member = await this.prisma.teamMembership.findUnique({
        where: { teamId_userId: { teamId: m.teamId, userId: input.subjectId } },
      });
      if (!member || member.status !== 'ACTIVE') throw badRequest('目标用户不是本团队成员');
    } else {
      const role = await this.prisma.role.findUnique({ where: { id: input.subjectId } });
      if (!role || role.scope !== 'TEAM' || role.teamId !== m.teamId) throw badRequest('目标角色不是本团队角色');
    }

    const grant = await this.prisma.pluginGrant.upsert({
      where: {
        teamId_packageId_subjectKind_subjectId: {
          teamId: m.teamId,
          packageId,
          subjectKind: input.subjectKind,
          subjectId: input.subjectId,
        },
      },
      update: { effect: input.effect },
      create: {
        teamId: m.teamId,
        packageId,
        subjectKind: input.subjectKind,
        subjectId: input.subjectId,
        effect: input.effect,
        createdBy: userId,
      },
    });
    await this.audit(userId, 'plugin.grant.set', 'PluginGrant', grant.id, { teamId: m.teamId, packageId, subjectKind: input.subjectKind, subjectId: input.subjectId, effect: input.effect });
    return { grant: publicGrant(grant) };
  }

  /** 移除插件授权（恢复默认）。 */
  async removeGrant(userId: string, packageId: string, subjectKind: 'USER' | 'ROLE', subjectId: string) {
    await this.auth.ensurePermission(userId, 'team.plugin.grant.manage');
    const m = await this.resolveCurrentTeam(userId);
    const grant = await this.prisma.pluginGrant.findUnique({
      where: {
        teamId_packageId_subjectKind_subjectId: {
          teamId: m.teamId,
          packageId,
          subjectKind,
          subjectId,
        },
      },
    });
    if (!grant) throw notFound('授权记录不存在');
    await this.prisma.pluginGrant.delete({ where: { id: grant.id } });
    await this.audit(userId, 'plugin.grant.removed', 'PluginGrant', grant.id, { teamId: m.teamId, packageId, subjectKind, subjectId });
    return { ok: true };
  }

  /**
   * 授权解析：判断某用户在某团队能否使用某插件。
   *
   * 语义（deny 优先，user 级优先于 role 级，团队管理员默认放行）：
   *  1. 团队管理员（系统团队管理员角色）→ 默认放行（不受 grant 限制，否则会锁死自己）。
   *  2. 查 user 级 grant：有 DENY → 拒绝；有 ALLOW → 放行。
   *  3. 查 role 级 grant（用户当前团队角色）：有 DENY → 拒绝；有 ALLOW → 放行。
   *  4. 无任何 grant → 放行（默认可用，grant 是「显式收紧」而非「显式放开」）。
   *
   * 供 PluginService.availablePlugins 过滤 + 桌面端运行时二次校验。
   */
  async resolvePluginAccess(teamId: string, pluginId: string, userId: string, teamRoleId: string | null): Promise<boolean> {
    // 1. 团队管理员默认放行
    if (teamRoleId) {
      const role = await this.prisma.role.findUnique({
        where: { id: teamRoleId },
        select: { isSystem: true, code: true },
      });
      // 基于 code 检测（不依赖 name 字符串，更稳健，见 SYSTEM_TEAM_ADMIN_ROLE_CODE）
      if (role?.isSystem && role.code === SYSTEM_TEAM_ADMIN_ROLE_CODE) return true;
    }

    const orConditions: Array<{ subjectKind: 'USER' | 'ROLE'; subjectId: string }> = [
      { subjectKind: 'USER', subjectId: userId },
    ];
    if (teamRoleId) orConditions.push({ subjectKind: 'ROLE', subjectId: teamRoleId });
    const grants = await this.prisma.pluginGrant.findMany({
      where: { teamId, pluginId, OR: orConditions },
      select: { subjectKind: true, effect: true },
    });

    // 2. user 级优先
    const userGrants = grants.filter((g) => g.subjectKind === 'USER');
    if (userGrants.some((g) => g.effect === 'DENY')) return false;
    if (userGrants.some((g) => g.effect === 'ALLOW')) return true;

    // 3. role 级
    const roleGrants = grants.filter((g) => g.subjectKind === 'ROLE');
    if (roleGrants.some((g) => g.effect === 'DENY')) return false;
    if (roleGrants.some((g) => g.effect === 'ALLOW')) return true;

    // 4. 默认放行
    return true;
  }

  // ============ 内部 helper ============

  /** 解析当前团队 membership（与 ensureCurrentTeam 同款：ACTIVE + team ACTIVE）。 */
  private async resolveCurrentTeam(userId: string) {
    const membership = await this.prisma.teamMembership.findFirst({
      where: { userId, status: 'ACTIVE' },
      include: { team: { select: { status: true } } },
      orderBy: { joinedAt: 'desc' },
    });
    if (!membership) throw forbidden('请先加入团队');
    if (membership.team.status !== 'ACTIVE') throw forbidden('团队当前不可用');
    return membership;
  }

  private async audit(actorUserId: string, action: string, targetType: string, targetId: string, metadata?: unknown) {
    await this.prisma.auditLog.create({ data: { actorUserId, action, targetType, targetId, metadata: metadata as object } });
  }
}
