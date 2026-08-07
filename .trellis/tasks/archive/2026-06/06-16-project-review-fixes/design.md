# Design

## Boundaries

This task repairs confirmed review findings across three areas:

- `apps/collab-api`: build/test gate, authentication/setup/settings behavior.
- `apps/desktop/src/lib/api.ts`: request header semantics affected by captcha boundary.
- `apps/desktop/src-tauri`: Rust test warning/noise cleanup.

No new infrastructure is introduced. Existing Prisma/Postgres and in-process service patterns remain the baseline.

## Data and State Contracts

### Backend quality gate

The source of truth for Prisma types is `apps/collab-api/prisma/schema.prisma`. The generated Prisma Client must include the fields and models currently referenced by code, including:

- `User.tokenVersion`, `failedLoginAttempts`, `lockedUntil`, `emailVerified`
- `Team.allowPublicJoin`, `description`
- `PlatformSetting`
- `LlmGateway`
- `Release`

The repair path is dependency install + Prisma generate, not weakening TypeScript checks.

### Setup bootstrap lock

Use an existing database-enforced unique key as the one-time setup marker:

- Key: `__setup_bootstrap_lock__` in `PlatformSetting.key`.
- The setup transaction creates this key before creating the first admin.
- If the key already exists, setup returns the same already-initialized semantic response as when an admin already exists.

This makes the one-time initialization guard database-backed rather than request-timing-backed.

### Captcha trust boundary

`X-Client: desktop` is a user-controllable HTTP header and must not be treated as a trust boundary.

The minimal safe behavior is:

- Auth endpoints may continue reading client kind for analytics or UX labels.
- Captcha skipping must not happen solely because `clientKind === 'desktop'`.
- Tests should prove forged desktop headers do not bypass captcha when a captcha scene is enabled.

If a future desktop exemption is needed, it should use a non-public shared secret / device registration / gateway-level trust model, not a plain header.

### Platform settings transaction

`updateSettings` should preserve all-or-nothing semantics for one submitted batch:

- Validate the whole batch first.
- In one Prisma transaction, upsert all normalized settings and write matching audit rows.
- Only after the transaction succeeds, invalidate public info, SMTP, Geetest and Gitee caches.

### Secret reveal consistency

`giteeAccessToken` is already treated as a secret for audit metadata. It should be revealable through the same second-factor admin-password confirmation path as `smtpPass` and `geetestCaptchaKey`, unless product policy explicitly forbids reveal. This task chooses consistency.

### Desktop Rust cleanup

- `cli_installer.rs`: non-Windows unsupported return should not make the Windows install body unreachable to the compiler. Platform-specific branches should be structurally separated.
- `plugin_script.rs`: tests should not print expected process-group permission noise as if it were an error. Expected best-effort kill failures should be swallowed or scoped to debug-only paths.

## Compatibility

- Public API paths remain unchanged.
- Captcha behavior becomes stricter for forged desktop headers; this is an intentional security hardening.
- Setup lock uses `PlatformSetting`; no schema migration is required.
- `giteeAccessToken` reveal behavior expands an existing privileged admin-only endpoint and keeps password confirmation.

## Rollback Shape

- Backend service changes are isolated to controllers/services/DTO tests.
- If setup lock behavior causes an unexpected bootstrap issue, removing the lock create branch restores prior behavior, but should only be done with a replacement concurrency guard.
- If captcha strictness blocks desktop UX, introduce a real trust primitive rather than reverting to header trust.
