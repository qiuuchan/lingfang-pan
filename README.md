# LingFang Platform

> 定位：**no-code 的 AI 插件生成平台**——任何人用自然语言描述，AI 直接生成可运行插件。

## 这是什么

任何人（包括不会写代码的人）用自然语言描述想要的功能，平台调第三方 LLM API（如 newapi / one-api 等 OpenAI 兼容网关）**直接生成可运行的插件**，在沙箱里即时预览、对话式迭代、发布、上架市场。**「造插件」是产品主线。** 完整定位见 [愿景与架构](docs/01-vision-and-architecture.md)。

## 核心特性

- **自然语言造插件**：描述需求 → AI 生成 manifest + HTML/CSS/JS → 沙箱即时预览 → 发布。
- **流式生成 + 思考过程**：SSE 实时逐字推送；支持模型原生推理（如 deepseek-r1 的 `reasoning_content`），不支持的模型回退到 `<think>` 提示词约定，前端实时显示「正在思考」。
- **对话式迭代**：在已生成草稿上继续追加需求修改；已发布的插件也能「继续修改」载回对话页迭代。
- **我的插件**：本地内置 + 你发布的 + 从市场安装的，统一在此运行；可把常用插件**固定到侧边栏子菜单**一键启动。
- **插件市场**：搜索 / 排序 / 详情 / 评分（须已购买或免费已安装）/ 发布上架 / 安装。
- **内部经济**：钱包余额（注册赠送）、付费插件购买结算、平台审核。
- **多租户**：注册 / 登录 / 团队（租户）/ 成员角色（owner/admin/member）；**首个注册用户自动成为平台管理员**。

## 技术栈

| 层 | 技术 |
|----|------|
| 桌面壳 | Tauri 2 + React + Vite + Tailwind v4 + shadcn/ui |
| 服务端 | Rust + axum + sqlx |
| 数据库 | **内嵌 SQLite（单文件、零安装、默认）**——无需 Docker/PostgreSQL |
| LLM | 第三方 OpenAI 兼容网关（平台只路由 + 审计，不自建计费） |

## 快速开始

### 前置

只需 **`cargo`（Rust）** 和 **`pnpm`**。**不需要 Docker、不需要 PostgreSQL**——数据库用内嵌 SQLite，首次启动自动创建 `lingfang.db`。

```bash
pnpm install                     # 安装前端依赖
```

### 一键启动（推荐）

自动完成：准备 `.env`（可选）→ 编译并启动服务端（自动建 SQLite 库）→ 等待健康 → 启动桌面壳。

```powershell
pnpm start            # Windows（PowerShell 7）
pnpm start:sh         # macOS / Linux
pnpm start:backend    # 只起后端，不起桌面壳
```

首次运行会编译 Rust（拉依赖较久）。关闭桌面壳即自动停服务端。

### 手动分步（调试用）

```bash
cargo run -p server              # 1. 启动服务端（自动创建 lingfang.db 并跑迁移）
pnpm -C apps/desktop dev         # 2. 启动 Tauri 壳：注册→建团队→配网关→描述生成→预览→发布
```

生成插件需在壳内「设置 → LLM 网关」填入第三方 `base_url` + `api_key`（key 仅服务端持有、加密落库、不回显）。

## 配置

所有配置经环境变量（`.env`，全部可选，见 `.env.example`）：

| 变量 | 默认 | 说明 |
|------|------|------|
| `DATABASE_URL` | `sqlite:lingfang.db?mode=rwc` | 数据库连接串；默认内嵌 SQLite，文件不存在自动创建 |
| `BIND_ADDR` | `127.0.0.1:8787` | 服务端监听地址 |
| `JWT_SECRET` | dev 占位 | JWT 签名密钥（生产务必改） |
| `KEY_ENCRYPTION_SECRET` | dev 占位 | 加密租户 LLM key 的密钥（生产务必改） |
| `PLATFORM_ADMIN_EMAIL` | 空 | 指定平台审核员邮箱；留空则首个注册用户为管理员 |

### 分发自定义后端地址

桌面壳默认连 `http://127.0.0.1:8787`。分发软件时可编辑 `apps/desktop/public/app.config.json` 的 `api_base` 指向你的后端，无需改代码：

```json
{ "api_base": "https://your-backend.example.com" }
```

LLM 网关地址同理在 `apps/desktop/public/gateway.config.json` 预置（终端用户只填自己的 key）。

## 代码结构

```
apps/server/        Rust + axum + sqlx（SQLite）：身份/租户/草稿/生成/发布/安装/授权/审计/市场/钱包 + LLM 代理
  src/{config,error,db,state,auth,crypto,llm,audit}.rs + routes/{auth,drafts,catalog,llm,marketplace,wallet}.rs
  migrations/0001..0005_*.sql   （SQLite 方言）
apps/desktop/       Tauri 2 壳：React + Vite + Tailwind v4 + shadcn/ui
  src/{pages,components,lib}    描述→生成（流式+思考）→预览→发布→市场→钱包；侧边栏固定插件
  public/app.config.json        后端地址（分发可配）
  public/gateway.config.json     LLM 网关地址（分发可配）
  src-tauri/                     capability 网关（fs/system）+ 内置插件加载
  builtin-plugins/               内置插件：todo-list / file-explorer / system-info
packages/contract/  单一事实来源（zod）：identity / plugin / draft / llm
packages/plugin-sdk/ 插件能力客户端
packages/ui-tokens/ design token
tools/start.ps1 / start.sh      一键启动（SQLite，无需 DB 服务）
```

## 数据库

默认内嵌 SQLite（`lingfang.db`，位于服务端工作目录），首次启动自动建库并跑迁移，无需任何外部依赖。迁移文件在 `apps/server/migrations/`，启动时按序自动应用。

迁移类型约定：UUID 列用 `BLOB`，JSON / 时间用 `TEXT`，布尔用 `INTEGER(0/1)`。

## 本地验证

```bash
cargo test -p server                 # 后端单元测试
pnpm -C apps/desktop typecheck       # 前端类型检查
pnpm -C apps/desktop vite:build      # 前端生产构建
```

## 设计宪法

1. 契约先行，实现对齐。 2. 不造已有轮子。 3. 平台不碰业务。
4. 不自建 LLM 计费经济（只路由 + 审计）。 5. 本地可验证。 6. 保持最小、易部署。

## 文档

| 文档 | 内容 |
|------|------|
| [01 愿景与架构](docs/01-vision-and-architecture.md) | 定位 + Tauri2 三支柱 / 生成数据流 / 里程碑 |
| [02 领域模型与插件系统](docs/02-domain-and-plugins.md) | 实体契约 + manifest / 能力 / 沙箱 / SDK |
| [03 后端与 LLM 网关](docs/03-backend-and-llm.md) | API / 鉴权 / 隔离 / 第三方网关对接 |
| [04 工程规范](docs/04-engineering.md) | monorepo 布局 / 配置隔离 / 本地验证 |
| [ADR 决策记录](docs/adr/) | 0001–0005 |
