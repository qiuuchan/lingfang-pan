# 全库规范审计、spec 更新与大文件拆分

## Goal

对 `lingfang-platform` 做一次证据驱动的全库代码检查，更新 Trellis spec，按规范修复发现的问题，并将超过维护阈值的大源码文件拆分为职责清晰的小模块。

## Confirmed Facts

- 当前任务是父任务，拆成 4 个可独立验收的子任务：
  - `06-17-code-audit-inventory`
  - `06-17-spec-update`
  - `06-17-quality-fixes`
  - `06-17-large-file-refactor`
- 当前仓库包含桌面前端、Tauri/Rust 后端、NestJS collab API、admin 前端、contract、plugin-sdk、ui-tokens 和 summarizer。
- 当前只读行数扫描发现的超大源码候选：
  - `apps/desktop/src-tauri/src/code_assistant.rs` 3782 行
  - `apps/desktop/src/lib/plugin-draft.ts` 1594 行
  - `apps/desktop/src/pages/PluginCreatorHome.tsx` 1441 行
  - `apps/desktop/src-tauri/src/plugin_store.rs` 1209 行
  - `apps/desktop/src-tauri/src/plugin_runner.rs` 1129 行
  - `apps/collab-admin/src/components/settings-view.tsx` 1066 行
  - `apps/desktop/src-tauri/src/plugin_script.rs` 1063 行
- `apps/desktop/src-tauri/gen/schemas/*.json` 和 `docs/evidence/**` 属于生成或证据文件，不作为源码拆分目标。
- `.trellis/spec/server/backend/index.md` 标记为历史 Rust server 规范，当前实现重点是 `apps/collab-api`、`apps/desktop` 和 `apps/desktop/src-tauri`。

## Child Goals

### 1. Code audit inventory

输入条件：
- 当前工作树源码、`package.json` / package-level manifest、`Cargo.toml`、现有 `.trellis/spec/`。
- 排除 `node_modules`、构建产物、锁文件、生成 schema 和历史证据文件。

输出条件：
- 生成可复查的代码审计清单，包含大文件清单、测试命令矩阵、spec 覆盖矩阵、风险模块、问题列表和后续任务输入。

### 2. Spec update

输入条件：
- Code audit inventory 的审计结果。
- 当前 `.trellis/spec/**` 文档和实际代码行为。

输出条件：
- 更新后的 Trellis spec，反映当前代码边界、质量命令、模块拆分约束和已废弃实现说明。

### 3. Quality fixes

输入条件：
- 审计问题清单。
- 更新后的 spec。
- 现有测试、类型检查和构建命令。

输出条件：
- 规范问题被修复，自动化检查通过或失败原因被明确记录，且不引入静默 fallback、mock 成功路径或防御性遮蔽错误。

### 4. Large file refactor

输入条件：
- 超大源码候选清单。
- 对应模块 spec 和现有测试。
- 拆分前的行为基线。

输出条件：
- 超过 1500 行的源码文件必须拆分；1000 到 1500 行的源码文件按职责复杂度拆分或写明保留理由。
- 拆分后模块职责清晰，公开 API 稳定，相关检查通过。

## Requirements

- 先审计，再更新 spec，再修复，再拆分大文件；不能在没有证据和基线的情况下直接重构。
- 每个子任务必须有明确输入条件、输出条件和验收条件。
- spec 更新必须来自真实代码和审计结果，不写占位内容。
- 修复和拆分必须遵守项目规则：暴露真实错误、不新增静默 fallback、不添加 mock 成功路径。
- 后端单元测试运行时必须使用 60 秒硬超时。
- 拆分时优先保持行为不变，必要时先补回归测试或最小可验证检查。

## Acceptance Criteria

- [x] 父任务和 4 个子任务均有可执行 PRD，父任务包含子目标输入/输出条件。
- [x] Code audit inventory 产出审计清单，并能作为 spec 更新和修复的输入。
- [x] Spec update 修改相关 `.trellis/spec/**`，且每项修改能追溯到代码事实或审计发现。
- [x] Quality fixes 按审计结果完成必要修复，并运行对应验证命令。
- [x] Large file refactor 处理所有源码超阈值文件，生成文件结构和验证结果。
- [x] 最终全局检查证明没有未处理的源码超阈值文件，或每个保留项都有明确、可复查的例外理由。

## Final Source Size Evidence

最终 1000+ 行扫描仅剩：

- `Cargo.lock` 4975 行：锁文件。
- `apps/desktop/src-tauri/gen/schemas/{desktop,macOS,windows}-schema.json` 2346 行：Tauri 生成 schema。
- `apps/desktop/src-tauri/src/code_assistant.rs` 1305 行：已从 3824 行拆出 process、stream、tests 等职责；剩余为 Tauri command/session 编排入口，作为本轮明确例外记录在 `06-17-large-file-refactor/prd.md`。

最终验证证据：

- `cargo fmt`
- `cargo test -p lingfang-desktop`（190 passed）
- `pnpm -C apps/desktop typecheck`
- `pnpm -C apps/desktop test`（184 passed）
- `pnpm -C apps/collab-admin typecheck`

## Out Of Scope

- 不重构生成文件、锁文件、依赖目录、构建产物或历史证据文件。
- 不引入新的架构层、框架或兼容路径，除非审计证明现有结构无法维护。
- 不把测试失败包装成成功，不用 mock 输出替代真实执行。
