# 阶段0：后台审核统一到 v4

> 父任务：[`07-18-unify-plugin-system-v4`](../07-18-unify-plugin-system-v4/prd.md)

## Goal

后台插件审核收敛到 v4 单一入口：新增「待审核发行版」直列页（消费现成的 `GET /api/admin/plugin-releases/review-pending`），作为平台审核员的主要审核入口；旧 legacy「插件审核」页（查 `Plugin.reviewStatus`）从主导航隐藏。让 v4 市场提交（`PluginRelease.marketReviewStatus='PENDING'`）在后台**可见、可审、可批**。

## Background

- v4 提交写 `PluginRelease.marketReviewStatus`，后台旧审核页查 legacy `Plugin.reviewStatus`（`admin.service.ts:1001`）→ v4 提交在旧页永远空（用户本次踩坑）。
- 后端 v4 审核接口**已齐全**：`GET review-pending`（`pendingReviews` 返回 `{items:[{package,release,fileManifest}]}`）、`POST :id/approve|reject|delist`、`GET :id/manifest|files|reviews`。
- 后台前端 `governance/api.ts` 已封装 approve/reject/delist，但**没消费 `review-pending`**；`governance-view.tsx` 有 `PluginPackagesTab` 但无「待审核发行版」直列页。
- Dashboard 已有「待审核插件发行版」计数（`pendingPluginReviews`），点进去没有对应列表页。

## Requirements

### 功能性
- **R1 待审核直列页**：后台新增「待审核发行版」视图，列出所有 `marketReviewStatus='PENDING'` 的 `PluginRelease`（消费 `review-pending`），每条显示：插件包名/manifestId、版本、所属团队、提交时间、AI 政策状态、来源（desktop/api）。
- **R2 一键进入审批**：每条可进 `plugin-package-sheet`（既有抽屉）定位到该 release，直接 approve/reject（复用 `approvePluginRelease`/`rejectPluginRelease`）。
- **R3 主入口**：Dashboard「待审核插件发行版」计数卡片点击 → 跳到该直列页；主导航「插件审核」入口指向 v4 直列页。
- **R4 legacy 降级**：旧 legacy 插件审核页（`/admin/plugins/review-pending`，查 `Plugin`）从主导航移除；路由保留但标注「仅历史 legacy 数据」并加跳转提示到 v4 页（legacy `Plugin` 完全退役留到 phase2）。

### 约束
- **C1 不动后端审核逻辑**：`pendingReviews`/`approveRelease` 等已就绪，本阶段以**前端消费**为主；仅在接口缺分页/筛选时做最小后端补强。
- **C2 不碰 legacy 数据**：legacy `Plugin` 表与旧上传接口保持原样，本阶段只调整后台「入口路由」。
- **C3 权限不变**：沿用 `platform.plugin.review` 权限码。

## Acceptance Criteria

- [ ] 平台审核员在后台能打开「待审核发行版」页，看到当前所有 v4 PENDING 提交（含本次 detail-poster 0.2.4）。
- [ ] 点某条 → 进入该 release 审批抽屉 → approve → 该条从待审核列表消失、状态变 APPROVED。
- [ ] Dashboard「待审核插件发行版」数字与直列页条数一致；点计数卡片跳到直列页。
- [ ] 主导航不再把 legacy「插件审核」作为主入口；旧页面访问时提示去 v4 页。
- [ ] 无 v4 PENDING 时直列页显示空态；非审核员无权限访问（403）。

## Out of Scope

- 不改 marketplace 货架/购买（phase1）。
- 不迁移/删除 legacy `Plugin` 数据（phase2）。
- 不改桌面端发布流程。
- 不重构 governance tab 整体结构（仅新增直列页 + 调入口）。

## Notes

- 后端 `pendingReviews` 目前 `findMany` 无分页——若 PENDING 量大需补 `take/skip`，列入 implement 待定项。
- 审批动作复用既有 `plugin-package-sheet` 抽屉，避免重复造 approve UI。
