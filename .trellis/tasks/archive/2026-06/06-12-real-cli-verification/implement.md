# 真实 CLI 验证实施计划

## Steps

1. Prepare environment
   - Confirm collab API is running.
   - Confirm desktop app build/dev server is running.
   - Confirm test tenant/team/users exist.
   - Confirm platform admin account exists.

2. Create evidence document
   - Create `docs/plugin-workbench-real-cli-test.md`.
   - Fill environment section before running tests.

3. Run real CLI detection
   - `which claude` and version.
   - `which codex` and version.
   - `which opencode` and version.
   - Record exact outputs.

4. Run app-level probes
   - Trigger `code_assistant_run_probe` for each tool through app/runtime.
   - Record session id and transcript path.

5. End-to-end plugin generation
   - Use each CLI to generate one small plugin.
   - Preview generated plugin.
   - Upload plugin to cloud team sharing.
   - Record cloud plugin id.

6. Team sharing verification
   - Login or act as another team member.
   - Confirm plugin appears and runs.

7. Marketplace verification
   - Submit plugin to marketplace.
   - Approve or reject through admin path.
   - Confirm resulting status is visible to author.
   - If approved, confirm public market visibility.

8. Cleanup verification
   - Stop each session.
   - Check process registry cleanup.
   - Record remaining processes if any.

## Commands

Exact commands depend on installed CLI versions. The evidence document must record the actual commands or app actions used.

Initial shell checks:

```bash
which claude
claude --version
which codex
codex --version
which opencode
opencode --version
```

## Completion Rule

- If Claude Code, Codex, and OpenCode all pass, verification can complete.
- If any one is blocked or failing, the parent task remains not complete.
- The final report must state the exact blocked/failing item and its raw output.

## Validation Commands

Run all automatic validations before real manual gate:

```bash
pnpm -C apps/collab-api typecheck
pnpm -C apps/collab-api test
pnpm -C apps/desktop typecheck
pnpm -C apps/desktop vite:build
pnpm -C packages/contract typecheck
pnpm -C packages/plugin-sdk typecheck
cargo test -p lingfang-desktop
```

## Done When

- Evidence document is filled.
- All three CLI tools have real pass records.
- Cloud upload/team sharing/market review are verified.
- Process cleanup is verified.
- No mock evidence is used.
