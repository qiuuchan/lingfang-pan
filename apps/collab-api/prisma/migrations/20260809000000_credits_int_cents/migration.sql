-- P2-1 / M-4：灵石改整数分，消除浮点计费误差。
-- 所有灵石相关列由 DOUBLE PRECISION 改为 INTEGER，单位统一为「分」（1 灵石 = 100 分）。
-- 存量数据按 ×100 回填；用 ROUND((col*100)::numeric) 消除浮点尾差（如 1.2299999 → 123）。
-- 注意：应用层 roundCredits 已把灵石量化到 0.01，故 col*100 本就近整数，ROUND 仅去浮点噪声。

ALTER TABLE "TeamCredit"
  ALTER COLUMN "balance" TYPE INTEGER
  USING CAST(ROUND(("balance" * 100)::numeric) AS INTEGER);

ALTER TABLE "CreditLedger"
  ALTER COLUMN "amount" TYPE INTEGER
  USING CAST(ROUND(("amount" * 100)::numeric) AS INTEGER);

ALTER TABLE "ModelPricing"
  ALTER COLUMN "pricePerUnit" TYPE INTEGER
  USING CAST(ROUND(("pricePerUnit" * 100)::numeric) AS INTEGER);

ALTER TABLE "LlmCallLog"
  ALTER COLUMN "credits" TYPE INTEGER
  USING CAST(ROUND(("credits" * 100)::numeric) AS INTEGER);

-- 顺手补非负约束（此前仅靠应用层 updateMany where balance>=cap 保证）。
ALTER TABLE "TeamCredit"
  ADD CONSTRAINT "team_credit_balance_nonneg" CHECK ("balance" >= 0);

-- 全局灵石参数（PlatformSetting）由「灵石」改为「分」：×100 回填。
-- 仅对数值类键值生效（正则守卫，避免误改非数值设置如 aiUsageGuardRule）。
UPDATE "PlatformSetting"
  SET "value" = CAST(CAST("value" AS NUMERIC) * 100 AS TEXT)
  WHERE "key" IN ('creditSignupBonus', 'creditReserveCapFast', 'creditReserveCapPremium')
    AND "value" ~ '^[0-9]+(\.[0-9]+)?$';
