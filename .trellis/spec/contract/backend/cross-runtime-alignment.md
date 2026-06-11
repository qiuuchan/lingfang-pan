# Cross Runtime Alignment

## Contract First

The project rule is contract first: behavior changes that cross runtime boundaries start in `packages/contract`, then server and desktop follow.

Reference docs:
- `docs/02-domain-and-plugins.md`
- `docs/04-engineering.md`

## Server Alignment

Rust does not import the TS package, so alignment is manual. When changing a contract, inspect matching server code:

- identity and roles: `apps/server/src/auth.rs`, `apps/server/src/routes/auth.rs`
- drafts and publishing: `apps/server/src/routes/drafts.rs`
- LLM binding and audit: `apps/server/src/routes/llm.rs`, `apps/server/src/audit.rs`
- marketplace and wallet: `apps/server/src/routes/marketplace.rs`, `apps/server/src/routes/wallet.rs`

Do not add a server field that is meant for frontend use without adding the contract field.

## Frontend Alignment

`apps/desktop/src/lib/types.ts` currently keeps a small frontend-local view of backend payloads. If a payload becomes shared or reused across pages, prefer adding/updating the contract instead of scattering local `[k: string]: unknown` reads.

Role drift is high-risk: `TenantRole` includes `developer`, while current UI labels and admin checks focus on `owner`, `admin`, and `member`. Any role change must update both sides.

## Error Codes

`packages/contract/src/llm.ts` defines stable error codes used by cross-runtime behavior. The server also has operational codes like `forbidden`, `bad_request`, `insufficient_balance`, and `payment_required`.

When frontend behavior branches on a new error code, add it to the shared contract or document why it remains route-local.

