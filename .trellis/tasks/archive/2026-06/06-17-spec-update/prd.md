# Spec 更新

## Goal

根据审计结果和当前代码事实更新 `.trellis/spec/**`，让后续代码修复和拆分有准确规范可依。

## Input Conditions

- `.trellis/tasks/06-17-code-audit-inventory/audit.md`。
- 当前 `.trellis/spec/**`。
- 相关源码文件和 package manifest。

## Output Conditions

- 更新后的 `.trellis/spec/**`。
- 任务目录中记录 spec 更新摘要和证据来源。
- 明确哪些历史规范已废弃，哪些当前包边界和质量命令是权威依据。

## Requirements

- spec 只记录真实代码事实、稳定约定和可执行质量门槛。
- 不写占位章节，不复制过时 server 规范作为当前实现依据。
- 如果发现 package 缺 spec，需要补最小入口或在父任务中记录后续拆分边界。
- 大文件拆分规则必须写入相关 spec 或共享 guide，使后续任务能复用。

## Acceptance Criteria

- [x] 每个被修改的 spec 条目都能追溯到审计报告或源码事实。
- [x] `apps/collab-api` 的当前规范入口不再依赖已废弃 `apps/server` 说明。
- [x] `apps/desktop/src-tauri` 的 Rust 后端规范包含大文件拆分和模块职责边界要求。
- [x] `apps/desktop/src` 前端规范包含 creator/draft 大文件拆分方向。
- [x] Spec 更新后可作为 `quality-fixes` 和 `large-file-refactor` 的输入。

## Completion Evidence

- Added `collab-api` and `collab-admin` to `.trellis/config.yaml`; `get_context.py --mode packages` now discovers both packages and their spec layers.
- Added current backend specs under `.trellis/spec/collab-api/backend/`.
- Added admin frontend specs under `.trellis/spec/collab-admin/frontend/`.
- Updated `.trellis/spec/server/backend/index.md` to point active backend work to `collab-api` and preserve old server docs as history only.
- Updated `.trellis/spec/desktop/frontend/index.md` and added `plugin-creator-organization.md` for `PluginCreatorHome` / `plugin-draft` split boundaries.
- Updated `.trellis/spec/lingfang-desktop/backend/index.md` and `quality.md` with Rust module split policy.
