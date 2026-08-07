import { describe, expect, it, vi } from 'vitest';
import {
  MarketplaceSettlementCutoverService,
  type MarketplaceBackfillReport,
  type MarketplaceReconciliationReport,
} from './marketplace-settlement-cutover.service';

const now = new Date('2026-07-16T00:00:00.000Z');
const state = {
  id: 'singleton',
  writerMode: 'LEGACY',
  writerGeneration: 3,
  settlementV2ActivatedAt: null,
};

function service(
  tx: Record<string, any> = {},
  top: Record<string, any> = {},
  commerceOverrides: Record<string, any> = {}
) {
  const prisma = {
    marketplaceCommerceState: {
      findUnique: vi.fn().mockResolvedValue(state),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    purchase: {
      count: vi.fn().mockResolvedValue(0),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    $transaction: vi.fn(async (operation: (client: unknown) => unknown) => operation(tx)),
    ...top,
  };
  const commerce = {
    settleDue: vi.fn().mockResolvedValue({ scanned: 0, settled: 0, skipped: 0 }),
    ...commerceOverrides,
  };
  return {
    cutover: new MarketplaceSettlementCutoverService(prisma as never, commerce as never),
    prisma,
    commerce,
  };
}

const goodBackfill: MarketplaceBackfillReport = {
  dry_run: false,
  scanned: 1,
  mutated: 1,
  gross_cents: 100,
  unresolved_seller: 0,
  unresolved_release: 0,
  entitlement_mismatch: 0,
  null_or_invalid_orders: 0,
  balance_writes: 0,
  ledger_writes: 0,
  ledger_snapshot: { count: 0, debit_cents: 0, credit_cents: 0, digest: 'a'.repeat(64) },
};
const goodReconciliation: MarketplaceReconciliationReport = {
  ok: true,
  settlement_version: 'LEGACY_V1',
  purchase_count: 1,
  gross_cents: 100,
  pending_cents: 0,
  refund_requested_cents: 0,
  settled_cents: 0,
  refunded_cents: 0,
  clearing_expected_cents: 0,
  clearing_actual_cents: 0,
  revenue_expected_cents: 0,
  revenue_actual_cents: 0,
  invalid_orders: [],
  ledger_violations: [],
  entitlement_violations: [],
  unresolved_seller: 0,
  unresolved_release: 0,
  reason_codes: [],
};

describe('MarketplaceSettlementCutoverService state machine', () => {
  it('uses generation CAS for LEGACY -> DRAINING and never offers a path back to LEGACY', async () => {
    const { cutover, prisma } = service();
    await cutover.beginDraining(3);
    expect(prisma.marketplaceCommerceState.updateMany).toHaveBeenCalledWith({
      where: { id: 'singleton', writerMode: 'LEGACY', writerGeneration: 3 },
      data: { writerMode: 'DRAINING' },
    });

    prisma.marketplaceCommerceState.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(cutover.beginDraining(3)).rejects.toMatchObject({
      code: 'marketplace_cutover_state_conflict',
    });
  });

  it('activates only after final backfill/reconciliation and increments the writer fence atomically', async () => {
    const draining = { ...state, writerMode: 'DRAINING' };
    const active = {
      ...draining,
      writerMode: 'SETTLEMENT_V2',
      writerGeneration: 4,
      settlementV2ActivatedAt: now,
    };
    const { cutover, prisma } = service(
      {},
      {
        marketplaceCommerceState: {
          findUnique: vi.fn().mockResolvedValueOnce(draining).mockResolvedValue(active),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      }
    );
    vi.spyOn(cutover, 'backfillLegacy').mockResolvedValue(goodBackfill);
    vi.spyOn(cutover, 'reconcile').mockResolvedValue(goodReconciliation);
    const result = await cutover.activate(3, now);
    expect(result.state).toEqual(active);
    expect(prisma.marketplaceCommerceState.updateMany).toHaveBeenCalledWith({
      where: { id: 'singleton', writerMode: 'DRAINING', writerGeneration: 3 },
      data: {
        writerMode: 'SETTLEMENT_V2',
        writerGeneration: { increment: 1 },
        settlementV2ActivatedAt: now,
      },
    });
  });

  it('keeps activation closed on a reconciliation mismatch and PAUSED fails the writer fence', async () => {
    const draining = { ...state, writerMode: 'DRAINING' };
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const { cutover } = service(
      {},
      { marketplaceCommerceState: { findUnique: vi.fn().mockResolvedValue(draining), updateMany } }
    );
    vi.spyOn(cutover, 'backfillLegacy').mockResolvedValue(goodBackfill);
    vi.spyOn(cutover, 'reconcile').mockResolvedValue({
      ...goodReconciliation,
      ok: false,
      reason_codes: ['platform_account_balance_mismatch'],
    });
    await expect(cutover.activate(3, now)).rejects.toMatchObject({
      code: 'marketplace_cutover_reconciliation_failed',
    });
    expect(updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ writerMode: 'SETTLEMENT_V2' }) })
    );

    const paused = {
      ...state,
      writerMode: 'PAUSED',
      writerGeneration: 8,
      settlementV2ActivatedAt: now,
    };
    const fenced = service(
      {},
      { marketplaceCommerceState: { findUnique: vi.fn().mockResolvedValue(paused), updateMany } }
    ).cutover;
    await expect(fenced.assertWriterFence(8)).rejects.toMatchObject({
      code: 'marketplace_commerce_paused',
    });
    await expect(fenced.assertWriterFence(8, ['PAUSED'])).resolves.toEqual(paused);
  });
});

