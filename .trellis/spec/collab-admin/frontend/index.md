# collab-admin 前端规范

## Scope

适用于 `apps/collab-admin/`：React + Vite + Tailwind v4 管理后台和未登录落地页。它面向平台管理员，不是桌面端插件创建工作台。

## Pre-Development Checklist

- 改登录态、页面切换、导航、命令面板或懒加载 view 时，先读 [app-shell-and-api.md](./app-shell-and-api.md)。
- 改后台业务视图、设置页、发布页或大组件拆分时，先读 [ui-composition.md](./ui-composition.md)。
- 改 v4 插件 package/release 治理、来源筛选、审核、下架或恢复时，先读 [plugin-governance.md](./plugin-governance.md)。
- 改后端 API payload、错误码或认证行为时，同时读 `.trellis/spec/collab-api/backend/index.md`。

## Package Shape

- `src/App.tsx` 是管理后台 shell：登录态、setup 向导、未登录落地页、view 切换和 lazy views。
- `src/lib/api.ts` 是 API 边界：token 存储、401 refresh、请求超时、错误对象。
- `src/lib/navigation.ts` 是导航、面包屑和命令面板的单一数据源。
- `src/components/*-view.tsx` 是后台业务 view；大型 view 必须拆成子目录组件。
- `src/components/landing/**` 是未登录落地页。

## Quality Check

- Typecheck: `pnpm -C apps/collab-admin typecheck`
- Build: `pnpm -C apps/collab-admin build`

## File Size Policy

- `>1500` 行源码必须拆分。
- `1000-1500` 行源码默认拆分；保留必须写明理由。
- `300-999` 行 view 改动时优先抽 hooks、API helpers、form sections 和 presentational components。
