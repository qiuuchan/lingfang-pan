import { Inject, Injectable } from '@nestjs/common';
import { Prisma, type MarketplaceQualityComputationKind } from '@prisma/client';
import { MARKETPLACE_QUALITY_POLICY_V1 } from '@lingfang/contract';
import { PrismaService } from '../prisma.service';
import {
  evaluateMarketplaceQualityV1,
  type MarketplaceQualityEvaluationInput,
} from './marketplace-quality-evaluator';
import { canProjectQualitySnapshot } from './marketplace-quality-projection';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export type MarketplaceQualityScope = {
  listingId: string;
  packageId: string;
  releaseId: string;
  currentReleaseActivatedAt: Date;
  pointerRevision: number;
  eligibilityRevision: number;
  eligibilityGateDigest: string;
  listingEligibleSince: Date | null;
  releaseEligibleSince: Date | null;
};

export type MarketplaceQualityComputeRequest = {
  jobKey: string;
  kind: MarketplaceQualityComputationKind;
  scope: MarketplaceQualityScope;
  factWatermark: Date;
  facts: Omit<
    MarketplaceQualityEvaluationInput,
    'factWatermark' | 'listingEligibleSince' | 'releaseEligibleSince' | 'currentReleaseActivatedAt'
  >;
};

export type MarketplaceQualityComputeResult = {
  computationId: string;
  snapshotId: string | null;
  reused: boolean;
  projected: boolean;
};

export interface MarketplaceQualityComputationRepository {
  claim(request: MarketplaceQualityComputeRequest): Promise<{
    id: string;
    status: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
    snapshotId: string | null;
    created: boolean;
  }>;
  commit(
    request: MarketplaceQualityComputeRequest,
    computationId: string,
    evaluation: ReturnType<typeof evaluateMarketplaceQualityV1>
  ): Promise<{ snapshotId: string; projected: boolean }>;
  fail(computationId: string, errorCode: string, finishedAt: Date): Promise<void>;
}

export const MARKETPLACE_QUALITY_COMPUTATION_REPOSITORY = Symbol(
  'MARKETPLACE_QUALITY_COMPUTATION_REPOSITORY'
);

@Injectable()
export class MarketplaceQualityComputationService {
  constructor(
    @Inject(MARKETPLACE_QUALITY_COMPUTATION_REPOSITORY)
    private readonly repository: MarketplaceQualityComputationRepository
  ) {}

  dailyJobKey(scope: MarketplaceQualityScope, watermark: Date): string {
    const day = watermark.toISOString().slice(0, 10);
    return `quality:v${MARKETPLACE_QUALITY_POLICY_V1.version}:daily:${day}:${scope.packageId}:p${scope.pointerRevision}:e${scope.eligibilityRevision}`;
  }

  manualJobKey(scope: MarketplaceQualityScope, requestId: string): string {
    if (!requestId.trim() || requestId.length > 128)
      throw new Error('marketplace_quality_invalid_request_id');
    return `quality:v${MARKETPLACE_QUALITY_POLICY_V1.version}:manual:${scope.packageId}:p${scope.pointerRevision}:e${scope.eligibilityRevision}:${requestId}`;
  }

  async compute(
    request: MarketplaceQualityComputeRequest
  ): Promise<MarketplaceQualityComputeResult> {
    validateRequest(request);
    const claimed = await this.repository.claim(request);
    if (!claimed.created) {
      return {
        computationId: claimed.id,
        snapshotId: claimed.snapshotId,
        reused: true,
        projected: false,
      };
    }
    try {
      const evaluation = evaluateMarketplaceQualityV1({
        ...request.facts,
        factWatermark: request.factWatermark,
        listingEligibleSince: request.scope.listingEligibleSince,
        releaseEligibleSince: request.scope.releaseEligibleSince,
        currentReleaseActivatedAt: request.scope.currentReleaseActivatedAt,
      });
      const committed = await this.repository.commit(request, claimed.id, evaluation);
      return {
        computationId: claimed.id,
        snapshotId: committed.snapshotId,
        reused: false,
        projected: committed.projected,
      };
    } catch (error) {
      await this.repository.fail(claimed.id, qualityErrorCode(error), new Date());
      throw error;
    }
  }
}

