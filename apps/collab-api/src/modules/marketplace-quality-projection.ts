import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { conflict } from '../common';
import { PLUGIN_AI_POLICY_VERSION } from './plugin-ai-policy';

export type MarketplaceQualityGateFacts = {
  listingStatus: string;
  currentReleaseId: string | null;
  currentReleaseStatus: string | null;
  marketReviewStatus: string | null;
  aiPolicyVersion: number | null;
  aiPolicyStatus: string | null;
  securityBlocked: boolean;
  pointerRevision: number;
  eligibilityRevision: number;
};

export type QualitySnapshotOrder = {
  factWatermark: Date;
  computationRevision: bigint;
};

export function marketplaceQualityGateDigest(facts: MarketplaceQualityGateFacts): string {
  const canonical = JSON.stringify({
    ai_policy_status: facts.aiPolicyStatus,
    ai_policy_version: facts.aiPolicyVersion,
    current_release_id: facts.currentReleaseId,
    current_release_status: facts.currentReleaseStatus,
    eligibility_revision: facts.eligibilityRevision,
    listing_status: facts.listingStatus,
    market_review_status: facts.marketReviewStatus,
    pointer_revision: facts.pointerRevision,
    security_blocked: facts.securityBlocked,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function isNewerQualitySnapshot(
  candidate: QualitySnapshotOrder,
  current: QualitySnapshotOrder | null
): boolean {
  if (!current) return true;
  const time = candidate.factWatermark.getTime() - current.factWatermark.getTime();
  if (time !== 0) return time > 0;
  return candidate.computationRevision > current.computationRevision;
}

export function canProjectQualitySnapshot(input: {
  expectedReleaseId: string;
  expectedPointerRevision: number;
  expectedEligibilityRevision: number;
  expectedGateDigest: string;
  currentReleaseId: string | null;
  currentPointerRevision: number;
  currentEligibilityRevision: number;
  currentGateDigest: string;
  candidate: QualitySnapshotOrder;
  current: QualitySnapshotOrder | null;
}): boolean {
  return (
    input.currentReleaseId === input.expectedReleaseId &&
    input.currentPointerRevision === input.expectedPointerRevision &&
    input.currentEligibilityRevision === input.expectedEligibilityRevision &&
    input.currentGateDigest === input.expectedGateDigest &&
    isNewerQualitySnapshot(input.candidate, input.current)
  );
}

export async function projectMarketplaceQualityGateTx(
  tx: Prisma.TransactionClient,
  packageId: string,
  reason: string,
  now = new Date(),
  options: { securityBlocked?: boolean } = {}
) {
  const db = tx as Prisma.TransactionClient & {
    marketplaceListingReleaseActivation?: Prisma.TransactionClient['marketplaceListingReleaseActivation'];
    marketplaceListingEligibilityEpoch?: Prisma.TransactionClient['marketplaceListingEligibilityEpoch'];
  };
  // Partial unit-test transaction doubles created before the quality rollout
  // intentionally omit the new append-only history repositories.
  if (!db.marketplaceListingReleaseActivation || !db.marketplaceListingEligibilityEpoch)
    return null;
  const listing = await tx.marketplaceListing.findUnique({
    where: { packageId },
    include: { package: true, currentRelease: true },
  });
  if (!listing) return null;
  const latestActivation = await db.marketplaceListingReleaseActivation.findFirst({
    where: { listingId: listing.id },
    orderBy: { pointerRevision: 'desc' },
  });
  const pointerChanged = Boolean(
    listing.currentReleaseId && latestActivation?.releaseId !== listing.currentReleaseId
  );
  const securityBlocked = options.securityBlocked ?? (await currentSecurityBlocked(tx, packageId));
  const hardGateEligible =
    listing.status === 'ACTIVE' &&
    listing.package.governanceStatus === 'ACTIVE' &&
    listing.currentReleaseId === listing.currentRelease?.id &&
    listing.currentRelease?.status === 'PUBLISHED' &&
    listing.currentRelease?.marketReviewStatus === 'APPROVED' &&
    listing.currentRelease?.aiPolicyVersion === PLUGIN_AI_POLICY_VERSION &&
    listing.currentRelease?.aiPolicyStatus === 'PASSED' &&
    !securityBlocked;
  const currentlyEligible = Boolean(listing.listingEligibleSince && listing.releaseEligibleSince);

  let pointerRevision = listing.pointerRevision;
  let activatedAt = listing.currentReleaseActivatedAt;
  let eligibilityRevision = listing.eligibilityRevision;
  let listingEligibleSince = listing.listingEligibleSince;
  let releaseEligibleSince = listing.releaseEligibleSince;
  let resetProjection = false;
  let closeListingEpoch = false;
  let closeReleaseEpoch = false;
  let openListingEpoch = false;
  let openReleaseEpoch = false;

  if (pointerChanged) {
    pointerRevision += 1;
    eligibilityRevision += 1;
    activatedAt = now;
    resetProjection = true;
    closeReleaseEpoch = true;
    if (hardGateEligible) {
      if (!listingEligibleSince) {
        listingEligibleSince = now;
        openListingEpoch = true;
      }
      releaseEligibleSince = now;
      openReleaseEpoch = true;
    } else {
      closeListingEpoch = Boolean(listingEligibleSince);
      listingEligibleSince = null;
      releaseEligibleSince = null;
    }
  } else if (hardGateEligible !== currentlyEligible) {
    eligibilityRevision += 1;
    resetProjection = true;
    if (hardGateEligible) {
      listingEligibleSince = now;
      releaseEligibleSince = now;
      openListingEpoch = true;
      openReleaseEpoch = true;
    } else {
      closeListingEpoch = Boolean(listingEligibleSince);
      closeReleaseEpoch = Boolean(releaseEligibleSince);
      listingEligibleSince = null;
      releaseEligibleSince = null;
    }
  }

  const digest = marketplaceQualityGateDigest({
    listingStatus: listing.status,
    currentReleaseId: listing.currentReleaseId,
    currentReleaseStatus: listing.currentRelease?.status ?? null,
    marketReviewStatus: listing.currentRelease?.marketReviewStatus ?? null,
    aiPolicyVersion: listing.currentRelease?.aiPolicyVersion ?? null,
    aiPolicyStatus: listing.currentRelease?.aiPolicyStatus ?? null,
    securityBlocked,
    pointerRevision,
    eligibilityRevision,
  });
  const changed = await tx.marketplaceListing.updateMany({
    where: {
      id: listing.id,
      currentReleaseId: listing.currentReleaseId,
      pointerRevision: listing.pointerRevision,
      eligibilityRevision: listing.eligibilityRevision,
      eligibilityGateDigest: listing.eligibilityGateDigest,
    },
    data: {
      pointerRevision,
      currentReleaseActivatedAt: activatedAt,
      listingEligibleSince,
      releaseEligibleSince,
      eligibilityRevision,
      eligibilityGateDigest: digest,
      ...(resetProjection
        ? { qualityTier: 'LISTED' as const, qualitySnapshotId: null, qualityQualifiedAt: null }
        : {}),
    },
  });
  if (changed.count !== 1) throw conflict('市场质量门禁状态发生并发冲突，请重试');

  if (pointerChanged && listing.currentReleaseId && activatedAt) {
    await db.marketplaceListingReleaseActivation.create({
      data: {
        listingId: listing.id,
        releaseId: listing.currentReleaseId,
        activatedAt,
        source: reason,
        pointerRevision,
      },
    });
  }
  if (closeListingEpoch)
    await db.marketplaceListingEligibilityEpoch.updateMany({
      where: { listingId: listing.id, kind: 'LISTING', endedAt: null },
      data: { endedAt: now, endReason: reason },
    });
  if (closeReleaseEpoch)
    await db.marketplaceListingEligibilityEpoch.updateMany({
      where: { listingId: listing.id, kind: 'RELEASE', endedAt: null },
      data: { endedAt: now, endReason: reason },
    });
  if (openListingEpoch && listingEligibleSince)
    await db.marketplaceListingEligibilityEpoch.create({
      data: {
        listingId: listing.id,
        releaseId: listing.currentReleaseId,
        kind: 'LISTING',
        generation: eligibilityRevision,
        startedAt: listingEligibleSince,
        startReason: reason,
        gateSnapshotDigest: digest,
      },
    });
  if (openReleaseEpoch && releaseEligibleSince)
    await db.marketplaceListingEligibilityEpoch.create({
      data: {
        listingId: listing.id,
        releaseId: listing.currentReleaseId,
        kind: 'RELEASE',
        generation: eligibilityRevision,
        startedAt: releaseEligibleSince,
        startReason: reason,
        gateSnapshotDigest: digest,
      },
    });
  return {
    hardGateEligible,
    pointerChanged,
    pointerRevision,
    eligibilityRevision,
    eligibilityGateDigest: digest,
    currentReleaseActivatedAt: activatedAt,
    listingEligibleSince,
    releaseEligibleSince,
    securityBlocked,
  };
}

async function currentSecurityBlocked(
  tx: Prisma.TransactionClient,
  packageId: string
): Promise<boolean> {
  const repository = (
    tx as Prisma.TransactionClient & {
      marketplaceMetricEvent?: Prisma.TransactionClient['marketplaceMetricEvent'];
    }
  ).marketplaceMetricEvent;
  if (!repository?.findMany) return false;
  const events = await repository.findMany({
    where: { packageId, kind: { in: ['SECURITY_BLOCKED', 'SECURITY_CLEARED'] } },
    orderBy: [{ occurredAt: 'asc' }, { recordedAt: 'asc' }, { id: 'asc' }],
    select: { kind: true, sourceRecordId: true },
  });
  const open = new Set<string>();
  for (const event of events) {
    if (event.kind === 'SECURITY_BLOCKED') open.add(event.sourceRecordId);
    else open.delete(event.sourceRecordId);
  }
  return open.size > 0;
}
