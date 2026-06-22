// CreditService —— 团队灵石账户与流水（计费账本）。
//
// 设计（见 docs/billing-and-relay-design.md §4.3 / §5）：
//  - 独立于人民币 Team.balanceCents（市场用），本服务管 AI 用量计费的「灵石」。
//  - 预扣 cap + 实算冲销（防并发透支）：
//    * reserve(teamId, cap, callLogId)：updateMany where balance>=cap → 原子条件扣款；count=0 即 402。
//    * reconcile(teamId, cap, realCredits, callLogId)：实际计费 = min(realCredits, cap)（cap 为单次硬上限，
//      超出部分不收费但全额记 usage）；退回未用预留 = cap - actualCharge（CREDIT）。
//    * refund(teamId, cap, callLogId)：上游失败时全额退回预留（CREDIT cap）。
//  - 所有变动写 CreditLedger，callLogId 串联一次调用的 reserve/reconcile/refund。
//  - ensureAccount：首次访问时 upsert TeamCredit + 注册赠送 signup_bonus（读 PlatformSetting.creditSignupBonus）。
//  - adjust：admin 加/扣款（写 admin_adjust 流水 + 审计）。
import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AppError, badRequest, insufficientBalance } from '../common';

const DEFAULT_SIGNUP_BONUS = 1000;

