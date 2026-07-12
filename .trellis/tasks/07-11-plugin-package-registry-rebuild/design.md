# Design: 插件制品仓库与管理系统重构

## 1. Architecture

数据流统一为：`DraftWorkspace -> .lfplugin v4 -> PluginRelease -> Team/Marketplace catalog -> LocalInstallation -> Runner`。

- collab-api 拥有远端包、发行版、审核、权益和制品存储。
- Tauri Rust 拥有打包、下载、校验、安全解压、本机安装账本、工作区和运行路径解析。
- React 只消费结构化 catalog/installation/workspace API，不再拼接云端与文件系统快照。
- collab-admin 以 release 为审核对象，不读取整包正文。

## 2. Server Data Model

- `PluginPackage`: `id`, `ownerTeamId`, `authorUserId`, `manifestId`, `name`, `description`, `status`, timestamps；unique `(ownerTeamId, manifestId)`。
- `PluginRelease`: `id`, `packageId`, strict SemVer `version`, `manifest`, `artifactKey`, `sha256`, `sizeBytes`, `status=PUBLISHED|YANKED`, `marketReviewStatus=DRAFT|PENDING|APPROVED|REJECTED`, review fields, creator, timestamps；unique `(packageId, version)`。
- `MarketplaceListing`: unique `packageId`, `currentReleaseId`, `priceCents`, `status=DRAFT|ACTIVE|DELISTED`, aggregate counts.
- `PluginEntitlement`: unique `(teamId, packageId)`, kind `PURCHASED`, purchase reference and timestamps.
- `PluginReleaseReview`: append-only release review history.
- `PluginGrant` moves from legacy plugin id to package id. Legacy tables remain read-only for one release cycle.

Approval updates the listing's `currentReleaseId` transactionally. Yanking/delisting never deletes releases or entitlements.

## 3. Artifact Contract

`.lfplugin` v4 is deterministic ZIP with sorted paths and fixed entry timestamps:

```text
_meta.json       {"format":"lingfang-plugin","formatVersion":4}
manifest.json    existing runtime/capability manifest
<source files>   text or binary bytes
```

Exclude `data`, `.git`, `.venv`, `venv`, `node_modules`, caches and `.lingfang`. Limits: archive 300 MiB, uncompressed 300 MiB, 1500 files, 60 MiB per file. Reject absolute/empty/dot/parent paths, duplicate normalized paths, symlinks and entry mismatch. SHA-256 covers final ZIP bytes and is stored lowercase hex.

## 4. Artifact Storage

`ArtifactStore` exposes staging put, promote, open/download URL and delete-orphan operations.

- `filesystem` default: `${PLUGIN_ARTIFACT_DIR:-<cwd>/artifacts/plugins}/<package>/<version>/<sha>.lfplugin`.
- `s3`: configured by `PLUGIN_ARTIFACT_DRIVER=s3`, endpoint/region/bucket/access credentials/path-style env; uploads go through server validation, downloads use short-lived presigned GET.
- Server always spools an upload to a local temp file while hashing and validating before promotion.

## 5. HTTP Contract

- `POST /api/plugin-registry/releases`: raw `application/vnd.lingfang.plugin+zip`; optional package id header; server parses manifest and creates/matches package.
- `GET /api/plugin-registry/team|marketplace`: paged catalog summaries without local installation fields or package bytes.
- `GET /api/plugin-packages/:id`: package metadata and release history.
- `GET /api/plugin-releases/:id/artifact`: permission check, then filesystem stream or S3 redirect; metadata endpoints provide sha/size.
- `POST /api/plugin-releases/:id/submit-marketplace`: stable versions only.
- `POST /api/plugin-packages/:id/runtime-access`: team membership/grant check.
- Admin release list/detail/approve/reject/delist endpoints replace plugin-row review.

Team artifact access requires current team ownership and grant. Market access requires active free listing or team entitlement. Runtime access is online-only for team origin and local-only for purchased market origin.

## 6. Local Storage

Anchor metadata stays under app data; user-configured plugin root holds payloads:

```text
<anchor>/.lingfang/installations-v1.json
<anchor>/.lingfang/workspaces-v1.json
<plugins_root>/installed/<installationId>/releases/<releaseId>/package/
<plugins_root>/installed/<installationId>/data/
<plugins_root>/cache/<sha>.lfplugin
<plugins_root>/workspaces/<workspaceId>/
<runtime_root>/plugin-envs/<installationId>/<releaseId>/
```

`LocalInstallation` records IDs, origin, active/pending/previous release metadata, paths, hashes, prepared state and timestamps. Atomic tmp+rename writes are serialized by a mutex.

Install: metadata -> stream download -> size/SHA verify -> safe staging extraction -> manifest verify -> atomic directory promotion -> ledger update. Update writes pending. First run prepares uv/pnpm dependencies for pending and activates only after successful spawn; failure leaves active unchanged. Rollback swaps active/previous. Data is shared across releases.

Builtins are represented as protected local installations from bundled resources/index and returned by the same list API.

## 7. Draft Workspaces

`DraftWorkspace` metadata contains workspaceId, title, path, manifestId, version, runtime, conversationId, diagnostic status, lastPublishedReleaseId/version and timestamps. Files live outside installed payloads.

- Draft page is a standalone `draft-plugins` route in the left application navigation.
- Continue edit binds workspace+conversation and opens `develop-plugins`; closing returns to `draft-plugins`.
- Publishing packages the workspace but keeps it. A content digest plus last published version prevents unchanged/same-version republish.
- Import destination is determined by UI context, never artifact metadata.
- Delete removes workspace and linked local conversation only.

## 8. Migration And Cutover

- Additive DB migration plus idempotent CLI dry-run/apply job reconstructs v4 archives from current legacy JSON files and maps listings, purchases by buyerTeamId, grants and reviews.
- Legacy installation rows are not device truth. Old endpoints return `client_upgrade_required` after cutover; no new dual-write.
- Desktop uses a migration journal. `draft:true` directories move to workspaces; others become origin=local installations. Each rename is reversible until its ledger commit. Existing data is preserved.
- Unknown legacy remote ids stay usable as local packages.

## 9. Operational Safety

Audit publish, download, SHA failure, review, entitlement denial, migration and rollback. Cleanup temp/orphan artifacts by age and DB reference. Never remove a published artifact through normal package deletion.
