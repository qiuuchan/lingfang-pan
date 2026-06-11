# tools

开发与验证脚本（按 docs/06 工程规范）。

- `db:up`（已在根 `package.json`）：起本地 PostgreSQL。
- TODO(M0)：迁移脚本、集成测试 runner、`verify` 一键本地验证（注册 → 建租户 → 邀成员 → 装插件 → 授权 → 调用并落审计 → 重启数据仍在）。
