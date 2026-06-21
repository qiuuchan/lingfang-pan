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

function mockPrisma() {
  const auditLog = { count: vi.fn(async () => 0) };
  const purchase = {
    aggregate: vi.fn(async () => ({ _sum: { priceCents: null } })),
    findMany: vi.fn(async () => []),
  };
  const plugin = { findMany: vi.fn(async () => []) };
  const user = { count: vi.fn(async () => 0) };
  return { auditLog, purchase, plugin, user };
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

  describe('adminGenerationStats', () => {
    it('非平台管理员被 ensurePlatformAdmin 拒绝（403）', async () => {
      auth.ensurePlatformAdmin.mockImplementation(() => {
        throw forbidden('仅平台管理员可操作');
      });
      await expect(service.adminGenerationStats('user-member')).rejects.toMatchObject({ status: 403, code: 'forbidden' });
      expect(prisma.auditLog.count).not.toHaveBeenCalled();
    });

    it('按 audit 计数聚合调用/成功/失败/成功率', async () => {
      // 4 次 count 调用顺序：monthCalls, monthSuccess, totalCalls, totalSuccess。
      prisma.auditLog.count
        .mockResolvedValueOnce(100) // 月调用
        .mockResolvedValueOnce(80) // 月成功
        .mockResolvedValueOnce(1000) // 累计调用
        .mockResolvedValueOnce(750); // 累计成功
      const result = await service.adminGenerationStats('user-admin');
      expect(result.month).toEqual({ calls: 100, success: 80, failed: 20, successRate: 80 });
      expect(result.total).toEqual({ calls: 1000, success: 750, failed: 250, successRate: 75 });
      // 平均耗时字段保留为 null（audit 未记录 duration），前端不渲染 NaN。
      expect(result.avgDurationMs).toBeNull();
    });

    it('调用次数为 0 时 successRate 兜底为 0（非 NaN）', async () => {
      prisma.auditLog.count.mockResolvedValue(0);
      const result = await service.adminGenerationStats('user-admin');
      expect(result.month.successRate).toBe(0);
      expect(result.total.successRate).toBe(0);
      // 失败数也兜底为 0，避免出现负数（Math.max(0, calls - success)）。
      expect(result.month.failed).toBe(0);
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
      prisma.plugin.findMany.mockResolvedValue([]);

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
      prisma.plugin.findMany.mockResolvedValue([
        { id: 'p1', name: '插件A', installCount: 42, ratingCount: 10, ratingSum: 45, priceCents: 0 },
        { id: 'p2', name: '插件B', installCount: 7, ratingCount: 0, ratingSum: 0, priceCents: 1000 },
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
      prisma.plugin.findMany.mockResolvedValue([]);

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

// === 通知埋点契约：审核/申请结果触发 NotificationService.create（触发失败不阻塞主操作）===
// 覆盖 4 个埋点：adminApprovePlugin / adminRejectPlugin / approveApplication / rejectApplication。
// 关键断言：notifications.create 被以正确的 userId（authorUserId / 申请者 userId）+ type 调用，
// 且 create 抛错时主流程仍正常返回（不阻塞）。
const NOW = new Date('2026-06-15T00:00:00.000Z');

// plugin 完整字段：publicPlugin(plugin-package.ts) 会读 createdAt/updatedAt/ratingSum/installCount 等，
// mock 必须补齐这些字段，否则 toISOString 报 undefined。
function makeReviewPlugin(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'p1',
    name: '插件A',
    description: '',
    version: '0.1.0',
    entry: 'ui/index.html',
    runtimeType: 'CLIENT',
    status: 'ENABLED',
    visibility: 'TEAM',
    teamId: 't1',
    authorUserId: 'author-1',
    files: [],
    manifest: {},
    capabilities: [],
    contentHash: '',
    reviewStatus: 'PENDING',
    reviewReason: '',
    reviewedById: null,
    reviewedAt: null,
    marketplace: false,
    priceCents: 0,
    installCount: 0,
    ratingCount: 0,
    ratingSum: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function mockPrismaForReview() {
  const plugin = { findUnique: vi.fn(async () => null), update: vi.fn() };
  const pluginReview = { create: vi.fn() };
  const auditLog = { create: vi.fn() };
  const teamAdminApplication = { findUnique: vi.fn(async () => null), update: vi.fn() };
  const team = { create: vi.fn() };
  const teamMembership = { create: vi.fn() };
  const tx = { plugin, pluginReview, auditLog, teamAdminApplication, team, teamMembership };
  const $transaction = vi.fn(async (cb: (tx: typeof tx) => Promise<unknown>) => cb(tx));
  return { plugin, pluginReview, auditLog, teamAdminApplication, team, teamMembership, $transaction };
}

function mockAuthForReview() {
  return {
    ensurePlatformAdmin: vi.fn(),
    ensureCurrentTeam: vi.fn(),
    ensureTeamAdmin: vi.fn(),
    // createTeamForApplication：approveApplication 委托此方法建团（内部事务）。
    createTeamForApplication: vi.fn(),
  };
}

describe('AdminService 通知埋点', () => {
  let prisma: ReturnType<typeof mockPrismaForReview>;
  let auth: ReturnType<typeof mockAuthForReview>;
  let notifications: ReturnType<typeof mockNotifications>;
  let service: AdminService;

  beforeEach(() => {
    prisma = mockPrismaForReview();
    auth = mockAuthForReview();
    notifications = mockNotifications();
    // @ts-expect-error mock 不实现完整 PrismaService 接口。
    service = new AdminService(prisma, auth, notifications);
  });

  it('adminApprovePlugin 触发通知 authorUserId（type=plugin_approved）', async () => {
    prisma.plugin.findUnique.mockResolvedValueOnce(makeReviewPlugin());
    prisma.plugin.update.mockResolvedValueOnce(makeReviewPlugin({ reviewStatus: 'APPROVED', marketplace: true, visibility: 'PUBLIC' }));
    await service.adminApprovePlugin('user-admin', 'p1');
    expect(notifications.create).toHaveBeenCalledWith(
      'author-1', 'plugin_approved', expect.any(String), expect.any(String),
      { relatedType: 'Plugin', relatedId: 'p1' },
    );
  });

  it('adminRejectPlugin 触发通知 authorUserId（type=plugin_rejected，body 含原因）', async () => {
    prisma.plugin.findUnique.mockResolvedValueOnce(makeReviewPlugin());
    prisma.plugin.update.mockResolvedValueOnce(makeReviewPlugin({ reviewStatus: 'REJECTED' }));
    await service.adminRejectPlugin('user-admin', 'p1', '描述不符规范');
    expect(notifications.create).toHaveBeenCalledWith(
      'author-1', 'plugin_rejected', expect.any(String), expect.stringContaining('描述不符规范'),
      { relatedType: 'Plugin', relatedId: 'p1' },
    );
  });

  it('adminApprovePlugin 无 authorUserId 时不触发通知（不报错）', async () => {
    prisma.plugin.findUnique.mockResolvedValueOnce(makeReviewPlugin({ authorUserId: null }));
    prisma.plugin.update.mockResolvedValueOnce(makeReviewPlugin({ authorUserId: null, reviewStatus: 'APPROVED', marketplace: true, visibility: 'PUBLIC' }));
    await service.adminApprovePlugin('user-admin', 'p1');
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('审核通过后通知 create 抛错时主流程不阻塞（仍正常返回）', async () => {
    prisma.plugin.findUnique.mockResolvedValueOnce(makeReviewPlugin());
    prisma.plugin.update.mockResolvedValueOnce(makeReviewPlugin({ reviewStatus: 'APPROVED', marketplace: true, visibility: 'PUBLIC' }));
    notifications.create.mockRejectedValueOnce(new Error('db down'));
    const result = await service.adminApprovePlugin('user-admin', 'p1');
    expect(result.plugin.reviewStatus).toBe('APPROVED');
  });

  it('approveApplication 触发通知申请者 userId（type=application_approved）', async () => {
    // createTeamForApplication 建团后回读申请者 userId 触发通知。
    auth.createTeamForApplication.mockResolvedValueOnce({ id: 'team-1', name: '团队X', slug: 'tuangan-x' });
    prisma.teamAdminApplication.findUnique.mockResolvedValueOnce({ id: 'app-1', userId: 'applier-1', teamName: '团队X' });
    const result = await service.approveApplication('user-admin', 'app-1');
    expect(result.team.id).toBe('team-1');
    expect(notifications.create).toHaveBeenCalledWith(
      'applier-1', 'application_approved', expect.any(String), expect.any(String),
      { relatedType: 'Team', relatedId: 'team-1' },
    );
  });

  it('rejectApplication 触发通知申请者 userId（type=application_rejected）', async () => {
    prisma.teamAdminApplication.findUnique.mockResolvedValueOnce({ id: 'app-1', userId: 'applier-1', teamName: '团队X', status: 'PENDING' });
    prisma.teamAdminApplication.update.mockResolvedValueOnce({ id: 'app-1', status: 'REJECTED' });
    await service.rejectApplication('user-admin', 'app-1', '资料不全');
    expect(notifications.create).toHaveBeenCalledWith(
      'applier-1', 'application_rejected', expect.any(String), expect.stringContaining('资料不全'),
      { relatedType: 'TeamAdminApplication', relatedId: 'app-1' },
    );
  });

  it('rejectApplication 对已处理申请抛 conflict（不触发通知）', async () => {
    prisma.teamAdminApplication.findUnique.mockResolvedValueOnce({ id: 'app-1', userId: 'applier-1', status: 'APPROVED' });
    await expect(service.rejectApplication('user-admin', 'app-1')).rejects.toMatchObject({ status: 409 });
    expect(notifications.create).not.toHaveBeenCalled();
  });
});

// === 组B 团队管理完善：成员列表 / 角色切换 / 状态启停 / 详情聚合 ===
// 覆盖 4 个新方法，关键断言：
//  - 非平台管理员被 ensurePlatformAdmin 拒绝（403）。
//  - adminUpdateMemberRole / adminUpdateTeamStatus 的幂等优化（无变更不写审计）。
//  - action 前缀分类（team.member.role_changed / team.status.suspended / team.status.activated）。
//  - adminTeamDetail 聚合成员数 + 插件数 + 购买 + 流水摘要（空表兜底非 NaN）。
function mockPrismaForTeam() {
  const team = { findUnique: vi.fn(), update: vi.fn() };
  const teamMembership = { findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn(async () => 0), update: vi.fn() };
  const plugin = { findMany: vi.fn(async () => []) };
  const purchase = { findMany: vi.fn(async () => []) };
  const balanceLedger = { groupBy: vi.fn(async () => []), findMany: vi.fn(async () => []) };
  const auditLog = { create: vi.fn() };
  return { team, teamMembership, plugin, purchase, balanceLedger, auditLog };
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
        { teamId: 't1', userId: 'u1', role: 'TEAM_ADMIN', status: 'ACTIVE', joinedAt: now, user: { id: 'u1', email: 'a@x.com', displayName: 'A', status: 'ACTIVE', platformRole: 'NONE', passwordHash: 'secret', tokenVersion: 1 } },
        { teamId: 't1', userId: 'u2', role: 'MEMBER', status: 'ACTIVE', joinedAt: now, user: { id: 'u2', email: 'b@x.com', displayName: 'B', status: 'ACTIVE', platformRole: 'NONE', passwordHash: 'secret', tokenVersion: 1 } },
      ]);
      const result = await service.adminTeamMembers('user-admin', 't1');
      expect(result.members).toHaveLength(2);
      // publicUser 脱敏：不得携带 passwordHash / tokenVersion。
      expect(result.members[0].user).toEqual({ id: 'u1', email: 'a@x.com', displayName: 'A', status: 'ACTIVE', platformRole: 'NONE' });
      expect(result.members[0]).not.toHaveProperty('user.passwordHash');
    });
  });

  describe('adminUpdateMemberRole', () => {
    it('成员关系不存在时抛 not_found', async () => {
      prisma.teamMembership.findUnique.mockResolvedValueOnce(null);
      await expect(service.adminUpdateMemberRole('user-admin', 't1', 'u1', { role: 'TEAM_ADMIN' })).rejects.toMatchObject({ status: 404, code: 'not_found' });
    });

    it('角色未变化时幂等返回（不写审计、不调用 update）', async () => {
      prisma.teamMembership.findUnique.mockResolvedValueOnce({ teamId: 't1', userId: 'u1', role: 'TEAM_ADMIN', status: 'ACTIVE' });
      const result = await service.adminUpdateMemberRole('user-admin', 't1', 'u1', { role: 'TEAM_ADMIN' });
      expect(result.membership.role).toBe('TEAM_ADMIN');
      expect(prisma.teamMembership.update).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('切换角色时写审计 action=team.member.role_changed（含 from/to）', async () => {
      prisma.teamMembership.findUnique.mockResolvedValueOnce({ teamId: 't1', userId: 'u1', role: 'MEMBER', status: 'ACTIVE' });
      prisma.teamMembership.update.mockResolvedValueOnce({ teamId: 't1', userId: 'u1', role: 'TEAM_ADMIN', status: 'ACTIVE' });
      await service.adminUpdateMemberRole('user-admin', 't1', 'u1', { role: 'TEAM_ADMIN' });
      expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ action: 'team.member.role_changed', targetType: 'User', targetId: 'u1', metadata: { teamId: 't1', from: 'MEMBER', to: 'TEAM_ADMIN' } }),
      }));
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

    it('聚合成员数/插件数/购买/流水摘要（空表兜底非 NaN）', async () => {
      prisma.team.findUnique.mockResolvedValueOnce({ id: 't1', name: '团队A', balanceCents: 0 });
      prisma.teamMembership.count.mockResolvedValueOnce(5);
      prisma.plugin.findMany.mockResolvedValueOnce([{ id: 'p1', name: '插件A', status: 'ENABLED', visibility: 'TEAM', reviewStatus: 'APPROVED', marketplace: true, priceCents: 0, installCount: 3 }]);
      prisma.purchase.findMany.mockResolvedValueOnce([{ id: 'po1', pluginId: 'p2', priceCents: 1000, createdAt: new Date('2026-06-01T00:00:00.000Z'), plugin: { id: 'p2', name: '外部插件' } }]);
      prisma.balanceLedger.groupBy.mockResolvedValueOnce([
        { direction: 'CREDIT', _sum: { amountCents: 5000 } },
        { direction: 'DEBIT', _sum: { amountCents: 2000 } },
      ]);
      prisma.balanceLedger.findMany.mockResolvedValueOnce([{ id: 'l1', teamId: 't1', amountCents: 5000, direction: 'CREDIT', reason: 'initial_balance' }]);

      const result = await service.adminTeamDetail('user-admin', 't1');
      expect(result.memberCount).toBe(5);
      expect(result.pluginCount).toBe(1);
      expect(result.plugins[0].name).toBe('插件A');
      expect(result.purchases[0]).toMatchObject({ pluginName: '外部插件', priceCents: 1000 });
      // CREDIT 5000 - DEBIT 2000 = 3000 净流入。
      expect(result.ledgerSummary).toEqual({ totalCreditCents: 5000, totalDebitCents: 2000, netCents: 3000 });
    });

    it('无流水时摘要兜底为 0（非 NaN）', async () => {
      prisma.team.findUnique.mockResolvedValueOnce({ id: 't1', name: '团队A', balanceCents: 0 });
      prisma.balanceLedger.groupBy.mockResolvedValueOnce([]);
      const result = await service.adminTeamDetail('user-admin', 't1');
      expect(result.ledgerSummary).toEqual({ totalCreditCents: 0, totalDebitCents: 0, netCents: 0 });
    });
  });
});

// === 组A 插件管理完善：扩展 adminUpdatePlugin（version/visibility/字段白名单）+ adminDelistPlugin + adminPluginAuditHistory ===
// 覆盖关键契约：
//  - adminUpdatePlugin：非管理员拒绝；字段白名单（仅声明字段落库 + 审计 metadata）；priceCents 强制取整非负。
//  - adminDelistPlugin：非管理员拒绝；未上架 conflict；下架写 admin.plugin.delisted 审计 + marketplace=false/reviewStatus=DRAFT；通知作者（触发失败不阻塞）。
//  - adminPluginAuditHistory：非管理员拒绝；插件不存在 not_found；返回 PluginReview 列表（reviewer 脱敏）。
function mockPrismaForPlugin() {
  const plugin = { findUnique: vi.fn(), update: vi.fn() };
  const pluginReview = { findMany: vi.fn(async () => []) };
  const auditLog = { create: vi.fn() };
  const tx = { plugin, pluginReview, auditLog };
  const $transaction = vi.fn(async (cb: (tx: typeof tx) => Promise<unknown>) => cb(tx));
  return { plugin, pluginReview, auditLog, $transaction };
}

describe('AdminService 插件管理完善（组A）', () => {
  let prisma: ReturnType<typeof mockPrismaForPlugin>;
  let auth: ReturnType<typeof mockAuthForReview>;
  let notifications: ReturnType<typeof mockNotifications>;
  let service: AdminService;

  beforeEach(() => {
    prisma = mockPrismaForPlugin();
    auth = mockAuthForReview();
    notifications = mockNotifications();
    // @ts-expect-error mock 不实现完整 PrismaService 接口。
    service = new AdminService(prisma, auth, notifications);
  });

  describe('adminUpdatePlugin', () => {
    it('非平台管理员被拒绝（403）', async () => {
      auth.ensurePlatformAdmin.mockImplementation(() => {
        throw forbidden('仅平台管理员可操作');
      });
      await expect(service.adminUpdatePlugin('user-member', 'p1', { name: '新名' })).rejects.toMatchObject({ status: 403, code: 'forbidden' });
      expect(prisma.plugin.update).not.toHaveBeenCalled();
    });

    it('插件不存在时抛 not_found', async () => {
      prisma.plugin.findUnique.mockResolvedValueOnce(null);
      await expect(service.adminUpdatePlugin('user-admin', 'missing', { name: '新名' })).rejects.toMatchObject({ status: 404, code: 'not_found' });
    });

    it('字段白名单：仅声明字段落库 + 审计 metadata 只含变更字段', async () => {
      prisma.plugin.findUnique.mockResolvedValueOnce({ id: 'p1' });
      prisma.plugin.update.mockResolvedValueOnce(makeReviewPlugin({ name: '新名', version: '1.2.0', visibility: 'PUBLIC', priceCents: 500 }));
      const result = await service.adminUpdatePlugin('user-admin', 'p1', {
        name: '新名', version: '1.2.0', visibility: 'PUBLIC', priceCents: 500,
      });
      // update.data 仅含四个声明字段（不含未声明的 marketplace/reviewStatus 等）。
      expect(prisma.plugin.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'p1' },
        data: { name: '新名', version: '1.2.0', visibility: 'PUBLIC', priceCents: 500 },
      }));
      // 审计 metadata 精确记录变更字段（H5 同类修复：不裸透传 input DTO）。
      expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ action: 'admin.plugin.updated', targetType: 'Plugin', targetId: 'p1', metadata: { name: '新名', version: '1.2.0', visibility: 'PUBLIC', priceCents: 500 } }),
      }));
      expect(result.plugin.name).toBe('新名');
    });

    it('priceCents 强制取整非负（负数或浮点兜底）', async () => {
      prisma.plugin.findUnique.mockResolvedValueOnce({ id: 'p1' });
      prisma.plugin.update.mockResolvedValueOnce(makeReviewPlugin({ priceCents: 0 }));
      await service.adminUpdatePlugin('user-admin', 'p1', { priceCents: -12.7 });
      expect(prisma.plugin.update).toHaveBeenCalledWith(expect.objectContaining({
        data: { priceCents: 0 }, // Math.max(0, Math.floor(-12.7)) = 0
      }));
    });

    it('部分字段更新：仅传 status 时 data 只含 status', async () => {
      prisma.plugin.findUnique.mockResolvedValueOnce({ id: 'p1' });
      prisma.plugin.update.mockResolvedValueOnce(makeReviewPlugin({ status: 'DISABLED' }));
      await service.adminUpdatePlugin('user-admin', 'p1', { status: 'DISABLED' });
      expect(prisma.plugin.update).toHaveBeenCalledWith(expect.objectContaining({
        data: { status: 'DISABLED' },
      }));
    });
  });

  describe('adminDelistPlugin', () => {
    it('非平台管理员被拒绝（403）', async () => {
      auth.ensurePlatformAdmin.mockImplementation(() => {
        throw forbidden('仅平台管理员可操作');
      });
      await expect(service.adminDelistPlugin('user-member', 'p1')).rejects.toMatchObject({ status: 403, code: 'forbidden' });
      expect(prisma.plugin.findUnique).not.toHaveBeenCalled();
    });

    it('插件不存在时抛 not_found', async () => {
      prisma.plugin.findUnique.mockResolvedValueOnce(null);
      await expect(service.adminDelistPlugin('user-admin', 'missing')).rejects.toMatchObject({ status: 404, code: 'not_found' });
    });

    it('未上架市场时抛 conflict（无需下架）', async () => {
      prisma.plugin.findUnique.mockResolvedValueOnce(makeReviewPlugin({ marketplace: false }));
      await expect(service.adminDelistPlugin('user-admin', 'p1')).rejects.toMatchObject({ status: 409, code: 'conflict' });
      expect(prisma.plugin.update).not.toHaveBeenCalled();
    });

    it('下架写 marketplace=false + reviewStatus=DRAFT + admin.plugin.delisted 审计 + 通知作者', async () => {
      prisma.plugin.findUnique.mockResolvedValueOnce(makeReviewPlugin({ marketplace: true }));
      prisma.plugin.update.mockResolvedValueOnce(makeReviewPlugin({ marketplace: false, reviewStatus: 'DRAFT' }));
      const result = await service.adminDelistPlugin('user-admin', 'p1', '违规内容');
      expect(prisma.plugin.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'p1' },
        data: expect.objectContaining({ marketplace: false, reviewStatus: 'DRAFT', reviewReason: '', reviewedById: null, reviewedAt: null }),
      }));
      expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ action: 'admin.plugin.delisted', targetType: 'Plugin', targetId: 'p1', metadata: { teamId: 't1', reason: '违规内容' } }),
      }));
      expect(result.plugin.marketplace).toBe(false);
      // 通知作者 type=plugin_delisted，body 含原因。
      expect(notifications.create).toHaveBeenCalledWith(
        'author-1', 'plugin_delisted', expect.any(String), expect.stringContaining('违规内容'),
        { relatedType: 'Plugin', relatedId: 'p1' },
      );
    });

    it('无 authorUserId 时不触发通知（不报错）', async () => {
      prisma.plugin.findUnique.mockResolvedValueOnce(makeReviewPlugin({ authorUserId: null, marketplace: true }));
      prisma.plugin.update.mockResolvedValueOnce(makeReviewPlugin({ authorUserId: null, marketplace: false, reviewStatus: 'DRAFT' }));
      await service.adminDelistPlugin('user-admin', 'p1');
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('通知 create 抛错时主流程不阻塞（仍正常返回）', async () => {
      prisma.plugin.findUnique.mockResolvedValueOnce(makeReviewPlugin({ marketplace: true }));
      prisma.plugin.update.mockResolvedValueOnce(makeReviewPlugin({ marketplace: false, reviewStatus: 'DRAFT' }));
      notifications.create.mockRejectedValueOnce(new Error('db down'));
      const result = await service.adminDelistPlugin('user-admin', 'p1');
      expect(result.plugin.marketplace).toBe(false);
    });
  });

  describe('adminPluginAuditHistory', () => {
    it('非平台管理员被拒绝（403）', async () => {
      auth.ensurePlatformAdmin.mockImplementation(() => {
        throw forbidden('仅平台管理员可操作');
      });
      await expect(service.adminPluginAuditHistory('user-member', 'p1')).rejects.toMatchObject({ status: 403, code: 'forbidden' });
      expect(prisma.pluginReview.findMany).not.toHaveBeenCalled();
    });

    it('插件不存在时抛 not_found', async () => {
      prisma.plugin.findUnique.mockResolvedValueOnce(null);
      await expect(service.adminPluginAuditHistory('user-admin', 'missing')).rejects.toMatchObject({ status: 404, code: 'not_found' });
    });

    it('返回 PluginReview 列表（reviewer 脱敏 + createdAt 转 ISO）', async () => {
      prisma.plugin.findUnique.mockResolvedValueOnce({ id: 'p1' });
      const now = new Date('2026-06-15T00:00:00.000Z');
      prisma.pluginReview.findMany.mockResolvedValueOnce([
        { id: 'rv1', status: 'APPROVED', reason: '', createdAt: now, reviewer: { id: 'u1', email: 'a@x.com', displayName: 'A', platformRole: 'PLATFORM_ADMIN', status: 'ACTIVE' } },
        { id: 'rv2', status: 'REJECTED', reason: '描述不符', createdAt: now, reviewer: null },
      ]);
      const result = await service.adminPluginAuditHistory('user-admin', 'p1');
      expect(result.reviews).toHaveLength(2);
      // reviewer 经 publicUser 脱敏：不携带 passwordHash/tokenVersion。
      expect(result.reviews[0].reviewer).toEqual({ id: 'u1', email: 'a@x.com', displayName: 'A', platformRole: 'PLATFORM_ADMIN', status: 'ACTIVE' });
      expect(result.reviews[0].reviewer).not.toHaveProperty('passwordHash');
      expect(result.reviews[1].reviewer).toBeNull();
      // createdAt 转 ISO 字符串。
      expect(result.reviews[0].createdAt).toBe('2026-06-15T00:00:00.000Z');
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
  const auditLog = { findMany: vi.fn(async () => [] as unknown[]) };
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

  it('无过滤参数时 where 为空对象（全量拉取）', async () => {
    await service.auditLogs('user-admin', {});
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {},
      orderBy: { createdAt: 'desc' },
      take: 200,
    }));
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

  it('category=system 无单一前缀，仅靠已注册 action 列表（含 admin.setting.* / platform_admin.bootstrap）', async () => {
    await service.auditLogs('user-admin', { category: 'system' });
    const call = prisma.auditLog.findMany.mock.calls[0][0] as { where: { OR?: unknown[] } };
    // system 分类无 startsWith（返回 null），仅有已注册 action 列表。
    expect(call.where.OR).toBeDefined();
    expect(call.where.OR).toHaveLength(1);
    // 列表中应含 platform_admin.bootstrap（显式归 system 的跨前缀 action）。
    const inClause = call.where.OR[0] as { action: { in: string[] } };
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
      include: { actor: { select: Record<string, boolean> } };
    };
    expect(call.include.actor.select).toEqual({
      id: true,
      email: true,
      displayName: true,
      platformRole: true,
      status: true,
    });
    expect(call.include.actor.select).not.toHaveProperty('passwordHash');
    expect(call.include.actor.select).not.toHaveProperty('tokenVersion');
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
  const auditLog = { findMany: vi.fn(async () => []), create: vi.fn() };
  const wallet = { findUnique: vi.fn(async () => null) };
  const teamMembership = { findMany: vi.fn(async () => []) };
  const walletTransaction = { findMany: vi.fn(async () => []) };
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

    it('聚合登录历史 + 钱包 + 团队 memberships（钱包不存在兜底 0）', async () => {
      const now = new Date('2026-06-15T00:00:00.000Z');
      prisma.user.findUnique.mockResolvedValueOnce({
        id: 'u1', email: 'a@x.com', displayName: 'A', status: 'ACTIVE', platformRole: 'NONE',
        createdAt: now, emailVerified: null, passwordHash: 'secret', tokenVersion: 1,
      });
      prisma.auditLog.findMany.mockResolvedValueOnce([
        { id: 'log1', action: 'auth.login.success', metadata: { email: 'a@x.com' }, createdAt: now },
      ]);
      prisma.wallet.findUnique.mockResolvedValueOnce(null); // 钱包不存在
      prisma.teamMembership.findMany.mockResolvedValueOnce([
        { teamId: 't1', role: 'MEMBER', status: 'ACTIVE', joinedAt: now, team: { id: 't1', name: '团队A', slug: 'team-a', status: 'ACTIVE', balanceCents: 1000 } },
      ]);
      prisma.walletTransaction.findMany.mockResolvedValueOnce([]);

      const result = await service.adminUserDetail('user-admin', 'u1');
      // user 经 publicUser 脱敏 + 补 createdAt/emailVerified。
      expect(result.user).toMatchObject({ id: 'u1', email: 'a@x.com', platformRole: 'NONE' });
      expect(result.user).not.toHaveProperty('passwordHash');
      expect(result.user).not.toHaveProperty('tokenVersion');
      // 钱包不存在时 balanceCents 兜底 0（非 null）。
      expect(result.wallet).toEqual({ balanceCents: 0 });
      expect(result.loginHistory).toHaveLength(1);
      // createdAt 转 ISO 字符串。
      expect(result.loginHistory[0].createdAt).toBe('2026-06-15T00:00:00.000Z');
      expect(result.teams[0]).toMatchObject({ teamId: 't1', role: 'MEMBER' });
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
      prisma.auditLog.findMany.mockResolvedValueOnce([]);
      await service.adminActivity('user-admin', 'admin-1');
      const call = prisma.auditLog.findMany.mock.calls[0][0] as {
        where: { actorUserId: string };
        include: { actor: { select: Record<string, boolean> } };
      };
      expect(call.where.actorUserId).toBe('admin-1');
      // actor select 白名单不含 passwordHash/tokenVersion。
      expect(call.include.actor.select).not.toHaveProperty('passwordHash');
      expect(call.include.actor.select).not.toHaveProperty('tokenVersion');
    });
  });
});


