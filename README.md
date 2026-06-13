<h1 align="center">LingFang</h1>
<p align="center">基于 AI 的无代码插件生成平台</p>

## 架构

```mermaid
graph TB
    subgraph Desktop["桌面客户端 Tauri 2 + React"]
        Gen["AI 插件生成器"]
        Sandbox["沙箱预览"]
        Market["插件市场"]
        Wallet["钱包经济"]
        Teams["团队协作"]
    end

    subgraph Admin["管理端 React + shadcn/ui"]
        Users["用户管理"]
        Approvals["审批管理"]
        Plugins["插件治理"]
        Audit["审计日志"]
    end

    subgraph API["统一后端 collab-api（NestJS + Prisma）端口 3000，/api 前缀"]
        PluginsApi["插件生成 / LLM 代理 / 市场 / 钱包"]
        TenantApi["多租户团队 / RBAC / 管理后台"]
    end

    subgraph Store["存储"]
        PG[("PostgreSQL")]
    end

    Desktop --> API
    Admin --> API
    API --> PG
```

**单后端、一个平台：**

| 子系统 | 技术栈 | 数据库 | 职责 |
|------|--------|--------|------|
| collab-api | NestJS 11 + Prisma 7 | PostgreSQL | 插件生成、LLM 代理、市场、钱包、多租户团队、RBAC、管理后台 |
| desktop | Tauri 2 + React | —（经 collab-api） | 桌面端 UI、内置插件、本地命令（list_plugins / code_assistant_*） |
| collab-admin | React + shadcn/ui | —（经 collab-api） | 用户、团队、插件、审批、审计的 Web 管理后台 |

## 功能

**AI 插件生成** — 自然语言描述需求，AI 流式生成可运行插件，沙箱即时预览，对话式迭代，发布到市场。

- SSE 流式生成，实时展示推理过程
- 对话式迭代修改已生成的插件
- 插件沙箱即时预览

**市场与经济** — 搜索/评分/安装插件，钱包余额体系，付费插件购买结算。内置文件管理器、系统信息、待办事项三个插件。

**多租户协作** — 团队管理（管理员/成员角色），团队管理员申请审批流程，团队共享余额及流水。

## 快速开始

### 前置条件

```bash
Node.js >= 20        # 前端与 collab-api
pnpm >= 9            # Node 包管理器
PostgreSQL >= 16     # 统一数据库（lingfang_collab 库）
cargo >= 1.80        # Rust 工具链，用于构建 Tauri 桌面壳（非后端依赖）
```

### 一键启动（collab-api + 桌面壳）

```bash
pnpm install
pnpm start
```

`pnpm start`（tools/start.ps1）依次：校验 `.env` → 检查 PostgreSQL 连通 → `prisma migrate deploy` + 建平台管理员 → 启动 collab-api（:3000）→ 等待 `/api/health` → 启动桌面壳（Tauri）。

- 后端：`http://localhost:3000`，Swagger：`http://localhost:3000/api/docs`
- 桌面端自动启动为原生窗口，首次进入登录页（后端地址填 `http://127.0.0.1:3000`）
- 平台管理员：`admin@example.com` / `ChangeMe123!`

### 协作平台（分步启动 / 管理端）

```bash
# 后端（等价于 pnpm start 的核心步骤，单独开发时）
pnpm install
cp apps/collab-api/.env.example apps/collab-api/.env
pnpm -C apps/collab-api db:setup       # prisma generate + migrate deploy + 建管理员
pnpm -C apps/collab-api dev            # collab-api → :3000
pnpm -C apps/collab-admin dev          # 管理端 → :4174

# Docker 部署
docker compose -f docker-compose.collab.yml up -d
```

| 地址 | 说明 |
|------|------|
| `http://localhost:3000` | collab-api（统一后端） |
| `http://localhost:3000/api/docs` | Swagger 文档 |
| `http://localhost:4174` | 管理后台（collab-admin） |

## 项目结构

```
lingfang/
├── apps/
│   ├── desktop/          Tauri 2 + React 桌面客户端
│   │   ├── src/                  UI 页面、组件、API 层
│   │   ├── src-tauri/            Rust 桌面壳（本地命令 list_plugins / code_assistant_*）
│   │   └── builtin-plugins/      内置插件
│   ├── collab-api/       NestJS 统一后端（Prisma + PostgreSQL :3000）
│   │   ├── src/modules/          插件、团队、市场、钱包、管理、鉴权
│   │   └── prisma/               数据模型、迁移、种子
│   └── collab-admin/     Web 管理后台（React + shadcn/ui）
│       └── src/components/       用户、团队、插件、审批、审计
├── packages/
│   ├── contract/         Zod 契约 — 前后端共享类型
│   ├── plugin-sdk/       插件能力客户端 SDK
│   └── ui-tokens/        设计令牌（CSS 变量）
├── plugins/
│   └── summarizer/       示例插件：LLM 文本摘要
├── docs/                 架构文档、API 文档、ADR
├── tools/                启动脚本、分发脚本、Logo 生成器
└── docker-compose*.yml   Docker 部署配置
```

## 配置

所有环境变量均有本地开发默认值，详见 `apps/collab-api/.env.example`。

| 变量 | 默认值 | 作用域 |
|------|--------|--------|
| `PORT` | `3000` | collab-api 监听端口 |
| `DATABASE_URL` | `postgresql://lingfang:lingfang@localhost:5432/lingfang_collab` | collab-api（PostgreSQL） |
| `JWT_SECRET` | 开发占位值 | collab-api 鉴权 |
| `CORS_ALLOWED_ORIGINS` | `http://localhost:4174,http://localhost:1420,tauri://localhost` | collab-api 跨域 |

部署到局域网或公网时，设置 `PORT` 与 `CORS_ALLOWED_ORIGINS`（例如 `https://desktop.example.com`），数据库与反向代理详见 `docs/collab-deployment.md`。

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
| [ADR](docs/adr/) | 架构决策记录（5 篇） |

## 验证

```bash
pnpm -C apps/desktop typecheck    # 桌面端类型检查
pnpm -C apps/collab-api typecheck # API 类型检查
pnpm -C apps/collab-api test      # API 单元测试（Vitest）
pnpm -C apps/collab-admin build   # 管理端构建
```

## 设计原则

1. **契约先行** — `packages/contract` 中的 Zod schema 是所有实现的唯一事实来源
2. **不重复造轮子** — 选用经过验证的工具（NestJS、Prisma、Tauri、shadcn/ui）
3. **平台保持中立** — 只路由 LLM 请求，不处理计费
4. **本地可验证** — PostgreSQL + Prisma 迁移，`pnpm start` 一条命令拉起后端与桌面端
5. **最小可部署** — 单一 collab-api 后端（Node 进程）+ 静态文件（管理后台）