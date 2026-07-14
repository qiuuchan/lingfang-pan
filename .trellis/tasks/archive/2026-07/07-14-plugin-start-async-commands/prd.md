# 修复插件启动同步命令阻塞主线程导致窗口未响应

## Goal

插件启动（venv 创建 / pip install / pnpm install 阶段）时桌面端窗口不再"未响应"，且 `plugin:output` / `plugin:start-progress` 事件能实时流到前端日志面板。

## Background / Root Cause

桌面端是 Tauri 2 应用。三个插件启动命令——`start_installed_plugin`（`plugin_package_manager/commands.rs`）、`start_plugin`（`plugin_runner.rs:1355`）、`start_builtin_plugin`（`main.rs:54`）——都是 **同步** `#[tauri::command]`，却在主线程（webview 事件循环线程）上执行 `start_plugin_from_dir`，后者包含几十秒到数分钟的阻塞子进程等待：

- `ensure_python_venv`：`python -m venv` + `pip install -r requirements.txt`（超时 600s）
- `ensure_node_dependencies`：`pnpm install`（超时 600s）

Tauri 2 同步命令跑在主线程上（async 命令才会丢到 tokio 线程池——`download_plugin_release`、`plugin_net_fetch` 已是 async）。主线程被阻塞导致：

1. **窗口"未响应"**：OS 标记窗口无响应（无法拖动/点击/关闭）。
2. **"动画正常"**：webview 的 CSS 合成器线程（spinner 的 transform/opacity 动画）独立于主线程，仍能继续。
3. **"没有安装环境输出"**：`start_plugin_from_dir` 内 `app.emit("plugin:output")` / `app.emit("plugin:start-progress")` 事件需要主线程参与投递，阻塞期间全部排队，直到命令返回才一次性 flush。前端虽提前订阅（`plugin-status.ts:217/230`），但阻塞期间收不到。

## Requirements

- `start_installed_plugin`、`start_plugin`、`start_builtin_plugin` 改为 `async fn`，把 `start_plugin_from_dir`（venv/deps/spawn 全流程）经 `tauri::async_runtime::spawn_blocking` 丢到阻塞线程池，不占主线程。
- 事件 emit 语义不变：仍由 `start_plugin_from_dir` 内部经 `StreamCtx` / `emit_stage` 发 `plugin:output` / `plugin:start-progress`；从 worker 线程 emit，主线程空闲即可实时投递。
- 前端契约不变：`tauriInvoke('start_installed_plugin', ...)` 仍返回 Promise<{pid, started_at}>，前端无需改动。
- 错误传播不变：venv/pip/pnpm 失败、进程秒退等错误仍以 `Err(String)` 返回，前端展示一致。
- `start_installed_plugin` 前后的快速步骤（`selected_release`、`mark_dependency_status`、`activate_pending` / `discard_pending`）保持在 async 命令体内直接执行（毫秒级 JSON 读写，无需 offload）。

## Out of Scope

- `install_plugin_artifact`（本地 .lfplugin 解包）：是同步命令但仅做 ZIP 校验/解压，秒级完成，不是本次卡顿来源；暂不改，留作后续观察。
- 运行时"按需下载"改造（记忆 runtime-on-demand-resolver）：与本次无关，当前代码仍用内置 `runtimes/`。

## Acceptance Criteria

- [ ] 启动一个需要首次创建 venv + pip install 的 Python 插件时，窗口可正常拖动/点击，标题栏不出现"未响应"。
- [ ] 启动过程中前端日志面板能逐行实时看到 venv 创建 / pip install 输出（不再卡住后一次性刷出）。
- [ ] 启动一个需要 pnpm install 的 Node 插件时，窗口保持响应且能实时看到 pnpm 输出。
- [ ] 冷启动后已有 venv/node_modules（秒过路径）的插件仍正常启动，返回 pid。
- [ ] venv/pip/pnpm 失败时，错误信息与改前一致地展示（前端不感知命令是否 async）。
- [ ] `cargo check` / `cargo clippy`（desktop crate）无新增 warning。
- [ ] stop/exit 流程不回归：启动后能正常 stop，进程退出仍 emit `plugin:exited`。
