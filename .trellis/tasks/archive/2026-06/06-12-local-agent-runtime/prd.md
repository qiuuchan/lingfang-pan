# 本地代码助手运行时

## Goal

在 Tauri 后端实现真实本地代码助手运行时，支持 Claude Code、Codex、OpenCode 的真实 CLI 发现、版本检查、可用性探测、模型选择、会话运行、输出事件、transcript 和进程清理。

## Confirmed Facts

- `apps/desktop/src-tauri/src/main.rs` 当前只有插件列表、插件文件读取、capability 调用命令。
- `apps/desktop/src-tauri/src/capability.rs` 当前只实现 `fs.read` 和 `system.info`。
- 项目要求对齐 AionUi 的 adapter、进程注册、健康检查和运行实例思想，但采用 Tauri Rust 原生实现。
- 用户要求真实 CLI 调用，不接受 mock、fake adapter 或只跑 `--help` 的验证。

## Requirements

- 新增 Tauri code assistant 模块。
- 支持 Claude Code、Codex、OpenCode 三个 adapter。
- 每个 adapter 支持真实二进制发现、版本检查、最小响应探测、模型参数、会话启动、停止和输出归一化。
- 提供 Tauri commands 和 events 给前端。
- 保存本地配置、session metadata、transcript 和进程注册表。
- 启动时清理上次异常退出遗留进程。
- 运行失败必须返回真实 stdout/stderr/exit code 和诊断。

## Acceptance Criteria

- [ ] `code_assistant_list_tools` 返回三个工具及其状态。
- [ ] `code_assistant_check_tool` 能真实检查路径和版本。
- [ ] `code_assistant_run_probe` 对每个工具执行真实最小响应，不使用 mock。
- [ ] `code_assistant_start_session` 能启动真实 CLI 会话并发出事件。
- [ ] stdout/stderr/exit code 被记录到 transcript。
- [ ] `code_assistant_stop_session` 能停止进程。
- [ ] 应用启动时能清理进程注册表中的遗留进程。
- [ ] 缺失安装、未登录、模型不可用时返回真实失败状态。
- [ ] Rust 测试通过。

## Out Of Scope

- 不做云端运行代码助手。
- 不实现多 Agent 编排。
- 不处理远程平台插件直接控制本机 CLI。
