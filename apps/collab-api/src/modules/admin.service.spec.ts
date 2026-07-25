// AdminService 单测：覆盖调研报告 Top10 新增的 AI 生成质量看板与财务概览看板。
//  - generation_member_blocked：非平台管理员被 ensurePlatformAdmin 拒绝（403）。
//  - generation_success_rate：调用/成功/失败/成功率按 audit 计数聚合，calls=0 时 successRate 兜底为 0（非 NaN）。
//  - finance_member_blocked：非平台管理员被拒绝。
//  - finance_gmv_and_conversion：GMV = sum(priceCents)（null 兜底 0），付费转化率 = distinct buyer / 总用户。
//  - finance_top_plugins：按 installCount 降序取前 5，平均分 ratingCount>0 才计算。
//  - finance_empty_no_nan：无交易时 GMV/转化率均为 0，topPlugins 为空数组（非 NaN）。
// 参考 release.service.spec.ts：Mock PrismaService + AuthService，不连真实 DB。
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AdminService } from './admin.service';
import { forbidden } from '../common';
import { auditActionCategory, auditActionLabel } from './audit-actions';

function mockPrisma() {
  const auditLog = { count: vi.fn(async () => 0) };
  const llmCallLog = {
    count: vi.fn(async () => 0),
    aggregate: vi.fn(async () => ({ _avg: { durationMs: null } })),
  };
  const purchase = {
    aggregate: vi.fn(async () => ({ _sum: { priceCents: null } })),
    findMany: vi.fn(async () => []),
  };
  const pluginRelease = { count: vi.fn(async () => 0) };
  const pluginPackage = { count: vi.fn(async () => 0) };
  const marketplaceListing = { count: vi.fn(async () => 0), findMany: vi.fn(async () => []) };
  const user = { count: vi.fn(async () => 0) };
  const team = { count: vi.fn(async () => 0) };
  const teamAdminApplication = { count: vi.fn(async () => 0) };
  return {
    auditLog,
    llmCallLog,
    purchase,
    pluginRelease,
    pluginPackage,
    marketplaceListing,
    user,
    team,
    teamAdminApplication,
  };
}

function mockAuth() {
  return {
    ensurePlatformAdmin: vi.fn(),
    ensureCurrentTeam: vi.fn(),
    ensureTeamAdmin: vi.fn(),
  };
}

// NotificationService mock：审核/购买埋点测试需要断言 create 调用，create 返回 Promise 不抛错。
function mockNotifications() {
  return { create: vi.fn(async () => ({})) };
}

