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
- `ui.render`

Do not include `base_url`, API key, provider name, or billing data in SDK calls. LLM routing is server-owned through tenant bindings.

## Generated Plugin Expectations

AI-generated plugins may use SDK-style calls only for capabilities declared in `manifest.json`. The generation prompt and validation currently forbid direct `import`, `require`, `fetch`, `XMLHttpRequest`, and `eval` in generated UI files.

Reference files:
- `apps/server/src/llm.rs`
- `plugins/summarizer/ui/index.html`

## Type Safety

Use typed input objects for non-trivial calls, as `ChatInput` does for `llm.chat`. Keep return types as `Promise<T>` and avoid `any` in exported API.

