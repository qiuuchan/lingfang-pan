<div align="center">

# LingFang

**基于 AI 的插件生成与协作平台** —— 自然语言生成插件，沙箱预览，三种 AI 编码助手注入，统一后端支撑桌面端、官网与管理后台。

[![Node](https://img.shields.io/badge/Node.js-%E2%89%A5%2020-339933?logo=node.js&logoColor=white)](#环境要求)
[![pnpm](https://img.shields.io/badge/pnpm-%E2%89%A5%209-F69220?logo=pnpm&logoColor=white)](#环境要求)
[![NestJS](https://img.shields.io/badge/NestJS-11-E0234E?logo=nestjs&logoColor=white)](https://nestjs.com/)
[![Prisma](https://img.shields.io/badge/Prisma-7-2D3748?logo=prisma&logoColor=white)](https://www.prisma.io/)
[![Tauri](https://img.shields.io/badge/Tauri-2-FFC131?logo=tauri&logoColor=black)](https://tauri.app/)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![Vite](https://img.shields.io/badge/Vite-6-646CFF?logo=vite&logoColor=white)](https://vite.dev/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-%E2%89%A5%2016-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-Private-lightgrey)](#license)

</div>

---

## 目录

- [项目简介](#项目简介)
- [功能特性](#功能特性)
- [架构概览](#架构概览)
- [快速开始](#快速开始)
- [部署](#部署)
- [项目结构](#项目结构)
- [环境变量](#环境变量)
- [开发指南](#开发指南)
- [文档](#文档)
- [设计原则](#设计原则)
- [贡献指南](#贡献指南)
- [License](#license)

---

## 项目简介

LingFang 是一个 monorepo 形态的 AI 插件平台，核心能力是用对话式自然语言生成可运行的插件，并通过统一的 `collab-api` 后端串联起三端：

- **桌面客户端**（Tauri 2 + React）—— AI 插件生成器、三种 CLI 编码助手、模型网关、沙箱预览、检查更新、市场、钱包、团队。
- **管理后台 + 官网落地页**（React + shadcn/ui，二合一）—— 未登录展示官网，登录后进入后台管理用户/团队/插件/审批/审计。
- **统一后端**（NestJS + Prisma + PostgreSQL）—— 鉴权、插件生成、LLM 代理、市场、钱包、多租户团队、RBAC、管理后台 API。

> 单后端、一个平台：桌面端与管理端共用同一套 API 与数据库。

---

## 功能特性

### AI 插件生成

- **对话式生成** —— 自然语言描述需求，AI 流式（SSE）生成可运行插件，实时展示推理过程。
- **对话式迭代** —— 在已生成插件基础上多轮修改，无需从零重写。
- **结构化输出** —— 生成器产出结构化草稿（manifest + 文件 + 能力声明），支持 `client` / `nodejs` / `python` / `cloud` 四类运行时。
- **沙箱即时预览** —— 生成结果在桌面端内置沙箱中即时预览运行。

### 三种 CLI 编码助手注入

- **claude / codex / opencode** —— 桌面壳（Rust）自动检测本地 CLI 可用性，会话级隔离配置注入：
  - 从后端拉取租户绑定的 `apiKey` + `apiUrl`，key 明文仅在 Rust 进程内流转，不进前端。
  - codex/opencode 写入会话级临时配置文件（`cli-configs/<sessionId>/`），claude 走环境变量。
  - 用户选定模型透传到 codex `config.toml` 与 opencode `json` 的 `lingfang/<model>`。
- **探针与会话管理** —— 启动/停止/列表/重命名/删除会话、读取 transcript、保存草稿、扫描 workspace 产出插件文件。

### 模型网关

- **平台维护 provider 目录**（openai/anthropic/azure/deepseek/moonshot/qwen/custom），seed 默认值。
- **单 provider 启用模式** —— 全表最多一条 `isActive`，事务维护唯一；用户界面零 provider 概念。
- **租户级 apiKey 绑定** —— AES-256-GCM 加密存库，脱敏串与 sha256 指纹辅助展示，平台切换 provider 后用户仅需重新填 key。
- **模型列表拉取** —— 桌面端直连 provider `/v1/models` 拉取，或经后端 active-provider 拿默认模型。

### 检查更新

- **Tauri Updater** —— `tauri-plugin-updater` + minisign 验签，endpoints 运行时由 Rust 注入（后端地址用户动态配置）。
- **版本发布目录** —— `Release` / `ReleaseAsset`（平台/架构/签名/大小），公开 `latest` / `list` / `tauri-update` 端点供官网与桌面端检查更新。

### 市场与经济

- **公共市场** —— 搜索（按安装量/评分排序）、详情、安装、评分评论。
- **钱包体系** —— 用户钱包余额（cents 计价），单事务结算购买付费插件（扣款 + 加款 + purchase + 双流水）。
- **审核流程** —— 插件提交市场审核（DRAFT → PENDING → APPROVED/REJECTED），平台 Admin 审批。

### 多租户协作

- **团队管理** —— 管理员/成员角色，团队管理员申请审批流程，团队共享余额及流水。
- **公开团队发现** —— 管理员可开启 `allowPublicJoin`，普通用户一键直接加入；邀请码加入（生成/禁用/兑换）。
- **账号自助** —— 导出全量数据、注销账号（软删除 + 打码邮箱 + `tokenVersion++` 作废 token）。

### 通知系统

- **用户级通知** —— 审核结果、收入到账、申请通过等业务事件触发；未读列表、单条/全部标记已读。

### 内置插件

桌面端内置三个示例插件：

| 插件 | 能力 |
|------|------|
| `file-explorer` | 文件管理器 |
| `system-info` | 系统信息 |
| `todo-list` | 待办事项 |

另有 `plugins/summarizer`（长文总结）作为 LLM 能力示例插件。

---

## 架构概览

```mermaid
graph TB
    subgraph Desktop["桌面客户端 Tauri 2 + React"]
        Gen["AI 插件生成器（SSE 流式）"]
        Cli["三种 CLI 编码助手（claude/codex/opencode）"]
        Sandbox["沙箱预览"]
        Updater["检查更新（minisign）"]
        Market["插件市场 / 钱包 / 团队"]
    end

    subgraph Admin["管理后台 + 官网 React + shadcn/ui"]
        Landing["官网落地页（未登录）"]
        Back["用户 / 团队 / 插件 / 审批 / 审计 / 发布"]
    end

    subgraph API["统一后端 collab-api NestJS 11 + Prisma 7 :3000 /api"]
        Auth["鉴权（JWT + tokenVersion 吊销）"]
        Plugins["插件生成 / LLM 代理 / 市场 / 钱包"]
        Tenant["多租户团队 / RBAC / 管理后台"]
        Release["版本发布 / 通知"]
    end

    subgraph Store["存储"]
        PG[("PostgreSQL ≥ 16")]
    end

    Desktop --> API
    Admin --> API
    API --> PG
```

### 技术栈

| 子系统 | 技术栈 | 数据库 | 职责 |
|--------|--------|--------|------|
| `apps/collab-api` | NestJS 11 + Prisma 7 + Express 5 | PostgreSQL | 鉴权、插件生成、LLM 代理、市场、钱包、多租户团队、RBAC、管理后台、版本发布、通知 |
| `apps/desktop` | Tauri 2 + React 18 + Vite 6 | —（经 collab-api） | 桌面端 UI、AI 生成器、CLI 注入、内置插件、本地命令（Rust） |
| `apps/collab-admin` | React 18 + shadcn/ui + Tailwind 4 | —（经 collab-api） | 官网落地页 + Web 管理后台（二合一） |
| `packages/contract` | Zod | — | 前后端共享契约（类型唯一真源） |
| `packages/plugin-sdk` | TypeScript | — | 插件作者用的能力客户端 SDK |
| `packages/ui-tokens` | CSS 变量 | — | 设计令牌 |

### 关键依赖

- **后端**：`@nestjs/*` 11、`@prisma/client` 7、`@prisma/adapter-pg`、`bcryptjs`、`class-validator/transformer`、`jsonwebtoken`、`helmet`、`nestjs-pino`、`nodemailer`、`@nestjs/throttler`、`@nestjs/swagger`。
- **桌面**：`@tauri-apps/api` 2、`@tauri-apps/cli` 2、`framer-motion` 12、`react-markdown` + `rehype-highlight` + `remark-gfm`、`highlight.js`、`next-themes`、`lucide-react`、`sonner`。
- **管理端**：`@radix-ui/*`、`framer-motion` 12、`shadcn` 4、`lucide-react`、`sonner`、`tailwind-merge`。
- **Rust（桌面壳）**：`tauri` 2、`tauri-plugin-updater` 2、`reqwest` 0.12（rustls-tls）、`sysinfo`、`serde`/`serde_json`。

---

## 快速开始

### 环境要求

| 工具 | 版本 | 用途 |
|------|------|------|
| [Node.js](https://nodejs.org/) | ≥ 20 | 前端与 collab-api |
| [pnpm](https://pnpm.io/) | ≥ 9 | Node 包管理器 |
| [PostgreSQL](https://www.postgresql.org/) | ≥ 16 | 统一数据库（`lingfang_collab` 库） |
| [Rust / cargo](https://www.rust-lang.org/) | ≥ 1.80 | 构建 Tauri 桌面壳（非后端依赖） |

### 一键启动（collab-api + 桌面壳）

```bash
pnpm install
pnpm start
```

`pnpm start`（`tools/start.ps1`）依次：校验 `.env` → 检查 PostgreSQL 连通 → `prisma migrate deploy` + 建平台管理员 → 启动 collab-api（`:3000`）→ 等待 `/api/health` → 启动桌面壳（Tauri）。

- 后端：`http://localhost:3000`，Swagger：`http://localhost:3000/api/docs`
- 桌面端自动启动为原生窗口，首次进入登录页（后端地址填 `http://127.0.0.1:3000`）。
- 平台管理员：`admin@example.com` / `ChangeMe123!`

### 分步启动（开发）

```bash
# 1. 安装依赖
pnpm install

# 2. 配置后端环境变量
cp apps/collab-api/.env.example apps/collab-api/.env
# 按需修改 DATABASE_URL / JWT_SECRET / LLM_KEY_ENCRYPTION_KEY 等

# 3. 数据库迁移 + 种子（建管理员、provider 目录、release 目录）
pnpm -C apps/collab-api db:setup

# 4. 启动服务（分别开终端）
pnpm -C apps/collab-api dev      # collab-api  → :3000
pnpm -C apps/collab-admin dev    # 管理端     → :4174
pnpm -C apps/desktop dev         # 桌面端     → Tauri 窗口
```

### 地址速查

| 地址 | 说明 |
|------|------|
| `http://localhost:3000` | collab-api（统一后端） |
| `http://localhost:3000/api/docs` | Swagger 文档（生产关闭） |
| `http://localhost:3000/api/platform-info` | 平台公开信息（免登录） |
| `http://localhost:4174` | 管理后台 + 官网落地页（二合一） |
| `http://localhost:1420` | 桌面端 Vite dev server（Tauri devUrl） |

---

## 部署

### 后端（collab-api）

```bash
# 构建
pnpm -C apps/collab-api prisma:generate
pnpm -C apps/collab-api build      # tsc → dist/

# 生产运行（务必设置生产环境变量，见下表）
NODE_ENV=production node dist/main.js
```

生产环境 **必须** 设置（缺失时启动 fail-fast）：

- `JWT_SECRET`（≥ 16 字符）
- `LLM_KEY_ENCRYPTION_KEY`（64 位 hex，`openssl rand -hex 32` 生成）
- `CORS_ALLOWED_ORIGINS`（如 `https://admin.example.com,tauri://localhost,https://tauri.localhost`）

### 桌面端打包（Tauri）

```bash
pnpm -C apps/desktop build         # tauri build（生成 NSIS 安装包 + updater 产物）
# 或一键打包分发脚本
pnpm dist                          # tools/create-distribution.ps1
```

打包产物包含 `createUpdaterArtifacts`（updater 签名），发布到后端 `Release` 目录后桌面端可自动检查更新。

### 管理端（collab-admin）

管理端是一个 **React SPA**（Vite 构建），未登录显示官网落地页，登录后进入管理后台。生产部署只需静态文件托管。

#### 1. 构建

```bash
# 构建时注入后端地址（管理端所有 API 请求都走这个地址）
# 两个变量名都支持，优先 VITE_API_BASE_URL
VITE_API_BASE_URL=https://api.example.com pnpm -C apps/collab-admin build

# 产物在 apps/collab-admin/dist/（纯静态 HTML + JS + CSS + 字体 woff2）
```

> **注意**：`VITE_API_BASE_URL` 是生产后端地址（不含尾斜杠），如 `https://api.lingfang.com`。
> 本地开发用 `pnpm -C apps/collab-admin dev`（:4174，自动连 localhost:3000）。

#### 2. 部署方式

**方式一：Nginx 静态托管（推荐）**

```nginx
server {
    listen 80;
    server_name admin.example.com;
    root /var/www/lingfang-admin/dist;

    # SPA 路由回退（所有路径走 index.html）
    location / {
        try_files $uri $uri/ /index.html;
    }

    # API 反代到后端
    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # 静态资源缓存（woff2 字体/js/css 带 hash 不变）
    location ~* \.(woff2|js|css|png|jpg|svg)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # Gzip 压缩
    gzip on;
    gzip_types text/css application/javascript application/json font/woff2;
}
```

**方式二：Node 静态服务器**

```bash
# 用 serve / http-server / caddy 等任意静态文件服务器
npx serve apps/collab-admin/dist -l 4174
# 或
pnpm -C apps/collab-admin preview   # Vite 内置 preview（开发用，不推荐生产）
```

**方式三：Docker（docker-compose 一体化）**

```bash
# 见下方 Docker Compose 部分，管理端自动构建+托管
```

#### 3. 首次使用

部署后访问管理端地址，首次启动会进入**安装向导**（Setup Wizard）：
1. 设置平台管理员邮箱 / 密码 / 显示名
2. 设置平台名称
3. 完成后自动登录，进入管理后台

> 安装向导仅在数据库无 `PLATFORM_ADMIN` 用户时可用，完成后自动禁用（防被重复创建管理员）。

#### 4. 管理后台配置（登录后）

| 配置项 | 位置 | 说明 |
|--------|------|------|
| 平台名称 / Logo | 平台设置 → 平台信息 | 云端存储，全端同步（官网/桌面客户端都显示） |
| SMTP 邮件 | 平台设置 → 邮件服务 | 阿里云 DirectMail / QQ / 163 等，填服务器地址+端口+用户名+密码 |
| 极验验证码 | 平台设置 → 验证码服务 | 管理端登录/注册的验证码（桌面客户端不需要验证码） |
| 模型服务 | 模型服务 | 平台维护 provider 列表 + 设当前启用，用户在桌面端填 API 密钥 |
| Gitee 更新日志 | 平台设置 → 更新日志 | 配置 Gitee 仓库 owner/repo/token，官网更新日志页自动拉取 release |
| 主题切换 | 平台设置 → 外观 | 亮色/暗色/跟随系统 |

### Docker Compose 一体化部署

```bash
docker compose -f docker-compose.collab.yml up -d
```

该编排包含：`postgres:16`（`lingfang_collab` 库，宿主 `:5434`）+ `collab-api`（自动 `prisma migrate deploy` + seed + `start`）+ `collab-admin`（构建注入 API 地址后 preview）。配置见 `.env.collab.example`。

---

## 项目结构

```
lingfang-platform/
├── apps/
│   ├── desktop/                      Tauri 2 + React 桌面客户端
│   │   ├── src/                      UI 页面、组件、API 层、lib 工具
│   │   │   ├── pages/                Auth / Market / Plugins / PluginCreator / Review / Settings / Team / Wallet 等
│   │   │   ├── components/           chat / creator / onboarding / ui（shadcn）
│   │   │   └── lib/                  api / cli / conversations / plugin-draft / updater 等
│   │   ├── src-tauri/                Rust 桌面壳
│   │   │   └── src/                  main / plugins / capability / code_assistant / cli_config / llm_* / updater
│   │   └── builtin-plugins/          内置插件：file-explorer / system-info / todo-list
│   ├── collab-api/                   NestJS 统一后端（Prisma + PostgreSQL :3000）
│   │   ├── src/
│   │   │   ├── modules/              auth / me / teams / applications / plugins / marketplace / wallet / llm / notifications / release / admin / settings
│   │   │   ├── common/               守卫、装饰器、异常过滤器
│   │   │   └── crypto/               apiKey 凭证加解密
│   │   └── prisma/                   schema.prisma + 11 个迁移 + seed
│   └── collab-admin/                 Web 管理后台 + 官网落地页（React + shadcn/ui）
│       └── src/components/           landing/ + admins/applications/audit/plugins/providers/settings/teams/users
├── packages/
│   ├── contract/                     Zod 契约 —— 前后端共享类型（plugin / llm / draft / identity）
│   ├── plugin-sdk/                   插件能力客户端 SDK（桥 __lingfangInvoke）
│   └── ui-tokens/                    设计令牌（CSS 变量）
├── plugins/
│   └── summarizer/                   示例插件：LLM 长文总结（client 运行时）
├── docs/                             架构文档、API 文档、ADR（5 篇）、证据
├── tools/                            start.ps1 / create-distribution.ps1 / generate_logo.py
├── docker-compose.collab.yml         Docker 一体化部署
├── docker-compose.yml                本地开发用 PostgreSQL
└── package.json                      根脚本（start / dist / typecheck / lint / test）
```

---

## 环境变量

所有环境变量均有本地开发默认值，详见 `apps/collab-api/.env.example`。

### 基础配置

| 变量 | 默认值 | 作用域 | 说明 |
|------|--------|--------|------|
| `PORT` | `3000` | collab-api | 监听端口 |
| `DATABASE_URL` | `postgresql://lingfang:lingfang@localhost:5432/lingfang_collab?schema=public` | collab-api | PostgreSQL 连接串 |
| `JWT_SECRET` | `dev-collab-change-me` | collab-api | JWT 签名密钥（生产必设 ≥ 16 字符，否则 fail-fast） |
| `JWT_EXPIRES_IN` | `7d` | collab-api | JWT 过期时间 |
| `CORS_ALLOWED_ORIGINS` | `http://localhost:4174,http://localhost:1420,tauri://localhost,http://tauri.localhost,...` | collab-api | CORS 白名单（未配时 fail-close） |

### 平台管理员引导

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PLATFORM_ADMIN_BOOTSTRAP_ENABLED` | `true` | 启动时引导平台管理员 |
| `PLATFORM_ADMIN_EMAIL` | `admin@example.com` | 管理员邮箱 |
| `PLATFORM_ADMIN_PASSWORD` | `ChangeMe123!` | 管理员初始密码 |
| `PLATFORM_ADMIN_NAME` | `平台管理员` | 管理员显示名 |

### 密钥与邮件

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `LLM_KEY_ENCRYPTION_KEY` | （空） | apiKey 加密密钥（64 位 hex；生产必设，AES-256-GCM；不入 git） |
| `SMTP_URL` | （空） | SMTP 邮件服务（找回密码用；未配时降级 `console.log`） |
| `SMTP_FROM` | `LingFang 平台 <no-reply@lingfang.local>` | 发件人地址 |
| `PASSWORD_RESET_BASE_URL` | （空） | 密码重置链接前缀（桌面端解析 `reset_token` 弹重置对话框） |

### CORS 说明

`CORS_ALLOWED_ORIGINS` 同时包含 dev 与 release 两种 Tauri origin：

- `tauri://localhost` —— Tauri 2 dev 模式 webview origin。
- `http(s)://tauri.localhost` —— Tauri 2 打包后 release origin（Windows 默认）。
- 官网落地页已与管理后台合并为 `apps/collab-admin`（同源 `:4174`），无需额外跨域配置。
- 生产部署时追加管理端域名（如 `https://admin.example.com`）。

数据库与反向代理详见 [`docs/collab-deployment.md`](docs/collab-deployment.md)。

---

## 开发指南

### 常用脚本（根目录）

| 命令 | 作用 |
|------|------|
| `pnpm start` | 一键启动 collab-api + 桌面壳 |
| `pnpm start:backend` | 仅启动后端（跳过桌面壳） |
| `pnpm dist` | 打包桌面端分发（`tools/create-distribution.ps1`） |
| `pnpm typecheck` | 递归全仓类型检查（`pnpm -r typecheck`） |
| `pnpm lint` | 递归全仓 lint |
| `pnpm test` | 递归全仓测试（Vitest） |
| `pnpm dev:desktop` | 桌面端 Tauri dev |
| `pnpm collab:api:dev` | 后端 dev |
| `pnpm collab:admin:dev` | 管理端 dev |
| `pnpm collab:api:migrate` | 后端 `prisma migrate deploy` |
| `pnpm collab:api:seed` | 建平台管理员 seed |

### 类型检查 / 测试 / 构建

```bash
# 类型检查（按子包）
pnpm -C apps/desktop typecheck
pnpm -C apps/collab-api typecheck
pnpm -C apps/collab-admin typecheck

# 测试（Vitest）
pnpm -C apps/collab-api test          # API 单元测试
pnpm -C apps/desktop test             # 桌面端 lib 单元测试

# 构建
pnpm -C apps/collab-api build         # tsc → dist/
pnpm -C apps/collab-admin build       # vite build（含 tsc --noEmit）
pnpm -C apps/desktop build            # tauri build（NSIS + updater 产物）
```

### 数据库迁移工作流

```bash
# 修改 schema.prisma 后生成新迁移
pnpm -C apps/collab-api prisma:migrate     # prisma migrate dev
# 生产部署应用迁移
pnpm -C apps/collab-api prisma:deploy      # prisma migrate deploy
# 重置开发库 + 种子（破坏性，仅开发）
pnpm -C apps/collab-api db:setup
```

当前共 11 个迁移：init、plugin 云共享、wallet/marketplace、nodejs/python 运行时、user tokenVersion、LLM 网关目录、release 目录、单 provider、团队公开加入/密码重置/限流、平台设置、通知。

---

## 文档

| 文档 | 内容 |
|------|------|
| [愿景与架构](docs/01-vision-and-architecture.md) | 产品定位、系统设计 |
| [领域模型与插件](docs/02-domain-and-plugins.md) | 实体契约、插件清单、SDK |
| [后端与 LLM](docs/03-backend-and-llm.md) | API 设计、鉴权、网关 |
| [工程规范](docs/04-engineering.md) | Monorepo 约定、配置隔离 |
| [协作平台架构](docs/collab-platform.md) | 多租户架构 |
| [协作 API](docs/collab-api.md) | API 参考 |
| [协作部署](docs/collab-deployment.md) | Docker 与手动部署 |
| [桌面客户端](docs/collab-desktop-client.md) | 桌面端说明 |
| [管理端指南](docs/collab-admin-guide.md) | 管理后台使用 |
| [插件工作台实跑测试](docs/plugin-workbench-real-cli-test.md) | 三 CLI 实测记录 |
| [ADR](docs/adr/) | 架构决策记录（5 篇）：桌面壳选型 / LLM 第三方网关 / 多租户持久化 / 插件能力沙箱 / Monorepo 工程 |

---

## 设计原则

1. **契约先行** —— `packages/contract` 中的 Zod schema 是所有实现的唯一事实来源。
2. **不重复造轮子** —— 选用经过验证的工具（NestJS、Prisma、Tauri、shadcn/ui、Radix）。
3. **平台保持中立** —— 只路由 LLM 请求与 provider 切换，不内嵌计费逻辑。
4. **本地可验证** —— PostgreSQL + Prisma 迁移，`pnpm start` 一条命令拉起后端与桌面端。
5. **最小可部署** —— 单一 collab-api 后端（Node 进程）+ 静态文件（管理后台）+ 桌面安装包。

---

## 贡献指南

1. **分支约定** —— 基于 `main` 创建特性分支，保持小步可编译可验证的提交。
2. **代码风格** —— 遵循既有命名、导入顺序与 TypeScript 配置；所有注释与文档使用简体中文。
3. **测试** —— 新增逻辑须配套单元测试（Vitest），覆盖正常流程、边界与错误恢复。
4. **提交前自检**：

   ```bash
   pnpm typecheck   # 全仓类型检查
   pnpm test        # 全仓测试
   ```

5. **迁移** —— 涉及数据模型变更须生成新 Prisma 迁移并补充 seed（幂等 upsert）。
6. **文档** —— 公共 API 或架构变更同步更新 `docs/` 与对应 ADR。

---

## License

本项目当前为私有项目（`package.json` 标记 `private: true`），未声明开源 License。如需使用、分发或二次开发，请联系项目维护者获取授权。
