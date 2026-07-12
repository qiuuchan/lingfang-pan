# @lingfang/desktop 前端规范

## Scope

适用于 `apps/desktop/src/` 下的 React + Vite + Tailwind v4 前端。这里是 Tauri 壳内的产品工作台，不是独立 Web 站点。

## Pre-Development Checklist

- 修改入口、页面切换、会话或固定插件时，先读 [app-shell-and-state.md](./app-shell-and-state.md)。
- 修改 HTTP、SSE、静态配置、插件运行 iframe 或 Tauri 调用时，先读 [api-streaming-and-runtime.md](./api-streaming-and-runtime.md)。
- 修改页面 UI、shadcn/base-ui 组件或样式时，先读 [ui-composition.md](./ui-composition.md)。
- 修改插件创建首页、对话草稿、`plugin-draft` 解析/合并或 creator 组件拆分时，先读 [plugin-creator-organization.md](./plugin-creator-organization.md)。
- 修改插件中心目录边界、本机安装操作或独立草稿页面时，先读 [plugin-registry-ui.md](./plugin-registry-ui.md)。
- 跨服务端、契约、SDK 或 Tauri 时，同时读对应 package/layer 的 spec 和 `.trellis/spec/guides/cross-layer-thinking-guide.md`。

## Package Shape

- `App.tsx` 持有全局 UI 状态和 `AppContext`。
- `pages/` 是业务页面：生成器、插件、市场、钱包、审核、设置、登录与租户选择。
- `lib/` 放边界工具：`api.ts`、`stream.ts`、`types.ts`、`models.ts`、`money.ts`。
- `components/ui/` 是 shadcn/base-ui 风格的基础组件；业务组件在 `components/`。

## File Size Policy

- `>1500` 行源码必须拆分。
- `1000-1500` 行源码默认拆分；保留必须在任务文档中写明职责单一的理由。
- `300-999` 行源码进入监控；改动时优先抽纯函数、hooks、API helpers 或 presentational components。
- 生成文件和历史证据文件不作为拆分目标。

## Quality Check

- 前端类型检查：`pnpm -C apps/desktop typecheck`
- 前端构建：`pnpm -C apps/desktop vite:build`
- 前端测试：`pnpm -C apps/desktop test`
