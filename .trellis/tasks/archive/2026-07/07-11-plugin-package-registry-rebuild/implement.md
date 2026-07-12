# Implement: 插件制品仓库与管理系统重构

Execute in order; keep legacy behavior compiling until its replacement is wired.

## Step 1 - Contract And Schema

- Add shared package/release/catalog/entitlement/workspace schemas and strict SemVer validation.
- Add Prisma models/enums/indexes and additive migrations for PostgreSQL/MySQL generation.
- Add artifact storage configuration and filesystem/S3 adapters with contract tests.
- Validation: contract typecheck/test, Prisma schema tests, collab-api typecheck.

## Step 2 - Registry Backend

- Add streaming v4 upload parser, limits/path safety, SHA calculation and immutable release creation.
- Add team/market catalogs, package detail/history, artifact download, runtime access and team entitlement purchase flow.
- Convert market submit/review/delist to release semantics and update admin response contracts.
- Add legacy migration dry-run/apply command and `client_upgrade_required` old protocol response.
- Validation: focused registry/storage/auth/review/migration tests, collab-api full test/build with 60s timeout.

## Step 3 - Rust Artifact And Local Manager

- Add deterministic v4 pack/inspect/extract modules with ZIP safety and SHA helpers.
- Add atomic installation/workspace ledgers, directory layout, builtins, migration journal and Tauri commands.
- Add streamed publish/download progress, install/update/pending activation/rollback/uninstall flows.
- Route runner/store/capability paths by installationId and reuse RuntimeResolver for uv/pnpm dependency preparation.
- Validation: Rust unit tests for archive attacks, checksum failure, transactions, migration and runner activation; cargo test/build.

## Step 4 - Desktop UI

- Replace four plugin tabs with Installed, Team Library and Marketplace backed by separate hooks.
- Join catalog rows with the local ledger by packageId; catalogs never expose run actions before download.
- Add install/update/rollback/uninstall/progress states and protected builtin behavior.
- Add standalone Draft Management navigation/page and workspace-to-creator round trip; remove broken draft version UI and `manifest.draft` truth.
- Store pinned/recent installation IDs only and prune stale references.
- Validation: desktop focused tests, typecheck and Vite build.

## Step 5 - Admin UI And Migration Integration

- Rework plugin governance to package rows and release review detail with manifest/file list/sha/size.
- Add approve/reject/delist actions per release without loading file bodies.
- Wire operator migration docs/config and verify forced-upgrade response.
- Validation: collab-admin typecheck/build and backend/admin contract tests.

## Step 6 - End-To-End And Cleanup

- Run team publish/download, market submit/approve/purchase/download, manual update pending activation, failed-first-run fallback, rollback and destructive uninstall scenarios.
- Verify local directory migration, builtin registration and draft workspace migration.
- Remove dead frontend inlined-package paths and JSZip runtime dependency only after all new flows pass.
- Run all quality gates and Windows NSIS smoke build; inspect git diff for unrelated changes.

## Quality Gates

```bash
pnpm -C packages/contract typecheck
pnpm -C packages/contract test
pnpm -C apps/collab-api typecheck
timeout 60 pnpm -C apps/collab-api test
pnpm -C apps/collab-api build
cargo test -p lingfang-desktop
cargo build -p lingfang-desktop
pnpm -C apps/desktop test
pnpm -C apps/desktop typecheck
pnpm -C apps/desktop vite:build
pnpm -C apps/collab-admin typecheck
pnpm -C apps/collab-admin build
```

## Rollback Points

- Schema is additive; legacy rows stay untouched for one release cycle.
- Artifact promotion happens only after validation and DB failures leave removable orphans.
- Local install/migration uses staging+journal and commits ledger last.
- Update activation never replaces the old active release until first successful spawn.

## Implementation Status (2026-07-12)

Implemented contract/schema, v4 artifact storage and registry APIs, release-level review, entitlement/grants, migration CLI, Rust artifact/package manager, three-tab plugin center, standalone draft management, and admin release review.

Verified:

- contract typecheck + 16 tests
- collab-api typecheck/build, Prisma validate, and full Vitest suite: 41 files / 566 tests
- desktop typecheck, 255 tests, Vite production build
- collab-admin typecheck + production build
- `pnpm -r typecheck` and `pnpm -r test`
- `cargo test -p lingfang-desktop` with the normal Tauri resource configuration: 166 tests
- `cargo build -p lingfang-desktop`
- NSIS configuration/resource static smoke: five builtin manifests, Windows x64 Node/Python and pip/npm/pnpm entry points, and zero dataless resource files

Remaining environment gates:

- Formal Windows NSIS build/install smoke requires a Windows x64 build host. On macOS, `tauri build --bundles nsis --ci` only built the Darwin binary and produced no `target/release/bundle/nsis` artifact, so it is not counted as a pass.
- S3/MinIO adapter requires a dedicated bucket lifecycle rule for orphan expiry; application-side orphan scanning is implemented for the default filesystem store.

File-size exception: `plugin_package_manager.rs` is 1445 lines after extracting Tauri commands, network transfer, shared helpers, and tests. The remaining module is the single atomic ledger/installation/workspace transaction owner; splitting its mutually coupled rollback paths during this cutover would increase partial-commit risk. It remains below the mandatory 1500-line threshold and should be split by a dedicated state/transaction design if it grows again.
