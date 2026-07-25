# 部署指南

## 本地开发

```powershell
pnpm install
Copy-Item apps/collab-api/.env.example apps/collab-api/.env
pnpm start
```

`tools/start.ps1` 读取 `.env`：检查数据库、生成 Prisma Client、应用 migration、执行管理员 seed、启动 API、等待 `/api/health`，最后启动 Tauri。仓库示例 `.env` 的 `PORT` 是 `19006`；代码在未设置时回退 `3000`。

管理端单独启动在 `http://localhost:19005`，桌面 Vite dev server 使用 `http://localhost:1420`。

## 必要配置

- `DATABASE_PROVIDER`：`postgresql` 或 `mysql`。
- `DATABASE_URL`：与 provider 协议一致。
- `JWT_SECRET`：生产至少 16 字符。
- `LLM_KEY_ENCRYPTION_KEY`：64 位 hex。
- `CORS_ALLOWED_ORIGINS`：管理端、Tauri dev/release origin。
- `PORT`：API 监听端口。

可选配置包括 Redis、SMTP、密码/邮箱验证链接和 CDN 前缀。平台 RBFLow 凭证通过管理后台设置，不下发插件进程。

## Docker Compose

```powershell
docker compose -f docker-compose.collab.yml up -d
```

编排包含数据库、API 和静态管理端。生产环境必须替换示例密码、JWT、加密密钥与公开域名，并为插件制品目录配置持久卷。

## 发布检查

```powershell
pnpm -C apps/collab-api prisma:generate
pnpm -C apps/collab-api build
pnpm -C apps/collab-admin build
pnpm -C apps/desktop build
```

数据库升级使用 `prisma:deploy`，不要在生产使用破坏性重置命令。

## Legacy 插件表退役维护窗口

删除 legacy `Plugin` 表前，先停止旧客户端写入并保存数据库与插件制品存储快照。回填命令直接读取 legacy 表，不依赖已删除的 Prisma delegate，可在包含退役 schema 的发布版本中执行：

```powershell
pnpm -C apps/collab-api plugin-registry:migrate -- --apply
pnpm -C apps/collab-api plugin-registry:migrate -- --verify
```

`--verify` 输出任一非零缺口时不得继续。PostgreSQL 的 `20260725090000_retire_legacy_plugin` migration 会再次校验 package/release 映射、购买、授权、安装、评分和审核事实，失败时中止删表。

MySQL 使用 `prisma db push`，没有 PostgreSQL migration 内的 SQL 断言。仅在 `--verify` 成功并归档 JSON 输出后，为本次命令临时设置一次性开关：

```powershell
$env:PRISMA_MYSQL_ACCEPT_DATA_LOSS_ONCE='1'
pnpm -C apps/collab-api prisma:deploy
Remove-Item Env:PRISMA_MYSQL_ACCEPT_DATA_LOSS_ONCE
```

部署顺序固定为：备份、`--apply`、`--verify`、停止旧实例、部署 schema 和应用、执行 v4 市场/购买/下载/审核/授权/导出 smoke test。删表后的回滚必须恢复数据库与制品快照并部署上一应用版本，不能用空 legacy 表代替恢复。
