// RoleService 单测：覆盖平台/团队角色 CRUD + 成员角色分配 + 权限码校验 + 内置角色保护。
// 参考 team.service.spec.ts：mock PrismaService + AuthService（ensurePermission 直接放行或抛 forbidden）。
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { RoleService } from './role.service';
import { SYSTEM_PLATFORM_ADMIN_ROLE_ID as PLATFORM_ADMIN_ROLE_ID } from './permissions/permission-codes';
import { badRequest, conflict, forbidden, notFound } from '../common';

function mockPrisma() {
  return {
    role: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
      groupBy: vi.fn(async () => []),
    },
    teamMembership: {
      findUnique: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
      groupBy: vi.fn(async () => []),
    },
    auditLog: { create: vi.fn(async () => ({})) },
  };
}

function mockAuth() {
  return {
    ensurePermission: vi.fn(async () => ({ perms: new Set() })),
    ensureAnyPermission: vi.fn(async () => ({ perms: new Set() })),
  };
}

function makeRole(overrides: Record<string, unknown> = {}) {
  return {
    id: 'role-1',
    name: '自定义角色',
    code: null,
    scope: 'TEAM' as const,
    teamId: 'team-1',
    isSystem: false,
    description: '',
    permissions: ['team.dashboard.view'],
    createdAt: new Date('2026-06-21T00:00:00.000Z'),
    updatedAt: new Date('2026-06-21T00:00:00.000Z'),
    ...overrides,
  };
}

