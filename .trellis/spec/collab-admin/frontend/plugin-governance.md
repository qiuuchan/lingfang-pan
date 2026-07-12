# collab-admin 插件治理规范

## Scenario: v4 Package And Release Governance

### 1. Scope / Trigger

- 修改治理中心插件 Tab、package 列表、release Sheet、来源展示、审核、平台下架/恢复或 Dashboard 插件入口时适用。
- 远端事实模型固定为 `PluginPackage -> PluginRelease -> MarketplaceListing`；旧 `Plugin.reviewStatus` 不得驱动本视图。

### 2. Signatures

```text
GET  /api/admin/plugin-packages?page&pageSize&search&status&reviewStatus&sourceKind
GET  /api/admin/plugin-packages/:id
GET  /api/admin/plugin-packages/:id/releases?page&pageSize
GET  /api/admin/plugin-releases/:id
GET  /api/admin/plugin-releases/:id/manifest
GET  /api/admin/plugin-releases/:id/files?page&pageSize
GET  /api/admin/plugin-releases/:id/reviews?page&pageSize
POST /api/admin/plugin-releases/:id/approve
POST /api/admin/plugin-releases/:id/reject
POST /api/admin/plugin-releases/:id/delist
POST /api/admin/plugin-packages/:id/relist
```

### 3. Contracts

- package 首屏只请求一页轻量摘要；不得包含 `manifest`、`fileManifest`、`artifactKey` 或 reviews。
- `latestRelease` 是同包严格 SemVer 最高版本；`marketplaceCurrentVersion` 按 listing 的 `currentReleaseId` 精确映射，两者可能不同。
- package row 分别展示 package、latest release、review、listing 和 current version，不合并成单一状态。
- release 来源固定展示 `sourceKind/sourceLabel/ingestChannel`，文案必须称为“发布来源”，不能暗示代码签名或可信认证。
- Sheet 打开后才请求 package detail 和 release page；选择 release 后才请求 core；Manifest、Files、Reviews 只在首次激活对应 Tab 时请求。
- Sheet 会话缓存 key 为 `core:<id>`、`manifest:<id>`、`files:<id>:<page>`、`reviews:<id>:<page>`；关闭或 package id 变化时清空。
- 只有 `core.isMarketplaceCurrent=true` 显示平台下架；只有 `listing.status=DELISTED && delistedBy=PLATFORM` 显示平台恢复。
- 409 后刷新 package detail、release page、selected core、package list；当前在 Reviews 时刷新 reviews，不失效不可变 manifest/files。
- 宽表格只能在自身容器横向滚动；页面、Sheet 和确认 Dialog 在 390px 视口不得产生 document 级横向溢出。

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| 来源筛选变化 | page 重置为 1，并发送 `sourceKind` 服务端筛选 |
| release 非市场精确 current | 不显示“平台下架当前版” |
| listing 为 `DELISTED(OWNER)` | 不显示平台恢复 |
| 下架/驳回/恢复原因空白或超过 500 字 | 确认按钮禁用，禁止提交 |
| mutation 返回 409 | 保留确认 Dialog 和原因，局部刷新可变资源并显示错误 |
| Manifest/Files 已缓存后 mutation | 请求计数不增加 |
| 任一异步资源失败 | 显示错误与重试，不渲染成空数据 |

### 5. Good/Base/Bad Cases

- Good：`1.10.0` 是 latest，但 listing current 仍是 `1.9.0`；列表同时显示两者，只有选择 `1.9.0` 时能下架。
- Base：平台暂停后 current pointer 保留；详情显示下架方、原因、时间、操作者，管理员显式恢复。
- Bad：按 package id 调下架、用“最高版本”推断 current，或 409 后清空全部缓存，会误伤并发新版本并重复拉取大字段。

### 6. Tests Required

- Playwright 记录请求：治理首屏只有 package page；打开 Sheet 后才有 package/releases/core；各子 Tab 首次打开才请求。
- Playwright 断言 exact release delist endpoint、PLATFORM-only relist、409 局部刷新和 manifest/files 请求数不变。
- Playwright 在 `1440x900` 与 `390x844` 断言 document 无横向溢出，并检查 Sheet 与确认 Dialog 稳定态截图。
- `pnpm -C apps/collab-admin typecheck`、`pnpm -C apps/collab-admin build`、`pnpm -C apps/collab-admin test:e2e`。

### 7. Wrong vs Correct

Wrong：

```tsx
const canDelist = release.marketReviewStatus === 'APPROVED';
await api(`/api/admin/plugin-packages/${packageId}/delist`, { method: 'POST' });
```

Correct：

```tsx
const canDelist = core.isMarketplaceCurrent;
await api(`/api/admin/plugin-releases/${releaseId}/delist`, {
  method: 'POST',
  body: { reason },
});
```
