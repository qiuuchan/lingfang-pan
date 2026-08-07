# 修复全量源码 review 发现的问题 - Design

## Architecture

本修复按边界分层处理，不引入新的静默 fallback：

- Server owns tenant authorization, plugin publish/install rules, LLM key encryption, and SSE success/error semantics.
- Tauri owns local builtin capability scope validation and real OS file reads.
- Desktop frontend owns iframe runtime message binding and host-injected SDK bridge.
- Contract and SDK own shared TypeScript schemas and plugin author API shape.

## Server Design

### Tenant Context

`TenantCtx` continues to parse JWT for `sub` and selected `tenant_id`, then queries `memberships` for `(role,status)` with `status='active'`. The returned role comes from DB, not JWT. Missing or disabled memberships return `Forbidden`.

This preserves the existing `/auth/switch-tenant` flow while closing stale or forged role claims. `AuthUser` remains pre-tenant and does not require membership.

### Config Secrets

`Config::from_env()` should stay side-effect free. Add validation after loading config, before database connection, that rejects known dev placeholders and too-short secrets. Startup failure is explicit, matching existing hard-fail startup style.

### LLM Key Encryption

Replace XOR with authenticated encryption using existing dependency additions:

- derive a 32-byte key from `KEY_ENCRYPTION_SECRET` with SHA-256
- encrypt with AES-256-GCM using a random 12-byte nonce
- store as versioned text, e.g. `v1:<nonce_hex>:<cipher_hex>`
- decrypt only `v1` values

No legacy XOR compatibility path is added, because compatibility was not requested and silent fallback would hide weak storage.

### Plugin Publish

Publishing keeps `plugins.id` as the manifest identity, but ownership is enforced:

- new id inserts normally with current `author_tenant_id`
- same id and same `author_tenant_id` updates content
- same id and different `author_tenant_id` returns an explicit conflict/bad request

If an already marketplace-approved plugin changes content, set `review_status='pending'` so marketplace visibility requires re-review.

### Plugin Install

Remove the unsafe generic install path from behavior by making `catalog::install()` enforce the same semantics as market/private visibility:

- author tenant may install its own listed plugin
- approved marketplace free plugin may install directly
- approved marketplace paid plugin requires purchase by current user
- non-marketplace plugin from another tenant is not installable

The marketplace endpoint remains the primary UI path and keeps its transaction for install count.

### Streaming Generation

The streaming task must propagate persistence failures:

- if LLM streaming or finalization fails: existing `error` event
- if `persist_generation` or `fetch_draft` after persistence fails: send `error` event and audit `error`
- only send `done` after the saved draft was loaded successfully

## Tauri Design

`fs_read()` canonicalizes the requested path and each expanded allowed prefix before checking `requested.starts_with(prefix)`. Missing paths surface `Exec`. Nonexistent allowed prefixes are ignored; if none match, return `OutOfScope`.

Tests use temporary directories and explicit sibling paths to cover:

- allowed child file
- `allowed/../sibling` rejected
- `allowed2` rejected when allowed is `allowed`

## Desktop Runtime Design

The shim still includes `pluginId` as internal context, but host message handling ignores `m.pluginId` and uses `plugin.id` from the active `Runner`. For database plugins, `/llm/proxy` also receives `plugin.id`.

The host injects:

```js
globalThis.__lingfangInvoke = (capability, args) => call(capability, args || {});
```

`window.sdk` can remain for generated inline plugins, but it must call the same bridge and accept `llm.chat({ messages, model })` to align with `@lingfang/plugin-sdk`.

## Contract And SDK Design

Update `ErrorCode` with actual backend stable codes. Update `resolveGrant()` so owner/admin default to allowed when no explicit grant exists, matching server behavior.

Update the summarizer example to avoid bare ESM package imports inside a raw iframe and use the host-injected `sdk`/`__lingfangInvoke` contract.

## Compatibility

- Existing saved XOR encrypted LLM keys will not decrypt after the change. This is intentional: preserving weak ciphertext via silent fallback would keep the reviewed flaw. Users must re-save API keys.
- Existing tokens remain structurally valid, but tenant role is no longer trusted from token claims.
- Plugin IDs remain stable; only cross-tenant collisions become rejected.

## Rollback

The risky points are localized:

- server auth/publish/install/encryption changes are in `apps/server/src/`
- Tauri scope check is in `apps/desktop/src-tauri/src/capability.rs`
- runtime bridge changes are in `apps/desktop/src/pages/Plugins.tsx`
- contracts are in `packages/contract/src/`

Rollback by reverting the affected file group; no database migration is required.
