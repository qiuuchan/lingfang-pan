import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { badRequest, notFound } from '../common';
import { assertIanaTimeZone } from '../automation/automation-schedule-time';
import { PrismaService } from '../prisma.service';
import { AuthService } from './auth.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_STATEMENT_RANGE_MS = 90 * DAY_MS;
const ORDER_STATUSES = ['PENDING_SETTLEMENT', 'REFUND_REQUESTED', 'SETTLED', 'REFUNDED'] as const;
type OrderStatus = typeof ORDER_STATUSES[number];

export type MarketplaceOrderQuery = {
  from?: string;
  to?: string;
  timezone?: string;
  packageId?: string;
  status?: OrderStatus;
  page?: number;
  pageSize?: number;
};

export type MarketplaceRefundAdminQuery = {
  from?: string;
  to?: string;
  status?: 'PENDING' | 'APPROVED' | 'REJECTED';
  page?: number;
  pageSize?: number;
};

const ORDER_ITEM_SELECT = {
  id: true,
  packageId: true,
  releaseId: true,
  currencyCode: true,
  listPriceCents: true,
  discountAmountCents: true,
  priceCents: true,
  platformFeeBps: true,
  platformAmountCents: true,
  sellerAmountCents: true,
  settlementVersion: true,
  priceVersion: true,
  campaignId: true,
  attributionKind: true,
  status: true,
  settleAt: true,
  refundableUntil: true,
  settledAt: true,
  refundedAt: true,
  createdAt: true,
  package: { select: { name: true } },
  plugin: { select: { name: true } },
  release: { select: { version: true } },
  refundRequest: {
    select: {
      id: true,
      purchaseId: true,
      status: true,
      reason: true,
      requestedAt: true,
      reviewedAt: true,
      reviewReason: true,
    },
  },
} as const;
type OrderItemRow = Prisma.PurchaseGetPayload<{ select: typeof ORDER_ITEM_SELECT }>;

