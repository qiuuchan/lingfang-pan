# Design: 管理端异步资源与响应式基础

## Components

### `src/lib/api.ts`

- `ApiOptions` 增加 `signal?: AbortSignal`。
- 内部 timeout controller 监听外部 signal；清理 timer 和 listener。
- 外部 signal 已取消时保留 AbortError 语义，领域 hook 静默忽略。
- 30 秒默认超时继续转换为友好错误。

### `src/lib/async-resource.ts`

提供轻量 hook，不引入 TanStack Query：

- `useAsyncResource(loader, deps, options)`。
- 每次依赖变化创建 AbortController 和递增 request token。
- 返回 `status/data/error/reload/setData`。
- 可选 `enabled`，用于未打开 Tab/Sheet 时保持 idle。
- view 会话级 detail cache 由领域 hook 用 Map 组合，不放进通用 UI 组件。

### `components/ui/async-resource.tsx`

纯展示组件，接收 status、error、retry、isEmpty、loading fallback 和 children。列表/详情 skeleton 由调用方提供。

### `components/ui/pagination.tsx`

- 删除或标记弃用 `usePagination`。
- `Pagination` 继续消费 `totalItems/pageSize/currentPage`。
- `sm` 以下只显示 previous、`page/totalPages`、next 和紧凑 page-size menu。
- 所有 icon button 增加 `aria-label` 和 Tooltip。

### `components/ui/detail-sheet.tsx`

- 保持现有 props，内部改用 Radix `Sheet`。
- Header、scroll content、Footer 三段固定布局。
- `size='md|lg|xl'`；手机全宽，桌面约 640/768/896px。
- 标题允许换行，不使用 truncate。

### Shared Layout

- `Table` 使用 `rounded-lg`、`.scrollbar-thin`、`overflow-x-auto`。
- `Card`、Button、Input、Select、Dialog 的主要圆角收敛到 8px 以内。
- `Section` 使用无框或底边分隔；增加可选 actions。
- `InfoGrid` 使用 definition list，不在 Sheet 内制造嵌套卡片。

## Shell

- `App` 根使用 `h-dvh`。
- Header 变为紧凑栏，移动菜单入口放入 Header。
- 内容区 `max-w-[1600px]`、稳定 padding、单一滚动。
- 固定 Footer 不再参与首屏；版本信息移至 About。
- Sidebar 接收 expanded/compact header/footer 或 render callback；移动内容始终 expanded。

## Compatibility

- 保留旧组件导出名，后续 view 可渐进迁移。
- 此子任务不改变导航 view union 和 API payload。

