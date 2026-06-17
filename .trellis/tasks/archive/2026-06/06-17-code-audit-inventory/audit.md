# 代码审计清单

## Scope

审计目标：为全库 spec 更新、规范修复和大文件拆分提供证据输入。

审计范围：
- `apps/**`
- `packages/**`
- `plugins/**`
- `.trellis/spec/**`
- 根 `package.json`

排除范围：
- `node_modules/**`
- `dist/**`
- `build/**`
- `target/**`
- `coverage/**`
- 锁文件
- `apps/desktop/src-tauri/gen/**` 生成 schema
- `docs/evidence/**` 历史证据文件

本报告只记录当前状态和后续输入，不声明任何质量命令已经通过。

## Package Matrix

| Area | Path | Manifest | Runtime | Spec status |
| --- | --- | --- | --- | --- |
| Desktop app | `apps/desktop` | `apps/desktop/package.json` | React + Vite + Tauri frontend | Covered by `.trellis/spec/desktop/frontend` and `.trellis/spec/desktop/backend` |
| Tauri shell | `apps/desktop/src-tauri` | `apps/desktop/src-tauri/Cargo.toml` | Rust + Tauri 2 | Covered by `.trellis/spec/lingfang-desktop/backend` |
| Collab API | `apps/collab-api` | `apps/collab-api/package.json` | NestJS + Prisma + Vitest | No dedicated `.trellis/spec/collab-api`; current guidance is scattered under deprecated `.trellis/spec/server/backend` and cross-package specs |
| Collab admin | `apps/collab-admin` | `apps/collab-admin/package.json` | React + Vite admin frontend | No dedicated `.trellis/spec/collab-admin` |
| Contract | `packages/contract` | `packages/contract/package.json` | TypeScript + zod | Covered by `.trellis/spec/contract/backend` and `.trellis/spec/contract/frontend` |
| Plugin SDK | `packages/plugin-sdk` | `packages/plugin-sdk/package.json` | TypeScript SDK | Covered by `.trellis/spec/plugin-sdk/backend` and `.trellis/spec/plugin-sdk/frontend` |
| UI tokens | `packages/ui-tokens` | `packages/ui-tokens/package.json` | CSS package | Covered by `.trellis/spec/ui-tokens/frontend` |
| Summarizer plugin | `plugins/summarizer` | no package.json; `manifest.json` + `ui/index.html` | Builtin plugin asset | Covered by `.trellis/spec/summarizer/backend` and `.trellis/spec/summarizer/frontend` |

Spec update inputs:
- Add or relocate current `apps/collab-api` guidance away from deprecated `server/backend`.
- Add admin frontend guidance for `apps/collab-admin`, or explicitly map it under a current package/layer.
- Keep deprecated server docs as history only.

## Quality Command Matrix

Commands found in manifests:

| Area | typecheck | test | build | lint |
| --- | --- | --- | --- | --- |
| Root | `pnpm -r typecheck` | `pnpm -r test` | `pnpm -C apps/collab-api build`, `pnpm -C apps/collab-admin build`, distribution scripts | `pnpm -r lint` |
| `apps/desktop` | `pnpm -C apps/desktop typecheck` | `pnpm -C apps/desktop test` | `pnpm -C apps/desktop vite:build`, `pnpm -C apps/desktop build` | no package-level lint script observed |
| `apps/desktop/src-tauri` | n/a | `cargo test -p lingfang-desktop` | Tauri build via `apps/desktop` | n/a |
| `apps/collab-api` | `pnpm -C apps/collab-api typecheck` | `pnpm -C apps/collab-api test` | `pnpm -C apps/collab-api build` | no package-level lint script observed |
| `apps/collab-admin` | `pnpm -C apps/collab-admin typecheck` | no package-level test script observed | `pnpm -C apps/collab-admin build` | no package-level lint script observed |
| `packages/contract` | `pnpm -C packages/contract typecheck` | `pnpm -C packages/contract test` | no package-level build script observed | no package-level lint script observed |
| `packages/plugin-sdk` | `pnpm -C packages/plugin-sdk typecheck` | no package-level test script observed | no package-level build script observed | no package-level lint script observed |
| `packages/ui-tokens` | no script observed | no script observed | no script observed | no script observed |
| `plugins/summarizer` | no package manifest | no package manifest | no package manifest | no package manifest |

Verification policy:
- Backend unit tests must be wrapped with a 60 second timeout.
- This audit did not run these commands; later tasks must record real pass/fail output.

## Large File Inventory

Line-count command used:

