# @lingfang/desktop 前端规范

## Scope

适用于 `apps/desktop/src/` 下的 React + Vite + Tailwind v4 前端。这里是 Tauri 壳内的产品工作台，不是独立 Web 站点。

## Pre-Development Checklist

- 修改入口、页面切换、会话或固定插件时，先读 [app-shell-and-state.md](./app-shell-and-state.md)。
- 修改 HTTP、SSE、静态配置、插件运行 iframe 或 Tauri 调用时，先读 [api-streaming-and-runtime.md](./api-streaming-and-runtime.md)。
- 修改页面 UI、shadcn/base-ui 组件或样式时，先读 [ui-composition.md](./ui-composition.md)。
- 跨服务端、契约、SDK 或 Tauri 时，同时读对应 package/layer 的 spec 和 `.trellis/spec/guides/cross-layer-thinking-guide.md`。

## Package Shape

- `App.tsx` 持有全局 UI 状态和 `AppContext`。
- `pages/` 是业务页面：生成器、插件、市场、钱包、审核、设置、登录与租户选择。
- `lib/` 放边界工具：`api.ts`、`stream.ts`、`types.ts`、`models.ts`、`money.ts`。
- `components/ui/` 是 shadcn/base-ui 风格的基础组件；业务组件在 `components/`。

## Quality Check

- 前端类型检查：`pnpm -C apps/desktop typecheck`
- 前端构建：`pnpm -C apps/desktop vite:build`
