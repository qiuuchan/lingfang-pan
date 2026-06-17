# lingfang-desktop 后端规范

## Scope

适用于 `apps/desktop/src-tauri/`：Tauri 2 Rust 壳层。它负责内置插件加载、本地资源读取和本机 capability 网关，不负责租户数据、市场、钱包或 LLM 网关。

## Pre-Development Checklist

- 改内置插件扫描、manifest 解析或资源目录时，先读 [plugin-loading.md](./plugin-loading.md)。
- 改用户/AI 创建插件的持久化目录、venv/pnpm 运行、进程管理、命名链路时，先读 [plugin-runtime-persistence.md](./plugin-runtime-persistence.md)。
- 改本地能力、路径校验或 Tauri command 时，先读 [capability-gateway.md](./capability-gateway.md)。
- 改检查更新、tauri-plugin-updater、版本发布契约时，先读 [updater-integration.md](./updater-integration.md)。
- 改 NSIS 安装器配置、打包命令、customLanguageFiles、resources 打包时，先读 [nsis-installer.md](./nsis-installer.md)。
- 改构建配置、命令或测试时，先读 [quality.md](./quality.md)。
- 同时改前端 iframe 运行时，读 `.trellis/spec/desktop/frontend/api-streaming-and-runtime.md`。

## Runtime Boundary

Tauri backend only serves builtin/local capabilities. Published database plugins run through the desktop frontend iframe plus server APIs.

## Quality Check

- Tauri/Rust compile and tests: `cargo test -p lingfang-desktop`
- Full Rust workspace when server interfaces changed: `cargo test`
