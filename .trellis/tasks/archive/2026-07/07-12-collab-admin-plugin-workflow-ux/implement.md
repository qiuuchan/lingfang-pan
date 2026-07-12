# Implementation Plan: 后台管理端动态加载与治理中心重构

> 集成完成记录（2026-07-12）：Contract/API/Admin/Rust/Desktop 质量门通过；治理 Playwright 6 项通过；浏览器覆盖 1440×900、1280×720、1024×768、768×1024、390×844、360×800，未发现页面级横向溢出。

## Execution Order

- [x] 完成并启动 `07-12-admin-ui-foundation`。
- [x] 基于 foundation 启动 `07-12-admin-governance-center`。
- [x] foundation 稳定后并行推进 `07-12-admin-core-data-loading` 与 `07-12-admin-billing-data-loading`。
- [x] 治理导航稳定后推进 `07-12-admin-dashboard-settings-lazy`。
- [x] 父任务执行跨子任务集成检查、视觉回归和最终归档。

## Cross-Task Gates

### Gate A: Shared Foundation

- [x] `api()` 支持外部取消，取消请求不产生误导错误。
- [x] `AsyncResource`、受控 Pagination、Radix DetailSheet、响应式 Table 可被业务 view 复用。
- [x] Shell/Sidebar 在 1024px 边界和移动端无文案丢失、溢出或焦点问题。
- [x] `pnpm -C apps/collab-admin typecheck`、`build` 通过。

### Gate B: Governance

- [x] 包级列表首屏不含 manifest、fileManifest 和 reviews。
- [x] 插件包、发行版、详情子 Tab 和申请详情均按需加载。
- [x] 并发审核/审批只有一个请求成功，无矛盾 audit/review/team 数据。
- [x] 当前市场版和下架语义正确。
- [x] Contract、collab-api、collab-admin 质量门通过。

### Gate C: Core And Billing Data

- [x] 所有无界列表返回 `items/total/page/pageSize`，前端无客户端全量分页。
- [x] 列表 projection 不包含详情重字段和敏感字段。
- [x] Credits 无 N+1，任何 GET 列表路径不写数据库。
- [x] 未打开的类型、编辑器和详情 Tab 不请求数据。

### Gate D: Dashboard And Settings

- [x] Dashboard 首屏只加载核心指标；分析区按需。
- [x] Settings 默认只加载基础 Tab，其他配置域首次打开才加载。
- [x] Dashboard 待办能定位治理中心正确 Tab 和 PENDING 筛选。

## Integration Verification

```bash
pnpm -C packages/contract typecheck
pnpm -C packages/contract test
pnpm -C apps/collab-api typecheck
pnpm -C apps/collab-api build
pnpm -C apps/collab-admin typecheck
pnpm -C apps/collab-admin build
git diff --check
```

Backend tests must run with a 60-second hard timeout:

```bash
pnpm -C apps/collab-api test
```

Targeted suites must cover plugin registry, admin service, auth application transitions, releases and billing pagination before the full suite.

## Network Assertions

- [x] Entering Dashboard does not request generation stats, finance stats or changelog.
- [x] Entering Governance requests only the active Tab first page.
- [x] Opening a plugin requests only that package overview/releases; manifest/files/reviews wait for their Tab.
- [x] Opening an application requests its detail; unopened rows do not.
- [x] Entering Settings requests only the default Tab domain.
- [x] Entering Channels requests only the active kind.
- [x] Fast entity/filter/page changes abort or ignore old responses.

## Visual And Accessibility Checks

- [x] 1440x900 and 1280x720 desktop layouts.
- [x] 1024x768 breakpoint transition.
- [x] 768x1024 tablet navigation.
- [x] 390x844 and 360x800 mobile layouts.
- [x] No hidden-scrollbar ambiguity, clipped text, overlapping controls or pagination overflow.
- [x] Sheet focus trap, ESC, overlay close, focus return and nested confirmation behavior.

## Rollback Points

- Shared UI foundation can be reverted independently before view migration.
- Each endpoint keeps old route compatibility until its frontend consumer is migrated.
- Core and billing views migrate one view at a time; a failed view can temporarily retain the old endpoint without blocking others.
- Governance UI rollback uses old release routes; new package summary routes and additive schemas may remain.
- Database index additions, if any, are non-destructive and need not be rolled back with application code.
