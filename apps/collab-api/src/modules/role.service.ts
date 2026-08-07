import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { badRequest, conflict, forbidden, notFound } from '../common';
import { AuthService } from './auth.service';
import { normalizeAdminPage } from './admin-data-loading';
import {
  PERMISSION_CODE_SET,
  permissionCodesByScope,
  permissionModulesByScope,
  SYSTEM_PLATFORM_ADMIN_ROLE_ID,
  SYSTEM_TEAM_ADMIN_ROLE_CODE,
  type PermissionScope,
} from './permissions/permission-codes';

type RoleListQuery = {
  page?: number;
  pageSize?: number;
  q?: string;
};

const ROLE_DETAIL_SELECT = {
  id: true,
  name: true,
  code: true,
  scope: true,
  teamId: true,
  isSystem: true,
  description: true,
  permissions: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.RoleSelect;

const PLATFORM_ROLE_LIST_SELECT = {
  ...ROLE_DETAIL_SELECT,
  _count: { select: { users: true } },
} as const satisfies Prisma.RoleSelect;

const TEAM_ROLE_LIST_SELECT = {
  ...ROLE_DETAIL_SELECT,
  _count: {
    select: {
      memberships: { where: { status: 'ACTIVE' } },
    },
  },
} as const satisfies Prisma.RoleSelect;

/** 公共 Role 序列化：转 HTTP 响应（对齐 contract Role schema camelCase）。 */
function publicRole(
  role: {
    id: string;
    name: string;
    code: string | null;
    scope: 'PLATFORM' | 'TEAM';
    teamId: string | null;
    isSystem: boolean;
    description: string;
    permissions: string[];
    createdAt: Date;
    updatedAt: Date;
  },
  memberCount = 0
) {
  return {
    id: role.id,
    name: role.name,
    code: role.code,
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

function roleSummary(
  role: {
    id: string;
    name: string;
    code: string | null;
    scope: 'PLATFORM' | 'TEAM';
    teamId: string | null;
    isSystem: boolean;
    description: string;
    permissions: string[];
    createdAt: Date;
    updatedAt: Date;
  },
  memberCount: number
) {
  return {
    id: role.id,
    name: role.name,
    code: role.code,
    scope: role.scope,
    teamId: role.teamId,
    isSystem: role.isSystem,
    description: role.description,
    permissionCount: role.permissions.length,
    memberCount,
    createdAt: role.createdAt.toISOString(),
    updatedAt: role.updatedAt.toISOString(),
  };
}

function roleListWhere(
  scope: PermissionScope,
  teamId: string | null,
  query: RoleListQuery
): Prisma.RoleWhereInput {
  const where: Prisma.RoleWhereInput = { scope, teamId };
  const keyword = query.q?.trim();
  if (keyword) {
    where.OR = [
      { name: { contains: keyword, mode: 'insensitive' } },
      { code: { contains: keyword, mode: 'insensitive' } },
      { description: { contains: keyword, mode: 'insensitive' } },
    ];
  }
  return where;
}

@Injectable()
export class RoleService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthService) private readonly auth: AuthService
  ) {}

  // ============ 权限码清单 ============

  /** 返回某 scope 的权限模块（两级：模块→操作，前端勾选树数据源）+ 扁平权限码（向后兼容）。 */
  async listPermissions(scope: PermissionScope) {
    return { modules: permissionModulesByScope(scope), permissions: permissionCodesByScope(scope) };
  }

  // ============ 平台角色（scope=PLATFORM，平台管理员在 web 端管理） ============

  /** Platform role summaries are paginated; full permissions are loaded by getPlatformRole. */
  async listPlatformRoles(userId: string, query: RoleListQuery = {}) {
    await this.auth.ensurePermission(userId, 'platform.role.manage');
    const { page, pageSize, skip } = normalizeAdminPage(query);
    const where = roleListWhere('PLATFORM', null, query);
    const [roles, total] = await Promise.all([
      this.prisma.role.findMany({
        where,
        orderBy: [{ isSystem: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
        skip,
        take: pageSize,
        select: PLATFORM_ROLE_LIST_SELECT,
      }),
      this.prisma.role.count({ where }),
    ]);
    const items = roles.map(({ _count, ...role }) => roleSummary(role, _count.users));
    return { items, total, page, pageSize };
  }

  async getPlatformRole(userId: string, roleId: string) {
    await this.auth.ensurePermission(userId, 'platform.role.manage');
    const role = await this.prisma.role.findUnique({
      where: { id: roleId },
      select: ROLE_DETAIL_SELECT,
    });
    if (!role || role.scope !== 'PLATFORM') throw notFound('平台角色不存在');
    const memberCount = await this.prisma.user.count({ where: { platformRoleId: roleId } });
    return { role: publicRole(role, memberCount) };
  }

  /** 创建平台角色。需 platform.role.manage 权限。 */
  async createPlatformRole(
    userId: string,
    input: { name: string; code?: string; description?: string; permissions?: string[] }
  ) {
    await this.auth.ensurePermission(userId, 'platform.role.manage');
    const permissions = this.validatePermissions(input.permissions ?? [], 'PLATFORM');
    const existing = await this.prisma.role.findFirst({
      where: { scope: 'PLATFORM', name: input.name },
      select: { id: true },
    });
    if (existing) throw conflict('平台角色名已存在');
    const code = this.normalizeRoleCode(input.code);
    if (code !== null) await this.assertCodeAvailable('PLATFORM', null, code);
    const role = await this.prisma.role.create({
      data: {
        name: input.name,
        code,
        scope: 'PLATFORM',
        teamId: null,
        description: input.description ?? '',
        permissions,
        isSystem: false,
      },
    });
    await this.audit(userId, 'role.created', 'Role', role.id, {
      scope: 'PLATFORM',
      name: role.name,
      code,
      permissions,
    });
    return { role: publicRole(role, 0) };
  }

  /** 更新平台角色。系统角色不可改权限。需 platform.role.manage 权限。 */
  async updatePlatformRole(
    userId: string,
    roleId: string,
    input: { name?: string; code?: string; description?: string; permissions?: string[] }
  ) {
    await this.auth.ensurePermission(userId, 'platform.role.manage');
    const role = await this.prisma.role.findUnique({ where: { id: roleId } });
    if (!role || role.scope !== 'PLATFORM') throw notFound('平台角色不存在');

    const data: {
      name?: string;
      code?: string | null;
      description?: string;
      permissions?: string[];
    } = {};
    if (input.name !== undefined) {
      if (input.name !== role.name) {
        const dup = await this.prisma.role.findFirst({
          where: { scope: 'PLATFORM', name: input.name, NOT: { id: roleId } },
        });
        if (dup) throw conflict('平台角色名已存在');
      }
      data.name = input.name;
    }
    if (input.code !== undefined) {
      if (role.isSystem) throw forbidden('内置角色编码不可修改');
      const code = this.normalizeRoleCode(input.code);
      if (code !== null && code !== role.code)
        await this.assertCodeAvailable('PLATFORM', null, code, roleId);
      data.code = code;
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
    await this.audit(userId, 'role.deleted', 'Role', roleId, {
      scope: 'PLATFORM',
      name: role.name,
    });
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
    await this.prisma.user.update({
      where: { id: targetUserId },
      data: { platformRoleId: roleId },
    });
    // 迁移期双写：platformRole 枚举同步（roleId=系统平台管理员 → PLATFORM_ADMIN，否则 NONE）
    const isPlatformAdmin = roleId === SYSTEM_PLATFORM_ADMIN_ROLE_ID;
    await this.prisma.user.update({
      where: { id: targetUserId },
      data: {
        platformRole: isPlatformAdmin ? 'PLATFORM_ADMIN' : 'NONE',
        tokenVersion: { increment: 1 },
      },
    });
    await this.audit(userId, 'role.assigned', 'User', targetUserId, {
      scope: 'PLATFORM',
      roleId,
      platformRole: isPlatformAdmin ? 'PLATFORM_ADMIN' : 'NONE',
    });
    return { ok: true };
  }

  // ============ 团队角色（scope=TEAM，团队管理员在桌面端管理） ============

  /** 列出当前团队的全部角色（含成员数）。需 OR(team.role.create/update/delete, team.member.role.assign) 权限。 */
  async listTeamRoles(userId: string) {
    await this.auth.ensureAnyPermission(
      userId,
      'team.role.create',
      'team.role.update',
      'team.role.delete',
      'team.member.role.assign'
    );
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

  /** 创建团队角色。需 team.role.create 权限。 */
  async createTeamRole(
    userId: string,
    input: { name: string; code?: string; description?: string; permissions?: string[] }
  ) {
    await this.auth.ensurePermission(userId, 'team.role.create');
    const m = await this.resolveCurrentTeam(userId);
    const permissions = this.validatePermissions(input.permissions ?? [], 'TEAM');
    const existing = await this.prisma.role.findFirst({
      where: { scope: 'TEAM', teamId: m.teamId, name: input.name },
    });
    if (existing) throw conflict('团队角色名已存在');
    const code = this.normalizeRoleCode(input.code);
    if (code !== null) await this.assertCodeAvailable('TEAM', m.teamId, code);
    const role = await this.prisma.role.create({
      data: {
        name: input.name,
        code,
        scope: 'TEAM',
        teamId: m.teamId,
        description: input.description ?? '',
        permissions,
        isSystem: false,
      },
    });
    await this.audit(userId, 'role.created', 'Role', role.id, {
      scope: 'TEAM',
      teamId: m.teamId,
      name: role.name,
      code,
      permissions,
    });
    return { role: publicRole(role, 0) };
  }

  /** 更新团队角色。系统角色不可改权限；不可跨团队。需 team.role.update 权限。 */
  async updateTeamRole(
    userId: string,
    roleId: string,
    input: { name?: string; code?: string; description?: string; permissions?: string[] }
  ) {
    await this.auth.ensurePermission(userId, 'team.role.update');
    const m = await this.resolveCurrentTeam(userId);
    const role = await this.prisma.role.findUnique({ where: { id: roleId } });
    if (!role || role.scope !== 'TEAM' || role.teamId !== m.teamId)
      throw notFound('团队角色不存在');

    const data: {
      name?: string;
      code?: string | null;
      description?: string;
      permissions?: string[];
    } = {};
    if (input.name !== undefined) {
      if (input.name !== role.name) {
        const dup = await this.prisma.role.findFirst({
          where: { scope: 'TEAM', teamId: m.teamId, name: input.name, NOT: { id: roleId } },
        });
        if (dup) throw conflict('团队角色名已存在');
      }
      data.name = input.name;
    }
    if (input.code !== undefined) {
      if (role.isSystem) throw forbidden('内置角色编码不可修改');
      const code = this.normalizeRoleCode(input.code);
      if (code !== null && code !== role.code)
        await this.assertCodeAvailable('TEAM', m.teamId, code, roleId);
      data.code = code;
    }
    if (input.description !== undefined) data.description = input.description;
    if (input.permissions !== undefined) {
      if (role.isSystem) throw forbidden('内置角色权限不可修改');
      data.permissions = this.validatePermissions(input.permissions, 'TEAM');
    }

    const updated = await this.prisma.role.update({ where: { id: roleId }, data });
    await this.audit(userId, 'role.updated', 'Role', roleId, {
      scope: 'TEAM',
      teamId: m.teamId,
      changes: data,
    });
    return { role: publicRole(updated) };
  }

  /** 删除团队角色。系统角色不可删；有成员引用时拒绝。需 team.role.delete 权限。 */
  async deleteTeamRole(userId: string, roleId: string) {
    await this.auth.ensurePermission(userId, 'team.role.delete');
    const m = await this.resolveCurrentTeam(userId);
    const role = await this.prisma.role.findUnique({ where: { id: roleId } });
    if (!role || role.scope !== 'TEAM' || role.teamId !== m.teamId)
      throw notFound('团队角色不存在');
    if (role.isSystem) throw forbidden('内置角色不可删除');
    const refCount = await this.prisma.teamMembership.count({
      where: { teamRoleId: roleId, status: 'ACTIVE' },
    });
    if (refCount > 0) throw conflict(`该角色仍有 ${refCount} 个成员引用，请先解除分配`);
    await this.prisma.role.delete({ where: { id: roleId } });
    await this.audit(userId, 'role.deleted', 'Role', roleId, {
      scope: 'TEAM',
      teamId: m.teamId,
      name: role.name,
    });
    return { ok: true };
  }

  /** 为团队成员分配团队角色。需 team.member.role.assign 权限。 */
  async assignMemberRole(userId: string, targetUserId: string, roleId: string) {
    await this.auth.ensurePermission(userId, 'team.member.role.assign');
    const m = await this.resolveCurrentTeam(userId);
    const role = await this.prisma.role.findUnique({ where: { id: roleId } });
    if (!role || role.scope !== 'TEAM' || role.teamId !== m.teamId)
      throw badRequest('团队角色不存在');
    const target = await this.prisma.teamMembership.findUnique({
      where: { teamId_userId: { teamId: m.teamId, userId: targetUserId } },
    });
    if (!target || target.status !== 'ACTIVE') throw notFound('团队成员不存在');

    // 迁移期双写：teamRole 枚举同步（系统团队管理员→TEAM_ADMIN，否则 MEMBER）
    // 基于 code 检测（不依赖 name 字符串，更稳健，见 SYSTEM_TEAM_ADMIN_ROLE_CODE）
    const isTeamAdmin = role.isSystem && role.code === SYSTEM_TEAM_ADMIN_ROLE_CODE;
    await this.prisma.teamMembership.update({
      where: { teamId_userId: { teamId: m.teamId, userId: targetUserId } },
      data: { teamRoleId: roleId, role: isTeamAdmin ? 'TEAM_ADMIN' : 'MEMBER' },
    });
    await this.audit(userId, 'role.assigned', 'TeamMembership', `${m.teamId}:${targetUserId}`, {
      scope: 'TEAM',
      teamId: m.teamId,
      targetUserId,
      roleId,
      teamRole: isTeamAdmin ? 'TEAM_ADMIN' : 'MEMBER',
    });
    return { ok: true };
  }

  // ============ 平台管理员代管团队角色（scope=TEAM，指定 teamId，绕过 resolveCurrentTeam） ============
  // 用途：collab-admin 平台管理员在 web 端为任意团队管理角色。守卫 platform.team.role.manage。
  // 与上面 listTeamRole/createTeamRole/... 区别：直接用 :id 参数指定团队（平台管理员不必加入该团队），
  // 复用同一套 validatePermissions / normalizeRoleCode / assertCodeAvailable / 系统角色锁定 / 审计逻辑。

  /** 校验团队存在 + ACTIVE（代管前置；停用团队不允许角色管理，与桌面端 resolveCurrentTeam 语义一致）。 */
  private async assertTeamManaged(teamId: string) {
    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      select: { id: true, status: true },
    });
    if (!team) throw notFound('团队不存在');
    if (team.status !== 'ACTIVE') throw forbidden('团队当前不可用');
    return team;
  }

  /** Read-only governance remains available for suspended teams. */
  private async assertTeamExists(teamId: string) {
    const team = await this.prisma.team.findUnique({ where: { id: teamId }, select: { id: true } });
    if (!team) throw notFound('团队不存在');
    return team;
  }

  /** Managed-team role summaries are paginated; permissions are loaded by getTeamRoleForTeam. */
  async listTeamRolesForTeam(userId: string, teamId: string, query: RoleListQuery = {}) {
    await this.auth.ensurePermission(userId, 'platform.team.role.manage');
    await this.assertTeamExists(teamId);
    const { page, pageSize, skip } = normalizeAdminPage(query);
    const where = roleListWhere('TEAM', teamId, query);
    const [roles, total] = await Promise.all([
      this.prisma.role.findMany({
        where,
        orderBy: [{ isSystem: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
        skip,
        take: pageSize,
        select: TEAM_ROLE_LIST_SELECT,
      }),
      this.prisma.role.count({ where }),
    ]);
    const items = roles.map(({ _count, ...role }) => roleSummary(role, _count.memberships));
    return { items, total, page, pageSize };
  }

  async getTeamRoleForTeam(userId: string, teamId: string, roleId: string) {
    await this.auth.ensurePermission(userId, 'platform.team.role.manage');
    await this.assertTeamExists(teamId);
    const role = await this.prisma.role.findUnique({
      where: { id: roleId },
      select: ROLE_DETAIL_SELECT,
    });
    if (!role || role.scope !== 'TEAM' || role.teamId !== teamId) throw notFound('团队角色不存在');
    const memberCount = await this.prisma.teamMembership.count({
      where: { teamRoleId: roleId, status: 'ACTIVE' },
    });
    return { role: publicRole(role, memberCount) };
  }

  /** 为指定团队创建角色。需 platform.team.role.manage 权限。 */
  async createTeamRoleForTeam(
    userId: string,
    teamId: string,
    input: { name: string; code?: string; description?: string; permissions?: string[] }
  ) {
    await this.auth.ensurePermission(userId, 'platform.team.role.manage');
    await this.assertTeamManaged(teamId);
    const permissions = this.validatePermissions(input.permissions ?? [], 'TEAM');
    const existing = await this.prisma.role.findFirst({
      where: { scope: 'TEAM', teamId, name: input.name },
    });
    if (existing) throw conflict('团队角色名已存在');
    const code = this.normalizeRoleCode(input.code);
    if (code !== null) await this.assertCodeAvailable('TEAM', teamId, code);
    const role = await this.prisma.role.create({
      data: {
        name: input.name,
        code,
        scope: 'TEAM',
        teamId,
        description: input.description ?? '',
        permissions,
        isSystem: false,
      },
    });
    await this.audit(userId, 'role.created', 'Role', role.id, {
      scope: 'TEAM',
      teamId,
      managed: true,
      name: role.name,
      code,
      permissions,
    });
    return { role: publicRole(role, 0) };
  }

  /** 更新指定团队的角色。系统角色不可改权限/编码；role 必须属该团队。需 platform.team.role.manage 权限。 */
  async updateTeamRoleForTeam(
    userId: string,
    teamId: string,
    roleId: string,
    input: { name?: string; code?: string; description?: string; permissions?: string[] }
  ) {
    await this.auth.ensurePermission(userId, 'platform.team.role.manage');
    await this.assertTeamManaged(teamId);
    const role = await this.prisma.role.findUnique({ where: { id: roleId } });
    if (!role || role.scope !== 'TEAM' || role.teamId !== teamId) throw notFound('团队角色不存在');

    const data: {
      name?: string;
      code?: string | null;
      description?: string;
      permissions?: string[];
    } = {};
    if (input.name !== undefined) {
      if (input.name !== role.name) {
        const dup = await this.prisma.role.findFirst({
          where: { scope: 'TEAM', teamId, name: input.name, NOT: { id: roleId } },
        });
        if (dup) throw conflict('团队角色名已存在');
      }
      data.name = input.name;
    }
    if (input.code !== undefined) {
      if (role.isSystem) throw forbidden('内置角色编码不可修改');
      const code = this.normalizeRoleCode(input.code);
      if (code !== null && code !== role.code)
        await this.assertCodeAvailable('TEAM', teamId, code, roleId);
      data.code = code;
    }
    if (input.description !== undefined) data.description = input.description;
    if (input.permissions !== undefined) {
      if (role.isSystem) throw forbidden('内置角色权限不可修改');
      data.permissions = this.validatePermissions(input.permissions, 'TEAM');
    }

    const updated = await this.prisma.role.update({ where: { id: roleId }, data });
    await this.audit(userId, 'role.updated', 'Role', roleId, {
      scope: 'TEAM',
      teamId,
      managed: true,
      changes: data,
    });
    return { role: publicRole(updated) };
  }

  /** 删除指定团队的角色。系统角色不可删；有成员引用时拒绝。需 platform.team.role.manage 权限。 */
  async deleteTeamRoleForTeam(userId: string, teamId: string, roleId: string) {
    await this.auth.ensurePermission(userId, 'platform.team.role.manage');
    await this.assertTeamManaged(teamId);
    const role = await this.prisma.role.findUnique({ where: { id: roleId } });
    if (!role || role.scope !== 'TEAM' || role.teamId !== teamId) throw notFound('团队角色不存在');
    if (role.isSystem) throw forbidden('内置角色不可删除');
    const refCount = await this.prisma.teamMembership.count({
      where: { teamRoleId: roleId, status: 'ACTIVE' },
    });
    if (refCount > 0) throw conflict(`该角色仍有 ${refCount} 个成员引用，请先解除分配`);
    await this.prisma.role.delete({ where: { id: roleId } });
    await this.audit(userId, 'role.deleted', 'Role', roleId, {
      scope: 'TEAM',
      teamId,
      managed: true,
      name: role.name,
    });
    return { ok: true };
  }

  /** 为团队成员分配团队角色（代管：直接指定 teamId）。需 platform.team.role.manage 权限。
   *  复用「双写 teamRole 枚举」语义（系统团队管理员 code → TEAM_ADMIN，否则 MEMBER），与桌面端 assignMemberRole 一致。 */
  async assignMemberRoleForTeam(
    userId: string,
    teamId: string,
    targetUserId: string,
    roleId: string
  ) {
    await this.auth.ensurePermission(userId, 'platform.team.role.manage');
    await this.assertTeamManaged(teamId);
    const role = await this.prisma.role.findUnique({ where: { id: roleId } });
    if (!role || role.scope !== 'TEAM' || role.teamId !== teamId)
      throw badRequest('团队角色不存在');
    const target = await this.prisma.teamMembership.findUnique({
      where: { teamId_userId: { teamId, userId: targetUserId } },
    });
    if (!target || target.status !== 'ACTIVE') throw notFound('团队成员不存在');

    const isTeamAdmin = role.isSystem && role.code === SYSTEM_TEAM_ADMIN_ROLE_CODE;
    await this.prisma.teamMembership.update({
      where: { teamId_userId: { teamId, userId: targetUserId } },
      data: { teamRoleId: roleId, role: isTeamAdmin ? 'TEAM_ADMIN' : 'MEMBER' },
    });
    await this.audit(userId, 'role.assigned', 'TeamMembership', `${teamId}:${targetUserId}`, {
      scope: 'TEAM',
      teamId,
      managed: true,
      targetUserId,
      roleId,
      teamRole: isTeamAdmin ? 'TEAM_ADMIN' : 'MEMBER',
    });
    return { ok: true };
  }

  // ============ 内部 helper ============

  /** 校验权限码：必须在注册表白名单 + scope 匹配（团队角色只能用 team.* 码）。 */
  private validatePermissions(codes: string[], scope: PermissionScope): string[] {
    const allowed = new Set(permissionCodesByScope(scope).map((p) => p.code));
    for (const code of codes) {
      if (!PERMISSION_CODE_SET.has(code)) throw badRequest(`未知权限码：${code}`);
      if (!allowed.has(code))
        throw badRequest(`权限码 ${code} 不属于${scope === 'PLATFORM' ? '平台' : '团队'}级`);
    }
    return [...new Set(codes)]; // 去重
  }

  /** 规范化角色编码：trim + 空串/null → null（表示不设编码）。DTO 已用正则校验非空值格式。 */
  private normalizeRoleCode(raw: string | undefined | null): string | null {
    if (raw === undefined || raw === null) return null;
    const trimmed = raw.trim();
    return trimmed.length === 0 ? null : trimmed;
  }

  /** 校验编码在同 scope+teamId 下唯一（排除自身）。code=null 跳过（多 null 行互不冲突）。 */
  private async assertCodeAvailable(
    scope: PermissionScope,
    teamId: string | null,
    code: string,
    excludeRoleId?: string
  ): Promise<void> {
    const dup = await this.prisma.role.findFirst({
      where: { scope, teamId, code, ...(excludeRoleId ? { NOT: { id: excludeRoleId } } : {}) },
      select: { id: true },
    });
    if (dup) throw conflict('角色编码已存在');
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

  private async audit(
    actorUserId: string,
    action: string,
    targetType: string,
    targetId: string,
    metadata?: unknown
  ) {
    await this.prisma.auditLog.create({
      data: { actorUserId, action, targetType, targetId, metadata: metadata as object },
    });
  }
}
