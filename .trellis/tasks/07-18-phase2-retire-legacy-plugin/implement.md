# 实施计划 — 退役 legacy Plugin 表

## 0. 准备与门禁

- [x] 0.1 保存 `git status`、数据库/制品备份操作说明和当前 legacy 引用扫描。
- [x] 0.2 确认旧 controller 已无业务调用方；保留 410 compatibility surface。
- [x] 0.3 运行当前 Prisma validate/typecheck，记录基线。

## 1. 完整数据回填

- [x] 1.1 为迁移脚本补 `Purchase.packageId/releaseId/sellerTeamId` 回填。
- [x] 1.2 将 enabled `PluginInstallation` 转 active entitlement，并为全部安装写幂等 install metric。
- [x] 1.3 将 legacy rating 按 package+team 收敛到 `MarketplaceRating` + revision/event，并重算 listing 聚合。
- [x] 1.4 保持 review/grant 迁移幂等；已有 v4 数据不被旧数据覆盖。
- [x] 1.5 增加 `--verify`：输出未映射 plugin/purchase/install/rating/review/grant 数量，任一非零即失败。

验证：

```powershell
pnpm -C apps/collab-api plugin-registry:migrate
pnpm -C apps/collab-api plugin-registry:migrate -- --verify
```

无可用数据库时至少通过 typecheck 与迁移 helper 单测；生产执行必须在删表部署前完成。

## 2. 关闭 legacy 运行代码

- [x] 2.1 旧插件/市场/钱包/管理接口统一 410 `legacy_plugin_api_retired`。
- [x] 2.2 从 Nest module 移除 legacy service providers，删除 service 和专属测试。
- [x] 2.3 AI policy audit 改为只审计 v4 release。
- [x] 2.4 Admin/Me 数据投影改读 v4。
- [x] 2.5 PluginGrant 契约和查询只保留 packageId。
- [x] 2.6 删除 Rust `upload_plugin` command/module；确认前端无调用。

## 3. Prisma schema 与 migration

- [x] 3.1 删除 legacy models/relations/enums/columns，更新所有 Prisma select/type。
- [x] 3.2 新增 PostgreSQL destructive migration，drop 前带未迁移数据断言。
- [x] 3.3 更新 MySQL 部署说明：verify + 一次性 data-loss opt-in。
- [x] 3.4 `pnpm -C apps/collab-api prisma:generate` 与 `prisma:validate` 通过。

## 4. 测试与跨层验证

- [x] 4.1 更新/新增 legacy 410、v4 admin projection、Me export、grant packageId 测试。
- [x] 4.2 扫描运行代码无 `prisma.plugin`、`pluginInstallation`、`pluginRating`、`pluginReview`（迁移脚本/历史 migration 除外）。
- [x] 4.3 运行 collab-api、contract、desktop、collab-admin、plugin-sdk typecheck/tests。
- [x] 4.4 运行 `cargo test -p lingfang-desktop` 与 `git diff --check`。

## 5. 发布/回滚检查

- [x] 5.1 记录生产顺序：备份 → migrate --apply → --verify → 停旧实例 → deploy schema/app → smoke test。
- [x] 5.2 定义 smoke：v4 discovery/detail/purchase/download/review/grant/me-export/admin stats。
- [x] 5.3 定义回滚演练：恢复 DB + artifact snapshot + 上一应用版本。

## Rollback Points

- Step 1/2 可直接 revert 应用代码，数据回填是加法且幂等。
- Step 3 删除表后必须通过备份恢复，禁止尝试手工重建空 legacy 表冒充回滚。
- PostgreSQL 断言失败时 migration 整体停止；先修复迁移报告中的缺口再重试。

## Verification Record (2026-07-25)

- `prisma:validate` / `prisma:generate`、monorepo typecheck、全仓 JS/TS tests、相关 builds 与 Rust tests 全部通过。
- collab-api 最终回归：109 files passed，976 tests passed，13 skipped。
- 全仓回归：contract 71、workflow-engine 8、web 19、plugin-preview 3、plugin-sdk 115、desktop 375、collab-api 976。
- 本开发环境没有生产 legacy 数据库，因此没有实际执行 `--apply` / `--verify` 或 destructive deploy。生产维护窗口必须按 `docs/collab-deployment.md` 执行并保存迁移报告、smoke 和恢复演练证据。