describe('AdminService stats', () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let auth: ReturnType<typeof mockAuth>;
  let notifications: ReturnType<typeof mockNotifications>;
  let service: AdminService;

  beforeEach(() => {
    prisma = mockPrisma();
    auth = mockAuth();
    notifications = mockNotifications();
    // @ts-expect-error mock 不实现完整 PrismaService 接口，仅测用到的方法。
    service = new AdminService(prisma, auth, notifications);
  });

  describe('adminDashboard', () => {
    it('插件指标全部来自 v4 registry 状态', async () => {
      prisma.user.count.mockResolvedValueOnce(12);
      prisma.team.count.mockResolvedValueOnce(4);
      prisma.teamAdminApplication.count.mockResolvedValueOnce(2);
      prisma.pluginRelease.count.mockResolvedValueOnce(5);
      prisma.pluginPackage.count.mockResolvedValueOnce(8);
      prisma.marketplaceListing.count.mockResolvedValueOnce(6).mockResolvedValueOnce(3);

      const result = await service.adminDashboard('user-admin');

      expect(result).toEqual({
        users: 12,
        teams: 4,
        pendingApplications: 2,
        pendingPluginReviews: 5,
        activePluginPackages: 8,
        activeMarketplaceListings: 6,
        delistedMarketplaceListings: 3,
      });
      expect(prisma.pluginRelease.count).toHaveBeenCalledWith({
        where: { marketReviewStatus: 'PENDING' },
      });
      expect(prisma.pluginPackage.count).toHaveBeenCalledWith({
        where: { governanceStatus: 'ACTIVE' },
      });
      expect(prisma.marketplaceListing.count).toHaveBeenNthCalledWith(1, { where: { status: 'ACTIVE' } });
      expect(prisma.marketplaceListing.count).toHaveBeenNthCalledWith(2, { where: { status: 'DELISTED' } });
    });
  });

  describe('adminGenerationStats', () => {
    it('非平台管理员被 ensurePlatformAdmin 拒绝（403）', async () => {
      auth.ensurePlatformAdmin.mockImplementation(() => {
        throw forbidden('仅平台管理员可操作');
      });
      await expect(service.adminGenerationStats('user-member')).rejects.toMatchObject({ status: 403, code: 'forbidden' });
      expect(prisma.llmCallLog.count).not.toHaveBeenCalled();
    });

    it('按 LlmCallLog 计数聚合调用/成功/失败/成功率 + 平均耗时', async () => {
      // count 调用顺序：monthCalls, monthSuccess, monthFailed, totalCalls, totalSuccess, totalFailed。
      prisma.llmCallLog.count
        .mockResolvedValueOnce(100)  // 月总调用
        .mockResolvedValueOnce(80)   // 月成功
        .mockResolvedValueOnce(15)   // 月失败
        .mockResolvedValueOnce(1000) // 累计总调用
        .mockResolvedValueOnce(750)  // 累计成功
        .mockResolvedValueOnce(200); // 累计失败
      // aggregate 调用顺序：monthDuration, totalDuration。
      prisma.llmCallLog.aggregate
        .mockResolvedValueOnce({ _avg: { durationMs: 1234.5 } })
        .mockResolvedValueOnce({ _avg: { durationMs: 1500 } });
      const result = await service.adminGenerationStats('user-admin');
      expect(result.month).toEqual({ calls: 100, success: 80, failed: 15, successRate: 80 });
      expect(result.total).toEqual({ calls: 1000, success: 750, failed: 200, successRate: 75 });
      // 平均耗时来自 LlmCallLog.durationMs 的 avg（仅 success 行）。
      expect(result.avgDurationMs).toBe(1234.5);
    });

    it('调用次数为 0 时 successRate 兜底为 0（非 NaN），平均耗时为 null', async () => {
      prisma.llmCallLog.count.mockResolvedValue(0);
      prisma.llmCallLog.aggregate.mockResolvedValue({ _avg: { durationMs: null } });
      const result = await service.adminGenerationStats('user-admin');
      expect(result.month.successRate).toBe(0);
      expect(result.total.successRate).toBe(0);
      expect(result.month.failed).toBe(0);
      expect(result.avgDurationMs).toBeNull();
    });
  });

  describe('adminFinanceStats', () => {
    it('非平台管理员被 ensurePlatformAdmin 拒绝（403）', async () => {
      auth.ensurePlatformAdmin.mockImplementation(() => {
        throw forbidden('仅平台管理员可操作');
      });
      await expect(service.adminFinanceStats('user-member')).rejects.toMatchObject({ status: 403, code: 'forbidden' });
      expect(prisma.purchase.aggregate).not.toHaveBeenCalled();
    });

    it('GMV = sum(priceCents)，付费转化率 = distinct buyer / 总用户', async () => {
      // 两次 aggregate 顺序：monthGmv, totalGmv。
      prisma.purchase.aggregate
        .mockResolvedValueOnce({ _sum: { priceCents: 5000 } }) // 月 GMV ¥50
        .mockResolvedValueOnce({ _sum: { priceCents: 20000 } }); // 累计 GMV ¥200
      // 付费买家去重列表（2 个）。
      prisma.purchase.findMany.mockResolvedValue([{ buyerUserId: 'u1' }, { buyerUserId: 'u2' }]);
      prisma.user.count.mockResolvedValue(10);
      prisma.marketplaceListing.findMany.mockResolvedValue([]);

      const result = await service.adminFinanceStats('user-admin');

      expect(result.month.gmvCents).toBe(5000);
      expect(result.total.gmvCents).toBe(20000);
      expect(result.paidUserCount).toBe(2);
      expect(result.totalUserCount).toBe(10);
      // 转化率 = 2/10 = 20%。
      expect(result.conversionRate).toBe(20);
      // 平台抽成暂为 0（ADR-0002 放弃抽成）。
      expect(result.platformRevenueCents).toBe(0);
      expect(result.topPlugins).toEqual([]);
    });

    it('Top5 热销插件按 installCount 降序，平均分 ratingCount>0 才计算', async () => {
      prisma.purchase.aggregate.mockResolvedValue({ _sum: { priceCents: 1000 } });
      prisma.purchase.findMany.mockResolvedValue([{ buyerUserId: 'u1' }]);
      prisma.user.count.mockResolvedValue(5);
      prisma.marketplaceListing.findMany.mockResolvedValue([
        { packageId: 'p1', package: { name: '插件A' }, installCount: 42, ratingCount: 10, ratingSum: 45, priceCents: 0 },
        { packageId: 'p2', package: { name: '插件B' }, installCount: 7, ratingCount: 0, ratingSum: 0, priceCents: 1000 },
      ]);

      const result = await service.adminFinanceStats('user-admin');

      expect(result.topPlugins).toEqual([
        { id: 'p1', name: '插件A', installCount: 42, ratingCount: 10, avgScore: 4.5, priceCents: 0 },
        // ratingCount=0 时平均分兜底为 0，避免除零 NaN。
        { id: 'p2', name: '插件B', installCount: 7, ratingCount: 0, avgScore: 0, priceCents: 1000 },
      ]);
    });

    it('无交易时 GMV/转化率为 0，topPlugins 为空数组（非 NaN）', async () => {
      // aggregate 对空表返回 null，service 用 ?? 0 兜底。
      prisma.purchase.aggregate.mockResolvedValue({ _sum: { priceCents: null } });
      prisma.purchase.findMany.mockResolvedValue([]);
      prisma.user.count.mockResolvedValue(0);
      prisma.marketplaceListing.findMany.mockResolvedValue([]);

      const result = await service.adminFinanceStats('user-admin');

      expect(result.month.gmvCents).toBe(0);
      expect(result.total.gmvCents).toBe(0);
      expect(result.paidUserCount).toBe(0);
      expect(result.totalUserCount).toBe(0);
      // 总用户为 0 时转化率兜底为 0（非 NaN）。
      expect(result.conversionRate).toBe(0);
      expect(result.topPlugins).toEqual([]);
    });
  });
});

describe('v4 plugin registry audit labels', () => {
  it.each([
    ['admin.plugin_release.approved', '审核通过插件发行版'],
    ['admin.plugin_release.rejected', '驳回插件发行版'],
    ['admin.plugin_release.artifact_downloaded', '下载插件发行版制品'],
    ['admin.plugin_package.delisted', '平台暂停市场插件包'],
    ['admin.plugin_package.relisted', '平台恢复市场插件包'],
  ])('%s 使用中文标签并归入平台管理', (action, label) => {
    expect(auditActionLabel(action)).toBe(label);
    expect(auditActionCategory(action)).toBe('admin');
  });
});

function mockAuthForReview() {
  return {
    ensurePlatformAdmin: vi.fn(),
    ensureCurrentTeam: vi.fn(),
    ensureTeamAdmin: vi.fn(),
  };
}

// === 组B 团队管理完善：成员列表 / 角色切换 / 状态启停 / 详情聚合 ===
// 覆盖 4 个新方法，关键断言：
//  - 非平台管理员被 ensurePlatformAdmin 拒绝（403）。
//  - adminUpdateMemberRole / adminUpdateTeamStatus 的幂等优化（无变更不写审计）。
//  - action 前缀分类（team.member.role_changed / team.status.suspended / team.status.activated）。
//  - adminTeamDetail 聚合成员数 + 插件数 + 购买 + 流水摘要（空表兜底非 NaN）。
function mockPrismaForTeam() {
  const team = { findUnique: vi.fn(), update: vi.fn() };
  const user = { findUnique: vi.fn(), update: vi.fn() };
  const teamMembership = { findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn(async () => 0), update: vi.fn(), upsert: vi.fn() };
  const role = { findUnique: vi.fn(), count: vi.fn(async () => 0), upsert: vi.fn(async ({ create }) => create) };
  const pluginPackage = { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) };
  const purchase = { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) };
  const balanceLedger = { groupBy: vi.fn(async () => []), findMany: vi.fn(async () => []), count: vi.fn(async () => 0) };
  const auditLog = { create: vi.fn() };
  const tx = { team, user, teamMembership, role, pluginPackage, purchase, balanceLedger, auditLog };
  const $transaction = vi.fn(async (cb: (client: typeof tx) => Promise<unknown>) => cb(tx));
  return { ...tx, $transaction };
}

