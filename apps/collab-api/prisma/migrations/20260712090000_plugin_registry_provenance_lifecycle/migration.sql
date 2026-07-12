-- Preserve release provenance separately from local installation origin.
CREATE TYPE "PluginReleaseSourceKind" AS ENUM (
  'LINGFANG_CREATOR',
  'EXTERNAL_TOOL',
  'LOCAL_ARTIFACT',
  'COPIED_INSTALLATION',
  'API',
  'LEGACY_MIGRATION',
  'UNKNOWN'
);
CREATE TYPE "PluginIngestChannel" AS ENUM ('DESKTOP', 'API', 'MIGRATION');
CREATE TYPE "MarketplaceDelistActor" AS ENUM ('OWNER', 'PLATFORM');

ALTER TABLE "PluginRelease"
  ADD COLUMN "sourceKind" "PluginReleaseSourceKind" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "sourceLabel" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "ingestChannel" "PluginIngestChannel" NOT NULL DEFAULT 'API';

ALTER TABLE "MarketplaceListing"
  ADD COLUMN "delistedBy" "MarketplaceDelistActor",
  ADD COLUMN "delistReason" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "delistedAt" TIMESTAMP(3),
  ADD COLUMN "delistedByUserId" TEXT;

-- Before this migration only platform administrators could delist marketplace entries.
UPDATE "MarketplaceListing"
SET
  "delistedBy" = 'PLATFORM',
  "delistedAt" = COALESCE("delistedAt", "updatedAt")
WHERE "status" = 'DELISTED';
