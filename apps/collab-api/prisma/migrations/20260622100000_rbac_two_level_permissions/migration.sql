-- RBAC 两级权限节点增强：Role.code（角色编码）、PermissionEntry 模块化（moduleKey/moduleLabel/moduleOrder）、
-- PermissionGroup 可编辑分组表。
-- 向后兼容：保留 PermissionEntry.group（=moduleKey）；Role.code 可空；不删除任何现有权限码。

-- 1. PermissionEntry 加模块化列（moduleKey/moduleLabel 非空，moduleOrder 默认 0）
ALTER TABLE "PermissionEntry" ADD COLUMN "moduleKey" TEXT NOT NULL DEFAULT '';
ALTER TABLE "PermissionEntry" ADD COLUMN "moduleLabel" TEXT NOT NULL DEFAULT '';
ALTER TABLE "PermissionEntry" ADD COLUMN "moduleOrder" INTEGER NOT NULL DEFAULT 0;

-- 2. 回填 moduleKey/moduleLabel/moduleOrder：先令 moduleKey=group（默认等于分组键）
UPDATE "PermissionEntry" SET "moduleKey" = "group";

-- 2.1 回填 moduleLabel（按 moduleKey 映射中文显示名）。CASE 覆盖全部内置模块键。
--      moduleKey 与 permission-codes.ts 的模块定义一一对应。
UPDATE "PermissionEntry" SET "moduleLabel" = CASE "moduleKey"
  WHEN 'platform.dashboard' THEN '仪表盘'
  WHEN 'platform.user' THEN '用户管理'
  WHEN 'platform.team' THEN '团队管理'
  WHEN 'platform.plugin' THEN '插件市场'
  WHEN 'platform.application' THEN '申请审批'
  WHEN 'platform.llm' THEN '模型服务'
  WHEN 'platform.release' THEN '版本发布'
  WHEN 'platform.admin' THEN '平台管理员'
  WHEN 'platform.role' THEN '平台角色'
  WHEN 'platform.audit' THEN '审计日志'
  WHEN 'platform.setting' THEN '平台设置'
  WHEN 'team.dashboard' THEN '团队概览'
  WHEN 'team.member' THEN '成员管理'
  WHEN 'team.role' THEN '团队角色'
  WHEN 'team.plugin' THEN '插件管理'
  WHEN 'team.plugin.grant' THEN '插件授权'
  WHEN 'team.balance' THEN '团队余额'
  WHEN 'team.profile' THEN '团队资料'
  ELSE "moduleKey"
END;

-- 2.2 回填 moduleOrder（模块间稳定排序，平台在前团队在后；与 permission-codes.ts sortOrder 对齐）
UPDATE "PermissionEntry" SET "moduleOrder" = CASE "moduleKey"
  WHEN 'platform.dashboard' THEN 10
  WHEN 'platform.user' THEN 20
  WHEN 'platform.team' THEN 30
  WHEN 'platform.plugin' THEN 40
  WHEN 'platform.application' THEN 50
  WHEN 'platform.llm' THEN 60
  WHEN 'platform.release' THEN 70
  WHEN 'platform.admin' THEN 80
  WHEN 'platform.role' THEN 90
  WHEN 'platform.audit' THEN 100
  WHEN 'platform.setting' THEN 110
  WHEN 'team.dashboard' THEN 10
  WHEN 'team.member' THEN 20
  WHEN 'team.role' THEN 30
  WHEN 'team.plugin' THEN 40
  WHEN 'team.plugin.grant' THEN 50
  WHEN 'team.balance' THEN 60
  WHEN 'team.profile' THEN 70
  ELSE 999
END;

-- 3. Role 加 code 列（可选，默认 null）
ALTER TABLE "Role" ADD COLUMN "code" TEXT;

