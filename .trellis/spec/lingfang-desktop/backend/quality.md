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

Do not add server-like tenant state or LLM credentials to the Tauri state. Tenant and LLM data belong to `apps/collab-api`.

## Build Config

`tauri.conf.json` enables `withGlobalTauri` because the web frontend calls `window.__TAURI__.core.invoke` through `tauriInvoke()`.

When changing CSP or resource bundling, verify that:
- desktop can still load `app.config.json` and `gateway.config.json`
- builtin plugins are bundled under `builtin-plugins`
- iframe plugin runtime still works
- `connect-src` still allows user-configured `http://` and `https://` backend URLs

## Scenario: User Configurable Backend URL In Tauri CSP

### 1. Scope / Trigger
- Trigger: changing `tauri.conf.json` security CSP or desktop backend URL behavior.

### 2. Signatures
- CSP owner: `apps/desktop/src-tauri/tauri.conf.json` `app.security.csp`
- Frontend owner: `apps/desktop/src/lib/api.ts` `apiBase()`

### 3. Contracts
- Desktop users may enter arbitrary HTTP/HTTPS backend URLs.
- CSP `connect-src` must allow those HTTP/HTTPS URLs, plus local Vite development endpoints.
- Builtin plugin resources remain under Tauri `bundle.resources` as `builtin-plugins`.

### 4. Validation & Error Matrix
- CSP omits remote HTTP/HTTPS -> WebView blocks requests before server CORS sees them.
- Tauri resources omit `builtin-plugins` -> builtin plugin list can be empty in packaged app.

### 5. Good/Base/Bad Cases
- Good: `connect-src` includes `http://*:*` and `https://*:*` while other CSP directives remain narrow.
- Base: local dev connects to `http://localhost:1420` and `ws://localhost:1420`.
- Bad: only whitelisting `127.0.0.1:8787` while Settings allows remote backend URL.

### 6. Tests Required
- `pnpm -C apps/desktop vite:build` after CSP/resource changes.
- `cargo test -p lingfang-desktop` when Rust Tauri code changes.

### 7. Wrong vs Correct
Wrong: solve remote backend failures only by changing server CORS.

Correct: check both WebView CSP and server CORS, because either side can block the request.

