import { beforeEach, describe, expect, it, vi } from 'vitest';
import { marketplaceJournalNet, type MarketplacePurchaseResponse } from '@lingfang/contract';
import { MarketplaceCommerceService } from './marketplace-commerce.service';
import { resolveMarketplacePrice } from './marketplace-commerce-calculator';
import { PLUGIN_AI_POLICY_VERSION } from './plugin-ai-policy';

const ids = {
  buyerUser: '11111111-1111-4111-8111-111111111111',
  buyerTeam: '22222222-2222-4222-8222-222222222222',
  sellerUser: '33333333-3333-4333-8333-333333333333',
  sellerTeam: '44444444-4444-4444-8444-444444444444',
  package: '55555555-5555-4555-8555-555555555555',
  release: '66666666-6666-4666-8666-666666666666',
  purchase: '77777777-7777-4777-8777-777777777777',
  entitlement: '88888888-8888-4888-8888-888888888888',
  refund: '99999999-9999-4999-8999-999999999999',
  discount: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  campaign: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
};
const now = new Date('2026-07-16T00:00:00.000Z');
beforeEach(() => {
  process.env.MARKETPLACE_CAMPAIGN_TOKEN_SECRET = 'campaign-test-secret-'.repeat(3);
});
const state = {
  writerMode: 'SETTLEMENT_V2',
  writerGeneration: 7,
  settlementV2ActivatedAt: new Date('2026-07-15T00:00:00.000Z'),
};
const listing = {
  id: 'listing-1',
  packageId: ids.package,
  status: 'ACTIVE',
  priceCents: 101,
  priceRevision: 1,
  package: {
    ownerTeamId: ids.sellerTeam,
    authorUserId: ids.sellerUser,
    governanceStatus: 'ACTIVE',
  },
  currentRelease: {
    id: ids.release,
    status: 'PUBLISHED',
    marketReviewStatus: 'APPROVED',
    aiPolicyVersion: PLUGIN_AI_POLICY_VERSION,
    aiPolicyStatus: 'PASSED',
  },
};

function service(
  tx: Record<string, any>,
  top: Record<string, any> = {},
  authOverrides: Record<string, any> = {}
) {
  const prisma = {
    ...top,
    $transaction: vi.fn(async (operation: (client: unknown) => unknown) => operation(tx)),
  };
  const auth = {
    ensureCurrentTeam: vi.fn().mockResolvedValue({ teamId: ids.buyerTeam }),
    ensurePlatformAdmin: vi.fn().mockResolvedValue({ id: ids.buyerUser }),
    ensurePermission: vi.fn().mockResolvedValue({ perms: new Set(['team.plugin.edit_price']) }),
    ...authOverrides,
  };
  return { commerce: new MarketplaceCommerceService(prisma as never, auth as never), prisma, auth };
}

function purchaseTx(overrides: Record<string, any> = {}) {
  const order = { id: ids.purchase, createdAt: now, priceCents: 101 };
  return {
    marketplaceCommerceState: { findUnique: vi.fn().mockResolvedValue(state) },
    marketplacePurchaseIdempotency: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
    },
    marketplaceListing: { findUnique: vi.fn().mockResolvedValue(listing) },
    marketplaceDiscount: { findFirst: vi.fn().mockResolvedValue(null) },
    pluginEntitlement: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi
        .fn()
        .mockResolvedValue({ id: ids.entitlement, purchaseId: ids.purchase, status: 'ACTIVE' }),
      updateMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    purchase: { create: vi.fn().mockResolvedValue(order) },
    team: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), update: vi.fn() },
    marketplacePlatformAccount: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn(),
    },
    balanceLedger: { createMany: vi.fn().mockResolvedValue({ count: 2 }) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    ...overrides,
  };
}

