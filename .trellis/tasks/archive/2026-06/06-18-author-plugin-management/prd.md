# 作者侧插件管理（软件内自助管理「我的插件」）

## Goal

让插件作者在桌面壳内有一个集中的「作者中心」，自助管理自己创建的插件：编辑名称/描述/图标、启用/禁用、改价、提交上架/下架（审核流程内）、删除，无需进入管理后台或重新走完整上传流程。

## 背景与现状（实证）

- 后端作者侧接口已基本完整（`apps/collab-api/src/modules/plugin.service.ts`）：
  - `myPlugins`（GET /api/plugins/mine）— 列出作者本团队创建的插件
  - `setPluginStatus`（POST /api/plugins/:id/set-status）— 启用/禁用
  - `setPluginPrice`（POST /api/plugins/:id/set-price）— 改价
  - `submitPluginToMarketplace`（POST /api/plugins/:id/submit-marketplace）— 提交市场审核
  - `editPluginDraft`（POST /api/plugins/:id/edit-draft）— 编辑草稿（会重置 reviewStatus=DRAFT，要求完整 files）
  - `deleteByAuthor`（DELETE /api/plugins/:id）— 删除（未上架可删）
- **缺口 1（后端）**：没有「仅改元数据（名称/描述/图标）而不重置审核态、不要求重传 files」的轻量接口。`editPluginDraft` 会把 `reviewStatus` 打回 `DRAFT` 并要求完整包，不适合只改个名字。
- **缺口 2（数据）**：`Plugin` 表无 `icon` 字段（已确认 schema 第 232-271 行）。图标决定存入 `manifest` JSON（`manifest.icon`），不加 schema 迁移。
- **缺口 3（前端）**：`apps/desktop/src/pages/PluginList.tsx` 已内联实现改价/启停/删除，但**无编辑名称/描述/图标 UI、无提交上架 UI**；且作者操作散落在通用插件列表里，没有集中的「我的插件」作者中心。
- `View` 联合类型（`apps/desktop/src/lib/types.ts:148`）当前无作者中心入口，需新增。

## Requirements

### 后端（collab-api）

1. 新增「编辑插件元数据」能力 `editPluginMeta`：仅更新 `name`、`description` 以及 `manifest.icon`（图标），**不重置** `reviewStatus`、**不要求** files。
   - 入参：`{ name?, description?, icon? }`，均可选，至少传一项。
   - 名称非空校验（trim 后不为空）、长度上限对齐既有约束；描述允许空串。
   - 图标 `icon` 存入 `manifest.icon`，同时同步顶层 `name`/`description` 冗余列（与 `editPluginDraft` 对齐：DB 顶层 `name`/`description` 与 `manifest.name`/`manifest.description` 双写保持一致）。
   - 权限沿用 `ensurePluginManager`（作者或团队管理员）。
   - 约束：审核中（PENDING）不可编辑（与既有 `editPluginDraft`/`setPluginStatus` 一致返回 conflict）。已上架（APPROVED+marketplace）是否允许仅改元数据，在 design 中定夺并写明理由。
   - 落审计日志 `plugin.meta.edited`。
2. 暴露 REST 端点 `POST /api/plugins/:id/edit-meta`（`apps/collab-api/src/modules/plugins.controller.ts`），新增对应 DTO（`EditPluginMetaDto`，class-validator 校验）。
3. `publicPlugin` 序列化需保证 `manifest.icon` 能被前端读取（确认现有 `manifest` 字段已透出，无需额外改动则记录结论）。

### 前端（desktop）

4. 新增「作者中心」页面（独立 View，如 `'author-center'`），入口挂到侧边栏（`apps/desktop/src/components/Sidebar.tsx`）。
5. 作者中心展示「我的插件」列表（数据源 GET /api/plugins/mine），每个插件支持：
   - 编辑名称/描述/图标（调用新 `edit-meta` 端点）
   - 启用/禁用（复用 `set-status`）
   - 改价（复用 `set-price`）
   - 提交上架（复用 `submit-marketplace`，新增 UI）
   - 删除（复用 DELETE）
   - 展示当前审核状态/价格/启停态（复用 `PluginList` 已有的 Badge 模式）
6. 列表展示每个插件的图标（若 `manifest.icon` 存在）。
7. 操作成功后刷新列表（与本任务并行的 `06-18-plugin-status-refresh` 协调：作者中心也提供手动刷新按钮）。

### 复用约束

- 优先复用 `PluginList.tsx` 既有的 `PluginPriceEditDialog`/`PluginStatusToggle`/`PluginDeleteDialog` 模式与样式，避免重复造轮子。
- 图标编辑控件复用项目既有上传/输入组件，不新引依赖。图标格式（URL 字符串 / base64 data URI / emoji）在 design 中定夺并写明上限约束。

## 非目标（Out of Scope）

- 不做版本历史管理 / 多版本并存（现有 `version` 字段保持单值，作者改源码仍走 `edit-draft` 重新审核）。
- 不做订阅/分级定价（沿用单价 `priceCents`）。
- 不改动已上架插件对已购用户的可见性规则。
- 不新增独立的桌面端登录/认证 UI（复用现有会话）。
- 不做图标的服务端文件存储/CDN（图标随 manifest 走 JSON）。

## Acceptance Criteria

- [ ] 后端 `POST /api/plugins/:id/edit-meta` 可仅改名称/描述/图标，调用后 `reviewStatus` 不变、files 不变，`manifest.icon` 与顶层 `name`/`description` 同步更新，审计日志写入。
- [ ] 非作者/非团队管理员调用 `edit-meta` 被拒（沿用 `ensurePluginManager`）；审核中插件调用返回 conflict。
- [ ] 桌面壳侧边栏出现「作者中心」入口，点击进入「我的插件」列表，数据来自 /api/plugins/mine。
- [ ] 作者中心可完成：改名称/描述/图标、启停、改价、提交上架、删除，全部走对应后端端点并在成功后刷新。
- [ ] 列表展示插件图标（manifest.icon 存在时）与审核状态/价格/启停 Badge。
- [ ] collab-api `pnpm build`（tsc）通过；desktop `pnpm build`（tsc + vite）通过。
- [ ] 后端 `edit-meta` 有单元/集成测试覆盖（正常改元数据、权限拒绝、审核中拒绝三条路径）。

## Notes

- 复杂任务：另见 `design.md`（技术设计）与 `implement.md`（执行计划）。
- 与 `06-18-plugin-status-refresh` 共享刷新机制，注意 PluginList/作者中心两处刷新逻辑一致性。
