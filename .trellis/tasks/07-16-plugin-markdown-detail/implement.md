# 插件 Markdown 描述页与 SDK 文档实施计划

## 1. 审计现有候选实现

- [x] 对照相关 Trellis spec 检查 contract、API、desktop、SDK 与文档边界。
- [x] 逐文件确认当前 dirty working tree 的改动归属，避免覆盖其他 07-15 插件平台任务。
- [x] 检查 release migration/schema、列表 select 与详情 select，确认 README 不泄漏到列表和非详情 mutation 响应。

## 2. 完成发行版描述链路

- [x] 补齐制品根 README 提取、UTF-8/256 KiB 校验与服务端测试。
- [x] 补齐 release detail contract、registry service/controller 与投影测试。
- [x] 确认本机安装/加载链路保留 release README，并兼容旧安装项。

## 3. 完成桌面详情界面

- [x] 统一已安装、团队库、市场详情模型与 VS Code 风格简洁布局。
- [x] 远端 README 按 release id 延迟加载，处理 loading/error/关闭与竞态。
- [x] 强化插件 README 安全渲染：GFM、外链、禁图片、禁 raw HTML/危险协议。
- [x] 为详情数据流和安全渲染补 focused tests，并覆盖 URL 安全纯函数。

## 4. 更新 SDK 与开发说明

- [x] `validate`/`build` 复用 README 校验器并覆盖超限、非法 UTF-8 测试。
- [x] 更新 client/nodejs/python README 模板和 create 测试。
- [x] 更新 SDK README 与插件开发文档，覆盖 manifest、README、CLI、runtime、capability 与展示规则。

## 5. Verification

- [x] `pnpm -C packages/contract test && pnpm -C packages/contract typecheck`
- [x] `pnpm -C packages/plugin-sdk test && pnpm -C packages/plugin-sdk typecheck`（该包无 `build` script；CLI build 行为由测试覆盖）
- [x] `pnpm -C apps/collab-api prisma:generate`
- [x] `pnpm -C apps/collab-api test -- --testTimeout=60000 src/modules/plugin-artifact.spec.ts src/modules/plugin-registry-upload.spec.ts src/modules/plugin-registry.service.spec.ts`
- [x] `pnpm -C apps/collab-api typecheck && pnpm -C apps/collab-api build`
- [x] `pnpm -C apps/desktop test`（全量 38 files / 322 tests）
- [x] `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop vite:build`
- [x] Rust focused：`cargo test -p lingfang-desktop readme -- --nocapture`
- [x] `git diff --check`

## Risk And Rollback Points

- Prisma schema 正被其他插件平台任务并行修改；只验证/复用既有 additive `readmeMarkdown`，不重写无关 schema。
- `PluginCenterBody.tsx` 与 registry files 可能同时承载其他任务改动；使用小范围 patch，禁止 reset/checkout/clean。
- 全量 desktop/collab-api 测试可能受并行未完成任务影响；先跑 focused tests，再区分本任务失败与工作树既有失败。
