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

### Don't: 把 Hook 放在条件 `return` 之后

**Problem**:

```tsx
function Market() {
  const [detail, setDetail] = useState(null);
  // ...其它 hooks
  if (detail) return <Detail .../>;        // 提前返回
  const totalPages = Math.ceil(total / N);
  useEffect(() => { if (page > totalPages) setPage(totalPages); }, [totalPages, page]); // ← 在提前返回之后
}
```

**Why it's bad**: React 要求每次渲染的 Hook 调用顺序与数量完全一致。`detail` 置值触发重渲染时在 `if (detail) return` 处截断，该 `useEffect` 不再执行，本次渲染比上次少一个 Hook → 抛 **React error #300**（"Rendered fewer hooks than expected. This may be caused by an accidental early return statement."），整页崩到 ErrorBoundary（DESK-MARKET-HOOKS：点击商店插件白屏即此因）。打包后只见 minified #300，本地 dev build 才有完整文案。

**Instead**:

```tsx
function Market() {
  const [detail, setDetail] = useState(null);
  const totalPages = Math.ceil(total / N);
  useEffect(() => { if (page > totalPages) setPage(totalPages); }, [totalPages, page]); // ← 所有 hooks 在提前返回之前
  if (detail) return <Detail .../>;
}
```

所有 Hook（含依赖派生值的 `useEffect`）必须在任何条件 `return` 之前调用；派生值（如 `totalPages`）也一并上移到返回之前，避免「为了喂 Hook 把计算留下、却把 Hook 推到 return 后」。新增依赖列表 ESLint 修复或防御性补丁时尤其要警惕这点。

