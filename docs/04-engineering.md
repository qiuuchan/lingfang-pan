# 工程规范

> 当前实现 · 2026-06-11 · 决策 [ADR-0005](adr/0005-monorepo-engineering.md)

---

## 1. Monorepo 布局

```text
lingfang-platform/
├── apps/
│   ├── desktop/            # Tauri 2 桌面壳（React + Vite + Rust 壳层）
│   └── server/             # Rust + axum + sqlx + SQLite 服务端
├── packages/
│   ├── contract/           # TS 类型与契约
│   ├── plugin-sdk/         # @lingfang/plugin-sdk
│   └── ui-tokens/          # design token
├── plugins/                # 示例插件
├── docs/                   # 设计文档
├── tools/                  # 启动、分发、验证脚本
├── Cargo.toml              # Rust workspace
├── pnpm-workspace.yaml     # TS/前端 workspace
└── package.json
```

平台代码放在 `apps/` 与 `packages/`；示例插件独立放在 `plugins/`。

## 2. 配置与密钥隔离

- 本地 `.env` 不入仓。
- 服务端密钥使用环境变量：`JWT_SECRET`、`KEY_ENCRYPTION_SECRET`。
- 租户第三方 LLM key 只提交给服务端，服务端加密落库，前端和插件不回显明文。
- 桌面端只保存后端 URL，不保存服务端密钥。

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
pnpm install                       # 安装前端依赖
pnpm start                         # Windows PowerShell 一键启动
pnpm start:sh                      # macOS / Linux 一键启动
pnpm start:backend                 # 只启动服务端
pnpm dev:server                    # cargo run -p server
pnpm dev:desktop                   # pnpm -C apps/desktop dev
pnpm -C apps/desktop typecheck     # 前端类型检查
pnpm -C apps/desktop vite:build    # 前端生产构建
cargo test -p server               # 后端测试
```

当前默认数据库是 SQLite，不需要 `db:up` 或 PostgreSQL 服务。

## 6. 部署要点

本机开发：

```env
BIND_ADDR=127.0.0.1:8787
CORS_ALLOWED_ORIGINS=
```

局域网/远端后端：

```env
BIND_ADDR=0.0.0.0:8787
CORS_ALLOWED_ORIGINS=http://localhost:1420,https://desktop.example.com
```

若桌面端填写公网 HTTPS 后端，服务端 HTTPS 通常由 Caddy、Nginx 或其他反向代理终止。

## 7. 本地验证

变更跨前端、后端或 Tauri 配置时，至少运行：

```bash
pnpm -C apps/desktop typecheck
pnpm -C apps/desktop vite:build
cargo test -p server
```

Tauri Rust 壳层变更较多时，再运行：

```bash
cargo test -p lingfang-desktop
```

## 8. 编码规范

- 文本文件 UTF-8 无 BOM；用户可见文案使用简体中文。
- 跨层配置和请求边界要集中管理，避免页面各自拼 URL。
- 注释只解释意图、约束和风险，不复述代码表面行为。
- 常规提交保持可构建。