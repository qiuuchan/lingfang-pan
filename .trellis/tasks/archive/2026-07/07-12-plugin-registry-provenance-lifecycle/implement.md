# Implementation Plan

- [x] 扩展 contract provenance、DraftWorkspace、management/listing schemas 和 tests。
- [x] 扩展 Prisma enums/models 并添加 additive migration 与 legacy migration 显式来源。
- [x] 运行 Prisma generate，更新受影响类型。
- [x] 为上传 metadata 增加 decode/validation，并将来源写入 release/audit/serializer。
- [x] 增加 team manage list 和完整 listing projection。
- [x] 实现 package archive/restore、release yank/restore、submission withdraw、owner delist/relist。
- [x] 实现 platform suspend/relist、current release 校验和审核 artifact 下载。
- [x] 将 approve/reject 改为条件抢占并按最高 SemVer 投影 current release。
- [x] 修正对象级授权和 purchase 的 `team.plugin.install` 权限。
- [x] 加固 manifest metadata/capability/entry 校验与相关 artifact 零变更测试。
- [x] 补来源、状态矩阵、并发、SemVer、下架方隔离、迁移回填单测。
- [x] 运行 contract/collab-api test、typecheck、build 和 `git diff --check`。

## Risky Files

- `apps/collab-api/src/modules/plugin-registry.service.ts`：保持 artifact cleanup、purchase transaction 和 entitlement 语义不回退。
- `apps/collab-api/prisma/schema.prisma`：只做 additive 修改，不碰旧 Plugin 双模型删除。
- `apps/collab-api/src/modules/plugin-artifact.ts`：新增 metadata 校验不得弱化现有流式 CRC/边界验证。

## Validation

- `pnpm -C packages/contract test`
- `pnpm -C packages/contract typecheck`
- `pnpm -C apps/collab-api prisma:generate`
- `timeout 60s pnpm -C apps/collab-api test`
- `pnpm -C apps/collab-api typecheck`
- `pnpm -C apps/collab-api build`

实际结果（2026-07-12）：registry 定向 123/123、collab-api 全量 682/682、contract 27/27；PostgreSQL/MySQL `prisma:validate`、contract/collab-api typecheck 与 build、`git diff --check` 均通过。
