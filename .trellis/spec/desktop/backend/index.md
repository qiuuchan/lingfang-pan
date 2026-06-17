# @lingfang/desktop 后端桥接规范

## Scope

适用于 `apps/desktop` 视角下跨前端与 Tauri 后端的插件/CLI 架构说明。真正的 Rust 命令、进程管理、插件持久化和能力网关实现规范归属 `.trellis/spec/lingfang-desktop/backend/`。

## Pre-Development Checklist

- 修改插件创建、插件运行、CLI 配置注入或桌面/后端交互流程时，先读 [plugin-system-architecture.md](./plugin-system-architecture.md)。
- 修改 Rust Tauri 实现时，同时读 `.trellis/spec/lingfang-desktop/backend/index.md` 及其指向的具体规范。
- 同时改前端 iframe、API、SSE 或 Tauri 调用时，读 `.trellis/spec/desktop/frontend/api-streaming-and-runtime.md`。

## Package Shape

- `apps/desktop/src/` 是 React/Tauri 前端工作台。
- `apps/desktop/src-tauri/` 是独立的 `lingfang-desktop` Rust 包，后端实现规范以该包为准。
- 本层只记录桌面包视角的跨层架构，不新增第二套 Rust 实现规则。

## Quality Check

- 桌面前端类型检查：`pnpm -C apps/desktop typecheck`
- 桌面前端构建：`pnpm -C apps/desktop vite:build`
- Tauri/Rust 测试：`cargo test -p lingfang-desktop`