describe('MarketplaceSettlementCutoverService backfill and reconciliation', () => {
  it('backfills legacy facts/entitlement idempotently without any balance or ledger write', async () => {
    const row = {
      id: 'purchase-1',
      settlementVersion: 'LEGACY_V1',
      status: 'PENDING_SETTLEMENT',
      packageId: 'package-1',
      releaseId: 'release-1',
      buyerTeamId: 'buyer-1',
      sellerTeamId: null,
      priceCents: 101,
      listPriceCents: 0,
      discountAmountCents: 0,
      platformFeeBps: 0,
      platformAmountCents: 0,
      sellerAmountCents: 0,
      settledAt: null,
      createdAt: now,
      package: { ownerTeamId: 'seller-1' },
      entitlement: null,
    };
    const tx = {
      purchase: {
        findMany: vi.fn().mockResolvedValue([row]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      pluginEntitlement: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'ent-1' }),
        updateMany: vi.fn(),
      },
      balanceLedger: {
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        createMany: vi.fn(),
      },
      team: { update: vi.fn(), updateMany: vi.fn() },
    };
    const { cutover } = service(tx);
    const first = await cutover.backfillLegacy();
    expect(first).toMatchObject({
      scanned: 1,
      mutated: 2,
      gross_cents: 101,
      balance_writes: 0,
      ledger_writes: 0,
    });
    expect(tx.purchase.updateMany).toHaveBeenCalledWith({
      where: { id: 'purchase-1', settlementVersion: 'LEGACY_V1' },
      data: expect.objectContaining({
        status: 'SETTLED',
        sellerTeamId: 'seller-1',
        sellerAmountCents: 101,
        settledAt: now,
      }),
    });
    expect(tx.pluginEntitlement.create).toHaveBeenCalledWith({
      data: {
        teamId: 'buyer-1',
        packageId: 'package-1',
        purchaseId: 'purchase-1',
        status: 'ACTIVE',
        activatedAt: now,
      },
    });
    expect(tx.team.update).not.toHaveBeenCalled();
    expect(tx.balanceLedger.createMany).not.toHaveBeenCalled();

    tx.purchase.findMany.mockResolvedValue([
      {
        ...row,
        status: 'SETTLED',
        sellerTeamId: 'seller-1',
        listPriceCents: 101,
        sellerAmountCents: 101,
        settledAt: now,
        entitlement: { id: 'ent-1', status: 'ACTIVE', purchaseId: 'purchase-1' },
      },
    ]);
    const second = await cutover.backfillLegacy();
    expect(second.mutated).toBe(0);
  });

  it('detects platform balance, ledger, entitlement, and unresolved release mismatches', async () => {
    const purchase = {
      id: 'purchase-v2',
      settlementVersion: 'SETTLEMENT_V2',
      status: 'PENDING_SETTLEMENT',
      packageId: 'package-1',
      releaseId: null,
      sellerTeamId: 'seller-1',
      priceCents: 100,
      listPriceCents: 100,
      discountAmountCents: 0,
      platformFeeBps: 2000,
      platformAmountCents: 20,
      sellerAmountCents: 80,
      entitlement: { status: 'REVOKED' },
      ledgerEntries: [],
      package: { ownerTeamId: 'seller-1' },
    };
    const top = {
      purchase: {
        findMany: vi.fn().mockResolvedValue([purchase]),
        count: vi.fn(),
        findFirst: vi.fn(),
      },
      marketplacePlatformAccount: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'marketplace-clearing', balanceCents: 0 },
          { id: 'marketplace-revenue', balanceCents: 0 },
        ]),
      },
      marketplaceCommerceState: {
        findUnique: vi.fn().mockResolvedValue({
          ...state,
          writerMode: 'SETTLEMENT_V2',
          writerGeneration: 4,
          settlementV2ActivatedAt: now,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const report = await service({}, top).cutover.reconcile();
    expect(report.ok).toBe(false);
    expect(report.reason_codes).toEqual(
      expect.arrayContaining([
        'ledger_invariant_violation',
        'entitlement_invariant_violation',
        'unresolved_release',
        'platform_account_balance_mismatch',
      ])
    );
  });
});

describe('MarketplaceSettlementCutoverService durable settlement job', () => {
  it('persists RUNNING/SUCCEEDED status and exposes catch-up counts', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const { cutover, commerce } = service(
      {},
      { marketplaceCommerceState: { findUnique: vi.fn().mockResolvedValue(state), updateMany } },
      { settleDue: vi.fn().mockResolvedValue({ scanned: 4, settled: 3, skipped: 1 }) }
    );
    await expect(cutover.runSettlementJob(now, 10)).resolves.toEqual({
      status: 'SUCCEEDED',
      scanned: 4,
      settled: 3,
      skipped: 1,
    });
    expect(commerce.settleDue).toHaveBeenCalledWith(now, 10);
    expect(updateMany.mock.calls[0][0].data.lastSettlementJobStatus).toBe('RUNNING');
    expect(updateMany.mock.calls[1][0].data).toMatchObject({
      lastSettlementJobStatus: 'SUCCEEDED',
      lastSettlementJobScanned: 4,
      lastSettlementJobSettled: 3,
      lastSettlementJobSkipped: 1,
    });
  });
});
