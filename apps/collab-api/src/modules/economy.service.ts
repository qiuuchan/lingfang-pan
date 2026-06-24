import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AuthService } from './auth.service';
import { badRequest, insufficientBalance, notFound } from '../common';
import { NotificationService } from './notification.service';

@Injectable()
export class EconomyService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(NotificationService) private readonly notifications: NotificationService,
  ) {}

  /**
   * 购买市场付费插件（R2：余额改团队共享，废弃个人钱包）。
   *
   * 资金口径（design §4，用户已拍板）：
   *  - 买家扣款：从买家当前/主团队的 `Team.balanceCents` 原子条件扣款（防透支），写 BalanceLedger(DEBIT, plugin_purchase)。
   *  - 卖家加款：进卖家当前/主团队的 `Team.balanceCents`，写 BalanceLedger(CREDIT, plugin_sale)。
   *  - 个人 Wallet 已退役：不再读写 wallet/walletTransaction，不再发注册赠送。
   *  - 幂等：已购买直接返回买家团队余额。
   */
  async purchase(userId: string, pluginId: string) {
    const plugin = await this.prisma.plugin.findFirst({
      where: { id: pluginId, marketplace: true, reviewStatus: 'APPROVED', status: 'ENABLED' },
    });
    if (!plugin) throw notFound('插件不存在或未上架');
    if (plugin.priceCents <= 0) throw badRequest('免费插件无需购买，可直接安装');

    const sellerId = plugin.authorUserId;
    if (!sellerId) throw badRequest('插件无作者信息，无法结算');
    if (sellerId === userId) throw badRequest('不能购买自己的插件');

    // 买家当前/主团队（扣款账户）。
    const buyerMembership = await this.auth.ensureCurrentTeam(userId);
    const buyerTeamId = buyerMembership.teamId;

    // 幂等：已购买直接返回买家团队余额。
    const already = await this.prisma.purchase.findUnique({
      where: { pluginId_buyerUserId: { pluginId, buyerUserId: userId } },
    });
    if (already) {
      const team = await this.prisma.team.findUniqueOrThrow({ where: { id: buyerTeamId }, select: { balanceCents: true } });
      return { status: 'already_purchased' as const, balance_cents: team.balanceCents };
    }

    // 卖家当前/主团队（收益账户）。卖家未入团则无法结算收益（与买家同口径，防资金丢失）。
    const sellerMembership = await this.auth.ensureCurrentTeam(sellerId);
    const sellerTeamId = sellerMembership.teamId;

    const price = plugin.priceCents;

    await this.prisma.$transaction(async (tx) => {
      // 买家条件扣款：余额不足则受影响行数为 0（原子防透支，与 team.service.consume 同模式）。
      const debited = await tx.team.updateMany({
        where: { id: buyerTeamId, balanceCents: { gte: price } },
        data: { balanceCents: { decrement: price } },
      });
      if (debited.count === 0) throw insufficientBalance();

      // 卖家加款（进卖家团队余额池）。
      await tx.team.update({
        where: { id: sellerTeamId },
        data: { balanceCents: { increment: price } },
      });

      await tx.purchase.create({
        data: {
          pluginId,
          buyerUserId: userId,
          buyerTeamId,
          sellerUserId: sellerId,
          priceCents: price,
        },
      });

      // 团队余额流水：买家 DEBIT(plugin_purchase) / 卖家 CREDIT(plugin_sale)。
      // reason 为 String 列，用裸值（pluginId 已在 Purchase 表与下方审计 metadata，无需塞进 reason，前端按裸值显示中文标签）。
      await tx.balanceLedger.create({
        data: { teamId: buyerTeamId, amountCents: price, direction: 'DEBIT', reason: 'plugin_purchase', actorUserId: userId },
      });
      await tx.balanceLedger.create({
        data: { teamId: sellerTeamId, amountCents: price, direction: 'CREDIT', reason: 'plugin_sale', actorUserId: sellerId },
      });

      // 购买审计入事务（对齐 team.service.consume 的 H4：保证余额变更必有审计，原子提交，杜绝「有流水无审计」破窗）。
      await tx.auditLog.create({
        data: {
          actorUserId: userId,
          action: 'wallet.purchase',
          targetType: 'Plugin',
          targetId: pluginId,
          metadata: { buyerTeamId, sellerUserId: sellerId, sellerTeamId, priceCents: price } as object,
        },
      });
    });

    const team = await this.prisma.team.findUniqueOrThrow({ where: { id: buyerTeamId }, select: { balanceCents: true } });
    // 通知卖家：插件售出，收入到账（触发失败不阻塞主操作）。
    try {
      await this.notifications.create(
        sellerId,
        'purchase_sale',
        '你的插件有新订单',
        `你的插件「${plugin.name}」已被购买，¥${(price / 100).toFixed(2)} 已到账团队余额。`,
        { relatedType: 'Plugin', relatedId: pluginId },
      );
    } catch {
      // 通知触发失败不阻塞购买主流程。
    }
    return { status: 'purchased' as const, plugin_id: pluginId, price_cents: price, balance_cents: team.balanceCents };
  }
}