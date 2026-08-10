-- P2-1 / M-4：灵石改整数分，消除浮点计费误差。
-- 所有灵石相关列由 DOUBLE PRECISION 改为 INTEGER，单位统一为「分」（1 灵石 = 100 分）。
-- 存量数据按 ×100 回填；用 ROUND((col*100)::numeric) 消除浮点尾差（如 1.2299999 → 123）。
-- 注意：应用层 roundCredits 已把灵石量化到 0.01，故 col*100 本就近整数，ROUND 仅去浮点噪声。

-- 溢出预检：INTEGER 上限 ≈ 2147 万分（约 21.5 万灵石）。余额受充值/预留上限约束，
-- 正常远达不到；但一旦达到，CAST 会在 ALTER 中途抛「integer out of range」，届时整批
-- 迁移中止、上下文难查。这里先显式报错并给出操作选项（拆表清理或改 BIGINT），fail-fast。
DO $$
DECLARE
  max_pre_round NUMERIC;
BEGIN
  SELECT COALESCE(MAX(("balance" * 100)::numeric), 0) INTO max_pre_round FROM "TeamCredit";
  IF max_pre_round > 2147483647 THEN
    RAISE EXCEPTION 'TeamCredit.balance 回填后超过 INTEGER 上限（%.0f 分）——请先拆分账目或改用 BIGINT', max_pre_round;
  END IF;
END $$;

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
-- NOT VALID + 单独 VALIDATE：大表上约束校验会排他锁全表，拆分语句可先拿到
-- 迁移事务成功语义，再在低峰期显式校验（pg_repack 同理）；小表顺序执行无感知。
ALTER TABLE "TeamCredit"
  ADD CONSTRAINT "team_credit_balance_nonneg" CHECK ("balance" >= 0) NOT VALID;
ALTER TABLE "TeamCredit" VALIDATE CONSTRAINT "team_credit_balance_nonneg";

-- 全局灵石参数（PlatformSetting）由「灵石」改为「分」：×100 回填。
-- 仅对数值类键值生效（正则守卫，避免误改非数值设置如 aiUsageGuardRule）。
UPDATE "PlatformSetting"
  SET "value" = CAST(CAST("value" AS NUMERIC) * 100 AS TEXT)
  WHERE "key" IN ('creditSignupBonus', 'creditReserveCapFast', 'creditReserveCapPremium')
    AND "value" ~ '^[0-9]+(\.[0-9]+)?$';
