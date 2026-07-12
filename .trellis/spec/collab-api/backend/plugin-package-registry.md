# Plugin Package Registry v4

## Scenario: Immutable Plugin Artifacts

### 1. Scope / Trigger

- 修改插件发布、团队库、市场、审核、购买、下载或制品清理时适用。
- 远端只拥有 package/release/catalog/entitlement，不拥有设备安装状态。

### 2. Signatures

- `POST /api/plugin-registry/releases`：raw `.lfplugin` v4 stream。
- `GET /api/plugin-registry/team|marketplace`：远端目录。
- `GET /api/plugin-packages/:id`：包与不可变版本历史。
- `GET /api/plugin-releases/:id/artifact`：鉴权下载或 S3 redirect。
- `POST /api/plugin-releases/:id/submit-marketplace`：按 release 提审。
- `POST /api/plugin-packages/:id/runtime-access|purchase`：团队授权检查/购买。
- DB unique：`PluginPackage(ownerTeamId, manifestId)`、`PluginRelease(packageId, version)`、`PluginEntitlement(teamId, packageId)`。

### 3. Contracts

- 上传格式固定为 ZIP：`_meta.json` 的 `formatVersion=4`、`manifest.json` 和源文件。
- 服务端流式落临时文件并计算最终 ZIP SHA-256；数据库只保存 manifest、文件清单、artifactKey、SHA 和大小。
- `PLUGIN_ARTIFACT_DRIVER=filesystem|s3`；filesystem 默认，S3 使用 endpoint/region/bucket/credentials/path-style 配置。
- 团队版本允许 prerelease；市场版本必须是正式严格 SemVer。团队目录最新版按 SemVer precedence 选取，不按创建时间。
- 市场审核更新 listing 的 `currentReleaseId`；新版本不会继承旧版本审核结果。
- 包详情对 owner team 返回全部 release；市场消费者（含已购 entitlement）只能看到并下载 `marketReviewStatus=APPROVED` 的具体 release。制品下载必须在 package 访问校验后再次校验 release 审核状态，delist 不影响已购团队下载历史 approved release。
- ZIP 校验必须把每个条目按边界流式消费到 EOF，并核对实际解压大小和 CRC-32；不能只读取 `_meta.json`/`manifest.json` 后信任其他条目的中央目录声明。

### 4. Validation & Error Matrix

- ZIP 超过 300MiB、解压总量超过 300MiB、文件超过 1500、单文件超过 60MiB -> `bad_request`。
- 重复/绝对/父级路径、符号链接、加密条目、ZIP64、非法压缩、缺少 v4 metadata/entry -> `bad_request`。
- 反斜杠路径，或任意深度出现 `data/.git/.venv/venv/node_modules/.lingfang/__pycache__` 段 -> `bad_request`。
- 实际解压超过声明大小、未到声明大小即 EOF、CRC 不符或 deflate 流损坏 -> `bad_request`，不得创建 release 或永久制品。
- 同 package+version -> `conflict`，不可覆盖。
- 团队成员/grant 拒绝 -> `forbidden`；付费市场无 entitlement -> `payment_required`。
- prerelease 提交市场 -> `bad_request`；非 PENDING release 审核 -> `conflict`。

### 5. Good/Base/Bad Cases

- Good：发布 `1.2.0` 后再发布 `1.1.9`，团队目录仍返回 `1.2.0`。
- Base：免费市场插件无需 entitlement 即可下载；付费插件购买后生成团队 entitlement。
- Bad：更新一行 `Plugin` 覆盖当前版本，或让市场目录返回设备安装状态。

### 6. Tests Required

- ZIP 路径/数量/大小/bomb/manifest/SHA 验证；覆盖伪造解压大小、错误 CRC、反斜杠和嵌套缓存段；filesystem 与 S3 adapter。
- SemVer 排序、重复版本、团队 grant、购买事务、逐版本 approve/reject/delist。
- package detail 与 artifact download 都要回归未审核 release 不可被 marketplace entitlement 绕过；owner team 仍可查看全部 release。
- legacy migration dry-run/apply 重跑不重复 review/audit，并能补齐已存在 release 的 entitlement/grant。

### 7. Wrong vs Correct

Wrong：按 `createdAt` 当作最新版，并覆盖旧制品。

Correct：创建不可变 `PluginRelease`，catalog 按 SemVer 或审核通过的 `currentReleaseId` 投影。

## Scenario: Release Provenance And Lifecycle Governance

### 1. Scope / Trigger

- 修改 v4 release 上传、作者状态操作、市场审核、listing 下架/恢复或管理端投影时适用。
- 远端发布来源与本机安装来源是两个独立维度，不能用 `builtin/local/marketplace` 替代 release provenance。

