# Quality

## Tauri Commands

Commands exposed to the frontend are registered in `tauri::generate_handler!`:

- `list_plugins`
- `read_plugin_file`
- `invoke_capability`

Return `Result<_, String>` for user-facing command failures. Keep detailed validation inside helper modules rather than in the command body.

Reference file:
- `apps/desktop/src-tauri/src/main.rs`

## State

Tauri `AppState` contains:

- `Arc<CapabilityRegistry>`
- loaded builtin plugin list

Do not add server-like tenant state or LLM credentials to the Tauri state. Tenant and LLM data belong to `apps/server`.

## Build Config

`tauri.conf.json` enables `withGlobalTauri` because the web frontend calls `window.__TAURI__.core.invoke` through `tauriInvoke()`.

When changing CSP or resource bundling, verify that:
- desktop can still load `app.config.json` and `gateway.config.json`
- builtin plugins are bundled under `builtin-plugins`
- iframe plugin runtime still works

