# collab-api 后端规范

## Scope

适用于 `apps/collab-api/`：NestJS + Prisma + Vitest 后端。它是当前协作平台后端，负责认证、团队、插件云端共享、市场、钱包、平台管理、发布更新、LLM 网关和审计。

历史 Rust `apps/server` 已删除；不要把 `.trellis/spec/server/backend/` 当作新实现依据。旧目录只保留历史参考，当前后端规则以本目录和相关 contract spec 为准。

## Pre-Development Checklist

- 改 API、错误码、认证、平台管理员、Prisma 查询、迁移或测试配置时，先读 [quality-and-contracts.md](./quality-and-contracts.md)。
- 改插件、市场、钱包、LLM 或跨桌面契约时，同时读 `.trellis/spec/contract/backend/index.md` 和 `.trellis/spec/desktop/frontend/api-streaming-and-runtime.md`。
- 改插件包、发行版、市场审核、权益或制品存储时，先读 [plugin-package-registry.md](./plugin-package-registry.md)。
- 改发布更新接口时，同时读 `.trellis/spec/lingfang-desktop/backend/updater-integration.md`。

## Package Shape

- `src/main.ts` 启动 Nest 应用并挂载全局过滤器、鉴权、Swagger 和安全中间件。
- `src/common.ts` 定义 `AppError`、错误响应格式、`requireUser()` 和 Prisma 错误映射。
- `src/database.config.ts` 解析 `DATABASE_PROVIDER` / `DATABASE_URL`，支持 `postgresql` 和 `mysql`。
- `src/prisma-cli.ts` / `src/prisma-schema.ts` 负责按 provider 渲染和执行 Prisma schema。
- `src/modules/` 放 controller、service、DTO 和单元测试。
- `prisma/schema.prisma` 是数据库模型源文件。

## Quality Check

- Typecheck: `pnpm -C apps/collab-api typecheck`
- Unit tests: `pnpm -C apps/collab-api test`
- Build: `pnpm -C apps/collab-api build`

后端单元测试必须带 60 秒硬超时执行，避免卡死任务。

数据库集成测试（env 门控 + 真实 PG/MySQL，常规 `test` 下 describe.skip）：

- 共享状态 CAS：`pnpm -C apps/collab-api test:shared-state:database:integration`（docker 版加 `:docker` 后缀）
- 跨租户越权隔离：`pnpm -C apps/collab-api test:cross-tenant:integration`（门控 `CROSS_TENANT_DATABASE_INTEGRATION=1`）

约定：新增团队隔离面（teamId 行级过滤）时，同步在 `cross-tenant-authz.database.integration.spec.ts`
补越权用例 + 同团正向对照——mock 级测试无法暴露「查询漏拼 teamId where」这类真实 SQL 缺陷。

## File Size Policy

- `>1500` 行源码必须拆分。
- `1000-1500` 行源码默认拆分；如果职责单一且拆分会增加复杂度，必须在任务文档中写明保留理由。
- `300-999` 行源码进入监控；改动时优先抽取 DTO、纯函数、查询构造器或测试 fixtures。
- 测试文件超过阈值时按业务场景拆分，不要用单个巨型 spec 承载所有模块行为。
