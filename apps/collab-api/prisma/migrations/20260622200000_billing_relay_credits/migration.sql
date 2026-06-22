-- 计费与模型中转（Relay + 灵石 Credit）基础表。
-- 见 docs/billing-and-relay-design.md。本迁移纯加表，不改动既有模型。
-- 设计：
--  - Channel 取代旧「单活跃 LlmGateway」（后者保留过渡，见 P8 清理迁移）。
--  - TeamCredit 独立于 Team.balanceCents：本表是 AI 用量计费的虚拟货币「灵石」。
--  - 上游真实 key 加密存 Channel.encryptedUpstreamKey；PlatformApiKey 只存 sha256。
--  - LlmCallLog 多维索引覆盖管理端按团队/用户/能力/状态/模型/时间的查询。

-- === 新增枚举 ===
CREATE TYPE "ChannelStatus" AS ENUM ('ENABLED', 'DISABLED');
CREATE TYPE "ChannelProtocol" AS ENUM ('OPENAI', 'ANTHROPIC');
CREATE TYPE "ChannelScopeKind" AS ENUM ('GLOBAL', 'TEAM', 'ROLE');
CREATE TYPE "PricingUnit" AS ENUM ('PER_TOKEN_INPUT', 'PER_TOKEN_OUTPUT', 'PER_CALL', 'PER_IMAGE');
CREATE TYPE "ModelTierId" AS ENUM ('FAST', 'PREMIUM');
CREATE TYPE "ApiKeyStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- === Channel：上游渠道 ===
CREATE TABLE "Channel" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "protocol" "ChannelProtocol" NOT NULL,
  "provider" TEXT NOT NULL,
  "baseUrl" TEXT NOT NULL,
  "encryptedUpstreamKey" TEXT NOT NULL,
  "upstreamKeyHint" TEXT NOT NULL DEFAULT '',
  "supportedModels" JSONB NOT NULL DEFAULT '[]',
  "supportedTiers" "ModelTierId"[] DEFAULT ARRAY[]::"ModelTierId"[],
  "status" "ChannelStatus" NOT NULL DEFAULT 'ENABLED',
  "priority" INTEGER NOT NULL DEFAULT 100,
  "weight" INTEGER NOT NULL DEFAULT 1,
  "description" TEXT NOT NULL DEFAULT '',
  "lastHealthAt" TIMESTAMP(3),
  "lastHealthOk" BOOLEAN,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Channel_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Channel_name_key" ON "Channel"("name");
CREATE INDEX "Channel_status_priority_idx" ON "Channel"("status", "priority");

