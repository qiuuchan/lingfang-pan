# 修复商店插件页 React #300 崩溃

## Goal

消除点击插件市场列表项进入详情时触发的 React error #300 崩溃，使详情页正常渲染。

## 根因

`apps/desktop/src/pages/Market.tsx` 的 `Market` 组件违反 Hooks 规则：

- 第 69 行：`if (detail) return <Detail .../>;`（提前返回）
- 第 80-82 行：在该提前返回**之后**还有一个 `useEffect`（MARKET-PAGE 收敛补丁）

首次渲染 `detail === null`，走到第 80 行的 `useEffect`，本次渲染 Hook 计数包含它。点击插件后 `setDetail(...)` 置值 → 重渲染时第 69 行命中提前返回，第 80 行的 `useEffect` 不再执行 → 本次渲染 Hook 数少于上次 → React 抛 #300「Rendered fewer hooks than expected. This may be caused by an accidental early return statement.」→ 被 `main.tsx` ErrorBoundary 捕获，显示"应用遇到错误，页面渲染过程中出现问题"。

`Detail` 子组件自身 Hooks 合规，不是崩溃源。

## Requirements

- 将第 80-82 行的 `useEffect`（及其依赖的 `totalPages` 等计算）调整到第 69 行提前返回**之前**，保证任何渲染路径下 `Market` 组件的 Hooks 调用顺序与数量恒定。
- 保留该补丁原有语义（`page > totalPages` 时收敛 `page`），注释说明为何必须置于提前返回之前。
- 不改变 `Detail` 组件行为，不改动后端，不引入向后兼容包袱。

## Acceptance Criteria

- [ ] `Market.tsx` 中所有 Hooks（含 page 收敛 `useEffect`）都在 `if (detail) return` 之前调用。
- [ ] 点击市场任意插件进入详情，不再触发 React #300，详情页正常渲染。
- [ ] page 收敛逻辑行为不变（列表缩短后 page 自动回到有效范围）。
- [ ] 前端类型检查/构建通过（`pnpm --filter @lingfang/desktop build` 或 `tsc`）。

## Notes

- 单文件改动，PRD-only 轻量任务。
- 验证：构建通过即可证明类型/语法正确；Hooks 顺序通过代码审查确认（提前返回后无任何 Hook）。
