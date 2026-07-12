# Implementation Plan

- [x] 扩展 admin package summary/page/detail contract 与 query DTO。
- [x] 实现 package-level 分页/筛选和 release lightweight projections。
- [x] 拆分 release core/manifest/files/reviews 按需 endpoints。
- [x] 将 currentReleaseId、source 和 delist metadata 投影到详情。
- [x] 用现有 DetailSheet/AsyncResource/Pagination 重做 plugins view。
- [x] 实现来源、四轴状态和合法动作显示；危险动作保留原因 Dialog。
- [x] 接入 approve/reject/platform suspend/relist，并处理 409/过期响应。
- [x] 将 Dashboard plugin metrics 切到 v4 registry 并补 backend tests。
- [x] 验证与 admin UI foundation 未提交改动兼容，不回退 shared components。
- [x] 运行 collab-api targeted tests、collab-admin typecheck/build、视觉检查。

## Validation

- `timeout 60s pnpm -C apps/collab-api test`
- `pnpm -C apps/collab-api typecheck`
- `pnpm -C apps/collab-admin typecheck`
- `pnpm -C apps/collab-admin build`
- Playwright/network assertions for lazy detail requests and action states
