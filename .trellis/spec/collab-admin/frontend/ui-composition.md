# collab-admin UI 组合规范

## View Boundaries

后台 view 面向重复管理操作，优先使用密度适中的表格、筛选、Dialog 和表单 section。不要把多个设置域长期塞进一个超大组件。

大型 view 拆分方向：

- `settings-view.tsx`：拆成 platform、SMTP、Geetest、Gitee 等 form section，并提取共享 API hooks。
- `plugins-view.tsx`：拆列表、审核操作、详情 Dialog、状态 badge。
- `releases-view.tsx`：拆 release 列表、asset 上传、发布/归档操作。

## State Placement

- 只被一个 form section 使用的字段放在 section 内。
- 跨 section 的加载、保存、toast 和 reload 放在 view shell 或 hook。
- API payload mapping 放在 `src/lib/` 或本 view 子目录 helper，不要内联在 JSX 深处。

## Async Resource And Pagination

- 远程资源统一区分 `idle/loading/ready/empty/error`。错误必须保留重试入口，不能渲染成“暂无数据”。
- `useAsyncResource(loader, deps, { enabled })` 的 loader 接收 `AbortSignal`；对象、筛选或分页变化时旧请求必须取消或被 request id 忽略。
- 无界集合使用服务端 `items/total/page/pageSize`。`Pagination` 完全受控；`usePagination(items)` 只保留给迁移期的本地有界数据。
- 未打开的 Tab、Sheet 和编辑器不得请求其数据。有界字典也只能在对应控件首次打开后加载。

```tsx
const resource = useAsyncResource(
  (signal) => api<Page<UserSummary>>(`/api/admin/users?page=${page}`, { signal }),
  [page],
  { isEmpty: (result) => result.items.length === 0 },
);
```

## Detail Surfaces And Table Actions

- 详情使用 `DetailSheet`，保持固定 header、独立滚动正文和固定 footer；危险动作再打开确认 Dialog。
- 受控 Sheet 必须显式记录触发元素，并在 `onCloseAutoFocus` 归还焦点。移动侧栏由 App 页头按钮控制时同样适用。
- `TableRow` 仅承担表格结构语义，不绑定 `onClick`、`role=button` 或 `tabIndex`。
- 打开详情使用真实按钮，优先放在主字段内的 `TableCellAction`，并提供动作化 `aria-label`。

```tsx
<TableRow>
  <TableCell>
    <TableCellAction
      aria-label={`查看用户详情：${user.email}`}
      aria-haspopup="dialog"
      onClick={() => setActive(user)}
    >
      {user.email}
    </TableCellAction>
  </TableCell>
</TableRow>
```

不要让整行伪装成按钮：表格行没有稳定的交互名称，且行内编辑、删除按钮会形成冲突的键盘和点击语义。

## Scenario: 服务端分页与详情资源生命周期

### 1. Scope / Trigger

- 修改远程列表分页、详情 Sheet、详情子 Tab 缓存或 mutation 后刷新逻辑时适用。
- 目标是避免旧页响应回退页码、旧详情动作残留，以及审核后重复加载不可变大字段。

### 2. Signatures

```ts
type Page<T> = { items: T[]; total: number; page: number; pageSize: number };

useAsyncResource<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  dependencies: DependencyList,
  options?: { enabled?: boolean; isEmpty?: (data: T) => boolean },
): UseAsyncResourceResult<T>;
```

详情缓存 key 使用 `core:<id>`、`manifest:<id>`、`files:<id>:<page>`、`reviews:<id>:<page>`；缓存只允许存活于一次 DetailSheet 会话。

### 3. Contracts

- 分页越界回退只有在 `data` 存在且 `data.page/pageSize` 等于当前查询时执行；loading 或旧查询数据不得改写当前页码。
- 用户显式切换详情分页时先清当前 selection 和 action footer；mutation 刷新同页时保留 selection，避免子资源重复请求。
- Sheet 关闭或主对象 id 变化时清空详情缓存；浏览多个对象不能让 Map 无界增长或长期返回陈旧审核记录。
- mutation 只失效可变的 list/core/reviews；不可变的 manifest/file manifest 不重复请求。
- 固定 footer 只有在 core payload 的对象 id 与当前 selection 一致时显示动作。
- 多个确认动作共享 Dialog 时，在点击时记录 `event.currentTarget`，关闭后只回焦实际触发按钮。

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| page 2 请求启动，内存仍是 page 1 数据 | 忽略旧数据，不回退 page 1 |
| 当前页 mutation 后变成越界页 | 当前查询返回后回退到最后有效页 |
| 切换详情分页且请求较慢 | selection 置空，footer 不显示旧对象动作 |
| Sheet 关闭后再次打开同对象 | 重新请求 overview/releases/core |
| 审核时停留 Manifest/Files | 刷新 core/reviews，不重复请求不可变 payload |
| Dialog 触发按钮已被 mutation 移除 | 不强制 focus 已断开的元素 |

### 5. Good/Base/Bad Cases

- Good: page 2 只发一次 page 2 请求；审核后只刷新一次当前 core，Manifest/Files 请求数不变。
- Base: 关闭详情再打开同一对象会获取最新状态，同时一次打开会话内重复切 Tab 可命中缓存。
- Bad: loading 将 `data` 清空后按 `total=0` 回退 page 1，或 mutation 对整个 cache `clear()` 并 reload 所有子资源。

### 6. Tests Required

- Playwright 记录请求：首开只有当前 Tab 列表；打开对象后才有 overview/releases/core；激活子 Tab 后才有对应请求。
- 分页断言 `page=2` 后没有新的 `page=1` 请求，且 UI 展示第 2 页数据。
- mutation 断言 core 只请求一次，Manifest/Files 不重载；关闭重开断言详情重新请求。
- 嵌套 Dialog 断言可见内容没有 `aria-hidden=true` 祖先，关闭后焦点回到实际触发按钮。

### 7. Wrong vs Correct

```tsx
// Wrong: loading 或旧页数据会把新页码立即改回 1。
const totalPages = Math.max(1, Math.ceil((resource.data?.total ?? 0) / pageSize));
if (page > totalPages) setPage(totalPages);

// Correct: 只有当前查询的真实响应能校正当前页码。
if (!resource.data || resource.data.page !== page || resource.data.pageSize !== pageSize) return;
const totalPages = Math.max(1, Math.ceil(resource.data.total / pageSize));
if (page > totalPages) setPage(totalPages);
```

## Settings View Shared Components

When `settings-view.tsx` is just over the 1000-line trigger, first extract real shared controls before splitting stateful form sections. Good low-risk candidates:

- theme option button/card -> `components/settings/SettingsShared.tsx`;
- reveal-secret dialog/button -> `components/settings/SettingsShared.tsx`.

Keep shared components below the function-length limits as well. If a moved component owns a dialog with multiple states, split inner content/footer helpers rather than leaving one long render function.

## File Size Trigger

修改 `1000+` 行 view 时，本次改动必须顺手抽出一个真实职责模块，除非任务文档写明不拆的理由。

Wrong:

```tsx
export function SettingsView() {
  // platform + smtp + captcha + gitee + all dialogs in one body
}
```

Correct:

```tsx
export function SettingsView() {
  return (
    <>
      <PlatformSettingsSection />
      <SmtpSettingsSection />
      <GeetestSettingsSection />
      <GiteeSettingsSection />
    </>
  );
}
```
