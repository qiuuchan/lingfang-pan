# 工程规范

> 蓝图 · 2026-06-09 · 决策 [ADR-0005](adr/0005-monorepo-engineering.md)
> 对应痛点：解决旧版「目录乱」（配置污染 / platform-apps 双轨 / 产物入仓）

---

## 1. Monorepo 布局

```
lingfang-platform/
├── apps/
│   ├── desktop/            # Tauri 2 桌面壳（Rust 核 + Web 前端）
│   └── server/             # 多租户服务端（Rust + axum）
├── packages/
│   ├── contract/           # ★单一事实来源：TS 类型 + zod
│   ├── plugin-sdk/         # @lingfang/plugin-sdk
│   └── ui-tokens/          # design token
├── plugins/                # 示例/内置插件（如 summarizer）
├── docs/                   # 设计文档
├── tools/                  # 开发与验证脚本
├── Cargo.toml              # Rust workspace
├── pnpm-workspace.yaml     # TS/前端 workspace
├── docker-compose.yml      # 本地 PostgreSQL
└── package.json
```

单一布局哲学：只用 `apps/`（无 `platform/` 双轨）；平台代码在 `apps/`+`packages/`，示例插件独立 `plugins/`。

## 2. AI 工具配置隔离

仓库**不为任何单一 AI 工具绑定**：`.gitignore` 排除 `.claude/`、`.cursor/`、`.codex/`、`.agents/`。验收标准：`git clone` 后根目录干净，只见项目本体。

## 3. 产物与密钥外置

`.gitignore` 排除 `node_modules/`、`target/`、`dist/`、`release/`、`night_runs/`、`*.log`。**密钥永不入仓**（LLM key、JWT 密钥、DB 密码），走环境变量 / `.env`（本地）/ KMS（生产）。

## 4. 构建与脚本

```
pnpm db:up        # 起本地 PostgreSQL
pnpm dev:server   # cargo run -p server（需 DATABASE_URL）
pnpm dev:desktop  # Tauri 壳
pnpm typecheck / lint / test
```

TS 侧统一 pnpm，Rust 侧 cargo workspace。不允许各包自创脚本入口。

## 5. 本地强制验证

每个里程碑一条命令可重复验证（拒绝「只在文档里成立」）：

| 里程碑 | verify 覆盖 |
|--------|------------|
| M0 | 真实 PG → 迁移 → 集成测试：注册→建租户→邀成员→装插件→授权→审计，重启数据仍在 |
| M1 | 壳加载插件 → 成功 `invoke` 一个能力 |
| M2 | 配 newapi key → 插件调 `llm.chat` 出真实结果 → 审计落库 |

验证失败即阻断。

## 6. 编码规范

- 文本文件 UTF-8 无 BOM；文档与注释用简体中文，代码标识符按各语言惯例。
- **契约先行**：改行为先改 `packages/contract`，再改两端实现；偏离契约即缺陷。
- 注释写「意图与约束」，不写修改流水账。
- 常规提交（`feat:`/`fix:`/`docs:`），每次提交保持可构建。