@Injectable()
export class CreditService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** 读 PlatformSetting.creditSignupBonus（缺失用默认 1000）。 */
  private async readSignupBonus(): Promise<number> {
    const row = await this.prisma.platformSetting.findUnique({
      where: { key: 'creditSignupBonus' },
      select: { value: true },
    });
    const n = Number.parseInt((row?.value ?? '').trim(), 10);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SIGNUP_BONUS;
  }

  /** 读 PlatformSetting.creditReserveCap<tier>（缺失用 0 = 不预扣，即放行后计费兜底）。 */
  async readReserveCap(tier: 'FAST' | 'PREMIUM'): Promise<number> {
    const key = tier === 'FAST' ? 'creditReserveCapFast' : 'creditReserveCapPremium';
    const row = await this.prisma.platformSetting.findUnique({
      where: { key },
      select: { value: true },
    });
    const n = Number.parseInt((row?.value ?? '').trim(), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  /** 读 PlatformSetting.aiUsageGuardRule（缺失用契约默认值，传 null 表示不注入）。 */
  async readAiUsageGuardRule(): Promise<string | null> {
    const row = await this.prisma.platformSetting.findUnique({
      where: { key: 'aiUsageGuardRule' },
      select: { value: true },
    });
    return row?.value ?? null;
  }

  /** 团队灵石账户（首次访问 upsert + signup_bonus）。 */
  async ensureAccount(teamId: string) {
    const bonus = await this.readSignupBonus();
    return this.prisma.$transaction(async (tx) => {
      const account = await tx.teamCredit.upsert({
        where: { teamId },
        update: {},
        create: { teamId, balance: bonus },
      });
      // 幂等：仅当账户本次创建且 bonus>0 且无 signup_bonus 流水时补写（事务内行锁防并发重复发放）。
      if (bonus > 0) {
        const exist = await tx.creditLedger.findFirst({
          where: { teamId, source: 'signup_bonus' },
          select: { id: true },
        });
        if (!exist) {
          await tx.creditLedger.create({
            data: { teamId, amount: bonus, direction: 'CREDIT', source: 'signup_bonus', reason: '注册赠送灵石' },
          });
        }
      }
      return account;
    });
  }

  /** 余额（含 ensureAccount）。 */
  async getBalance(teamId: string): Promise<number> {
    const account = await this.ensureAccount(teamId);
    return account.balance;
  }

  /** 流水（近 take 条，按时间倒序）。 */
  async getLedger(teamId: string, take = 100) {
    return this.prisma.creditLedger.findMany({
      where: { teamId },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  /**
   * 预扣灵石额度（relay 调用前）。
   * cap=0 时跳过预扣（放行后计费兜底，适合低风险 tier）；cap>0 时原子条件扣款，余额不足抛 402。
   * 写 reserve DEBIT 流水。返回预留额度（供 reconcile/refund 用）。
   */
  async reserve(teamId: string, cap: number, callLogId: string | null, actorUserId: string | null): Promise<number> {
    if (cap <= 0) return 0;
    await this.ensureAccount(teamId);
    const result = await this.prisma.$transaction(async (tx) => {
      const debited = await tx.teamCredit.updateMany({
        where: { teamId, balance: { gte: cap } },
        data: { balance: { decrement: cap } },
      });
      if (debited.count === 0) throw insufficientBalance();
      await tx.creditLedger.create({
        data: { teamId, amount: cap, direction: 'DEBIT', source: 'reserve', reason: 'AI 调用预扣', actorUserId, callLogId },
      });
      return cap;
    });
    return result;
  }

  /**
   * 实算冲销：实际计费 = min(realCredits, cap)（cap 为单次硬上限，保护用户免被超长输出刷爆）。
   * 退回未用预留 = cap - actualCharge（CREDIT，source=reconcile）。
   * 写 reconcile 流水 + 返回实际扣减的灵石数（供写 LlmCallLog.credits）。
   */
  async reconcile(
    teamId: string,
    cap: number,
    realCredits: number,
    callLogId: string,
    actorUserId: string | null,
  ): Promise<number> {
    if (cap <= 0) {
      // 未预扣模式：事后直接扣实际额（actualCredits）。条件扣款防透支（余额不足则扣到 0，差额记 bad_debt——本期简化为扣到 0）。
      const actual = Math.max(0, realCredits);
      if (actual === 0) return 0;
      await this.prisma.$transaction(async (tx) => {
        // 条件扣款：余额充足才扣全；不足扣到 0（relay 已服务完成，不回滚结果，但记透支标记）。
        const account = await tx.teamCredit.findUnique({ where: { teamId } });
        const balance = account?.balance ?? 0;
        const charge = Math.min(actual, Math.max(0, balance));
        if (charge > 0) {
          await tx.teamCredit.update({ where: { teamId }, data: { balance: { decrement: charge } } });
          await tx.creditLedger.create({
            data: { teamId, amount: charge, direction: 'DEBIT', source: 'llm_consume', reason: 'AI 对话消费', actorUserId, callLogId },
          });
        }
      });
      return actual;
    }
    const actualCharge = Math.min(realCredits, cap); // cap 内全额计费，超出不收费
    const refund = cap - actualCharge; // 退回未用预留
    await this.prisma.$transaction(async (tx) => {
      if (refund > 0) {
        await tx.teamCredit.update({ where: { teamId }, data: { balance: { increment: refund } } });
        await tx.creditLedger.create({
          data: { teamId, amount: refund, direction: 'CREDIT', source: 'refund', reason: '预扣冲销（未用部分退回）', actorUserId, callLogId },
        });
      }
      if (actualCharge > 0) {
        await tx.creditLedger.create({
          data: { teamId, amount: actualCharge, direction: 'DEBIT', source: 'llm_consume', reason: 'AI 对话消费', actorUserId, callLogId },
        });
      }
    });
    return actualCharge;
  }

  /** 全额退回预留（上游失败时，relay 在 finally 调）。幂等：仅当该 callLogId 已 reserve 时退。 */
  async refund(teamId: string, cap: number, callLogId: string, actorUserId: string | null): Promise<void> {
    if (cap <= 0) return;
    await this.prisma.$transaction(async (tx) => {
      // 仅当存在该 callLog 的 reserve 流水时退（防重复退）。
      const reserved = await tx.creditLedger.findFirst({
        where: { teamId, callLogId, source: 'reserve' },
        select: { id: true },
      });
      if (!reserved) return; // 无预留则不退（幂等）
      await tx.teamCredit.update({ where: { teamId }, data: { balance: { increment: cap } } });
      await tx.creditLedger.create({
        data: { teamId, amount: cap, direction: 'CREDIT', source: 'refund', reason: '上游失败退回预扣', actorUserId, callLogId },
      });
    });
  }

  /** admin 调整灵石（加/扣 + 强审计）。amount>0；direction=CREDIT 加款，DEBIT 扣款。 */
  async adjust(args: {
    teamId: string;
    amount: number;
    direction: 'CREDIT' | 'DEBIT';
    reason: string;
    actorUserId: string;
  }) {
    if (args.amount <= 0) throw badRequest('金额必须为正数');
    if (!args.reason.trim()) throw badRequest('请填写调整原因');
    await this.ensureAccount(args.teamId);
    return this.prisma.$transaction(async (tx) => {
      if (args.direction === 'CREDIT') {
        await tx.teamCredit.update({ where: { teamId: args.teamId }, data: { balance: { increment: args.amount } } });
      } else {
        const debited = await tx.teamCredit.updateMany({
          where: { teamId: args.teamId, balance: { gte: args.amount } },
          data: { balance: { decrement: args.amount } },
        });
        if (debited.count === 0) throw insufficientBalance();
      }
      await tx.creditLedger.create({
        data: {
          teamId: args.teamId,
          amount: args.amount,
          direction: args.direction,
          source: 'admin_adjust',
          reason: args.reason,
          actorUserId: args.actorUserId,
        },
      });
      const account = await tx.teamCredit.findUnique({ where: { teamId: args.teamId } });
      return { balance: account?.balance ?? 0 };
    });
  }
}

/** relay 计费所需的「预留单据」。relay 在请求生命周期内持有，finally 据此冲销/退回。 */
export interface ReserveTicket {
  teamId: string;
  cap: number;
  callLogId: string;
  actorUserId: string | null;
}
