-- Cloud plugin sharing, marketplace review, and team installation state.

CREATE TYPE "PluginRuntimeType" AS ENUM ('CLIENT', 'CLOUD');
CREATE TYPE "PluginVisibility" AS ENUM ('PRIVATE', 'TEAM', 'PUBLIC');
CREATE TYPE "PluginReviewStatus" AS ENUM ('DRAFT', 'PENDING', 'APPROVED', 'REJECTED');

ALTER TABLE "Plugin"
  ADD COLUMN "version" TEXT NOT NULL DEFAULT '0.1.0',
  ADD COLUMN "entry" TEXT NOT NULL DEFAULT 'ui/index.html',
  ADD COLUMN "runtimeType" "PluginRuntimeType" NOT NULL DEFAULT 'CLIENT',
  ADD COLUMN "visibility" "PluginVisibility" NOT NULL DEFAULT 'TEAM',
  ADD COLUMN "teamId" TEXT,
  ADD COLUMN "authorUserId" TEXT,
  ADD COLUMN "files" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "manifest" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "capabilities" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "contentHash" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "reviewStatus" "PluginReviewStatus" NOT NULL DEFAULT 'DRAFT',
  ADD COLUMN "reviewReason" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "reviewedById" TEXT,
  ADD COLUMN "reviewedAt" TIMESTAMP(3),
  ADD COLUMN "marketplace" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "priceCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "installCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "ratingCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "ratingSum" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "PluginInstallation" (
  "id" TEXT NOT NULL,
  "pluginId" TEXT NOT NULL,
  "teamId" TEXT NOT NULL,
  "installedById" TEXT,
  "version" TEXT NOT NULL,
  "status" "PluginStatus" NOT NULL DEFAULT 'ENABLED',
  "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PluginInstallation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PluginReview" (
  "id" TEXT NOT NULL,
  "pluginId" TEXT NOT NULL,
  "reviewerId" TEXT,
  "status" "PluginReviewStatus" NOT NULL,
  "reason" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PluginReview_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Plugin_teamId_contentHash_key" ON "Plugin"("teamId", "contentHash");
CREATE INDEX "Plugin_teamId_status_visibility_idx" ON "Plugin"("teamId", "status", "visibility");
CREATE INDEX "Plugin_authorUserId_createdAt_idx" ON "Plugin"("authorUserId", "createdAt");
CREATE INDEX "Plugin_marketplace_reviewStatus_status_idx" ON "Plugin"("marketplace", "reviewStatus", "status");
CREATE INDEX "Plugin_reviewStatus_createdAt_idx" ON "Plugin"("reviewStatus", "createdAt");

CREATE UNIQUE INDEX "PluginInstallation_pluginId_teamId_key" ON "PluginInstallation"("pluginId", "teamId");
CREATE INDEX "PluginInstallation_teamId_status_idx" ON "PluginInstallation"("teamId", "status");

CREATE INDEX "PluginReview_pluginId_createdAt_idx" ON "PluginReview"("pluginId", "createdAt");
CREATE INDEX "PluginReview_status_createdAt_idx" ON "PluginReview"("status", "createdAt");

ALTER TABLE "Plugin" ADD CONSTRAINT "Plugin_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Plugin" ADD CONSTRAINT "Plugin_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Plugin" ADD CONSTRAINT "Plugin_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PluginInstallation" ADD CONSTRAINT "PluginInstallation_pluginId_fkey" FOREIGN KEY ("pluginId") REFERENCES "Plugin"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PluginInstallation" ADD CONSTRAINT "PluginInstallation_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PluginReview" ADD CONSTRAINT "PluginReview_pluginId_fkey" FOREIGN KEY ("pluginId") REFERENCES "Plugin"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PluginReview" ADD CONSTRAINT "PluginReview_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;