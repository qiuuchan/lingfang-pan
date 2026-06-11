# LLM Generation And Audit

## Binding And Key Handling

LLM keys are tenant-scoped and stored encrypted in `llm_gateway_bindings.api_key_ciphertext`. Runtime use goes through `llm::resolve_binding()`, which decrypts only inside the server process.

Reference files:
- `apps/server/src/routes/llm.rs`
- `apps/server/src/llm.rs`
- `apps/server/src/crypto.rs`

Frontend and plugins never receive plaintext keys. Public binding responses return only a masked key.

Stored key ciphertext uses authenticated encryption format `v1:<nonce_hex>:<cipher_hex>`, derived from `KEY_ENCRYPTION_SECRET`. Do not add legacy XOR or plaintext fallback paths; decryption failure is an explicit binding failure. Startup must call `Config::validate()` and reject placeholder or too-short `JWT_SECRET` / `KEY_ENCRYPTION_SECRET`.

## Generation Flow

Plugin generation is the product core:

1. route fetches the tenant draft
2. resolves tenant LLM binding
3. builds messages with the system plugin-generation prompt
4. calls OpenAI-compatible `/chat/completions`
5. extracts JSON, parses files, validates schema and safety
6. persists files, diagnostics, turns, and status
7. writes invocation audit

Reference files:
- `apps/server/src/routes/drafts.rs`
- `apps/server/src/llm.rs`

Invalid generation returns `generation_invalid` with the model output excerpt. Keep that diagnostic exposure; do not hide the model output behind a generic failure.

## Streaming Contract

`generate_stream()` sends SSE events consumed by `apps/desktop/src/lib/stream.ts`:

- `stage`
- `reasoning`
- `token`
- `done`
- `error`

If the event shape changes, update both server and desktop in the same change.

Only send `done` after generation persistence succeeds and the saved draft is loaded back from storage. If `persist_generation()` updates zero rows, persistence fails, or loading the saved draft fails, send an `error` event with `{ "error": <code>, "message": <text> }` and audit status `error`.

## Audit

`audit::record(state, AuditRecord { ... })` records facts for `generate` and `runtime` calls. Audit failure is intentionally ignored so a successful primary operation is not converted into a user failure.

Do not put billing logic in `invocation_audits`; wallet transactions live in `wallet_transactions`.

## Scenario: LLM Key Encryption And Streaming Finalization

### 1. Scope / Trigger
- Trigger: changing LLM bindings, key storage, generation streaming, or invocation audit.

### 2. Signatures
- `Config::validate() -> Result<(), ConfigError>`
- `crypto::encrypt(plaintext, secret) -> String`
- `crypto::decrypt(ciphertext, secret) -> Option<String>`
- `audit::record(state, AuditRecord { ... })`

### 3. Contracts
- `JWT_SECRET` and `KEY_ENCRYPTION_SECRET` must be non-placeholder and at least 32 characters.
- Ciphertext must start with `v1:` and must be tamper-evident.
- Stream events remain `stage`, `reasoning`, `token`, `done`, `error`.
- `done` data is the saved `PluginDraft`, not an in-memory generated draft.

### 4. Validation & Error Matrix
- Placeholder/short secret -> startup validation error.
- Ciphertext version mismatch or AES-GCM failure -> decrypt returns `None`.
- Draft update affects zero rows -> `not_found`, stream `error`.
- Persist or reload failure -> stream `error`, audit `error`, no `done`.

### 5. Good/Base/Bad Cases
- Good: encrypted key roundtrips, tampered ciphertext fails.
- Base: non-stream generate persists and reloads draft before returning.
- Bad: stream persistence fails but sends `done`; this hides data loss and is forbidden.

### 6. Tests Required
- Config validation rejects placeholders and short secrets.
- Crypto roundtrip and tamper failure.
- Stream persistence helper reports `not_found` on zero-row update.

### 7. Wrong vs Correct
Wrong: keep XOR decode fallback or send `done` from unsaved generated data.

Correct: decrypt only versioned AES-GCM ciphertext and emit stream `error` for persistence failures.
