# server 后端规范

> ⚠️ **已废弃（2026-06-13）**：本目录描述的 Rust 后端 apps/server 已删除，后端能力统一由 NestJS apps/collab-api 提供（见 .trellis/spec/lingfang-desktop 或 docs/collab-api.md）。以下内容保留为历史设计参考，不再作为实现依据。

## Scope

适用于 `apps/server/`：Rust + axum + sqlx + SQLite 的多租户服务端。它负责身份、租户、草稿生成、发布、市场、钱包、LLM 网关和审计。

## Pre-Development Checklist

- 改 route、鉴权、错误码或平台管理员逻辑时，先读 [http-auth-and-errors.md](./http-auth-and-errors.md)。
- 改 schema、SQL、迁移、事务或钱包/市场写路径时，先读 [database-and-transactions.md](./database-and-transactions.md)。
- 改 LLM 绑定、生成、流式、运行时代理或审计时，先读 [llm-generation-and-audit.md](./llm-generation-and-audit.md)。
- 改测试、模块边界或启动行为时，先读 [quality-and-tests.md](./quality-and-tests.md)。
- 跨前端或 contract 时，同时读 `.trellis/spec/desktop/frontend/` 和 `.trellis/spec/contract/`。

## Current Reality

README 和当前代码以 SQLite 为准：`Config::from_env()` 默认 `sqlite:lingfang.db?mode=rwc`，`db::connect_and_migrate()` 自动建库并跑 `apps/server/migrations/`。旧文档中 PostgreSQL 表述是历史痕迹，不要作为新实现依据。

## Quality Check

- Backend unit tests: `cargo test -p server`
- Full workspace Rust tests when Tauri changes are nearby: `cargo test`
