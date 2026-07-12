# Implementation Plan

## 1. Registry Foundation

- [x] 完成 `07-12-plugin-registry-provenance-lifecycle`：contract、Prisma migration、来源字段、状态动作、并发审核、审计和测试。
- [x] 确认旧数据回填与旧客户端无来源 header 的兼容行为。
- [x] 运行 contract 与 collab-api 质量门。

## 2. Desktop Import And Publishing

- [x] 完成 `07-12-desktop-plugin-import-publish`：原生文件选择、local artifact 上传、源码目录二进制完整性、目标发布 Dialog 和发布管理。
- [x] 将 Creator、草稿页、Plugin Center 的入口收敛到共享发布/选择 helper。
- [x] 运行 desktop unit/typecheck/build、Rust tests，并对关键 UI 做 Playwright/截图检查。

## 3. Governance Integration

- [x] 完成 `07-12-plugin-governance-source-status`：管理端来源、精确 current release、平台 suspend/relist、v4 metrics 和按需详情。
- [x] 与现有 admin UI foundation 和 governance task 做冲突审查，不回退未提交修改。
- [x] 运行 collab-admin 与相关后端质量门。

## 4. Integration Review

- [x] 验证 `.lfplugin` 与源码目录两条入口、团队/市场两种目标、提审失败重试和所有合法/非法状态转换。
- [x] 验证二进制文件 round-trip SHA、旧 ledger/schema 兼容和审计完整性。
- [x] 执行 `trellis-check`、更新插件 registry/desktop/admin spec，并记录任务结果。
- [x] 依次完成并归档三个子任务，再归档父任务。

## Rollback Points

- 数据库 migration 为 additive；出现问题时可先回滚 UI/API 使用而保留新列。
- artifact 上传继续复用现有 v4 store；不得在失败回滚时删除已被 release 引用的 artifact。
- 市场提审失败不回滚团队 release，避免不可变制品与数据库状态不一致。
- 管理端切换到新投影前保留旧 route 一版兼容，但新 UI 不依赖旧 500 条宽列表。

## Validation Matrix

- `pnpm -C packages/contract test && pnpm -C packages/contract typecheck`
- `pnpm -C apps/collab-api prisma:generate`
- `timeout 60s pnpm -C apps/collab-api test`
- `pnpm -C apps/collab-api typecheck && pnpm -C apps/collab-api build`
- `cargo test -p lingfang-desktop`
- `pnpm -C apps/desktop test && pnpm -C apps/desktop typecheck && pnpm -C apps/desktop vite:build`
- `pnpm -C apps/collab-admin typecheck && pnpm -C apps/collab-admin build`
- `git diff --check`
