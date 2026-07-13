-- Checkpoint B: run only after every application instance is JWT-only and a
-- database backup has been verified. Existing external lf_ keys are destroyed.
ALTER TABLE "LlmCallLog"
  DROP CONSTRAINT IF EXISTS "LlmCallLog_apiKeyId_fkey";

DROP INDEX IF EXISTS "LlmCallLog_apiKeyId_createdAt_idx";

ALTER TABLE "LlmCallLog"
  DROP COLUMN IF EXISTS "apiKeyId";

DROP TABLE IF EXISTS "PlatformApiKey";

DROP TYPE IF EXISTS "ApiKeyStatus";