describe('AdminService 团队管理完善（组B）', () => {
  let prisma: ReturnType<typeof mockPrismaForTeam>;
  let auth: ReturnType<typeof mockAuthForReview>;
  let notifications: ReturnType<typeof mockNotifications>;
  let service: AdminService;

  beforeEach(() => {
    prisma = mockPrismaForTeam();
    auth = mockAuthForReview();
    notifications = mockNotifications();
    // @ts-expect-error mock 不实现完整 PrismaService 接口。
    service = new AdminService(prisma, auth, notifications);
  });

  describe('adminTeamMembers', () => {
    it('非平台管理员被拒绝（403）', async () => {
      auth.ensurePlatformAdmin.mockImplementation(() => {
        throw forbidden('仅平台管理员可操作');
      });
      await expect(service.adminTeamMembers('user-member', 't1')).rejects.toMatchObject({ status: 403, code: 'forbidden' });
      expect(prisma.team.findUnique).not.toHaveBeenCalled();
    });

    it('团队不存在时抛 not_found', async () => {
      prisma.team.findUnique.mockResolvedValueOnce(null);
      await expect(service.adminTeamMembers('user-admin', 'missing')).rejects.toMatchObject({ status: 404, code: 'not_found' });
    });

    it('返回成员列表（含 role/status/joinedAt + 脱敏 user）', async () => {
      const now = new Date('2026-06-15T00:00:00.000Z');
      prisma.team.findUnique.mockResolvedValueOnce({ id: 't1' });
      prisma.teamMembership.findMany.mockResolvedValueOnce([
        { teamId: 't1', userId: 'u1', role: 'TEAM_ADMIN', status: 'ACTIVE', teamRoleId: null, joinedAt: now, teamRole: null, user: { id: 'u1', email: 'a@x.com', displayName: 'A', status: 'ACTIVE', platformRole: 'NONE', passwordHash: 'secret', tokenVersion: 1 } },
        { teamId: 't1', userId: 'u2', role: 'MEMBER', status: 'ACTIVE', teamRoleId: null, joinedAt: now, teamRole: null, user: { id: 'u2', email: 'b@x.com', displayName: 'B', status: 'ACTIVE', platformRole: 'NONE', passwordHash: 'secret', tokenVersion: 1 } },
      ]);
      const result = await service.adminTeamMembers('user-admin', 't1');
      expect(result.items).toHaveLength(2);
      // publicUser 脱敏：不得携带 passwordHash / tokenVersion。
      expect(result.items[0].user).toEqual({ id: 'u1', email: 'a@x.com', displayName: 'A', status: 'ACTIVE', platformRole: 'NONE' });
      expect(result.items[0]).not.toHaveProperty('user.passwordHash');
      expect(result).toMatchObject({ total: 0, page: 1, pageSize: 20 });
    });
  });

  describe('团队管理员 RBAC 双写', () => {
    it('adminSetTeamAdmin 写系统 team_admin roleId 并吊销旧 token', async () => {
      prisma.team.findUnique.mockResolvedValueOnce({ id: 't1', status: 'ACTIVE' });
      prisma.user.findUnique.mockResolvedValueOnce({ id: 'u1', status: 'ACTIVE' });
      prisma.teamMembership.upsert.mockResolvedValueOnce({
        teamId: 't1', userId: 'u1', role: 'TEAM_ADMIN', teamRoleId: 'team-admin-t1', status: 'ACTIVE',
      });

      await service.adminSetTeamAdmin('user-admin', 't1', { userId: 'u1' });

      expect(prisma.role.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'team-admin-t1' } }));
      expect(prisma.teamMembership.upsert).toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({ role: 'TEAM_ADMIN', teamRoleId: 'team-admin-t1' }),
        update: expect.objectContaining({ role: 'TEAM_ADMIN', teamRoleId: 'team-admin-t1' }),
      }));
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: {
          tokenVersion: { increment: 1 },
          teamContextVersion: { increment: 1 },
        },
      });
    });

    it('adminRevokeTeamAdmin 写系统 team_member roleId 并吊销旧 token', async () => {
      prisma.teamMembership.findUnique.mockResolvedValueOnce({
        teamId: 't1', userId: 'u1', role: 'TEAM_ADMIN', teamRoleId: 'team-admin-t1', status: 'ACTIVE',
      });
      prisma.teamMembership.update.mockResolvedValueOnce({
        teamId: 't1', userId: 'u1', role: 'MEMBER', teamRoleId: 'team-member-t1', status: 'ACTIVE',
      });

      await service.adminRevokeTeamAdmin('user-admin', 't1', 'u1');

      expect(prisma.role.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'team-member-t1' } }));
      expect(prisma.teamMembership.update).toHaveBeenCalledWith(expect.objectContaining({
        data: { role: 'MEMBER', teamRoleId: 'team-member-t1' },
      }));
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { tokenVersion: { increment: 1 } },
      });
    });
  });

  describe('adminUpdateMemberRole', () => {
    it('成员关系不存在时抛 not_found', async () => {
      prisma.teamMembership.findUnique.mockResolvedValueOnce(null);
      await expect(service.adminUpdateMemberRole('user-admin', 't1', 'u1', { role: 'TEAM_ADMIN' })).rejects.toMatchObject({ status: 404, code: 'not_found' });
    });

    it('角色未变化时幂等返回（不写审计、不调用 update）', async () => {
      prisma.teamMembership.findUnique.mockResolvedValueOnce({ teamId: 't1', userId: 'u1', role: 'TEAM_ADMIN', teamRoleId: 'team-admin-t1', status: 'ACTIVE' });
      const result = await service.adminUpdateMemberRole('user-admin', 't1', 'u1', { role: 'TEAM_ADMIN' });
      expect(result.membership.role).toBe('TEAM_ADMIN');
      expect(prisma.teamMembership.update).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('切换角色时写审计 action=team.member.role_changed（含 from/to）', async () => {
      prisma.teamMembership.findUnique.mockResolvedValueOnce({ teamId: 't1', userId: 'u1', role: 'MEMBER', status: 'ACTIVE' });
      prisma.teamMembership.update.mockResolvedValueOnce({ teamId: 't1', userId: 'u1', role: 'TEAM_ADMIN', teamRoleId: 'team-admin-t1', status: 'ACTIVE' });
      await service.adminUpdateMemberRole('user-admin', 't1', 'u1', { role: 'TEAM_ADMIN' });
      expect(prisma.teamMembership.update).toHaveBeenCalledWith(expect.objectContaining({
        data: { role: 'TEAM_ADMIN', teamRoleId: 'team-admin-t1' },
      }));
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { tokenVersion: { increment: 1 } },
      });
      expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          action: 'team.member.role_changed',
          targetType: 'User',
          targetId: 'u1',
          metadata: expect.objectContaining({ teamId: 't1', from: 'MEMBER', to: 'TEAM_ADMIN', toRoleId: 'team-admin-t1' }),
        }),
      }));
    });

    // child-4 D7：roleId 分支（指定任意团队自定义角色）
    it('传 roleId 时解析角色并双写 teamRoleId + role 枚举（系统团队管理员→TEAM_ADMIN）', async () => {
      prisma.teamMembership.findUnique.mockResolvedValueOnce({ teamId: 't1', userId: 'u1', role: 'MEMBER', status: 'ACTIVE', teamRoleId: null });
      prisma.role.findUnique.mockResolvedValueOnce({ id: 'team-admin-t1', scope: 'TEAM', teamId: 't1', isSystem: true, code: 'team_admin' });
      prisma.teamMembership.update.mockResolvedValueOnce({ teamId: 't1', userId: 'u1', role: 'TEAM_ADMIN', status: 'ACTIVE', teamRoleId: 'team-admin-t1' });
      await service.adminUpdateMemberRole('user-admin', 't1', 'u1', { roleId: 'team-admin-t1' });
      expect(prisma.teamMembership.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ teamRoleId: 'team-admin-t1', role: 'TEAM_ADMIN' }),
      }));
      expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'u1' },
        data: { tokenVersion: { increment: 1 } },
      }));
    });

    it('传 roleId 自定义角色双写 role=MEMBER（非系统团队管理员）', async () => {
      prisma.teamMembership.findUnique.mockResolvedValueOnce({ teamId: 't1', userId: 'u1', role: 'TEAM_ADMIN', status: 'ACTIVE', teamRoleId: 'team-admin-t1' });
      prisma.role.findUnique.mockResolvedValueOnce({ id: 'role-dev', scope: 'TEAM', teamId: 't1', isSystem: false, code: 'developer' });
      prisma.teamMembership.update.mockResolvedValueOnce({ teamId: 't1', userId: 'u1', role: 'MEMBER', status: 'ACTIVE', teamRoleId: 'role-dev' });
      await service.adminUpdateMemberRole('user-admin', 't1', 'u1', { roleId: 'role-dev' });
      expect(prisma.teamMembership.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ teamRoleId: 'role-dev', role: 'MEMBER' }),
      }));
      // 审计含 managed: true + fromRoleId/toRoleId
      expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ action: 'team.member.role_changed', metadata: expect.objectContaining({ teamId: 't1', managed: true, toRoleId: 'role-dev', to: 'MEMBER' }) }),
      }));
    });

    it('传 roleId 跨团队角色拒绝 400', async () => {
      prisma.teamMembership.findUnique.mockResolvedValueOnce({ teamId: 't1', userId: 'u1', role: 'MEMBER', status: 'ACTIVE', teamRoleId: null });
      prisma.role.findUnique.mockResolvedValueOnce({ id: 'role-x', scope: 'TEAM', teamId: 'other-team', isSystem: false, code: null });
      await expect(service.adminUpdateMemberRole('user-admin', 't1', 'u1', { roleId: 'role-x' })).rejects.toMatchObject({ status: 400, code: 'bad_request' });
    });

    it('传 roleId 角色不存在拒绝 400', async () => {
      prisma.teamMembership.findUnique.mockResolvedValueOnce({ teamId: 't1', userId: 'u1', role: 'MEMBER', status: 'ACTIVE', teamRoleId: null });
      prisma.role.findUnique.mockResolvedValueOnce(null);
      await expect(service.adminUpdateMemberRole('user-admin', 't1', 'u1', { roleId: 'nope' })).rejects.toMatchObject({ status: 400, code: 'bad_request' });
    });

    it('role 与 roleId 都未传拒绝 400', async () => {
      prisma.teamMembership.findUnique.mockResolvedValueOnce({ teamId: 't1', userId: 'u1', role: 'MEMBER', status: 'ACTIVE' });
      await expect(service.adminUpdateMemberRole('user-admin', 't1', 'u1', {})).rejects.toMatchObject({ status: 400, code: 'bad_request' });
    });

    it('传 roleId 但 role+teamRoleId 均未变时幂等返回（不写审计、不调用 update）', async () => {
      prisma.teamMembership.findUnique.mockResolvedValueOnce({ teamId: 't1', userId: 'u1', role: 'MEMBER', status: 'ACTIVE', teamRoleId: 'role-dev' });
      prisma.role.findUnique.mockResolvedValueOnce({ id: 'role-dev', scope: 'TEAM', teamId: 't1', isSystem: false, code: 'developer' });
      const result = await service.adminUpdateMemberRole('user-admin', 't1', 'u1', { roleId: 'role-dev' });
      expect(result.membership.teamRoleId).toBe('role-dev');
      expect(prisma.teamMembership.update).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });
  });

  describe('adminUpdateTeamStatus', () => {
    it('团队不存在时抛 not_found', async () => {
      prisma.team.findUnique.mockResolvedValueOnce(null);
      await expect(service.adminUpdateTeamStatus('user-admin', 'missing', { status: 'SUSPENDED' })).rejects.toMatchObject({ status: 404, code: 'not_found' });
    });

    it('状态未变化时幂等返回（不写审计、不调用 update）', async () => {
      prisma.team.findUnique.mockResolvedValueOnce({ id: 't1', status: 'ACTIVE' });
      const result = await service.adminUpdateTeamStatus('user-admin', 't1', { status: 'ACTIVE' });
      expect(result.team).toEqual({ id: 't1', status: 'ACTIVE' });
      expect(prisma.team.update).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('停用团队写审计 action=team.status.suspended（含 from/to）', async () => {
      prisma.team.findUnique.mockResolvedValueOnce({ id: 't1', status: 'ACTIVE' });
      prisma.team.update.mockResolvedValueOnce({ id: 't1', status: 'SUSPENDED' });
      await service.adminUpdateTeamStatus('user-admin', 't1', { status: 'SUSPENDED' });
      expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ action: 'team.status.suspended', targetType: 'Team', targetId: 't1', metadata: { from: 'ACTIVE', to: 'SUSPENDED' } }),
      }));
    });

    it('启用团队写审计 action=team.status.activated', async () => {
      prisma.team.findUnique.mockResolvedValueOnce({ id: 't1', status: 'SUSPENDED' });
      prisma.team.update.mockResolvedValueOnce({ id: 't1', status: 'ACTIVE' });
      await service.adminUpdateTeamStatus('user-admin', 't1', { status: 'ACTIVE' });
      expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ action: 'team.status.activated' }),
      }));
    });
  });

  describe('adminTeamDetail', () => {
    it('团队不存在时抛 not_found', async () => {
      prisma.team.findUnique.mockResolvedValueOnce(null);
      await expect(service.adminTeamDetail('user-admin', 'missing')).rejects.toMatchObject({ status: 404, code: 'not_found' });
    });

    it('只返回概览计数与流水摘要，不捆绑关联列表', async () => {
      prisma.team.findUnique.mockResolvedValueOnce({
        id: 't1', name: '团队A', slug: 'team-a', status: 'ACTIVE', allowPublicJoin: false,
        description: '', balanceCents: 0, defaultPoolId: null,
        createdAt: new Date('2026-06-01T00:00:00.000Z'), updatedAt: new Date('2026-06-01T00:00:00.000Z'),
      });
      prisma.teamMembership.count.mockResolvedValueOnce(5);
      prisma.role.count.mockResolvedValueOnce(3);
      prisma.pluginPackage.count.mockResolvedValueOnce(2);
      prisma.purchase.count.mockResolvedValueOnce(7);
      prisma.balanceLedger.groupBy.mockResolvedValueOnce([
        { direction: 'CREDIT', _sum: { amountCents: 5000 } },
        { direction: 'DEBIT', _sum: { amountCents: 2000 } },
      ]);

      const result = await service.adminTeamDetail('user-admin', 't1');
      expect(result.memberCount).toBe(5);
      expect(result.roleCount).toBe(3);
      expect(result.pluginCount).toBe(2);
      expect(result.purchaseCount).toBe(7);
      expect(result).not.toHaveProperty('plugins');
      expect(result).not.toHaveProperty('purchases');
      expect(result).not.toHaveProperty('recentLedger');
      // CREDIT 5000 - DEBIT 2000 = 3000 净流入。
      expect(result.ledgerSummary).toEqual({ totalCreditCents: 5000, totalDebitCents: 2000, netCents: 3000 });
    });

    it('无流水时摘要兜底为 0（非 NaN）', async () => {
      prisma.team.findUnique.mockResolvedValueOnce({
        id: 't1', name: '团队A', slug: 'team-a', status: 'ACTIVE', allowPublicJoin: false,
        description: '', balanceCents: 0, defaultPoolId: null,
        createdAt: new Date(), updatedAt: new Date(),
      });
      prisma.balanceLedger.groupBy.mockResolvedValueOnce([]);
      const result = await service.adminTeamDetail('user-admin', 't1');
      expect(result.ledgerSummary).toEqual({ totalCreditCents: 0, totalDebitCents: 0, netCents: 0 });
    });
  });

  describe('adminTeamPlugins', () => {
    it('从 v4 package/listing 投影，并按严格 SemVer 选择最新发行版', async () => {
      prisma.team.findUnique.mockResolvedValueOnce({ id: 't1' });
      prisma.pluginPackage.findMany.mockResolvedValueOnce([{
        id: 'pkg-1', name: '图片插件', governanceStatus: 'ACTIVE',
        listing: { status: 'ACTIVE', priceCents: 500, installCount: 12 },
        releases: [
          { version: '1.9.0', status: 'PUBLISHED', marketReviewStatus: 'APPROVED' },
          { version: '1.10.0', status: 'PUBLISHED', marketReviewStatus: 'PENDING' },
        ],
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
        updatedAt: new Date('2026-07-02T00:00:00.000Z'),
      }]);
      prisma.pluginPackage.count.mockResolvedValueOnce(1);

      const result = await service.adminTeamPlugins('user-admin', 't1');

      expect(result.items[0]).toMatchObject({
        id: 'pkg-1', version: '1.10.0', status: 'ENABLED', visibility: 'PUBLIC',
        reviewStatus: 'PENDING', marketplace: true, priceCents: 500, installCount: 12,
      });
    });
  });
});

