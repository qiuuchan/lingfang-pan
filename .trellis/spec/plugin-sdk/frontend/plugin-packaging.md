# Plugin Packaging (.lfplugin v4)

## MUST use the SDK build CLI

Produce `.lfplugin` artifacts **only** with the `@lingfang/plugin-sdk` build command — never hand-roll a zip with Python `zipfile`, `zip`, `Compress-Archive`, etc.

```bash
pnpm -C packages/plugin-sdk exec tsx src/cli/index.ts build <plugin-dir> --out <out.lfplugin>
```

- The `-C packages/plugin-sdk` changes cwd, so pass **absolute paths** for both `<plugin-dir>` and `--out`.
- `<plugin-dir>` must contain `manifest.json` + the `manifest.entry` file.

## Why hand-rolled zips are rejected

The desktop shell inspects every `.lfplugin` with `plugin_artifact_v4.rs::inspect_artifact`. It requires a root-level `_meta.json`:

```json
{"format":"lingfang-plugin","formatVersion":4}
```

Hand-rolled zips omit this file → the artifact is rejected as a v4 package. The build CLI writes it automatically (`archive.ts::META_JSON_CONTENT`).

The CLI also guarantees the rest of the v4 invariants that hand-rolling gets wrong:
- `manifest.json` pretty-printed (2-space), source files in dictionary order
- Fixed `date = new Date(0)`, unix `0o644`, Deflate level 6, `platform: UNIX`, `createFolders: false` (no directory entries — the inspector rejects them)
- Excludes `data`, `.git`, `.venv`, `node_modules`, `.lingfang`, `__pycache__`, `*.pyc`, `*.pyo`, and re-creates `_meta.json` / `manifest.json` itself
- Enforces size limits (300 MiB archive / uncompressed, 60 MiB per file, 1500 files)
- Computes the `sha256[..16]` release id the same way the desktop shell does

## Build flow

`build.ts::buildCommand`:
1. Read + JSON-parse `manifest.json`
2. `validateManifest` (schema check)
3. Verify `manifest.entry` exists
4. `packWorkspace({ workspaceDir, manifest })` → ZIP buffer + sha256 prefix + suggested filename `<id>-<version>.lfplugin`
5. Write to `--out` (or `<id>-<version>.lfplugin` in cwd)

A successful build reports `文件：N 个` where N = source files + 2 (`_meta.json` + `manifest.json`). If you see `N = source files` only, `_meta.json` is missing.

## Reference files

- `packages/plugin-sdk/src/cli/util/archive.ts` — `packWorkspace`, `META_JSON_CONTENT`, exclusion rules (authoritative producer)
- `packages/plugin-sdk/src/cli/commands/build.ts` — `buildCommand` entry
- `apps/desktop/src-tauri/src/plugin_artifact_v4.rs` — `inspect_artifact` (authoritative consumer; the producer mirrors its rules)
- `.trellis/tasks/07-13-plugin-dev-sdk/research/lfplugin-format.md` — format research (original source of truth)