@Injectable()
export class MarketplaceCommerceQueryService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  async buyerOrders(userId: string, input: MarketplaceOrderQuery = {}) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const { page, pageSize, skip } = normalizePage(input);
    const range = normalizeDateRange(input, false);
    const where: Prisma.PurchaseWhereInput = {
      buyerTeamId: membership.teamId,
      ...(input.packageId ? { packageId: input.packageId } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(range ? { createdAt: { gte: range.from, lt: range.to } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.purchase.findMany({
        where,
        select: ORDER_ITEM_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: pageSize,
      }),
      this.prisma.purchase.count({ where }),
    ]);
    return { items: rows.map(publicOrder), total, page, pageSize };
  }

  async sellerStatement(userId: string, input: MarketplaceOrderQuery = {}) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const { page, pageSize, skip } = normalizePage(input);
    const range = normalizeDateRange(input, true)!;
    const where: Prisma.PurchaseWhereInput = {
      sellerTeamId: membership.teamId,
      createdAt: { gte: range.from, lt: range.to },
      ...(input.packageId ? { packageId: input.packageId } : {}),
      ...(input.status ? { status: input.status } : {}),
    };
    const [rows, total, totals, ...statusTotals] = await Promise.all([
      this.prisma.purchase.findMany({
        where,
        select: ORDER_ITEM_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: pageSize,
      }),
      this.prisma.purchase.count({ where }),
      this.prisma.purchase.aggregate({
        where,
        _sum: {
          listPriceCents: true,
          discountAmountCents: true,
          priceCents: true,
          platformAmountCents: true,
          sellerAmountCents: true,
        },
      }),
      ...ORDER_STATUSES.map((status) => this.prisma.purchase.aggregate({
        where: { ...where, status },
        _count: { _all: true },
        _sum: { priceCents: true, sellerAmountCents: true },
      })),
    ]);
    return {
      range: publicRange(range),
      summary: {
        order_count: total,
        list_price_cents: totals._sum.listPriceCents ?? 0,
        discount_cents: totals._sum.discountAmountCents ?? 0,
        gross_cents: totals._sum.priceCents ?? 0,
        platform_cents: totals._sum.platformAmountCents ?? 0,
        seller_cents: totals._sum.sellerAmountCents ?? 0,
        by_status: Object.fromEntries(ORDER_STATUSES.map((status, index) => [status, {
          count: statusTotals[index]._count._all,
          gross_cents: statusTotals[index]._sum.priceCents ?? 0,
          seller_cents: statusTotals[index]._sum.sellerAmountCents ?? 0,
        }])),
      },
      items: rows.map(publicOrder),
      total,
      page,
      pageSize,
    };
  }

  async sellerStatementDaily(userId: string, input: MarketplaceOrderQuery = {}) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const range = normalizeDateRange(input, true)!;
    const baseWhere: Prisma.PurchaseWhereInput = {
      sellerTeamId: membership.teamId,
      ...(input.packageId ? { packageId: input.packageId } : {}),
      ...(input.status ? { status: input.status } : {}),
    };
    const rows = await this.prisma.purchase.findMany({
      where: {
        ...baseWhere,
        OR: [
          { createdAt: { gte: range.from, lt: range.to } },
          { settledAt: { gte: range.from, lt: range.to } },
          { refundedAt: { gte: range.from, lt: range.to } },
        ],
      },
      select: {
        createdAt: true,
        settledAt: true,
        refundedAt: true,
        priceCents: true,
        sellerAmountCents: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    const daily = new Map<string, ReturnType<typeof emptyDaily>>();
    for (const row of rows) {
      if (inRange(row.createdAt, range)) {
        const item = getDaily(daily, dateKey(row.createdAt, range.timeZone));
        item.order_created.count += 1;
        item.order_created.gross_cents += row.priceCents;
        item.order_created.seller_cents += row.sellerAmountCents;
      }
      if (row.settledAt && inRange(row.settledAt, range)) {
        const item = getDaily(daily, dateKey(row.settledAt, range.timeZone));
        item.settled.count += 1;
        item.settled.gross_cents += row.priceCents;
        item.settled.seller_cents += row.sellerAmountCents;
      }
      if (row.refundedAt && inRange(row.refundedAt, range)) {
        const item = getDaily(daily, dateKey(row.refundedAt, range.timeZone));
        item.refund_approved.count += 1;
        item.refund_approved.gross_cents += row.priceCents;
        item.refund_approved.seller_cents += row.sellerAmountCents;
      }
    }
    return {
      range: publicRange(range),
      items: [...daily.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([date, values]) => ({ date, ...values })),
    };
  }

  async adminRefundRequests(adminUserId: string, input: MarketplaceRefundAdminQuery = {}) {
    await this.auth.ensurePlatformAdmin(adminUserId);
    const { page, pageSize, skip } = normalizePage(input);
    const range = normalizeDateRange(input, false);
    const where: Prisma.MarketplaceRefundRequestWhereInput = {
      ...(input.status ? { status: input.status } : {}),
      ...(range ? { requestedAt: { gte: range.from, lt: range.to } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.marketplaceRefundRequest.findMany({
        where,
        select: {
          id: true,
          purchaseId: true,
          buyerTeamId: true,
          reason: true,
          requestedAt: true,
          status: true,
          reviewedAt: true,
          reviewReason: true,
          purchase: {
            select: {
              packageId: true,
              priceCents: true,
              currencyCode: true,
              status: true,
              refundableUntil: true,
              createdAt: true,
              package: { select: { name: true } },
            },
          },
          buyerTeam: { select: { name: true } },
        },
        orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }],
        skip,
        take: pageSize,
      }),
      this.prisma.marketplaceRefundRequest.count({ where }),
    ]);
    return { items: rows.map(publicRefundRequest), total, page, pageSize };
  }

  async adminRefundRequestDetail(adminUserId: string, requestId: string) {
    await this.auth.ensurePlatformAdmin(adminUserId);
    const row = await this.prisma.marketplaceRefundRequest.findUnique({
      where: { id: requestId },
      include: {
        requester: { select: { id: true, email: true, displayName: true } },
        reviewedBy: { select: { id: true, email: true, displayName: true } },
        buyerTeam: { select: { id: true, name: true } },
        purchase: {
          select: {
            ...ORDER_ITEM_SELECT,
            buyerTeamId: true,
            sellerTeamId: true,
            sellerTeam: { select: { name: true } },
          },
        },
      },
    });
    if (!row) throw notFound('退款申请不存在');
    return {
      ...publicRefundRequest({ ...row, purchase: row.purchase, buyerTeam: row.buyerTeam }),
      requester: row.requester,
      reviewed_by: row.reviewedBy,
      buyer_team: row.buyerTeam,
      seller_team: row.purchase.sellerTeam,
      order: publicOrder(row.purchase),
    };
  }

  async campaignReport(adminUserId: string, campaignId: string) {
    await this.auth.ensurePlatformAdmin(adminUserId);
    const campaign = await this.prisma.marketplaceCampaign.findUnique({
      where: { id: campaignId },
      include: { items: { include: { package: { select: { name: true } } }, orderBy: { rank: 'asc' } } },
    });
    if (!campaign) throw notFound('市场活动不存在');
    const orders = await this.prisma.purchase.findMany({
      where: { campaignId, attributionKind: 'CAMPAIGN', campaignItemId: { not: null } },
      select: { campaignItemId: true, packageId: true, status: true, priceCents: true, createdAt: true, refundedAt: true },
    });
    const attributed = summarizeCampaignOrders(orders);
    const byItem = new Map<string, typeof orders>();
    for (const order of orders) {
      if (!order.campaignItemId) continue;
      const rows = byItem.get(order.campaignItemId) ?? [];
      rows.push(order);
      byItem.set(order.campaignItemId, rows);
    }
    return {
      campaign: {
        id: campaign.id,
        slug: campaign.slug,
        name: campaign.name,
        description: campaign.description,
        status: campaign.status,
        starts_at: campaign.startsAt.toISOString(),
        ends_at: campaign.endsAt.toISOString(),
        published_at: campaign.publishedAt?.toISOString() ?? null,
        canceled_at: campaign.canceledAt?.toISOString() ?? null,
      },
      attributed,
      items: campaign.items.map((item) => ({
        package_id: item.packageId,
        package_name: item.package.name,
        rank: item.rank,
        campaign_item_id: item.id,
        ...summarizeCampaignOrders(byItem.get(item.id) ?? []),
      })),
    };
  }
}

