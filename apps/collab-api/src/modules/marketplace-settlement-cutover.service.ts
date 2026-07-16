import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { AppError, conflict } from '../common';
import { PrismaService } from '../prisma.service';
import { MarketplaceCommerceService } from './marketplace-commerce.service';

/**
 * Cutover/backfill is deliberately separate from the purchase service.  It is
 * the only component allowed to move the commerce writer state and it never
 * mutates Team.balanceCents or creates a BalanceLedger row while backfilling.
 */
export type MarketplaceBackfillReport = {
  dry_run: boolean;
  scanned: number;
  mutated: number;
  gross_cents: number;
  unresolved_seller: number;
  unresolved_release: number;
  entitlement_mismatch: number;
  null_or_invalid_orders: number;
  balance_writes: number;
  ledger_writes: number;
  ledger_snapshot: { count: number; debit_cents: number; credit_cents: number; digest: string };
};

export type MarketplaceReconciliationReport = {
  ok: boolean;
  settlement_version: 'LEGACY_V1' | 'SETTLEMENT_V2' | 'MIXED';
  purchase_count: number;
  gross_cents: number;
  pending_cents: number;
  refund_requested_cents: number;
  settled_cents: number;
  refunded_cents: number;
  clearing_expected_cents: number;
  clearing_actual_cents: number | null;
  revenue_expected_cents: number;
  revenue_actual_cents: number | null;
  invalid_orders: string[];
  ledger_violations: string[];
  entitlement_violations: string[];
  unresolved_seller: number;
  unresolved_release: number;
  reason_codes: string[];
};

const CLEARING_ACCOUNT_ID = 'marketplace-clearing';
const REVENUE_ACCOUNT_ID = 'marketplace-revenue';

type AnyClient = Record<string, any>;

