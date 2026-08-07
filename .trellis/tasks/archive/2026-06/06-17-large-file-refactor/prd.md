# 大文件拆分重构

## Goal

将超过维护阈值的源码文件拆分为职责明确的小模块，降低阅读、测试和后续修改成本。

## Input Conditions

- `.trellis/tasks/06-17-code-audit-inventory/audit.md` 中的大文件清单。
- 已更新的相关 `.trellis/spec/**`。
- 拆分前可运行的最小行为基线和验证命令。

## Output Conditions

- 超过 1500 行的源码文件完成拆分。
- 1000 到 1500 行的源码文件完成拆分，或在审计报告/任务文档中记录保留理由。
- 新模块命名、职责和公开 API 清晰。
- 相关验证命令通过并记录。

## Initial Candidates

- `apps/desktop/src-tauri/src/code_assistant.rs`：CLI 探测、会话生命周期、进程管理、workspace 解析、事件输出等职责混杂。
- `apps/desktop/src/lib/plugin-draft.ts`：provider 常量、transcript 解析、结构化包解析、draft 合并、manifest/preview/diagnostic 等职责混杂。
- `apps/desktop/src/pages/PluginCreatorHome.tsx`：页面状态、会话控制、上传/发布、UI 组合集中在单文件。
- `apps/desktop/src-tauri/src/plugin_store.rs`：配置、路径安全、manifest 扫描、状态合并集中在单文件。
- `apps/desktop/src-tauri/src/plugin_runner.rs`：manifest 解析、venv/pnpm 安装、进程表、运行命令集中在单文件。
- `apps/collab-admin/src/components/settings-view.tsx`：admin 设置 UI、状态和接口操作集中在单文件。
- `apps/desktop/src-tauri/src/plugin_script.rs`：探测、sandbox 写入、环境变量、执行和清理集中在单文件。

## Requirements

- 先补或确认行为基线，再拆分。
- 优先按稳定职责边界拆：types/constants、path/security、process/runtime、parser/normalizer、hooks/state、presentational UI。
- 拆分后不能制造跨模块循环依赖。
- 原调用方 API 尽量保持稳定；如必须改变，需要同步更新调用点和测试。
- 不拆生成文件、锁文件、构建产物和历史证据文件。

## Acceptance Criteria

- [x] `>1500` 行源码文件不再超过阈值。
- [x] `1000-1500` 行源码文件均已处理或有明确例外理由。
- [x] 拆分后的新文件职责单一，命名反映领域含义。
- [x] 相关 typecheck/test/build 命令通过。
- [x] 重新运行行数扫描并记录结果。

## Sub-Goal Results

### 1. Code Inspection

输入条件：

- 当前源码树、已有 `.trellis/spec/**`、已归档审计任务的大文件清单。
- 排除 `node_modules`、`target`、`dist`、`build`、生成 schema、锁文件和历史证据文件。

输出条件：

- 确认可拆源码候选：`code_assistant.rs`、`plugin-draft.ts`、`PluginCreatorHome.tsx`、`plugin_store.rs`、`plugin_runner.rs`、`plugin_script.rs`、`settings-view.tsx`、`plugin-draft.spec.ts`、`code_assistant/tests.rs`。
- 确认例外类别：`Cargo.lock`、`apps/desktop/src-tauri/gen/schemas/*.json`。

### 2. Spec Update

输入条件：

- 拆分过程中确认的稳定职责边界。
- Rust reader 测试并发假失败根因：生产 reader 先写 transcript 后 emit event，测试若等待 transcript 行数会早于最后一次 emit 断言。
- 前端/后台拆分后的模块组织。

输出条件：

- 更新 backend/frontend/admin spec，记录大文件拆分边界、测试组织和 reader 测试同步规则。
- 不新增跨层 API 或运行时契约变更。

### 3. Refactor Split

输入条件：

- 拆分前测试基线：`cargo test -p lingfang-desktop`、`pnpm -C apps/desktop typecheck/test`、`pnpm -C apps/collab-admin typecheck`。
- 各候选文件的现有 import surface 和调用点。

输出条件：

- `apps/desktop/src-tauri/src/code_assistant.rs`：从 3824 行拆到 1305 行；新增 `process/`、`stream/`、拆分测试子模块。
- `apps/desktop/src/lib/plugin-draft.ts`：从 1594 行变为 6 行 barrel；实现拆到 `plugin-draft/*.ts`。
- `apps/desktop/src/lib/plugin-draft.spec.ts`：拆为 `plugin-draft/*.spec.ts`，单文件最大 388 行。
- `apps/desktop/src/pages/PluginCreatorHome.tsx`：抽 `PluginCreatorLayout`、上传命名 Dialog、creator hooks/helpers，主文件降至 1000-1500 监控区。
- `apps/desktop/src-tauri/src/plugin_store.rs`、`plugin_runner.rs`、`plugin_script.rs`：测试外置到同名子目录，主文件均低于 1000 行。
- `apps/collab-admin/src/components/settings-view.tsx`：抽 `settings/SettingsShared.tsx`，主文件降至 878 行。

## Remaining Exceptions

- `apps/desktop/src-tauri/src/code_assistant.rs` 1305 行：保留为明确例外。该文件已从 3824 行拆出 process、stream、tests 等职责，剩余主体主要是 Tauri command surface、session lifecycle 编排、store/process 连接和 event sink glue。继续拆需要单独设计 session orchestration 模块，否则容易把状态机和 command 注册割裂。
- `Cargo.lock` 4975 行：锁文件，不是源码拆分目标。
- `apps/desktop/src-tauri/gen/schemas/{desktop,macOS,windows}-schema.json` 各 2346 行：Tauri 生成 schema，不是源码拆分目标。

## Verification Evidence

- `cargo fmt`：通过。
- `cargo test -p lingfang-desktop`：190 passed。
- `pnpm -C apps/desktop typecheck`：通过。
- `pnpm -C apps/desktop test`：184 passed。
- `pnpm -C apps/collab-admin typecheck`：通过。
- 大文件扫描结果：除 `Cargo.lock`、生成 schema 和已记录例外 `code_assistant.rs` 外，无 1000+ 行源码文件。
