-- v3 定稿（单 provider 云分发 + 无 provider UI）：
-- 1. LlmGateway 加 isActive（当前启用 provider，全表最多一条 true）。
-- 2. TenantLlmBinding 去 gatewayId + provider（破坏式，用户界面零 provider 概念），teamId 改唯一。

-- LlmGateway 加 isActive 字段 + 索引。
ALTER TABLE "LlmGateway" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "LlmGateway_isActive_idx" ON "LlmGateway"("isActive");

-- TenantLlmBinding：首版无生产数据，删旧 binding 重建最简（破坏式，不向后兼容）。
DELETE FROM "TenantLlmBinding";

-- 删旧的 (teamId, gatewayId) 复合唯一约束。
DROP INDEX "TenantLlmBinding_teamId_gatewayId_key";

-- 删 gateway 外键（provider 不再绑特定 gateway，onDelete: Restrict 不再需要）。
ALTER TABLE "TenantLlmBinding" DROP CONSTRAINT "TenantLlmBinding_gatewayId_fkey";

-- 删 gatewayId + provider 冗余列。
ALTER TABLE "TenantLlmBinding" DROP COLUMN "gatewayId";
ALTER TABLE "TenantLlmBinding" DROP COLUMN "provider";

-- teamId 改唯一（一个团队一条 apiKey 绑定）。
CREATE UNIQUE INDEX "TenantLlmBinding_teamId_key" ON "TenantLlmBinding"("teamId");