// === 组D 审计完善：auditLogs 分类筛选 + 关键词搜索 + auditCategories ===
// 覆盖：
//  - member_blocked：非平台管理员被拒绝（403）。
//  - no_filter：无过滤参数时 where 为空（全量）。
//  - category_filter：按分类过滤构造 where.OR（前缀 startsWith + 已注册 action 列表）。
//  - q_search：关键词搜索匹配 action / targetId / actor email。
//  - actor_target_filter：精确过滤 actorId / targetType。
//  - auditCategories：返回 8 个分类元数据。
function mockPrismaForAuditLogs() {
  const auditLog = {
    findMany: vi.fn(async () => [] as unknown[]),
    findUnique: vi.fn(),
    count: vi.fn(async () => 0),
  };
  return { auditLog };
}

function mockAuthForAuditLogs() {
  return {
    ensurePlatformAdmin: vi.fn(),
    ensureCurrentTeam: vi.fn(),
    ensureTeamAdmin: vi.fn(),
  };
}

describe('AdminService auditLogs 过滤', () => {
  let prisma: ReturnType<typeof mockPrismaForAuditLogs>;
  let auth: ReturnType<typeof mockAuthForAuditLogs>;
  let notifications: ReturnType<typeof mockNotifications>;
  let service: AdminService;

  beforeEach(() => {
    prisma = mockPrismaForAuditLogs();
    auth = mockAuthForAuditLogs();
    notifications = mockNotifications();
    // @ts-expect-error mock 不实现完整 PrismaService 接口，仅测用到的方法。
    service = new AdminService(prisma, auth, notifications);
  });

  it('非平台管理员被 ensurePlatformAdmin 拒绝（403）', async () => {
    auth.ensurePlatformAdmin.mockImplementation(() => {
      throw forbidden('仅平台管理员可操作');
    });
    await expect(service.auditLogs('user-member', {})).rejects.toMatchObject({ status: 403, code: 'forbidden' });
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  it('无过滤参数时使用默认分页，并让 findMany/count 共用 where', async () => {
    await service.auditLogs('user-admin', {});
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {},
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: 0,
      take: 20,
    }));
    expect(prisma.auditLog.count).toHaveBeenCalledWith({ where: {} });
  });

  it('category=auth 过滤构造 where.OR（前缀 startsWith + 已注册 action 列表）', async () => {
    await service.auditLogs('user-admin', { category: 'auth' });
    const call = prisma.auditLog.findMany.mock.calls[0][0] as { where: { OR?: unknown[] } };
    // where.OR 应包含 { action: { startsWith: 'auth.' } } 与 { action: { in: [...] } } 两条。
    expect(call.where.OR).toBeDefined();
    expect(call.where.OR).toHaveLength(2);
    // startsWith 前缀覆盖未来新增的 auth.* action。
    expect(call.where.OR).toContainEqual({ action: { startsWith: 'auth.' } });
  });

  it('category=system 覆盖未注册的配置/引导/system 前缀与已注册 action', async () => {
    await service.auditLogs('user-admin', { category: 'system' });
    const call = prisma.auditLog.findMany.mock.calls[0][0] as { where: { OR?: unknown[] } };
    expect(call.where.OR).toBeDefined();
    expect(call.where.OR).toContainEqual({ action: { startsWith: 'admin.setting' } });
    expect(call.where.OR).toContainEqual({ action: { startsWith: 'platform_admin' } });
    expect(call.where.OR).toContainEqual({ action: { startsWith: 'system.' } });
    const inClause = call.where.OR!.find((condition) => {
      const candidate = condition as { action?: { in?: string[] } };
      return Array.isArray(candidate.action?.in);
    }) as { action: { in: string[] } };
    expect(inClause.action.in).toContain('platform_admin.bootstrap');
    expect(inClause.action.in).toContain('admin.setting.updated');
  });

  it('q 关键词搜索匹配 action / targetId / actor email（OR 组合）', async () => {
    await service.auditLogs('user-admin', { q: 'plugin' });
    const call = prisma.auditLog.findMany.mock.calls[0][0] as {
      where: { OR: Array<Record<string, unknown>> };
    };
    // OR 应含 3 条：action contains / targetId contains / actor.email contains。
    expect(call.where.OR).toHaveLength(3);
    expect(call.where.OR.some((c) => 'action' in c)).toBe(true);
    expect(call.where.OR.some((c) => 'targetId' in c)).toBe(true);
    expect(call.where.OR.some((c) => 'actor' in c)).toBe(true);
  });

  it('actorId / targetType 精确过滤（写入 where）', async () => {
    await service.auditLogs('user-admin', { actorId: 'u1', targetType: 'Plugin' });
    const call = prisma.auditLog.findMany.mock.calls[0][0] as {
      where: { actorUserId?: string; targetType?: string };
    };
    expect(call.where.actorUserId).toBe('u1');
    expect(call.where.targetType).toBe('Plugin');
  });

  it('q 空白字符串不触发搜索（where 无 OR）', async () => {
    await service.auditLogs('user-admin', { q: '   ' });
    const call = prisma.auditLog.findMany.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(call.where.OR).toBeUndefined();
  });

  it('category + q 同时存在：两组条件 AND 串联（交集，非 OR 合并）— AUDIT-OR 修复', async () => {
    // 修复前：category 与 q 被扁平合并进同一个 where.OR，形成并集（范围错误扩大）。
    // 修复后：where.AND = [ { OR: category 组 }, { OR: keyword 组 } ]，交集语义正确。
    await service.auditLogs('user-admin', { category: 'auth', q: 'login' });
    const call = prisma.auditLog.findMany.mock.calls[0][0] as {
      where: { AND?: Array<{ OR: Array<Record<string, unknown>> }>; OR?: unknown };
    };
    // 同时存在 category + q 时不再用顶层 where.OR，改用 where.AND 串联两个 OR 组。
    expect(call.where.AND).toBeDefined();
    expect(call.where.OR).toBeUndefined();
    expect(call.where.AND).toHaveLength(2);
    // 第一组 = category 的 OR（auth 前缀 startsWith + 已注册 action 列表）。
    const categoryGroup = call.where.AND![0].OR;
    expect(categoryGroup.some((c) => 'action' in c && 'startsWith' in c.action)).toBe(true);
    // 第二组 = keyword 的 OR（action / targetId / actor.email 三条 contains）。
    const keywordGroup = call.where.AND![1].OR;
    expect(keywordGroup).toHaveLength(3);
    expect(keywordGroup.some((c) => 'action' in c && 'contains' in c.action)).toBe(true);
    expect(keywordGroup.some((c) => 'targetId' in c)).toBe(true);
    expect(keywordGroup.some((c) => 'actor' in c)).toBe(true);
  });

  it('actor select 白名单不含 passwordHash/tokenVersion（防凭据泄漏）', async () => {
    await service.auditLogs('user-admin', {});
    const call = prisma.auditLog.findMany.mock.calls[0][0] as {
      select: { actor: { select: Record<string, boolean> }; metadata?: boolean };
    };
    expect(call.select.actor.select).toEqual({
      id: true,
      email: true,
      displayName: true,
    });
    expect(call.select).not.toHaveProperty('metadata');
    expect(call.select.actor.select).not.toHaveProperty('passwordHash');
    expect(call.select.actor.select).not.toHaveProperty('tokenVersion');
  });

  it('auditCategories 返回 8 个分类元数据', async () => {
    const result = await service.auditCategories('user-admin');
    expect(result.categories).toHaveLength(8);
    expect(result.categories.map((c) => c.key)).toEqual([
      'auth', 'team', 'plugin', 'marketplace', 'wallet', 'llm', 'admin', 'system',
    ]);
  });
});

