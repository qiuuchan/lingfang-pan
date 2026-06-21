-- 模型服务密钥改为用户级绑定：一个用户一条 apiKey，普通成员也可维护自己的配置。
-- 旧团队级数据尽量迁移给最后更新人；无用户归属的记录删除；同一用户多条时保留最新一条。

ALTER TABLE "TenantLlmBinding" ADD COLUMN "userId" TEXT;

UPDATE "TenantLlmBinding"
SET "userId" = COALESCE("updatedById", "createdById");

DELETE FROM "TenantLlmBinding"
WHERE "userId" IS NULL;

WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "userId"
      ORDER BY "updatedAt" DESC, "createdAt" DESC, "id" ASC
    ) AS row_num
  FROM "TenantLlmBinding"
)
DELETE FROM "TenantLlmBinding" AS binding
USING ranked
WHERE binding."id" = ranked."id"
  AND ranked.row_num > 1;

ALTER TABLE "TenantLlmBinding" ALTER COLUMN "userId" SET NOT NULL;

DROP INDEX IF EXISTS "TenantLlmBinding_teamId_key";

CREATE UNIQUE INDEX "TenantLlmBinding_userId_key" ON "TenantLlmBinding"("userId");
CREATE INDEX "TenantLlmBinding_userId_enabled_idx" ON "TenantLlmBinding"("userId", "enabled");

ALTER TABLE "TenantLlmBinding"
ADD CONSTRAINT "TenantLlmBinding_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
