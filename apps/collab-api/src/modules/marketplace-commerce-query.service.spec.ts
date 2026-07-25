import { describe, expect, it, vi } from 'vitest';
import { MarketplaceCommerceQueryService } from './marketplace-commerce-query.service';

const now = new Date('2026-07-16T00:00:00.000Z');

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: 'purchase-1', packageId: 'package-1', releaseId: 'release-1', currencyCode: 'CNY',
    listPriceCents: 100, discountAmountCents: 10, priceCents: 90, platformFeeBps: 2000,
    platformAmountCents: 18, sellerAmountCents: 72, settlementVersion: 'SETTLEMENT_V2',
    priceVersion: `pv1.${'a'.repeat(43)}`, campaignId: null, attributionKind: 'ORGANIC',
    status: 'PENDING_SETTLEMENT', createdAt: now, settleAt: new Date('2026-07-23T00:00:00.000Z'),
    refundableUntil: new Date('2026-07-23T00:00:00.000Z'), settledAt: null, refundedAt: null,
    package: { name: '图片插件' }, release: { version: '1.0.0' }, refundRequest: null,
    ...overrides,
  };
}

function service(prismaOverrides: Record<string, unknown> = {}) {
  const prisma = {
    purchase: {
      findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0),
      aggregate: vi.fn().mockResolvedValue({ _count: { _all: 0 }, _sum: {} }),
    },
    marketplaceRefundRequest: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0), findUnique: vi.fn() },
    marketplaceCampaign: { findUnique: vi.fn() },
    ...prismaOverrides,
  };
  const auth = { ensureCurrentTeam: vi.fn().mockResolvedValue({ teamId: 'team-1' }), ensurePlatformAdmin: vi.fn().mockResolvedValue(undefined) };
  return { queries: new MarketplaceCommerceQueryService(prisma as never, auth as never), prisma, auth };
}

describe('MarketplaceCommerceQueryService', () => {
  it('lists only the current buyer team and projects refund-safe order fields', async () => {
    const purchase = { findMany: vi.fn().mockResolvedValue([order()]), count: vi.fn().mockResolvedValue(1), aggregate: vi.fn() };
    const { queries } = service({ purchase });
    const result = await queries.buyerOrders('buyer-user', { page: 1, pageSize: 10 });
    expect(purchase.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { buyerTeamId: 'team-1' }, skip: 0, take: 10 }));
    expect(result).toMatchObject({ total: 1, items: [{ id: 'purchase-1', package_name: '图片插件', price_cents: 90, status: 'PENDING_SETTLEMENT' }] });
    expect(result.items[0]).not.toHaveProperty('buyer_user_id');
  });

  it('builds seller-scoped statement totals from the same frozen order filter', async () => {
    const purchase = {
      findMany: vi.fn().mockResolvedValue([order()]),
      count: vi.fn().mockResolvedValue(1),
      aggregate: vi.fn()
        .mockResolvedValueOnce({ _sum: { listPriceCents: 100, discountAmountCents: 10, priceCents: 90, platformAmountCents: 18, sellerAmountCents: 72 } })
        .mockResolvedValueOnce({ _count: { _all: 1 }, _sum: { priceCents: 90, sellerAmountCents: 72 } })
        .mockResolvedValue({ _count: { _all: 0 }, _sum: { priceCents: null, sellerAmountCents: null } }),
    };
    const { queries } = service({ purchase });
    const result = await queries.sellerStatement('seller-user', { from: '2026-07-01T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z', timezone: 'Asia/Shanghai' });
    expect(purchase.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ sellerTeamId: 'team-1' }) }));
    expect(result.summary).toMatchObject({ order_count: 1, gross_cents: 90, platform_cents: 18, seller_cents: 72, by_status: { PENDING_SETTLEMENT: { count: 1 } } });
  });

  it('groups creation, settlement and refund instants by the requested IANA timezone', async () => {
    const purchase = { findMany: vi.fn().mockResolvedValue([order({
      createdAt: new Date('2026-07-15T16:30:00.000Z'),
      settledAt: new Date('2026-07-16T16:30:00.000Z'),
      refundedAt: new Date('2026-07-17T16:30:00.000Z'),
    })]), count: vi.fn(), aggregate: vi.fn() };
    const { queries } = service({ purchase });
    const result = await queries.sellerStatementDaily('seller-user', { from: '2026-07-15T00:00:00.000Z', to: '2026-07-19T00:00:00.000Z', timezone: 'Asia/Shanghai' });
    expect(result.items.map((item) => item.date)).toEqual(['2026-07-16', '2026-07-17', '2026-07-18']);
    expect(result.items[0].order_created).toMatchObject({ count: 1, gross_cents: 90 });
    expect(result.items[1].settled).toMatchObject({ count: 1, seller_cents: 72 });
    expect(result.items[2].refund_approved).toMatchObject({ count: 1, gross_cents: 90 });
  });

  it('admin refund list is paged and requires the platform-admin boundary', async () => {
    const refund = {
      id: 'refund-1', purchaseId: 'purchase-1', buyerTeamId: 'team-1', reason: '误购', requestedAt: now,
      status: 'PENDING', reviewedAt: null, reviewReason: '', buyerTeam: { name: '买家团队' },
      purchase: { packageId: 'package-1', package: { name: '图片插件' }, priceCents: 90, currencyCode: 'CNY', status: 'REFUND_REQUESTED', refundableUntil: new Date('2026-07-23T00:00:00.000Z'), createdAt: now },
    };
    const marketplaceRefundRequest = { findMany: vi.fn().mockResolvedValue([refund]), count: vi.fn().mockResolvedValue(1), findUnique: vi.fn() };
    const { queries, auth } = service({ marketplaceRefundRequest });
    const result = await queries.adminRefundRequests('admin-user', { status: 'PENDING', page: 2, pageSize: 5 });
    expect(auth.ensurePlatformAdmin).toHaveBeenCalledWith('admin-user');
    expect(marketplaceRefundRequest.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: 'PENDING' }, skip: 5, take: 5 }));
    expect(result.items[0]).toMatchObject({ id: 'refund-1', buyer_team_name: '买家团队', order_status: 'REFUND_REQUESTED' });
  });

  it('campaign report counts attributed, refunded and net orders per package', async () => {
    const marketplaceCampaign = { findUnique: vi.fn().mockResolvedValue({
      id: 'campaign-1', slug: 'summer', name: '夏日活动', description: '', status: 'PUBLISHED',
      startsAt: now, endsAt: new Date('2026-08-01T00:00:00.000Z'), publishedAt: now, canceledAt: null,
      items: [{ id: 'campaign-item-1', packageId: 'package-1', rank: 0, package: { name: '图片插件' } }],
    }) };
    const purchase = { findMany: vi.fn().mockResolvedValue([
      { campaignItemId: 'campaign-item-1', packageId: 'package-1', status: 'SETTLED', priceCents: 90, createdAt: now, refundedAt: null },
      { campaignItemId: 'campaign-item-1', packageId: 'package-1', status: 'REFUNDED', priceCents: 90, createdAt: now, refundedAt: now },
    ]), count: vi.fn(), aggregate: vi.fn() };
    const { queries } = service({ marketplaceCampaign, purchase });
    const result = await queries.campaignReport('admin-user', 'campaign-1');
    expect(result.attributed).toMatchObject({ attributed_order_count: 2, refunded_order_count: 1, net_order_count: 1, net_gross_cents: 90 });
    expect(result.items[0]).toMatchObject({ package_name: '图片插件', attributed_order_count: 2, net_order_count: 1 });
  });
});
