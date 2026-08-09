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
import { badRequest, insufficientBalance } from '../common';

const DEFAULT_SIGNUP_BONUS = 100000; // 注册赠送灵石（整数分；1 灵石=100 分 → 1000 灵石）

// 灵石以整数分（1 灵石=100 分）存储与计算；本函数仅做整数兜底（消除浮点噪声 / -0）。
function roundCredits(value: number | null | undefined): number {
  const n = value ?? 0;
  if (!Number.isFinite(n)) return 0;
  const rounded = Math.round(n);
  return Object.is(rounded, -0) ? 0 : rounded;
}

@Injectable()
export class CreditService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** 读 PlatformSetting.creditSignupBonus（缺失去默认 100000 分 = 1000 灵石）。存储单位为整数分。 */
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
            data: {
              teamId,
              amount: bonus,
              direction: 'CREDIT',
              source: 'signup_bonus',
              reason: '注册赠送灵石',
            },
          });
        }
      }
      return account;
    });
  }

  /** 余额（含 ensureAccount）。 */
  async getBalance(teamId: string): Promise<number> {
    const account = await this.ensureAccount(teamId);
    return roundCredits(account.balance);
  }

  /** 流水（近 take 条，按时间倒序）。 */
  async getLedger(teamId: string, take = 100) {
    const rows = await this.prisma.creditLedger.findMany({
      where: { teamId },
      orderBy: { createdAt: 'desc' },
      take,
    });
    const callLogIds = Array.from(
      new Set(rows.map((row) => row.callLogId).filter((id): id is string => Boolean(id)))
    );
    if (!callLogIds.length)
      return rows.map((row) => ({ ...row, amount: roundCredits(row.amount) }));

    const logs = await this.prisma.llmCallLog.findMany({
      where: { teamId, id: { in: callLogIds } },
      select: { id: true, tier: true },
    });
    const tierByLogId = new Map(logs.map((log) => [log.id, log.tier]));
    return rows.map((row) => ({
      ...row,
      amount: roundCredits(row.amount),
      tier: row.callLogId ? (tierByLogId.get(row.callLogId) ?? null) : null,
    }));
  }

  /**
   * 预扣灵石额度（relay 调用前）。
   * cap=0 时跳过预扣（放行后计费兜底，适合低风险 tier）；cap>0 时原子条件扣款，余额不足抛 402。
   * 写 reserve DEBIT 流水。返回预留额度（供 reconcile/refund 用）。
   */
  async reserve(
    teamId: string,
    cap: number,
    callLogId: string | null,
    actorUserId: string | null
  ): Promise<number> {
    const reserveCap = roundCredits(cap);
    if (reserveCap <= 0) {
      // 事后计费模式（cap=0）：不预扣，放行后按实际用量扣。但须设最低门槛——
      // 余额已为 0 时直接拒绝（402），否则用户可刷到 0 后无限免费调用（reconcile 的 cap=0 分支
      // 会把 charge 算成 min(actual, max(0, balance))=0，等于不扣费）。此检查堵住该漏费路径。
      await this.ensureAccount(teamId);
      const balance = await this.getBalance(teamId);
      if (balance <= 0) throw insufficientBalance();
      return 0;
    }
    await this.ensureAccount(teamId);
    const result = await this.prisma.$transaction(async (tx) => {
      const debited = await tx.teamCredit.updateMany({
        where: { teamId, balance: { gte: reserveCap } },
        data: { balance: { decrement: reserveCap } },
      });
      if (debited.count === 0) throw insufficientBalance();
      await tx.creditLedger.create({
        data: {
          teamId,
          amount: reserveCap,
          direction: 'DEBIT',
          source: 'reserve',
          reason: 'AI 调用预扣',
          actorUserId,
          callLogId,
        },
      });
      return reserveCap;
    });
    return result;
  }

  /**
   * 实算冲销：实际计费 = min(realCredits, cap)（cap 为单次硬上限，保护用户免被超长输出刷爆）。
   *
   * 账本自洽模型（每行流水都对应一次 balance 变动，流水求和 == 余额变动）：
   *  - reserve 已 DEBIT(cap)  [balance -= cap]
   *  - reconcile：CREDIT(cap) 退回全部预扣  [balance += cap]
   *               + DEBIT(actualCharge, llm_consume) 实扣  [balance -= actualCharge]
   *  - 净效果：-cap + cap - actualCharge = -actualCharge ✓
   * 返回实际扣减的灵石数（供写 LlmCallLog.credits）。
   */
  async reconcile(
    teamId: string,
    cap: number,
    realCredits: number,
    callLogId: string,
    actorUserId: string | null
  ): Promise<number> {
    // 确保团队灵石账户存在（cap<=0 事后计费路径下，reserve 不建账户，此处补建以扣除余额）。
    await this.ensureAccount(teamId);
    const reserveCap = roundCredits(cap);
    const actualCredits = Math.max(0, roundCredits(realCredits));
    if (reserveCap <= 0) {
      // 未预扣模式：事后直接扣实际额。事务 + 行锁防并发竞态（check-then-update）：
      // 此前 findUnique→计算→update 在并发下可能都读到同一 balance，导致多线程合计扣减超过实际。
      // 现在同一事务内 SELECT ... FOR UPDATE 锁住 TeamCredit 行，串行化同一账户的扣减。
      const actual = actualCredits;
      if (actual === 0) return 0;
      return this.prisma.$transaction(async (tx) => {
        // 原生 SELECT ... FOR UPDATE 行锁（Prisma 的 findMany 不会加锁，普通 findUnique→update
        // 在并发下会 read-then-write 竞态：多请求同时读到旧余额、各自扣减，合计超扣）。
        const [row] = await tx.$queryRaw<{ balance: number | null }[]>`
          SELECT "balance" FROM "TeamCredit" WHERE "teamId" = ${teamId} FOR UPDATE
        `;
        const balance = roundCredits(row?.balance ?? 0);
        const charge = roundCredits(Math.min(actual, Math.max(0, balance)));
        if (charge > 0) {
          await tx.teamCredit.update({
            where: { teamId },
            data: { balance: { decrement: charge } },
          });
          await tx.creditLedger.create({
            data: {
              teamId,
              amount: charge,
              direction: 'DEBIT',
              source: 'llm_consume',
              reason: 'AI 对话消费',
              actorUserId,
              callLogId,
            },
          });
        }
        return charge;
      });
    }
    const actualCharge = roundCredits(Math.min(actualCredits, reserveCap)); // cap 内全额计费，超出不收费（用户保护）
    await this.prisma.$transaction(async (tx) => {
      // 1) 退回全部预扣（与 reserve 的 DEBIT(cap) 对冲，balance 回到调用前）。
      await tx.teamCredit.update({
        where: { teamId },
        data: { balance: { increment: reserveCap } },
      });
      await tx.creditLedger.create({
        data: {
          teamId,
          amount: reserveCap,
          direction: 'CREDIT',
          source: 'refund',
          reason: '预扣退回',
          actorUserId,
          callLogId,
        },
      });
      // 2) 实扣实际消费额（balance 真正减少 actualCharge）。
      if (actualCharge > 0) {
        await tx.teamCredit.update({
          where: { teamId },
          data: { balance: { decrement: actualCharge } },
        });
        await tx.creditLedger.create({
          data: {
            teamId,
            amount: actualCharge,
            direction: 'DEBIT',
            source: 'llm_consume',
            reason: 'AI 对话消费',
            actorUserId,
            callLogId,
          },
        });
      }
    });
    return actualCharge;
  }

  /**
   * 全额退回预留（上游失败时，relay 在失败路径调）。
   *
   * 真正幂等（R3-1）：只有「存在该 callLogId 的 reserve 流水」**且**「尚无终结流水
   * （refund / llm_consume）」时才退。这样即使调用链未来出现「reconcile 后又 refund」
   * 或「refund 被调两次」，余额也不会被错误加回（防"成功却被退款 → 平台漏计费"）。
   * 此前仅检查「有 reserve 流水」，幂等性靠调用方纪律维持（脆弱），现收敛为流水状态机判定。
   */
  async refund(
    teamId: string,
    cap: number,
    callLogId: string,
    actorUserId: string | null
  ): Promise<void> {
    const reserveCap = roundCredits(cap);
    if (reserveCap <= 0) return;
    await this.prisma.$transaction(async (tx) => {
      // 1) 必须曾预扣（无 reserve 流水说明没扣过钱，无需退）。
      const reserved = await tx.creditLedger.findFirst({
        where: { teamId, callLogId, source: 'reserve' },
        select: { id: true },
      });
      if (!reserved) return; // 无预留则不退（幂等）
      // 2) 必须未终结（已 refund 退过 或 已 llm_consume 实扣，则本次为重复调用，不再退）。
      const settled = await tx.creditLedger.findFirst({
        where: { teamId, callLogId, source: { in: ['refund', 'llm_consume'] } },
        select: { id: true },
      });
      if (settled) return; // 已终结，幂等 no-op
      await tx.teamCredit.update({
        where: { teamId },
        data: { balance: { increment: reserveCap } },
      });
      await tx.creditLedger.create({
        data: {
          teamId,
          amount: reserveCap,
          direction: 'CREDIT',
          source: 'refund',
          reason: '上游失败退回预扣',
          actorUserId,
          callLogId,
        },
      });
    });
  }

  /**
   * 退还已实扣的灵石（视频生成等「先 reconcile 实扣、后转发失败」场景专用）。
   *
   * 与 refund 的区别：
   *  - refund：退 reserve 的预留（在 reconcile 之前调用；针对未实扣的 cap）。
   *  - refundConsumed：退 reconcile 已实扣的消费（针对已扣到 llm_consume 的额度）。
   *
   * 视频计费链路：reserve(cap) → reconcile(cap, real) 实扣 → 桥转发 RBFLow。
   * 若转发失败，此时钱已从 llm_consume 扣走（refund 因 source=llm_consume 已「终结」而 no-op），
   * 必须走本方法：找到该 callLogId 的 llm_consume 流水，按其 amount 退回（CREDIT）+ 写 source='video_refund'
   * 标记，保证幂等（同一 callLogId 只退一次，重复调用 no-op）。
   *
   * @returns 实际退还的灵石数（已退过则返回 0）。
   */
  async refundConsumed(
    teamId: string,
    callLogId: string,
    actorUserId: string | null,
    reason = '视频生成转发失败退款'
  ): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      // 幂等：已退过（source='video_refund'）则 no-op。
      const alreadyRefunded = await tx.creditLedger.findFirst({
        where: { teamId, callLogId, source: 'video_refund' },
        select: { id: true },
      });
      if (alreadyRefunded) return 0;
      // 找到本次实扣的 llm_consume 流水（reconcile 写的 DEBIT）。
      const consumed = await tx.creditLedger.findFirst({
        where: { teamId, callLogId, source: 'llm_consume', direction: 'DEBIT' },
        select: { id: true, amount: true },
      });
      if (!consumed || roundCredits(consumed.amount) <= 0) return 0;
      const refundAmount = roundCredits(consumed.amount);
      await tx.teamCredit.update({
        where: { teamId },
        data: { balance: { increment: refundAmount } },
      });
      await tx.creditLedger.create({
        data: {
          teamId,
          amount: refundAmount,
          direction: 'CREDIT',
          source: 'video_refund',
          reason,
          actorUserId,
          callLogId,
        },
      });
      return refundAmount;
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
    const amount = roundCredits(args.amount);
    if (amount <= 0) throw badRequest('金额必须为正数');
    if (!args.reason.trim()) throw badRequest('请填写调整原因');
    await this.ensureAccount(args.teamId);
    return this.prisma.$transaction(async (tx) => {
      if (args.direction === 'CREDIT') {
        await tx.teamCredit.update({
          where: { teamId: args.teamId },
          data: { balance: { increment: amount } },
        });
      } else {
        const debited = await tx.teamCredit.updateMany({
          where: { teamId: args.teamId, balance: { gte: amount } },
          data: { balance: { decrement: amount } },
        });
        if (debited.count === 0) throw insufficientBalance();
      }
      await tx.creditLedger.create({
        data: {
          teamId: args.teamId,
          amount,
          direction: args.direction,
          source: 'admin_adjust',
          reason: args.reason,
          actorUserId: args.actorUserId,
        },
      });
      const account = await tx.teamCredit.findUnique({ where: { teamId: args.teamId } });
      return { balance: roundCredits(account?.balance ?? 0) };
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
