import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { badRequest, conflict, forbidden, notFound } from '../common';
import { AuthService } from './auth.service';
import {
  PERMISSION_CODE_SET,
  permissionCodesByScope,
  type PermissionScope,
} from './permissions/permission-codes';

/** 系统平台管理员角色 id（与 seed/migration 一致）。 */
export const PLATFORM_ADMIN_ROLE_ID = '00000000-0000-0000-0000-platform0001';

/** 公共 Role 序列化：转 HTTP 响应（对齐 contract Role schema camelCase）。 */
function publicRole(
  role: {
    id: string;
    name: string;
    scope: 'PLATFORM' | 'TEAM';
    teamId: string | null;
    isSystem: boolean;
    description: string;
    permissions: string[];
    createdAt: Date;
    updatedAt: Date;
  },
  memberCount = 0,
) {
  return {
    id: role.id,
    name: role.name,
    scope: role.scope,
    teamId: role.teamId,
    isSystem: role.isSystem,
    description: role.description,
    permissions: role.permissions,
    memberCount,
    createdAt: role.createdAt.toISOString(),
    updatedAt: role.updatedAt.toISOString(),
  };
}

@Injectable()
export class RoleService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  // ============ 权限码清单 ============

  /** 返回某 scope 的全部权限码定义（前端角色编辑页勾选面板数据源）。 */
  async listPermissions(scope: PermissionScope) {
    return { permissions: permissionCodesByScope(scope) };
  }

  // ============ 平台角色（scope=PLATFORM，平台管理员在 web 端管理） ============

  /** 列出全部平台级角色（含成员数）。需 platform.role.manage 权限。 */
  async listPlatformRoles(userId: string) {
    await this.auth.ensurePermission(userId, 'platform.role.manage');
    const roles = await this.prisma.role.findMany({
      where: { scope: 'PLATFORM' },
      orderBy: [{ isSystem: 'desc' }, { createdAt: 'asc' }],
    });
    // 成员数：平台角色通过 User.platformRoleId 关联
    const counts = await this.prisma.user.groupBy({
      by: ['platformRoleId'],
      where: { platformRoleId: { in: roles.map((r) => r.id) } },
      _count: { _all: true },
    });
    const countMap = new Map(counts.map((c) => [c.platformRoleId, c._count._all]));
    return { roles: roles.map((r) => publicRole(r, countMap.get(r.id) ?? 0)) };
  }

  /** 创建平台角色。需 platform.role.manage 权限。 */
  async createPlatformRole(userId: string, input: { name: string; description?: string; permissions?: string[] }) {
    await this.auth.ensurePermission(userId, 'platform.role.manage');
    const permissions = this.validatePermissions(input.permissions ?? [], 'PLATFORM');
    const existing = await this.prisma.role.findFirst({
      where: { scope: 'PLATFORM', name: input.name },
      select: { id: true },
    });
    if (existing) throw conflict('平台角色名已存在');
    const role = await this.prisma.role.create({
      data: {
        name: input.name,
        scope: 'PLATFORM',
        teamId: null,
        description: input.description ?? '',
        permissions,
        isSystem: false,
      },
    });
    await this.audit(userId, 'role.created', 'Role', role.id, { scope: 'PLATFORM', name: role.name, permissions });
    return { role: publicRole(role, 0) };
  }

  /** 更新平台角色。系统角色不可改权限。需 platform.role.manage 权限。 */
  async updatePlatformRole(userId: string, roleId: string, input: { name?: string; description?: string; permissions?: string[] }) {
    await this.auth.ensurePermission(userId, 'platform.role.manage');
    const role = await this.prisma.role.findUnique({ where: { id: roleId } });
    if (!role || role.scope !== 'PLATFORM') throw notFound('平台角色不存在');

    const data: { name?: string; description?: string; permissions?: string[] } = {};
    if (input.name !== undefined) {
      if (input.name !== role.name) {
        const dup = await this.prisma.role.findFirst({ where: { scope: 'PLATFORM', name: input.name, NOT: { id: roleId } } });
        if (dup) throw conflict('平台角色名已存在');
      }
      data.name = input.name;
    }
    if (input.description !== undefined) data.description = input.description;
    if (input.permissions !== undefined) {
      if (role.isSystem) throw forbidden('内置角色权限不可修改');
      data.permissions = this.validatePermissions(input.permissions, 'PLATFORM');
    }

    const updated = await this.prisma.role.update({ where: { id: roleId }, data });
    await this.audit(userId, 'role.updated', 'Role', roleId, { scope: 'PLATFORM', changes: data });
    return { role: publicRole(updated) };
  }

  /** 删除平台角色。系统角色不可删；有用户引用时拒绝（需先解除）。需 platform.role.manage 权限。 */
  async deletePlatformRole(userId: string, roleId: string) {
    await this.auth.ensurePermission(userId, 'platform.role.manage');
    const role = await this.prisma.role.findUnique({ where: { id: roleId } });
    if (!role || role.scope !== 'PLATFORM') throw notFound('平台角色不存在');
    if (role.isSystem) throw forbidden('内置角色不可删除');
    const refCount = await this.prisma.user.count({ where: { platformRoleId: roleId } });
    if (refCount > 0) throw conflict(`该角色仍有 ${refCount} 个用户引用，请先解除分配`);
    await this.prisma.role.delete({ where: { id: roleId } });
    await this.audit(userId, 'role.deleted', 'Role', roleId, { scope: 'PLATFORM', name: role.name });
    return { ok: true };
  }

  /** 为用户分配/撤销平台角色。需 platform.user.role.assign 权限。 */
  async assignPlatformRole(userId: string, targetUserId: string, roleId: string | null) {
    await this.auth.ensurePermission(userId, 'platform.user.role.assign');
    const target = await this.prisma.user.findUnique({ where: { id: targetUserId } });
    if (!target) throw notFound('用户不存在');
    if (roleId !== null) {
      const role = await this.prisma.role.findUnique({ where: { id: roleId } });
      if (!role || role.scope !== 'PLATFORM') throw badRequest('平台角色不存在');
    }
    await this.prisma.user.update({ where: { id: targetUserId }, data: { platformRoleId: roleId } });
    // 迁移期双写：platformRole 枚举同步（roleId=系统平台管理员 → PLATFORM_ADMIN，否则 NONE）
    const isPlatformAdmin = roleId === PLATFORM_ADMIN_ROLE_ID;
    await this.prisma.user.update({
      where: { id: targetUserId },
      data: { platformRole: isPlatformAdmin ? 'PLATFORM_ADMIN' : 'NONE', tokenVersion: { increment: 1 } },
    });
    await this.audit(userId, 'role.assigned', 'User', targetUserId, { scope: 'PLATFORM', roleId, platformRole: isPlatformAdmin ? 'PLATFORM_ADMIN' : 'NONE' });
    return { ok: true };
  }

  // ============ 团队角色（scope=TEAM，团队管理员在桌面端管理） ============

  /** 列出当前团队的全部角色（含成员数）。需 team.role.manage 权限。 */
  async listTeamRoles(userId: string) {
    await this.auth.ensurePermission(userId, 'team.role.manage');
    const m = await this.resolveCurrentTeam(userId);
    const roles = await this.prisma.role.findMany({
      where: { scope: 'TEAM', teamId: m.teamId },
      orderBy: [{ isSystem: 'desc' }, { createdAt: 'asc' }],
    });
    const counts = await this.prisma.teamMembership.groupBy({
      by: ['teamRoleId'],
      where: { teamRoleId: { in: roles.map((r) => r.id) }, status: 'ACTIVE' },
      _count: { _all: true },
    });
    const countMap = new Map(counts.map((c) => [c.teamRoleId, c._count._all]));
    return { roles: roles.map((r) => publicRole(r, countMap.get(r.id) ?? 0)) };
  }

  /** 创建团队角色。需 team.role.manage 权限。 */
  async createTeamRole(userId: string, input: { name: string; description?: string; permissions?: string[] }) {
    await this.auth.ensurePermission(userId, 'team.role.manage');
    const m = await this.resolveCurrentTeam(userId);
    const permissions = this.validatePermissions(input.permissions ?? [], 'TEAM');
    const existing = await this.prisma.role.findFirst({ where: { scope: 'TEAM', teamId: m.teamId, name: input.name } });
    if (existing) throw conflict('团队角色名已存在');
    const role = await this.prisma.role.create({
      data: {
        name: input.name,
        scope: 'TEAM',
        teamId: m.teamId,
        description: input.description ?? '',
        permissions,
        isSystem: false,
      },
    });
    await this.audit(userId, 'role.created', 'Role', role.id, { scope: 'TEAM', teamId: m.teamId, name: role.name, permissions });
    return { role: publicRole(role, 0) };
  }

  /** 更新团队角色。系统角色不可改权限；不可跨团队。需 team.role.manage 权限。 */
  async updateTeamRole(userId: string, roleId: string, input: { name?: string; description?: string; permissions?: string[] }) {
    await this.auth.ensurePermission(userId, 'team.role.manage');
    const m = await this.resolveCurrentTeam(userId);
    const role = await this.prisma.role.findUnique({ where: { id: roleId } });
    if (!role || role.scope !== 'TEAM' || role.teamId !== m.teamId) throw notFound('团队角色不存在');

    const data: { name?: string; description?: string; permissions?: string[] } = {};
    if (input.name !== undefined) {
      if (input.name !== role.name) {
        const dup = await this.prisma.role.findFirst({ where: { scope: 'TEAM', teamId: m.teamId, name: input.name, NOT: { id: roleId } } });
        if (dup) throw conflict('团队角色名已存在');
      }
      data.name = input.name;
    }
    if (input.description !== undefined) data.description = input.description;
    if (input.permissions !== undefined) {
      if (role.isSystem) throw forbidden('内置角色权限不可修改');
      data.permissions = this.validatePermissions(input.permissions, 'TEAM');
    }

    const updated = await this.prisma.role.update({ where: { id: roleId }, data });
    await this.audit(userId, 'role.updated', 'Role', roleId, { scope: 'TEAM', teamId: m.teamId, changes: data });
    return { role: publicRole(updated) };
  }

  /** 删除团队角色。系统角色不可删；有成员引用时拒绝。需 team.role.manage 权限。 */
  async deleteTeamRole(userId: string, roleId: string) {
    await this.auth.ensurePermission(userId, 'team.role.manage');
    const m = await this.resolveCurrentTeam(userId);
    const role = await this.prisma.role.findUnique({ where: { id: roleId } });
    if (!role || role.scope !== 'TEAM' || role.teamId !== m.teamId) throw notFound('团队角色不存在');
    if (role.isSystem) throw forbidden('内置角色不可删除');
    const refCount = await this.prisma.teamMembership.count({ where: { teamRoleId: roleId, status: 'ACTIVE' } });
    if (refCount > 0) throw conflict(`该角色仍有 ${refCount} 个成员引用，请先解除分配`);
    await this.prisma.role.delete({ where: { id: roleId } });
    await this.audit(userId, 'role.deleted', 'Role', roleId, { scope: 'TEAM', teamId: m.teamId, name: role.name });
    return { ok: true };
  }

  /** 为团队成员分配团队角色。需 team.member.role.assign 权限。 */
  async assignMemberRole(userId: string, targetUserId: string, roleId: string) {
    await this.auth.ensurePermission(userId, 'team.member.role.assign');
    const m = await this.resolveCurrentTeam(userId);
    const role = await this.prisma.role.findUnique({ where: { id: roleId } });
    if (!role || role.scope !== 'TEAM' || role.teamId !== m.teamId) throw badRequest('团队角色不存在');
    const target = await this.prisma.teamMembership.findUnique({
      where: { teamId_userId: { teamId: m.teamId, userId: targetUserId } },
    });
    if (!target || target.status !== 'ACTIVE') throw notFound('团队成员不存在');

    // 迁移期双写：teamRole 枚举同步（系统团队管理员→TEAM_ADMIN，否则 MEMBER）
    const isTeamAdmin = role.isSystem && role.name === '系统团队管理员';
    await this.prisma.teamMembership.update({
      where: { teamId_userId: { teamId: m.teamId, userId: targetUserId } },
      data: { teamRoleId: roleId, role: isTeamAdmin ? 'TEAM_ADMIN' : 'MEMBER' },
    });
    await this.audit(userId, 'role.assigned', 'TeamMembership', `${m.teamId}:${targetUserId}`, { scope: 'TEAM', teamId: m.teamId, targetUserId, roleId, teamRole: isTeamAdmin ? 'TEAM_ADMIN' : 'MEMBER' });
    return { ok: true };
  }

  // ============ 内部 helper ============

  /** 校验权限码：必须在注册表白名单 + scope 匹配（团队角色只能用 team.* 码）。 */
  private validatePermissions(codes: string[], scope: PermissionScope): string[] {
    const allowed = new Set(permissionCodesByScope(scope).map((p) => p.code));
    for (const code of codes) {
      if (!PERMISSION_CODE_SET.has(code)) throw badRequest(`未知权限码：${code}`);
      if (!allowed.has(code)) throw badRequest(`权限码 ${code} 不属于${scope === 'PLATFORM' ? '平台' : '团队'}级`);
    }
    return [...new Set(codes)]; // 去重
  }

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
