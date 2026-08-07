# 贡献指南 (Contributing)

感谢参与 LingFang (灵贩) 平台开发。

## 开发环境

- **Node.js**：22（见仓库根 `.nvmrc`，可用 `nvm use` 切换）
- **包管理器**：pnpm 9（`corepack enable` 或 `npm i -g pnpm@9`）
- **Monorepo**：pnpm workspace（`apps/*` + `packages/*`）

## 本地初始化

```bash
pnpm install
pnpm -r typecheck      # 全量类型检查
pnpm lint              # ESLint（error 级基线，0 warning）
pnpm format:check      # Prettier 格式检查
pnpm -r test           # 运行各包单元测试
```

## 质量门禁

所有变更必须通过 `scripts/ci.sh`（CI 自动执行），包含：

1. 依赖安装（frozen lockfile）
2. Prisma client 生成 + 请求路径敏感模式扫描
3. `eslint` 静态检查（`--max-warnings=0`）
4. `prettier --check` 格式检查
5. `pnpm -r typecheck`：全部 8 个带 typecheck 的工作区包
6. `pnpm -r test`：全部 8 个包的 vitest（需真实 Redis/Postgres 的
   integration spec 按环境变量门控自动 skip，不需要外部服务）
7. 生产构建：collab-api、collab-admin、web、plugin-preview，
   以及 desktop 的纯前端 `vite:build`（不含 `tauri build`，
   那需要 Rust 工具链和数 GB 运行时产物，不进快速门禁）

提交前直接本地跑 `bash scripts/ci.sh` 最省事（全量约 1 分钟），
它和 CI 跑的是同一个脚本；只想快速自查时至少跑
`pnpm lint && pnpm format:check && pnpm -r typecheck && pnpm -r test`。

## 提交规范

使用 [Conventional Commits](https://www.conventionalcommits.org/)：

```
feat: 新增插件市场搜索过滤
fix: 修复更新签名校验失败时静默跳过的问题
test: 补充 release-signing 往返测试
docs: 更新安全政策
chore: 升级 eslint 配置
```

## 分支与 PR

- 从 `main` 切出 `feat/`、`fix/`、`chore/` 等特性分支；
- 向 `main` 发起 Pull Request，并在 PR 模板中勾选自检清单；
- 至少通过 CI 全部步骤后方可合并。
