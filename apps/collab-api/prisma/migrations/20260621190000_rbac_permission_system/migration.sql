-- RBAC 权限系统：自定义角色 + 预定义权限码 + 插件授权表。
-- 将现有 PLATFORM_ADMIN/TEAM_ADMIN/MEMBER 枚举角色迁移为新 Role 系统的内置系统角色（过渡期双写并存）。
-- 权限码本体由后端 permission-codes.ts 定义，seed 时 upsert 到 PermissionEntry 表（此处只建结构）。

-- 1. 新增 enum
CREATE TYPE "RoleScope" AS ENUM ('PLATFORM', 'TEAM');
CREATE TYPE "PluginGrantSubject" AS ENUM ('USER', 'ROLE');
CREATE TYPE "PluginGrantEffect" AS ENUM ('ALLOW', 'DENY');

-- 2. PermissionEntry 表（权限码注册表镜像，主键 code）
CREATE TABLE "PermissionEntry" (
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "scope" "RoleScope" NOT NULL,
    "group" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PermissionEntry_pkey" PRIMARY KEY ("code")
);
CREATE INDEX "PermissionEntry_scope_group_idx" ON "PermissionEntry"("scope", "group");

-- 3. Role 表（自定义角色，scope=PLATFORM teamId=null / scope=TEAM teamId 必填）
CREATE TABLE "Role" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scope" "RoleScope" NOT NULL,
    "teamId" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT NOT NULL DEFAULT '',
    "permissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);
-- 同 scope+teamId 下角色名唯一（Postgres 多列 unique 对 null 各行独立，平台级 teamId=null 全局唯一）
CREATE UNIQUE INDEX "Role_scope_teamId_name_key" ON "Role"("scope", "teamId", "name");
CREATE INDEX "Role_scope_teamId_idx" ON "Role"("scope", "teamId");

-- 4. PluginGrant 表（团队级插件授权，subjectId 多态不建 FK）
CREATE TABLE "PluginGrant" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "pluginId" TEXT NOT NULL,
    "subjectKind" "PluginGrantSubject" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "effect" "PluginGrantEffect" NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PluginGrant_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PluginGrant_teamId_pluginId_subjectKind_subjectId_key" ON "PluginGrant"("teamId", "pluginId", "subjectKind", "subjectId");
CREATE INDEX "PluginGrant_teamId_pluginId_idx" ON "PluginGrant"("teamId", "pluginId");

-- 5. User / TeamMembership 加角色引用列（过渡期与旧枚举列并存）
ALTER TABLE "User" ADD COLUMN "platformRoleId" TEXT;
ALTER TABLE "TeamMembership" ADD COLUMN "teamRoleId" TEXT;

-- 6. 内置系统角色（三条，isSystem=true，幂等用固定 name 占位 seed 由应用层补 permissions）
--    平台级：teamId=null；团队级系统角色为「每个团队一条」（这里先不预生成团队级系统角色，
--    改由应用层 seed 按需为每个已存在团队补「系统团队管理员」「系统成员」，并在新建团队时自动补）。
INSERT INTO "Role" ("id", "name", "scope", "teamId", "isSystem", "description", "permissions", "updatedAt")
SELECT
    -- 固定 id 便于回填引用 + 应用层 seed 识别（gen_random_uuid 不幂等，用确定性占位）
    '00000000-0000-0000-0000-platform0001',
    '系统平台管理员',
    'PLATFORM',
    NULL,
    true,
    '内置平台管理员角色，拥有全部平台权限',
    ARRAY[]::TEXT[],
    CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "Role" WHERE "id" = '00000000-0000-0000-0000-platform0001');

-- 7. 回填：现有 platformRole=PLATFORM_ADMIN 的用户指向系统平台管理员角色
UPDATE "User"
SET "platformRoleId" = '00000000-0000-0000-0000-platform0001'
WHERE "platformRole" = 'PLATFORM_ADMIN' AND "platformRoleId" IS NULL;

-- 8. 团队级系统角色：为每个已存在团队补「系统团队管理员」「系统成员」两条 isSystem 角色，
--    并把现有 membership.role 回填到 teamRoleId。
--    用 WHERE NOT EXISTS 保证幂等；确定性 id（teamId 拼前缀）便于回填引用 + 应用层 seed 识别。
INSERT INTO "Role" ("id", "name", "scope", "teamId", "isSystem", "description", "permissions", "updatedAt")
SELECT
    'team-admin-' || "id",
    '系统团队管理员',
    'TEAM',
    "id",
    true,
    '内置团队管理员角色，拥有全部团队权限',
    ARRAY[]::TEXT[],
    CURRENT_TIMESTAMP
FROM "Team" t
WHERE NOT EXISTS (SELECT 1 FROM "Role" r WHERE r."teamId" = t."id" AND r."name" = '系统团队管理员');

INSERT INTO "Role" ("id", "name", "scope", "teamId", "isSystem", "description", "permissions", "updatedAt")
SELECT
    'team-member-' || "id",
    '系统成员',
    'TEAM',
    "id",
    true,
    '内置成员角色，拥有只读基线权限',
    ARRAY[]::TEXT[],
    CURRENT_TIMESTAMP
FROM "Team" t
WHERE NOT EXISTS (SELECT 1 FROM "Role" r WHERE r."teamId" = t."id" AND r."name" = '系统成员');

-- 9. 回填 membership.teamRoleId：TEAM_ADMIN→系统团队管理员，MEMBER→系统成员
UPDATE "TeamMembership"
SET "teamRoleId" = 'team-admin-' || "teamId"
WHERE "role" = 'TEAM_ADMIN' AND "teamRoleId" IS NULL;

UPDATE "TeamMembership"
SET "teamRoleId" = 'team-member-' || "teamId"
WHERE "role" = 'MEMBER' AND "teamRoleId" IS NULL;

-- 10. 外键约束（回填完成后加，避免约束阻止回填）
ALTER TABLE "Role"
ADD CONSTRAINT "Role_teamId_fkey"
FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PluginGrant"
ADD CONSTRAINT "PluginGrant_teamId_fkey"
FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PluginGrant"
ADD CONSTRAINT "PluginGrant_pluginId_fkey"
FOREIGN KEY ("pluginId") REFERENCES "Plugin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PluginGrant"
ADD CONSTRAINT "PluginGrant_createdBy_fkey"
FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "User"
ADD CONSTRAINT "User_platformRoleId_fkey"
FOREIGN KEY ("platformRoleId") REFERENCES "Role"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "TeamMembership"
ADD CONSTRAINT "TeamMembership_teamRoleId_fkey"
FOREIGN KEY ("teamRoleId") REFERENCES "Role"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 11. 查询索引
CREATE INDEX "User_platformRoleId_idx" ON "User"("platformRoleId");
CREATE INDEX "TeamMembership_teamRoleId_idx" ON "TeamMembership"("teamRoleId");