describe('MarketplaceCommerceService writer and purchase', () => {
  it('routes LEGACY/V2 and blocks DRAINING or PAUSED before any financial write', async () => {
    for (const [row, expected] of [
      [null, 'LEGACY'],
      [{ writerMode: 'LEGACY' }, 'LEGACY'],
      [state, 'V2'],
    ] as const) {
      const { commerce } = service(
        {},
        { marketplaceCommerceState: { findUnique: vi.fn().mockResolvedValue(row) } }
      );
      await expect(commerce.purchaseDisposition()).resolves.toBe(expected);
    }
    for (const writerMode of ['DRAINING', 'PAUSED']) {
      const tx = purchaseTx({
        marketplaceCommerceState: {
          findUnique: vi.fn().mockResolvedValue({ ...state, writerMode }),
        },
      });
      const { commerce } = service(tx);
      await expect(
        commerce.purchaseV2(ids.buyerUser, { packageId: ids.package, now })
      ).rejects.toMatchObject({ code: 'marketplace_commerce_paused' });
      expect(tx.purchase.create).not.toHaveBeenCalled();
      expect(tx.team.updateMany).not.toHaveBeenCalled();
      expect(tx.balanceLedger.createMany).not.toHaveBeenCalled();
    }
  });

  it('freezes the exact price/release, debits buyer, credits clearing, and leaves seller unchanged until T+7', async () => {
    const tx = purchaseTx();
    const expected = resolveMarketplacePrice({
      listPriceCents: listing.priceCents,
      priceRevision: listing.priceRevision,
      discount: null,
      now,
    });
    const { commerce } = service(tx);
    const result = await commerce.purchaseV2(ids.buyerUser, {
      packageId: ids.package,
      expectedPriceVersion: expected.price_version,
      idempotencyKey: 'purchase-1',
      now,
    });
    expect(result).toMatchObject({
      entitled: true,
      result_kind: 'ORDER_CREATED',
      purchase_id: ids.purchase,
      order: {
        release_id: ids.release,
        price_cents: 101,
        platform_amount_cents: 20,
        seller_amount_cents: 81,
        status: 'PENDING_SETTLEMENT',
      },
    });
    expect(tx.purchase.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        releaseId: ids.release,
        buyerTeamId: ids.buyerTeam,
        sellerTeamId: ids.sellerTeam,
        priceVersion: expected.price_version,
        settleAt: new Date('2026-07-23T00:00:00.000Z'),
      }),
    });
    expect(tx.team.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ids.buyerTeam, balanceCents: { gte: 101 } },
        data: { balanceCents: { decrement: 101 } },
      })
    );
    expect(tx.team.update).not.toHaveBeenCalled();
    const entries = tx.balanceLedger.createMany.mock.calls[0][0].data;
    expect(entries).toHaveLength(2);
    expect(
      marketplaceJournalNet(
        entries.map((entry: any) => ({
          entry_kind: entry.marketplaceEntryKind,
          direction: entry.direction,
          amount_cents: entry.amountCents,
        }))
      )
    ).toBe(0);
    expect(tx.marketplacePurchaseIdempotency.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        key: 'purchase-1',
        purchaseId: ids.purchase,
        entitlementId: ids.entitlement,
      }),
    });
  });

  it('creates and reuses a zero-value acquisition fact without touching balances or ledgers', async () => {
    const freeListing = { ...listing, priceCents: 0 };
    const tx = purchaseTx({
      marketplaceListing: { findUnique: vi.fn().mockResolvedValue(freeListing) },
      purchase: {
        create: vi.fn().mockResolvedValue({ id: ids.purchase, createdAt: now, priceCents: 0 }),
      },
    });
    const expected = resolveMarketplacePrice({
      listPriceCents: 0,
      priceRevision: freeListing.priceRevision,
      discount: null,
      now,
    });
    const result = await service(tx).commerce.purchaseV2(ids.buyerUser, {
      packageId: ids.package,
      expectedPriceVersion: expected.price_version,
      idempotencyKey: 'free-acquisition-1',
      now,
    });

    expect(result).toMatchObject({
      entitled: true,
      entitlement_id: ids.entitlement,
      purchase_id: ids.purchase,
      result_kind: 'ORDER_CREATED',
      order: {
        price_cents: 0,
        platform_amount_cents: 0,
        seller_amount_cents: 0,
        status: 'SETTLED',
        settled_at: now.toISOString(),
      },
    });
    expect(tx.purchase.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        priceCents: 0,
        status: 'SETTLED',
        settledAt: now,
      }),
    });
    expect(tx.pluginEntitlement.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ purchaseId: ids.purchase }),
    });
    expect(tx.marketplacePurchaseIdempotency.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        key: 'free-acquisition-1',
        purchaseId: ids.purchase,
        entitlementId: ids.entitlement,
      }),
    });
    expect(tx.team.updateMany).not.toHaveBeenCalled();
    expect(tx.marketplacePlatformAccount.updateMany).not.toHaveBeenCalled();
    expect(tx.balanceLedger.createMany).not.toHaveBeenCalled();

    const repeatedTx = purchaseTx({
      marketplaceListing: { findUnique: vi.fn().mockResolvedValue(freeListing) },
      pluginEntitlement: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ id: ids.entitlement, purchaseId: ids.purchase, status: 'ACTIVE' }),
        create: vi.fn(),
        updateMany: vi.fn(),
        findUniqueOrThrow: vi.fn(),
      },
    });
    await expect(
      service(repeatedTx).commerce.purchaseV2(ids.buyerUser, { packageId: ids.package, now })
    ).resolves.toMatchObject({
      entitlement_id: ids.entitlement,
      purchase_id: ids.purchase,
      result_kind: 'ENTITLED_EXISTING',
    });
    expect(repeatedTx.purchase.create).not.toHaveBeenCalled();

    const refundTx = {
      purchase: {
        findUnique: vi.fn().mockResolvedValue({
          id: ids.purchase,
          buyerTeamId: ids.buyerTeam,
          settlementVersion: 'SETTLEMENT_V2',
          status: 'SETTLED',
          refundableUntil: now,
          refundRequest: null,
        }),
      },
      marketplaceRefundRequest: { create: vi.fn() },
      auditLog: { create: vi.fn() },
    };
    await expect(
      service(refundTx).commerce.requestRefund(ids.buyerUser, ids.purchase, '免费获取不可退款', now)
    ).rejects.toMatchObject({ code: 'marketplace_refund_window_closed' });
    expect(refundTx.marketplaceRefundRequest.create).not.toHaveBeenCalled();
  });

  it('rejects stale prices with zero writes and replays or conflicts idempotency keys deterministically', async () => {
    const staleTx = purchaseTx();
    await expect(
      service(staleTx).commerce.purchaseV2(ids.buyerUser, {
        packageId: ids.package,
        expectedPriceVersion: `pv1.${'x'.repeat(43)}`,
        now,
      })
    ).rejects.toMatchObject({ code: 'marketplace_price_changed' });
    expect(staleTx.purchase.create).not.toHaveBeenCalled();
    expect(staleTx.team.updateMany).not.toHaveBeenCalled();

    const stored: MarketplacePurchaseResponse = {
      entitled: true,
      entitlement_id: ids.entitlement,
      purchase_id: null,
      result_kind: 'ENTITLED_EXISTING',
      order: null,
    };
    const replayTx = purchaseTx({
      marketplacePurchaseIdempotency: {
        findUnique: vi.fn().mockResolvedValue({
          packageId: ids.package,
          requestDigest: 'digest',
          responseJson: stored,
        }),
        create: vi.fn(),
      },
    });
    const input = { packageId: ids.package, idempotencyKey: 'same-key', now };
    const crypto = await import('node:crypto');
    replayTx.marketplacePurchaseIdempotency.findUnique.mockResolvedValue({
      packageId: ids.package,
      requestDigest: crypto
        .createHash('sha256')
        .update(
          JSON.stringify({
            package_id: ids.package,
            expected_price_version: null,
            campaign_token_sha256: null,
          })
        )
        .digest('hex'),
      responseJson: stored,
    });
    await expect(service(replayTx).commerce.purchaseV2(ids.buyerUser, input)).resolves.toEqual(
      stored
    );
    expect(replayTx.marketplaceListing.findUnique).not.toHaveBeenCalled();

    replayTx.marketplacePurchaseIdempotency.findUnique.mockResolvedValue({
      packageId: ids.release,
      requestDigest: 'other',
      responseJson: stored,
    });
    await expect(service(replayTx).commerce.purchaseV2(ids.buyerUser, input)).rejects.toMatchObject(
      { code: 'marketplace_idempotency_conflict' }
    );

    const activeTx = purchaseTx({
      pluginEntitlement: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ id: ids.entitlement, purchaseId: ids.purchase, status: 'ACTIVE' }),
        create: vi.fn(),
        updateMany: vi.fn(),
        findUniqueOrThrow: vi.fn(),
      },
    });
    await expect(
      service(activeTx).commerce.purchaseV2(ids.buyerUser, {
        ...input,
        idempotencyKey: 'active-key',
      })
    ).resolves.toMatchObject({ result_kind: 'ENTITLED_EXISTING' });
    expect(activeTx.marketplacePurchaseIdempotency.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        resultKind: 'ENTITLED_EXISTING',
        entitlementId: ids.entitlement,
      }),
    });
    expect(activeTx.purchase.create).not.toHaveBeenCalled();
  });

  it('issues a short-lived buyer-scoped campaign token and freezes campaign item attribution', async () => {
    const top = {
      marketplaceCampaign: {
        findFirst: vi.fn().mockResolvedValue({
          id: ids.campaign,
          endsAt: new Date('2026-07-20T00:00:00.000Z'),
          items: [{ id: 'campaign-item-1', packageId: ids.package }],
        }),
      },
      marketplaceListing: { findFirst: vi.fn().mockResolvedValue({ id: listing.id }) },
    };
    const issued = await service({}, top).commerce.issueCampaignToken(
      ids.buyerUser,
      ids.campaign,
      ids.package,
      now
    );
    expect(issued.campaign_token).toMatch(/^ct1\./);
    const tx = purchaseTx({
      marketplaceCampaignItem: { findFirst: vi.fn().mockResolvedValue({ id: 'campaign-item-1' }) },
    });
    const result = await service(tx).commerce.purchaseV2(ids.buyerUser, {
      packageId: ids.package,
      campaignToken: issued.campaign_token,
      now,
    });
    expect(tx.purchase.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        attributionKind: 'CAMPAIGN',
        campaignId: ids.campaign,
        campaignItemId: 'campaign-item-1',
      }),
    });
    expect(result.order).toMatchObject({ campaign_id: ids.campaign, attribution_kind: 'CAMPAIGN' });
  });

  it('rejects forged, expired, and cross-team campaign tokens before financial writes', async () => {
    const top = {
      marketplaceCampaign: {
        findFirst: vi.fn().mockResolvedValue({
          id: ids.campaign,
          endsAt: new Date('2026-07-20T00:00:00.000Z'),
          items: [{ id: 'campaign-item-1', packageId: ids.package }],
        }),
      },
      marketplaceListing: { findFirst: vi.fn().mockResolvedValue({ id: listing.id }) },
    };
    const issued = await service({}, top).commerce.issueCampaignToken(
      ids.buyerUser,
      ids.campaign,
      ids.package,
      now
    );
    for (const token of [`${issued.campaign_token}x`, issued.campaign_token]) {
      const tx = purchaseTx({
        marketplaceCampaignItem: {
          findFirst: vi.fn().mockResolvedValue({ id: 'campaign-item-1' }),
        },
      });
      const overrides =
        token === issued.campaign_token
          ? { ensureCurrentTeam: vi.fn().mockResolvedValue({ teamId: 'other-team' }) }
          : {};
      await expect(
        service(tx, {}, overrides).commerce.purchaseV2(ids.buyerUser, {
          packageId: ids.package,
          campaignToken: token,
          now,
        })
      ).rejects.toMatchObject({ code: 'campaign_token_invalid' });
      expect(tx.purchase.create).not.toHaveBeenCalled();
    }
    const expiredTx = purchaseTx({ marketplaceCampaignItem: { findFirst: vi.fn() } });
    await expect(
      service(expiredTx).commerce.purchaseV2(ids.buyerUser, {
        packageId: ids.package,
        campaignToken: issued.campaign_token,
        now: new Date('2026-07-16T00:16:00.000Z'),
      })
    ).rejects.toMatchObject({ code: 'campaign_token_expired' });
    expect(expiredTx.purchase.create).not.toHaveBeenCalled();
  });
});

