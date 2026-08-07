# 执行计划 — 阶段0：后台审核统一到 v4

## 前置确认（实现前定位）

- [ ] P1 `governance-view.tsx` 的 tab 注册/切换机制（看 `PluginPackagesTab` 如何接入、是否支持 query 参数切 tab）。
- [ ] P2 `plugin-package-sheet.tsx` 是否支持透传 `initialReleaseId` 预选某 release；若否，列为小改项。
- [ ] P3 主导航定义文件（legacy「插件审核」入口在哪声明，移除点）。
- [ ] P4 dashboard 卡片是否已支持 onClick/链接（`dashboard.tsx:67-68` 周边）。

## Step 1 — 后端（最小）

- [ ] 1.1 视情况给 `pendingReviews`（`plugin-registry.service.ts`）加 `take: 100` 兜底；若需分页，加 `page/pageSize` + `total`（参考 `adminReleases` 分页）。**仅在需要时改。**
- [ ] 1.2 确认 `GET /api/admin/plugin-releases/review-pending` 返回 `{items:[{package, release, fileManifest}]}` 字段满足前端展示（包名/manifestId/版本/团队/时间/AI 状态/来源）。

> Review Gate 0：后端返回结构确认，前端可直接消费。

## Step 2 — 前端 API 封装

- [ ] 2.1 `governance/api.ts` 新增：
  ```ts
  export function loadPendingReleases(
    signal: AbortSignal
  ): Promise<{ items: PendingReleaseItem[] }>;
  ```
  调 `GET /api/admin/plugin-releases/review-pending`。
- [ ] 2.2 补 `PendingReleaseItem` 类型（package + release + fileManifest，复用既有 `PluginPackageSummary`/`PluginReleaseCore`）。

## Step 3 — 前端待审核直列页

- [ ] 3.1 新建 `apps/collab-admin/src/components/governance/pending-releases-tab.tsx`：
  - `useAsyncResource(loadPendingReleases)` 拉数据
  - 表格列：插件包（name + manifestId）、版本、所属团队、提交时间、AI 政策状态、来源
  - 空态：「暂无待审核发行版」
  - 行点击 → 打开 `plugin-package-sheet` 并透传 `initialReleaseId`（P2 决定是否需小改抽屉）
- [ ] 3.2 抽屉内 approve/reject 成功后，触发直列页资源刷新（复用既有刷新回调 / `notifyPluginsChanged` 类机制）。

## Step 4 — 容器与导航

- [ ] 4.1 `governance-view.tsx` 注册 `PendingReleasesTab`，置为默认 tab 或紧随其后的主 tab。
- [ ] 4.2 Dashboard「待审核插件发行版」卡片（`dashboard.tsx:68`）加跳转：点击 → governance-view 的待审核 tab（带 `?tab=pending` 或等价路由）。
- [ ] 4.3 主导航：移除 legacy「插件审核」主入口（P3 定位点）。

## Step 5 — legacy 审核页降级

- [ ] 5.1 legacy 审核页组件顶部加横幅：「此页仅展示历史 legacy 插件数据，新提交请到『待审核发行版』」+ 跳转按钮。
- [ ] 5.2 路由保留，不删（退役在 phase2）。

## Step 6 — 验证

- [ ] 6.1 真实样本：detail-poster 0.2.4（当前 PENDING）在直列页可见。
- [ ] 6.2 approve 后该条消失，DB `marketReviewStatus=APPROVED`。
- [ ] 6.3 Dashboard 计数 == 直列页条数；点卡片跳到直列页。
- [ ] 6.4 非审核员 → 403；空态正常。
- [ ] 6.5 legacy 页访问显示降级横幅。
- [ ] 6.6 `pnpm -C apps/collab-admin lint && typecheck`（或项目既有检查命令）通过。

## 回滚点

- 全部为前端新增 + 少量导航调整，无数据迁移、无 schema 变更。
- 回滚：`git revert` 该提交；legacy 审核页恢复主导航入口。

## 遗留待办（不在本阶段）

- 直列页分页/筛选（量大时再做）。
- legacy `Plugin` 完全退役（phase2）。
