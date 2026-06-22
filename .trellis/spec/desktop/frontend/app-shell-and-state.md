# App Shell And State

## Navigation And Session

`apps/desktop/src/App.tsx` 是前端壳层。当前代码没有 React Router；页面由 `View` 字面量联合类型和 `setView` 切换。新增页面时要同步：

- `apps/desktop/src/lib/types.ts` 的 `View`
- `apps/desktop/src/App.tsx` 的页面分支
- `apps/desktop/src/components/Sidebar.tsx` 的 `NAV`
- `apps/desktop/src/lib/view-preload.ts` 的 loaders（预加载，可选但推荐）

**团队管理控制面板（TeamAdmin）**：顶级页面 `View = 'team-admin'`，仅团队管理员可见（RBAC：`isTeamManager(session.permissions)`）。
这是团队管理线路的核心 UI（与平台管理 web 端分离），含 5 个 tab：概览 / 成员管理 / 角色与权限 / 插件授权 / 邀请码与设置。子组件拆分在 `src/pages/team-admin/` 目录下（避免单文件过大，遵循 >1500 行必拆策略）。
注意：`team-admin` 走主 body 渲染（不被 `setView` 拦截到 AccountDialog），与 `team`（走 AccountDialog tab）不同。入口在左下角 **AvatarMenu**（不在 Sidebar NAV，`teamAdminOnly` 标志已随入口迁出而停用）。

会话状态只保存在内存中的 `Session`，`applySession` 同步更新 `lib/api.ts` 的模块级 auth token。不要在页面里直接维护第二份 token。

Reference files:
- `apps/desktop/src/App.tsx`
- `apps/desktop/src/lib/types.ts`
- `apps/desktop/src/components/Sidebar.tsx`

## Tenant-Scoped Local Preferences

固定到侧边栏的插件是本地偏好，按租户写入 `localStorage`，key 形如 `lf:pins:<tenantId>`。新增本地偏好时保持同样的租户隔离，不要把不同租户的 UI 状态混在一个 key 里。

Source pattern:
- `pinKey`, `loadPins`, `savePins` in `apps/desktop/src/App.tsx`

同构的租户隔离偏好还有「最近使用插件」`lf:recent:<tenantId>`（限量 5、置顶去重，在包装后的 `setRunningPlugin` 内写入，侧栏分区展示）。新增按租户隔离的列表型偏好时复用 `loadX/saveX` + `useEffect([session.tenantId])` 重载 + AppContext 暴露的同款骨架。

## Global UI-State Persistence

部分外壳 UI 状态是**全局**（非租户隔离）的 localStorage 偏好：

- `lf:sidebar-open`（`'1'/'0'`，首次无 key 默认折叠 `false`）—— 侧栏开合，`useState` 内联加载 + `useEffect([sidebarOpen])` 写盘。
- `lf:creator-open`（`'1'/'0'`，默认 `false`）—— 创建器悬浮窗开关态。`creatorOpen` 用 `useState(loadCreatorOpen)` + 包装 `setCreatorOpen` 同步写盘；登出 `resetSession` 内 `setCreatorOpen(false)` 清态，避免下次登录自动弹。
- `lf:sidebar-width`—— 侧栏展开态宽度（200–320，默认 224），拖拽结束写盘（见 `Sidebar.tsx`）。

新增全局 UI 偏好时沿用「内联加载初值 + effect/包装 setter 写盘」模式，不要为单个布尔开新的状态库。

## AvatarMenu（左下角用户菜单）

`components/AvatarMenu.tsx` 是从 `origin/lingfang-v4` 移植的富菜单，由 `App.tsx` 顶层渲染（`avatarMenuOpen` state），Sidebar 底部账户按钮点击唤起（替代直接 `openAccountSettings('account')`）。它**拥有**这些入口：通知中心（红点 `useUnreadCount`）、钱包、切换团队、插件管理、团队管理（`team-admin`，`isTeamManager` 可见）、开发者模式（创建器）、LLM 设置（→ 设置 gateway tab）、设置、帮助、主题切换、退出登录。

注意：`team-admin` 不再出现在 Sidebar NAV（已迁入此菜单）；`review`（platformAdminOnly）仍在侧栏。v4 原版的「版本发布管理」「token 余额」在桌面端**不适用**，移植时已剔除。通知中心抽屉随菜单挂载（侧栏不再有铃铛，避免与菜单重复轮询）。

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

