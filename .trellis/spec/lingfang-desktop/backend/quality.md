# Quality

## Tauri Commands

Commands exposed to the frontend are registered in `tauri::generate_handler!`:

- `list_plugins`
- `read_plugin_file`
- `invoke_capability`

Return `Result<_, String>` for user-facing command failures. Keep detailed validation inside helper modules rather than in the command body.

Reference file:
- `apps/desktop/src-tauri/src/main.rs`

## Module Organization

Large Rust command modules must be split by responsibility before they become the maintenance surface:

- `code_assistant.rs` -> keep command/export surface thin; move SDK engines, local tools, process helpers, workspace and session storage under `code_assistant/`.
- `plugin_store.rs` -> split config, path safety, manifest parsing, status scanning and file IO under `plugin_store/`.
- `plugin_runner.rs` -> split manifest parsing, Python venv, Node install, process table and command wrappers under `plugin_runner/`.
- `plugin_script.rs` -> split runtime probing, env construction, path validation, sandbox materialization and execution under `plugin_script/`.

The old top-level file may remain as `mod.rs`/barrel during migration, but implementation should move into focused modules. Do not hide command failures behind broad catch-and-continue behavior during the split.

### Code Assistant Split Boundary

`apps/desktop/src-tauri/src/code_assistant.rs` may remain as the thin command/session orchestration surface after SDK engines, process helpers and test logic have moved out. Treat it as a recorded exception only when:

- process lookup/capture/tree-kill lives under `code_assistant/process/`;
- SDK request construction, response parsing, tool loops and local workspace tools live under `code_assistant/engine/`;
- tests are split under `code_assistant/tests/` by behavior (`core`, `summary`, `process`, `scan`) plus engine-local tests for SDK request bodies and tool validation;
- the remaining top-level file owns command inputs, session lifecycle glue, event sink glue and store/task coordination.

Do not split the remaining session state machine by cutting arbitrary line ranges. Create a separate session-orchestration design first if the top-level file grows again.

### Reader Test Synchronization

`spawn_reader` writes transcript output before emitting `code-assistant://output`. Tests that assert emitted payloads must wait on captured emitted events, not transcript line counts.

Wrong:

```rust
// This can wake after append_transcript but before the matching emit_json.
wait_until_transcript_has_output_count(&store, session_id, 4);
assert_emitted_stderr_contains("402");
```

Correct:

```rust
wait_for_output_events(&captured_events, 4);
assert_emitted_stderr_contains("402");
```

This is not a retry fallback. It aligns the test synchronization point with the data source being asserted.

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