function normalizePage(input: { page?: number; pageSize?: number }) {
  const page = Math.max(1, Math.floor(Number(input.page) || 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(Number(input.pageSize) || 20)));
  return { page, pageSize, skip: (page - 1) * pageSize };
}

function normalizeDateRange(input: { from?: string; to?: string; timezone?: string }, defaults: boolean) {
  if (!defaults && !input.from && !input.to) return null;
  const to = input.to ? new Date(input.to) : new Date();
  const from = input.from ? new Date(input.from) : new Date(to.getTime() - 30 * DAY_MS);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) throw badRequest('市场对账日期范围无效');
  if (to.getTime() - from.getTime() > MAX_STATEMENT_RANGE_MS) throw badRequest('市场对账单次最多查询 90 天');
  const timeZone = input.timezone?.trim() || 'UTC';
  try { assertIanaTimeZone(timeZone); } catch { throw badRequest('市场对账时区无效'); }
  return { from, to, timeZone };
}

function publicRange(range: { from: Date; to: Date; timeZone: string }) {
  return { from: range.from.toISOString(), to: range.to.toISOString(), timezone: range.timeZone };
}

function publicOrder(row: OrderItemRow) {
  return {
    id: row.id,
    package_id: row.packageId,
    package_name: row.package?.name ?? row.plugin?.name ?? '未知插件',
    release_id: row.releaseId,
    release_version: row.release?.version ?? null,
    currency_code: row.currencyCode,
    list_price_cents: row.listPriceCents,
    discount_cents: row.discountAmountCents,
    price_cents: row.priceCents,
    platform_fee_bps: row.platformFeeBps,
    platform_cents: row.platformAmountCents,
    seller_cents: row.sellerAmountCents,
    settlement_version: row.settlementVersion,
    price_version: row.priceVersion,
    campaign_id: row.campaignId,
    attribution_kind: row.attributionKind,
    status: row.status,
    created_at: row.createdAt.toISOString(),
    settle_at: row.settleAt?.toISOString() ?? null,
    refundable_until: row.refundableUntil?.toISOString() ?? null,
    settled_at: row.settledAt?.toISOString() ?? null,
    refunded_at: row.refundedAt?.toISOString() ?? null,
    refund_request: row.refundRequest ? {
      id: row.refundRequest.id,
      purchase_id: row.refundRequest.purchaseId,
      status: row.refundRequest.status,
      reason: row.refundRequest.reason,
      requested_at: row.refundRequest.requestedAt.toISOString(),
      reviewed_at: row.refundRequest.reviewedAt?.toISOString() ?? null,
      review_reason: row.refundRequest.reviewReason,
    } : null,
  };
}

