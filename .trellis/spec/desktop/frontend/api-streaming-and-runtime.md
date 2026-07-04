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
- Trigger: changing backend URL setup, app startup, `apiBase()`, login/setup address entry, update checks, or connection testing.

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
- Settings -> 更新 only exposes update actions (`checkUpdate`, changelog, install). It must not render platform/backend address inputs, save buttons, clear buttons, or current-address readouts.
- Update checks use the current `apiBase()`/session backend URL internally. If no backend URL is active, show a plain update failure message rather than sending the user to Settings to configure an address.

### 4. Validation & Error Matrix
- Empty URL -> setup card blocks app entry.
- Invalid scheme or malformed URL -> Chinese validation error.
- `/health` unreachable -> connection error mentioning backend URL, network, and CORS.
- Saved URL changes -> reset current session because old token may belong to another backend.
- Settings update tab contains address editing UI -> remove it; address editing belongs outside Settings.
- Check update with no active backend URL -> toast `当前未连接协作服务，无法检查更新`.

### 5. Good/Base/Bad Cases
- Good: packaged default is empty; first run shows backend setup and sends no business request.
- Base: packaged default points to local backend; app can enter Auth immediately.
- Bad: page directly concatenates its own backend URL instead of using `apiBase()`.
- Bad: Settings card titled `平台地址与更新` with an editable backend URL field.

### 6. Tests Required
- `pnpm -C apps/desktop typecheck`
- `pnpm -C apps/desktop vite:build`
- Manual/runtime check for first-run empty URL and Settings -> 更新 showing update-only controls when UI behavior is touched.

### 7. Wrong vs Correct
Wrong: keep a hidden hardcoded `http://127.0.0.1:8787` fallback that bypasses user setup, or put backend URL editing back under Settings -> 更新.

Correct: use the shared backend URL configuration layer, let empty config become an explicit setup state, and keep Settings -> 更新 focused on update checking/installing only.

## Error Handling

Backend errors expose stable `error` codes and human messages. UI pages use `ApiError.code` only for user-facing branches that are already known, such as:

- `llm_binding_missing` in `Generator.tsx`
- `insufficient_balance` / `payment_required` in `Market.tsx`
- `forbidden` in `Settings.tsx`

Do not swallow new backend errors or convert them to fake success states. Surface the message and let the failed operation remain failed.

### Convention: Tauri invoke 错误用 `errorMessage(err, fallback)` 提取

**What**: 凡 `catch` 来自 `tauriInvoke`（即调 Rust `#[tauri::command]`）的错误，必须用 `errorMessage(err, fallback)` 提取信息，禁止 `(err as ApiError).message`。

**Why**: Rust 命令返回 `Result<_, String>`，失败时以**裸字符串** reject，不是 `Error`/`ApiError` 对象。`(err as ApiError).message` 对裸字符串恒为 `undefined`，真实失败原因（HTTP 状态、验签失败、网络错误）被吞，用户只见通用兜底文案，无从排查（DESK-UPDATE-01：检查更新失败即此因）。`api()`（fetch 通道）抛的是真 `Error`，`.message` 可用——但两条通道混用易错，统一走 `errorMessage` 最稳。

**Signature**: `errorMessage(err: unknown, fallback = ''): string` —— 字符串原样 `trim`、`Error` 取 `message`、`{message}`/`{error}` 对象取对应字段、其余 `JSON.stringify` 兜底；全空时返 `fallback`。位于 `apps/desktop/src/lib/api.ts`。

**Example**:

```typescript
// Wrong：裸字符串 .message 恒 undefined → 永远走兜底，真因被吞
catch (err) { toast.error((err as ApiError).message || '检查更新失败'); }

// Correct：两种来源都能透出真实信息
catch (err) { toast.error(errorMessage(err, '检查更新失败，请重试')); }
```

**Related**: 单测 `apps/desktop/src/lib/api-error-message.spec.ts` 覆盖裸字符串/Error/对象/兜底。

## Streaming Generation

`streamGenerate()` parses server-sent events:

- `reasoning` accumulates model reasoning text
- `token` accumulates generated JSON/code text
- `stage` updates progress text
- `done` returns the full `PluginDraft`
- `error` throws an `Error` with `code`

