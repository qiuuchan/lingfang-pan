-- 组E 性能优化：为高频聚合查询补索引（非破坏式 CREATE INDEX IF NOT EXISTS）。
--
-- 目标与依据：
--   1. AuditLog(action, createdAt)：adminGenerationStats / adminFinanceStats 看板每次渲染
--      都按 action（如 'llm_binding.key_decrypted' / 'plugin.uploaded'）+ createdAt 范围执行 4 次 count，
--      此前 action 无索引走全表扫描（AuditLog 随时间单调增长，是最易膨胀的表）。
--      audit-view 按 action 前缀分类筛选同样依赖此列。复合索引 [action, createdAt] 同时覆盖
--      「按 action 过滤」与「按 action + 时间范围聚合」两种访问路径。
--   2. Purchase(buyerTeamId, createdAt)：adminTeamDetail 用 buyerTeamId + createdAt desc
--      拉取最近 10 笔购买记录，此前 buyerTeamId 无索引（仅有 buyerUserId 单列索引），按租户聚合
--      走全表扫描；租户级财务对账（该团队作为买方的 GMV）同样受益。
--
-- 全部 CREATE INDEX IF NOT EXISTS，幂等可重复执行，不锁表不改列定义，纯加速索引补充。
-- Prisma migrate deploy 会在迁移历史表中记录本迁移名，避免重复执行。

-- AuditLog: 按 action 聚合的高频查询（看板 count + audit-view 分类筛选）。
CREATE INDEX IF NOT EXISTS "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");

-- Purchase: 按买方团队拉取购买记录（adminTeamDetail + 租户财务聚合）。
CREATE INDEX IF NOT EXISTS "Purchase_buyerTeamId_createdAt_idx" ON "Purchase"("buyerTeamId", "createdAt");
