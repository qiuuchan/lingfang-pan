# 工程规范

## 仓库与工具链

- Node.js 20+，pnpm 9，Rust/Cargo 用于 Tauri。
- TypeScript workspace 由 `pnpm-workspace.yaml` 管理；Rust workspace 由根 `Cargo.toml` 管理。
- 共享契约放 `packages/contract`，插件能力客户端放 `packages/plugin-sdk`。

## 开发流程

1. 先读 `.trellis/spec/<layer>/index.md` 和对应规范。
2. 跨层字段先改 contract，再同步服务端、桌面和 SDK。
3. 新行为增加单元测试；Bug 修复增加回归测试。
4. 数据模型变更必须提供 Prisma migration，并验证 PostgreSQL/MySQL 渲染路径。
5. 公共 API、插件格式或运行时行为变更同步更新 docs 与 spec。

## 质量命令

```powershell
pnpm -r typecheck
pnpm -r test
pnpm -C apps/collab-api build
pnpm -C apps/collab-admin build
pnpm -C apps/desktop vite:build
cargo test -p lingfang-desktop
```

后端单元测试设置 60 秒硬超时。大文件遵循各层 spec 的拆分阈值；命令/controller 保持薄入口，把 IO、验证、事务和状态机放入专用模块。

## 安全与配置

- 密钥只来自环境变量或平台设置，不写入仓库。
- CORS 未配置时 fail-close。
- 生产关闭 Swagger。
- 插件进程使用最小环境和应用自带运行时，不继承敏感宿主变量。
