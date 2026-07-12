# Plugin System Audit

## Existing Strengths

- `POST /api/plugin-registry/releases` already accepts raw `.lfplugin v4`, streams to staging, hashes, validates and promotes immutable artifacts.
- Team and marketplace catalogs already share `PluginPackage` / `PluginRelease`; marketplace approval only projects one current release.
- Tauri already owns verified packaging, installation, rollback and draft workspaces.
- The desktop creator already reads local files/folders and can turn them into a staged draft.

## Product Gaps

- Local artifact import only creates an installation; cloud publishing only accepts a draft workspace.
- Desktop publishing always targets the team. The existing marketplace submission API has no desktop wrapper or UI.
- Package/release/listing state enums exist without complete author lifecycle endpoints.
- Cloud release records have no provenance; local installation origin is being used as a weaker, different concept.
- Admin review lists releases broadly and cannot identify the exact marketplace current release.

## Correctness Gaps

- approve/reject read PENDING outside the transaction and then update unconditionally, so concurrent terminal actions may both succeed.
- approve assigns the reviewed release directly to `currentReleaseId`, allowing an older version approved later to downgrade the market.
- release-based delist does not require that release to be the listing current release.
- local folder import marks binary files as base64, but workspace persistence discards the binary flag and writes base64 text.
- workspace reload uses UTF-8-only reads and substitutes binary placeholders, so later saves can overwrite original assets.
- local folder import allows only 300 files and drops `dist/build`, while v4 allows 1500 files and real plugins may run from those directories.

## Evidence Paths

- `packages/contract/src/plugin-registry.ts`
- `apps/collab-api/prisma/schema.prisma`
- `apps/collab-api/src/modules/plugin-registry.controller.ts`
- `apps/collab-api/src/modules/plugin-registry.service.ts`
- `apps/collab-api/src/modules/plugin-artifact.ts`
- `apps/desktop/src/lib/plugin-registry.ts`
- `apps/desktop/src/lib/plugin-creator/import-local.ts`
- `apps/desktop/src/pages/DraftPlugins.tsx`
- `apps/desktop/src/pages/plugins/PluginCenterBody.tsx`
- `apps/desktop/src-tauri/src/plugin_package_manager/network.rs`
- `apps/desktop/src-tauri/src/plugin_store.rs`
- `apps/collab-admin/src/components/plugins/registry-release-review.tsx`

## Existing Task Boundaries

- `07-12-admin-governance-center` correctly plans package-level pagination, on-demand details, concurrent review protection and exact current release projection.
- Its parent explicitly excludes desktop import/install and artifact format changes, so the new cross-layer parent task is required.
- Current collab-admin uncommitted changes are shared UI foundation only; plugin governance business files are still unchanged.