```powershell
$results = @(); $items = rg --files -g '!node_modules/**' -g '!dist/**' -g '!build/**' -g '!target/**' -g '!coverage/**' -g '!*.lock' -g '!pnpm-lock.yaml' -g '!package-lock.json' -g '!yarn.lock' -g '!apps/desktop/src-tauri/gen/**' -g '!docs/evidence/**'; foreach ($p in $items) { $ext = [IO.Path]::GetExtension($p); if ($ext -in '.ts','.tsx','.js','.jsx','.mjs','.cjs','.rs','.go','.py','.vue','.svelte','.css','.scss','.md','.json') { $n = (Get-Content -LiteralPath $p | Measure-Object).Count; if ($n -ge 300) { $results += [pscustomobject]@{ Lines = $n; Path = $p } } } }; $results | Sort-Object Lines -Descending | Select-Object -First 40 | Format-Table -AutoSize
```

### Must Split: >1500 Lines

| Lines | Path | Classification | Next task |
| ---: | --- | --- | --- |
| 3782 | `apps/desktop/src-tauri/src/code_assistant.rs` | Source; very high priority | `large-file-refactor` |
| 1594 | `apps/desktop/src/lib/plugin-draft.ts` | Source; high priority | `large-file-refactor` |

### Split Or Justify: 1000-1500 Lines

| Lines | Path | Classification | Next task |
| ---: | --- | --- | --- |
| 1441 | `apps/desktop/src/pages/PluginCreatorHome.tsx` | Source; split recommended | `large-file-refactor` |
| 1211 | `apps/desktop/src/lib/plugin-draft.spec.ts` | Test; split by parser/draft/manifest themes after source split | `large-file-refactor` |
| 1209 | `apps/desktop/src-tauri/src/plugin_store.rs` | Source; split recommended | `large-file-refactor` |
| 1129 | `apps/desktop/src-tauri/src/plugin_runner.rs` | Source; split recommended | `large-file-refactor` |
| 1066 | `apps/collab-admin/src/components/settings-view.tsx` | Source; split recommended | `large-file-refactor` |
| 1063 | `apps/desktop/src-tauri/src/plugin_script.rs` | Source; split recommended | `large-file-refactor` |

### Near Threshold: 800-999 Lines

| Lines | Path | Classification | Next task |
| ---: | --- | --- | --- |
| 983 | `apps/collab-api/src/modules/admin.service.spec.ts` | Test; monitor after service split | `large-file-refactor` if related code changes |
| 954 | `apps/desktop/src-tauri/src/cli_installer.rs` | Source; monitor | `large-file-refactor` optional |
| 938 | `apps/collab-api/src/modules/admin.service.ts` | Source; monitor | `quality-fixes`/future split |
| 891 | `apps/desktop/src-tauri/src/code_assistant/store.rs` | Source; monitor | after `code_assistant.rs` split |
| 862 | `apps/collab-admin/src/components/plugins-view.tsx` | Source; monitor | admin frontend follow-up |

Generated or evidence files excluded from refactor target:
- `apps/desktop/src-tauri/gen/schemas/*.json`
- `docs/evidence/**`

## Risk Modules And Responsibility Boundaries

### `apps/desktop/src-tauri/src/code_assistant.rs`

Current observed responsibilities:
- CLI adapter module wiring.
- `CodeAssistantState` and persistent `AssistantStore` access.
- tool availability/probe input/output DTOs.
- workspace resolution.
- process spawning and process tree cleanup.
- transcript/event emission.
- session lifecycle commands.
- CLI config preparation integration.

Recommended split:
- `code_assistant/mod.rs` for exports and Tauri commands.
- `code_assistant/state.rs` for `CodeAssistantState`.
- `code_assistant/process.rs` for process tree and kill/wait helpers.
- `code_assistant/workspace.rs` for workspace resolution.
- `code_assistant/probe.rs` for availability and probe flow.
- `code_assistant/session.rs` for session lifecycle.
- keep `code_assistant/store.rs` and `code_assistant/adapters/**`.

### `apps/desktop/src/lib/plugin-draft.ts`

Current observed responsibilities:
- provider constants and labels.
- tool card parsing and ask-user extraction.
- transcript parsing and title summarization.
- structured package parsing.
- draft build/merge logic.
- manifest parsing.
- preview document generation.
- local recent plugins storage.
- structure diagnostics.

Recommended split:
- `plugin-draft/providers.ts`
- `plugin-draft/transcript.ts`
- `plugin-draft/tool-cards.ts`
- `plugin-draft/structured-package.ts`
- `plugin-draft/builders.ts`
- `plugin-draft/manifest.ts`
- `plugin-draft/preview.ts`
- `plugin-draft/recent.ts`
- `plugin-draft/diagnostics.ts`

### `apps/desktop/src/pages/PluginCreatorHome.tsx`

Current observed responsibilities:
- page-level state.
- CLI/provider/model readiness.
- session start/stop/send controls.
- local plugin loading.
- upload/review flow.
- draft merge and conversation handling.
- layout composition.

Recommended split:
- route/page shell stays in `PluginCreatorHome.tsx`.
- stateful hooks under `components/creator` or `lib/plugin-creator`.
- upload/review actions in a small API helper.
- presentational panels stay in `components/creator/**`.

### `apps/desktop/src-tauri/src/plugin_store.rs`

