// RoleService 单测：覆盖平台/团队角色 CRUD + 成员角色分配 + 权限码校验 + 内置角色保护。
// 参考 team.service.spec.ts：mock PrismaService + AuthService（ensurePermission 直接放行或抛 forbidden）。
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { RoleService } from './role.service';
import { SYSTEM_PLATFORM_ADMIN_ROLE_ID as PLATFORM_ADMIN_ROLE_ID } from './permissions/permission-codes';
import { PERMISSION_CODE_SET } from './permissions/permission-codes';
import { badRequest, conflict, forbidden, notFound } from '../common';

function mockPrisma() {
  return {
    role: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(async () => 0),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    team: {
      findUnique: vi.fn(),
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
    // 默认持有全部注册权限码（模拟内置管理员角色）→ 超集校验默认放行；
    // 单测「权限不足」时按需 mock 返回受限 perms。
    ensurePermission: vi.fn(async () => ({ perms: new Set(PERMISSION_CODE_SET) })),
    ensureAnyPermission: vi.fn(async () => ({ perms: new Set(PERMISSION_CODE_SET) })),
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
      role: 'TEAM_ADMIN', // 双写字段（H-4：系统团队管理员角色分配权判定）
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

  describe('平台角色动态加载', () => {
    it('列表分页仅返回 permissionCount，并让 findMany/count 共用 where', async () => {
      prisma.role.findMany.mockResolvedValueOnce([
        {
          ...makeRole({
            scope: 'PLATFORM',
            teamId: null,
            permissions: ['platform.dashboard.view', 'platform.user.list'],
          }),
          _count: { users: 3 },
        },
      ]);
      prisma.role.count.mockResolvedValueOnce(9);

      const result = await service.listPlatformRoles('admin-1', {
        page: 2,
        pageSize: 5,
        q: 'custom',
      });

      const listArgs = prisma.role.findMany.mock.calls[0][0] as Record<string, any>;
      const countArgs = prisma.role.count.mock.calls[0][0] as Record<string, any>;
      expect(listArgs).toMatchObject({ skip: 5, take: 5 });
      expect(countArgs.where).toBe(listArgs.where);
      expect(result).toMatchObject({ total: 9, page: 2, pageSize: 5 });
      expect(result.items[0]).toMatchObject({ permissionCount: 2, memberCount: 3 });
      expect(result.items[0]).not.toHaveProperty('permissions');
    });

    it('详情按 id 返回完整 permissions', async () => {
      prisma.role.findUnique.mockResolvedValueOnce(
        makeRole({
          scope: 'PLATFORM',
          teamId: null,
          permissions: ['platform.dashboard.view'],
        })
      );
      prisma.user.count.mockResolvedValueOnce(2);

      const result = await service.getPlatformRole('admin-1', 'role-1');

      expect(result.role.permissions).toEqual(['platform.dashboard.view']);
      expect(result.role.memberCount).toBe(2);
      expect(prisma.role.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'role-1' },
          select: expect.objectContaining({ permissions: true }),
        })
      );
    });
  });

  describe('createTeamRole', () => {
    it('正常创建团队角色', async () => {
      prisma.role.findFirst.mockResolvedValue(null); // 无重名
      prisma.role.create.mockResolvedValue(makeRole());
      const result = await service.createTeamRole('admin-1', {
        name: '开发者',
        permissions: ['team.dashboard.view'],
      });
      expect(result.role.name).toBe('自定义角色');
      expect(prisma.role.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ scope: 'TEAM', teamId: 'team-1', name: '开发者' }),
        })
      );
      expect(prisma.auditLog.create).toHaveBeenCalled();
    });

    it('创建角色携带 code 时写入并校验唯一性', async () => {
      prisma.role.findFirst.mockResolvedValue(null); // 无重名
      prisma.role.create.mockResolvedValue(makeRole({ code: 'developer' }));
      await service.createTeamRole('admin-1', { name: '开发者', code: 'developer' });
      expect(prisma.role.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ code: 'developer' }),
        })
      );
    });

    it('创建角色 code 重复拒绝 409', async () => {
      // 第一次 findFirst（name 查重）返回 null；第二次 findFirst（code 查重，assertCodeAvailable）返回已存在
      prisma.role.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(makeRole({ code: 'developer' }));
      await expect(
        service.createTeamRole('admin-1', { name: '新角色', code: 'developer' })
      ).rejects.toMatchObject({ status: 409 });
    });

    it('团队角色名重复拒绝 409', async () => {
      prisma.role.findFirst.mockResolvedValue(makeRole()); // 已存在
      await expect(service.createTeamRole('admin-1', { name: '自定义角色' })).rejects.toMatchObject(
        { status: 409 }
      );
    });

    it('权限码不属于团队级拒绝 400', async () => {
      await expect(
        service.createTeamRole('admin-1', { name: 'R', permissions: ['platform.user.list'] })
      ).rejects.toMatchObject({ status: 400 });
    });

    it('未知权限码拒绝 400', async () => {
      await expect(
        service.createTeamRole('admin-1', { name: 'R', permissions: ['team.unknown.code'] })
      ).rejects.toMatchObject({ status: 400 });
    });

    it('无 team.role.create 权限拒绝 403', async () => {
      auth.ensurePermission.mockRejectedValue(forbidden());
      await expect(service.createTeamRole('admin-1', { name: 'R' })).rejects.toMatchObject({
        status: 403,
      });
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
        'team.member.role.assign'
      );
    });

    it('无任一 list 守卫权限拒绝 403', async () => {
      auth.ensureAnyPermission.mockRejectedValue(forbidden());
      await expect(service.listTeamRoles('admin-1')).rejects.toMatchObject({ status: 403 });
    });
  });

  describe('updateTeamRole', () => {
    it('系统角色改权限拒绝 403', async () => {
      prisma.role.findUnique.mockResolvedValue(
        makeRole({ isSystem: true, id: 'team-admin-team-1' })
      );
      await expect(
        service.updateTeamRole('admin-1', 'team-admin-team-1', {
          permissions: ['team.dashboard.view'],
        })
      ).rejects.toMatchObject({ status: 403 });
    });

    it('跨团队角色拒绝 404', async () => {
      prisma.role.findUnique.mockResolvedValue(makeRole({ teamId: 'other-team' }));
      await expect(
        service.updateTeamRole('admin-1', 'role-1', { name: 'X' })
      ).rejects.toMatchObject({ status: 404 });
    });

    it('角色不存在拒绝 404', async () => {
      prisma.role.findUnique.mockResolvedValue(null);
      await expect(service.updateTeamRole('admin-1', 'nope', { name: 'X' })).rejects.toMatchObject({
        status: 404,
      });
    });
  });

  describe('deleteTeamRole', () => {
    it('系统角色不可删 403', async () => {
      prisma.role.findUnique.mockResolvedValue(makeRole({ isSystem: true }));
      await expect(service.deleteTeamRole('admin-1', 'role-1')).rejects.toMatchObject({
        status: 403,
      });
    });

    it('有成员引用时拒绝 409', async () => {
      prisma.role.findUnique.mockResolvedValue(makeRole({ isSystem: false }));
      prisma.teamMembership.count.mockResolvedValue(3);
      await expect(service.deleteTeamRole('admin-1', 'role-1')).rejects.toMatchObject({
        status: 409,
      });
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
      await expect(service.assignMemberRole('admin-1', 'u2', 'role-1')).rejects.toMatchObject({
        status: 400,
      });
    });

    it('目标用户不是本团队成员拒绝 404', async () => {
      prisma.role.findUnique.mockResolvedValue(makeRole());
      prisma.teamMembership.findUnique.mockResolvedValue(null);
      await expect(service.assignMemberRole('admin-1', 'u2', 'role-1')).rejects.toMatchObject({
        status: 404,
      });
    });

    it('系统团队管理员角色双写 teamRole=TEAM_ADMIN', async () => {
      // 基于 code 检测（不依赖 name 字符串）
      prisma.role.findUnique.mockResolvedValue(
        makeRole({
          id: 'team-admin-team-1',
          name: '系统团队管理员',
          code: 'team_admin',
          isSystem: true,
        })
      );
      prisma.teamMembership.findUnique.mockResolvedValue({
        teamId: 'team-1',
        userId: 'u2',
        status: 'ACTIVE',
      });
      prisma.teamMembership.update.mockResolvedValue({});
      await service.assignMemberRole('admin-1', 'u2', 'team-admin-team-1');
      expect(prisma.teamMembership.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ role: 'TEAM_ADMIN', teamRoleId: 'team-admin-team-1' }),
        })
      );
    });

    it('H-4 门禁：非团队管理员分配系统团队管理员角色 → 403', async () => {
      prisma.role.findUnique.mockResolvedValue(
        makeRole({
          id: 'team-admin-team-1',
          name: '系统团队管理员',
          code: 'team_admin',
          isSystem: true,
        })
      );
      prisma.teamMembership.findFirst.mockResolvedValueOnce({
        teamId: 'team-1',
        userId: 'member-1',
        teamRoleId: 'team-member-team-1',
        role: 'MEMBER',
        team: { status: 'ACTIVE' },
      });
      prisma.teamMembership.findUnique.mockResolvedValue({
        teamId: 'team-1',
        userId: 'u2',
        status: 'ACTIVE',
      });
      await expect(
        service.assignMemberRole('member-1', 'u2', 'team-admin-team-1')
      ).rejects.toMatchObject({ status: 403 });
    });

    it('H-4 门禁：分配权限高于自身权限的自定义角色 → 403（缺少权限清单）', async () => {
      prisma.role.findUnique.mockResolvedValue(
        makeRole({ id: 'role-strong', permissions: ['team.member.role.assign'] })
      );
      prisma.teamMembership.findFirst.mockResolvedValueOnce({
        teamId: 'team-1',
        userId: 'member-1',
        teamRoleId: 'team-member-team-1',
        role: 'MEMBER',
        team: { status: 'ACTIVE' },
      });
      prisma.teamMembership.findUnique.mockResolvedValue({
        teamId: 'team-1',
        userId: 'u2',
        status: 'ACTIVE',
      });
      // 分配者权限为 team.dashboard.view（mockImplementation：两次 ensurePermission 都受限）
      auth.ensurePermission.mockImplementation(async () => ({
        perms: new Set(['team.dashboard.view']),
      }));
      await expect(
        service.assignMemberRole('member-1', 'u2', 'role-strong')
      ).rejects.toMatchObject({ status: 403 });
    });
  });

  describe('平台角色', () => {
    it('assignPlatformRole 系统平台管理员角色双写 platformRole=PLATFORM_ADMIN + 吊销 tokenVersion', async () => {
      // H-4：actor（admin-1）须是平台管理员本人才能分配系统平台管理员角色
      prisma.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
        where.id === 'admin-1'
          ? {
              id: 'admin-1',
              platformRole: 'PLATFORM_ADMIN',
              platformRoleId: PLATFORM_ADMIN_ROLE_ID,
            }
          : { id: 'u2' }
      );
      prisma.role.findUnique.mockResolvedValue({
        id: PLATFORM_ADMIN_ROLE_ID,
        scope: 'PLATFORM',
        isSystem: true,
        permissions: [],
      });
      prisma.user.update.mockResolvedValue({});
      await service.assignPlatformRole('admin-1', 'u2', PLATFORM_ADMIN_ROLE_ID);
      // 第二次 update 写 platformRole + tokenVersion increment
      expect(prisma.user.update).toHaveBeenCalledTimes(2);
      expect(prisma.user.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            platformRole: 'PLATFORM_ADMIN',
            tokenVersion: { increment: 1 },
          }),
        })
      );
    });

    it('assignPlatformRole roleId=null 撤销平台角色，platformRole=NONE', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u2' });
      prisma.user.update.mockResolvedValue({});
      await service.assignPlatformRole('admin-1', 'u2', null);
      expect(prisma.user.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ platformRole: 'NONE', tokenVersion: { increment: 1 } }),
        })
      );
    });

    it('createPlatformRole 平台角色名重复拒绝 409', async () => {
      prisma.role.findFirst.mockResolvedValue(makeRole({ scope: 'PLATFORM' }));
      await expect(
        service.createPlatformRole('admin-1', { name: '已有角色' })
      ).rejects.toMatchObject({ status: 409 });
    });

    it('createPlatformRole 平台角色用了团队权限码拒绝 400', async () => {
      await expect(
        service.createPlatformRole('admin-1', { name: 'R', permissions: ['team.dashboard.view'] })
      ).rejects.toMatchObject({ status: 400 });
    });
  });

  // 平台管理员代管团队角色（listTeamRolesForTeam / createTeamRoleForTeam / updateTeamRoleForTeam /
  // deleteTeamRoleForTeam / assignMemberRoleForTeam）：直接用 teamId 参数，绕过 resolveCurrentTeam。
  // 与团队级版本（listTeamRoles/...）共享 validatePermissions / normalizeRoleCode / assertCodeAvailable / 系统角色锁定。
  describe('代管团队角色（platform.team.role.manage）', () => {
    beforeEach(() => {
      // assertTeamManaged：团队存在 + ACTIVE
      prisma.team.findUnique.mockResolvedValue({ id: 'team-2', status: 'ACTIVE' });
    });

    it('listTeamRolesForTeam 校验 platform.team.role.manage 权限', async () => {
      prisma.role.findMany.mockResolvedValue([]);
      await service.listTeamRolesForTeam('admin-1', 'team-2');
      expect(auth.ensurePermission).toHaveBeenCalledWith('admin-1', 'platform.team.role.manage');
      // 直接用传入 teamId（不走 resolveCurrentTeam → teamMembership.findFirst）
      expect(prisma.role.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ scope: 'TEAM', teamId: 'team-2' }),
        })
      );
    });

    it('listTeamRolesForTeam 返回摘要而非 permissions', async () => {
      prisma.role.findMany.mockResolvedValueOnce([
        {
          ...makeRole({ teamId: 'team-2', permissions: ['team.dashboard.view'] }),
          _count: { memberships: 4 },
        },
      ]);
      prisma.role.count.mockResolvedValueOnce(1);

      const result = await service.listTeamRolesForTeam('admin-1', 'team-2', {
        page: 1,
        pageSize: 10,
      });

      expect(result.items[0]).toMatchObject({ permissionCount: 1, memberCount: 4 });
      expect(result.items[0]).not.toHaveProperty('permissions');
    });

    it('listTeamRolesForTeam 团队不存在拒绝 404', async () => {
      prisma.team.findUnique.mockResolvedValue(null);
      await expect(service.listTeamRolesForTeam('admin-1', 'nope')).rejects.toMatchObject({
        status: 404,
      });
    });

    it('listTeamRolesForTeam 团队已停用仍允许只读审查', async () => {
      prisma.team.findUnique.mockResolvedValue({ id: 'team-2', status: 'SUSPENDED' });
      prisma.role.findMany.mockResolvedValue([]);
      await expect(service.listTeamRolesForTeam('admin-1', 'team-2')).resolves.toEqual({
        items: [],
        total: 0,
        page: 1,
        pageSize: 20,
      });
    });

    it('createTeamRoleForTeam 正常创建（写入 teamId 参数）', async () => {
      prisma.role.findFirst.mockResolvedValue(null);
      prisma.role.create.mockResolvedValue(makeRole({ teamId: 'team-2' }));
      const result = await service.createTeamRoleForTeam('admin-1', 'team-2', {
        name: '开发者',
        permissions: ['team.dashboard.view'],
      });
      expect(result.role.name).toBe('自定义角色');
      expect(prisma.role.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ scope: 'TEAM', teamId: 'team-2', name: '开发者' }),
        })
      );
      expect(prisma.auditLog.create).toHaveBeenCalled();
    });

    it('createTeamRoleForTeam 权限码不属于团队级拒绝 400', async () => {
      await expect(
        service.createTeamRoleForTeam('admin-1', 'team-2', {
          name: 'R',
          permissions: ['platform.user.list'],
        })
      ).rejects.toMatchObject({ status: 400 });
    });

    it('createTeamRoleForTeam 无 platform.team.role.manage 权限拒绝 403', async () => {
      auth.ensurePermission.mockRejectedValue(forbidden());
      await expect(
        service.createTeamRoleForTeam('admin-1', 'team-2', { name: 'R' })
      ).rejects.toMatchObject({ status: 403 });
    });

    it('updateTeamRoleForTeam 跨团队角色拒绝 404（teamId 不匹配）', async () => {
      prisma.role.findUnique.mockResolvedValue(makeRole({ teamId: 'other-team' }));
      await expect(
        service.updateTeamRoleForTeam('admin-1', 'team-2', 'role-1', { name: 'X' })
      ).rejects.toMatchObject({ status: 404 });
    });

    it('updateTeamRoleForTeam 系统角色改权限拒绝 403', async () => {
      prisma.role.findUnique.mockResolvedValue(makeRole({ isSystem: true, teamId: 'team-2' }));
      await expect(
        service.updateTeamRoleForTeam('admin-1', 'team-2', 'team-admin-team-2', {
          permissions: ['team.dashboard.view'],
        })
      ).rejects.toMatchObject({ status: 403 });
    });

    it('deleteTeamRoleForTeam 系统角色不可删 403', async () => {
      prisma.role.findUnique.mockResolvedValue(makeRole({ isSystem: true, teamId: 'team-2' }));
      await expect(
        service.deleteTeamRoleForTeam('admin-1', 'team-2', 'role-1')
      ).rejects.toMatchObject({ status: 403 });
    });

    it('deleteTeamRoleForTeam 有成员引用时拒绝 409', async () => {
      prisma.role.findUnique.mockResolvedValue(makeRole({ isSystem: false, teamId: 'team-2' }));
      prisma.teamMembership.count.mockResolvedValue(2);
      await expect(
        service.deleteTeamRoleForTeam('admin-1', 'team-2', 'role-1')
      ).rejects.toMatchObject({ status: 409 });
    });

    it('deleteTeamRoleForTeam 正常删除', async () => {
      prisma.role.findUnique.mockResolvedValue(makeRole({ isSystem: false, teamId: 'team-2' }));
      prisma.teamMembership.count.mockResolvedValue(0);
      prisma.role.delete.mockResolvedValue(makeRole());
      const result = await service.deleteTeamRoleForTeam('admin-1', 'team-2', 'role-1');
      expect(result.ok).toBe(true);
    });

    it('assignMemberRoleForTeam 系统团队管理员角色双写 role=TEAM_ADMIN', async () => {
      prisma.role.findUnique.mockResolvedValue(
        makeRole({
          id: 'team-admin-team-2',
          name: '系统团队管理员',
          code: 'team_admin',
          isSystem: true,
          teamId: 'team-2',
        })
      );
      prisma.teamMembership.findUnique.mockResolvedValue({
        teamId: 'team-2',
        userId: 'u2',
        status: 'ACTIVE',
        teamRoleId: null,
        role: 'MEMBER',
      });
      prisma.teamMembership.update.mockResolvedValue({});
      await service.assignMemberRoleForTeam('admin-1', 'team-2', 'u2', 'team-admin-team-2');
      expect(prisma.teamMembership.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ role: 'TEAM_ADMIN', teamRoleId: 'team-admin-team-2' }),
        })
      );
    });

    it('assignMemberRoleForTeam 目标角色不属于该团队拒绝 400', async () => {
      prisma.role.findUnique.mockResolvedValue(makeRole({ teamId: 'other-team' }));
      await expect(
        service.assignMemberRoleForTeam('admin-1', 'team-2', 'u2', 'role-1')
      ).rejects.toMatchObject({ status: 400 });
    });

    it('assignMemberRoleForTeam 目标用户不是该团队成员拒绝 404', async () => {
      prisma.role.findUnique.mockResolvedValue(makeRole({ teamId: 'team-2' }));
      prisma.teamMembership.findUnique.mockResolvedValue(null);
      await expect(
        service.assignMemberRoleForTeam('admin-1', 'team-2', 'u2', 'role-1')
      ).rejects.toMatchObject({ status: 404 });
    });
  });
});
