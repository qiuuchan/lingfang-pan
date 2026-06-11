# App Shell And State

## Navigation And Session

`apps/desktop/src/App.tsx` 是前端壳层。当前代码没有 React Router；页面由 `View` 字面量联合类型和 `setView` 切换。新增页面时要同步：

- `apps/desktop/src/lib/types.ts` 的 `View`
- `apps/desktop/src/App.tsx` 的页面分支
- `apps/desktop/src/components/Sidebar.tsx` 的 `NAV`

会话状态只保存在内存中的 `Session`，`applySession` 同步更新 `lib/api.ts` 的模块级 auth token。不要在页面里直接维护第二份 token。

Reference files:
- `apps/desktop/src/App.tsx`
- `apps/desktop/src/lib/types.ts`
- `apps/desktop/src/components/Sidebar.tsx`

## Tenant-Scoped Local Preferences

固定到侧边栏的插件是本地偏好，按租户写入 `localStorage`，key 形如 `lf:pins:<tenantId>`。新增本地偏好时保持同样的租户隔离，不要把不同租户的 UI 状态混在一个 key 里。

Source pattern:
- `pinKey`, `loadPins`, `savePins` in `apps/desktop/src/App.tsx`

## Page State Pattern

页面用 React 本地 state 和 `useEffect` 拉取数据；项目目前没有全局 server-state 库。新增页面时优先保持这种直接模式：

- 页面内维护 loading/error/submitting 状态。
- 后端调用走 `api()`，错误用 `toast.error` 或局部错误区展示。
- 需要跨页面的少量状态才放进 `AppContext`，如 `currentDraft`、`runningPlugin`。

Avoid adding a new global state library for one page. It would not match the current app shape.

