# tools

开发、分发与验证脚本。

## 启动

- `start.ps1`：Windows / PowerShell 一键启动。准备 `.env`，启动服务端，等待 `/health`，再启动桌面壳。
- `start.sh`：macOS / Linux 一键启动，流程同上。
- 根脚本映射：
  - `pnpm start` → `tools/start.ps1`
  - `pnpm start:sh` → `tools/start.sh`
  - `pnpm start:backend` → 只启动后端

服务端默认使用 SQLite，首次启动会自动创建 `lingfang.db` 并运行迁移。

## 分发

- `create-distribution.ps1`：创建源码分发包，排除依赖、构建产物、日志、`.env`、本地数据库等。
- `test-distribution.ps1`：用于检查分发包可用性。

桌面端后端地址可以通过 `apps/desktop/public/app.config.json` 预置，也可以在应用首次启动或设置页里修改。

## 验证

- `verify.ps1`：项目验证入口。
- `verify-economy.ps1`：钱包、市场、经济链路验证。

常用手动验证：

```bash
pnpm -C apps/desktop typecheck
pnpm -C apps/desktop vite:build
cargo test -p server
```