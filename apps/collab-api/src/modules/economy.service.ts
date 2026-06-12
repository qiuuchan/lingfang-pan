import { Inject, Injectable, forwardRef } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AuthService } from './auth.service';
import { badRequest, insufficientBalance, notFound } from '../common';

const SIGNUP_BONUS_CENTS = 1000;

@Injectable()
export class EconomyService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => AuthService)) private readonly auth: AuthService,
  ) {}

  // 注册赠送 ¥10（1000 分）：首次访问钱包时 upsert，不改 auth.service 的注册流程。
  async ensureWallet(userId: string) {
    return this.prisma.wallet.upsert({
      where: { userId },
      update: {},
      create: { userId, balanceCents: SIGNUP_BONUS_CENTS },
    });
  }

  async getWallet(userId: string) {
    const wallet = await this.ensureWallet(userId);
    const txs = await this.prisma.walletTransaction.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return {
      balance_cents: wallet.balanceCents,
      transactions: txs.map((t) => ({
        id: t.id,
        amount_cents: t.amountCents,
        direction: t.direction.toLowerCase(),
        reason: t.reason,
        plugin_id: t.pluginId,
        at: t.createdAt.toISOString(),
      })),
    };
  }

  async purchase(userId: string, pluginId: string) {
    const plugin = await this.prisma.plugin.findFirst({
      where: { id: pluginId, marketplace: true, reviewStatus: 'APPROVED', status: 'ENABLED' },
    });
    if (!plugin) throw notFound('插件不存在或未上架');
    if (plugin.priceCents <= 0) throw badRequest('免费插件无需购买，可直接安装');

    const sellerId = plugin.authorUserId;
    if (!sellerId) throw badRequest('插件无作者信息，无法结算');
    if (sellerId === userId) throw badRequest('不能购买自己的插件');

    const membership = await this.auth.ensureCurrentTeam(userId);

    // 幂等：已购买直接返回。
    const already = await this.prisma.purchase.findUnique({
      where: { pluginId_buyerUserId: { pluginId, buyerUserId: userId } },
    });
    if (already) {
      const wallet = await this.ensureWallet(userId);
      return { status: 'already_purchased' as const, balance_cents: wallet.balanceCents };
    }

    const price = plugin.priceCents;

    await this.prisma.$transaction(async (tx) => {
      // 条件扣款：余额不足则受影响行数为 0。
      const debited = await tx.wallet.updateMany({
        where: { userId, balanceCents: { gte: price } },
        data: { balanceCents: { decrement: price } },
      });
      if (debited.count === 0) throw insufficientBalance();

      // 卖家加款（upsert 兜底缺失钱包行）。
      await tx.wallet.upsert({
        where: { userId: sellerId },
        update: { balanceCents: { increment: price } },
        create: { userId: sellerId, balanceCents: price },
      });

      await tx.purchase.create({
        data: {
          pluginId,
          buyerUserId: userId,
          buyerTeamId: membership.teamId,
          sellerUserId: sellerId,
          priceCents: price,
        },
      });

      await tx.walletTransaction.create({
        data: { userId, amountCents: price, direction: 'DEBIT', reason: 'purchase', pluginId, counterpartyUserId: sellerId },
      });
      await tx.walletTransaction.create({
        data: { userId: sellerId, amountCents: price, direction: 'CREDIT', reason: 'sale', pluginId, counterpartyUserId: userId },
      });
    });

    const wallet = await this.ensureWallet(userId);
    return { status: 'purchased' as const, plugin_id: pluginId, price_cents: price, balance_cents: wallet.balanceCents };
  }
}