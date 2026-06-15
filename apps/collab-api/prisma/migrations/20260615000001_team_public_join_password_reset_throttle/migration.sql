-- 平台缺口补齐（团队发现 + 找回密码 + 限流）：
-- 1. Team 加 allowPublicJoin（公开团队发现，普通用户一键直接加入，无需邀请码）。
-- 2. Team 加 description（团队简介，发现页展示）。
-- 本批仅涉及 Team 表加字段 + 索引，均为带默认值的非破坏式 ALTER（现有行回填默认值，不影响既有数据）。
-- 找回密码复用 JWT tokenVersion 机制（reset 后 tokenVersion++），无需新增 schema 字段。

-- Team 加 allowPublicJoin 字段：默认 false（团队管理员需主动开启才出现在发现页）。
ALTER TABLE "Team" ADD COLUMN IF NOT EXISTS "allowPublicJoin" BOOLEAN NOT NULL DEFAULT false;

-- Team 加 description 字段：团队简介（公开发现页展示），默认空串。
ALTER TABLE "Team" ADD COLUMN IF NOT EXISTS "description" TEXT NOT NULL DEFAULT '';

-- 公开团队发现查询索引：allowPublicJoin=true + status=ACTIVE 的团队列表。
-- 该组合是 GET /api/teams/public 的过滤条件，数据量增长后避免全表扫。
CREATE INDEX IF NOT EXISTS "Team_allowPublicJoin_status_idx" ON "Team"("allowPublicJoin", "status");
