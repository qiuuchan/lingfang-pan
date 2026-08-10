-- NEW-2：消除迁移链产物与 schema.prisma 之间的结构漂移。
-- 漂移由 `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma` 在
-- 空库跑完全链后测得，本迁移只处理其中「有实质语义」的一类：残留的列默认值。
--
-- 这 5 个默认值都是历史「给已有表加 NOT NULL 列」时为回填而临时加的脚手架，
-- 回填完成后没有摘掉，schema.prisma 里从来就没有对应的 @default：
--   Channel.kind    DEFAULT 'CHAT'   （20260623020000_pool_model_redesign 回填遗留）
--   Channel.tier    DEFAULT 'FAST'
--   Channel.poolId  DEFAULT '00000000-0000-0000-0000-defaultpool'
--       ↑ 最危险的一个：这是个哨兵外键值，漏填 poolId 的写入会静默指向一个并不存在的池，
--         而不是当场报错。摘掉默认值后此类写入会被 NOT NULL 直接拦下。
--   PermissionEntry.moduleKey    DEFAULT ''
--   PermissionEntry.moduleLabel  DEFAULT ''
--       ↑ 空 moduleKey 会污染 @@index([scope, moduleKey]) 上的按模块分组统计。
--
-- 安全性：DROP DEFAULT 只影响后续 INSERT，不改动存量行。schema.prisma 本就无 @default，
-- 因此 Prisma Client 生成的类型早已要求调用方显式提供这些字段；代码库内亦无绕过 Client 的
-- 裸 INSERT INTO "Channel" / "PermissionEntry"。
--
-- 本迁移「不」处理的两类差异，理由如下（见 commit message 与 schema.prisma 同步改动）：
--
-- 1) 9 处纯改名（3 个外键约束 + 6 个索引），例如
--      PluginSharedValueArtifact_artifact_fkey
--        -> PluginSharedValueArtifact_artifactId_executionKind_fkey
--      MarketplaceQualitySnapshot_identity_key
--        -> MarketplaceQualitySnapshot_packageId_releaseId_currentRelea_key
--    这些是 Prisma 默认命名规则 + 63 字符标识符截断产生的版本相关产物，
--    约束/索引本身的列、类型、语义完全一致。手工改名只会把当前 Prisma 版本的截断结果
--    固化进迁移链，升级 Prisma 后又要再改一轮，因此保持现名，仅在此登记。
--
-- 2) Purchase_campaignItemId_createdAt_idx 与 SharedStateOutbox_namespaceId_cursor_idx
--    这两处 diff 的正确对齐方向是「改 schema.prisma」而不是「改库」，已在同一提交内
--    修正 schema.prisma，故本文件不含相应 DDL。

ALTER TABLE "Channel"
  ALTER COLUMN "kind" DROP DEFAULT,
  ALTER COLUMN "tier" DROP DEFAULT,
  ALTER COLUMN "poolId" DROP DEFAULT;

ALTER TABLE "PermissionEntry"
  ALTER COLUMN "moduleKey" DROP DEFAULT,
  ALTER COLUMN "moduleLabel" DROP DEFAULT;
