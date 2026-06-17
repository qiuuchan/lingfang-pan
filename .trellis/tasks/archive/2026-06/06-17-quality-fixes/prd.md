# 规范检查与修复

## Goal

按更新后的 spec 和审计结果修复明确的代码质量问题，保证后续大文件拆分建立在可靠基线上。

## Input Conditions

- `.trellis/tasks/06-17-code-audit-inventory/audit.md`。
- 已更新的 `.trellis/spec/**`。
- 当前自动化检查命令和失败输出。

## Output Conditions

- 代码质量问题被修复。
- 对应验证命令通过，或真实失败原因被记录并关联到后续任务。
- 修复摘要写入任务文档。

## Requirements

- 不新增静默 fallback、mock 成功路径、吞错逻辑或只为通过检查而添加的边界规则。
- 优先修复类型错误、测试失败、过时引用、明显死代码和重复逻辑。
- 每个修复保持职责局部化，不把大文件拆分混入本任务。
- 后端单元测试必须使用 60 秒硬超时。

## Acceptance Criteria

- [x] 所有审计列为必须修复的问题均已处理或有明确阻塞证据。
- [x] 相关 typecheck/test/build/lint 命令有记录。
- [x] 修改后的代码与 spec 一致。
- [x] 没有新增 mock/simulation fake success 或隐藏真实错误的 fallback。
- [x] 大文件拆分仍留给 `large-file-refactor` 子任务处理。

## Fix Summary

- Fixed Windows Python interpreter discovery for plugin script preview:
  - `find_binary()` kept the old first-match behavior for callers that need it.
  - Added `find_binaries()` / `find_binaries_in_path()` to enumerate every same-name executable on `PATH`.
  - Updated `probe_script_runtime()` to validate all candidate paths, so a broken `py.exe` or WindowsApps Store stub no longer blocks a later working Python.
  - Updated Python runtime tests to reuse the real probe path.
  - Added `code_assistant::tests::find_binaries_in_path_keeps_later_matches`.
- Updated `.trellis/spec/lingfang-desktop/backend/plugin-runtime-persistence.md` with the Windows Python discovery contract.

## Validation Evidence

- `pnpm -C apps/collab-api typecheck` passed.
- `pnpm -C apps/collab-admin typecheck` passed.
- `pnpm -C apps/desktop typecheck` passed.
- `pnpm -C packages/contract typecheck` passed.
- `pnpm -C packages/plugin-sdk typecheck` passed.
- `pnpm -C apps/collab-api test` passed: 24 files, 332 tests.
- `pnpm -C apps/collab-api test` with 60 second timeout passed: 24 files, 332 tests, 6.09s.
- `pnpm -C apps/desktop test` passed: 6 files, 184 tests.
- `pnpm -C packages/contract test` passed: 6 tests.
- `cargo test -p lingfang-desktop` initially failed on two Python preview tests with exit code 101, then passed after the fix: 190 tests.
- `cargo fmt --check` passed.
- `pnpm -C apps/collab-api build` passed.
- `pnpm -C apps/collab-admin build` passed when run serially.
- `pnpm -C apps/desktop vite:build` passed when run serially.
- `pnpm -r lint` ran and reported no selected package has a `lint` script; not a code failure.
