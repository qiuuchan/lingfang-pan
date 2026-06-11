# HTTP, Auth, And Errors

## Router Shape

`apps/server/src/routes/mod.rs` owns route composition. Each feature route module accepts `State<AppState>` and typed extractors, then returns `AppResult<Json<Value>>` or another explicit response type.

Reference files:
- `apps/server/src/routes/mod.rs`
- `apps/server/src/routes/auth.rs`
- `apps/server/src/routes/drafts.rs`
- `apps/server/src/routes/marketplace.rs`

## Tenant Isolation

Tenant-scoped routes must use `TenantCtx`. It parses JWT claims and requires a selected `tenant_id`; routes then bind `ctx.tenant_id` in SQL.

`TenantCtx` must not trust the JWT `role` claim. After parsing `sub` and `tenant_id`, it queries `memberships` for `(tenant_id,user_id,status='active')` and uses the database role. Missing or inactive memberships return `Forbidden`.

Use `AuthUser` only for routes that can run before tenant selection, such as wallet lookup or tenant selection flows. Use `PlatformAdmin` only for platform review endpoints.

Reference file:
- `apps/server/src/auth.rs`

## Role Checks

Tenant admin operations call `ctx.is_admin()`, which currently allows `owner` and `admin`. If you add a role in `packages/contract/src/identity.ts`, update:

- server role checks
- frontend role labels and admin-only navigation
- any docs or tests that assume owner/admin/member only

## Error Contract

Use `AppError` and `AppResult`; do not hand-build ad hoc error JSON. `AppError::into_response()` returns `{ "error": code, "message": text }`, and frontend `ApiError.code` depends on those codes.

Reference files:
- `apps/server/src/error.rs`
- `apps/desktop/src/lib/api.ts`

Do not add mock success responses. For missing LLM binding, invalid generation, denied capability, payment failure, or upstream errors, return the explicit `AppError` variant.

## Scenario: Health Check And CORS Boundary

### 1. Scope / Trigger
- Trigger: changing `/health`, `Config`, CORS behavior, frontend backend URL setup, or deployment docs.

### 2. Signatures
- Health API: `GET /health -> { "status": "ok" }`
- Env: `CORS_ALLOWED_ORIGINS=<origin>[,<origin>...]`
- Config field: `cors_allowed_origins: Vec<String>`

### 3. Contracts
- `/health` is unauthenticated and is the desktop connection-test endpoint.
- Empty `CORS_ALLOWED_ORIGINS` keeps development permissive CORS.
- Non-empty `CORS_ALLOWED_ORIGINS` is an exact origin allowlist.
- Allowlisted CORS supports `GET`, `POST`, `OPTIONS`, `Authorization`, and `Content-Type`.

### 4. Validation & Error Matrix
- Invalid allowlist origin at startup -> hard startup failure.
- Origin not in allowlist -> browser/WebView blocks frontend request.
- Missing backend URL on desktop -> frontend blocks before hitting server.

### 5. Good/Base/Bad Cases
- Good: deployed backend sets `BIND_ADDR=0.0.0.0:8787` and exact `CORS_ALLOWED_ORIGINS`.
- Base: local dev leaves `CORS_ALLOWED_ORIGINS` empty.
- Bad: server keeps permissive CORS in deployment while docs claim a whitelist is active.

### 6. Tests Required
- `cargo test -p server` after changing config shape or CORS construction.
- Runtime smoke test: desktop `/health` check succeeds for expected backend URL.

### 7. Wrong vs Correct
Wrong: create a second health endpoint or require auth for connection testing.

Correct: reuse `GET /health` as the only unauthenticated backend readiness signal.

## Scenario: Tenant Context Membership Authority

### 1. Scope / Trigger
- Trigger: any tenant-scoped API, admin check, or JWT claim change.

### 2. Signatures
- Extractor: `TenantCtx::from_request_parts(parts, state) -> Result<TenantCtx, AppError>`
- SQL authority: `SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND status='active'`

### 3. Contracts
- JWT supplies `sub` and selected `tenant_id` only.
- Returned `TenantCtx.role` is the active membership role from DB.
- JWT `role` is advisory legacy data and must not drive authorization.

### 4. Validation & Error Matrix
- Missing `Authorization` / invalid token -> `Unauthorized`
- Missing or invalid `tenant_id` -> `Forbidden`
- No active membership row -> `Forbidden`
- Active membership found -> `TenantCtx { user_id, tenant_id, role }`

### 5. Good/Base/Bad Cases
- Good: token says `owner`, DB membership says `member`; route sees `member`.
- Base: token and DB both say `admin`; route sees `admin`.
- Bad: token contains tenant but membership is disabled/missing; route must fail.

### 6. Tests Required
- Unit or extractor test where JWT role differs from DB role and assertion reads `TenantCtx.role`.
- Negative test for missing/inactive membership when adding membership status behavior.

### 7. Wrong vs Correct
Wrong: use `claims.role.unwrap_or_default()` inside tenant routes.

Correct: parse identity from token, then load active membership role from `memberships`.
