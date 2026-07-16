CREATE TYPE "MarketplaceCategory" AS ENUM ('AI', 'PRODUCTIVITY', 'DEV', 'DATA', 'MEDIA', 'FILES', 'NETWORK', 'SYSTEM', 'OTHER');
CREATE TYPE "MarketplaceQualityTier" AS ENUM ('LISTED', 'QUALITY', 'FEATURED');
CREATE TYPE "MarketplaceMetricKind" AS ENUM ('INSTALL_SUCCEEDED', 'RUN_SUCCEEDED', 'RUN_FAILED', 'RATING_CHANGED', 'PURCHASED', 'REFUNDED', 'SECURITY_BLOCKED', 'SECURITY_CLEARED');
CREATE TYPE "MarketplaceMetricSource" AS ENUM ('DESKTOP_HOST', 'CLOUD_RUNTIME', 'WORKFLOW_RUNTIME', 'REGISTRY', 'COMMERCE', 'SECURITY');
CREATE TYPE "MarketplaceUsageOutcome" AS ENUM ('SUCCEEDED', 'FAILED', 'CANCELED', 'EXCLUDED');
CREATE TYPE "MarketplaceEligibilityKind" AS ENUM ('LISTING', 'RELEASE');
CREATE TYPE "MarketplaceRefundMetricState" AS ENUM ('AVAILABLE', 'NOT_APPLICABLE', 'INSUFFICIENT_SAMPLE', 'DATA_UNAVAILABLE');
CREATE TYPE "MarketplaceQualityComputationKind" AS ENUM ('DAILY', 'MANUAL');
CREATE TYPE "MarketplaceQualityComputationStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

ALTER TABLE "MarketplaceListing"
  ADD COLUMN "category" "MarketplaceCategory" NOT NULL DEFAULT 'OTHER',
  ADD COLUMN "currentReleaseActivatedAt" TIMESTAMP(3),
  ADD COLUMN "pointerRevision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "listingEligibleSince" TIMESTAMP(3),
  ADD COLUMN "releaseEligibleSince" TIMESTAMP(3),
  ADD COLUMN "eligibilityRevision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "eligibilityGateDigest" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "qualityTier" "MarketplaceQualityTier" NOT NULL DEFAULT 'LISTED',
  ADD COLUMN "qualitySnapshotId" TEXT,
  ADD COLUMN "qualityQualifiedAt" TIMESTAMP(3),
  ADD COLUMN "qualityBlockedAt" TIMESTAMP(3),
  ADD COLUMN "qualityBlockedByUserId" TEXT,
  ADD COLUMN "qualityBlockedReason" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "featuredAt" TIMESTAMP(3),
  ADD COLUMN "featuredUntil" TIMESTAMP(3),
  ADD COLUMN "featuredByUserId" TEXT,
  ADD COLUMN "featuredReason" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "featuredRank" INTEGER;

