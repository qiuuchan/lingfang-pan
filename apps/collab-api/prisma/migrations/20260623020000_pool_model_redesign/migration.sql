-- 资源池模型重构（2026-06-23，v0.0.6）：
--  - 新增 Pool（资源池，SHARED 共享 / DEDICATED 单团队）。
--  - Channel 加 kind（CHAT/IMAGE）+ tier（FAST/PREMIUM）+ poolId；models 轮询。
--  - 删除 ChannelBinding（改用 Pool 范围）/ ModelTierConfig（版本=渠道标签）。
--  - 删除 ChannelScopeKind 枚举（不再用）。

-- === 新增枚举 ===
CREATE TYPE "PoolScope" AS ENUM ('SHARED', 'DEDICATED');
CREATE TYPE "ChannelKind" AS ENUM ('CHAT', 'IMAGE');

-- === Pool 表 ===
CREATE TABLE "Pool" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "scope" "PoolScope" NOT NULL DEFAULT 'SHARED',
  "teamId" TEXT,
  "description" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Pool_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Pool_name_key" ON "Pool"("name");
ALTER TABLE "Pool" ADD CONSTRAINT "Pool_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 建一个默认 SHARED 池，承接既有渠道（升级兼容）。
INSERT INTO "Pool" ("id", "name", "scope", "description")
VALUES ('00000000-0000-0000-0000-defaultpool', '默认池', 'SHARED', '升级自动创建的默认共享池');

-- === Channel 改造 ===
-- 加 kind/tier/poolId（先可空 + 默认值回填，再设 NOT NULL）。
ALTER TABLE "Channel" ADD COLUMN "kind" "ChannelKind" NOT NULL DEFAULT 'CHAT';
ALTER TABLE "Channel" ADD COLUMN "tier" "ModelTierId" NOT NULL DEFAULT 'FAST';
ALTER TABLE "Channel" ADD COLUMN "poolId" TEXT NOT NULL DEFAULT '00000000-0000-0000-0000-defaultpool';
-- 既有渠道回填到默认池（已由 DEFAULT 完成，显式 UPDATE 兜底）。
UPDATE "Channel" SET "poolId" = '00000000-0000-0000-0000-defaultpool' WHERE "poolId" IS NULL OR "poolId" = '';
-- supportedModels 改名为 models（语义：自定义多个轮询模型）。
ALTER TABLE "Channel" RENAME COLUMN "supportedModels" TO "models";
-- 删旧字段（supportedTiers 数组、priority、weight）。
ALTER TABLE "Channel" DROP COLUMN IF EXISTS "supportedTiers";
ALTER TABLE "Channel" DROP COLUMN IF EXISTS "priority";
ALTER TABLE "Channel" DROP COLUMN IF EXISTS "weight";
-- FK: poolId → Pool。
ALTER TABLE "Channel" ADD CONSTRAINT "Channel_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "Pool"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "Channel_poolId_status_idx" ON "Channel"("poolId", "status");
CREATE INDEX "Channel_kind_tier_status_idx" ON "Channel"("kind", "tier", "status");
DROP INDEX IF EXISTS "Channel_status_priority_idx";

-- === 删旧表 ===
DROP TABLE IF EXISTS "ChannelBinding";
DROP TABLE IF EXISTS "ModelTierConfig";

-- === 删旧枚举 ===
DROP TYPE IF EXISTS "ChannelScopeKind";
