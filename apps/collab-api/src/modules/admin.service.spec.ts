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

