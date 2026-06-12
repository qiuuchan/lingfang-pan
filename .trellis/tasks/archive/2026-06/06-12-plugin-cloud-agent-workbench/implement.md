# 云端插件创建分享与本地代码助手实施计划

## Execution Order

1. **Trellis planning artifacts**
   - Write parent PRD/design/implement.
   - Write child PRD/design/implement for:
     - `cloud-plugin-sharing`
     - `desktop-plugin-home`
     - `local-agent-runtime`
     - `plugin-capability-sdk`
     - `real-cli-verification`

2. **Cloud plugin sharing**
   - Extend Prisma plugin schema.
   - Add migration.
   - Add plugin upload/list/submit/edit APIs.
   - Add admin review APIs.
   - Add validation for manifest, entry, paths, file size, capabilities, ownership.
   - Add backend tests for permission and validation.

3. **Desktop plugin home**
   - Move default post-login view to plugin creator home.
   - Refactor `Generator.tsx` into workbench components.
   - Add cloud upload/share panel.
   - Add recent plugins cache.
   - Wire team-shared and marketplace statuses.

4. **Local agent runtime**
   - Add Tauri code assistant module.
   - Implement adapters for Claude Code, Codex, OpenCode.
   - Implement commands/events/session store/transcript/process registry.
   - Add tests for adapter normalization and process registry cleanup.

5. **Plugin capability SDK**
   - Extend contract capability enum.
   - Extend plugin SDK.
   - Extend desktop iframe runtime restrictions.
   - Add tests/typecheck for contract and SDK.

6. **Real CLI verification**
   - Write `docs/plugin-workbench-real-cli-test.md`.
   - Run automated checks.
   - Run full real CLI manual matrix.
   - Record real outputs and failures.

## Validation Commands

```bash
pnpm -C apps/collab-api typecheck
pnpm -C apps/collab-api test
pnpm -C apps/desktop typecheck
pnpm -C apps/desktop vite:build
pnpm -C packages/contract typecheck
pnpm -C packages/plugin-sdk typecheck
cargo test -p lingfang-desktop
```

## Real CLI Manual Gate

Must be executed against real installed CLIs:

```bash
which claude
claude --version
# Run adapter-level Claude Code probe through the app, not only shell help.

which codex
codex --version
# Run adapter-level Codex probe through the app, not only shell help.

which opencode
opencode --version
# Run adapter-level OpenCode probe through the app, not only shell help.
```

For each tool:

1. Detect binary path.
2. Read version.
3. Confirm authenticated/model-ready state through a real minimal prompt.
4. Generate a small plugin through desktop workbench.
5. Verify transcript path and session id.
6. Upload generated plugin to cloud team space.
7. Verify team member visibility.
8. Submit marketplace review.
9. Approve or reject through admin path.
10. Verify public market visibility or rejection feedback.
11. Stop session and verify process registry cleanup.

## Evidence Requirements

`docs/plugin-workbench-real-cli-test.md` must include:

- OS and app build.
- Backend URL and test tenant/team identifiers.
- CLI path/version/model for Claude Code, Codex, OpenCode.
- Commands or UI actions used.
- Session ids.
- Transcript paths.
- Cloud plugin ids.
- Upload response payloads.
- Marketplace review ids/status.
- Screenshots or browser/runtime observations where UI behavior matters.
- Exact stderr/stdout for any failing tool.

## Risky Files

- `apps/collab-api/prisma/schema.prisma`
- `apps/collab-api/src/modules/collab.service.ts`
- `apps/collab-api/src/modules/plugins.controller.ts`
- `apps/collab-api/src/modules/admin.controller.ts`
- `apps/desktop/src/App.tsx`
- `apps/desktop/src/pages/Generator.tsx`
- `apps/desktop/src/pages/plugins-runtime.ts`
- `apps/desktop/src-tauri/src/main.rs`
- `apps/desktop/src-tauri/src/capability.rs`
- `apps/desktop/src-tauri/Cargo.toml`
- `packages/contract/src/plugin.ts`
- `packages/plugin-sdk/src/index.ts`

## Rollback Points

- Cloud schema/API can be rolled back as one collab-api slice.
- Desktop home UI can be rolled back independently from Tauri runtime.
- Tauri runtime can remain compiled but hidden if CLI integration blocks.
- SDK capability additions are additive; do not break existing plugin SDK behavior.

## Definition Of Done

- Parent and child Trellis artifacts are complete.
- All implementation child tasks are complete or explicitly marked blocked.
- Automatic validation passes.
- Real CLI matrix passes for Claude Code, Codex, OpenCode.
- If any CLI fails due to missing installation/auth/model, the task remains blocked and final report says so directly.