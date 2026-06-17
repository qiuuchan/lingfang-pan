# server 后端规范

> ⚠️ **已废弃（2026-06-13）**：本目录描述的 Rust 后端 apps/server 已删除，后端能力统一由 NestJS apps/collab-api 提供。当前后端实现规范见 `.trellis/spec/collab-api/backend/index.md`；桌面 Tauri 壳规范见 `.trellis/spec/lingfang-desktop/backend/index.md`；接口概览见 `docs/collab-api.md`。以下内容保留为历史设计参考，不再作为实现依据。

## Scope

适用于 `apps/server/`：Rust + axum + sqlx + SQLite 的多租户服务端。它负责身份、租户、草稿生成、发布、市场、钱包、LLM 网关和审计。

## Pre-Development Checklist

> 当前实现不要使用本 checklist。请改读 `.trellis/spec/collab-api/backend/index.md`。

- 改 route、鉴权、错误码或平台管理员逻辑时，先读 [http-auth-and-errors.md](./http-auth-and-errors.md)。
- 改 schema、SQL、迁移、事务或钱包/市场写路径时，先读 [database-and-transactions.md](./database-and-transactions.md)。
- 改 LLM 绑定、生成、流式、运行时代理或审计时，先读 [llm-generation-and-audit.md](./llm-generation-and-audit.md)。
- 改测试、模块边界或启动行为时，先读 [quality-and-tests.md](./quality-and-tests.md)。
- 跨前端或 contract 时，同时读 `.trellis/spec/desktop/frontend/` 和 `.trellis/spec/contract/`。

## Current Reality

当前真实后端是 `apps/collab-api`，使用 NestJS + Prisma，数据库 provider 由 `DATABASE_PROVIDER` / `DATABASE_URL` 解析，支持 PostgreSQL 和 MySQL。旧 `apps/server` 的 SQLite/Rust 描述只作为历史参考。

## Quality Check

- Current backend typecheck: `pnpm -C apps/collab-api typecheck`
- Current backend unit tests: `pnpm -C apps/collab-api test` with a 60 second timeout
- Current backend build: `pnpm -C apps/collab-api build`
