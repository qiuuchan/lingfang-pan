import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AuthService } from './auth.service';

@Injectable()
export class AdminDashboardService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}
  async adminDashboard(userId: string) {
    await this.auth.ensurePlatformAdmin(userId);
    const [
      users,
      teams,
      pendingApplications,
      pendingPluginReviews,
      activePluginPackages,
      activeMarketplaceListings,
      delistedMarketplaceListings,
    ] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.team.count(),
      this.prisma.teamAdminApplication.count({ where: { status: 'PENDING' } }),
      this.prisma.pluginRelease.count({ where: { marketReviewStatus: 'PENDING' } }),
      this.prisma.pluginPackage.count({ where: { governanceStatus: 'ACTIVE' } }),
      this.prisma.marketplaceListing.count({ where: { status: 'ACTIVE' } }),
      this.prisma.marketplaceListing.count({ where: { status: 'DELISTED' } }),
    ]);
    return {
      users,
      teams,
      pendingApplications,
      pendingPluginReviews,
      activePluginPackages,
      activeMarketplaceListings,
      delistedMarketplaceListings,
    };
  }

  // 平台级 AI 生成质量看板（调研报告 Top10 / A4）。
  // 数据源：LlmCallLog（relay 每次 AI 调用都写一条，含 status/durationMs/credits，真实且准确）。
  //   - 调用次数：LlmCallLog 总数（无论成功失败，发生过即算一次调用）。
  //   - 成功次数：status = 'success'。
  //   - 失败次数：status in (upstream_error/client_error/no_channel/no_pricing/insufficient_balance)。
  //   - 平均耗时：avg(durationMs)（仅 success，失败请求耗时无质量参考意义）。
  //
  // 历史：首版基于 AuditLog 的 llm_binding.key_decrypted 统计（旧架构：桌面端发起生成会解密 LLM key）。
  // 但灵坊现已改为 relay + JWT 架构（relay.service.ts），AI 调用不再解密 llm_binding key，
  // 导致该审计日志不再产生、调用次数恒为旧值/0。改用 LlmCallLog 后数据准确反映真实调用量。
  async adminGenerationStats(userId: string) {
    await this.auth.ensurePlatformAdmin(userId);
    // 月度窗口：当前自然月起始 → 现在（取本月初便于运营观察近期质量趋势）。
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    // 失败状态集合（relay executeRelay 的所有非 success 终态）。
    const failStatuses = ['upstream_error', 'client_error', 'no_channel', 'no_pricing', 'insufficient_balance'];
    const [monthCalls, monthSuccess, monthFailed, monthDurationAgg, totalCalls, totalSuccess, totalFailed, totalDurationAgg] = await Promise.all([
      this.prisma.llmCallLog.count({ where: { createdAt: { gte: monthStart } } }),
      this.prisma.llmCallLog.count({ where: { status: 'success', createdAt: { gte: monthStart } } }),
      this.prisma.llmCallLog.count({ where: { status: { in: failStatuses }, createdAt: { gte: monthStart } } }),
      this.prisma.llmCallLog.aggregate({ where: { status: 'success', createdAt: { gte: monthStart } }, _avg: { durationMs: true } }),
      this.prisma.llmCallLog.count({}),
      this.prisma.llmCallLog.count({ where: { status: 'success' } }),
      this.prisma.llmCallLog.count({ where: { status: { in: failStatuses } } }),
      this.prisma.llmCallLog.aggregate({ where: { status: 'success' }, _avg: { durationMs: true } }),
    ]);
    const safeRate = (calls: number, success: number) => (calls > 0 ? Math.round((success / calls) * 1000) / 10 : 0);
    return {
      period: 'current_month',
      month: { calls: monthCalls, success: monthSuccess, failed: monthFailed, successRate: safeRate(monthCalls, monthSuccess) },
      total: { calls: totalCalls, success: totalSuccess, failed: totalFailed, successRate: safeRate(totalCalls, totalSuccess) },
      // 平均耗时：成功调用的 avg(durationMs)，null 时前端不渲染（Prisma 对无匹配行返回 null）。
      avgDurationMs: monthDurationAgg._avg.durationMs ?? null,
    };
  }

  // 平台级财务概览看板（调研报告 Top10 / C7）。
  // 全量基于现有 Purchase/MarketplaceListing 表聚合，不新建 PaymentOrder/PlatformFeePolicy 表：
  //   - GMV（月/累计）：sum(Purchase.priceCents)。平台抽成暂为 0（ADR-0002 明确放弃），platformRevenueCents 恒为 0。
  //   - 付费用户数：distinct Purchase.buyerUserId。
  //   - 付费转化率：付费用户 / 总用户（需 count User）。
  //   - Top5 热销插件：按 v4 MarketplaceListing.installCount 降序取前 5。
  async adminFinanceStats(userId: string) {
    await this.auth.ensurePlatformAdmin(userId);
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const [monthGmvAgg, totalGmvAgg, paidBuyers, totalUsers, topPluginsRaw] = await Promise.all([
      // Prisma aggregate _sum 对空表返回 null，用 ?? 0 兜底避免 NaN。
      this.prisma.purchase.aggregate({ where: { createdAt: { gte: monthStart } }, _sum: { priceCents: true } }),
      this.prisma.purchase.aggregate({ _sum: { priceCents: true } }),
      this.prisma.purchase.findMany({ select: { buyerUserId: true }, distinct: ['buyerUserId'] }),
      this.prisma.user.count(),
      this.prisma.marketplaceListing.findMany({
        where: { status: 'ACTIVE' },
        orderBy: [{ installCount: 'desc' }, { ratingCount: 'desc' }],
        take: 5,
        select: { packageId: true, installCount: true, ratingCount: true, ratingSum: true, priceCents: true, package: { select: { name: true } } },
      }),
    ]);
    const monthGmv = monthGmvAgg._sum.priceCents ?? 0;
    const totalGmv = totalGmvAgg._sum.priceCents ?? 0;
    const paidUserCount = paidBuyers.length;
    const conversionRate = totalUsers > 0 ? Math.round((paidUserCount / totalUsers) * 1000) / 10 : 0;
    const topPlugins = topPluginsRaw.map((p) => ({
      id: p.packageId,
      name: p.package.name,
      installCount: p.installCount,
      ratingCount: p.ratingCount,
      // 平均分：ratingCount>0 才计算，否则 0，避免除零 NaN。
      avgScore: p.ratingCount > 0 ? Math.round((p.ratingSum / p.ratingCount) * 10) / 10 : 0,
      priceCents: p.priceCents,
    }));
    return {
      period: 'current_month',
      month: { gmvCents: monthGmv },
      total: { gmvCents: totalGmv },
      // 平台抽成暂为 0（ADR-0002 放弃抽成现金流），保留字段为后续商业化预留。
      platformRevenueCents: 0,
      paidUserCount,
      totalUserCount: totalUsers,
      conversionRate,
      topPlugins,
    };
  }
}
