import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { MARKETPLACE_QUALITY_POLICY_V1, MarketplaceQualitySummary } from '@lingfang/contract';
import { badRequest, conflict, forbidden, notFound } from '../common';
import { PrismaService } from '../prisma.service';
import { AuthService } from './auth.service';
import { PLUGIN_AI_POLICY_VERSION } from './plugin-ai-policy';
import { MarketplaceQualityComputationService } from './marketplace-quality-computation.service';
import { MarketplaceQualityFactsService } from './marketplace-quality-facts.service';
import { marketplaceQualityGateDigest } from './marketplace-quality-projection';
import { TicketService } from './ticket.service';

@Injectable()
export class MarketplaceQualityService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(MarketplaceQualityComputationService) private readonly computations: MarketplaceQualityComputationService,
    @Inject(TicketService) private readonly tickets: TicketService,
    @Inject(MarketplaceQualityFactsService) private readonly facts: MarketplaceQualityFactsService,
  ) {}

  policy() { return MARKETPLACE_QUALITY_POLICY_V1; }

  async rate(userId: string, packageId: string, input: { score: number; comment?: string }) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const listing = await this.publicListing(packageId);
    if (listing.package.ownerTeamId === membership.teamId) throw forbidden('作者团队不能评价自己的插件');
    if (listing.priceCents > 0) {
      const entitlement = await this.prisma.pluginEntitlement.findFirst({
        where: { teamId: membership.teamId, packageId, status: 'ACTIVE' },
        select: { id: true },
      });
      if (!entitlement) throw forbidden('购买并启用插件后才能评分');
    } else {
      const successfulRun = await this.prisma.marketplaceMetricEvent.findFirst({
        where: { packageId, teamId: membership.teamId, kind: 'RUN_SUCCEEDED' },
        select: { id: true },
      });
      if (!successfulRun) throw forbidden('成功运行插件后才能评分');
    }

    const comment = String(input.comment || '').trim().slice(0, 2000);
    const releaseId = listing.currentRelease!.id;
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.marketplaceRating.findUnique({ where: { packageId_teamId: { packageId, teamId: membership.teamId } } });
      const ratingId = current?.id ?? randomUUID();
      const revision = (current?.revision ?? 0) + 1;
      const recordedAt = new Date();
      const sourceId = `${ratingId}:${revision}`;
      const rating = current
        ? await tx.marketplaceRating.update({
            where: { id: current.id },
            data: { score: input.score, comment, revision, updatedById: userId },
          })
        : await tx.marketplaceRating.create({
            data: { id: ratingId, packageId, teamId: membership.teamId, score: input.score, comment, revision, createdById: userId, updatedById: userId },
          });
      const revisionRow = await tx.marketplaceRatingRevision.create({ data: {
        ratingId, packageId, teamId: membership.teamId, revision, score: input.score,
        recordedAt, sourceKind: 'TEAM_RATING', sourceId, actorUserId: userId,
      } });
      await tx.marketplaceMetricEvent.create({ data: {
        idempotencyKey: `rating:${ratingId}:r${revision}`,
        packageId,
        releaseId,
        teamId: membership.teamId,
        kind: 'RATING_CHANGED',
        source: 'REGISTRY',
        sourceRecordId: revisionRow.id,
        value: input.score,
        metadata: { ratingRevision: revision } as Prisma.InputJsonValue,
        occurredAt: recordedAt,
      } });
      await tx.auditLog.create({ data: {
        actorUserId: userId,
        action: 'marketplace.package.rated',
        targetType: 'PluginPackage',
        targetId: packageId,
        metadata: { revision, score: input.score },
      } });
      return publicRating(rating);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async ratings(packageId: string, input: { page?: number; pageSize?: number }) {
    await this.publicListing(packageId);
    const page = Math.max(1, Math.floor(input.page ?? 1));
    const pageSize = Math.min(50, Math.max(1, Math.floor(input.pageSize ?? 20)));
    const [rows, total] = await Promise.all([
      this.prisma.marketplaceRating.findMany({
        where: { packageId }, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize, take: pageSize,
      }),
      this.prisma.marketplaceRating.count({ where: { packageId } }),
    ]);
    return { items: rows.map(publicRating), total, page, pageSize };
  }

  async ownerQuality(userId: string, packageId: string) {
    const { listing } = await this.ownerListing(userId, packageId);
    const snapshot = listing.qualitySnapshotId
      ? await this.prisma.marketplaceQualitySnapshot.findUnique({ where: { id: listing.qualitySnapshotId } })
      : null;
    return {
      packageId,
      category: listing.category,
      tier: activeTier(listing, snapshot, new Date()),
      policy: MARKETPLACE_QUALITY_POLICY_V1,
      snapshot: snapshot ? snapshotProjection(listing, snapshot) : null,
      qualityBlocked: listing.qualityBlockedAt ? {
        at: listing.qualityBlockedAt.toISOString(), reason: listing.qualityBlockedReason,
      } : null,
      featured: listing.featuredAt ? {
        at: listing.featuredAt.toISOString(),
        until: listing.featuredUntil?.toISOString() ?? null,
        reason: listing.featuredReason,
        rank: listing.featuredRank,
      } : null,
    };
  }

  async appeal(userId: string, packageId: string, body: string) {
    const { pkg, listing } = await this.ownerListing(userId, packageId);
    if (!listing.qualitySnapshotId) throw conflict('当前还没有可申诉的质量快照');
    const title = `插件质量结果申诉：${pkg.name}`;
    const detail = [
      String(body || '').trim(),
      '',
      `packageId: ${packageId}`,
      `snapshotId: ${listing.qualitySnapshotId}`,
      `qualityTier: ${listing.qualityTier}`,
    ].join('\n');
    const ticket = await this.tickets.create(userId, {
      title,
      body: detail,
      // Reuse the current ticket state machine without changing its database
      // enum in this read/API rollout.  The stable title prefix and audit
      // target retain machine-identifiable marketplace appeal context.
      category: 'OTHER',
    }, []);
    await this.prisma.auditLog.create({ data: {
      actorUserId: userId,
      action: 'marketplace.quality.appealed',
      targetType: 'MarketplaceQualitySnapshot',
      targetId: listing.qualitySnapshotId,
      metadata: { packageId, ticketId: ticket.ticket.id },
    } });
    return ticket;
  }

  async recompute(actorId: string, packageId: string, requestId?: string) {
    await this.auth.ensurePlatformAdmin(actorId);
    const factWatermark = new Date();
    const result = await this.computePackage(packageId, 'MANUAL', factWatermark, requestId?.trim() || randomUUID());
    await this.prisma.auditLog.create({ data: {
      actorUserId: actorId,
      action: 'admin.marketplace.quality.recomputed',
      targetType: 'PluginPackage',
      targetId: packageId,
      metadata: { computationId: result.computationId, snapshotId: result.snapshotId, projected: result.projected },
    } });
    return result;
  }

  async runDaily(factWatermark = new Date(), batchSize = 100) {
    const take = Math.max(1, Math.min(500, Math.floor(batchSize)));
    let cursor: string | undefined;
    let processed = 0;
    let succeeded = 0;
    let failed = 0;
    do {
      const rows = await this.prisma.marketplaceListing.findMany({
        where: { currentReleaseId: { not: null }, currentReleaseActivatedAt: { not: null } },
        orderBy: { packageId: 'asc' },
        take,
        ...(cursor ? { cursor: { packageId: cursor }, skip: 1 } : {}),
        select: { packageId: true },
      });
      if (rows.length === 0) break;
      for (const row of rows) {
        processed += 1;
        try {
          await this.computePackage(row.packageId, 'DAILY', factWatermark);
          succeeded += 1;
        } catch {
          failed += 1;
        }
      }
      cursor = rows.at(-1)!.packageId;
      if (rows.length < take) break;
    } while (true);
    return { factWatermark, processed, succeeded, failed };
  }

  async feature(actorId: string, packageId: string, input: { reason: string; rank?: number; until?: string }) {
    await this.auth.ensurePlatformAdmin(actorId);
    const reason = requiredReason(input.reason);
    const until = input.until ? new Date(input.until) : null;
    if (until && (!Number.isFinite(until.getTime()) || until <= new Date())) throw badRequest('精选结束时间必须位于未来');
    const rank = input.rank === undefined ? null : Math.max(0, Math.min(10_000, Math.floor(input.rank)));
    return this.prisma.$transaction(async (tx) => {
      const listing = await tx.marketplaceListing.findUnique({ where: { packageId }, include: { package: true, currentRelease: true } });
      if (!listing || !hardGateEligible(listing)) throw conflict('只有通过当前市场硬门禁的插件可以设为精选');
      const now = new Date();
      const changed = await tx.marketplaceListing.updateMany({
        where: { id: listing.id, updatedAt: listing.updatedAt },
        data: { featuredAt: now, featuredUntil: until, featuredByUserId: actorId, featuredReason: reason, featuredRank: rank, qualityTier: 'FEATURED' },
      });
      if (changed.count !== 1) throw conflict('精选状态已变化，请刷新后重试');
      await tx.auditLog.create({ data: { actorUserId: actorId, action: 'admin.marketplace.quality.featured', targetType: 'PluginPackage', targetId: packageId, metadata: { reason, rank, until } } });
      return { packageId, tier: 'FEATURED' as const, featuredAt: now.toISOString(), featuredUntil: until?.toISOString() ?? null, reason, rank };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async unfeature(actorId: string, packageId: string, reasonInput: string) {
    await this.auth.ensurePlatformAdmin(actorId);
    const reason = requiredReason(reasonInput);
    return this.prisma.$transaction(async (tx) => {
      const listing = await tx.marketplaceListing.findUnique({ where: { packageId } });
      if (!listing?.featuredAt) throw conflict('插件当前不是精选状态');
      const snapshot = listing.qualitySnapshotId ? await tx.marketplaceQualitySnapshot.findUnique({ where: { id: listing.qualitySnapshotId } }) : null;
      const nextTier = snapshot?.autoQualified && !listing.qualityBlockedAt ? 'QUALITY' as const : 'LISTED' as const;
      const changed = await tx.marketplaceListing.updateMany({ where: { id: listing.id, updatedAt: listing.updatedAt }, data: {
        featuredAt: null, featuredUntil: null, featuredByUserId: null, featuredReason: '', featuredRank: null, qualityTier: nextTier,
      } });
      if (changed.count !== 1) throw conflict('精选状态已变化，请刷新后重试');
      await tx.auditLog.create({ data: { actorUserId: actorId, action: 'admin.marketplace.quality.unfeatured', targetType: 'PluginPackage', targetId: packageId, metadata: { reason } } });
      return { packageId, tier: nextTier };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async setQualityBlocked(actorId: string, packageId: string, blocked: boolean, reasonInput: string) {
    await this.auth.ensurePlatformAdmin(actorId);
    const reason = requiredReason(reasonInput);
    return this.prisma.$transaction(async (tx) => {
      const listing = await tx.marketplaceListing.findUnique({ where: { packageId } });
      if (!listing) throw notFound('市场 listing 不存在');
      const snapshot = listing.qualitySnapshotId ? await tx.marketplaceQualitySnapshot.findUnique({ where: { id: listing.qualitySnapshotId } }) : null;
      const featured = listing.featuredAt !== null && (listing.featuredUntil === null || listing.featuredUntil > new Date());
      const nextTier = featured ? 'FEATURED' as const : !blocked && snapshot?.autoQualified ? 'QUALITY' as const : 'LISTED' as const;
      const changed = await tx.marketplaceListing.updateMany({ where: { id: listing.id, updatedAt: listing.updatedAt }, data: blocked ? {
        qualityBlockedAt: new Date(), qualityBlockedByUserId: actorId, qualityBlockedReason: reason, qualityTier: nextTier,
      } : {
        qualityBlockedAt: null, qualityBlockedByUserId: null, qualityBlockedReason: '', qualityTier: nextTier,
      } });
      if (changed.count !== 1) throw conflict('质量暂停状态已变化，请刷新后重试');
      await tx.auditLog.create({ data: { actorUserId: actorId, action: blocked ? 'admin.marketplace.quality.blocked' : 'admin.marketplace.quality.unblocked', targetType: 'PluginPackage', targetId: packageId, metadata: { reason } } });
      return { packageId, blocked, tier: nextTier, reason };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  private async computePackage(packageId: string, kind: 'DAILY' | 'MANUAL', factWatermark: Date, requestId?: string) {
    const loaded = await this.facts.load(packageId, factWatermark);
    return this.computations.compute({
      jobKey: kind === 'DAILY'
        ? this.computations.dailyJobKey(loaded.scope, factWatermark)
        : this.computations.manualJobKey(loaded.scope, requestId || randomUUID()),
      kind,
      scope: loaded.scope,
      factWatermark,
      facts: loaded.facts,
    });
  }

  private async ownerListing(userId: string, packageId: string) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const pkg = await this.prisma.pluginPackage.findUnique({ where: { id: packageId }, include: { listing: true } });
    if (!pkg || pkg.ownerTeamId !== membership.teamId || !pkg.listing) throw notFound('插件包或市场 listing 不存在');
    return { pkg, listing: pkg.listing };
  }

  private async publicListing(packageId: string) {
    const listing = await this.prisma.marketplaceListing.findUnique({ where: { packageId }, include: { package: true, currentRelease: true } });
    if (!listing || listing.status !== 'ACTIVE' || !listing.currentRelease || listing.currentReleaseId !== listing.currentRelease.id
      || listing.package.governanceStatus !== 'ACTIVE' || listing.currentRelease.status !== 'PUBLISHED'
      || listing.currentRelease.marketReviewStatus !== 'APPROVED' || listing.currentRelease.aiPolicyVersion !== PLUGIN_AI_POLICY_VERSION
      || listing.currentRelease.aiPolicyStatus !== 'PASSED') throw notFound('市场插件不存在或未上架');
    return listing;
  }
}

function publicRating(row: { id: string; score: number; comment: string; revision: number; createdAt: Date; updatedAt: Date }) {
  return {
    id: row.id,
    score: row.score,
    comment: row.comment,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function snapshotProjection(listing: any, snapshot: any) {
  return MarketplaceQualitySummary.parse({
    tier: activeTier(listing, snapshot, new Date()),
    auto_qualified: snapshot.autoQualified,
    policy_version: snapshot.policyVersion,
    fact_watermark: snapshot.factWatermark.toISOString(),
    computed_at: snapshot.computedAt.toISOString(),
    qualified_at: listing.qualityQualifiedAt?.toISOString() ?? null,
    stale: false,
    metrics: {
      listing_age_days: snapshot.listingAgeDays,
      current_release_age_days: snapshot.currentReleaseAgeDays,
      active_teams_30d: snapshot.activeTeams30d,
      install_teams_30d: snapshot.installTeams30d,
      observed_runs_30d: snapshot.observedRuns30d,
      failed_runs_30d: snapshot.failedRuns30d,
      failure_rate_bps: snapshot.failureRateBps,
      rating_teams: snapshot.ratingTeams,
      rating_sum: snapshot.ratingSum,
      average_rating_tenths: snapshot.averageRatingTenths,
      refund_metric_state: snapshot.refundMetricState,
      matured_paid_orders_90d: snapshot.maturedPaidOrders90d,
      approved_refunds_90d: snapshot.approvedRefunds90d,
      refund_rate_bps: snapshot.refundRateBps,
      security_incidents_90d: snapshot.securityIncidents90d,
    },
    reasons: Array.isArray(snapshot.reasons) ? snapshot.reasons : [],
  });
}

function activeTier(listing: any, snapshot: any, now: Date): 'LISTED' | 'QUALITY' | 'FEATURED' {
  if (listing.qualityTier === 'FEATURED' && listing.featuredAt && (!listing.featuredUntil || listing.featuredUntil > now)) return 'FEATURED';
  return snapshot?.autoQualified ? 'QUALITY' : 'LISTED';
}

function requiredReason(value: string): string {
  const reason = String(value || '').trim();
  if (!reason || reason.length > 500) throw badRequest('请填写 1 到 500 字符的操作原因');
  return reason;
}

function hardGateEligible(listing: any): boolean {
  const gate = listing.status === 'ACTIVE'
    && listing.package?.governanceStatus === 'ACTIVE'
    && listing.currentReleaseId === listing.currentRelease?.id
    && listing.currentRelease?.status === 'PUBLISHED'
    && listing.currentRelease?.marketReviewStatus === 'APPROVED'
    && listing.currentRelease?.aiPolicyVersion === PLUGIN_AI_POLICY_VERSION
    && listing.currentRelease?.aiPolicyStatus === 'PASSED'
    && listing.currentReleaseActivatedAt
    && listing.listingEligibleSince
    && listing.releaseEligibleSince;
  if (!gate) return false;
  return listing.eligibilityGateDigest === marketplaceQualityGateDigest({
    listingStatus: listing.status,
    currentReleaseId: listing.currentReleaseId,
    currentReleaseStatus: listing.currentRelease.status,
    marketReviewStatus: listing.currentRelease.marketReviewStatus,
    aiPolicyVersion: listing.currentRelease.aiPolicyVersion,
    aiPolicyStatus: listing.currentRelease.aiPolicyStatus,
    securityBlocked: false,
    pointerRevision: listing.pointerRevision,
    eligibilityRevision: listing.eligibilityRevision,
  });
}