When changing the backend stream contract, update `apps/desktop/src/lib/stream.ts` and `apps/collab-api/src/modules/plugins.controller.ts` (SSE 生成端点，已由 apps/server 迁移至 apps/collab-api) together.

## Plugin Preview And Runtime

Generated drafts preview in a sandboxed iframe using `srcDoc`. Published database plugins get a runtime shim from `sdkShim()`, while builtin plugins get `LingFangBridge` from `bridgeShim()`.

Runtime rule:
- Builtin plugin capabilities go through Tauri `invoke_capability`.
- Database and builtin plugin AI capabilities go through the host bridge and platform relay (`/api/relay/v1/*`) with the current app login state or local script bridge token.
- Unsupported capabilities must fail explicitly; do not pretend they succeeded.
- Iframe messages must be bound to the active `Runner` plugin. The host ignores message-provided `pluginId` and sends `plugin.id` to Tauri or relay.
- The host injects `globalThis.__lingfangInvoke(capability,args)`; SDK-style AI calls are `sdk.llm.chat({ messages, model })` and `sdk.image.generate({ prompt, model, size, n })`.
- Plugin UI/config must not expose API Key, API URL, baseUrl, provider, custom endpoint, Authorization header, bridge token, or upstream model service address. `model` remains allowed only as a platform model id such as `fast` or `premium`.
- Plugin list loading may combine builtin and database sources, but source failures must be shown in-page instead of silently becoming an empty list.

Reference files:
- `apps/desktop/src/pages/Generator.tsx`
- `apps/desktop/src/pages/Plugins.tsx`
- `apps/desktop/src-tauri/src/capability.rs`
- `apps/collab-api/src/modules/relay/relay.controller.ts`

## Scenario: Plugin Iframe Runtime Bridge

### 1. Scope / Trigger
- Trigger: changing `Plugins.tsx`, plugin SDK bridge, database plugin runtime, or builtin capability calls.

### 2. Signatures
- Host bridge: `globalThis.__lingfangInvoke(capability: string, args: unknown) -> Promise<unknown>`
- Chat call: `sdk.llm.chat({ messages, model }) -> Promise<string>`
- Image call: `sdk.image.generate({ prompt, model, size, n }) -> Promise<{ images: string[] }>`
- Host relay chat body: `{ model: 'fast' | 'premium', messages, stream: false }`
- Host relay image body: `{ model: 'fast' | 'premium', prompt, n, size }`

### 3. Contracts
- Host validates `ev.source === iframe.contentWindow`.
- Host uses the active `LoadedPlugin.id`, not any `pluginId` included by iframe code.
- Builtin plugins call Tauri `invoke_capability` with `{ pluginId: plugin.id, kind, args }`.
- Database plugins may call only supported runtime capabilities; unsupported calls post an error reply.
- `llm.chat` and `image.generate` require the plugin manifest capability. Missing capability fails before relay.
- AI capability args may include `model`, but the host normalizes it to the platform tier (`premium` only when explicitly requested; otherwise `fast`).
- Plugins never receive or persist platform API Key/JWT/local bridge token values.

### 4. Validation & Error Matrix
- Message from another frame -> ignored.
- Missing bridge -> SDK throws explicit bridge-not-injected error.
- Database plugin calls unsupported capability -> explicit error reply.
- Plugin calls `llm.chat` / `image.generate` without declaring the matching capability -> explicit error reply.
- Plugin asks for API Key/API URL/provider configuration -> generation/prompt contract violation; remove the setting and use SDK AI capability.
- Builtin or database source load fails -> page error text; do not fake an empty source.

### 5. Good/Base/Bad Cases
- Good: malicious iframe sends another `pluginId`; host still invokes with active `plugin.id`.
- Base: summarizer calls `sdk.llm.chat({ messages, model })`; image plugin calls `sdk.image.generate({ prompt, model })`.
- Bad: `sdk.llm.chat(messages, model)`, direct `fetch` to an LLM provider, or any plugin settings field for API Key/API URL/provider.

### 6. Tests Required
- `pnpm -C apps/desktop typecheck`
- `pnpm -C packages/plugin-sdk typecheck`
- Vite build after changing injected shims or page imports.

### 7. Wrong vs Correct
Wrong: trust `ev.data.pluginId` or swallow source-load errors with `.catch(() => [])`.

Correct: bind runtime calls to the active plugin and surface load failures to the page.