@Injectable()
export class MarketplaceSettlementCutoverService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private started = false;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(MarketplaceCommerceService) private readonly commerce: MarketplaceCommerceService,
  ) {}

  /** Startup catch-up is durable and unref'd; tests and one-shot workers can call
   * runSettlementJob directly without relying on an in-memory timer. */
  async onModuleInit() {
    if (process.env.MARKETPLACE_SETTLEMENT_AUTORUN === 'false') return;
    this.started = true;
    void this.runSettlementJob(new Date()).catch(() => undefined);
    this.timer = setInterval(() => { void this.runSettlementJob(new Date()).catch(() => undefined); }, 60_000);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.started = false;
  }

  isStarted() { return this.started; }

  async state() {
    return this.prisma.marketplaceCommerceState.findUnique({ where: { id: 'singleton' } });
  }

  /** Fence a writer at its transaction boundary. PAUSED never falls through to LEGACY. */
  async assertWriterFence(expectedGeneration: number, allowedModes: Array<'SETTLEMENT_V2' | 'PAUSED'> = ['SETTLEMENT_V2']) {
    const row = await this.prisma.marketplaceCommerceState.findUnique({ where: { id: 'singleton' } });
    if (!row || row.writerGeneration !== expectedGeneration || !allowedModes.includes(row.writerMode as 'SETTLEMENT_V2' | 'PAUSED')) {
      throw new AppError(503, 'marketplace_commerce_paused', '市场结算 writer fence 已变化');
    }
    return row;
  }

  async beginDraining(expectedGeneration: number) {
    const changed = await this.prisma.marketplaceCommerceState.updateMany({
      where: { id: 'singleton', writerMode: 'LEGACY', writerGeneration: expectedGeneration },
      data: { writerMode: 'DRAINING' },
    });
    if (changed.count !== 1) throw new AppError(409, 'marketplace_cutover_state_conflict', '市场结算不能进入排空状态');
    return this.state();
  }

  /**
   * Final gate: repeat idempotent backfill, run read-only reconciliation, then
   * CAS DRAINING -> V2.  The activation instant is immutable and generation is
   * incremented in the same write that opens the new writer.
   */
  async activate(expectedGeneration: number, now = new Date()) {
    const row = await this.state();
    if (!row || row.writerMode !== 'DRAINING' || row.writerGeneration !== expectedGeneration) {
      throw new AppError(409, 'marketplace_cutover_state_conflict', '市场结算不在排空状态');
    }
    const backfill = await this.backfillLegacy({ dryRun: false });
    const reconciliation = await this.reconcile({ preCutover: true });
    if (!reconciliation.ok) {
      throw new AppError(409, 'marketplace_cutover_reconciliation_failed', '市场结算对账未通过，不能激活');
    }
    const activated = await this.prisma.marketplaceCommerceState.updateMany({
      where: { id: 'singleton', writerMode: 'DRAINING', writerGeneration: expectedGeneration },
      data: { writerMode: 'SETTLEMENT_V2', writerGeneration: { increment: 1 }, settlementV2ActivatedAt: row.settlementV2ActivatedAt ?? now },
    });
    if (activated.count !== 1) throw new AppError(409, 'marketplace_cutover_state_conflict', '市场结算激活状态已变化');
    return { state: await this.state(), backfill, reconciliation };
  }

  /** Incident handling only moves forward. There is intentionally no V2 -> LEGACY path. */
  async pause(expectedGeneration: number, reason = '') {
    const changed = await this.prisma.marketplaceCommerceState.updateMany({
      where: { id: 'singleton', writerMode: 'SETTLEMENT_V2', writerGeneration: expectedGeneration },
      data: { writerMode: 'PAUSED', writerGeneration: { increment: 1 }, pausedAt: new Date(), pauseReason: reason.slice(0, 200) },
    });
    if (changed.count !== 1) throw new AppError(409, 'marketplace_cutover_state_conflict', '市场结算暂停状态已变化');
    return this.state();
  }

  async resume(expectedGeneration: number) {
    const changed = await this.prisma.marketplaceCommerceState.updateMany({
      where: { id: 'singleton', writerMode: 'PAUSED', writerGeneration: expectedGeneration },
      data: { writerMode: 'SETTLEMENT_V2', writerGeneration: { increment: 1 }, pausedAt: null, pauseReason: '' },
    });
    if (changed.count !== 1) throw new AppError(409, 'marketplace_cutover_state_conflict', '市场结算恢复状态已变化');
    return this.state();
  }

  /** Idempotent legacy backfill. It only fills immutable order facts and entitlement links. */
  async backfillLegacy(options: { dryRun?: boolean; limit?: number } = {}): Promise<MarketplaceBackfillReport> {
    const dryRun = options.dryRun === true;
    const limit = Math.max(1, Math.min(options.limit ?? 10_000, 100_000));
    return this.serializable(async (tx) => {
      const client = tx as AnyClient;
      const rows = await client.purchase.findMany({
        where: { settlementVersion: 'LEGACY_V1' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limit,
        include: { package: { select: { ownerTeamId: true } }, entitlement: true },
      });
      const ledgerSnapshot = await this.ledgerSnapshot(client);
      const report: MarketplaceBackfillReport = {
        dry_run: dryRun, scanned: rows.length, mutated: 0, gross_cents: 0,
        unresolved_seller: 0, unresolved_release: 0, entitlement_mismatch: 0,
        null_or_invalid_orders: 0, balance_writes: 0, ledger_writes: 0, ledger_snapshot: ledgerSnapshot,
      };
      for (const row of rows) {
        const gross = Math.max(0, Number(row.priceCents ?? 0)); report.gross_cents += gross;
        const sellerTeamId = row.sellerTeamId ?? row.package?.ownerTeamId ?? null;
        if (!sellerTeamId) report.unresolved_seller += 1;
        if (row.packageId && !row.releaseId) report.unresolved_release += 1;
        const valid = row.status === 'SETTLED' && row.listPriceCents === gross && row.sellerAmountCents === gross
          && row.platformAmountCents === 0 && row.platformFeeBps === 0 && row.settledAt;
        if (!valid) report.null_or_invalid_orders += 1;
        if (!row.entitlement || row.entitlement.status !== 'ACTIVE' || row.entitlement.purchaseId !== row.id) report.entitlement_mismatch += 1;
        if (dryRun) continue;
        const data: Record<string, unknown> = {
          settlementVersion: 'LEGACY_V1', status: 'SETTLED', listPriceCents: gross,
          discountAmountCents: 0, platformFeeBps: 0, platformAmountCents: 0,
          sellerAmountCents: gross, settledAt: row.settledAt ?? row.createdAt,
        };
        if (sellerTeamId && !row.sellerTeamId) data.sellerTeamId = sellerTeamId;
        const needsOrderUpdate = Object.entries(data).some(([key, value]) => (row as any)[key] !== value);
        if (needsOrderUpdate) {
          const changed = await client.purchase.updateMany({ where: { id: row.id, settlementVersion: 'LEGACY_V1' }, data });
          if (changed.count === 1) report.mutated += 1;
        }
        if (row.packageId) {
          const existing = row.entitlement ?? await client.pluginEntitlement.findUnique({ where: { teamId_packageId: { teamId: row.buyerTeamId, packageId: row.packageId } } });
          if (!existing) {
            await client.pluginEntitlement.create({ data: { teamId: row.buyerTeamId, packageId: row.packageId, purchaseId: row.id, status: 'ACTIVE', activatedAt: row.createdAt } });
            report.mutated += 1;
          } else if (!existing.purchaseId) {
            const changed = await client.pluginEntitlement.updateMany({ where: { id: existing.id, purchaseId: null }, data: { purchaseId: row.id, status: 'ACTIVE', activatedAt: existing.activatedAt ?? row.createdAt } });
            if (changed.count === 1) report.mutated += 1;
          }
        }
      }
      return report;
    });
  }

  async reconcile(options: { preCutover?: boolean } = {}): Promise<MarketplaceReconciliationReport> {
    const report = await this.readReconciliation(options);
    const state = await this.state();
    if (state) {
      await this.prisma.marketplaceCommerceState.updateMany({ where: { id: 'singleton' }, data: { lastReconciliationAt: new Date(), lastReconciliationStatus: report.ok ? 'OK' : 'FAILED', lastReconciliationReport: report as unknown as Prisma.InputJsonValue } });
    }
    return report;
  }

  async runSettlementJob(now = new Date(), limit = 100) {
    const startedAt = new Date();
    await this.prisma.marketplaceCommerceState.updateMany({ where: { id: 'singleton' }, data: { lastSettlementJobAt: startedAt, lastSettlementJobStatus: 'RUNNING', lastSettlementJobError: '' } });
    try {
      const result = await this.commerce.settleDue(now, limit);
      await this.prisma.marketplaceCommerceState.updateMany({ where: { id: 'singleton' }, data: { lastSettlementJobAt: new Date(), lastSettlementJobStatus: 'SUCCEEDED', lastSettlementJobScanned: result.scanned, lastSettlementJobSettled: result.settled, lastSettlementJobSkipped: result.skipped, lastSettlementJobError: '' } });
      return { status: 'SUCCEEDED' as const, ...result };
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : 'settlement_job_failed';
      await this.prisma.marketplaceCommerceState.updateMany({ where: { id: 'singleton' }, data: { lastSettlementJobAt: new Date(), lastSettlementJobStatus: 'FAILED', lastSettlementJobError: message } });
      throw error;
    }
  }

  async settlementJobStatus() {
    const state = await this.state();
    if (!state) return null;
    const overdue = await this.prisma.purchase.count({ where: { settlementVersion: 'SETTLEMENT_V2', status: 'PENDING_SETTLEMENT', settleAt: { lte: new Date() } } });
    const refundReview = await this.prisma.purchase.count({ where: { settlementVersion: 'SETTLEMENT_V2', status: 'REFUND_REQUESTED' } });
    const oldest = await this.prisma.purchase.findFirst({ where: { settlementVersion: 'SETTLEMENT_V2', status: 'PENDING_SETTLEMENT', settleAt: { lte: new Date() } }, orderBy: { settleAt: 'asc' }, select: { settleAt: true } });
    return { last_run_at: state.lastSettlementJobAt?.toISOString() ?? null, status: state.lastSettlementJobStatus ?? null, scanned: state.lastSettlementJobScanned, settled: state.lastSettlementJobSettled, skipped: state.lastSettlementJobSkipped, error: state.lastSettlementJobError, due_count: overdue, refund_review_count: refundReview, oldest_overdue_at: oldest?.settleAt?.toISOString() ?? null };
  }

  private async readReconciliation(options: { preCutover?: boolean }): Promise<MarketplaceReconciliationReport> {
    const client = this.prisma as AnyClient;
    const rows = await client.purchase.findMany({ where: options.preCutover ? {} : { settlementVersion: 'SETTLEMENT_V2' }, include: { package: { select: { ownerTeamId: true } }, entitlement: true, ledgerEntries: true } });
    const invalidOrders: string[] = []; const ledgerViolations: string[] = []; const entitlementViolations: string[] = [];
    let gross = 0; let pending = 0; let review = 0; let settled = 0; let refunded = 0; let clearingExpected = 0; let revenueExpected = 0; let legacy = 0; let v2 = 0; let unresolvedSeller = 0; let unresolvedRelease = 0;
    for (const row of rows) {
      if (row.settlementVersion === 'LEGACY_V1') legacy += 1; else v2 += 1;
      const amount = Number(row.priceCents ?? 0); gross += amount;
      if (!row.sellerTeamId && row.packageId) unresolvedSeller += 1;
      if (row.packageId && !row.releaseId) unresolvedRelease += 1;
      if (row.settlementVersion === 'LEGACY_V1') {
        if (row.status !== 'SETTLED' || row.sellerAmountCents !== amount || row.platformAmountCents !== 0) invalidOrders.push(row.id);
        if (row.packageId && (row.entitlement?.status !== 'ACTIVE' || row.entitlement?.purchaseId !== row.id)) entitlementViolations.push(row.id);
        continue;
      }
      if (row.listPriceCents - row.discountAmountCents !== amount || row.platformAmountCents + row.sellerAmountCents !== amount || row.platformFeeBps < 0 || row.platformFeeBps > 10000) invalidOrders.push(row.id);
      if (row.status === 'PENDING_SETTLEMENT') { pending += amount; clearingExpected += amount; }
      if (row.status === 'REFUND_REQUESTED') { review += amount; clearingExpected += amount; }
      if (row.status === 'SETTLED') { settled += amount; revenueExpected += row.platformAmountCents; }
      if (row.status === 'REFUNDED') refunded += amount;
      if ((row.status === 'PENDING_SETTLEMENT' || row.status === 'REFUND_REQUESTED') && row.entitlement?.status !== 'ACTIVE') entitlementViolations.push(row.id);
      if (row.status === 'REFUNDED' && row.entitlement?.status !== 'REVOKED') entitlementViolations.push(row.id);
      const entries = Array.isArray(row.ledgerEntries) ? row.ledgerEntries : [];
      const expected = new Map<string, { amount: number; direction: 'CREDIT' | 'DEBIT'; teamId: string | null; platformAccountId: string | null }>([
        ['BUYER_PURCHASE_DEBIT', { amount, direction: 'DEBIT', teamId: row.buyerTeamId, platformAccountId: null }],
        ['PLATFORM_PURCHASE_CLEARING_CREDIT', { amount, direction: 'CREDIT', teamId: null, platformAccountId: CLEARING_ACCOUNT_ID }],
      ]);
      if (row.status === 'SETTLED') {
        expected.set('PLATFORM_SETTLEMENT_CLEARING_DEBIT', { amount, direction: 'DEBIT', teamId: null, platformAccountId: CLEARING_ACCOUNT_ID });
        expected.set('SELLER_SETTLEMENT_CREDIT', { amount: row.sellerAmountCents, direction: 'CREDIT', teamId: row.sellerTeamId, platformAccountId: null });
        expected.set('PLATFORM_SETTLEMENT_CREDIT', { amount: row.platformAmountCents, direction: 'CREDIT', teamId: null, platformAccountId: REVENUE_ACCOUNT_ID });
      }
      if (row.status === 'REFUNDED') {
        expected.set('BUYER_REFUND_CREDIT', { amount, direction: 'CREDIT', teamId: row.buyerTeamId, platformAccountId: null });
        expected.set('PLATFORM_REFUND_CLEARING_DEBIT', { amount, direction: 'DEBIT', teamId: null, platformAccountId: CLEARING_ACCOUNT_ID });
      }
      const indexed = new Map(entries.map((entry: any) => [entry.marketplaceEntryKind, entry]));
      const badLedger = indexed.size !== expected.size || [...expected].some(([kind, wanted]) => {
        const entry: any = indexed.get(kind);
        return !entry || Number(entry.amountCents) !== wanted.amount || entry.direction !== wanted.direction
          || (entry.teamId ?? null) !== wanted.teamId || (entry.platformAccountId ?? null) !== wanted.platformAccountId;
      });
      if (badLedger) ledgerViolations.push(row.id);
    }
    const accounts = await client.marketplacePlatformAccount.findMany({ where: { id: { in: [CLEARING_ACCOUNT_ID, REVENUE_ACCOUNT_ID] } }, select: { id: true, balanceCents: true } });
    const accountMap = new Map<string, number>(accounts.map((row: any) => [String(row.id), Number(row.balanceCents)]));
    const reasonCodes: string[] = [];
    if (options.preCutover && v2 > 0) reasonCodes.push('unexpected_settlement_v2_orders');
    if (invalidOrders.length) reasonCodes.push('invalid_order_facts');
    if (ledgerViolations.length) reasonCodes.push('ledger_invariant_violation');
    if (entitlementViolations.length) reasonCodes.push('entitlement_invariant_violation');
    if (unresolvedSeller) reasonCodes.push('unresolved_seller');
    if (unresolvedRelease) reasonCodes.push('unresolved_release');
    const clearingActual = accountMap.get(CLEARING_ACCOUNT_ID) ?? null;
    const revenueActual = accountMap.get(REVENUE_ACCOUNT_ID) ?? null;
    if (clearingActual === null || revenueActual === null) reasonCodes.push('platform_account_missing');
    else if (clearingActual !== clearingExpected || revenueActual !== revenueExpected) reasonCodes.push('platform_account_balance_mismatch');
    const ok = reasonCodes.length === 0 && (!options.preCutover || (legacy === rows.length));
    return {
      ok, settlement_version: legacy && v2 ? 'MIXED' : v2 ? 'SETTLEMENT_V2' : 'LEGACY_V1', purchase_count: rows.length,
      gross_cents: gross, pending_cents: pending, refund_requested_cents: review, settled_cents: settled, refunded_cents: refunded,
      clearing_expected_cents: clearingExpected, clearing_actual_cents: clearingActual,
      revenue_expected_cents: revenueExpected, revenue_actual_cents: revenueActual,
      invalid_orders: invalidOrders, ledger_violations: ledgerViolations, entitlement_violations: entitlementViolations,
      unresolved_seller: unresolvedSeller, unresolved_release: unresolvedRelease, reason_codes: reasonCodes,
    };
  }

  private async ledgerSnapshot(client: AnyClient) {
    const rows = await client.balanceLedger.findMany({ where: { marketplaceEntryKind: { not: null } }, orderBy: { id: 'asc' }, select: { id: true, amountCents: true, direction: true, marketplaceEntryKind: true, purchaseId: true } });
    const digest = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    return { count: rows.length, debit_cents: rows.filter((row: any) => row.direction === 'DEBIT').reduce((sum: number, row: any) => sum + Number(row.amountCents), 0), credit_cents: rows.filter((row: any) => row.direction === 'CREDIT').reduce((sum: number, row: any) => sum + Number(row.amountCents), 0), digest };
  }

  private async serializable<T>(operation: (tx: unknown) => Promise<T>) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try { return await this.prisma.$transaction(operation, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }); }
      catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') || attempt === 3) throw error;
      }
    }
    throw conflict('市场结算发生并发冲突');
  }
}