describe('MarketplaceCommerceService refunds and settlement', () => {
  it('accepts refund requests strictly before expiry and rejects the equal boundary', async () => {
    const refundableUntil = new Date('2026-07-23T00:00:00.000Z');
    const tx = {
      purchase: {
        findUnique: vi.fn().mockResolvedValue({
          id: ids.purchase,
          buyerTeamId: ids.buyerTeam,
          settlementVersion: 'SETTLEMENT_V2',
          status: 'PENDING_SETTLEMENT',
          refundableUntil,
          refundRequest: null,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      marketplaceRefundRequest: { create: vi.fn().mockResolvedValue({ id: ids.refund }) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    await expect(
      service(tx).commerce.requestRefund(
        ids.buyerUser,
        ids.purchase,
        '需要退款',
        new Date(refundableUntil.getTime() - 1)
      )
    ).resolves.toEqual({ id: ids.refund });
    expect(tx.purchase.updateMany).toHaveBeenCalledWith({
      where: { id: ids.purchase, status: 'PENDING_SETTLEMENT' },
      data: { status: 'REFUND_REQUESTED' },
    });
    const equalTx = {
      ...tx,
      marketplaceRefundRequest: { create: vi.fn() },
      purchase: { ...tx.purchase, updateMany: vi.fn() },
    };
    await expect(
      service(equalTx).commerce.requestRefund(
        ids.buyerUser,
        ids.purchase,
        '需要退款',
        refundableUntil
      )
    ).rejects.toMatchObject({ code: 'marketplace_refund_window_closed' });
    expect(equalTx.marketplaceRefundRequest.create).not.toHaveBeenCalled();
  });

  it('approves with a balanced buyer/clearing reversal and entitlement revoke, while rejection restores pending', async () => {
    const purchase = {
      id: ids.purchase,
      buyerTeamId: ids.buyerTeam,
      priceCents: 101,
      status: 'REFUND_REQUESTED',
    };
    const approveTx = {
      marketplaceRefundRequest: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ id: ids.refund, status: 'PENDING', reason: 'reason', purchase }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      purchase: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: vi.fn().mockResolvedValue({ ...purchase, status: 'REFUNDED' }),
      },
      marketplacePlatformAccount: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      team: { update: vi.fn().mockResolvedValue({}) },
      pluginEntitlement: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      balanceLedger: { createMany: vi.fn().mockResolvedValue({ count: 2 }) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    await expect(
      service(approveTx).commerce.approveRefund(ids.buyerUser, ids.refund, 'approved', now)
    ).resolves.toMatchObject({ status: 'REFUNDED' });
    expect(approveTx.team.update).toHaveBeenCalledWith({
      where: { id: ids.buyerTeam },
      data: { balanceCents: { increment: 101 } },
    });
    expect(approveTx.pluginEntitlement.updateMany).toHaveBeenCalledWith({
      where: { purchaseId: ids.purchase, status: 'ACTIVE' },
      data: expect.objectContaining({ status: 'REVOKED', revokedByPurchaseId: ids.purchase }),
    });
    const entries = approveTx.balanceLedger.createMany.mock.calls[0][0].data;
    expect(
      marketplaceJournalNet(
        entries.map((entry: any) => ({
          entry_kind: entry.marketplaceEntryKind,
          direction: entry.direction,
          amount_cents: entry.amountCents,
        }))
      )
    ).toBe(0);

    const rejectTx = {
      marketplaceRefundRequest: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ id: ids.refund, status: 'PENDING', reason: 'reason', purchase }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      purchase: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: vi.fn().mockResolvedValue({ ...purchase, status: 'PENDING_SETTLEMENT' }),
      },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    await expect(
      service(rejectTx).commerce.rejectRefund(ids.buyerUser, ids.refund, '', now)
    ).resolves.toMatchObject({ status: 'PENDING_SETTLEMENT' });
    expect(rejectTx.purchase.updateMany).toHaveBeenCalledWith({
      where: { id: ids.purchase, status: 'REFUND_REQUESTED' },
      data: { status: 'PENDING_SETTLEMENT' },
    });
  });

  it('settles only due pending V2 orders and duplicate CAS cannot double-credit, including zero platform rows', async () => {
    const order = {
      id: ids.purchase,
      status: 'PENDING_SETTLEMENT',
      settleAt: now,
      sellerTeamId: ids.sellerTeam,
      priceCents: 1,
      sellerAmountCents: 1,
      platformAmountCents: 0,
      platformFeeBps: 2000,
    };
    const tx = {
      marketplaceCommerceState: {
        findUnique: vi.fn().mockResolvedValue({ ...state, writerMode: 'PAUSED' }),
      },
      purchase: {
        findUnique: vi.fn().mockResolvedValue(order),
        updateMany: vi.fn().mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 }),
      },
      pluginEntitlement: { findUnique: vi.fn().mockResolvedValue({ status: 'ACTIVE' }) },
      marketplacePlatformAccount: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn().mockResolvedValue({}),
      },
      team: { update: vi.fn().mockResolvedValue({}) },
      balanceLedger: { createMany: vi.fn().mockResolvedValue({ count: 3 }) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const top = {
      purchase: {
        findMany: vi.fn().mockResolvedValue([{ id: ids.purchase }, { id: ids.purchase }]),
      },
    };
    await expect(service(tx, top).commerce.settleDue(now)).resolves.toEqual({
      scanned: 2,
      settled: 1,
      skipped: 1,
    });
    expect(top.purchase.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          settlementVersion: 'SETTLEMENT_V2',
          status: 'PENDING_SETTLEMENT',
          settleAt: { lte: now },
        },
      })
    );
    expect(tx.team.update).toHaveBeenCalledTimes(1);
    expect(tx.marketplacePlatformAccount.update).toHaveBeenCalledWith({
      where: { id: 'marketplace-revenue' },
      data: { balanceCents: { increment: 0 } },
    });
    const entries = tx.balanceLedger.createMany.mock.calls[0][0].data;
    expect(entries).toHaveLength(3);
    expect(entries).toContainEqual(
      expect.objectContaining({
        marketplaceEntryKind: 'PLATFORM_SETTLEMENT_CREDIT',
        amountCents: 0,
      })
    );
  });
});

