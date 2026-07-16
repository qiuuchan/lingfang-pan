import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  MarketplacePurchaseResponse,
  splitMarketplacePrice,
  type MarketplacePurchaseResponse as MarketplacePurchaseResponseValue,
} from '@lingfang/contract';
import { AppError, badRequest, conflict, forbidden, insufficientBalance, notFound } from '../common';
import { PrismaService } from '../prisma.service';
import { AuthService } from './auth.service';
import { PLUGIN_AI_POLICY_VERSION } from './plugin-ai-policy';
import { purchaseJournal, refundJournal, resolveMarketplacePrice, settlementJournal, validateMarketplaceDiscount } from './marketplace-commerce-calculator';

const CLEARING_ACCOUNT_ID = 'marketplace-clearing';
const REVENUE_ACCOUNT_ID = 'marketplace-revenue';
const REFUND_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const CAMPAIGN_TOKEN_TTL_MS = 15 * 60 * 1000;
type CampaignAttributionPayload = { v: 1; campaign_id: string; campaign_item_id: string; package_id: string; listing_id: string; team_id: string; user_id: string; session_id: string; issued_at: string; expires_at: string };

@Injectable()
export class MarketplaceCommerceService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  async purchaseDisposition(): Promise<'LEGACY' | 'V2' | 'BLOCKED'> {
    const state = await this.prisma.marketplaceCommerceState.findUnique({ where: { id: 'singleton' } });
    if (!state || state.writerMode === 'LEGACY') return 'LEGACY';
    if (state.writerMode === 'SETTLEMENT_V2' && state.settlementV2ActivatedAt) return 'V2';
    return 'BLOCKED';
  }

  async issueCampaignToken(userId: string, campaignId: string, packageId: string, now = new Date()) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const campaign = await this.prisma.marketplaceCampaign.findFirst({ where: { id: campaignId, status: 'PUBLISHED', startsAt: { lte: now }, endsAt: { gt: now } }, include: { items: { where: { packageId } } } });
    const item = campaign?.items[0];
    const listing = item && await this.prisma.marketplaceListing.findFirst({ where: { packageId, status: 'ACTIVE', currentReleaseId: { not: null } }, select: { id: true } });
    if (!campaign || !item || !listing) throw notFound('活动商品不存在或不在有效期');
    const expiresAt = new Date(Math.min(campaign.endsAt.getTime(), now.getTime() + CAMPAIGN_TOKEN_TTL_MS));
    const payload: CampaignAttributionPayload = { v: 1, campaign_id: campaign.id, campaign_item_id: item.id, package_id: packageId, listing_id: listing.id, team_id: membership.teamId, user_id: userId, session_id: randomUUID(), issued_at: now.toISOString(), expires_at: expiresAt.toISOString() };
    return { campaign_token: this.signCampaignToken(payload), expires_at: payload.expires_at };
  }

  async purchaseV2(userId: string, input: { packageId: string; expectedPriceVersion?: string; idempotencyKey?: string; campaignToken?: string; now?: Date }): Promise<MarketplacePurchaseResponseValue> {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const now = input.now ?? new Date();
    const key = input.idempotencyKey?.trim() || null;
    if (key && key.length > 256) throw badRequest('购买幂等键过长');
    const requestDigest = createHash('sha256').update(JSON.stringify({ package_id: input.packageId, expected_price_version: input.expectedPriceVersion ?? null, campaign_token_sha256: input.campaignToken ? createHash('sha256').update(input.campaignToken).digest('hex') : null })).digest('hex');

    return this.serializable(async (tx) => {
      const state = await tx.marketplaceCommerceState.findUnique({ where: { id: 'singleton' } });
      if (!state || state.writerMode !== 'SETTLEMENT_V2' || !state.settlementV2ActivatedAt) throw new AppError(503, 'marketplace_commerce_paused', '市场结算暂未开放新订单');
      if (key) {
        const previous = await tx.marketplacePurchaseIdempotency.findUnique({ where: { buyerTeamId_key: { buyerTeamId: membership.teamId, key } } });
        if (previous) {
          if (previous.packageId !== input.packageId || previous.requestDigest !== requestDigest) throw new AppError(409, 'marketplace_idempotency_conflict', '幂等键已用于不同购买请求');
          return MarketplacePurchaseResponse.parse(previous.responseJson);
        }
      }

      const listing = await tx.marketplaceListing.findUnique({
        where: { packageId: input.packageId },
        include: {
          package: { select: { ownerTeamId: true, authorUserId: true, governanceStatus: true } },
          currentRelease: { select: { id: true, status: true, marketReviewStatus: true, aiPolicyVersion: true, aiPolicyStatus: true } },
        },
      });
      if (!listing || listing.status !== 'ACTIVE' || !listing.currentRelease || listing.package.governanceStatus !== 'ACTIVE') throw notFound('市场插件不存在');
      if (listing.package.ownerTeamId === membership.teamId) throw forbidden('不能购买本团队自己的插件');
      if (!listing.package.authorUserId) throw conflict('插件作者信息缺失');
      if (listing.currentRelease.status !== 'PUBLISHED' || listing.currentRelease.marketReviewStatus !== 'APPROVED'
        || listing.currentRelease.aiPolicyVersion !== PLUGIN_AI_POLICY_VERSION || listing.currentRelease.aiPolicyStatus !== 'PASSED') throw conflict('市场当前发行版不可购买');
      const attribution = input.campaignToken ? await this.validateCampaignTokenTx(tx, input.campaignToken, { userId, teamId: membership.teamId, packageId: input.packageId, listingId: listing.id, now }) : null;

      const discount = await tx.marketplaceDiscount.findFirst({ where: { packageId: input.packageId, canceledAt: null, endsAt: { gt: now } }, orderBy: [{ startsAt: 'asc' }, { revision: 'desc' }] });
      const price = resolveMarketplacePrice({ listPriceCents: listing.priceCents, priceRevision: listing.priceRevision, discount, now });
      if (input.expectedPriceVersion && input.expectedPriceVersion !== price.price_version) throw new AppError(409, 'marketplace_price_changed', '插件价格已变化，请刷新后重试');
      const existingEntitlement = await tx.pluginEntitlement.findUnique({ where: { teamId_packageId: { teamId: membership.teamId, packageId: input.packageId } } });
      if (existingEntitlement?.status === 'ACTIVE') {
        const response = MarketplacePurchaseResponse.parse({ entitled: true, entitlement_id: existingEntitlement.id, purchase_id: existingEntitlement.purchaseId, result_kind: 'ENTITLED_EXISTING', order: null });
        if (key) await tx.marketplacePurchaseIdempotency.create({ data: {
          buyerTeamId: membership.teamId, key, packageId: input.packageId, requestDigest, resultKind: 'ENTITLED_EXISTING', purchaseId: existingEntitlement.purchaseId,
          entitlementId: existingEntitlement.id, responseJson: response as unknown as Prisma.InputJsonValue,
        } });
        return response;
      }

      const split = splitMarketplacePrice(price.price_cents);
      const freeAcquisition = price.price_cents === 0;
      const settleAt = freeAcquisition ? now : new Date(now.getTime() + REFUND_WINDOW_MS);
      const order = await tx.purchase.create({ data: {
        packageId: input.packageId, releaseId: listing.currentRelease.id, buyerUserId: userId, buyerTeamId: membership.teamId,
        sellerUserId: listing.package.authorUserId, sellerTeamId: listing.package.ownerTeamId, priceCents: price.price_cents,
        currencyCode: 'CNY', listPriceCents: price.list_price_cents, discountAmountCents: price.discount_amount_cents,
        platformFeeBps: split.platform_fee_bps, platformAmountCents: split.platform_amount_cents, sellerAmountCents: split.seller_amount_cents,
        settlementVersion: 'SETTLEMENT_V2', priceRevision: price.internal_price_revision, priceVersion: price.price_version,
        discountId: price.discount?.id ?? null, discountRevision: price.discount?.revision ?? null, attributionKind: attribution ? 'CAMPAIGN' : 'ORGANIC', campaignId: attribution?.campaign_id ?? null, campaignItemId: attribution?.campaign_item_id ?? null,
        status: freeAcquisition ? 'SETTLED' : 'PENDING_SETTLEMENT', settleAt, refundableUntil: settleAt,
        settledAt: freeAcquisition ? now : null, idempotencyKey: key,
      } });

      let entitlement;
      if (existingEntitlement?.status === 'REVOKED') {
        const claimed = await tx.pluginEntitlement.updateMany({ where: { id: existingEntitlement.id, status: 'REVOKED' }, data: { status: 'ACTIVE', purchaseId: order.id, activatedAt: now, revokedAt: null, revokedByPurchaseId: null, revokedReason: '' } });
        if (claimed.count !== 1) throw conflict('插件权益状态已变化');
        entitlement = await tx.pluginEntitlement.findUniqueOrThrow({ where: { id: existingEntitlement.id } });
      } else {
        entitlement = await tx.pluginEntitlement.create({ data: { teamId: membership.teamId, packageId: input.packageId, purchaseId: order.id, status: 'ACTIVE', activatedAt: now } });
      }

      if (!freeAcquisition) {
        const debit = await tx.team.updateMany({ where: { id: membership.teamId, balanceCents: { gte: price.price_cents } }, data: { balanceCents: { decrement: price.price_cents } } });
        if (debit.count !== 1) throw insufficientBalance();
        const clearing = await tx.marketplacePlatformAccount.updateMany({ where: { id: CLEARING_ACCOUNT_ID, kind: 'MARKETPLACE_CLEARING', currencyCode: 'CNY' }, data: { balanceCents: { increment: price.price_cents } } });
        if (clearing.count !== 1) throw conflict('市场清算账户不可用');
        await tx.balanceLedger.createMany({ data: purchaseJournal(price.price_cents).map((entry) => ({
          teamId: entry.entry_kind === 'BUYER_PURCHASE_DEBIT' ? membership.teamId : null,
          platformAccountId: entry.entry_kind === 'PLATFORM_PURCHASE_CLEARING_CREDIT' ? CLEARING_ACCOUNT_ID : null,
          purchaseId: order.id, marketplaceEntryKind: entry.entry_kind, amountCents: entry.amount_cents,
          direction: entry.direction, reason: entry.entry_kind.toLowerCase(), actorUserId: userId,
        })) });
      }

      const response = MarketplacePurchaseResponse.parse({
        entitled: true, entitlement_id: entitlement.id, purchase_id: order.id, result_kind: 'ORDER_CREATED',
        order: {
          id: order.id, package_id: input.packageId, release_id: listing.currentRelease.id, buyer_team_id: membership.teamId,
          seller_team_id: listing.package.ownerTeamId, buyer_user_id: userId, currency_code: 'CNY', list_price_cents: price.list_price_cents,
          discount_amount_cents: price.discount_amount_cents, price_cents: price.price_cents, platform_fee_bps: split.platform_fee_bps,
          platform_amount_cents: split.platform_amount_cents, seller_amount_cents: split.seller_amount_cents, settlement_version: 'SETTLEMENT_V2',
          price_version: price.price_version, discount_id: price.discount?.id ?? null, discount_revision: price.discount?.revision ?? null,
          campaign_id: attribution?.campaign_id ?? null, attribution_kind: attribution ? 'CAMPAIGN' : 'ORGANIC', status: freeAcquisition ? 'SETTLED' : 'PENDING_SETTLEMENT', created_at: order.createdAt.toISOString(),
          settle_at: settleAt.toISOString(), refundable_until: settleAt.toISOString(), settled_at: freeAcquisition ? now.toISOString() : null, refunded_at: null,
        },
      });
      if (key) await tx.marketplacePurchaseIdempotency.create({ data: {
        buyerTeamId: membership.teamId, key, packageId: input.packageId, requestDigest, resultKind: 'ORDER_CREATED', purchaseId: order.id,
        entitlementId: entitlement.id, responseJson: response as unknown as Prisma.InputJsonValue,
      } });
      await tx.auditLog.create({ data: { actorUserId: userId, action: 'marketplace.order.created', targetType: 'Purchase', targetId: order.id, metadata: { packageId: input.packageId, releaseId: listing.currentRelease.id, priceCents: order.priceCents } } });
      const finalState = await tx.marketplaceCommerceState.findUnique({ where: { id: 'singleton' } });
      if (!finalState || finalState.writerMode !== 'SETTLEMENT_V2' || finalState.writerGeneration !== state.writerGeneration) throw new AppError(503, 'marketplace_commerce_paused', '市场结算模式已变化');
      return response;
    });
  }

  async requestRefund(userId: string, purchaseId: string, reason: string, now = new Date()) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const normalized = reason.trim();
    if (!normalized || normalized.length > 1000) throw badRequest('退款原因长度无效');
    return this.serializable(async (tx) => {
      const order = await tx.purchase.findUnique({ where: { id: purchaseId }, include: { refundRequest: true } });
      if (!order || order.buyerTeamId !== membership.teamId || order.settlementVersion !== 'SETTLEMENT_V2') throw notFound('订单不存在');
      if (order.refundRequest) return order.refundRequest;
      if (order.status !== 'PENDING_SETTLEMENT' || !order.refundableUntil || now >= order.refundableUntil) throw new AppError(409, 'marketplace_refund_window_closed', '订单已超过退款申请期限');
      const request = await tx.marketplaceRefundRequest.create({ data: { purchaseId, requesterUserId: userId, buyerTeamId: membership.teamId, reason: normalized, requestedAt: now } });
      const claimed = await tx.purchase.updateMany({ where: { id: purchaseId, status: 'PENDING_SETTLEMENT' }, data: { status: 'REFUND_REQUESTED' } });
      if (claimed.count !== 1) throw new AppError(409, 'marketplace_refund_state_conflict', '订单退款状态已变化');
      await tx.auditLog.create({ data: { actorUserId: userId, action: 'marketplace.refund.requested', targetType: 'Purchase', targetId: purchaseId, metadata: { requestId: request.id } } });
      return request;
    });
  }

  async approveRefund(adminUserId: string, requestId: string, reviewReason = '', now = new Date()) {
    await this.auth.ensurePlatformAdmin(adminUserId);
    return this.reviewRefund(adminUserId, requestId, true, reviewReason, now);
  }

  async rejectRefund(adminUserId: string, requestId: string, reviewReason = '', now = new Date()) {
    await this.auth.ensurePlatformAdmin(adminUserId);
    return this.reviewRefund(adminUserId, requestId, false, reviewReason, now);
  }

  async settleDue(now = new Date(), limit = 100): Promise<{ scanned: number; settled: number; skipped: number }> {
    const ids = await this.prisma.purchase.findMany({ where: { settlementVersion: 'SETTLEMENT_V2', status: 'PENDING_SETTLEMENT', settleAt: { lte: now } }, orderBy: { settleAt: 'asc' }, take: Math.max(1, Math.min(limit, 100)), select: { id: true } });
    let settled = 0;
    for (const row of ids) if (await this.settleOne(row.id, now)) settled += 1;
    return { scanned: ids.length, settled, skipped: ids.length - settled };
  }

  async triggerSettlement(adminUserId: string, now = new Date(), limit = 100) {
    await this.auth.ensurePlatformAdmin(adminUserId);
    return this.settleDue(now, limit);
  }

  async updateListingPrice(userId: string, packageId: string, priceCents: number, expectedPriceVersion: string, now = new Date()) {
    await this.auth.ensurePermission(userId, 'team.plugin.edit_price');
    const membership = await this.auth.ensureCurrentTeam(userId);
    if (!Number.isInteger(priceCents) || priceCents < 0) throw badRequest('插件价格无效');
    return this.serializable(async (tx) => {
      await this.ensureMarketingWriter(tx);
      const listing = await tx.marketplaceListing.findUnique({ where: { packageId }, include: { package: { select: { ownerTeamId: true } } } });
      if (!listing || listing.package.ownerTeamId !== membership.teamId) throw notFound('市场插件不存在');
      const discount = await tx.marketplaceDiscount.findFirst({ where: { packageId, canceledAt: null, endsAt: { gt: now } }, orderBy: [{ startsAt: 'asc' }, { revision: 'desc' }] });
      this.assertPriceVersion(listing, discount, now, expectedPriceVersion);
      if (discount) throw conflict('请先取消未结束的限时折扣');
      const claimed = await tx.marketplaceListing.updateMany({ where: { id: listing.id, priceRevision: listing.priceRevision }, data: { priceCents, priceRevision: { increment: 1 } } });
      if (claimed.count !== 1) throw new AppError(409, 'marketplace_price_changed', '插件价格已变化，请刷新后重试');
      const updated = await tx.marketplaceListing.findUniqueOrThrow({ where: { id: listing.id } });
      const projection = resolveMarketplacePrice({ listPriceCents: updated.priceCents, priceRevision: updated.priceRevision, discount: null, now });
      await tx.auditLog.create({ data: { actorUserId: userId, action: 'marketplace.price.updated', targetType: 'PluginPackage', targetId: packageId, metadata: { priceCents, priceRevision: updated.priceRevision } } });
      return { listing: updated, price: projection };
    });
  }

  async createDiscount(userId: string, packageId: string, input: { priceCents: number; startsAt: Date; endsAt: Date; expectedPriceVersion: string }, now = new Date()) {
    await this.auth.ensurePermission(userId, 'team.plugin.edit_price');
    const membership = await this.auth.ensureCurrentTeam(userId);
    return this.serializable(async (tx) => {
      await this.ensureMarketingWriter(tx);
      const listing = await tx.marketplaceListing.findUnique({ where: { packageId }, include: { package: { select: { ownerTeamId: true } } } });
      if (!listing || listing.status !== 'ACTIVE' || listing.package.ownerTeamId !== membership.teamId) throw notFound('市场插件不存在');
      const current = await tx.marketplaceDiscount.findFirst({ where: { packageId, canceledAt: null, endsAt: { gt: now } }, orderBy: [{ startsAt: 'asc' }, { revision: 'desc' }] });
      this.assertPriceVersion(listing, current, now, input.expectedPriceVersion);
      try { validateMarketplaceDiscount(listing.priceCents, { id: '00000000-0000-4000-8000-000000000000', revision: 1, priceCents: input.priceCents, startsAt: input.startsAt, endsAt: input.endsAt, canceledAt: null }); }
      catch { throw new AppError(400, 'marketplace_discount_invalid', '限时折扣价格或时间无效'); }
      const overlap = await tx.marketplaceDiscount.findFirst({ where: { packageId, canceledAt: null, startsAt: { lt: input.endsAt }, endsAt: { gt: input.startsAt } } });
      if (overlap) throw new AppError(409, 'marketplace_discount_overlap', '限时折扣时间与现有折扣重叠');
      const latest = await tx.marketplaceDiscount.findFirst({ where: { packageId }, orderBy: { revision: 'desc' }, select: { revision: true } });
      const discount = await tx.marketplaceDiscount.create({ data: { packageId, revision: (latest?.revision ?? 0) + 1, priceCents: input.priceCents, startsAt: input.startsAt, endsAt: input.endsAt, createdByUserId: userId } });
      await tx.auditLog.create({ data: { actorUserId: userId, action: 'marketplace.discount.created', targetType: 'MarketplaceDiscount', targetId: discount.id, metadata: { packageId, revision: discount.revision, priceCents: discount.priceCents } } });
      return discount;
    });
  }

  async cancelDiscount(userId: string, discountId: string, expectedPriceVersion: string, now = new Date()) {
    await this.auth.ensurePermission(userId, 'team.plugin.edit_price');
    const membership = await this.auth.ensureCurrentTeam(userId);
    return this.serializable(async (tx) => {
      await this.ensureMarketingWriter(tx);
      const discount = await tx.marketplaceDiscount.findUnique({ where: { id: discountId }, include: { package: { include: { listing: true } } } });
      const listing = discount?.package.listing;
      if (!discount || !listing || discount.package.ownerTeamId !== membership.teamId) throw notFound('限时折扣不存在');
      if (discount.canceledAt) return discount;
      this.assertPriceVersion(listing, discount, now, expectedPriceVersion);
      const claimed = await tx.marketplaceDiscount.updateMany({ where: { id: discountId, canceledAt: null }, data: { canceledAt: now, canceledByUserId: userId } });
      if (claimed.count !== 1) throw conflict('限时折扣状态已变化');
      await tx.auditLog.create({ data: { actorUserId: userId, action: 'marketplace.discount.canceled', targetType: 'MarketplaceDiscount', targetId: discountId, metadata: { packageId: discount.packageId } } });
      return tx.marketplaceDiscount.findUniqueOrThrow({ where: { id: discountId } });
    });
  }

  async createCampaign(adminUserId: string, input: { slug: string; name: string; description: string; startsAt: Date; endsAt: Date; items: Array<{ packageId: string; rank: number }> }) {
    await this.auth.ensurePlatformAdmin(adminUserId);
    if (!input.slug.trim() || !input.name.trim() || input.startsAt >= input.endsAt) throw badRequest('精选活动信息无效');
    const packageIds = input.items.map((item) => item.packageId);
    if (new Set(packageIds).size !== packageIds.length || new Set(input.items.map((item) => item.rank)).size !== input.items.length) throw badRequest('精选活动插件或排序重复');
    return this.serializable(async (tx) => {
      await this.ensureMarketingWriter(tx);
      const listings = await tx.marketplaceListing.findMany({ where: { packageId: { in: packageIds }, status: 'ACTIVE' }, select: { packageId: true, currentReleaseId: true } });
      if (listings.length !== packageIds.length || listings.some((row) => !row.currentReleaseId)) throw badRequest('精选活动只能包含已上架插件');
      const campaign = await tx.marketplaceCampaign.create({ data: { slug: input.slug.trim(), name: input.name.trim(), description: input.description.trim(), startsAt: input.startsAt, endsAt: input.endsAt, createdByUserId: adminUserId, items: { create: input.items.map((item) => ({ packageId: item.packageId, rank: item.rank })) } }, include: { items: { orderBy: { rank: 'asc' } } } });
      await tx.auditLog.create({ data: { actorUserId: adminUserId, action: 'marketplace.campaign.created', targetType: 'MarketplaceCampaign', targetId: campaign.id, metadata: { packageCount: input.items.length } } });
      return campaign;
    });
  }

  async publishCampaign(adminUserId: string, campaignId: string, now = new Date()) {
    await this.auth.ensurePlatformAdmin(adminUserId);
    return this.serializable(async (tx) => {
      await this.ensureMarketingWriter(tx);
      const campaign = await tx.marketplaceCampaign.findUnique({ where: { id: campaignId }, include: { items: true } });
      if (!campaign) throw notFound('精选活动不存在');
      const listings = await tx.marketplaceListing.findMany({ where: { packageId: { in: campaign.items.map((item) => item.packageId) }, status: 'ACTIVE' }, select: { packageId: true, currentReleaseId: true } });
      if (listings.length !== campaign.items.length || listings.some((row) => !row.currentReleaseId)) throw badRequest('精选活动包含已失效插件');
      const claimed = await tx.marketplaceCampaign.updateMany({ where: { id: campaignId, status: 'DRAFT' }, data: { status: 'PUBLISHED', publishedByUserId: adminUserId, publishedAt: now } });
      if (claimed.count !== 1) throw conflict('精选活动状态已变化');
      await tx.auditLog.create({ data: { actorUserId: adminUserId, action: 'marketplace.campaign.published', targetType: 'MarketplaceCampaign', targetId: campaignId, metadata: { packageCount: campaign.items.length } } });
      return tx.marketplaceCampaign.findUniqueOrThrow({ where: { id: campaignId }, include: { items: { orderBy: { rank: 'asc' } } } });
    });
  }

  async cancelCampaign(adminUserId: string, campaignId: string, now = new Date()) {
    await this.auth.ensurePlatformAdmin(adminUserId);
    return this.serializable(async (tx) => {
      await this.ensureMarketingWriter(tx);
      const claimed = await tx.marketplaceCampaign.updateMany({ where: { id: campaignId, status: { in: ['DRAFT', 'PUBLISHED'] } }, data: { status: 'CANCELED', canceledAt: now } });
      if (claimed.count !== 1) throw conflict('精选活动状态已变化');
      await tx.auditLog.create({ data: { actorUserId: adminUserId, action: 'marketplace.campaign.canceled', targetType: 'MarketplaceCampaign', targetId: campaignId, metadata: {} } });
      return tx.marketplaceCampaign.findUniqueOrThrow({ where: { id: campaignId } });
    });
  }

  private async reviewRefund(adminUserId: string, requestId: string, approve: boolean, reviewReason: string, now: Date) {
    return this.serializable(async (tx) => {
      const request = await tx.marketplaceRefundRequest.findUnique({ where: { id: requestId }, include: { purchase: true } });
      if (!request) throw notFound('退款申请不存在');
      if (request.status !== 'PENDING' || request.purchase.status !== 'REFUND_REQUESTED') throw new AppError(409, 'marketplace_refund_state_conflict', '退款申请状态已变化');
      const requestStatus = approve ? 'APPROVED' : 'REJECTED';
      const requestClaim = await tx.marketplaceRefundRequest.updateMany({ where: { id: requestId, status: 'PENDING' }, data: { status: requestStatus, reviewedByUserId: adminUserId, reviewedAt: now, reviewReason: reviewReason.trim().slice(0, 1000) } });
      const orderClaim = await tx.purchase.updateMany({ where: { id: request.purchase.id, status: 'REFUND_REQUESTED' }, data: approve
        ? { status: 'REFUNDED', refundedAt: now, refundedByUserId: adminUserId, refundReason: request.reason }
        : { status: 'PENDING_SETTLEMENT' } });
      if (requestClaim.count !== 1 || orderClaim.count !== 1) throw new AppError(409, 'marketplace_refund_state_conflict', '退款申请状态已变化');
      if (approve) {
        const clearing = await tx.marketplacePlatformAccount.updateMany({ where: { id: CLEARING_ACCOUNT_ID, balanceCents: { gte: request.purchase.priceCents } }, data: { balanceCents: { decrement: request.purchase.priceCents } } });
        if (clearing.count !== 1) throw conflict('市场清算余额不足');
        await tx.team.update({ where: { id: request.purchase.buyerTeamId }, data: { balanceCents: { increment: request.purchase.priceCents } } });
        const entitlement = await tx.pluginEntitlement.updateMany({ where: { purchaseId: request.purchase.id, status: 'ACTIVE' }, data: { status: 'REVOKED', revokedAt: now, revokedByPurchaseId: request.purchase.id, revokedReason: 'REFUNDED' } });
        if (entitlement.count !== 1) throw conflict('订单权益状态不一致');
        await tx.balanceLedger.createMany({ data: refundJournal(request.purchase.priceCents).map((entry) => ({
          teamId: entry.entry_kind === 'BUYER_REFUND_CREDIT' ? request.purchase.buyerTeamId : null,
          platformAccountId: entry.entry_kind === 'PLATFORM_REFUND_CLEARING_DEBIT' ? CLEARING_ACCOUNT_ID : null,
          purchaseId: request.purchase.id, marketplaceEntryKind: entry.entry_kind, amountCents: entry.amount_cents,
          direction: entry.direction, reason: entry.entry_kind.toLowerCase(), actorUserId: adminUserId,
        })) });
      }
      await tx.auditLog.create({ data: { actorUserId: adminUserId, action: approve ? 'marketplace.refund.approved' : 'marketplace.refund.rejected', targetType: 'Purchase', targetId: request.purchase.id, metadata: { requestId } } });
      return tx.purchase.findUniqueOrThrow({ where: { id: request.purchase.id } });
    });
  }

  private async settleOne(purchaseId: string, now: Date): Promise<boolean> {
    return this.serializable(async (tx) => {
      const state = await tx.marketplaceCommerceState.findUnique({ where: { id: 'singleton' } });
      if (!state?.settlementV2ActivatedAt || state.writerMode === 'LEGACY') return false;
      const order = await tx.purchase.findUnique({ where: { id: purchaseId } });
      if (!order || order.status !== 'PENDING_SETTLEMENT' || !order.settleAt || order.settleAt > now || !order.sellerTeamId) return false;
      const entitlement = await tx.pluginEntitlement.findUnique({ where: { purchaseId: order.id } });
      if (!entitlement || entitlement.status !== 'ACTIVE') throw conflict('待结算订单权益状态不一致');
      const claimed = await tx.purchase.updateMany({ where: { id: order.id, status: 'PENDING_SETTLEMENT', settleAt: { lte: now } }, data: { status: 'SETTLED', settledAt: now } });
      if (claimed.count !== 1) return false;
      const clearing = await tx.marketplacePlatformAccount.updateMany({ where: { id: CLEARING_ACCOUNT_ID, balanceCents: { gte: order.priceCents } }, data: { balanceCents: { decrement: order.priceCents } } });
      if (clearing.count !== 1) throw conflict('市场清算余额不足');
      await tx.team.update({ where: { id: order.sellerTeamId }, data: { balanceCents: { increment: order.sellerAmountCents } } });
      await tx.marketplacePlatformAccount.update({ where: { id: REVENUE_ACCOUNT_ID }, data: { balanceCents: { increment: order.platformAmountCents } } });
      await tx.balanceLedger.createMany({ data: settlementJournal(order.priceCents, order.platformFeeBps).map((entry) => ({
        teamId: entry.entry_kind === 'SELLER_SETTLEMENT_CREDIT' ? order.sellerTeamId : null,
        platformAccountId: entry.entry_kind === 'PLATFORM_SETTLEMENT_CLEARING_DEBIT' ? CLEARING_ACCOUNT_ID : entry.entry_kind === 'PLATFORM_SETTLEMENT_CREDIT' ? REVENUE_ACCOUNT_ID : null,
        purchaseId: order.id, marketplaceEntryKind: entry.entry_kind, amountCents: entry.amount_cents,
        direction: entry.direction, reason: entry.entry_kind.toLowerCase(), actorUserId: null,
      })) });
      await tx.auditLog.create({ data: { action: 'marketplace.order.settled', targetType: 'Purchase', targetId: order.id, metadata: { sellerTeamId: order.sellerTeamId } } });
      return true;
    });
  }

  private async ensureMarketingWriter(tx: Prisma.TransactionClient) {
    const state = await tx.marketplaceCommerceState.findUnique({ where: { id: 'singleton' } });
    if (!state || state.writerMode !== 'SETTLEMENT_V2' || !state.settlementV2ActivatedAt) throw new AppError(503, 'marketplace_commerce_paused', '市场营销暂未开放');
  }

  private campaignSecret() { const value = process.env.MARKETPLACE_CAMPAIGN_TOKEN_SECRET; if (!value || value.length < 32) throw new AppError(500, 'campaign_token_unavailable', '活动归因签名服务未配置'); return value; }
  private signCampaignToken(payload: CampaignAttributionPayload) { const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url'); const signature = createHmac('sha256', this.campaignSecret()).update(encoded).digest('base64url'); return `ct1.${encoded}.${signature}`; }
  private verifyCampaignToken(token: string): CampaignAttributionPayload {
    const parts = token.split('.'); if (parts.length !== 3 || parts[0] !== 'ct1') throw new AppError(400, 'campaign_token_invalid', '活动归因凭证无效');
    const expected = Buffer.from(createHmac('sha256', this.campaignSecret()).update(parts[1]).digest('base64url')); const actual = Buffer.from(parts[2]);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new AppError(400, 'campaign_token_invalid', '活动归因凭证无效');
    try { const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as CampaignAttributionPayload; if (payload.v !== 1) throw new Error('version'); return payload; } catch { throw new AppError(400, 'campaign_token_invalid', '活动归因凭证无效'); }
  }
  private async validateCampaignTokenTx(tx: Prisma.TransactionClient, token: string, expected: { userId: string; teamId: string; packageId: string; listingId: string; now: Date }) {
    const payload = this.verifyCampaignToken(token); const expiresAt = new Date(payload.expires_at); const issuedAt = new Date(payload.issued_at);
    if (!Number.isFinite(expiresAt.getTime()) || !Number.isFinite(issuedAt.getTime()) || issuedAt > expected.now || expiresAt <= expected.now) throw new AppError(400, 'campaign_token_expired', '活动归因凭证已过期');
    if (payload.user_id !== expected.userId || payload.team_id !== expected.teamId || payload.package_id !== expected.packageId || payload.listing_id !== expected.listingId) throw new AppError(400, 'campaign_token_invalid', '活动归因凭证与当前购买上下文不匹配');
    const item = await tx.marketplaceCampaignItem.findFirst({ where: { id: payload.campaign_item_id, campaignId: payload.campaign_id, packageId: expected.packageId, campaign: { status: 'PUBLISHED', startsAt: { lte: expected.now }, endsAt: { gt: expected.now } } } });
    if (!item) throw new AppError(400, 'campaign_token_invalid', '活动或活动商品已失效');
    return payload;
  }

  private assertPriceVersion(listing: { priceCents: number; priceRevision: number }, discount: Parameters<typeof resolveMarketplacePrice>[0]['discount'], now: Date, expected: string) {
    const current = resolveMarketplacePrice({ listPriceCents: listing.priceCents, priceRevision: listing.priceRevision, discount, now });
    if (current.price_version !== expected) throw new AppError(409, 'marketplace_price_changed', '插件价格已变化，请刷新后重试');
  }

  private async serializable<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try { return await this.prisma.$transaction(operation, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }); }
      catch (error) {
        const retryable = error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';
        if (!retryable || attempt === 3) throw error;
      }
    }
    throw conflict('市场订单发生并发冲突');
  }
}