// === 组C 用户管理 + 平台管理员管理完善 ===
// 覆盖 4 个新方法：
//  - adminUserDetail：非管理员拒绝；用户不存在 not_found；聚合登录历史 + 钱包 + 团队 + 钱包流水（钱包不存在兜底 0）。
//  - adminResetUserPassword：非管理员拒绝；用户不存在 not_found；生成临时密码 + 改密 + tokenVersion++ + 审计（不记密码值）+ 通知 + 邮件。
//  - adminUpdateUserPlatformRole：非管理员拒绝；禁止自改自身；幂等（角色未变不写审计）；降级最后一个管理员 forbidden；降级 tokenVersion++ + 审计 from/to。
//  - adminActivity：非管理员拒绝；返回 actor 维度审计日志。
function mockPrismaForUser() {
  const user = { findUnique: vi.fn(), update: vi.fn(), count: vi.fn(async () => 0) };
  const auditLog = { findMany: vi.fn(async () => []), count: vi.fn(async () => 0), create: vi.fn() };
  const wallet = { findUnique: vi.fn(async () => null) };
  const teamMembership = { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) };
  const walletTransaction = { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) };
  const tx = { user, auditLog };
  const $transaction = vi.fn(async (cb: (tx: typeof tx) => Promise<unknown>) => cb(tx));
  return { user, auditLog, wallet, teamMembership, walletTransaction, $transaction };
}

