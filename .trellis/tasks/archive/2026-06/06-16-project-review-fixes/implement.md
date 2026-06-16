# Implementation Plan

## Order

1. Restore backend gate
   - Run dependency install from repo root with the existing lockfile.
   - Run Prisma generate for `apps/collab-api`.
   - Re-run `pnpm -r typecheck` and `pnpm -r test` to separate environment failures from code failures.

2. Setup bootstrap lock
   - Update `apps/collab-api/src/modules/setup.controller.ts` to create a `PlatformSetting` bootstrap lock inside the setup transaction.
   - Preserve existing response semantics for already-initialized systems.
   - Add/update `setup.controller.spec.ts` for duplicate setup behavior.

3. Captcha boundary
   - Update `AuthService.requireCaptcha` so `clientKind === 'desktop'` does not skip captcha by itself.
   - Update controller/comments and desktop header comment in `apps/desktop/src/lib/api.ts`.
   - Add/update auth service tests proving forged desktop header still requires captcha.

4. Transactional settings
   - Update `SettingsService.updateSettings` to run batch upserts and audit writes in one Prisma transaction.
   - Keep cache invalidation after successful transaction only.
   - Add/update settings service tests for rollback behavior.

5. Secret reveal consistency
   - Add `giteeAccessToken` to reveal whitelist and update messages/tests.

6. Rust cleanup
   - Restructure `cli_installer.rs` platform branches to remove unreachable code warning.
   - Suppress expected best-effort process kill permission noise in `plugin_script.rs` without hiding real test failures.

7. Final verification
   - `pnpm -r typecheck`
   - `pnpm -r test`
   - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
   - Read lints for edited TypeScript/Rust files where available.

## Risk Points

- Prisma 7 generation may depend on `prisma.config.ts`; use the package script if direct command syntax differs.
- Tests may currently mock Prisma with incomplete models; after transactional changes, mocks may need `$transaction` support.
- Captcha tests should validate behavior through service-level contract, not external Geetest network calls.

## Review Gate

Proceed to implementation only after this task is moved to `in_progress` with `task.py start`.