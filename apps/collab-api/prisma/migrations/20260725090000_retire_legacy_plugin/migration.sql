-- Phase 2: retire the legacy Plugin graph after the v4 backfill.
-- The guards intentionally fail closed. Run `plugin-registry:migrate --apply`
-- followed by `plugin-registry:migrate --verify` before deploying this migration.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Plugin" p
    WHERE p."teamId" IS NULL OR NOT EXISTS (
      SELECT 1
      FROM "AuditLog" a
      JOIN "PluginPackage" pp ON pp."id" = a."metadata"->>'packageId'
      JOIN "PluginRelease" pr ON pr."id" = a."metadata"->>'releaseId'
        AND pr."packageId" = pp."id"
      WHERE a."action" = 'plugin.registry.legacy_migrated'
        AND a."targetType" = 'Plugin'
        AND a."targetId" = p."id"
        AND pp."ownerTeamId" = p."teamId"
        AND pr."version" = p."version"
    )
  ) THEN RAISE EXCEPTION 'legacy Plugin rows are missing exact v4 audit mappings';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "Purchase" p
    WHERE p."pluginId" IS NOT NULL
      AND (
        p."sellerTeamId" IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM "AuditLog" a
          JOIN "PluginRelease" pr ON pr."id" = a."metadata"->>'releaseId'
            AND pr."packageId" = a."metadata"->>'packageId'
          WHERE a."action" = 'plugin.registry.legacy_migrated'
            AND a."targetType" = 'Plugin'
            AND a."targetId" = p."pluginId"
            AND p."packageId" = a."metadata"->>'packageId'
            AND p."releaseId" = a."metadata"->>'releaseId'
        )
      )
  ) THEN RAISE EXCEPTION 'legacy Purchase rows do not match their v4 package/release mapping';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Purchase" p
    JOIN "AuditLog" a ON a."action" = 'plugin.registry.legacy_migrated'
      AND a."targetType" = 'Plugin' AND a."targetId" = p."pluginId"
    WHERE p."pluginId" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "MarketplaceMetricEvent" m
        WHERE m."idempotencyKey" = 'legacy-purchase:' || p."id"
          AND m."packageId" = a."metadata"->>'packageId'
          AND m."releaseId" = a."metadata"->>'releaseId'
          AND m."teamId" = p."buyerTeamId"
          AND m."kind" = 'PURCHASED'
          AND m."sourceRecordId" = p."id"
      )
  ) THEN RAISE EXCEPTION 'legacy Purchase rows are missing exact v4 metric facts';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "PluginGrant" g
    WHERE g."pluginId" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "AuditLog" a
        WHERE a."action" = 'plugin.registry.legacy_migrated'
          AND a."targetType" = 'Plugin'
          AND a."targetId" = g."pluginId"
          AND g."packageId" = a."metadata"->>'packageId'
      )
  ) THEN RAISE EXCEPTION 'legacy PluginGrant rows do not match their v4 package mapping';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "PluginInstallation" i
    JOIN "AuditLog" a ON a."action" = 'plugin.registry.legacy_migrated'
      AND a."targetType" = 'Plugin' AND a."targetId" = i."pluginId"
    WHERE i."status" = 'ENABLED'
      AND NOT EXISTS (
        SELECT 1 FROM "PluginEntitlement" e
        WHERE e."teamId" = i."teamId"
          AND e."packageId" = a."metadata"->>'packageId'
          AND e."status" = 'ACTIVE'
      )
  ) THEN RAISE EXCEPTION 'enabled legacy PluginInstallation rows are missing active v4 entitlements';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "PluginInstallation" i
    JOIN "AuditLog" a ON a."action" = 'plugin.registry.legacy_migrated'
      AND a."targetType" = 'Plugin' AND a."targetId" = i."pluginId"
    WHERE NOT EXISTS (
      SELECT 1 FROM "MarketplaceMetricEvent" m
      WHERE m."idempotencyKey" = 'legacy-installation:' || i."id"
        AND m."packageId" = a."metadata"->>'packageId'
        AND m."releaseId" = a."metadata"->>'releaseId'
        AND m."teamId" = i."teamId"
        AND m."kind" = 'INSTALL_SUCCEEDED'
        AND m."sourceRecordId" = i."id"
    )
  ) THEN RAISE EXCEPTION 'legacy PluginInstallation rows are missing exact v4 metric facts';
  END IF;

  IF EXISTS (
    WITH latest_rating AS (
      SELECT r.*, row_number() OVER (
        PARTITION BY r."pluginId", r."teamId"
        ORDER BY r."createdAt" DESC, r."id" DESC
      ) AS rank
      FROM "PluginRating" r
    )
    SELECT 1
    FROM latest_rating r
    JOIN "AuditLog" a ON a."action" = 'plugin.registry.legacy_migrated'
      AND a."targetType" = 'Plugin' AND a."targetId" = r."pluginId"
    WHERE r.rank = 1
      AND (
        (
          NOT EXISTS (
            SELECT 1 FROM "MarketplaceRatingRevision" rr
            WHERE rr."packageId" = a."metadata"->>'packageId'
              AND rr."teamId" = r."teamId"
              AND rr."sourceKind" = 'LEGACY_PLUGIN_RATING'
              AND rr."sourceId" = r."id"
          )
          AND NOT EXISTS (
            SELECT 1 FROM "MarketplaceRating" mr
            WHERE mr."packageId" = a."metadata"->>'packageId'
              AND mr."teamId" = r."teamId"
          )
        )
        OR NOT EXISTS (
          SELECT 1 FROM "MarketplaceMetricEvent" m
          WHERE m."idempotencyKey" = 'legacy-rating:' || r."id"
            AND m."packageId" = a."metadata"->>'packageId'
            AND m."releaseId" = a."metadata"->>'releaseId'
            AND m."teamId" = r."teamId"
            AND m."kind" = 'RATING_CHANGED'
            AND m."sourceRecordId" = r."id"
        )
      )
  ) THEN RAISE EXCEPTION 'latest legacy PluginRating rows are missing v4 rating facts';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "PluginReview" r
    JOIN "AuditLog" a ON a."action" = 'plugin.registry.legacy_migrated'
      AND a."targetType" = 'Plugin' AND a."targetId" = r."pluginId"
    WHERE NOT EXISTS (
      SELECT 1 FROM "PluginReleaseReview" rr
      WHERE rr."releaseId" = a."metadata"->>'releaseId'
        AND rr."reviewerId" IS NOT DISTINCT FROM r."reviewerId"
        AND rr."status"::text = r."status"::text
        AND rr."reason" = r."reason"
        AND rr."createdAt" = r."createdAt"
    )
  ) THEN RAISE EXCEPTION 'legacy PluginReview rows are missing v4 review history';
  END IF;
END $$;

ALTER TABLE "Purchase" DROP CONSTRAINT IF EXISTS "Purchase_pluginId_fkey";
DROP INDEX IF EXISTS "Purchase_pluginId_buyerUserId_key";
ALTER TABLE "Purchase" DROP COLUMN IF EXISTS "pluginId";

ALTER TABLE "PluginGrant" DROP CONSTRAINT IF EXISTS "PluginGrant_pluginId_fkey";
DROP INDEX IF EXISTS "PluginGrant_teamId_pluginId_subjectKind_subjectId_key";
DROP INDEX IF EXISTS "PluginGrant_teamId_pluginId_idx";
ALTER TABLE "PluginGrant" ALTER COLUMN "packageId" SET NOT NULL;
ALTER TABLE "PluginGrant" DROP COLUMN IF EXISTS "pluginId";

DROP TABLE IF EXISTS "PluginInstallation";
DROP TABLE IF EXISTS "PluginReview";
DROP TABLE IF EXISTS "PluginRating";
DROP TABLE IF EXISTS "Plugin";

DROP TYPE IF EXISTS "PluginStatus";
DROP TYPE IF EXISTS "PluginRuntimeType";
DROP TYPE IF EXISTS "PluginVisibility";
