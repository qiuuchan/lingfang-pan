# API, Streaming, And Plugin Runtime

## Backend HTTP Boundary

所有业务后端请求默认走 `api()`。它统一拼接 `apiBase()`、JSON body、Bearer token 和 `{ error, message }` 错误映射。

Direct `fetch` is currently reserved for:
- startup/static config: `app.config.json`, `gateway.config.json`, `models-catalog.json`
- backend health checks through `testBackendUrl()`
- the SSE stream in `lib/stream.ts`

Reference files:
- `apps/desktop/src/lib/api.ts`
- `apps/desktop/src/main.tsx`
- `apps/desktop/src/pages/Settings.tsx`
- `apps/desktop/src/lib/models.ts`

## Scenario: Backend URL Configuration Boundary

### 1. Scope / Trigger
- Trigger: changing backend URL setup, app startup, `apiBase()`, Settings backend address UI, or connection testing.

### 2. Signatures
- `initApiBase(defaultUrl?: string | null) -> string | null`
- `configureApiBase(url, { persist }) -> boolean`
- `normalizeBackendUrl(raw) -> string | null`
- `testBackendUrl(url) -> Promise<void>`
- `api(path, options) -> Promise<T>`

### 3. Contracts
- User backend URL is stored globally under `localStorage` key `lf:backendUrl`; it is not tenant-scoped.
- URL priority: stored user value -> `app.config.json.api_base` -> empty setup state.
- Valid URLs must use `http://` or `https://`; saved values are trimmed and trailing slash removed.
- Empty backend URL blocks Auth, tenant selection, business API, and SSE requests.

### 4. Validation & Error Matrix
- Empty URL -> setup card blocks app entry.
- Invalid scheme or malformed URL -> Chinese validation error.
- `/health` unreachable -> connection error mentioning backend URL, network, and CORS.
- Saved URL changes -> reset current session because old token may belong to another backend.

### 5. Good/Base/Bad Cases
- Good: packaged default is empty; first run shows backend setup and sends no business request.
- Base: packaged default points to local backend; app can enter Auth immediately.
- Bad: page directly concatenates its own backend URL instead of using `apiBase()`.

### 6. Tests Required
- `pnpm -C apps/desktop typecheck`
- `pnpm -C apps/desktop vite:build`
- Manual/runtime check for first-run empty URL and Settings URL change when UI behavior is touched.

### 7. Wrong vs Correct
Wrong: keep a hidden hardcoded `http://127.0.0.1:8787` fallback that bypasses user setup.

Correct: use the shared backend URL configuration layer and let empty config become an explicit setup state.

## Error Handling

Backend errors expose stable `error` codes and human messages. UI pages use `ApiError.code` only for user-facing branches that are already known, such as:

- `llm_binding_missing` in `Generator.tsx`
- `insufficient_balance` / `payment_required` in `Market.tsx`
- `forbidden` in `Settings.tsx`

Do not swallow new backend errors or convert them to fake success states. Surface the message and let the failed operation remain failed.

## Streaming Generation

`streamGenerate()` parses server-sent events:

- `reasoning` accumulates model reasoning text
- `token` accumulates generated JSON/code text
- `stage` updates progress text
- `done` returns the full `PluginDraft`
- `error` throws an `Error` with `code`

When changing the backend stream contract, update `apps/desktop/src/lib/stream.ts` and `apps/server/src/routes/drafts.rs` together.

## Plugin Preview And Runtime

Generated drafts preview in a sandboxed iframe using `srcDoc`. Published database plugins get a runtime shim from `sdkShim()`, while builtin plugins get `LingFangBridge` from `bridgeShim()`.

Runtime rule:
- Builtin plugin capabilities go through Tauri `invoke_capability`.
- Database plugin `llm.chat` goes through `/llm/proxy`.
- Unsupported capabilities must fail explicitly; do not pretend they succeeded.
- Iframe messages must be bound to the active `Runner` plugin. The host ignores message-provided `pluginId` and sends `plugin.id` to Tauri or `/llm/proxy`.
- The host injects `globalThis.__lingfangInvoke(capability,args)`; SDK-style `sdk.llm.chat` accepts `{ messages, model }`.
- Plugin list loading may combine builtin and database sources, but source failures must be shown in-page instead of silently becoming an empty list.

Reference files:
- `apps/desktop/src/pages/Generator.tsx`
- `apps/desktop/src/pages/Plugins.tsx`
- `apps/desktop/src-tauri/src/capability.rs`
- `apps/server/src/routes/llm.rs`

## Scenario: Plugin Iframe Runtime Bridge

### 1. Scope / Trigger
- Trigger: changing `Plugins.tsx`, plugin SDK bridge, database plugin runtime, or builtin capability calls.

### 2. Signatures
- Host bridge: `globalThis.__lingfangInvoke(capability: string, args: unknown) -> Promise<unknown>`
- Database LLM call: `sdk.llm.chat({ messages, model }) -> Promise<string>`
- Host proxy body: `{ plugin_id: plugin.id, messages, model }`

### 3. Contracts
- Host validates `ev.source === iframe.contentWindow`.
- Host uses the active `LoadedPlugin.id`, not any `pluginId` included by iframe code.
- Builtin plugins call Tauri `invoke_capability` with `{ pluginId: plugin.id, kind, args }`.
- Database plugins may call only supported runtime capabilities; unsupported calls post an error reply.

### 4. Validation & Error Matrix
- Message from another frame -> ignored.
- Missing bridge -> SDK throws explicit bridge-not-injected error.
- Database plugin calls non-`llm.chat` capability -> explicit error reply.
- Builtin or database source load fails -> page error text; do not fake an empty source.

### 5. Good/Base/Bad Cases
- Good: malicious iframe sends another `pluginId`; host still invokes with active `plugin.id`.
- Base: summarizer calls `sdk.llm.chat({ messages, model })`.
- Bad: `sdk.llm.chat(messages, model)` or bare browser import from `@lingfang/plugin-sdk`.

### 6. Tests Required
- `pnpm -C apps/desktop typecheck`
- `pnpm -C packages/plugin-sdk typecheck`
- Vite build after changing injected shims or page imports.

### 7. Wrong vs Correct
Wrong: trust `ev.data.pluginId` or swallow source-load errors with `.catch(() => [])`.

Correct: bind runtime calls to the active plugin and surface load failures to the page.
