import { Inject, Injectable } from '@nestjs/common';
import { MARKETPLACE_QUALITY_POLICY_V1, type MarketplaceRefundMetricState } from '@lingfang/contract';
import { notFound } from '../common';
import { PrismaService } from '../prisma.service';
import { PLUGIN_AI_POLICY_VERSION } from './plugin-ai-policy';
import type { MarketplaceQualityEvaluationInput } from './marketplace-quality-evaluator';
import type { MarketplaceQualityScope } from './marketplace-quality-computation.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * DAY_MS;
const NINETY_DAYS_MS = 90 * DAY_MS;

export type MarketplaceCommerceQualityFacts = {
  refundMetricState: MarketplaceRefundMetricState;
  maturedPaidOrders90d: number;
  approvedRefunds90d: number;
  eligibleBuyerTeamIds: ReadonlySet<string>;
};

export interface MarketplaceCommerceFactsPort {
  read(packageId: string, factWatermark: Date): Promise<MarketplaceCommerceQualityFacts>;
}

export const MARKETPLACE_COMMERCE_FACTS_PORT = Symbol('MARKETPLACE_COMMERCE_FACTS_PORT');

@Injectable()
export class PrismaMarketplaceCommerceFactsAdapter implements MarketplaceCommerceFactsPort {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async read(packageId: string, factWatermark: Date): Promise<MarketplaceCommerceQualityFacts> {
    const state = await this.prisma.marketplaceCommerceState.findUnique({ where: { id: 'singleton' } });
    if (!state?.settlementV2ActivatedAt || state.writerMode === 'LEGACY' || state.writerMode === 'DRAINING') {
      return unavailableCommerceFacts();
    }
    const windowStart = new Date(factWatermark.getTime() - NINETY_DAYS_MS);
    const rows = await this.prisma.purchase.findMany({
      where: { packageId, createdAt: { lte: factWatermark } },
      select: {
        buyerTeamId: true,
        settlementVersion: true,
        status: true,
        createdAt: true,
        refundableUntil: true,
        refundedAt: true,
      },
    });
    const eligibleBuyerTeamIds = new Set(rows
      .filter((row) => row.settlementVersion === 'SETTLEMENT_V2'
        && row.createdAt <= factWatermark
        && (!row.refundedAt || row.refundedAt > factWatermark))
      .map((row) => row.buyerTeamId));
    const cohort = rows.filter((row) => row.createdAt >= windowStart && row.createdAt <= factWatermark);
    if (cohort.some((row) => row.settlementVersion !== 'SETTLEMENT_V2')) {
      return { ...unavailableCommerceFacts(), eligibleBuyerTeamIds };
    }
    const matured = cohort.filter((row) => row.refundableUntil !== null && row.refundableUntil <= factWatermark);
    if (matured.some((row) => row.status === 'REFUND_REQUESTED')) {
      return { ...unavailableCommerceFacts(), eligibleBuyerTeamIds };
    }
    const approvedRefunds = matured.filter((row) => row.status === 'REFUNDED' && row.refundedAt && row.refundedAt <= factWatermark).length;
    return {
      refundMetricState: matured.length >= MARKETPLACE_QUALITY_POLICY_V1.matured_paid_orders_90d ? 'AVAILABLE' : 'INSUFFICIENT_SAMPLE',
      maturedPaidOrders90d: matured.length,
      approvedRefunds90d: approvedRefunds,
      eligibleBuyerTeamIds,
    };
  }
}

export type MarketplaceQualityFacts = {
  scope: MarketplaceQualityScope;
  facts: Omit<MarketplaceQualityEvaluationInput, 'factWatermark' | 'listingEligibleSince' | 'releaseEligibleSince' | 'currentReleaseActivatedAt'>;
};