Current observed responsibilities:
- plugin root config.
- path sanitization and canonicalization.
- manifest scanning.
- runtime/status normalization.
- local file read/write.
- plugin rename and cleanup helpers.
- tests.

Recommended split:
- `plugin_store/mod.rs`
- `plugin_store/config.rs`
- `plugin_store/path.rs`
- `plugin_store/manifest.rs`
- `plugin_store/status.rs`
- `plugin_store/files.rs`

### `apps/desktop/src-tauri/src/plugin_runner.rs`

Current observed responsibilities:
- manifest runtime parsing.
- Python venv management.
- Node dependency install.
- process table.
- start/stop/status Tauri commands.
- detached process launch.

Recommended split:
- `plugin_runner/mod.rs`
- `plugin_runner/manifest.rs`
- `plugin_runner/python.rs`
- `plugin_runner/node.rs`
- `plugin_runner/process_table.rs`
- `plugin_runner/commands.rs`

### `apps/desktop/src-tauri/src/plugin_script.rs`

Current observed responsibilities:
- runtime probing.
- environment sanitization.
- script entry/path validation.
- sandbox materialization.
- run/capture with timeout.
- sandbox cleanup.
- tests.

Recommended split:
- `plugin_script/mod.rs`
- `plugin_script/probe.rs`
- `plugin_script/env.rs`
- `plugin_script/path.rs`
- `plugin_script/sandbox.rs`
- `plugin_script/run.rs`

### `apps/collab-admin/src/components/settings-view.tsx`

Current observed responsibilities:
- platform settings form.
- SMTP settings form.
- Geetest settings form.
- Gitee settings form.
- secret reveal/test actions.
- layout and loading states.

Recommended split:
- `settings-view.tsx` page shell.
- `settings/platform-form.tsx`
- `settings/smtp-form.tsx`
- `settings/geetest-form.tsx`
- `settings/gitee-form.tsx`
- shared settings hooks/API helpers.

## Quality Findings For Later Tasks

### Spec coverage gaps

- `apps/collab-api` has no dedicated current spec despite being the active backend.
- `apps/collab-admin` has no dedicated frontend spec despite containing large admin components.
- `.trellis/spec/server/backend/index.md` is explicitly deprecated but several useful collab-api notes remain under it; move current NestJS guidance into a current spec namespace.

### Threshold mismatch

- Global AGENTS rules state file size hard limit is 300 lines.
- User goal asks to split files over 1000-1500 lines.
- Current codebase has many source files over 300 lines, so immediate remediation should follow the user's explicit 1000-1500 threshold while spec update records a practical staged policy:
  - mandatory now: `>1500`;
  - split or justify now: `1000-1500`;
  - monitor and opportunistically split: `300-999`.

### Fallback and silent behavior review targets

The search found multiple intentional UI fallbacks and test mocks. These are not automatically defects. Items needing review in `quality-fixes`:
- `apps/desktop/src-tauri/src/plugin_store.rs:176` silently skips unreadable plugin root during startup cleanup.
- `apps/desktop/src-tauri/src/plugin_script.rs:443` silently skips unreadable sandbox cleanup directory.
- `apps/desktop/src/components/creator/panels/ScriptPreviewPanel.tsx:139` silently ignores scan failure.
- `apps/desktop/src/pages/PluginCreatorHome.tsx:218` catches tool/model list failure and falls back to bundled providers.

Allowed examples that should not be treated as defects without further evidence:
- React `Suspense fallback`.
- display fallback labels/icons.
- test mocks in `*.spec.ts`.
- `.env` fallback where spec explicitly documents first-run compatibility.

## Inputs To `spec-update`

- Create or update current collab backend spec for `apps/collab-api`.
- Create or update admin frontend spec for `apps/collab-admin`.
- Add large-file policy and staged thresholds to relevant spec docs.
- Update desktop frontend spec to mention plugin draft and creator page extraction boundaries.
- Update lingfang-desktop backend spec to mention Rust module split policy for Tauri command files.
- Ensure deprecated `server/backend` docs point to the current collab-api spec for active backend rules.

## Inputs To `quality-fixes`

- Verify fallback/silent behavior review targets above.
- Run scoped typecheck/test/build commands before changing behavior.
- Do not convert failures into hidden fallbacks.
- Wrap backend tests with a 60 second timeout.

## Inputs To `large-file-refactor`

Priority order:
1. `apps/desktop/src-tauri/src/code_assistant.rs`
2. `apps/desktop/src/lib/plugin-draft.ts`
3. `apps/desktop/src/pages/PluginCreatorHome.tsx`
4. `apps/desktop/src-tauri/src/plugin_store.rs`
5. `apps/desktop/src-tauri/src/plugin_runner.rs`
6. `apps/desktop/src-tauri/src/plugin_script.rs`
7. `apps/collab-admin/src/components/settings-view.tsx`
8. `apps/desktop/src/lib/plugin-draft.spec.ts`

Each refactor must record:
- split boundary;
- files created;
- public API retained or changed;
- validation command and result.
