# 工程规范

> 当前实现 · 2026-06-11 · 决策 [ADR-0005](adr/0005-monorepo-engineering.md)

---

## 1. Monorepo 布局

```text
lingfang-platform/
├── apps/
│   ├── desktop/            # Tauri 2 桌面壳（React + Vite + Rust 壳层，本地命令 list_plugins / code_assistant_*）
│   ├── collab-api/         # NestJS + Prisma + PostgreSQL 统一后端（:3000，/api 前缀）
│   └── collab-admin/       # React + shadcn/ui 管理后台（:4174）
├── packages/
│   ├── contract/           # TS 类型与契约
│   ├── plugin-sdk/         # @lingfang/plugin-sdk
│   └── ui-tokens/          # design token
├── plugins/                # 示例插件
├── docs/                   # 设计文档
├── tools/                  # 启动、分发脚本
├── apps/desktop/src-tauri/ # Tauri 壳层 Cargo workspace（仅桌面壳，非后端）
├── pnpm-workspace.yaml     # TS/前端 workspace
└── package.json
```

平台代码放在 `apps/` 与 `packages/`；示例插件独立放在 `plugins/`。后端已收敛到唯一的 `apps/collab-api`（NestJS + PostgreSQL）。

## 2. 配置与密钥隔离

- 本地 `.env` 不入仓（`apps/collab-api/.env`）。
- 后端密钥使用环境变量：`JWT_SECRET`、`DATABASE_URL`、`CORS_ALLOWED_ORIGINS`，统一在 `apps/collab-api/.env` 管理。
- 租户第三方 LLM key 只提交给 collab-api，服务端加密落库，前端和插件不回显明文。
- 桌面端只保存后端 URL，不保存后端密钥。

## 3. 前后端分离配置

桌面端连接后端的优先级：

```text
用户本机保存的后端 URL
  -> 打包默认 app.config.json 的 api_base
  -> 首次启动配置入口
```

要求：

- 后端 URL 是全局本机偏好，不按租户隔离。
- 首次未配置时不得进入登录页或发业务请求。
- 设置页可修改后端 URL，切换后端后需要重新登录。
- 分发者可以预置默认后端地址，但用户仍可在应用内修复。

## 4. 本地资源与打包

- `apps/desktop/public/` 下的 JSON 文件由 Vite 打进 `dist`，随 Tauri `frontendDist` 进入应用。
- `apps/desktop/builtin-plugins/` 通过 Tauri `bundle.resources` 打包为 `builtin-plugins`。
- Tauri CSP 允许连接用户配置的 HTTP/HTTPS 后端，同时保留本地开发地址。
- 生成产物和运行日志不入仓：`dist/`、`target/`、`release/`、`night_runs/`、`*.log`。

## 5. 构建与脚本

```bash
pnpm install                       # 安装前端与后端依赖
pnpm start                         # 一键启动：PG 检查 → migrate → seed → collab-api(:3000) → 桌面壳
pnpm start:backend                 # 仅启动后端（tools/start.ps1 -SkipDesktop）
pnpm collab:api:dev                # 单独开发 collab-api（pnpm -C apps/collab-api dev）
pnpm collab:admin:dev              # 单独开发管理后台（pnpm -C apps/collab-admin dev）
pnpm dev:desktop                   # 单独开发桌面端（pnpm -C apps/desktop dev）
pnpm -C apps/desktop typecheck     # 前端类型检查
pnpm -C apps/desktop vite:build    # 前端生产构建
pnpm -C apps/collab-api typecheck  # collab-api 类型检查
pnpm -C apps/collab-api test       # collab-api 单元测试（Vitest）
```

当前默认数据库是 PostgreSQL（lingfang_collab 库），需在 `apps/collab-api/.env` 配置可达的 `DATABASE_URL`，详见 `docs/collab-deployment.md`。

## 6. 部署要点

collab-api 部署配置在 `apps/collab-api/.env`：

本机开发：

```env
PORT=3000
DATABASE_URL="postgresql://lingfang:lingfang@localhost:5432/lingfang_collab"
CORS_ALLOWED_ORIGINS="http://localhost:4174,http://localhost:1420,tauri://localhost"
```

局域网/远端后端：

```env
PORT=3000
DATABASE_URL="postgresql://user:pass@db-host:5432/lingfang_collab"
CORS_ALLOWED_ORIGINS=http://localhost:1420,https://desktop.example.com
```

若桌面端填写公网 HTTPS 后端，HTTPS 通常由 Caddy、Nginx 或其他反向代理终止。Docker 部署见 `docs/collab-deployment.md`。

## 7. 本地验证

变更跨前端、后端或 Tauri 配置时，至少运行：

```bash
pnpm -C apps/desktop typecheck
pnpm -C apps/desktop vite:build
pnpm -C apps/collab-api typecheck
pnpm -C apps/collab-api test
```

Tauri Rust 壳层（`apps/desktop/src-tauri`）变更较多时，再运行其本地命令测试。

## 8. 编码规范

- 文本文件 UTF-8 无 BOM；用户可见文案使用简体中文。
- 跨层配置和请求边界要集中管理，避免页面各自拼 URL。
- 注释只解释意图、约束和风险，不复述代码表面行为。
- 常规提交保持可构建。