CREATE TABLE "MarketplaceListingReleaseActivation" (
  "id" TEXT NOT NULL, "listingId" TEXT NOT NULL, "releaseId" TEXT NOT NULL,
  "activatedAt" TIMESTAMP(3) NOT NULL, "changedByUserId" TEXT, "source" TEXT NOT NULL,
  "pointerRevision" INTEGER NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MarketplaceListingReleaseActivation_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "MarketplaceListingEligibilityEpoch" (
  "id" TEXT NOT NULL, "listingId" TEXT NOT NULL, "releaseId" TEXT, "kind" "MarketplaceEligibilityKind" NOT NULL,
  "generation" INTEGER NOT NULL, "startedAt" TIMESTAMP(3) NOT NULL, "endedAt" TIMESTAMP(3),
  "startReason" TEXT NOT NULL, "endReason" TEXT, "gateSnapshotDigest" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MarketplaceListingEligibilityEpoch_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "MarketplaceMetricEvent" (
  "id" TEXT NOT NULL, "idempotencyKey" TEXT NOT NULL, "packageId" TEXT NOT NULL, "releaseId" TEXT NOT NULL,
  "teamId" TEXT, "kind" "MarketplaceMetricKind" NOT NULL, "source" "MarketplaceMetricSource" NOT NULL,
  "sourceRecordId" TEXT NOT NULL, "value" INTEGER, "metadata" JSONB, "occurredAt" TIMESTAMP(3) NOT NULL,
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MarketplaceMetricEvent_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "MarketplaceUsageSession" (
  "id" TEXT NOT NULL, "packageId" TEXT NOT NULL, "releaseId" TEXT NOT NULL, "sha256" TEXT NOT NULL,
  "teamId" TEXT NOT NULL, "userId" TEXT NOT NULL, "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL, "completedAt" TIMESTAMP(3), "outcome" "MarketplaceUsageOutcome",
  "failureClass" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MarketplaceUsageSession_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "MarketplaceRating" (
  "id" TEXT NOT NULL, "packageId" TEXT NOT NULL, "teamId" TEXT NOT NULL, "score" INTEGER NOT NULL,
  "comment" TEXT NOT NULL DEFAULT '', "revision" INTEGER NOT NULL DEFAULT 1, "createdById" TEXT NOT NULL,
  "updatedById" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MarketplaceRating_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "MarketplaceRatingRevision" (
  "id" TEXT NOT NULL, "ratingId" TEXT NOT NULL, "packageId" TEXT NOT NULL, "teamId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL, "score" INTEGER NOT NULL, "recordedAt" TIMESTAMP(3) NOT NULL,
  "sourceKind" TEXT NOT NULL, "sourceId" TEXT NOT NULL, "actorUserId" TEXT NOT NULL,
  CONSTRAINT "MarketplaceRatingRevision_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "MarketplaceQualitySnapshot" (
  "id" TEXT NOT NULL, "packageId" TEXT NOT NULL, "releaseId" TEXT NOT NULL, "currentReleaseActivatedAt" TIMESTAMP(3) NOT NULL,
  "listingEligibleSince" TIMESTAMP(3), "releaseEligibleSince" TIMESTAMP(3), "eligibilityRevision" INTEGER NOT NULL,
  "policyVersion" INTEGER NOT NULL, "factWatermark" TIMESTAMP(3) NOT NULL, "computationRevision" BIGINT NOT NULL,
  "windowStart" TIMESTAMP(3) NOT NULL, "windowEnd" TIMESTAMP(3) NOT NULL, "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "listingAgeDays" INTEGER NOT NULL, "currentReleaseAgeDays" INTEGER NOT NULL, "activeTeams30d" INTEGER NOT NULL,
  "installTeams30d" INTEGER NOT NULL, "observedRuns30d" INTEGER NOT NULL, "failedRuns30d" INTEGER NOT NULL,
  "failureRateBps" INTEGER, "ratingTeams" INTEGER NOT NULL, "ratingSum" INTEGER NOT NULL, "averageRatingTenths" INTEGER,
  "refundMetricState" "MarketplaceRefundMetricState" NOT NULL, "maturedPaidOrders90d" INTEGER NOT NULL,
  "approvedRefunds90d" INTEGER NOT NULL, "refundRateBps" INTEGER, "securityIncidents90d" INTEGER NOT NULL,
  "anomalyReviewRequired" BOOLEAN NOT NULL DEFAULT false, "autoQualified" BOOLEAN NOT NULL, "reasons" JSONB NOT NULL,
  CONSTRAINT "MarketplaceQualitySnapshot_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "MarketplaceQualityComputation" (
  "id" TEXT NOT NULL, "jobKey" TEXT NOT NULL, "kind" "MarketplaceQualityComputationKind" NOT NULL,
  "packageId" TEXT NOT NULL, "releaseId" TEXT NOT NULL, "currentReleaseActivatedAt" TIMESTAMP(3) NOT NULL,
  "pointerRevision" INTEGER NOT NULL, "eligibilityRevision" INTEGER NOT NULL, "requestedFactWatermark" TIMESTAMP(3) NOT NULL,
  "status" "MarketplaceQualityComputationStatus" NOT NULL DEFAULT 'RUNNING', "snapshotId" TEXT, "errorCode" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "finishedAt" TIMESTAMP(3),
  CONSTRAINT "MarketplaceQualityComputation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MarketplaceListingReleaseActivation_listingId_pointerRevision_key" ON "MarketplaceListingReleaseActivation"("listingId", "pointerRevision");
CREATE INDEX "MarketplaceListingReleaseActivation_listingId_activatedAt_idx" ON "MarketplaceListingReleaseActivation"("listingId", "activatedAt");
CREATE INDEX "MarketplaceListingReleaseActivation_releaseId_activatedAt_idx" ON "MarketplaceListingReleaseActivation"("releaseId", "activatedAt");
CREATE UNIQUE INDEX "MarketplaceListingEligibilityEpoch_listingId_kind_generation_key" ON "MarketplaceListingEligibilityEpoch"("listingId", "kind", "generation");
CREATE INDEX "MarketplaceListingEligibilityEpoch_listingId_kind_startedAt_idx" ON "MarketplaceListingEligibilityEpoch"("listingId", "kind", "startedAt");
CREATE INDEX "MarketplaceListingEligibilityEpoch_releaseId_kind_startedAt_idx" ON "MarketplaceListingEligibilityEpoch"("releaseId", "kind", "startedAt");
CREATE UNIQUE INDEX "MarketplaceMetricEvent_idempotencyKey_key" ON "MarketplaceMetricEvent"("idempotencyKey");
CREATE INDEX "MarketplaceMetricEvent_packageId_kind_occurredAt_idx" ON "MarketplaceMetricEvent"("packageId", "kind", "occurredAt");
CREATE INDEX "MarketplaceMetricEvent_packageId_releaseId_kind_occurredAt_idx" ON "MarketplaceMetricEvent"("packageId", "releaseId", "kind", "occurredAt");
CREATE INDEX "MarketplaceMetricEvent_teamId_occurredAt_idx" ON "MarketplaceMetricEvent"("teamId", "occurredAt");
CREATE INDEX "MarketplaceMetricEvent_recordedAt_idx" ON "MarketplaceMetricEvent"("recordedAt");
CREATE INDEX "MarketplaceUsageSession_teamId_userId_expiresAt_idx" ON "MarketplaceUsageSession"("teamId", "userId", "expiresAt");
CREATE INDEX "MarketplaceUsageSession_packageId_releaseId_completedAt_idx" ON "MarketplaceUsageSession"("packageId", "releaseId", "completedAt");
CREATE UNIQUE INDEX "MarketplaceRating_packageId_teamId_key" ON "MarketplaceRating"("packageId", "teamId");
CREATE INDEX "MarketplaceRating_packageId_updatedAt_idx" ON "MarketplaceRating"("packageId", "updatedAt");
CREATE UNIQUE INDEX "MarketplaceRatingRevision_ratingId_revision_key" ON "MarketplaceRatingRevision"("ratingId", "revision");
CREATE INDEX "MarketplaceRatingRevision_packageId_teamId_recordedAt_idx" ON "MarketplaceRatingRevision"("packageId", "teamId", "recordedAt");
CREATE INDEX "MarketplaceRatingRevision_packageId_recordedAt_idx" ON "MarketplaceRatingRevision"("packageId", "recordedAt");
CREATE UNIQUE INDEX "MarketplaceQualitySnapshot_identity_key" ON "MarketplaceQualitySnapshot"("packageId", "releaseId", "currentReleaseActivatedAt", "eligibilityRevision", "policyVersion", "factWatermark", "computationRevision");
CREATE INDEX "MarketplaceQualitySnapshot_packageId_releaseId_factWatermark_computationRevision_idx" ON "MarketplaceQualitySnapshot"("packageId", "releaseId", "factWatermark", "computationRevision");
CREATE INDEX "MarketplaceQualitySnapshot_autoQualified_computedAt_idx" ON "MarketplaceQualitySnapshot"("autoQualified", "computedAt");
CREATE UNIQUE INDEX "MarketplaceQualityComputation_jobKey_key" ON "MarketplaceQualityComputation"("jobKey");
CREATE INDEX "MarketplaceQualityComputation_packageId_startedAt_idx" ON "MarketplaceQualityComputation"("packageId", "startedAt");
CREATE INDEX "MarketplaceQualityComputation_status_startedAt_idx" ON "MarketplaceQualityComputation"("status", "startedAt");
CREATE INDEX "MarketplaceListing_category_status_qualityTier_idx" ON "MarketplaceListing"("category", "status", "qualityTier");
CREATE INDEX "MarketplaceListing_qualityTier_qualityQualifiedAt_idx" ON "MarketplaceListing"("qualityTier", "qualityQualifiedAt");
CREATE INDEX "MarketplaceListing_featuredUntil_featuredRank_idx" ON "MarketplaceListing"("featuredUntil", "featuredRank");

-- Existing listings conservatively restart observation at migration time. Legacy aggregates are intentionally not copied.
UPDATE "MarketplaceListing"
SET "currentReleaseActivatedAt" = CURRENT_TIMESTAMP,
    "pointerRevision" = CASE WHEN "currentReleaseId" IS NULL THEN 0 ELSE 1 END,
    "listingEligibleSince" = CASE WHEN "status" = 'ACTIVE' AND "currentReleaseId" IS NOT NULL THEN CURRENT_TIMESTAMP ELSE NULL END,
    "releaseEligibleSince" = CASE WHEN "status" = 'ACTIVE' AND "currentReleaseId" IS NOT NULL THEN CURRENT_TIMESTAMP ELSE NULL END,
    "eligibilityRevision" = CASE WHEN "status" = 'ACTIVE' AND "currentReleaseId" IS NOT NULL THEN 1 ELSE 0 END;

INSERT INTO "MarketplaceListingReleaseActivation" ("id", "listingId", "releaseId", "activatedAt", "source", "pointerRevision")
SELECT md5("id" || ':quality-backfill'), "id", "currentReleaseId", "currentReleaseActivatedAt", 'BACKFILL', "pointerRevision"
FROM "MarketplaceListing" WHERE "currentReleaseId" IS NOT NULL;

INSERT INTO "MarketplaceListingEligibilityEpoch" ("id", "listingId", "releaseId", "kind", "generation", "startedAt", "startReason", "gateSnapshotDigest")
SELECT md5("id" || ':listing-eligibility-backfill'), "id", "currentReleaseId", 'LISTING', 1, "listingEligibleSince", 'BACKFILL', ''
FROM "MarketplaceListing" WHERE "listingEligibleSince" IS NOT NULL;

INSERT INTO "MarketplaceListingEligibilityEpoch" ("id", "listingId", "releaseId", "kind", "generation", "startedAt", "startReason", "gateSnapshotDigest")
SELECT md5("id" || ':release-eligibility-backfill'), "id", "currentReleaseId", 'RELEASE', 1, "releaseEligibleSince", 'BACKFILL', ''
FROM "MarketplaceListing" WHERE "releaseEligibleSince" IS NOT NULL;