function publicRefundRequest(row: {
  id: string;
  purchaseId: string;
  buyerTeamId: string;
  reason: string;
  requestedAt: Date;
  status: string;
  reviewedAt: Date | null;
  reviewReason: string;
  buyerTeam: { name: string };
  purchase: {
    packageId: string | null;
    package: { name: string } | null;
    priceCents: number;
    currencyCode: string;
    status: string;
    refundableUntil: Date | null;
    createdAt: Date;
  };
}) {
  return {
    id: row.id,
    purchase_id: row.purchaseId,
    buyer_team_id: row.buyerTeamId,
    buyer_team_name: row.buyerTeam?.name ?? '',
    package_id: row.purchase.packageId,
    package_name: row.purchase.package?.name ?? '未知插件',
    price_cents: row.purchase.priceCents,
    currency_code: row.purchase.currencyCode,
    order_status: row.purchase.status,
    reason: row.reason,
    requested_at: row.requestedAt.toISOString(),
    status: row.status,
    reviewed_at: row.reviewedAt?.toISOString() ?? null,
    review_reason: row.reviewReason,
    refundable_until: row.purchase.refundableUntil?.toISOString() ?? null,
    order_created_at: row.purchase.createdAt.toISOString(),
  };
}

function inRange(value: Date, range: { from: Date; to: Date }) {
  return value >= range.from && value < range.to;
}

function dateKey(value: Date, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US-u-ca-iso8601', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function emptyDaily() {
  return {
    order_created: { count: 0, gross_cents: 0, seller_cents: 0 },
    refund_approved: { count: 0, gross_cents: 0, seller_cents: 0 },
    settled: { count: 0, gross_cents: 0, seller_cents: 0 },
  };
}

function getDaily(map: Map<string, ReturnType<typeof emptyDaily>>, key: string) {
  const existing = map.get(key);
  if (existing) return existing;
  const created = emptyDaily();
  map.set(key, created);
  return created;
}

function summarizeCampaignOrders(rows: Array<{ status: string; priceCents: number }>) {
  const refunded = rows.filter((row) => row.status === 'REFUNDED');
  return {
    attributed_order_count: rows.length,
    attributed_gross_cents: rows.reduce((sum, row) => sum + row.priceCents, 0),
    refunded_order_count: refunded.length,
    refunded_gross_cents: refunded.reduce((sum, row) => sum + row.priceCents, 0),
    net_order_count: rows.length - refunded.length,
    net_gross_cents: rows.reduce((sum, row) => sum + (row.status === 'REFUNDED' ? 0 : row.priceCents), 0),
  };
}
