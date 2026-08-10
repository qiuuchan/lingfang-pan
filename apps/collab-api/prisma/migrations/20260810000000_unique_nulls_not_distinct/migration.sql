-- P1-2：修复唯一约束在可空列上整体失效的根因。
-- Postgres 默认 NULL != NULL，因此：
--   Role 的平台级行（teamId = NULL）不参与 (scope, teamId, name) / (scope, teamId, code) 的唯一判定，
--   同名、同 code 的平台角色可被无限重复插入；
--   ModelPricing 的通用定价行（tier = NULL）不参与 (capability, model, tier) 的唯一判定，
--   同一 capability+model 可存在多条通用定价，取价结果不确定。
-- PG15+ 的 NULLS NOT DISTINCT 让索引内 NULL 之间互相视为相等，恢复约束本意。
--
-- 索引名沿用 Prisma 默认名，保证 schema.prisma 中的 @@unique 仍匹配同一索引；
-- PSL 无法表达该修饰符，后续 migrate dev 重新生成这些索引时须手工补回。
--
-- 应用前置检查（存量数据可能已违反新约束，届时建索引会失败）：
--   SELECT scope, "teamId", name, count(*) FROM "Role" GROUP BY 1,2,3 HAVING count(*) > 1;
--   SELECT scope, "teamId", code, count(*) FROM "Role" WHERE code IS NOT NULL GROUP BY 1,2,3 HAVING count(*) > 1;
--   SELECT capability, model, tier, count(*) FROM "ModelPricing" GROUP BY 1,2,3 HAVING count(*) > 1;

DROP INDEX "Role_scope_teamId_name_key";

CREATE UNIQUE INDEX "Role_scope_teamId_name_key" ON "Role"("scope", "teamId", "name") NULLS NOT DISTINCT;

-- code 为可选字段：只对填了 code 的行做唯一约束，未填 code 的角色之间不应互相冲突。
-- 故在 NULLS NOT DISTINCT（此处作用于 teamId）之外，另加 code IS NOT NULL 的部分索引谓词。
DROP INDEX "Role_scope_teamId_code_key";

CREATE UNIQUE INDEX "Role_scope_teamId_code_key" ON "Role"("scope", "teamId", "code") NULLS NOT DISTINCT WHERE "code" IS NOT NULL;

DROP INDEX "ModelPricing_capability_model_tier_key";

CREATE UNIQUE INDEX "ModelPricing_capability_model_tier_key" ON "ModelPricing"("capability", "model", "tier") NULLS NOT DISTINCT;