function mockMail() {
  return { sendMail: vi.fn(async () => undefined) };
}

describe('AdminService 用户管理 + 平台管理员管理完善（组C）', () => {
  let prisma: ReturnType<typeof mockPrismaForUser>;
  let auth: ReturnType<typeof mockAuthForReview>;
  let notifications: ReturnType<typeof mockNotifications>;
  let mail: ReturnType<typeof mockMail>;
  let service: AdminService;

  beforeEach(() => {
    prisma = mockPrismaForUser();
    auth = mockAuthForReview();
    notifications = mockNotifications();
    mail = mockMail();
    // @ts-expect-error mock 不实现完整 PrismaService 接口，仅测用到的方法。
    service = new AdminService(prisma, auth, notifications, mail);
  });

  describe('adminUserDetail', () => {
    it('非平台管理员被拒绝（403）', async () => {
      auth.ensurePlatformAdmin.mockImplementation(() => {
        throw forbidden('仅平台管理员可操作');
      });
      await expect(service.adminUserDetail('user-member', 'u1')).rejects.toMatchObject({ status: 403, code: 'forbidden' });
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('用户不存在时抛 not_found', async () => {
      prisma.user.findUnique.mockResolvedValueOnce(null);
      await expect(service.adminUserDetail('user-admin', 'missing')).rejects.toMatchObject({ status: 404, code: 'not_found' });
    });

    it('只返回白名单 overview，关联时间线不随详情预加载', async () => {
      const now = new Date('2026-06-15T00:00:00.000Z');
      prisma.user.findUnique.mockResolvedValueOnce({
        id: 'u1', email: 'a@x.com', displayName: 'A', status: 'ACTIVE', platformRole: 'NONE',
        platformRoleId: null, createdAt: now, updatedAt: now, emailVerified: null,
        passwordHash: 'secret', tokenVersion: 1,
      });

      const result = await service.adminUserDetail('user-admin', 'u1');
      expect(result.user).toMatchObject({ id: 'u1', email: 'a@x.com', platformRole: 'NONE' });
      expect(result.user).not.toHaveProperty('passwordHash');
      expect(result.user).not.toHaveProperty('tokenVersion');
      expect(result).toEqual({ user: result.user });
      expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
      expect(prisma.teamMembership.findMany).not.toHaveBeenCalled();
      expect(prisma.walletTransaction.findMany).not.toHaveBeenCalled();
      const call = prisma.user.findUnique.mock.calls[0][0] as { select: Record<string, boolean> };
      expect(call.select).not.toHaveProperty('passwordHash');
      expect(call.select).not.toHaveProperty('tokenVersion');
    });
  });

  describe('adminResetUserPassword', () => {
    it('非平台管理员被拒绝（403）', async () => {
      auth.ensurePlatformAdmin.mockImplementation(() => {
        throw forbidden('仅平台管理员可操作');
      });
      await expect(service.adminResetUserPassword('user-member', 'u1')).rejects.toMatchObject({ status: 403, code: 'forbidden' });
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('用户不存在时抛 not_found', async () => {
      prisma.user.findUnique.mockResolvedValueOnce(null);
      await expect(service.adminResetUserPassword('user-admin', 'missing')).rejects.toMatchObject({ status: 404, code: 'not_found' });
    });

    it('生成临时密码 + 改密 + tokenVersion++ + 审计（不记密码值）+ 通知 + 邮件', async () => {
      prisma.user.findUnique.mockResolvedValueOnce({ id: 'u1', email: 'a@x.com', displayName: 'A', status: 'ACTIVE' });
      prisma.user.update.mockResolvedValueOnce({ id: 'u1' });

      const result = await service.adminResetUserPassword('user-admin', 'u1');
      // 返回临时密码（randomBytes(9) → base64url 恰好 12 字符）。
      expect(result.tempPassword).toHaveLength(12);
      expect(typeof result.tempPassword).toBe('string');
      // 事务内改密 + tokenVersion++。
      expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'u1' },
        data: expect.objectContaining({ tokenVersion: { increment: 1 }, passwordHash: expect.any(String) }),
      }));
      // 审计 action=admin.user.password_reset，metadata 不含密码值（仅 reset + email）。
      expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          action: 'admin.user.password_reset',
          targetType: 'User',
          targetId: 'u1',
          metadata: { reset: true, email: 'a@x.com' },
        }),
      }));
      // 通知用户 type=password_reset_by_admin。
      expect(notifications.create).toHaveBeenCalledWith(
        'u1', 'password_reset_by_admin', expect.any(String), expect.any(String),
        { relatedType: 'User', relatedId: 'u1' },
      );
      // 邮件通知（临时密码不发邮件，仅通知）。
      expect(mail.sendMail).toHaveBeenCalledWith('a@x.com', expect.any(String), expect.any(String));
    });

    it('通知触发失败不阻塞主流程（仍返回临时密码）', async () => {
      prisma.user.findUnique.mockResolvedValueOnce({ id: 'u1', email: 'a@x.com', displayName: 'A', status: 'ACTIVE' });
      prisma.user.update.mockResolvedValueOnce({ id: 'u1' });
      notifications.create.mockRejectedValueOnce(new Error('db down'));
      const result = await service.adminResetUserPassword('user-admin', 'u1');
      expect(result.tempPassword).toHaveLength(12);
    });

    it('邮件通知失败时显式返回未发送状态（仍返回临时密码）', async () => {
      prisma.user.findUnique.mockResolvedValueOnce({ id: 'u1', email: 'a@x.com', displayName: 'A', status: 'ACTIVE' });
      prisma.user.update.mockResolvedValueOnce({ id: 'u1' });
      mail.sendMail.mockRejectedValueOnce(new Error('SMTP 未配置'));

      const result = await service.adminResetUserPassword('user-admin', 'u1');

      expect(result.tempPassword).toHaveLength(12);
      expect(result.emailNotice).toEqual({
        sent: false,
        message: '邮件通知未发送：SMTP 未配置',
      });
    });
  });

  describe('adminUpdateUserPlatformRole', () => {
    it('非平台管理员被拒绝（403）', async () => {
      auth.ensurePlatformAdmin.mockImplementation(() => {
        throw forbidden('仅平台管理员可操作');
      });
      await expect(service.adminUpdateUserPlatformRole('user-member', 'u1', { platformRole: 'PLATFORM_ADMIN' }))
        .rejects.toMatchObject({ status: 403, code: 'forbidden' });
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('禁止自改自身（防自降级/自提权）', async () => {
      await expect(service.adminUpdateUserPlatformRole('user-admin', 'user-admin', { platformRole: 'PLATFORM_ADMIN' }))
        .rejects.toMatchObject({ status: 403, code: 'forbidden' });
    });

    it('用户不存在时抛 not_found', async () => {
      prisma.user.findUnique.mockResolvedValueOnce(null);
      await expect(service.adminUpdateUserPlatformRole('user-admin', 'missing', { platformRole: 'PLATFORM_ADMIN' }))
        .rejects.toMatchObject({ status: 404, code: 'not_found' });
    });

    it('角色未变化时幂等返回（不写审计、不调用 update）', async () => {
      prisma.user.findUnique.mockResolvedValueOnce({ id: 'u1', email: 'a@x.com', displayName: 'A', platformRole: 'PLATFORM_ADMIN', status: 'ACTIVE' });
      const result = await service.adminUpdateUserPlatformRole('user-admin', 'u1', { platformRole: 'PLATFORM_ADMIN' });
      expect(result.user.platformRole).toBe('PLATFORM_ADMIN');
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('升级为 PLATFORM_ADMIN 写审计 admin.user.role_changed（from/to），不 tokenVersion++', async () => {
      prisma.user.findUnique.mockResolvedValueOnce({ id: 'u1', email: 'a@x.com', displayName: 'A', platformRole: 'NONE', status: 'ACTIVE' });
      prisma.user.update.mockResolvedValueOnce({ id: 'u1', email: 'a@x.com', displayName: 'A', platformRole: 'PLATFORM_ADMIN', status: 'ACTIVE' });
      await service.adminUpdateUserPlatformRole('user-admin', 'u1', { platformRole: 'PLATFORM_ADMIN' });
      // 升级不 tokenVersion++（提权不涉及吊销）；RBAC 双写 platformRole + platformRoleId。
      expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'u1' },
        data: { platformRole: 'PLATFORM_ADMIN', platformRoleId: '00000000-0000-0000-0000-platform0001' },
      }));
      expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ action: 'admin.user.role_changed', targetType: 'User', targetId: 'u1', metadata: { from: 'NONE', to: 'PLATFORM_ADMIN' } }),
      }));
    });

    it('降级为 NONE 时 tokenVersion++（作废旧 token）', async () => {
      prisma.user.findUnique.mockResolvedValueOnce({ id: 'u1', email: 'a@x.com', displayName: 'A', platformRole: 'PLATFORM_ADMIN', status: 'ACTIVE' });
      prisma.user.count.mockResolvedValueOnce(3); // 3 个管理员，可降级
      prisma.user.update.mockResolvedValueOnce({ id: 'u1', email: 'a@x.com', displayName: 'A', platformRole: 'NONE', status: 'ACTIVE' });
      await service.adminUpdateUserPlatformRole('user-admin', 'u1', { platformRole: 'NONE' });
      // RBAC 双写：降级时 platformRoleId 同步置 null + tokenVersion++ 作废旧 token。
      expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'u1' },
        data: { platformRole: 'NONE', platformRoleId: null, tokenVersion: { increment: 1 } },
      }));
      expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ metadata: { from: 'PLATFORM_ADMIN', to: 'NONE' } }),
      }));
    });

    it('降级最后一个 PLATFORM_ADMIN 时抛 forbidden', async () => {
      prisma.user.findUnique.mockResolvedValueOnce({ id: 'u1', email: 'a@x.com', displayName: 'A', platformRole: 'PLATFORM_ADMIN', status: 'ACTIVE' });
      prisma.user.count.mockResolvedValueOnce(1); // 仅剩 1 个管理员
      await expect(service.adminUpdateUserPlatformRole('user-admin', 'u1', { platformRole: 'NONE' }))
        .rejects.toMatchObject({ status: 403, code: 'forbidden' });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });

  describe('adminActivity', () => {
    it('非平台管理员被拒绝（403）', async () => {
      auth.ensurePlatformAdmin.mockImplementation(() => {
        throw forbidden('仅平台管理员可操作');
      });
      await expect(service.adminActivity('user-member', 'admin-1')).rejects.toMatchObject({ status: 403, code: 'forbidden' });
      expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
    });

    it('返回 actor 维度审计日志（actor select 白名单脱敏）', async () => {
      prisma.user.findUnique.mockResolvedValueOnce({ id: 'admin-1' });
      prisma.auditLog.findMany.mockResolvedValueOnce([]);
      await service.adminActivity('user-admin', 'admin-1');
      const call = prisma.auditLog.findMany.mock.calls[0][0] as {
        where: { actorUserId: string };
        select: Record<string, boolean>;
      };
      expect(call.where.actorUserId).toBe('admin-1');
      expect(call.select).not.toHaveProperty('metadata');
      expect(call.select).not.toHaveProperty('actor');
      expect(prisma.auditLog.count).toHaveBeenCalledWith({ where: call.where });
    });
  });
});
