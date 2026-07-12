# lingfang-desktop 后端规范

## Scope

适用于 `apps/desktop/src-tauri/`：Tauri 2 Rust 壳层。它负责内置插件加载、本地资源读取和本机 capability 网关，不负责租户数据、市场、钱包或 LLM 网关。

## Pre-Development Checklist

- 改内置插件扫描、manifest 解析或资源目录时，先读 [plugin-loading.md](./plugin-loading.md)。
- 改用户/AI 创建插件的持久化目录、venv/pnpm 运行、进程管理、命名链路时，先读 [plugin-runtime-persistence.md](./plugin-runtime-persistence.md)。
- 改 `.lfplugin`、安装账本、更新/回滚/卸载或草稿工作区时，先读 [plugin-package-manager.md](./plugin-package-manager.md)。
- 改本地能力、路径校验或 Tauri command 时，先读 [capability-gateway.md](./capability-gateway.md)。
- 改代码助手对话引擎（SSE 流式、思考内容、工具调用、多轮续轮）时，先读 [sdk-runtime-engine.md](./sdk-runtime-engine.md)。
- 改检查更新、tauri-plugin-updater、版本发布契约时，先读 [updater-integration.md](./updater-integration.md)。
- 改 NSIS 安装器配置、打包命令、customLanguageFiles、resources 打包时，先读 [nsis-installer.md](./nsis-installer.md)。
- 改构建配置、命令或测试时，先读 [quality.md](./quality.md)。
- 同时改前端 iframe 运行时，读 `.trellis/spec/desktop/frontend/api-streaming-and-runtime.md`。

## Runtime Boundary

Tauri backend only serves builtin/local capabilities. Published database plugins run through the desktop frontend iframe plus server APIs.

## File Size Policy

- `>1500` 行 Rust source 必须拆分。
- `1000-1500` 行 Rust source 默认拆分；保留必须在任务文档中写明职责单一的理由。
- `300-999` 行 source 进入监控；改动时优先抽 `state`、`process`、`path`、`manifest`、`commands`、`tests` 等职责模块。
- Tauri command 文件应保持薄入口：参数解析和 `tauri::command` 留在 command 层，路径校验、进程管理、manifest 解析和 IO 放 helper module。

## Quality Check

- Tauri/Rust compile and tests: `cargo test -p lingfang-desktop`
- Full Rust workspace when server interfaces changed: `cargo test`
