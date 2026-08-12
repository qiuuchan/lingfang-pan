-- 破坏场景（演练用，仅作用于隔离演练库 5444）：
-- 1) 注入一笔伪造的 WalletTransaction（模拟计费/流水注水）
INSERT INTO "WalletTransaction" ("id","userId","amountCents","direction","reason","createdAt")
VALUES ('wt999999-0000-0000-0000-000000000001','u000000-0000-0000-0000-000000000001',999999,'CREDIT','DRILL_INJECTED_BAD',now());

-- 2) 注入一条伪造的 CreditLedger（团队额度注水）
INSERT INTO "CreditLedger" ("id","teamId","amount","direction","source","reason","createdAt")
VALUES ('cl999999-0000-0000-0000-000000000001','t000000-0000-0000-0000-000000000001',888888,'CREDIT','GRANT','DRILL_INJECTED_BAD',now());

-- 3) 破坏（删表）：DROP PluginRelease 表内全部行，模拟误删数据
DELETE FROM "PluginRelease";

-- 4) 破坏（删表）：DROP Wallet 全部行
DELETE FROM "Wallet";
