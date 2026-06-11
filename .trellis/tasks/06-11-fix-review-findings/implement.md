# 修复全量源码 review 发现的问题 - Implementation Plan

## Ordered Checklist

### 1. Server Regression Tests

- Add server unit tests first for:
  - config secret validation rejects placeholders
  - authenticated crypto roundtrip and tamper failure
  - publish ownership decision helper rejects cross-tenant conflict
  - install eligibility helper rejects unsafe generic install cases
  - stream persistence helper maps persistence errors to an explicit error event payload
- Run `cargo test -p server` and verify the new tests fail for the expected reason before implementation.

### 2. Server Fixes

- Modify `apps/server/src/config.rs` to validate `JWT_SECRET` and `KEY_ENCRYPTION_SECRET`.
- Modify `apps/server/src/main.rs` to call config validation before DB startup.
- Replace `apps/server/src/crypto.rs` XOR codec with versioned AES-GCM encryption.
- Modify `apps/server/src/auth.rs` so `TenantCtx` loads active membership role from DB.
- Modify `apps/server/src/routes/drafts.rs` publish flow to reject cross-tenant plugin ID conflicts and re-review changed marketplace plugins.
- Modify `apps/server/src/routes/catalog.rs` generic install flow to enforce author/marketplace/purchase rules.
- Modify `apps/server/src/routes/drafts.rs` stream finalization to send `error` if persistence or saved draft loading fails.
- Run `cargo test -p server` and fix only failures caused by this work.

### 3. Tauri Regression Tests And Fixes

- Add tests in `apps/desktop/src-tauri/src/capability.rs` for canonical path scoping.
- Run `cargo test -p lingfang-desktop` and verify the scope test fails before implementation.
- Implement canonicalized scope validation.
- Re-run `cargo test -p lingfang-desktop`.

### 4. Desktop Runtime And SDK Contract

- Update `apps/desktop/src/pages/Plugins.tsx`:
  - host uses active `plugin.id`, not message-provided `pluginId`
  - shim injects `globalThis.__lingfangInvoke`
  - `window.sdk.llm.chat` accepts `{ messages, model }`
- Update `packages/plugin-sdk/src/index.ts` only if needed to match host shape.
- Update `plugins/summarizer/ui/index.html` to use host-injected runtime instead of bare import.
- Run `pnpm -C apps/desktop typecheck` and `pnpm -C packages/plugin-sdk typecheck`.

### 5. Contract Alignment

- Update `packages/contract/src/llm.ts` `ErrorCode`.
- Update `packages/contract/src/plugin.ts` `resolveGrant()` owner/admin default.
- Add lightweight node tests in `packages/contract` for `resolveGrant()` and `ErrorCode` membership if practical.
- Run `pnpm -C packages/contract typecheck` and `pnpm -C packages/contract test`.

### 6. Full Verification

- Run:
  - `pnpm -r typecheck`
  - `pnpm -r test`
  - `cargo test -p server` with 60 second timeout
  - `cargo test -p lingfang-desktop` with 60 second timeout
  - `pnpm -C apps/desktop vite:build`
- Report any remaining non-code risk explicitly.

## Validation Notes

- Backend tests must finish within 60 seconds.
- Do not add mock success or fallback behavior to make tests pass.
- Do not preserve weak XOR decryption as a compatibility fallback.
- Do not add new local capabilities beyond existing `fs.read` and `system.info`.

## Risky Files

- `apps/server/src/auth.rs`
- `apps/server/src/config.rs`
- `apps/server/src/crypto.rs`
- `apps/server/src/routes/catalog.rs`
- `apps/server/src/routes/drafts.rs`
- `apps/desktop/src-tauri/src/capability.rs`
- `apps/desktop/src/pages/Plugins.tsx`
- `packages/contract/src/llm.ts`
- `packages/contract/src/plugin.ts`
- `plugins/summarizer/ui/index.html`