@Injectable()
export class PrismaMarketplaceQualityComputationRepository implements MarketplaceQualityComputationRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async claim(request: MarketplaceQualityComputeRequest) {
    try {
      const row = await this.prisma.marketplaceQualityComputation.create({
        data: {
          jobKey: request.jobKey,
          kind: request.kind,
          packageId: request.scope.packageId,
          releaseId: request.scope.releaseId,
          currentReleaseActivatedAt: request.scope.currentReleaseActivatedAt,
          pointerRevision: request.scope.pointerRevision,
          eligibilityRevision: request.scope.eligibilityRevision,
          requestedFactWatermark: request.factWatermark,
        },
      });
      return { id: row.id, status: row.status, snapshotId: row.snapshotId, created: true };
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002')
        throw error;
      const row = await this.prisma.marketplaceQualityComputation.findUniqueOrThrow({
        where: { jobKey: request.jobKey },
      });
      if (!sameComputationRequest(row, request))
        throw new Error('marketplace_quality_job_key_conflict');
      return { id: row.id, status: row.status, snapshotId: row.snapshotId, created: false };
    }
  }

  async commit(
    request: MarketplaceQualityComputeRequest,
    computationId: string,
    evaluation: ReturnType<typeof evaluateMarketplaceQualityV1>
  ) {
    return this.prisma.$transaction(
      async (tx) => {
        const computation = await tx.marketplaceQualityComputation.findUniqueOrThrow({
          where: { id: computationId },
        });
        if (computation.status !== 'RUNNING') {
          if (!computation.snapshotId)
            throw new Error('marketplace_quality_computation_not_running');
          return { snapshotId: computation.snapshotId, projected: false };
        }
        const latest = await tx.marketplaceQualitySnapshot.findFirst({
          where: {
            packageId: request.scope.packageId,
            releaseId: request.scope.releaseId,
            currentReleaseActivatedAt: request.scope.currentReleaseActivatedAt,
            eligibilityRevision: request.scope.eligibilityRevision,
            policyVersion: MARKETPLACE_QUALITY_POLICY_V1.version,
          },
          orderBy: { computationRevision: 'desc' },
          select: { computationRevision: true },
        });
        const computationRevision = (latest?.computationRevision ?? 0n) + 1n;
        const m = evaluation.metrics;
        const snapshot = await tx.marketplaceQualitySnapshot.create({
          data: {
            packageId: request.scope.packageId,
            releaseId: request.scope.releaseId,
            currentReleaseActivatedAt: request.scope.currentReleaseActivatedAt,
            listingEligibleSince: request.scope.listingEligibleSince,
            releaseEligibleSince: request.scope.releaseEligibleSince,
            eligibilityRevision: request.scope.eligibilityRevision,
            policyVersion: MARKETPLACE_QUALITY_POLICY_V1.version,
            factWatermark: request.factWatermark,
            computationRevision,
            windowStart: new Date(request.factWatermark.getTime() - THIRTY_DAYS_MS),
            windowEnd: request.factWatermark,
            listingAgeDays: m.listing_age_days,
            currentReleaseAgeDays: m.current_release_age_days,
            activeTeams30d: m.active_teams_30d,
            installTeams30d: m.install_teams_30d,
            observedRuns30d: m.observed_runs_30d,
            failedRuns30d: m.failed_runs_30d,
            failureRateBps: m.failure_rate_bps,
            ratingTeams: m.rating_teams,
            ratingSum: m.rating_sum,
            averageRatingTenths: m.average_rating_tenths,
            refundMetricState: m.refund_metric_state,
            maturedPaidOrders90d: m.matured_paid_orders_90d,
            approvedRefunds90d: m.approved_refunds_90d,
            refundRateBps: m.refund_rate_bps,
            securityIncidents90d: m.security_incidents_90d,
            anomalyReviewRequired: request.facts.anomalyReviewRequired,
            autoQualified: evaluation.autoQualified,
            reasons: evaluation.reasons as unknown as Prisma.InputJsonValue,
          },
        });
        await tx.marketplaceQualityComputation.update({
          where: { id: computationId },
          data: {
            status: 'SUCCEEDED',
            snapshotId: snapshot.id,
            finishedAt: new Date(),
            errorCode: null,
          },
        });

        const listing = await tx.marketplaceListing.findUnique({
          where: { id: request.scope.listingId },
        });
        if (!listing) return { snapshotId: snapshot.id, projected: false };
        const currentSnapshot = listing.qualitySnapshotId
          ? await tx.marketplaceQualitySnapshot.findUnique({
              where: { id: listing.qualitySnapshotId },
              select: { factWatermark: true, computationRevision: true },
            })
          : null;
        const eligible = canProjectQualitySnapshot({
          expectedReleaseId: request.scope.releaseId,
          expectedPointerRevision: request.scope.pointerRevision,
          expectedEligibilityRevision: request.scope.eligibilityRevision,
          expectedGateDigest: request.scope.eligibilityGateDigest,
          currentReleaseId: listing.currentReleaseId,
          currentPointerRevision: listing.pointerRevision,
          currentEligibilityRevision: listing.eligibilityRevision,
          currentGateDigest: listing.eligibilityGateDigest,
          candidate: { factWatermark: request.factWatermark, computationRevision },
          current: currentSnapshot,
        });
        if (!eligible || listing.status !== 'ACTIVE')
          return { snapshotId: snapshot.id, projected: false };
        const featured =
          listing.featuredAt !== null &&
          (listing.featuredUntil === null || listing.featuredUntil > request.factWatermark);
        const nextTier = featured ? 'FEATURED' : evaluation.tier;
        const update = await tx.marketplaceListing.updateMany({
          where: {
            id: listing.id,
            currentReleaseId: request.scope.releaseId,
            currentReleaseActivatedAt: request.scope.currentReleaseActivatedAt,
            pointerRevision: request.scope.pointerRevision,
            eligibilityRevision: request.scope.eligibilityRevision,
            eligibilityGateDigest: request.scope.eligibilityGateDigest,
            qualitySnapshotId: listing.qualitySnapshotId,
          },
          data: {
            qualitySnapshotId: snapshot.id,
            qualityTier: nextTier,
            qualityQualifiedAt: evaluation.autoQualified
              ? (listing.qualityQualifiedAt ?? request.factWatermark)
              : null,
          },
        });
        return { snapshotId: snapshot.id, projected: update.count === 1 };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  }

  async fail(computationId: string, errorCode: string, finishedAt: Date): Promise<void> {
    await this.prisma.marketplaceQualityComputation.updateMany({
      where: { id: computationId, status: 'RUNNING' },
      data: {
        status: 'FAILED',
        errorCode: errorCode.slice(0, 128),
        finishedAt,
      },
    });
  }
}

function validateRequest(request: MarketplaceQualityComputeRequest): void {
  if (!request.jobKey.trim() || request.jobKey.length > 512)
    throw new Error('marketplace_quality_invalid_job_key');
  if (
    Number.isNaN(request.factWatermark.getTime()) ||
    request.factWatermark < request.scope.currentReleaseActivatedAt
  )
    throw new Error('marketplace_quality_invalid_watermark');
  if (!/^[a-f0-9]{64}$/.test(request.scope.eligibilityGateDigest))
    throw new Error('marketplace_quality_invalid_gate_digest');
}

function sameComputationRequest(
  row: {
    kind: MarketplaceQualityComputationKind;
    packageId: string;
    releaseId: string;
    currentReleaseActivatedAt: Date;
    pointerRevision: number;
    eligibilityRevision: number;
    requestedFactWatermark: Date;
  },
  request: MarketplaceQualityComputeRequest
): boolean {
  return (
    row.kind === request.kind &&
    row.packageId === request.scope.packageId &&
    row.releaseId === request.scope.releaseId &&
    row.currentReleaseActivatedAt.getTime() === request.scope.currentReleaseActivatedAt.getTime() &&
    row.pointerRevision === request.scope.pointerRevision &&
    row.eligibilityRevision === request.scope.eligibilityRevision &&
    row.requestedFactWatermark.getTime() === request.factWatermark.getTime()
  );
}

function qualityErrorCode(error: unknown): string {
  return error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
    ? error.message
    : 'marketplace_quality_computation_failed';
}