-- 4. 回填内置角色 code（确定性，与 permission-codes.ts 常量一致）
--    系统平台管理员：id 固定占位 → code='platform_admin'
UPDATE "Role" SET "code" = 'platform_admin'
WHERE "id" = '00000000-0000-0000-0000-platform0001' AND "code" IS NULL;

--    系统团队管理员：id 形如 team-admin-<teamId> → code='team_admin'
UPDATE "Role" SET "code" = 'team_admin'
WHERE "id" LIKE 'team-admin-%' AND "scope" = 'TEAM' AND "code" IS NULL;

--    系统成员：id 形如 team-member-<teamId> → code='team_member'
UPDATE "Role" SET "code" = 'team_member'
WHERE "id" LIKE 'team-member-%' AND "scope" = 'TEAM' AND "code" IS NULL;

-- 5. Role.code 唯一索引（同 scope+teamId 下唯一；null 各行独立，不影响存量自定义角色）
CREATE UNIQUE INDEX "Role_scope_teamId_code_key" ON "Role"("scope", "teamId", "code");

-- 6. PermissionEntry 模块索引
CREATE INDEX "PermissionEntry_scope_moduleKey_idx" ON "PermissionEntry"("scope", "moduleKey");

-- 7. PermissionGroup 表（可编辑分组显示名）
CREATE TABLE "PermissionGroup" (
    "scope" "RoleScope" NOT NULL,
    "groupKey" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PermissionGroup_pkey" PRIMARY KEY ("scope", "groupKey")
);
CREATE INDEX "PermissionGroup_scope_sortOrder_idx" ON "PermissionGroup"("scope", "sortOrder");

-- 8. seed 内置 PermissionGroup 行（isSystem=true，与 permission-codes.ts BUILTIN_PERMISSION_GROUPS 对齐）
--    幂等：WHERE NOT EXISTS 防重复执行。displayName 取内置 moduleLabel，管理员可后续覆盖。
INSERT INTO "PermissionGroup" ("scope", "groupKey", "displayName", "sortOrder", "isSystem", "updatedAt")
SELECT * FROM (VALUES
  ('PLATFORM'::"RoleScope", 'platform.dashboard', '仪表盘', 10, true),
  ('PLATFORM'::"RoleScope", 'platform.user', '用户管理', 20, true),
  ('PLATFORM'::"RoleScope", 'platform.team', '团队管理', 30, true),
  ('PLATFORM'::"RoleScope", 'platform.plugin', '插件市场', 40, true),
  ('PLATFORM'::"RoleScope", 'platform.application', '申请审批', 50, true),
  ('PLATFORM'::"RoleScope", 'platform.llm', '模型服务', 60, true),
  ('PLATFORM'::"RoleScope", 'platform.release', '版本发布', 70, true),
  ('PLATFORM'::"RoleScope", 'platform.admin', '平台管理员', 80, true),
  ('PLATFORM'::"RoleScope", 'platform.role', '平台角色', 90, true),
  ('PLATFORM'::"RoleScope", 'platform.audit', '审计日志', 100, true),
  ('PLATFORM'::"RoleScope", 'platform.setting', '平台设置', 110, true),
  ('TEAM'::"RoleScope", 'team.dashboard', '团队概览', 10, true),
  ('TEAM'::"RoleScope", 'team.member', '成员管理', 20, true),
  ('TEAM'::"RoleScope", 'team.role', '团队角色', 30, true),
  ('TEAM'::"RoleScope", 'team.plugin', '插件管理', 40, true),
  ('TEAM'::"RoleScope", 'team.plugin.grant', '插件授权', 50, true),
  ('TEAM'::"RoleScope", 'team.balance', '团队余额', 60, true),
  ('TEAM'::"RoleScope", 'team.profile', '团队资料', 70, true)
) AS v("scope", "groupKey", "displayName", "sortOrder", "isSystem")
WHERE NOT EXISTS (
  SELECT 1 FROM "PermissionGroup" pg
  WHERE pg."scope" = v."scope" AND pg."groupKey" = v."groupKey"
);
