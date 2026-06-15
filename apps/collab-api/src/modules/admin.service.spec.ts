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

describe('AdminService stats', () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let auth: ReturnType<typeof mockAuth>;
  let service: AdminService;

  beforeEach(() => {
    prisma = mockPrisma();
    auth = mockAuth();
    // @ts-expect-error mock 不实现完整 PrismaService 接口，仅测用到的方法。
    service = new AdminService(prisma, auth);
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