### 2. Signatures

- `POST /api/plugin-registry/releases`：raw `.lfplugin` stream；来源头为 `x-plugin-source-kind`、`x-plugin-source-label-b64`，`x-client: desktop` 由服务端派生 `ingestChannel=DESKTOP`，其余 HTTP 请求为 `API`。
- `PATCH /api/plugin-packages/:id/status`：`ACTIVE <-> ARCHIVED`。
- `PATCH /api/plugin-releases/:id/status`：`PUBLISHED <-> YANKED`。
- `POST /api/plugin-releases/:id/submit-marketplace` / `withdraw-marketplace`：审核 `DRAFT|REJECTED <-> PENDING`。
- `PATCH /api/plugin-packages/:id/marketplace-status`：作者 listing `ACTIVE <-> DELISTED(OWNER)`；平台同名 route 使用 `PLATFORM`。
- `PluginRelease(sourceKind, sourceLabel, ingestChannel)`；`MarketplaceListing(delistedBy, delistReason, delistedAt, delistedByUserId)`。

### 3. Contracts

- `sourceKind` 取 `LINGFANG_CREATOR | EXTERNAL_TOOL | LOCAL_ARTIFACT | COPIED_INSTALLATION | API | LEGACY_MIGRATION | UNKNOWN`；`sourceLabel` 为 trim 后最多 80 个字符，不接收路径、token 或环境变量。
- `ingestChannel` 由服务端决定，绝不信任客户端直接传入的 channel；legacy migration 固定 `LEGACY_MIGRATION/MIGRATION`。
- 每个状态动作在事务内用 `updateMany` 匹配 expected state；只有抢占成功者写 review/audit。
- approve 从同包 `PUBLISHED + APPROVED` 发行版按严格 SemVer 选最高版本。listing 被 `OWNER` 或 `PLATFORM` 下架时，后续 approve 只更新 `currentReleaseId`，不自动清除下架状态；恢复必须由对应 actor 显式执行。
- `isMarketplaceCurrent` 只有 listing `ACTIVE` 且 `currentReleaseId === release.id` 时为 true；下架 listing 仍保留 release 指针供恢复校验。
- package archive、release yank、listing relist、approve 与 publish 的跨行检查使用 Serializable transaction；重试耗尽映射为 409，不泄漏 Prisma P2034/P2002。
- MySQL 不支持 primitive scalar list；schema renderer 将 `String[] @default([])` 渲染为 `Json @default("[]")`，relation list 不转换，PostgreSQL canonical schema 保持不变。

### 4. Validation & Error Matrix

- 非法来源枚举/base64url/UTF-8/控制字符/超过 80 字符 -> `400 bad_request`。
- 归档 package 发布、待审核 package 归档、yanked release 提审或未审核 release 下载 -> `409 conflict`。
- 同一 expected state 的并发 approve/reject/withdraw/yank 只有一方成功，另一方 -> `409 conflict`。
- owner 不能恢复 `DELISTED(PLATFORM)`；平台不能用 owner relist；current release 不满足 `PUBLISHED + APPROVED` -> `409 conflict`。
- market catalog 不返回 `ARCHIVED` package、`YANKED` release 或非 `ACTIVE` listing。

### 5. Good/Base/Bad Cases

- Good：外部工具发布 `EXTERNAL_TOOL/Cursor/DESKTOP`，团队目录和版本历史都返回同一 provenance；市场提审失败只重试提审，不重复上传。
- Base：平台暂停 listing 后新版本通过审核，listing 仍为 `DELISTED(PLATFORM)`，管理员显式 relist 后才重新可见。
- Bad：用 `createdAt` 选最新版、approve 自动清掉 owner 下架、或让 delisted projection 清空 `currentReleaseId`，都会破坏 SemVer/current 与恢复不变量。

### 6. Tests Required

- 上传集成/单元：断言 source 字段同时落入 `PluginRelease`、响应和 audit metadata，失败时无永久 artifact。
- 状态矩阵：package/release/review/listing 合法与非法前置状态、owner/platform 隔离、platform suspension persistence。
- 并发回归：approve/reject、submit/yank、archive/submit、approve/yank 只允许一方写终态且不产生 `YANKED+PENDING` 或 `ACTIVE+ARCHIVED`。
- SemVer 回归：旧版本晚 approve 不降级 current；下架 listing 保留 current pointer 但 `isMarketplaceCurrent=false`。
- provider 渲染：PostgreSQL 原样、MySQL scalar list 转 JSON、relation list 保持不变。

### 7. Wrong vs Correct

Wrong：先 `findUnique` 检查 listing current，再在另一个事务中按 package 下架；并发 approve 可能把新 current 误下架。

