-- 旧 BYOK 系统清理（P8）：计费/中转系统上线后移除单活跃 LlmGateway + 用户级 apiKey 绑定。
-- 渠道管理已迁至 Channel（见 20260622200000_billing_relay_credits），用户侧无 apiKey（AI 走 relay）。

-- 先删绑定（含对 User/Team 的外键），再删网关目录，最后删枚举。
DROP TABLE IF EXISTS "TenantLlmBinding";
DROP TABLE IF EXISTS "LlmGateway";
DROP TYPE IF EXISTS "LlmGatewayStatus";
