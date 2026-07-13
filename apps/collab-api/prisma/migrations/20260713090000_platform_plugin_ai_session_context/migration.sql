-- Checkpoint A: add session-team, client telemetry, and plugin policy state.
-- The legacy relay key table remains temporarily, but every key is disabled.
ALTER TABLE "User"
  ADD COLUMN "teamContextVersion" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "LlmCallLog"
  ADD COLUMN "clientSource" TEXT NOT NULL DEFAULT 'platform';

CREATE INDEX "LlmCallLog_clientSource_createdAt_idx"
  ON "LlmCallLog"("clientSource", "createdAt");

ALTER TABLE "Plugin"
  ADD COLUMN "aiPolicyVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "aiPolicyStatus" TEXT NOT NULL DEFAULT 'UNCHECKED',
  ADD COLUMN "aiPolicyReason" TEXT NOT NULL DEFAULT '';

ALTER TABLE "PluginRelease"
  ADD COLUMN "aiPolicyVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "aiPolicyStatus" TEXT NOT NULL DEFAULT 'UNCHECKED',
  ADD COLUMN "aiPolicyReason" TEXT NOT NULL DEFAULT '';

UPDATE "PlatformApiKey"
SET "status" = 'DISABLED'
WHERE "status" <> 'DISABLED';

-- Retired external-relay permissions must disappear from both the registry and
-- every system/custom role. This data migration is deterministic and idempotent.
UPDATE "Role"
SET "permissions" = array_remove(
  array_remove(
    array_remove("permissions", 'team.api_key.manage'),
    'platform.billing.api_key.manage'
  ),
  'platform.billing.relay_docs.view'
)
WHERE "permissions" && ARRAY[
  'team.api_key.manage',
  'platform.billing.api_key.manage',
  'platform.billing.relay_docs.view'
]::TEXT[];

DELETE FROM "PermissionEntry"
WHERE "code" IN (
  'team.api_key.manage',
  'platform.billing.api_key.manage',
  'platform.billing.relay_docs.view'
);

DELETE FROM "PermissionGroup"
WHERE "scope" = 'TEAM' AND "groupKey" = 'team.api_key';