Correct：在同一 Serializable transaction 的 `updateMany` 中匹配 `status='ACTIVE'` 与 `currentReleaseId=expectedReleaseId`，count 非 1 直接返回 409，并保留 delist metadata。

## Scenario: Admin Package Governance Projection

### 1. Scope / Trigger

- 修改 `/api/admin/plugin-packages`、admin release 延迟详情、来源筛选、平台审核、精确下架或恢复时适用。
- 管理端必须治理 v4 registry，不能回退到旧 `Plugin` 宽列表或 `Plugin.reviewStatus`。

### 2. Signatures

```text
GET  /api/admin/plugin-packages?page&pageSize&search&status&reviewStatus&sourceKind
GET  /api/admin/plugin-packages/:id
GET  /api/admin/plugin-packages/:id/releases?page&pageSize
GET  /api/admin/plugin-releases/:id
GET  /api/admin/plugin-releases/:id/manifest
GET  /api/admin/plugin-releases/:id/files?page&pageSize
GET  /api/admin/plugin-releases/:id/reviews?page&pageSize
POST /api/admin/plugin-releases/:id/delist { reason: string }
POST /api/admin/plugin-packages/:id/relist { reason?: string }
```

### 3. Contracts

- package page 的 release 二次查询只 select id/packageId/version/status/review/source/channel/createdAt，不读取 manifest、fileManifest、artifactKey 或 reviews。
- `latestRelease` 使用严格 SemVer 最高版本；`marketplaceCurrentVersion` 通过 `listing.currentReleaseId` 查找，listing 下架时仍可返回下架前版本。
- `sourceKind` 与 `reviewStatus` 合并到同一个 `releases.some`，表示至少一个 release 同时满足全部 release 级筛选。
- release list 与 core 都返回 `sourceKind/sourceLabel/ingestChannel`；`isMarketplaceCurrent` 仅在 listing ACTIVE 且 currentReleaseId 精确等于 release id 时为 true。
- core/manifest/files/reviews 允许 `platform.plugin.list_all OR platform.plugin.review`；artifact 下载仅允许 `platform.plugin.review`。
- 平台下架通过 release endpoint 传入 expected current release id，并在 Serializable transaction 的 `updateMany` 中 CAS；package endpoint 只用于恢复 `DELISTED(PLATFORM)`。
- 下架原因在 DTO 和 service 两层 trim 并校验 1..500 字；审计保存 actor、reason 和状态动作。

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| 非法 `sourceKind` | 400 DTO validation |
| package/release 不存在 | 404 `not_found` |
| 下架原因空白或超过 500 字 | 400 `bad_request`，不读取或修改 registry |
| listing 非 ACTIVE 或 currentReleaseId 不匹配 | 409 `conflict` |
| relist 目标不是 `DELISTED(PLATFORM)` | 409 `conflict` |
| current release 非 `PUBLISHED + APPROVED` | 409 `conflict` |
| 并发审核/下架抢占失败 | 409，只有成功方写 review/audit |

### 5. Good/Base/Bad Cases

- Good：包有 `1.10.0` latest 与 `1.9.0` current，列表同时投影两个版本；管理员只能用 `1.9.0` release id 下架。
- Base：PLATFORM 下架保留 current pointer 和 metadata；恢复前重新验证 package/release 不变量。
- Bad：用 latest release id 代替 listing pointer，或先读 current 后按 package 无条件 update，会在并发 approve 后下架错误版本。

### 6. Tests Required

- contract：package page 拒绝重字段，要求来源三字段与 `marketplaceCurrentVersion`，严格 SemVer 校验。
- backend unit：轻量 select、来源筛选、SemVer latest/current 分离、DELISTED pointer、权限 metadata、必填原因。
- backend concurrency：approve/reject 和 exact-current delist 使用 CAS，只允许一个终态成功。
- admin Playwright：首屏/详情/Tab 请求边界、exact endpoint、PLATFORM-only relist、409 局部刷新。
- `pnpm -C packages/contract test`、60 秒硬超时 `pnpm -C apps/collab-api test`、两包 typecheck/build。

### 7. Wrong vs Correct

Wrong：

```ts
const current = highestSemVer(releases);
await prisma.marketplaceListing.update({
  where: { packageId },
  data: { status: 'DELISTED' },
});
```

Correct：

```ts
const claimed = await tx.marketplaceListing.updateMany({
  where: { packageId, status: 'ACTIVE', currentReleaseId: expectedReleaseId },
  data: { status: 'DELISTED', delistedBy: 'PLATFORM', delistReason: reason },
});
if (claimed.count !== 1) throw conflict('只有市场当前发行版可以触发下架');
```
