# 工程指南

## 仓库结构

```text
apps/
  desktop/       Tauri 2 + React 桌面应用与 Rust 本机能力
  collab-api/    NestJS + Prisma 平台后端
  collab-admin/  React 管理后台与未登录页面
packages/
  contract/      Zod 跨层契约
  plugin-sdk/    插件能力客户端 SDK
  ui-tokens/     共享设计令牌
plugins/
  summarizer/    示例插件
docs/            当前文档、历史设计与 ADR
```

## 本地开发

```bash
pnpm install
cp apps/collab-api/.env.example apps/collab-api/.env
pnpm -C apps/collab-api db:setup
pnpm -C apps/collab-api dev
pnpm -C apps/collab-admin dev
pnpm -C apps/desktop dev
```

桌面开发需要 Rust/Tauri 工具链。平台数据使用 PostgreSQL 或 MySQL；Redis 是可选缓存，不是正确性依赖。

## 代码边界

- 共享 JSON 形状先在 `packages/contract` 定义，再更新 API 和消费者。
- `collab-api` 拥有云端业务状态；桌面 Rust 只拥有本机文件、进程、安装和更新能力。
- 管理端列表使用服务端分页与轻量投影，详情和关联集合按需加载。
- Tauri command 保持薄入口，路径校验、下载、进程和账本逻辑放在 Rust 模块中。
- 插件运行不得继承宿主敏感环境变量；运行时、镜像和 PATH 由 Resolver 构造。

## 质量命令

```bash
pnpm -C packages/contract typecheck
pnpm -C packages/contract test
pnpm -C apps/collab-api typecheck
pnpm -C apps/collab-api test
pnpm -C apps/collab-api build
pnpm -C apps/collab-admin typecheck
pnpm -C apps/collab-admin build
pnpm -C apps/desktop typecheck
pnpm -C apps/desktop test
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
git diff --check
```

后端完整测试应设置 60 秒硬超时。跨层变更至少覆盖契约解析、后端投影/状态转换和前端消费。

## 数据库与迁移

`apps/collab-api/prisma/schema.prisma` 是模型源文件。迁移必须是可部署的增量变更；列表查询使用白名单 `select`，分页的 `findMany` 与 `count` 共享过滤条件。GET 路径不得通过 ensure helper 隐式写库。

## 桌面打包

```bash
pnpm -C apps/desktop build
pnpm dist
```

桌面安装包包含应用和必要静态资源。Python/Node 运行时由应用按需下载到用户目录，不应作为大型资源打进安装包。更新产物通过 Tauri updater 签名和平台 release 目录分发。

## 文档约定

- `README.md` 与 `docs/01-*`、`02-*`、`04-*` 描述当前实现。
- 根目录中带“历史参考”声明的设计文档用于解释迁移背景。
- `docs/adr/` 保存当时决策，不因当前实现变化而重写历史。
