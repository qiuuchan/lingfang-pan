# Plugin Loading

## Builtin Plugin Directory

`builtin_dir()` resolves the builtin plugin directory differently by environment:

- development: `CARGO_MANIFEST_DIR/../builtin-plugins`
- packaged app: Tauri resource directory `builtin-plugins`

Reference file:
- `apps/desktop/src-tauri/src/main.rs`

## Manifest Parsing

`plugins::load_builtin_plugins()` scans subdirectories and calls `parse_manifest()`. A builtin manifest must provide at least:

- `id`
- `name`
- `entry`

`version`, `description`, and `entry` have defaults. Capabilities are parsed from `capabilities[]`; `fs.*` path templates are expanded through `expand_path()`.
`runtime_type` is also exported on `LoadedPlugin` and defaults to `client`; script builtin plugins depend on this field so the frontend does not mistake `main.py` / `index.js` for iframe HTML.

Reference files:
- `apps/desktop/src-tauri/src/plugins.rs`
- `apps/desktop/builtin-plugins/file-explorer/manifest.json`
- `apps/desktop/builtin-plugins/system-info/manifest.json`

Do not silently register partially parsed capabilities. The current loader skips malformed capability entries and only registers successfully parsed plugin directories.

## Resource Reading

`read_plugin_file()` canonicalizes both plugin base dir and target file, then requires the target to stay under base. Keep that path traversal guard for every future file read command.
