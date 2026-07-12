# Design: 统一治理中心

## Contract

在 `packages/contract/src/plugin-registry.ts` 增加：

- admin package list item/page。
- package detail 与 release lightweight summary/page。
- release core detail、manifest、file page、review page。
- listing/current release 投影。

新增 `admin-governance.ts`：

- pagination metadata。
- application summary/detail/page。
- reject/delist reason schema，长度 1..500。

保持现有 plugin registry camelCase。

## API

```text
GET  /api/admin/plugin-packages
GET  /api/admin/plugin-packages/:packageId
GET  /api/admin/plugin-packages/:packageId/releases
GET  /api/admin/plugin-releases/:releaseId
GET  /api/admin/plugin-releases/:releaseId/manifest
GET  /api/admin/plugin-releases/:releaseId/files
GET  /api/admin/plugin-releases/:releaseId/reviews
POST /api/admin/plugin-releases/:releaseId/approve
POST /api/admin/plugin-releases/:releaseId/reject
POST /api/admin/plugin-packages/:packageId/delist

GET  /api/admin/team-admin-applications
GET  /api/admin/team-admin-applications/:id
POST /api/admin/team-admin-applications/:id/approve
POST /api/admin/team-admin-applications/:id/reject
```

旧 `/admin/plugin-releases`、`review-pending` 和 release-based delist 保留一版兼容，新 UI 不调用。

## Package Query

1. 按 package where/count/skip/take 查询一页包和 listing/owner 摘要。
2. 对当前页 package IDs 一次查询轻量 release 字段。
3. 在内存按 package 分组，用 `compareStrictSemVer()` 选最新版本并统计 pending/release count。
4. 不读取 manifest、fileManifest、artifactKey 或 reviews。

如果过滤 `reviewStatus`，package where 使用 releases relation `some`；返回的 pending count 仍基于该包全部发行版。

## Release Detail

- core detail: sha、size、platform、status、review status/reason、isMarketplaceCurrent。
- manifest 单独返回。
- files 从现有 `fileManifest` JSON 排序后服务端切片分页。
- reviews 使用数据库 skip/take/count，并返回 reviewer 白名单摘要。

## Transactions

- approve/reject 先在事务内 `updateMany(id + PENDING)` 抢占。
- 抢占成功后才写 review/audit。
- approve 后读取同包 APPROVED + PUBLISHED 轻量版本，按 SemVer 选最大并更新 listing。
- delist 条件更新 ACTIVE package listing；保留 currentReleaseId 数据但响应不投影为当前上架版。
- application approve/reject 用 `status=PENDING` 条件抢占；建团、系统角色、membership 和 audit 同事务。
- 通知在事务提交后发送。

## Frontend

- 新 `View='governance'` 和 `GovernanceView`。
- Tabs: plugin packages / applications；仅挂载当前 Tab。
- 插件包行可点击并打开 `DetailSheet size='xl'`。
- Sheet 使用版本选择器，一次只显示一个发行版详情；Manifest/文件/审核记录按 Tab 加载并按 releaseId 缓存，缓存随 Sheet 会话结束或 packageId 变化清空。
- 应用申请使用独立 DetailSheet，但复用 AsyncResource、状态 badge、action footer。
- 成功动作刷新当前 row/detail 和相关计数；只失效可变的 core/reviews，保留不可变 manifest/files，且 mutation reload 不清当前发行版 selection。

## Rollout

Contract -> API/tests -> admin UI -> 删除旧 UI 调用。无破坏性 DB 迁移。