-- === ChannelBinding：渠道↔主体（多对多，多态 scopeId 不建 FK） ===
CREATE TABLE "ChannelBinding" (
  "id" TEXT NOT NULL,
  "channelId" TEXT NOT NULL,
  "scopeKind" "ChannelScopeKind" NOT NULL,
  "scopeId" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChannelBinding_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ChannelBinding_channelId_scopeKind_scopeId_key" ON "ChannelBinding"("channelId", "scopeKind", "scopeId");
CREATE INDEX "ChannelBinding_scopeKind_scopeId_idx" ON "ChannelBinding"("scopeKind", "scopeId");
ALTER TABLE "ChannelBinding" ADD CONSTRAINT "ChannelBinding_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- === TeamCredit：团队灵石账户（每团队一行） ===
CREATE TABLE "TeamCredit" (
  "teamId" TEXT NOT NULL,
  "balance" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TeamCredit_pkey" PRIMARY KEY ("teamId")
);

ALTER TABLE "TeamCredit" ADD CONSTRAINT "TeamCredit_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- === CreditLedger：灵石流水（callLogId 多态，不建 FK） ===
CREATE TABLE "CreditLedger" (
  "id" TEXT NOT NULL,
  "teamId" TEXT NOT NULL,
  "amount" INTEGER NOT NULL,
  "direction" "LedgerDirection" NOT NULL,
  "source" TEXT NOT NULL,
  "reason" TEXT NOT NULL DEFAULT '',
  "actorUserId" TEXT,
  "callLogId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CreditLedger_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CreditLedger_teamId_createdAt_idx" ON "CreditLedger"("teamId", "createdAt");
CREATE INDEX "CreditLedger_source_createdAt_idx" ON "CreditLedger"("source", "createdAt");
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- === ModelPricing：模型定价（灵石） ===
CREATE TABLE "ModelPricing" (
  "id" TEXT NOT NULL,
  "capability" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "label" TEXT NOT NULL DEFAULT '',
  "unit" "PricingUnit" NOT NULL,
  "pricePerUnit" INTEGER NOT NULL,
  "tier" "ModelTierId",
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ModelPricing_pkey" PRIMARY KEY ("id")
);

-- (capability, model, tier) 唯一；tier 可空，Postgres 下各行 null 独立（同 Role 语义）。
CREATE UNIQUE INDEX "ModelPricing_capability_model_tier_key" ON "ModelPricing"("capability", "model", "tier");
CREATE INDEX "ModelPricing_capability_enabled_idx" ON "ModelPricing"("capability", "enabled");

-- === ModelTierConfig：前台固定版本（快速版/高级版）底层映射 ===
CREATE TABLE "ModelTierConfig" (
  "tier" "ModelTierId" NOT NULL,
  "label" TEXT NOT NULL DEFAULT '',
  "chatModel" TEXT NOT NULL,
  "imageModel" TEXT,
  "temperature" DOUBLE PRECISION,
  "maxTokens" INTEGER,
  "extraParams" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ModelTierConfig_pkey" PRIMARY KEY ("tier")
);

-- === PlatformApiKey：平台 API Key（keyHash 唯一，明文仅创建时返回一次） ===
CREATE TABLE "PlatformApiKey" (
  "id" TEXT NOT NULL,
  "teamId" TEXT NOT NULL,
  "name" TEXT NOT NULL DEFAULT '',
  "keyPrefix" TEXT NOT NULL,
  "keyHash" TEXT NOT NULL,
  "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "status" "ApiKeyStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdById" TEXT,
  "lastUsedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlatformApiKey_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlatformApiKey_keyHash_key" ON "PlatformApiKey"("keyHash");
CREATE INDEX "PlatformApiKey_teamId_status_idx" ON "PlatformApiKey"("teamId", "status");
CREATE INDEX "PlatformApiKey_keyHash_idx" ON "PlatformApiKey"("keyHash");
ALTER TABLE "PlatformApiKey" ADD CONSTRAINT "PlatformApiKey_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PlatformApiKey" ADD CONSTRAINT "PlatformApiKey_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- === LlmCallLog：调用日志（计费/日志咽喉唯一事实来源） ===
CREATE TABLE "LlmCallLog" (
  "id" TEXT NOT NULL,
  "teamId" TEXT NOT NULL,
  "userId" TEXT,
  "apiKeyId" TEXT,
  "channelId" TEXT,
  "capability" TEXT NOT NULL,
  "tier" "ModelTierId",
  "model" TEXT NOT NULL,
  "inputTokens" INTEGER NOT NULL DEFAULT 0,
  "outputTokens" INTEGER NOT NULL DEFAULT 0,
  "images" INTEGER NOT NULL DEFAULT 0,
  "durationMs" INTEGER NOT NULL DEFAULT 0,
  "credits" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL,
  "httpStatus" INTEGER,
  "errorCode" TEXT,
  "requestId" TEXT,
  "requestSummary" JSONB NOT NULL DEFAULT '{}',
  "clientIp" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LlmCallLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LlmCallLog_teamId_createdAt_idx" ON "LlmCallLog"("teamId", "createdAt");
CREATE INDEX "LlmCallLog_userId_createdAt_idx" ON "LlmCallLog"("userId", "createdAt");
CREATE INDEX "LlmCallLog_apiKeyId_createdAt_idx" ON "LlmCallLog"("apiKeyId", "createdAt");
CREATE INDEX "LlmCallLog_capability_createdAt_idx" ON "LlmCallLog"("capability", "createdAt");
CREATE INDEX "LlmCallLog_status_createdAt_idx" ON "LlmCallLog"("status", "createdAt");
CREATE INDEX "LlmCallLog_model_createdAt_idx" ON "LlmCallLog"("model", "createdAt");
ALTER TABLE "LlmCallLog" ADD CONSTRAINT "LlmCallLog_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LlmCallLog" ADD CONSTRAINT "LlmCallLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LlmCallLog" ADD CONSTRAINT "LlmCallLog_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "PlatformApiKey"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LlmCallLog" ADD CONSTRAINT "LlmCallLog_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE SET NULL ON UPDATE CASCADE;
