import { Inject, Injectable, forwardRef } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AuthService } from './auth.service';
import { badRequest, notFound, AppError } from '../common';

@Injectable()
export class MarketplaceService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => AuthService)) private readonly auth: AuthService,
  ) {}

  async search(userId: string, q: string, sort: string) {
    const keyword = (q || '').trim();
    const where = {
      marketplace: true,
      reviewStatus: 'APPROVED' as const,
      status: 'ENABLED' as const,
      ...(keyword
        ? { OR: [{ name: { contains: keyword, mode: 'insensitive' as const } }, { description: { contains: keyword, mode: 'insensitive' as const } }] }
        : {}),
    };
    const orderBy =
      sort === 'rating'
        ? [{ ratingSum: 'desc' as const }, { ratingCount: 'desc' as const }]
        : sort === 'recent'
          ? [{ createdAt: 'desc' as const }]
          : [{ installCount: 'desc' as const }];

    const plugins = await this.prisma.plugin.findMany({ where, orderBy, take: 50 });

    return {
      plugins: plugins.map((p) => ({
        id: p.id,
        name: p.name,
        version: p.version,
        description: p.description,
        install_count: p.installCount,
        price_cents: p.priceCents,
        is_free: p.priceCents === 0,
        avg_score: p.ratingCount > 0 ? Math.round((p.ratingSum / p.ratingCount) * 10) / 10 : 0,
        rating_count: p.ratingCount,
      })),
    };
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

    await this.prisma.$transaction([
      this.prisma.pluginInstallation.upsert({
        where: { pluginId_teamId: { pluginId, teamId: membership.teamId } },
        update: { version: plugin.version, status: 'ENABLED', installedById: userId },
        create: { pluginId, teamId: membership.teamId, version: plugin.version, installedById: userId, status: 'ENABLED' },
      }),
      this.prisma.plugin.update({ where: { id: pluginId }, data: { installCount: { increment: 1 } } }),
    ]);

    return { plugin_id: pluginId, version: plugin.version, status: 'installed' };
  }

  async rate(userId: string, pluginId: string, score: number, comment: string) {
    if (!(score >= 1 && score <= 5)) throw badRequest('评分须为 1-5');
    const plugin = await this.prisma.plugin.findFirst({ where: { id: pluginId, marketplace: true } });
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

    // upsert 评分 + 维护 plugin 聚合（ratingSum/ratingCount）。
    const existing = await this.prisma.pluginRating.findUnique({ where: { pluginId_userId: { pluginId, userId } } });
    await this.prisma.$transaction([
      this.prisma.pluginRating.upsert({
        where: { pluginId_userId: { pluginId, userId } },
        update: { score, comment },
        create: { pluginId, userId, teamId: membership.teamId, score, comment },
      }),
      this.prisma.plugin.update({
        where: { id: pluginId },
        data: {
          ratingSum: { increment: existing ? score - existing.score : score },
          ratingCount: { increment: existing ? 0 : 1 },
        },
      }),
    ]);

    return { ok: true };
  }
}