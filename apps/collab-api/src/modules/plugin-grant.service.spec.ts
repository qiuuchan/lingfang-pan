// PluginGrantService 单测：覆盖授权 CRUD + resolvePluginAccess（deny 优先、user 级优先于 role 级、团队管理员默认放行）。
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PluginGrantService } from './plugin-grant.service';
import { badRequest, forbidden, notFound } from '../common';

function mockPrisma() {
  return {
    plugin: { findUnique: vi.fn() },
    pluginGrant: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
    },
    role: { findUnique: vi.fn() },
    teamMembership: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
    auditLog: { create: vi.fn(async () => ({})) },
  };
}

function mockAuth() {
  return { ensurePermission: vi.fn(async () => ({ perms: new Set() })) };
}

function makeMembership(teamRoleId = 'team-admin-team-1') {
  return { teamId: 'team-1', userId: 'admin-1', teamRoleId, team: { status: 'ACTIVE' } };
}

function makeGrant(overrides: Record<string, unknown> = {}) {
  return {
    id: 'grant-1',
    teamId: 'team-1',
    pluginId: 'plugin-1',
    subjectKind: 'USER' as const,
    subjectId: 'u2',
    effect: 'DENY' as const,
    createdBy: 'admin-1',
    createdAt: new Date('2026-06-21T00:00:00.000Z'),
    ...overrides,
  };
}

describe('PluginGrantService 授权管理 + resolvePluginAccess', () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let auth: ReturnType<typeof mockAuth>;
  let service: PluginGrantService;

  beforeEach(() => {
    prisma = mockPrisma();
    auth = mockAuth();
    prisma.teamMembership.findFirst.mockResolvedValue(makeMembership());
    // @ts-expect-error mock 不实现完整 PrismaService 接口
    service = new PluginGrantService(prisma, auth);
  });

  describe('setGrant', () => {
    it('USER 主体：目标非团队成员拒绝 400', async () => {
      prisma.plugin.findUnique.mockResolvedValue({ id: 'plugin-1' });
      prisma.teamMembership.findUnique.mockResolvedValue(null);
      await expect(
        service.setGrant('admin-1', 'plugin-1', { subjectKind: 'USER', subjectId: 'u2', effect: 'DENY' }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('ROLE 主体：目标非本团队角色拒绝 400', async () => {
      prisma.plugin.findUnique.mockResolvedValue({ id: 'plugin-1' });
      prisma.role.findUnique.mockResolvedValue({ id: 'role-x', scope: 'TEAM', teamId: 'other-team' });
      await expect(
        service.setGrant('admin-1', 'plugin-1', { subjectKind: 'ROLE', subjectId: 'role-x', effect: 'ALLOW' }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('插件不存在拒绝 404', async () => {
      prisma.plugin.findUnique.mockResolvedValue(null);
      await expect(
        service.setGrant('admin-1', 'nope', { subjectKind: 'USER', subjectId: 'u2', effect: 'DENY' }),
      ).rejects.toMatchObject({ status: 404 });
    });

    it('正常 upsert USER DENY 授权', async () => {
      prisma.plugin.findUnique.mockResolvedValue({ id: 'plugin-1' });
      prisma.teamMembership.findUnique.mockResolvedValue({ teamId: 'team-1', userId: 'u2', status: 'ACTIVE' });
      prisma.pluginGrant.upsert.mockResolvedValue(makeGrant());
      const result = await service.setGrant('admin-1', 'plugin-1', { subjectKind: 'USER', subjectId: 'u2', effect: 'DENY' });
      expect(result.grant.effect).toBe('DENY');
      expect(prisma.auditLog.create).toHaveBeenCalled();
    });
  });

  describe('removeGrant', () => {
    it('授权记录不存在拒绝 404', async () => {
      prisma.pluginGrant.findUnique.mockResolvedValue(null);
      await expect(
        service.removeGrant('admin-1', 'plugin-1', 'USER', 'u2'),
      ).rejects.toMatchObject({ status: 404 });
    });

    it('正常删除', async () => {
      prisma.pluginGrant.findUnique.mockResolvedValue(makeGrant());
      prisma.pluginGrant.delete.mockResolvedValue(makeGrant());
      const result = await service.removeGrant('admin-1', 'plugin-1', 'USER', 'u2');
      expect(result.ok).toBe(true);
    });
  });

  describe('resolvePluginAccess', () => {
    it('团队管理员（系统团队管理员角色）默认放行，不查 grant', async () => {
      // 基于 code 检测（不依赖 name 字符串）
      prisma.role.findUnique.mockResolvedValue({ isSystem: true, code: 'team_admin' });
      const ok = await service.resolvePluginAccess('team-1', 'plugin-1', 'admin-1', 'team-admin-team-1');
      expect(ok).toBe(true);
      expect(prisma.pluginGrant.findMany).not.toHaveBeenCalled();
    });

    it('user 级 DENY 优先，拒绝', async () => {
      prisma.role.findUnique.mockResolvedValue({ isSystem: false, code: null });
      prisma.pluginGrant.findMany.mockResolvedValue([
        { subjectKind: 'USER', effect: 'DENY' },
        { subjectKind: 'ROLE', effect: 'ALLOW' },
      ]);
      const ok = await service.resolvePluginAccess('team-1', 'plugin-1', 'u2', 'role-custom');
      expect(ok).toBe(false);
    });

    it('user 级 ALLOW 优先于 role 级 DENY，放行', async () => {
      prisma.role.findUnique.mockResolvedValue({ isSystem: false, code: null });
      prisma.pluginGrant.findMany.mockResolvedValue([
        { subjectKind: 'USER', effect: 'ALLOW' },
        { subjectKind: 'ROLE', effect: 'DENY' },
      ]);
      const ok = await service.resolvePluginAccess('team-1', 'plugin-1', 'u2', 'role-custom');
      expect(ok).toBe(true);
    });

    it('无任何 grant 默认放行', async () => {
      prisma.role.findUnique.mockResolvedValue({ isSystem: false, code: null });
      prisma.pluginGrant.findMany.mockResolvedValue([]);
      const ok = await service.resolvePluginAccess('team-1', 'plugin-1', 'u2', 'role-custom');
      expect(ok).toBe(true);
    });

    it('role 级 DENY（无 user 级 grant）拒绝', async () => {
      prisma.role.findUnique.mockResolvedValue({ isSystem: false, code: null });
      prisma.pluginGrant.findMany.mockResolvedValue([{ subjectKind: 'ROLE', effect: 'DENY' }]);
      const ok = await service.resolvePluginAccess('team-1', 'plugin-1', 'u2', 'role-custom');
      expect(ok).toBe(false);
    });
  });
});
