# 阶段2：退役 legacy Plugin 表

> 父任务：[`07-18-unify-plugin-system-v4`](../07-18-unify-plugin-system-v4/prd.md)
> 依赖：阶段1 完成（所有读路径已离开 `Plugin`）。

## Goal

legacy `Plugin` 表完全退役：存量数据迁进 v4，旧上传/旧审核/旧市场接口与前端页面下线，删除 `Plugin` 相关代码与（最终）表结构。v4 成为唯一插件系统。

## Confirmed Decisions

- 采用“先幂等回填、再维护窗口删表”的两阶段切换；不再增加双写，因为桌面与管理端主路径已经全部使用 v4。
- 旧客户端兼容端点保留一个明确的 `410 Gone / legacy_plugin_api_retired` 响应，不再接受任何 legacy 写入。
- legacy 购买全部回填 `Purchase.packageId/releaseId`；有效安装回填 `PluginEntitlement`，所有安装写入带 legacy 来源 ID 的质量事实事件。
- legacy 评分按 `packageId + teamId` 收敛；同团队多用户评分取最新一条作为 v4 当前评分，原 legacy ID 写入 revision/source 便于追溯。
- PostgreSQL destructive migration 在执行前做 SQL 级未迁移数据断言；MySQL 使用同一 Prisma schema，并要求先运行迁移脚本 `--verify` 后显式启用一次性 data-loss 开关。
- 删除表后的回滚不是反向 migration，而是恢复数据库与制品存储备份；因此切换前必须保存可恢复备份并保留迁移报告。

## Scope

预期改动面：

- **数据迁移**：legacy `Plugin` → v4 `PluginPackage`+`PluginRelease`+`MarketplaceListing`；含购买、安装、评分、授权和审核历史的归属对齐。
- **接口下线**：`POST /api/plugins/upload`（`uploadPlugin`）、`GET /api/admin/plugins/review-pending`、legacy `marketplace.service` 残余端点 → 返回 410 Gone 或删除。
- **前端下线**：collab-admin legacy 插件审核页/编辑页、桌面端任何 legacy `/api/plugins/*` 残余调用（如 `plugin-ai-policy.ts` 的 `/api/plugins/policy/check` 迁移或确认废弃）。
- **Rust 侧**：`upload.rs::upload_plugin`（旧 v3 上传命令）若仍注册则移除（桌面已用 v4 `publish_local_artifact`）。
- **schema**：最终 `Plugin` 模型及相关索引移除（Prisma migration，需确认无依赖后）。

## Requirements

- R1：迁移脚本可重复执行；重复执行不得重复创建发行版、权益、评分 revision、质量事实或审核历史。
- R2：每个可迁 legacy 插件都有稳定的 `PluginPackage`、精确 `PluginRelease` 和审计映射；有团队归属但迁移失败时必须非零退出并阻止删表。
- R3：legacy `Purchase` 全部回填 `packageId/releaseId`，不会改写原始金额、买卖双方或 `LEGACY_V1` 结算语义。
- R4：有效 legacy 安装在 v4 下可访问；安装历史通过 `MarketplaceMetricEvent.sourceRecordId` 关联原安装 ID，禁用安装不会凭空授予访问权。
- R5：legacy 评分和审核历史迁入 v4 对应事实表；已有更新的 v4 评分不得被旧数据覆盖。
- R6：应用运行代码不再注册或读取 legacy service/model；旧上传、管理、市场和钱包购买路由统一返回 410。
- R7：Prisma schema 删除 legacy model、关系、索引和仅 legacy 使用的 enum；PostgreSQL migration 与 MySQL destructive deploy 都有显式操作门禁。
- R8：个人数据导出、平台财务看板、团队详情/插件列表继续从 v4 投影返回兼容字段。

## 验收（目标级）

- [x] legacy `Plugin` 表无新写入；代码库无 `prisma.plugin` 读写（除迁移脚本）。
- [x] 旧上传/审核/市场接口 410 或删除；前端无入口。
- [x] 存量 legacy 插件的购买/安装记录在 v4 体系下可追溯（迁移校验）。
- [x] Prisma migration 落地，`Plugin` 模型移除；部署步骤与 destructive guards 已记录。
- [x] `Purchase.pluginId`、`PluginGrant.pluginId` 及 legacy-only `PluginStatus/PluginRuntimeType/PluginVisibility` 从 Prisma schema 移除。
- [x] `pnpm -C apps/collab-api prisma:validate`、typecheck、测试和 `cargo test -p lingfang-desktop` 通过。

## Out of Scope

- 不改 v4 系统本身的数据模型（仅在必要时为迁移加字段）。
- 不重写购买/计费业务规则（phase1 已对齐）。

## Notes

- **高风险阶段**：动表结构与历史外键，需充分备份 + 灰度 + 回滚预案。
- 详细迁移与回滚边界见同目录 `design.md`，执行顺序与验证命令见 `implement.md`。
- 排序：phase0 → phase1 → phase2，逐阶段上线。phase2 前确认 phase1 在生产稳定运行。
- 生产 `--apply` / `--verify`、smoke 与恢复演练属于维护窗口操作；本开发环境无生产 legacy 数据库，不能把静态/单元验证替代为生产执行记录。
