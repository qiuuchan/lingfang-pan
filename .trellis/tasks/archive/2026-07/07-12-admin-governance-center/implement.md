# Implementation Plan

- [x] 新增 admin governance contract schemas/tests/barrel export。
- [x] 新增分页/筛选 DTO 和 package-level controller routes。
- [x] 实现 package list 的两阶段轻量查询和 SemVer 投影。
- [x] 拆分 package/release/manifest/files/reviews 详情接口。
- [x] 为 approve/reject/delist 增加条件状态转换和并发测试。
- [x] 为 application list/detail 增加分页和轻量投影。
- [x] 修正 application approve/reject 事务抢占和通知时机。
- [x] 将 dashboard pending plugin count 改为 PluginRelease。
- [x] 新增 `governance` View、导航和懒加载入口。
- [x] 实现插件包分页列表、筛选和 DetailSheet 子 Tab 按需加载。
- [x] 实现申请分页列表和 DetailSheet 审批。
- [x] 删除新 UI 和遗留死组件对宽 release list/review-pending 的调用。
- [x] 覆盖快速切换乱序、失败保留原因、防重复提交和局部刷新。
- [x] 运行 contract、collab-api、collab-admin 质量门和视觉检查。

## Verification

- `pnpm -C packages/contract typecheck`：通过。
- `pnpm -C packages/contract test`：27/27 通过。
- `pnpm -C apps/collab-api test`（60 秒硬超时）：48 files，684/684 通过。
- `pnpm -C apps/collab-api typecheck` / `build`：通过。
- `pnpm -C apps/collab-admin typecheck` / `build`：通过。
- Playwright production preview：首开/Tab/Sheet/子 Tab 请求边界、page 2 不回退、mutation 单次 core 刷新、关闭重开重新请求、嵌套 Dialog ARIA 与焦点回归均通过。

## Targeted Tests

- package list projection/pagination/search/status。
- SemVer `1.10.0 > 1.9.0`。
- concurrent approve/reject and application approve/reject。
- historical release delist conflict / package delist preservation。
- no detail request before open; no child-tab request before activation。
