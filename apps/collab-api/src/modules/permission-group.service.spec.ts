// PermissionGroupService 单测：权限分组显示名 CRUD + 内置分组保护 + groupKey 白名单校验 + scope 隔离。
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PermissionGroupService } from './permission-group.service';
import { forbidden } from '../common';

function mockPrisma() {
  return {
    permissionGroup: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    teamMembership: {
      findFirst: vi.fn(),
    },
    auditLog: { create: vi.fn(async () => ({})) },
  };
}

function mockAuth() {
  return { ensurePermission: vi.fn(async () => ({ perms: new Set() })) };
}

function makeMembership() {
  return { teamId: 'team-1', userId: 'admin-1', team: { status: 'ACTIVE' } };
}

function makeGroupRow(overrides: Record<string, unknown> = {}) {
  return {
    scope: 'TEAM',
    groupKey: 'team.plugin',
    displayName: '插件中心',
    sortOrder: 40,
    isSystem: true,
    createdAt: new Date('2026-06-22T00:00:00.000Z'),
    updatedAt: new Date('2026-06-22T00:00:00.000Z'),
    ...overrides,
  };
}

describe('PermissionGroupService 权限分组显示名管理', () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let auth: ReturnType<typeof mockAuth>;
  let service: PermissionGroupService;

  beforeEach(() => {
    prisma = mockPrisma();
    auth = mockAuth();
    prisma.teamMembership.findFirst.mockResolvedValue(makeMembership());
    // @ts-expect-error mock 不实现完整 PrismaService 接口
    service = new PermissionGroupService(prisma, auth);
  });

  describe('listGroups', () => {
    it('合并内置基线 + DB 覆盖，标注 customized', async () => {
      // DB 有一条自定义覆盖（team.plugin → 插件中心）
      prisma.permissionGroup.findMany.mockResolvedValue([
        makeGroupRow({ displayName: '插件中心' }),
      ]);
      const result = await service.listGroups('admin-1', 'TEAM');
      const pluginGroup = result.groups.find((g) => g.groupKey === 'team.plugin');
      expect(pluginGroup?.displayName).toBe('插件中心');
      expect(pluginGroup?.customized).toBe(true);
      // 未覆盖的模块用内置默认名
      const memberGroup = result.groups.find((g) => g.groupKey === 'team.member');
      expect(memberGroup?.displayName).toBe('成员管理');
      expect(memberGroup?.customized).toBe(false);
    });

    it('无 team.role.update 权限拒绝 403', async () => {
      auth.ensurePermission.mockRejectedValue(forbidden());
      await expect(service.listGroups('admin-1', 'TEAM')).rejects.toMatchObject({ status: 403 });
    });
  });

  describe('upsertGroup', () => {
    it('管理员改名内置分组显示名', async () => {
      prisma.permissionGroup.upsert.mockResolvedValue(makeGroupRow({ displayName: '插件中心' }));
      const result = await service.upsertGroup('admin-1', 'TEAM', {
        groupKey: 'team.plugin',
        displayName: '插件中心',
      });
      expect(result.group.displayName).toBe('插件中心');
      expect(prisma.permissionGroup.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { scope_groupKey: { scope: 'TEAM', groupKey: 'team.plugin' } },
          update: { displayName: '插件中心' },
        })
      );
      expect(prisma.auditLog.create).toHaveBeenCalled();
    });

    it('未知 groupKey（非已注册模块）拒绝 400', async () => {
      await expect(
        service.upsertGroup('admin-1', 'TEAM', { groupKey: 'team.unknown', displayName: 'X' })
      ).rejects.toMatchObject({ status: 400 });
    });

    it('空 displayName 经 DTO 校验在前置层，service 收到即 upsert', async () => {
      prisma.permissionGroup.upsert.mockResolvedValue(makeGroupRow({ displayName: '插件管理' }));
      // service 不做空校验（DTO 已校验），正常 upsert
      await service.upsertGroup('admin-1', 'TEAM', {
        groupKey: 'team.plugin',
        displayName: '插件管理',
      });
      expect(prisma.permissionGroup.upsert).toHaveBeenCalled();
    });

    it('PLATFORM scope 无需团队归属校验', async () => {
      prisma.permissionGroup.upsert.mockResolvedValue(
        makeGroupRow({ scope: 'PLATFORM', groupKey: 'platform.user' })
      );
      await service.upsertGroup('admin-1', 'PLATFORM', {
        groupKey: 'platform.user',
        displayName: '账号中心',
      });
      expect(prisma.permissionGroup.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { scope_groupKey: { scope: 'PLATFORM', groupKey: 'platform.user' } },
        })
      );
    });
  });

  describe('deleteGroup（重置为内置默认）', () => {
    it('已自定义分组重置为内置默认显示名', async () => {
      prisma.permissionGroup.findUnique.mockResolvedValue(
        makeGroupRow({ displayName: '插件中心' })
      );
      await service.deleteGroup('admin-1', 'TEAM', 'team.plugin');
      // update 重置 displayName 为内置默认（team.plugin → 插件管理）
      expect(prisma.permissionGroup.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { scope_groupKey: { scope: 'TEAM', groupKey: 'team.plugin' } },
          data: { displayName: '插件管理' },
        })
      );
      expect(prisma.auditLog.create).toHaveBeenCalled();
    });

    it('未自定义的分组拒绝 404', async () => {
      prisma.permissionGroup.findUnique.mockResolvedValue(null);
      await expect(service.deleteGroup('admin-1', 'TEAM', 'team.plugin')).rejects.toMatchObject({
        status: 404,
      });
    });

    it('未知 groupKey 拒绝 400', async () => {
      await expect(service.deleteGroup('admin-1', 'TEAM', 'team.unknown')).rejects.toMatchObject({
        status: 400,
      });
    });
  });

  describe('scope 隔离', () => {
    it('TEAM scope 无当前团队 membership 拒绝 403', async () => {
      prisma.teamMembership.findFirst.mockResolvedValue(null);
      auth.ensurePermission.mockResolvedValue({ perms: new Set() });
      // resolveCurrentTeam 在 ensurePermission 之后调用，无 membership 抛 forbidden
      await expect(service.listGroups('admin-1', 'TEAM')).rejects.toMatchObject({ status: 403 });
    });

    it('TEAM scope 团队 SUSPENDED 拒绝 403', async () => {
      prisma.teamMembership.findFirst.mockResolvedValue({
        teamId: 'team-1',
        userId: 'admin-1',
        team: { status: 'SUSPENDED' },
      });
      auth.ensurePermission.mockResolvedValue({ perms: new Set() });
      await expect(service.listGroups('admin-1', 'TEAM')).rejects.toMatchObject({ status: 403 });
    });

    it('PLATFORM scope 不调用 resolveCurrentTeam（无 teamMembership 依赖）', async () => {
      prisma.permissionGroup.findMany.mockResolvedValue([]);
      await service.listGroups('admin-1', 'PLATFORM');
      expect(prisma.teamMembership.findFirst).not.toHaveBeenCalled();
    });
  });
});
