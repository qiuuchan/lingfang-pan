# 技术设计 — 阶段0：后台审核统一到 v4

## 边界

本阶段以**前端（collab-admin）消费为主**，后端几乎不动。

| 改             | 文件                                                                         | 说明                                             |
| -------------- | ---------------------------------------------------------------------------- | ------------------------------------------------ |
| 前端 API       | `apps/collab-admin/src/components/governance/api.ts`                         | 新增 `loadPendingReleases()` 调 `review-pending` |
| 前端视图       | `apps/collab-admin/src/components/governance/pending-releases-tab.tsx`（新） | 待审核发行版直列页                               |
| 前端容器       | `apps/collab-admin/src/components/governance/governance-view.tsx`            | 注册新 tab，设为默认/主入口                      |
| 前端 dashboard | `apps/collab-admin/src/components/dashboard.tsx`                             | 「待审核插件发行版」卡片 onClick → 跳 v4 直列页  |
| 前端 legacy    | 主导航 + legacy 审核页组件                                                   | 移除主导航入口；legacy 页加跳转提示              |
| 后端（可选）   | `plugin-registry.service.ts:pendingReviews`                                  | 仅在需要分页时加 `take/skip` + count             |

**不动**：后端审核/批准逻辑、`Plugin` 表、桌面端、市场/购买。

## 数据流

```
平台审核员打开「待审核发行版」tab
   │
   ▼
loadPendingReleases() → GET /api/admin/plugin-releases/review-pending
   │ （platform.plugin.review 权限）
   ▼
pendingReviews() → prisma.pluginRelease.findMany({where:{marketReviewStatus:'PENDING'}, include:{package}})
   │
   ▼  返回 {items:[{package, release, fileManifest}]}
PendingReleasesTab 渲染表格：包名/manifestId/版本/团队/提交时间/AI政策状态/来源
   │
   ▼  点击某行
plugin-package-sheet 抽屉（既有）→ 定位到该 release → approvePluginRelease/rejectPluginRelease
   │
   ▼
列表刷新（该条 PENDING→APPROVED 后消失）
```

## 设计决策

### D1 新增独立 tab，而非塞进 PluginPackagesTab

`PluginPackagesTab` 是「按插件包管理」视角（包→多个 release）。待审核是「按 release」视角（跨包的 PENDING 队列）。混进去会让包列表被审核状态污染。单独 `pending-releases-tab` 更清晰，且能直接复用 `plugin-package-sheet` 抽屉做审批。

### D2 复用既有审批抽屉

`plugin-package-sheet.tsx` 已有 release 选择 + approve/reject/delist + 审核记录（`loadPluginReviews`）。直列页行点击 → 打开抽屉并预选该 release id，不重写审批 UI。

### D3 Dashboard 计数卡片可点击

`dashboard.tsx:68` 的「待审核插件发行版」卡片目前只展示数字。加 `onClick`/`to` 跳到 v4 直列页（路由参数 `?status=PENDING` 或直接到 tab）。这是用户从 dashboard 进入审核的自然路径。

### D4 legacy 审核页降级不删

- 主导航移除「插件审核（legacy）」入口。
- 路由 `/admin/plugins/review-pending` 保留，页面顶部加横幅：「此页仅展示历史 legacy 插件数据，新提交请到「待审核发行版」」，并提供跳转按钮。
- 不删 legacy 页/接口——legacy `Plugin` 存量数据与完全退役归 phase2，本阶段只切断「主入口误导」。

### D5 后端分页（条件性）

`pendingReviews` 当前无分页（`findMany` 全量）。PENDING 量通常不大，初版可不全量分页；但加 `take: 100` 兜底防巨量。若后续量大再补 `page/pageSize` + count。（implement 里列为可选步骤）

## 兼容性 / 回归

- governance-view 新增 tab 不影响既有 `PluginPackagesTab`/`ApplicationsTab`。
- Dashboard 卡片加 onClick 不破坏既有计数。
- legacy 页降级不影响 legacy 数据本身。
- 权限：新 tab 用既有 `platform.plugin.review`，无新权限码。

## 验证策略

1. 构造一个 v4 PENDING release（本次 detail-poster 0.2.4 就是现成样本）→ 直列页能看到。
2. approve → 列表刷新后消失；`PluginRelease.marketReviewStatus` 变 APPROVED（DB 验证）。
3. Dashboard 计数与直列页条数一致。
4. 非审核员访问直列页 → 403。
5. legacy 页访问 → 显示降级横幅。

## 风险

- **R1 dashboard 跳转路由**：需确认 governance-view 的路由参数/tab 切换机制（implement 时定位）。低风险。
- **R2 PENDING 巨量**：加 `take` 兜底，足够。低风险。
- **R3 既有 plugin-package-sheet 预选 release**：抽屉需支持 `initialReleaseId` 透传；若不支持需小改。implement 时确认。