describe('RoleService 团队角色 + 平台角色', () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let auth: ReturnType<typeof mockAuth>;
  let service: RoleService;

  beforeEach(() => {
    prisma = mockPrisma();
    auth = mockAuth();
    // resolveCurrentTeam mock：返回 ACTIVE 团队 membership
    prisma.teamMembership.findFirst = vi.fn(async () => ({
      teamId: 'team-1',
      userId: 'admin-1',
      teamRoleId: 'team-admin-team-1',
      team: { status: 'ACTIVE' },
    }));
    // @ts-expect-error mock 不实现完整 PrismaService 接口
    service = new RoleService(prisma, auth);
  });

  describe('listPermissions', () => {
    it('返回对应 scope 的权限码清单', async () => {
      const result = await service.listPermissions('PLATFORM');
      expect(result.permissions.length).toBeGreaterThan(0);
      expect(result.permissions.every((p) => p.scope === 'PLATFORM')).toBe(true);
    });
  });

  describe('createTeamRole', () => {
    it('正常创建团队角色', async () => {
      prisma.role.findFirst.mockResolvedValue(null); // 无重名
      prisma.role.create.mockResolvedValue(makeRole());
      const result = await service.createTeamRole('admin-1', { name: '开发者', permissions: ['team.dashboard.view'] });
      expect(result.role.name).toBe('自定义角色');
      expect(prisma.role.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ scope: 'TEAM', teamId: 'team-1', name: '开发者' }),
      }));
      expect(prisma.auditLog.create).toHaveBeenCalled();
    });

    it('创建角色携带 code 时写入并校验唯一性', async () => {
      prisma.role.findFirst.mockResolvedValue(null); // 无重名
      prisma.role.create.mockResolvedValue(makeRole({ code: 'developer' }));
      await service.createTeamRole('admin-1', { name: '开发者', code: 'developer' });
      expect(prisma.role.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ code: 'developer' }),
      }));
    });

    it('创建角色 code 重复拒绝 409', async () => {
      // 第一次 findFirst（name 查重）返回 null；第二次 findFirst（code 查重，assertCodeAvailable）返回已存在
      prisma.role.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(makeRole({ code: 'developer' }));
      await expect(
        service.createTeamRole('admin-1', { name: '新角色', code: 'developer' }),
      ).rejects.toMatchObject({ status: 409 });
    });

    it('团队角色名重复拒绝 409', async () => {
      prisma.role.findFirst.mockResolvedValue(makeRole()); // 已存在
      await expect(
        service.createTeamRole('admin-1', { name: '自定义角色' }),
      ).rejects.toMatchObject({ status: 409 });
    });

    it('权限码不属于团队级拒绝 400', async () => {
      await expect(
        service.createTeamRole('admin-1', { name: 'R', permissions: ['platform.user.list'] }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('未知权限码拒绝 400', async () => {
      await expect(
        service.createTeamRole('admin-1', { name: 'R', permissions: ['team.unknown.code'] }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('无 team.role.create 权限拒绝 403', async () => {
      auth.ensurePermission.mockRejectedValue(forbidden());
      await expect(service.createTeamRole('admin-1', { name: 'R' })).rejects.toMatchObject({ status: 403 });
    });
  });

  describe('listTeamRoles（OR 守卫）', () => {
    it('只配 team.member.role.assign 也能 list（ensureAnyPermission 放行）', async () => {
      prisma.role.findMany.mockResolvedValue([]);
      const result = await service.listTeamRoles('admin-1');
      expect(result.roles).toEqual([]);
      expect(auth.ensureAnyPermission).toHaveBeenCalledWith(
        'admin-1',
        'team.role.create',
        'team.role.update',
        'team.role.delete',
        'team.member.role.assign',
      );
    });

    it('无任一 list 守卫权限拒绝 403', async () => {
      auth.ensureAnyPermission.mockRejectedValue(forbidden());
      await expect(service.listTeamRoles('admin-1')).rejects.toMatchObject({ status: 403 });
    });
  });

  describe('updateTeamRole', () => {
    it('系统角色改权限拒绝 403', async () => {
      prisma.role.findUnique.mockResolvedValue(makeRole({ isSystem: true, id: 'team-admin-team-1' }));
      await expect(
        service.updateTeamRole('admin-1', 'team-admin-team-1', { permissions: ['team.dashboard.view'] }),
      ).rejects.toMatchObject({ status: 403 });
    });

    it('跨团队角色拒绝 404', async () => {
      prisma.role.findUnique.mockResolvedValue(makeRole({ teamId: 'other-team' }));
      await expect(
        service.updateTeamRole('admin-1', 'role-1', { name: 'X' }),
      ).rejects.toMatchObject({ status: 404 });
    });

    it('角色不存在拒绝 404', async () => {
      prisma.role.findUnique.mockResolvedValue(null);
      await expect(service.updateTeamRole('admin-1', 'nope', { name: 'X' })).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('deleteTeamRole', () => {
    it('系统角色不可删 403', async () => {
      prisma.role.findUnique.mockResolvedValue(makeRole({ isSystem: true }));
      await expect(service.deleteTeamRole('admin-1', 'role-1')).rejects.toMatchObject({ status: 403 });
    });

    it('有成员引用时拒绝 409', async () => {
      prisma.role.findUnique.mockResolvedValue(makeRole({ isSystem: false }));
      prisma.teamMembership.count.mockResolvedValue(3);
      await expect(service.deleteTeamRole('admin-1', 'role-1')).rejects.toMatchObject({ status: 409 });
    });

    it('正常删除', async () => {
      prisma.role.findUnique.mockResolvedValue(makeRole({ isSystem: false }));
      prisma.teamMembership.count.mockResolvedValue(0);
      prisma.role.delete.mockResolvedValue(makeRole());
      const result = await service.deleteTeamRole('admin-1', 'role-1');
      expect(result.ok).toBe(true);
    });
  });

  describe('assignMemberRole', () => {
    it('目标角色不属于本团队拒绝 400', async () => {
      prisma.role.findUnique.mockResolvedValue(makeRole({ teamId: 'other-team' }));
      await expect(
        service.assignMemberRole('admin-1', 'u2', 'role-1'),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('目标用户不是本团队成员拒绝 404', async () => {
      prisma.role.findUnique.mockResolvedValue(makeRole());
      prisma.teamMembership.findUnique.mockResolvedValue(null);
      await expect(
        service.assignMemberRole('admin-1', 'u2', 'role-1'),
      ).rejects.toMatchObject({ status: 404 });
    });

    it('系统团队管理员角色双写 teamRole=TEAM_ADMIN', async () => {
      // 基于 code 检测（不依赖 name 字符串）
      prisma.role.findUnique.mockResolvedValue(makeRole({ id: 'team-admin-team-1', name: '系统团队管理员', code: 'team_admin', isSystem: true }));
      prisma.teamMembership.findUnique.mockResolvedValue({ teamId: 'team-1', userId: 'u2', status: 'ACTIVE' });
      prisma.teamMembership.update.mockResolvedValue({});
      await service.assignMemberRole('admin-1', 'u2', 'team-admin-team-1');
      expect(prisma.teamMembership.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ role: 'TEAM_ADMIN', teamRoleId: 'team-admin-team-1' }),
      }));
    });
  });

  describe('平台角色', () => {
    it('assignPlatformRole 系统平台管理员角色双写 platformRole=PLATFORM_ADMIN + 吊销 tokenVersion', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u2' });
      prisma.role.findUnique.mockResolvedValue({ id: PLATFORM_ADMIN_ROLE_ID, scope: 'PLATFORM' });
      prisma.user.update.mockResolvedValue({});
      await service.assignPlatformRole('admin-1', 'u2', PLATFORM_ADMIN_ROLE_ID);
      // 第二次 update 写 platformRole + tokenVersion increment
      expect(prisma.user.update).toHaveBeenCalledTimes(2);
      expect(prisma.user.update).toHaveBeenLastCalledWith(expect.objectContaining({
        data: expect.objectContaining({ platformRole: 'PLATFORM_ADMIN', tokenVersion: { increment: 1 } }),
      }));
    });

    it('assignPlatformRole roleId=null 撤销平台角色，platformRole=NONE', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u2' });
      prisma.user.update.mockResolvedValue({});
      await service.assignPlatformRole('admin-1', 'u2', null);
      expect(prisma.user.update).toHaveBeenLastCalledWith(expect.objectContaining({
        data: expect.objectContaining({ platformRole: 'NONE', tokenVersion: { increment: 1 } }),
      }));
    });

    it('createPlatformRole 平台角色名重复拒绝 409', async () => {
      prisma.role.findFirst.mockResolvedValue(makeRole({ scope: 'PLATFORM' }));
      await expect(
        service.createPlatformRole('admin-1', { name: '已有角色' }),
      ).rejects.toMatchObject({ status: 409 });
    });

    it('createPlatformRole 平台角色用了团队权限码拒绝 400', async () => {
      await expect(
        service.createPlatformRole('admin-1', { name: 'R', permissions: ['team.dashboard.view'] }),
      ).rejects.toMatchObject({ status: 400 });
    });
  });
});
