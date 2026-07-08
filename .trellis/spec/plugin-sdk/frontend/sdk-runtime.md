# SDK Runtime

## Bridge Contract

The SDK calls a host-injected function:

```ts
globalThis.__lingfangInvoke(capability, args)
```

If the bridge is missing, `invoke()` throws `capability bridge 未注入: <capability>`. Keep this explicit failure; do not provide a fake local implementation.

Reference file:
- `packages/plugin-sdk/src/index.ts`

## Capability API Shape

SDK methods are thin wrappers around capability names from `@lingfang/contract`:

- `fs.pick`, `fs.read`, `fs.write`
- `net.fetch`
- `clipboard.readText`, `clipboard.writeText`
- `storage.get`, `storage.set`
- `system.screenshot`, `system.notify`
- `llm.chat`
- `image.generate`
- `ui.render`

Do not include `apiKey`, `apiUrl`, `base_url`, `baseUrl`, provider name, custom endpoint, Authorization header, bridge token, upstream model id, or billing data in SDK calls. AI routing is owned by the platform relay (`apps/collab-api`) through team channels and pricing.

Allowed AI signatures:

```ts
sdk.llm.chat({ messages, model });
sdk.image.generate({ prompt, model, size, n });
```

`model` is a platform model id (`fast` / `premium`) only. It is not an upstream model name, URL, provider selector, or key lookup hint.

Script plugins without `globalThis.__lingfangInvoke` may use the SDK's local HTTP bridge fallback through `LINGFANG_PLUGIN_BRIDGE_URL` + one-time `LINGFANG_PLUGIN_BRIDGE_TOKEN`; plugin authors still must not read, print, persist, or expose that token in UI.

## OpenAI-Compatible Bridge Routes (for third-party SDKs)

The local bridge (`apps/desktop/src-tauri/src/plugin_llm_bridge.rs`) also serves standard OpenAI-compatible routes so that third-party code using the `openai` SDK / `@ai-sdk/openai` / `openai-python` can point `base_url` directly at `LINGFANG_PLUGIN_BRIDGE_URL` and bypass `@lingfang/plugin-sdk` entirely. This is how vendored third-party projects (e.g. MoneyPrinterTurbo, Pixelle-Video, huobao-drama) route their LLM + image calls to the platform model without a proxy shim.

| Route | Method | Behavior | Gate |
|---|---|---|---|
| `/v1/chat/completions` | POST | **Pass-through**: forwards to platform relay `/api/relay/v1/chat/completions` and returns the full OpenAI response (`choices[].message`) **unwrapped** (NOT as `{content}`). `model` is normalized to `fast`/`premium` sentinel; upstream fields like `quality`/`response_format`/`extra_body` are tolerated and ignored. | reuses `llm.chat` capability (`allow_llm_chat`) |
| `/v1/images/generations` | POST | **Pass-through**: forwards to relay `/api/relay/v1/images/generations`, returns full OpenAI response `{data:[{url|b64_json}]}` **unwrapped** (NOT as `{images}`). | reuses `image.generate` capability (`allow_image_generate`) |
| `/v1/models` | GET | Returns `{object:list, data:[{id:fast},{id:premium}]}` for SDK connectivity probing. | any valid token (no capability required) |

Contrast with the legacy SDK-shaped routes (`/llm/chat` → `{content}`, `/image/generate` → `{images}`), which wrap responses for `@lingfang/plugin-sdk`'s `invoke()`. The `/v1/*` routes do NOT wrap — third-party SDKs consume raw OpenAI format. The SDK's `sdk.llm.chat()` continues to use `/llm/chat`; `/v1/*` is purely for code that bypasses the SDK.

The method guard is per-route: only `GET /v1/models` is allowed as GET; all other routes remain POST-only.

## Generated Plugin Expectations

AI-generated plugins may use SDK-style calls only for capabilities declared in `manifest.json`. The generation prompt and validation currently forbid direct `import`, `require`, `fetch`, `XMLHttpRequest`, and `eval` in generated UI files.

Generated plugins must not render settings for API Key, API URL, provider, baseUrl, custom model endpoint, token, or Authorization header. If AI capability is unavailable, show a normal product error such as "请登录灵坊或联系团队管理员", not instructions to paste a secret.

Reference files:
- `apps/collab-api/src/modules/plugins.controller.ts`
- `plugins/summarizer/ui/index.html`

## Type Safety

Use typed input objects for non-trivial calls, as `ChatInput` does for `llm.chat`. Keep return types as `Promise<T>` and avoid `any` in exported API.
