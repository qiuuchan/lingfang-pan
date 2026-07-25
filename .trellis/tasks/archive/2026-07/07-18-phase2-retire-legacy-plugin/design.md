# 技术设计 — 退役 legacy Plugin 表

## 1. 边界与切换策略

v4 `PluginPackage / PluginRelease / MarketplaceListing / PluginEntitlement` 已是桌面端、市场、审核和运行时的主路径。phase2 不重做 v4，而是清除仍可能写读 `Plugin` 的死代码，并将存量依赖转换为 v4 身份。

切换分两段：

1. 在线、幂等地运行 `migrate-plugin-registry-v4.ts --apply`，生成制品、v4 行和关联回填；随后运行 `--verify`。
2. 在维护窗口备份数据库与制品存储，停止旧版本 API 实例，部署删除 legacy schema 的 migration 和新应用。

不增加双写。所有 legacy HTTP 路由仅保留 410 响应，避免旧客户端在回填后重新制造 legacy 行。

## 2. 身份映射

每个 `Plugin` 以 `(teamId, manifest.id)` 映射到一个 `PluginPackage`，以 `(packageId, manifest.version)` 映射到一个精确 `PluginRelease`。迁移审计：

```text
AuditLog.action     = plugin.registry.legacy_migrated
AuditLog.targetType = Plugin
AuditLog.targetId   = legacy Plugin.id
metadata            = { packageId, releaseId, sha256 }
```

该审计行是 destructive migration 的可机读映射凭据。缺 `teamId`、制品校验失败或映射冲突均记失败并使脚本非零退出。

## 3. 关联数据迁移

### Purchase

- 所有带 `pluginId` 的历史订单回填同一插件映射的 `packageId` 和 `releaseId`。
- `sellerTeamId` 缺失时补为 legacy 插件所属团队。
- 金额、买卖用户、创建时间、订单状态和 `LEGACY_V1` 结算语义不改写。
- 同一买家团队存在多笔 legacy 订单时，最早订单作为 entitlement 的 provenance；其余订单仍保留 v4 package/release 追溯。

### PluginInstallation

- `ENABLED` 安装若尚无 entitlement，则创建 active `PluginEntitlement`；已存在购买权益时不覆盖其 purchaseId/status。
- 每条安装创建幂等 `MarketplaceMetricEvent(INSTALL_SUCCEEDED, source=REGISTRY)`，`sourceRecordId` 为 legacy installation ID，metadata 保留 legacy status/version/installedById。
- `DISABLED` 安装只迁历史事实，不新授予 active entitlement。

### PluginRating

- v4 评分粒度是 `package + team`。按团队将 legacy 评分按 `createdAt,id` 排序，取最新一条作为当前评分。
- 仅当该团队没有现成 v4 评分时创建 `MarketplaceRating`、revision 1 和 `RATING_CHANGED` 事实；已有 v4 评分视为更可信的当前事实，不被旧数据覆盖。
- 迁移后按 v4 当前评分重算 listing 的 `ratingCount/ratingSum`。质量快照由既有 computation scheduler 使用 revision/event 重新计算。

### Review 与 Grant

- `PluginReview` 幂等复制到对应 `PluginReleaseReview`。
- `PluginGrant.packageId` 回填后，运行时只按 packageId 解析；删表 migration 将 `packageId` 设为必填并删除 `pluginId`。

## 4. API 与应用投影

- `/api/plugins/*`（`/policy/check` 除外）、`/api/marketplace/*`、`/api/wallet/purchase`、`/api/admin/plugins/*` 返回 `410 legacy_plugin_api_retired`。
- 删除未被 controller 使用的 `PluginService`、`MarketplaceService`、`EconomyService` 及 v3 JSON package normalizer。
- `AdminService` 财务 Top 插件、团队插件计数/列表改读 `MarketplaceListing + PluginPackage + latest PluginRelease`。
- `MeService.exportMyData` 改读作者的 v4 packages/releases/listing；历史 purchase 输出 `pluginId: null` 并携带 packageId/releaseId。
- 桌面 Rust 删除未被前端调用的 `upload_plugin` command；v4 `publish_local_artifact` 保持不变。

## 5. Schema 收敛

删除：

- models：`Plugin`、`PluginInstallation`、`PluginReview`、`PluginRating`
- relations：User/Team 上的 legacy 反向关系
- columns：`Purchase.pluginId`、`PluginGrant.pluginId`
- enums：`PluginStatus`、`PluginRuntimeType`、`PluginVisibility`

保留：

- `PluginReviewStatus`（v4 release review 仍使用）
- `WalletTransaction.pluginId`（无 FK 的历史展示字段；不构成 legacy model 依赖）
- 旧迁移 SQL（历史不可改写）

## 6. 安全门禁与回滚

PostgreSQL migration 在 drop 前断言：

- 每个 legacy Plugin 有有效审计映射；
- 所有 plugin-linked Purchase 已有 packageId/releaseId；
- 所有 PluginGrant 已有 packageId；
- enabled installation 对应 active entitlement；
- rating/review 的 v4 目标行存在。

任何断言失败都 `RAISE EXCEPTION`，不执行 drop。MySQL 的 `db push` 无法承载相同 SQL 断言，必须先运行 `plugin-registry:migrate --verify`，并由运维显式设置 `PRISMA_MYSQL_ACCEPT_DATA_LOSS_ONCE=1`。

删除表后不提供自动 down migration。回滚步骤：停止新实例、恢复切换前数据库快照和制品存储快照、部署上一版本。迁移 JSON 报告和备份时间点必须进入变更记录。

## 7. 兼容性

- 新客户端完全不受 legacy 路由影响。
- 旧客户端得到稳定 410 和升级提示，不会误以为上传/购买成功。
- 管理端/个人导出的兼容字段保持；内部 ID 从 legacy plugin ID 切为 package ID。
- 历史审计 targetType=`Plugin` 保留，作为不可变历史，不要求重写。
