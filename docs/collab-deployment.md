# Collab 部署文档

协作平台优先支持本地部署；Docker Compose 保留为可选部署方式。

## 本地部署主路径

### 1. 前置环境

- Node.js 20+
- pnpm 9+
- PostgreSQL 16+

默认本地端口：

- API：`http://localhost:3000`
- Swagger：`http://localhost:3000/api/docs`
- OpenAPI JSON：`http://localhost:3000/api/docs-json`
- 管理端：`http://localhost:4174`
- PostgreSQL：`localhost:5432`

### 2. 创建本地数据库

示例数据库连接：

```text
postgresql://lingfang:lingfang@localhost:5432/lingfang_collab?schema=public
```

可用任意 PostgreSQL 管理方式创建同名用户和数据库。示例 SQL：

```sql
CREATE USER lingfang WITH PASSWORD 'lingfang';
CREATE DATABASE lingfang_collab OWNER lingfang;
```

### 3. 安装依赖

在仓库根目录执行：

```bash
pnpm install
```

### 4. 配置后端环境变量

```bash
cp apps/collab-api/.env.example apps/collab-api/.env
```

最小配置：

```env
PORT=3000
DATABASE_URL="postgresql://lingfang:lingfang@localhost:5432/lingfang_collab?schema=public"
JWT_SECRET="change-me-in-production"
JWT_EXPIRES_IN="7d"
CORS_ALLOWED_ORIGINS="http://localhost:4174,http://localhost:1420,tauri://localhost"
PLATFORM_ADMIN_BOOTSTRAP_ENABLED=true
PLATFORM_ADMIN_EMAIL="admin@example.com"
PLATFORM_ADMIN_PASSWORD="ChangeMe123!"
PLATFORM_ADMIN_NAME="平台管理员"
```

生产环境必须替换 `JWT_SECRET` 和初始管理员密码。

### 5. 生成 Prisma Client、迁移数据库、创建初始平台管理员

```bash
pnpm -C apps/collab-api prisma:generate
pnpm -C apps/collab-api prisma:deploy
pnpm -C apps/collab-api seed:admin
```

也可以使用聚合命令：

```bash
pnpm -C apps/collab-api db:setup
```

seed 规则：

- 若数据库中不存在任何 `PLATFORM_ADMIN`，并且 `PLATFORM_ADMIN_BOOTSTRAP_ENABLED=true`，创建初始平台管理员。
- 若该邮箱已存在且尚无平台管理员，则提升该用户为平台管理员。
- 若已经存在平台管理员，不重复创建，也不覆盖密码。

初始化完成后，生产环境建议关闭：

```env
PLATFORM_ADMIN_BOOTSTRAP_ENABLED=false
```

### 6. 启动 API

开发模式：

```bash
pnpm -C apps/collab-api dev
```

生产构建后启动：

```bash
pnpm -C apps/collab-api build
pnpm -C apps/collab-api start
```

### 7. 启动管理端

管理端默认读取 `VITE_API_BASE_URL`，并兼容旧变量名 `VITE_COLLAB_API_BASE`。

```bash
VITE_API_BASE_URL=http://localhost:3000 pnpm -C apps/collab-admin dev
```

访问：

```text
http://localhost:4174
```

生产构建：

```bash
VITE_API_BASE_URL=http://localhost:3000 pnpm -C apps/collab-admin build
pnpm -C apps/collab-admin preview
```

### 8. 配置本地客户端

本地客户端首次启动时填写统一 API 地址：

```text
http://127.0.0.1:3000
```

也可以在 `apps/desktop/public/app.config.json` 预置：

```json
{ "api_base": "http://127.0.0.1:3000" }
```

客户端会访问 `/api/health` 做健康检查。

## 根目录快捷脚本

根目录提供协作平台常用脚本：

```bash
pnpm collab:api:generate
pnpm collab:api:migrate
pnpm collab:api:seed
pnpm collab:api:dev
pnpm collab:api:build
pnpm collab:admin:dev
pnpm collab:admin:build
```

## Docker Compose 可选路径

Docker Compose 会启动 PostgreSQL、API 和管理端。该路径适合快速联调或容器化部署，不是唯一部署方式。

### 1. 准备环境文件

```bash
cp .env.collab.example .env.collab
```

按需修改 `.env.collab` 中的管理员账号、JWT 密钥和管理端 API 地址。

Compose 中 API 容器会使用内部数据库地址：

```text
postgresql://lingfang:lingfang@postgres:5432/lingfang_collab?schema=public
```

宿主机访问 PostgreSQL 使用：

```text
localhost:5434
```

### 2. 启动

```bash
docker compose -f docker-compose.collab.yml up --build
```

启动流程包含：

1. PostgreSQL 健康检查。
2. `prisma:generate`。
3. `prisma migrate deploy`。
4. `seed:admin`。
5. 启动 API 和管理端。

默认端口：

- API：`http://localhost:3000`
- Swagger：`http://localhost:3000/api/docs`
- 管理端：`http://localhost:4174`
- PostgreSQL：宿主机 `localhost:5434`

## 验证命令

```bash
pnpm -C apps/collab-api exec prisma validate
pnpm -C apps/collab-api typecheck
pnpm -C apps/collab-api build
pnpm -C apps/collab-admin typecheck
pnpm -C apps/collab-admin build
pnpm -C apps/desktop typecheck
pnpm -C apps/desktop vite:build
docker compose -f docker-compose.collab.yml config
```

如果 Docker 镜像拉取网络不可用，`docker compose build` 可能卡在基础镜像元数据下载；这不影响本地 Node/PostgreSQL 部署路径。