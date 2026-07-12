-- Plugin registry v4. Legacy Plugin rows remain available during the cutover period.
CREATE TYPE "PluginPackageStatus" AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TYPE "PluginArtifactStatus" AS ENUM ('PUBLISHED', 'YANKED');
CREATE TYPE "MarketplaceListingStatus" AS ENUM ('DRAFT', 'ACTIVE', 'DELISTED');
CREATE TYPE "PluginEntitlementKind" AS ENUM ('PURCHASED');

ALTER TABLE "PluginGrant" ALTER COLUMN "pluginId" DROP NOT NULL;
ALTER TABLE "PluginGrant" ADD COLUMN "packageId" TEXT;
ALTER TABLE "Purchase" ALTER COLUMN "pluginId" DROP NOT NULL;
ALTER TABLE "Purchase" ADD COLUMN "packageId" TEXT;

CREATE TABLE "PluginPackage" (
  "id" TEXT NOT NULL,
  "ownerTeamId" TEXT NOT NULL,
  "authorUserId" TEXT,
  "manifestId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "governanceStatus" "PluginPackageStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PluginPackage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PluginRelease" (
  "id" TEXT NOT NULL,
  "packageId" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "manifest" JSONB NOT NULL,
  "fileManifest" JSONB NOT NULL DEFAULT '[]',
  "artifactKey" TEXT NOT NULL,
  "sha256" TEXT NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "targetPlatform" TEXT NOT NULL DEFAULT 'windows-x64',
  "status" "PluginArtifactStatus" NOT NULL DEFAULT 'PUBLISHED',
  "marketReviewStatus" "PluginReviewStatus" NOT NULL DEFAULT 'DRAFT',
  "reviewReason" TEXT NOT NULL DEFAULT '',
  "reviewedById" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PluginRelease_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MarketplaceListing" (
  "id" TEXT NOT NULL,
  "packageId" TEXT NOT NULL,
  "currentReleaseId" TEXT,
  "priceCents" INTEGER NOT NULL DEFAULT 0,
  "status" "MarketplaceListingStatus" NOT NULL DEFAULT 'DRAFT',
  "installCount" INTEGER NOT NULL DEFAULT 0,
  "ratingCount" INTEGER NOT NULL DEFAULT 0,
  "ratingSum" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MarketplaceListing_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PluginEntitlement" (
  "id" TEXT NOT NULL,
  "teamId" TEXT NOT NULL,
  "packageId" TEXT NOT NULL,
  "kind" "PluginEntitlementKind" NOT NULL DEFAULT 'PURCHASED',
  "purchaseId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PluginEntitlement_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PluginReleaseReview" (
  "id" TEXT NOT NULL,
  "releaseId" TEXT NOT NULL,
  "reviewerId" TEXT,
  "status" "PluginReviewStatus" NOT NULL,
  "reason" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PluginReleaseReview_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PluginPackage_ownerTeamId_manifestId_key" ON "PluginPackage"("ownerTeamId", "manifestId");
CREATE INDEX "PluginPackage_ownerTeamId_governanceStatus_updatedAt_idx" ON "PluginPackage"("ownerTeamId", "governanceStatus", "updatedAt");
CREATE INDEX "PluginPackage_authorUserId_createdAt_idx" ON "PluginPackage"("authorUserId", "createdAt");
CREATE UNIQUE INDEX "PluginRelease_artifactKey_key" ON "PluginRelease"("artifactKey");
CREATE UNIQUE INDEX "PluginRelease_packageId_version_key" ON "PluginRelease"("packageId", "version");
CREATE INDEX "PluginRelease_packageId_status_createdAt_idx" ON "PluginRelease"("packageId", "status", "createdAt");
CREATE INDEX "PluginRelease_marketReviewStatus_createdAt_idx" ON "PluginRelease"("marketReviewStatus", "createdAt");
CREATE INDEX "PluginRelease_createdById_createdAt_idx" ON "PluginRelease"("createdById", "createdAt");
CREATE UNIQUE INDEX "MarketplaceListing_packageId_key" ON "MarketplaceListing"("packageId");
CREATE INDEX "MarketplaceListing_status_updatedAt_idx" ON "MarketplaceListing"("status", "updatedAt");
CREATE INDEX "MarketplaceListing_currentReleaseId_idx" ON "MarketplaceListing"("currentReleaseId");
CREATE UNIQUE INDEX "PluginEntitlement_teamId_packageId_key" ON "PluginEntitlement"("teamId", "packageId");
CREATE INDEX "PluginEntitlement_packageId_createdAt_idx" ON "PluginEntitlement"("packageId", "createdAt");
CREATE UNIQUE INDEX "PluginEntitlement_purchaseId_key" ON "PluginEntitlement"("purchaseId");
CREATE INDEX "PluginReleaseReview_releaseId_createdAt_idx" ON "PluginReleaseReview"("releaseId", "createdAt");
CREATE INDEX "PluginReleaseReview_status_createdAt_idx" ON "PluginReleaseReview"("status", "createdAt");
CREATE UNIQUE INDEX "PluginGrant_teamId_packageId_subjectKind_subjectId_key" ON "PluginGrant"("teamId", "packageId", "subjectKind", "subjectId");
CREATE INDEX "PluginGrant_teamId_packageId_idx" ON "PluginGrant"("teamId", "packageId");
CREATE UNIQUE INDEX "Purchase_packageId_buyerTeamId_key" ON "Purchase"("packageId", "buyerTeamId");
CREATE INDEX "Purchase_packageId_idx" ON "Purchase"("packageId");

ALTER TABLE "PluginPackage" ADD CONSTRAINT "PluginPackage_ownerTeamId_fkey" FOREIGN KEY ("ownerTeamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PluginPackage" ADD CONSTRAINT "PluginPackage_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PluginRelease" ADD CONSTRAINT "PluginRelease_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "PluginPackage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PluginRelease" ADD CONSTRAINT "PluginRelease_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MarketplaceListing" ADD CONSTRAINT "MarketplaceListing_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "PluginPackage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MarketplaceListing" ADD CONSTRAINT "MarketplaceListing_currentReleaseId_fkey" FOREIGN KEY ("currentReleaseId") REFERENCES "PluginRelease"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PluginEntitlement" ADD CONSTRAINT "PluginEntitlement_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PluginEntitlement" ADD CONSTRAINT "PluginEntitlement_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "PluginPackage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PluginEntitlement" ADD CONSTRAINT "PluginEntitlement_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PluginReleaseReview" ADD CONSTRAINT "PluginReleaseReview_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "PluginRelease"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PluginReleaseReview" ADD CONSTRAINT "PluginReleaseReview_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PluginGrant" ADD CONSTRAINT "PluginGrant_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "PluginPackage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "PluginPackage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
