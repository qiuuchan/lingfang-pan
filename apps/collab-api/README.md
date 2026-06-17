# Collab API

NestJS + Prisma 的三平台协作系统统一 API。默认数据库为 PostgreSQL，也支持 MySQL；缓存默认使用进程内内存，Redis 可显式启用。

## 本地开发

前置：Node.js 20+、pnpm 9+、PostgreSQL 16+ 或 MySQL 8+/MariaDB 10.11+，Redis 可选。

```bash
cp apps/collab-api/.env.example apps/collab-api/.env
pnpm -C apps/collab-api prisma:generate
pnpm -C apps/collab-api prisma:deploy
pnpm -C apps/collab-api seed:admin
pnpm -C apps/collab-api dev
```

也可以使用聚合命令完成数据库准备和初始管理员创建：

```bash
pnpm -C apps/collab-api db:setup
```

默认本地数据库：

```text
postgresql://lingfang:lingfang@localhost:5432/lingfang_collab?schema=public
```

关键环境变量：

- `DATABASE_PROVIDER=postgresql | mysql`
- `DATABASE_URL=postgresql://...`
- `CACHE_DRIVER=memory | redis`
- `REDIS_URL=redis://127.0.0.1:6379/0`（仅 `CACHE_DRIVER=redis` 时必填）
- `VITE_CDN_BASE_URL=https://cdn.example.cn/lingfang-admin/`（管理端静态资源走国内 CDN）

## 初始平台管理员

`seed:admin` 读取以下环境变量：

- `PLATFORM_ADMIN_BOOTSTRAP_ENABLED`
- `PLATFORM_ADMIN_EMAIL`
- `PLATFORM_ADMIN_PASSWORD`
- `PLATFORM_ADMIN_NAME`

数据库中已存在平台管理员时，不重复创建，也不覆盖密码。

## 文档

- Swagger UI：`http://localhost:3000/api/docs`
- OpenAPI JSON：`http://localhost:3000/api/docs-json`

## 质量检查

```bash
pnpm -C apps/collab-api exec prisma validate
pnpm -C apps/collab-api typecheck
pnpm -C apps/collab-api build
pnpm -C apps/collab-api test
```
