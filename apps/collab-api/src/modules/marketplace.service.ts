import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AuthService } from './auth.service';
import { badRequest, notFound, AppError } from '../common';

@Injectable()
export class MarketplaceService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  async search(userId: string, q: string, sort: string) {
    void userId;
    const keyword = (q || '').trim();
    const where = {
      marketplace: true,
      reviewStatus: 'APPROVED' as const,
      status: 'ENABLED' as const,
      ...(keyword
        ? { OR: [{ name: { contains: keyword, mode: 'insensitive' as const } }, { description: { contains: keyword, mode: 'insensitive' as const } }] }
        : {}),
    };
    // 修复 MKT-04：sort=rating 此前按 ratingSum 排序，与 avg_score 语义冲突
    // （100 条均 4.9 排在 1 条 5.0 之前）。改为按平均分（ratingSum/ratingCount）排序。
    // Postgres 无法直接对除法表达式 orderBy，取较多候选后应用层按 avg 排序。
    const take = sort === 'rating' ? 200 : 50;
    const orderBy =
      sort === 'recent'
        ? [{ createdAt: 'desc' as const }]
        : [{ installCount: 'desc' as const }];
    const plugins = await this.prisma.plugin.findMany({ where, orderBy, take });

    const mapped = plugins.map((p) => ({
      id: p.id,
      name: p.name,
      version: p.version,
      description: p.description,
      install_count: p.installCount,
      price_cents: p.priceCents,
      is_free: p.priceCents === 0,
      avg_score: p.ratingCount > 0 ? Math.round((p.ratingSum / p.ratingCount) * 10) / 10 : 0,
      rating_count: p.ratingCount,
    }));
    if (sort === 'rating') {
      mapped.sort((a, b) => b.avg_score - a.avg_score || b.rating_count - a.rating_count);
    }
    return { plugins: mapped.slice(0, 50) };
  }

  async detail(userId: string, pluginId: string) {
    const plugin = await this.prisma.plugin.findFirst({
      where: { id: pluginId, marketplace: true, reviewStatus: 'APPROVED', status: 'ENABLED' },
      include: { ratings: { orderBy: { createdAt: 'desc' }, take: 50 } },
    });
    if (!plugin) throw notFound('插件不存在或未上架');

    const membership = await this.auth.ensureCurrentTeam(userId);

    const purchased =
      plugin.priceCents === 0
        ? true
        : (await this.prisma.purchase.count({ where: { pluginId, buyerUserId: userId } })) > 0;

    const installed =
      (await this.prisma.pluginInstallation.count({
        where: { pluginId, teamId: membership.teamId, status: 'ENABLED' },
      })) > 0;

    const canRate = plugin.priceCents > 0 ? purchased : installed;
    const avg = plugin.ratingCount > 0 ? Math.round((plugin.ratingSum / plugin.ratingCount) * 10) / 10 : 0;

    return {
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      description: plugin.description,
      install_count: plugin.installCount,
      price_cents: plugin.priceCents,
      is_free: plugin.priceCents === 0,
      purchased,
      installed,
      can_rate: canRate,
      capabilities: plugin.capabilities,
      avg_score: avg,
      reviews: plugin.ratings.map((r) => ({ score: r.score, comment: r.comment, at: r.createdAt.toISOString() })),
    };
  }

  async install(userId: string, pluginId: string) {
    const plugin = await this.prisma.plugin.findFirst({
      where: { id: pluginId, marketplace: true, reviewStatus: 'APPROVED', status: 'ENABLED' },
    });
    if (!plugin) throw notFound('插件不存在或未上架');

    const membership = await this.auth.ensureCurrentTeam(userId);

    if (plugin.priceCents > 0) {
      const bought = await this.prisma.purchase.count({ where: { pluginId, buyerUserId: userId } });
      if (bought === 0) throw new AppError(402, 'payment_required', '该插件为付费插件，请先购买');
    }

    // 修复 PLUGIN-02 / MKT-05 / PLUGIN-03 / SCHEMA-06（installCount 重复自增）：
    // 此前用 upsert + 无条件 increment，重复安装/重装都会 +1，计数虚高且可刷量。
    // 改为先判断是否已存在安装记录，仅首次安装才 increment（与 plugin.service.installMarketplacePlugin 一致）。
    const existing = await this.prisma.pluginInstallation.findUnique({
      where: { pluginId_teamId: { pluginId, teamId: membership.teamId } },
    });
    if (existing) {
      // 已安装：仅刷新版本与状态，不重复计数。
      await this.prisma.pluginInstallation.update({
        where: { id: existing.id },
        data: { version: plugin.version, status: 'ENABLED', installedById: userId },
      });
      // 市场安装审计（重装分支）：记录刷新版本事件，与首次安装 action 区分（同一 action 不同 metadata.reason）。
      await this.audit(userId, 'marketplace.plugin.installed', 'Plugin', pluginId, { teamId: membership.teamId, reason: 'reinstall' });
      return { plugin_id: pluginId, version: plugin.version, status: 'already_installed' as const };
    }
    await this.prisma.$transaction([
      this.prisma.pluginInstallation.create({
        data: { pluginId, teamId: membership.teamId, version: plugin.version, installedById: userId, status: 'ENABLED' },
      }),
      this.prisma.plugin.update({ where: { id: pluginId }, data: { installCount: { increment: 1 } } }),
    ]);
    // 市场安装审计（首次安装）：此前 marketplace install 完全缺失审计，现补齐。
    await this.audit(userId, 'marketplace.plugin.installed', 'Plugin', pluginId, { teamId: membership.teamId, reason: 'install' });

    return { plugin_id: pluginId, version: plugin.version, status: 'installed' as const };
  }

  async rate(userId: string, pluginId: string, score: number, comment: string) {
    // score 的 1-5 整数校验已下沉到 MarketplaceRateDto（@IsInt @Min(1) @Max(5)），
    // 此前重复的手动校验移除以保持单一来源。
    const plugin = await this.prisma.plugin.findFirst({
      // 修复 MKT-03：与 search/detail/install 一致，要求 APPROVED+ENABLED，避免对 PENDING/DISABLED 评分。
      where: { id: pluginId, marketplace: true, reviewStatus: 'APPROVED', status: 'ENABLED', visibility: 'PUBLIC' },
    });
    if (!plugin) throw notFound('插件不存在或未上架');

    const membership = await this.auth.ensureCurrentTeam(userId);

    // 消费校验：付费看购买、免费看本团队安装。
    const consumed =
      plugin.priceCents > 0
        ? (await this.prisma.purchase.count({ where: { pluginId, buyerUserId: userId } })) > 0
        : (await this.prisma.pluginInstallation.count({
            where: { pluginId, teamId: membership.teamId, status: 'ENABLED' },
          })) > 0;
    if (!consumed) {
      throw badRequest(plugin.priceCents > 0 ? '请先购买该插件后再评分' : '请先安装该插件后再评分');
    }

    // 修复 MKT-02 / XCONC-02（评分聚合 TOCTOU 丢失更新）：
    // 此前 existing 在事务外读取，并发改分各自用陈旧 existing.score 算 delta 导致 ratingSum 多加。
    // 改用回调式事务：在事务内 findUnique 评分行（行锁串行化），据事务内 fresh 值算 delta，
    // 同一事务内完成 upsert + plugin 聚合更新，消除 check-then-act 窗口。
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.pluginRating.findUnique({ where: { pluginId_userId: { pluginId, userId } } });
      await tx.pluginRating.upsert({
        where: { pluginId_userId: { pluginId, userId } },
        update: { score, comment },
        create: { pluginId, userId, teamId: membership.teamId, score, comment },
      });
      await tx.plugin.update({
        where: { id: pluginId },
        data: {
          ratingSum: { increment: existing ? score - existing.score : score },
          ratingCount: { increment: existing ? 0 : 1 },
        },
      });
    });
    // 市场评分审计：记录用户对插件的评分行为（首次评分/改分均记），metadata 含 score 便于追溯。
    await this.audit(userId, 'plugin.marketplace.rated', 'Plugin', pluginId, { teamId: membership.teamId, score });

    return { ok: true };
  }

  private async audit(actorUserId: string, action: string, targetType: string, targetId?: string, metadata?: unknown) {
    await this.prisma.auditLog.create({ data: { actorUserId, action, targetType, targetId, metadata: metadata as object } });
  }
}