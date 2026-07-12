# Design: Registry Provenance And Lifecycle

## Contract And Schema

`plugin-registry.ts` 增加：

- `PluginReleaseSourceKind`
- `PluginIngestChannel`
- `MarketplaceDelistActor`
- `PluginManagementItem`
- `PluginPackageDetail`
- 状态更新与 listing 投影 schema

`PluginReleaseSummary` 新增三个必返字段。`DraftWorkspace` 同时增加来源字段，但 Rust 侧落地由后续 desktop 子任务完成。

Prisma additive changes：

```text
PluginRelease.sourceKind
PluginRelease.sourceLabel
PluginRelease.ingestChannel
MarketplaceListing.delistedBy
MarketplaceListing.delistReason
MarketplaceListing.delistedAt
MarketplaceListing.delistedByUserId
```

不增加通用 revision；有限状态转换用 expected-state `updateMany` 作为乐观并发门。

## Upload Metadata

Controller 读取：

- `x-plugin-source-kind`
- `x-plugin-source-label-b64`
- `x-client`

service 对来源 enum、base64url、UTF-8 和 80 字长度再次验证。接入通道不接受客户端自报：controller 仅将 `X-Client: desktop` 派生为 `DESKTOP`，其他 HTTP 请求统一记录为 `API`。缺失来源时按旧客户端兼容记录 `UNKNOWN/API`；migration 直接写 `LEGACY_MIGRATION/MIGRATION`。

## Ownership Helper

新增 service 内聚 helper 读取 current membership/package，并按动作校验：

- 作者始终可管理自己 package 的版本。
- TEAM_ADMIN 兼容保留。
- 自定义角色通过 `AuthService.ensurePermission(userId, code)` 获得相应能力。

Controller decorator 提供第一层静态权限，service helper 负责作者/目标 package 的对象级授权。

## Management Query

`GET /api/plugin-registry/manage` 返回 package 级轻量项：

- package summary
- latest release summary（允许 YANKED）
- releaseCount / pendingReviewCount
- listing status/currentReleaseId/delist metadata/price

`GET /api/plugin-packages/:id` 对 owner team 返回完整 release summaries 与 listing metadata，但仍不返回 artifact body。

## State Operations

- `PATCH /api/plugin-packages/:id/status`
- `PATCH /api/plugin-releases/:id/status`
- `POST /api/plugin-releases/:id/withdraw-marketplace`
- `PATCH /api/plugin-packages/:id/marketplace-status`
- `POST /api/admin/plugin-packages/:id/relist`
- 现有 admin delist route 保留兼容，但必须校验 current release。

每个操作在一个 transaction 中更新实体、必要的关联 listing/review，并写 AuditLog。恢复 listing 统一调用 invariant helper。

## Review Concurrency

approve/reject transaction 首先执行：

```ts
updateMany({ where: { id: releaseId, marketReviewStatus: 'PENDING', status: 'PUBLISHED' }, data: ... })
```

count=0 立即抛 409，之后才写 review/audit。approve 再查询该 package 的 `APPROVED + PUBLISHED` 轻量 releases，以 `compareStrictSemVer()` 选最大并更新 listing。

## Artifact Review Access

平台审核下载使用独立 admin route，不经过 owner/entitlement 逻辑。它只允许 `platform.plugin.review`，下载前确认 release 存在，写 `admin.plugin_release.artifact_downloaded` 审计，再复用 ArtifactStore。

## Validation

`plugin-artifact.ts` 在解压 metadata 前限制 `_meta.json`/`manifest.json <= 256 KiB`，并验证：

- manifest id/name/description/entry 长度
- runtime/visibility enums
- capabilities 数量和结构/白名单
- entry 是 artifact 内真实文件

保持当前 ZIP CRC、目录、大小和文件数防护。

## Migration

新增 timestamped migration。PostgreSQL canonical schema 为源；项目现有 provider renderer 继续生成 MySQL schema。migration 后运行 `prisma:generate`，不部署到用户数据库。