describe('MarketplaceCommerceService marketing management', () => {
  it('enforces team price permission, opaque price CAS, creates/cancels discounts, and audits mutations', async () => {
    const baseVersion = resolveMarketplacePrice({
      listPriceCents: 101,
      priceRevision: 1,
      discount: null,
      now,
    }).price_version;
    const tx = {
      marketplaceCommerceState: { findUnique: vi.fn().mockResolvedValue(state) },
      marketplaceListing: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ ...listing, package: { ownerTeamId: ids.buyerTeam } }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: vi
          .fn()
          .mockResolvedValue({ ...listing, priceCents: 120, priceRevision: 2 }),
      },
      marketplaceDiscount: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({
          id: ids.discount,
          packageId: ids.package,
          revision: 1,
          priceCents: 80,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: vi.fn(),
      },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const { commerce, auth } = service(tx);
    await expect(
      commerce.updateListingPrice(ids.buyerUser, ids.package, 120, `pv1.${'x'.repeat(43)}`, now)
    ).rejects.toMatchObject({ code: 'marketplace_price_changed' });
    expect(tx.marketplaceListing.updateMany).not.toHaveBeenCalled();
    await expect(
      commerce.createDiscount(
        ids.buyerUser,
        ids.package,
        {
          priceCents: 80,
          startsAt: new Date('2026-07-17T00:00:00.000Z'),
          endsAt: new Date('2026-07-20T00:00:00.000Z'),
          expectedPriceVersion: baseVersion,
        },
        now
      )
    ).resolves.toMatchObject({ id: ids.discount });
    expect(auth.ensurePermission).toHaveBeenCalledWith(ids.buyerUser, 'team.plugin.edit_price');
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'marketplace.discount.created' }),
    });

    const priceTx = {
      marketplaceCommerceState: { findUnique: vi.fn().mockResolvedValue(state) },
      marketplaceListing: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ ...listing, package: { ownerTeamId: ids.buyerTeam } }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: vi
          .fn()
          .mockResolvedValue({ ...listing, priceCents: 120, priceRevision: 2 }),
      },
      marketplaceDiscount: { findFirst: vi.fn().mockResolvedValue(null) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    await expect(
      service(priceTx).commerce.updateListingPrice(
        ids.buyerUser,
        ids.package,
        120,
        baseVersion,
        now
      )
    ).resolves.toMatchObject({
      listing: { priceCents: 120, priceRevision: 2 },
    });
    expect(priceTx.marketplaceListing.updateMany).toHaveBeenCalledWith({
      where: { id: listing.id, priceRevision: 1 },
      data: { priceCents: 120, priceRevision: { increment: 1 } },
    });

    const activeDiscount = {
      id: ids.discount,
      packageId: ids.package,
      revision: 1,
      priceCents: 80,
      startsAt: now,
      endsAt: new Date('2026-07-20T00:00:00.000Z'),
      canceledAt: null,
      package: { ownerTeamId: ids.buyerTeam, listing: { ...listing, package: undefined } },
    };
    const cancelTx = {
      marketplaceCommerceState: { findUnique: vi.fn().mockResolvedValue(state) },
      marketplaceDiscount: {
        findUnique: vi.fn().mockResolvedValue(activeDiscount),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: vi.fn().mockResolvedValue({ ...activeDiscount, canceledAt: now }),
      },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const discountVersion = resolveMarketplacePrice({
      listPriceCents: 101,
      priceRevision: 1,
      discount: activeDiscount,
      now,
    }).price_version;
    await expect(
      service(cancelTx).commerce.cancelDiscount(ids.buyerUser, ids.discount, discountVersion, now)
    ).resolves.toMatchObject({ canceledAt: now });
    expect(cancelTx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'marketplace.discount.canceled' }),
    });
  });

  it('requires platform admin and audits campaign create, publish, and cancel', async () => {
    const item = { packageId: ids.package, rank: 0 };
    const createTx = {
      marketplaceCommerceState: { findUnique: vi.fn().mockResolvedValue(state) },
      marketplaceListing: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ packageId: ids.package, currentReleaseId: ids.release }]),
      },
      marketplaceCampaign: {
        create: vi.fn().mockResolvedValue({ id: ids.campaign, items: [item] }),
      },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const created = service(createTx);
    await expect(
      created.commerce.createCampaign(ids.buyerUser, {
        slug: 'summer-picks',
        name: 'Summer Picks',
        description: '',
        startsAt: now,
        endsAt: new Date('2026-08-01T00:00:00.000Z'),
        items: [item],
      })
    ).resolves.toMatchObject({ id: ids.campaign });
    expect(created.auth.ensurePlatformAdmin).toHaveBeenCalledWith(ids.buyerUser);
    expect(createTx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'marketplace.campaign.created' }),
    });

    const publishTx = {
      marketplaceCommerceState: { findUnique: vi.fn().mockResolvedValue(state) },
      marketplaceCampaign: {
        findUnique: vi.fn().mockResolvedValue({ id: ids.campaign, status: 'DRAFT', items: [item] }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: vi
          .fn()
          .mockResolvedValue({ id: ids.campaign, status: 'PUBLISHED', items: [item] }),
      },
      marketplaceListing: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ packageId: ids.package, currentReleaseId: ids.release }]),
      },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    await expect(
      service(publishTx).commerce.publishCampaign(ids.buyerUser, ids.campaign, now)
    ).resolves.toMatchObject({ status: 'PUBLISHED' });
    expect(publishTx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'marketplace.campaign.published' }),
    });

    const cancelTx = {
      marketplaceCommerceState: { findUnique: vi.fn().mockResolvedValue(state) },
      marketplaceCampaign: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: vi.fn().mockResolvedValue({ id: ids.campaign, status: 'CANCELED' }),
      },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    await expect(
      service(cancelTx).commerce.cancelCampaign(ids.buyerUser, ids.campaign, now)
    ).resolves.toMatchObject({ status: 'CANCELED' });
    expect(cancelTx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'marketplace.campaign.canceled' }),
    });
  });
});