@Injectable()
export class MarketplaceQualityFactsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(MARKETPLACE_COMMERCE_FACTS_PORT) private readonly commerce: MarketplaceCommerceFactsPort,
  ) {}

  async load(packageId: string, factWatermark: Date): Promise<MarketplaceQualityFacts> {
    const listing = await this.prisma.marketplaceListing.findUnique({
      where: { packageId },
      include: { package: true, currentRelease: true },
    });
    if (!listing?.currentReleaseId || !listing.currentRelease || !listing.currentReleaseActivatedAt) {
      throw notFound('市场插件或当前发行版不存在');
    }
    const ninetyDayStart = new Date(factWatermark.getTime() - NINETY_DAYS_MS);
    const thirtyDayStart = new Date(factWatermark.getTime() - THIRTY_DAYS_MS);
    const [events, ratingRevisions, commerce] = await Promise.all([
      this.prisma.marketplaceMetricEvent.findMany({
        where: {
          packageId,
          recordedAt: { lte: factWatermark },
          occurredAt: { gte: ninetyDayStart, lte: factWatermark },
        },
        orderBy: [{ occurredAt: 'asc' }, { recordedAt: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.marketplaceRatingRevision.findMany({
        where: { packageId, recordedAt: { lte: factWatermark } },
        orderBy: [{ teamId: 'asc' }, { recordedAt: 'desc' }, { revision: 'desc' }],
      }),
      listing.priceCents > 0 ? this.commerce.read(packageId, factWatermark) : Promise.resolve({
        refundMetricState: 'NOT_APPLICABLE' as const,
        maturedPaidOrders90d: 0,
        approvedRefunds90d: 0,
        eligibleBuyerTeamIds: new Set<string>(),
      }),
    ]);

    const latestRatings = latestRatingPerTeam(ratingRevisions);
    const factTeamIds = new Set<string>();
    events.forEach((event) => { if (event.teamId) factTeamIds.add(event.teamId); });
    latestRatings.forEach((rating) => factTeamIds.add(rating.teamId));
    commerce.eligibleBuyerTeamIds.forEach((teamId) => factTeamIds.add(teamId));
    const activeTeamRows = factTeamIds.size === 0 ? [] : await this.prisma.team.findMany({
      where: { id: { in: [...factTeamIds] }, status: 'ACTIVE' },
      select: { id: true },
    });
    const activeTeamIds = new Set(activeTeamRows.map((team) => team.id));
    const publicEvents = events.filter((event) => event.teamId === null || activeTeamIds.has(event.teamId))
      .filter((event) => !isTestFact(event.metadata));
    const recentEvents = publicEvents.filter((event) => event.occurredAt >= thirtyDayStart);
    const runEvents = recentEvents.filter((event) => event.releaseId === listing.currentReleaseId
      && (event.kind === 'RUN_SUCCEEDED' || event.kind === 'RUN_FAILED')
      && event.teamId !== listing.package.ownerTeamId
      && !excludedRunFailure(event));
    const successfulTeams = new Set(runEvents
      .filter((event) => event.kind === 'RUN_SUCCEEDED' && event.teamId)
      .map((event) => event.teamId as string));
    const installTeams = new Set(recentEvents
      .filter((event) => event.kind === 'INSTALL_SUCCEEDED' && event.teamId && event.teamId !== listing.package.ownerTeamId)
      .map((event) => event.teamId as string));
    const freeUsageTeams = new Set(publicEvents
      .filter((event) => event.kind === 'RUN_SUCCEEDED' && event.teamId && event.teamId !== listing.package.ownerTeamId)
      .map((event) => event.teamId as string));
    const eligibleRatings = latestRatings.filter((rating) => rating.teamId !== listing.package.ownerTeamId
      && activeTeamIds.has(rating.teamId)
      && (listing.priceCents > 0 ? commerce.eligibleBuyerTeamIds.has(rating.teamId) : freeUsageTeams.has(rating.teamId)));
    const openSecurityIncidents = unresolvedSecurityIncidentIds(publicEvents);

    return {
      scope: {
        listingId: listing.id,
        packageId,
        releaseId: listing.currentReleaseId,
        currentReleaseActivatedAt: listing.currentReleaseActivatedAt,
        pointerRevision: listing.pointerRevision,
        eligibilityRevision: listing.eligibilityRevision,
        eligibilityGateDigest: listing.eligibilityGateDigest,
        listingEligibleSince: listing.listingEligibleSince,
        releaseEligibleSince: listing.releaseEligibleSince,
      },
      facts: {
        hardGateEligible: listing.status === 'ACTIVE'
          && listing.package.governanceStatus === 'ACTIVE'
          && listing.currentRelease.status === 'PUBLISHED'
          && listing.currentRelease.marketReviewStatus === 'APPROVED'
          && listing.currentRelease.aiPolicyVersion === PLUGIN_AI_POLICY_VERSION
          && listing.currentRelease.aiPolicyStatus === 'PASSED'
          && openSecurityIncidents.size === 0,
        activeTeams30d: successfulTeams.size,
        installTeams30d: installTeams.size,
        observedRuns30d: runEvents.length,
        failedRuns30d: runEvents.filter((event) => event.kind === 'RUN_FAILED').length,
        ratingTeams: eligibleRatings.length,
        ratingSum: eligibleRatings.reduce((sum, rating) => sum + rating.score, 0),
        paid: listing.priceCents > 0,
        refundMetricState: commerce.refundMetricState,
        maturedPaidOrders90d: commerce.maturedPaidOrders90d,
        approvedRefunds90d: commerce.approvedRefunds90d,
        securityIncidents90d: openSecurityIncidents.size,
        anomalyReviewRequired: anomalyReviewRequired(recentEvents, successfulTeams.size),
        qualityBlocked: listing.qualityBlockedAt !== null,
      },
    };
  }
}

function unavailableCommerceFacts(): MarketplaceCommerceQualityFacts {
  return {
    refundMetricState: 'DATA_UNAVAILABLE',
    maturedPaidOrders90d: 0,
    approvedRefunds90d: 0,
    eligibleBuyerTeamIds: new Set<string>(),
  };
}

function latestRatingPerTeam(rows: Array<{ teamId: string; score: number }>) {
  const latest = new Map<string, { teamId: string; score: number }>();
  for (const row of rows) if (!latest.has(row.teamId)) latest.set(row.teamId, row);
  return [...latest.values()];
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isTestFact(metadata: unknown): boolean {
  const value = objectValue(metadata);
  return value.test_data === true || value.platform_test === true || value.excluded_from_quality === true;
}

function excludedRunFailure(event: { kind: string; metadata: unknown }): boolean {
  if (event.kind !== 'RUN_FAILED') return false;
  const failure = String(objectValue(event.metadata).failure_class || '').toUpperCase();
  return ['USER_CANCELED', 'AUTHORIZATION', 'ENTITLEMENT', 'BALANCE', 'PLATFORM', 'UPSTREAM_PLATFORM'].includes(failure);
}

function securityIncidentId(event: { sourceRecordId: string; metadata: unknown }): string {
  const metadata = objectValue(event.metadata);
  return String(metadata.incident_id || event.sourceRecordId);
}

function unresolvedSecurityIncidentIds(events: Array<{ kind: string; sourceRecordId: string; metadata: unknown }>): Set<string> {
  const open = new Set<string>();
  for (const event of events) {
    if (event.kind === 'SECURITY_BLOCKED') open.add(securityIncidentId(event));
    if (event.kind === 'SECURITY_CLEARED') open.delete(securityIncidentId(event));
  }
  return open;
}

function anomalyReviewRequired(events: Array<{ kind: string; teamId: string | null; occurredAt: Date; metadata: unknown }>, activeTeams30d: number): boolean {
  if (activeTeams30d <= 0) return false;
  const newest = events.reduce((time, event) => Math.max(time, event.occurredAt.getTime()), 0);
  const burstTeams = new Set(events
    .filter((event) => event.kind === 'RUN_SUCCEEDED' && event.teamId && event.occurredAt.getTime() >= newest - DAY_MS)
    .map((event) => event.teamId as string));
  if (burstTeams.size >= 20 && burstTeams.size * 4 >= activeTeams30d * 3) return true;
  const controlled = new Map<string, Set<string>>();
  for (const event of events) {
    if (!event.teamId) continue;
    const control = String(objectValue(event.metadata).control_principal_hash || '');
    if (!control) continue;
    const teams = controlled.get(control) ?? new Set<string>();
    teams.add(event.teamId);
    controlled.set(control, teams);
  }
  return [...controlled.values()].some((teams) => teams.size >= 3);
}

