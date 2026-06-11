# ADR-0003：持久化用 PostgreSQL，服务端用 Rust + axum

- **状态**：Superseded by current implementation note（当前实现以 SQLite 为准）
- **日期**：2026-06-09
- **关联**：[多租户后台](../03-backend-and-llm.md)、[领域模型](../02-domain-and-plugins.md)

> 当前代码与 README 已采用内嵌 SQLite：`Config::from_env()` 默认 `sqlite:lingfang.db?mode=rwc`，启动时自动建库并运行迁移。本文保留历史决策背景，不作为当前运行配置依据。

---

## 背景

旧版号称多租户 SaaS，实际 `persistence_mode` 默认退化到内存/文件，项目自己的 readiness gate 都把它标成 **blocker**。即「多租户后台」跑起来是单机模拟。同时，桌面壳已定 Rust（Tauri 2），服务端语言若另选会造成技术栈割裂。

## 决策

### 持久化
- **PostgreSQL，首发即真实 DB。** 服务端启动若未配 `DATABASE_URL` **直接报错退出**——取消「内存/文件 demo 默认」。
- 表结构对应 [02 领域模型](../02-domain-and-plugins.md)，迁移纳入版本控制。

### 服务端语言：Rust + axum
- 定 **Rust + axum + sqlx**：与 Tauri 核**同一门语言**（产品前后端统一、不割裂）、性能好、SQL 编译期校验。
- 曾考虑 Node（Fastify/NestJS + Prisma），因会让壳(Rust)与服务端(TS)两套栈割裂而否决。
- 契约仍以**语言无关**方式定义在 `packages/contract`（TS 为权威来源），Rust 端按同字段实现。

## 理由

1. 关系型 + PG 是多租户隔离、事务、审计的稳妥默认。
2. 「无 demo 默认」从根上杜绝「跑起来像 SaaS、其实单机」的自欺。
3. 全栈统一 Rust，减少语言切换成本与契约漂移。

## 取舍 / 代价

- Rust 服务端开发门槛高于 Node——换来全栈语言统一 + 性能 + 编译期安全。
- 开发需起本地 PG（`docker-compose`），比内存兜底重，但这正是「真实多租户」该付的代价，且可重复验证。

## 后果

- 服务端技术栈锁定：**Rust + axum + sqlx + PostgreSQL**。
- M0 验收必须命中真实 PG 且重启数据不丢（见 [04 §7](../03-backend-and-llm.md)）。
