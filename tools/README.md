# tools

开发、分发与验证脚本。

## 启动

- `start.ps1`：Windows / PowerShell 一键启动。流程：校验 `apps/collab-api/.env` → 检查 PostgreSQL 连通 → `prisma migrate deploy` + 建平台管理员 → 启动 collab-api（NestJS，:3000）→ 等待 `/api/health` → 启动桌面壳（Tauri）。
- 根脚本映射：
  - `pnpm start` → `tools/start.ps1`（启动 collab-api + 桌面壳）
  - `pnpm start:backend` → `tools/start.ps1 -SkipDesktop`（只起后端）

> macOS / Linux 用户需自行通过 `pnpm -C apps/collab-api dev` 与 `pnpm -C apps/desktop dev` 分步启动（当前仅提供 PowerShell 版启动脚本）。

后端（apps/collab-api）默认使用 PostgreSQL（lingfang_collab 库），首次启动会运行 Prisma 迁移并生成平台管理员。

## 分发

- `create-distribution.ps1`：创建源码分发包，排除依赖、构建产物、日志、`.env`、本地数据库等。
- `test-distribution.ps1`：用于检查分发包可用性。

桌面端后端地址可以通过 `apps/desktop/public/app.config.json` 预置，也可以在应用首次启动或设置页里修改。

## 验证

后端单元测试使用 Vitest：

```bash
pnpm -C apps/collab-api test
```

常用手动验证：

```bash
pnpm -C apps/desktop typecheck
pnpm -C apps/desktop vite:build
pnpm -C apps/collab-api typecheck
```
