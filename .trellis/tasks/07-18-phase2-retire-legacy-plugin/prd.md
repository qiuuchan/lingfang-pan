# 阶段2：退役 legacy Plugin 表

> 父任务：[`07-18-unify-plugin-system-v4`](../07-18-unify-plugin-system-v4/prd.md)
> 依赖：阶段1 完成（所有读路径已离开 `Plugin`）。

## Goal

legacy `Plugin` 表完全退役：存量数据迁进 v4，旧上传/旧审核/旧市场接口与前端页面下线，删除 `Plugin` 相关代码与（最终）表结构。v4 成为唯一插件系统。

## 范围（目标级，详细设计待 phase1 完成后补 design.md）

预期改动面：
- **数据迁移**：legacy `Plugin` → v4 `PluginPackage`+`PluginRelease`+`MarketplaceListing`；含购买记录、安装记录、审核历史的归属对齐（接续 phase1 Q1/Q2）。
- **接口下线**：`POST /api/plugins/upload`（`uploadPlugin`）、`GET /api/admin/plugins/review-pending`、legacy `marketplace.service` 残余端点 → 返回 410 Gone 或删除。
- **前端下线**：collab-admin legacy 插件审核页/编辑页、桌面端任何 legacy `/api/plugins/*` 残余调用（如 `plugin-ai-policy.ts` 的 `/api/plugins/policy/check` 迁移或确认废弃）。
- **Rust 侧**：`upload.rs::upload_plugin`（旧 v3 上传命令）若仍注册则移除（桌面已用 v4 `publish_local_artifact`）。
- **schema**：最终 `Plugin` 模型及相关索引移除（Prisma migration，需确认无依赖后）。

## 关键问题（详规时解决）

- Q1 迁移策略：在线迁移 vs 停机一次性；是否需要双写过渡（phase1 Q5 已倾向不双写）。
- Q2 购买/安装历史归属：legacy `Purchase`/`PluginInstallation` 若外键引用 `Plugin.id`，迁移后如何改引用 `PluginPackage`/`PluginRelease`（schema 外键变更，高风险）。
- Q3 回滚预案：表结构删除不可逆，需备份 + 灰度。
- Q4 旧客户端兼容：是否有旧版本桌面客户端仍在调旧 `/api/plugins/upload`（需留 410 兼容期还是直接断）。

## 验收（目标级）

- [ ] legacy `Plugin` 表无新写入；代码库无 `prisma.plugin` 读写（除迁移脚本）。
- [ ] 旧上传/审核/市场接口 410 或删除；前端无入口。
- [ ] 存量 legacy 插件的购买/安装记录在 v4 体系下可追溯（迁移校验）。
- [ ] Prisma migration 落地，`Plugin` 模型移除，部署稳定。

## Out of Scope

- 不改 v4 系统本身的数据模型（仅在必要时为迁移加字段）。
- 不重写购买/计费业务规则（phase1 已对齐）。

## Notes

- **高风险阶段**：动表结构与历史外键，需充分备份 + 灰度 + 回滚预案。
- 本 PRD 为目标级；**design.md / implement.md 待 phase1 完成后、进入本阶段时再写**（届时读路径已切，迁移边界才清晰）。
- 排序：phase0 → phase1 → phase2，逐阶段上线。phase2 前确认 phase1 在生产稳定运行。
