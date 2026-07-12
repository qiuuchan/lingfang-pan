# Design: Plugin Governance Source And Status

## API Projection

新增/复用 package-level admin routes：

```text
GET  /api/admin/plugin-packages
GET  /api/admin/plugin-packages/:id
GET  /api/admin/plugin-packages/:id/releases
GET  /api/admin/plugin-releases/:id
GET  /api/admin/plugin-releases/:id/manifest
GET  /api/admin/plugin-releases/:id/files
GET  /api/admin/plugin-releases/:id/reviews
POST /api/admin/plugin-releases/:id/approve
POST /api/admin/plugin-releases/:id/reject
POST /api/admin/plugin-packages/:id/delist
POST /api/admin/plugin-packages/:id/relist
```

列表只 select 轻量字段。当前页 package IDs 再批量查询 release id/version/status/source/review status，以内存分组计算 latest/pending/count；不读取 manifest、fileManifest 或 artifactKey。

## Frontend

保留当前 `plugins` view 入口，替换内部宽 release list 为 package governance view：

- toolbar：search/status/source filter + pagination。
- table：package/owner/latest source/version/package status/listing status/pending。
- DetailSheet：package overview + release selector。
- release tabs/sections：overview、manifest、files、reviews，首次打开才请求并按 ID 缓存。
- footer：依据 selected release/listing 状态显示 approve/reject/suspend/relist。

不创建 card 嵌 card；列表与详情使用现有 foundation 组件。

## State Display

来源文案使用固定 mapping，sourceLabel 作为补充：

- LINGFANG_CREATOR：灵枋创建器
- EXTERNAL_TOOL：外部开发工具
- LOCAL_ARTIFACT：本地插件包
- COPIED_INSTALLATION：从已安装插件复制
- API：API 上传
- LEGACY_MIGRATION：旧版迁移
- UNKNOWN：历史来源未知

Package、Release、Review、Listing 状态分别显示，不合并为一个模糊 badge。

## Request Safety

- list/detail hooks 使用 AbortSignal 或 request id 忽略过期响应。
- action button 在 submitting 时锁定。
- reject/suspend reason 保留到成功或用户取消，失败不清空。
- 成功后优先更新当前 row/detail，再刷新当前页与 pending count。

## Metrics

Admin dashboard 查询改为 v4 registry：

- pendingPluginReviews = PluginRelease.marketReviewStatus=PENDING
- activePluginPackages = PluginPackage.governanceStatus=ACTIVE
- activeMarketplaceListings / delistedMarketplaceListings

若原响应字段名被现有 UI 使用，保持兼容字段名但改变数据来源，并补测试说明。

## Compatibility

旧 `/api/admin/plugin-releases` route 保留一版，但新 UI 不调用。后续 `07-12-admin-governance-center` 可把本 view 移入统一 GovernanceView，而无需重写 API/hook。
