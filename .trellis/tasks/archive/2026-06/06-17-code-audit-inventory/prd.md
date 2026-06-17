# 代码检查与审计清单

## Goal

建立全库代码现状的证据清单，为 spec 更新、规范修复和大文件拆分提供输入。

## Input Conditions

- 当前 `main` 工作树源码。
- 根 `package.json`、各 package `package.json`、`apps/desktop/src-tauri/Cargo.toml`。
- 当前 `.trellis/spec/**`。
- 排除 `node_modules`、`dist`、`build`、`target`、`coverage`、锁文件、生成 schema 和历史证据文件。

## Output Conditions

- 生成 `.trellis/tasks/06-17-code-audit-inventory/audit.md`。
- 审计报告必须包含：
  - package 和 spec 覆盖矩阵。
  - 可运行质量命令矩阵。
  - 源码大文件清单，区分 `>1500`、`1000-1500`、测试/生成/证据文件。
  - 高风险模块和职责边界初判。
  - 需要进入 `spec-update`、`quality-fixes`、`large-file-refactor` 的事项列表。

## Requirements

- 审计阶段不修改业务代码。
- 所有发现必须能追溯到文件路径、命令输出或 spec 文档。
- 不能把未运行的命令写成已通过。
- 对无法运行的命令记录真实失败原因。

## Acceptance Criteria

- [x] `audit.md` 存在并包含输入/输出所列章节。
- [x] 行数扫描覆盖 TypeScript、TSX、JavaScript、Rust、Go、Python、Vue、Svelte、CSS、Markdown 和 JSON 中的源码相关文件。
- [x] 每个超过 1000 行的源码候选都有分类和后续处理建议。
- [x] 每个 package 至少列出 typecheck/test/build/lint 的存在情况。
- [x] 审计报告明确下一步 spec 更新和重构输入。

## Completion Evidence

- `audit.md` records package/spec coverage, quality command matrix, large-file inventory, risk-module boundaries, and inputs for `spec-update`, `quality-fixes`, and `large-file-refactor`.
- No business code was modified in this child task.
