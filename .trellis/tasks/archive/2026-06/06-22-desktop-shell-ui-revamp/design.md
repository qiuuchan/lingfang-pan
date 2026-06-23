# Design — desktop 外壳与插件体验 9 项调整

> 配套 `prd.md`。本文聚焦技术决策、契约与数据流；执行清单见 `implement.md`。
> 目标应用：`apps/desktop`。所有路径相对 `apps/desktop/`。

## 总体策略

9 项改动可分三类，按「先低风险布局清理 → 再导航/菜单重构 → 最后插件体验」顺序实施，降低互相干扰：

- **A. 布局微调（项 1/2/5/8）**：纯展示层，改动小、独立、可并行。
- **B. 导航与用户菜单重构（项 3/4）**：项 3 依赖项 4 的 AvatarMenu 就位（入口要搬进去），故 **4 先于 3**。
- **C. 插件体验（项 6/7/9）**：彼此独立，但 9 需在 `App.tsx` 的 `setRunningPlugin` 注入记录逻辑，与 7（也在 App.tsx 改 creatorOpen）同文件，注意合并。

---

## 项 1 — 首页搜索框居中

**现状**：`pages/Home.tsx:17` 根容器 `flex h-full flex-col items-center justify-center px-6 py-10`；搜索按钮 `w-full max-w-xl`（`Home.tsx:25-33`）。外层 `App.tsx:549-550` 为 `min-h-0 flex-1 overflow-y-auto px-6 py-6` → `mx-auto w-full max-w-6xl`。

**根因假设（待运行实测确认）**：
- (a) `h-full` 在 `overflow-y-auto` 父容器内，当内容高度 < 容器高度时 `justify-center` 生效；但若内容溢出触发滚动，垂直居中「看起来」偏上——可能被误判为「不居中」。水平方向 `items-center` 应当生效。
- (b) 主体区左侧有侧栏，主体水平中心 ≠ 视口中心，用户可能期望视口居中。这是标准模式，**by design 不改**（除非用户明确要求视口居中）。
- (c) 真 bug：`max-w-6xl` 内层 + `max-w-xl` 按钮双重居中，若某层 `mx-auto` 缺失会偏移——已查代码，内层有 `mx-auto`，按钮靠 `items-center` 居中，应无偏移。

**处理**：
1. 实施时先 `pnpm tauri dev` 运行，截图观察不同窗口宽度下的实际表现。
2. 若确属 (a)：保持水平居中即可（垂直可不强求中心，内容自然排布）。
3. 若发现真偏移：确保 Home 根用 `mx-auto` + `w-full`，搜索按钮用 `mx-auto w-full max-w-xl`，不依赖父级 flex。
4. 属 (b) 则记「by design」并在 PRD Open Questions 勾掉。

**不引入** 新依赖、不改外层 `max-w-6xl`（其他页面共用）。

---

## 项 2 — 侧栏默认折叠 + 持久化

**现状**：`App.tsx:192` `const [sidebarOpen, setSidebarOpen] = useState(true);`；`TitleBar.tsx` 传入 `onToggleSidebar`。

**方案**：
- 新增 `src/lib/sidebar-prefs.ts`（或在 `App.tsx` 内联 helper）：
  ```ts
  const SIDEBAR_OPEN_KEY = 'lf:sidebar-open';
  function loadSidebarOpen(): boolean {
    try { const raw = localStorage.getItem(SIDEBAR_OPEN_KEY); return raw === null ? false : raw === '1'; }
    catch { return false; } // 默认折叠
  }
  ```
- `useState(loadSidebarOpen)`；`setSidebarOpen` 的两处调用（TitleBar toggle、以及项 4 之后可能新增）需同步写盘。用 `useEffect(() => { try { localStorage.setItem(SIDEBAR_OPEN_KEY, sidebarOpen ? '1' : '0'); } catch {} }, [sidebarOpen])` 统一持久化，避免每处手写。
- 首次无 key → `false`（默认折叠）；用户切换后写盘；重启恢复。

**与项 1 的交互**：默认折叠后侧栏更窄，主体中心更接近视口中心——可能顺带缓解项 1 的观感。

---

## 项 5 — 删除页脚

**现状**：`App.tsx:8` import `{ Footer }`；`App.tsx:556` `<Footer />`；文件 `components/Footer.tsx`。

**方案**：
1. `App.tsx` 删 import 与渲染。
2. 全仓搜 `Footer` 引用（`components/Footer.tsx` 应仅被 `App.tsx` 用）——确认后删文件。
3. 主体区 flex-col 末尾少一个 shrink-0 子元素，内容区 `flex-1` 自然扩展，无残留空白（Footer 原本 border-t，移除后干净）。

---

## 项 8 — 删侧栏顶部「灵坊」（含 logo）

**现状**：`Sidebar.tsx:138-153` header 含 logo + `platformName`（span 文本）+ `<br/>` + 「协作平台前台」副标题（仅展开态）。

**方案（用户确认连 logo 一起删）**：删除整个 header `<div className="flex items-center gap-2 border-b px-3 py-3.5 ...">...</div>`（`:138-153`）。搜索栏（原 `:155-193`）成为侧栏最顶部。`platformName`/`platformLogoUrl` 仍由 `useApp()` 提供（其他地方可能用），仅不在 Sidebar 渲染；若 `platformLogoUrl`/`platformName` 在 Sidebar 内不再被引用，相应从解构中移除以避免未用变量 lint。`HomeIcon` import 若仅 header 用则一并删。

---

## 项 4 + 项 3 — AvatarMenu 移植与导航重构（核心）

### 4.1 文件落点

新建 `apps/desktop/src/components/AvatarMenu.tsx`，以 `git show origin/lingfang-v4:apps/desktop/src/components/AvatarMenu.tsx` 为蓝本改写。

### 4.2 与当前架构的差异与适配

| v4 原貌 | 当前 main 现状 | 适配 |
|---|---|---|
| `useTheme()` from `next-themes` | `next-themes` 已是依赖 | 直接用 |
| `resetSession` from `useApp()` | 存在 | 直接用 |
| `setView('team'/'team-manage'/'creator'/'llm'/'releases'/'plugins'/'settings')` | View 类型不含 `team-manage`/`llm`/`releases`；`setView` 已拦截 `creator`/`settings`/`wallet`/`team` 转投 AccountDialog/创建器 | 见下映射表 |
| `api('/api/notifications')` 取 unreadCount | `NotificationCenter` 已有 `useUnreadCount` hook | 复用 `useUnreadCount`，避免重复轮询与接口漂移 |
| `api('/api/teams/current/profile')` 取 tokenBalance | 桌面端钱包数据走 AccountDialog wallet tab | **删掉 tokenBalance 请求**（桌面端无此数据契约；账号头只显示名/租户/角色），避免 404 噪音 |
| 角色判定 `session.role === 'TEAM_ADMIN' \|\| 'DEVELOPER'` | RBAC 走 `session.permissions` + `isTeamManager()` | 改用 `isTeamManager(session.permissions)` 判定团队管理/开发者入口可见性 |
| `isPlatformAdmin` 判定 `session.isPlatformAdmin` | 同 | 直接用 |

### 4.3 View 映射表（AvatarMenu 菜单项 → 当前跳转）

| 菜单项 | v4 setView | 当前映射 | 可见性 |
|---|---|---|---|
| 通知中心 | `onOpenNotifications()` | 打开 `NotificationCenter`（AvatarMenu 内部 `notifOpen` state，渲染 `<NotificationCenter/>`） | 全员 |
| 钱包 | `onOpenWallet()` | `openAccountSettings('wallet')` | 全员 |
| 切换租户 | `goTo('team')` | `openAccountSettings('team')`（AccountDialog team tab） | 全员 |
| 插件管理 | `goTo('plugins')` | `setView('plugins')` | 全员 |
| 团队管理 | `goTo('team-manage')` | `setView('team-admin')` | `isTeamManager(session.permissions)` |
| 开发者模式 | `goTo('creator')` | `setView('creator')`（→ 创建器悬浮窗） | `isTeamManager(session.permissions)`（v4 同语义） |
| LLM 设置 | `goTo('llm')` | `openAccountSettings('settings', 'gateway')` | 全员 |
| ~~版本发布管理~~ | ~~`goTo('releases')~~ | **删除该项**（桌面端无 releases 视图，属 collab-admin 能力） | — |
| 设置与快捷键 | `goTo('settings')` | `openAccountSettings('settings')` | 全员 |
| 本地权限与安全 | `goTo('settings')` | `openAccountSettings('settings')`（暂合并；若需独立 tab 另立任务） | 全员 |
| 帮助与反馈 | `window.open(docs)` | 改为项目实际文档 URL（查 README/现有 help 入口，无则保留 v4 链接或移除） | 全员 |
| 退出登录 | `resetSession()` | 同 | 全员 |

### 4.4 触发点改造（Sidebar.tsx + App.tsx）

- **Sidebar.tsx**：底部账户按钮（`Sidebar.tsx:223-241`）`onClick` 由 `openAccountSettings('account')` 改为 `onOpenAvatarMenu()`（新 prop）。Sidebar 不再自管 AvatarMenu 挂载——**统一在 `App.tsx` 渲染** `<AvatarMenu/>`（与 AccountDialog/CommandPalette 同层），避免侧栏 `overflow-hidden` 裁切弹出层（v4 用 `fixed bottom-12 left-14` 定位，需基于侧栏宽度/折叠态计算；折叠态 `left` 取折叠宽度≈56px + 间距）。
- AvatarMenu 的 `open`/`onClose` 由 App 持有 state；Sidebar 账户按钮调用 `onOpenAvatarMenu`。
- `openAccountSettings` 等仍由 `useApp()` 暴露，AvatarMenu 通过 `useApp()` 取——与 v4 一致。

### 4.5 项 3 落地（依赖 4 就位后）

- `Sidebar.tsx:38` NAV 移除 `{ v: 'team-admin', ... }`。
- `Sidebar.tsx:174-192` 通知铃铛 button 整块移除；其所在 flex 容器（`Sidebar.tsx:156-193`）只剩搜索按钮，调整为单列满宽。
- `NotificationCenter` 的渲染从 Sidebar 迁到 AvatarMenu 内部（打开时渲染抽屉）。`useUnreadCount` 仍可在 Sidebar 之外（AvatarMenu 内）调用——hook 自管轮询。
- 审核入口（`review`，platformAdminOnly）**保留**在侧栏（用户仅说移团队管理与通知）。

### 4.6 折叠态定位修正

v4 `fixed bottom-12 left-14` 基于固定宽度。当前侧栏折叠宽度 `COLLAPSED_WIDTH=56`（w-14）、展开可拖拽 200–320。AvatarMenu 弹出位置需随折叠态切换：
- 折叠态：`left: 64px`（56 + 8 间距），`bottom: 56px`（账户按钮高度区）。
- 展开态：`left` 取 `var(--sidebar-width)` 或直接用 anchor 定位。
- 简化：用 Radix 无依赖的 `fixed` + 根据 `collapsed` 切 class；或用绝对定位相对侧栏。**推荐**：AvatarMenu 接收 `collapsed` prop 切两套定位 class，避免引入 Popper 依赖。

---

## 项 6 — 插件图标全量 + 放大默认

**现状**：
- `components/plugins/author-actions/shared.tsx` `PluginIcon` 默认 `size-8`；`readPluginIcon(plugin)` 读 `plugin.manifest.icon`。
- `TeamPluginRow.tsx:78` 用 `<PluginIcon icon={readPluginIcon(plugin)} className="size-9 ..." />`。
- `LocalPluginRow.tsx` `LocalPluginSummary`（`:118-131`）无图标。
- `MarketplacePluginsSection.tsx` `MarketplaceRow`（`:114-133`）无图标；`MarketPlugin` 接口（`:24-39`）无 `icon` 字段。

**方案**：
1. **放大默认**：`shared.tsx` `PluginIcon` 默认 class `size-8` → `size-10`（img 与 fallback 两处）。
2. **三处统一 `size-10`**：`TeamPluginRow` 由 `size-9` → `size-10`；新增处同样 `size-10`，`rounded-lg object-cover`。
3. **LocalPluginRow 补图标**：`LocalPluginStatus` 是否含 manifest/icon？查 `lib/plugin-status.ts`——若 `LocalPluginStatus` 有 `manifest` 或 `icon` 字段则用 `readPluginIcon`；否则用首字/默认 🧩。在 `LocalPluginSummary` 内、名称块左侧插入 `<PluginIcon .../>`（与 TeamPluginRow 同构：`<PluginIcon className="size-10 shrink-0 rounded-lg object-cover" />`，icon 传 `readPluginIcon(item as any)` 或 item 的 icon 字段）。
4. **MarketplaceRow 补图标**：`MarketPlugin` 接口加可选 `icon?: string`（后端若返回则用，无则 fallback）；MarketplaceRow 名称块左侧插 `<PluginIcon icon={plugin.icon} className="size-10 ..." />`。**不**改后端——若后端不返回 icon，自然回退默认。

**图标来源真实情况需在实施时确认**：`LoadedPlugin.manifest.icon` 是否在本地插件/市场插件上普遍有值。若几乎都为空，则「图标」实际多为默认 🧩——仍满足「显示图标」诉求，但「团队插件独有图标」可能是因为团队插件 manifest 带 icon、本地/市场不带。此为数据层事实，前端按统一逻辑渲染即可。

---

## 项 7 — 创建器悬浮窗模糊 + 开关状态持久化

**现状**：`App.tsx:562` `<div className={creatorOpen ? 'absolute inset-0 z-30 flex flex-col bg-background shadow-2xl' : 'hidden'}>`；`creatorOpen` `useState(false)`（`:196`，内存态）。

**重要前置事实（已研究确认）**：创建器**草稿/对话内容已具备跨重启持久化**——`lib/conversations.ts:59` `saveDraft(sessionId, draftJson)` 落盘；`PluginCreatorHome.tsx:201-220` 挂载时 `listConversations()` + 按 `activeId`（localStorage）恢复并加载 draft。故「内容保存」已存在，本项**只**做 (1) 背景模糊、(2) 浮窗开关态持久化。

**方案**：
1. **背景模糊**：className 改 `absolute inset-0 z-30 flex flex-col bg-background/70 backdrop-blur-xl shadow-2xl`（半透明 + 毛玻璃）。创建器内部 header/aside 用 `bg-background`/`bg-card`（不透明），内容仍清晰可读；底层页面隐约可见。
   - 内部面板保持不透明，浮窗边缘与面板间显出毛玻璃，主体内容（chat/composer）不透明。视觉为「毛玻璃边框 + 实心面板」，符合「悬浮窗背景模糊」。
2. **开关态持久化**：
   ```ts
   const CREATOR_OPEN_KEY = 'lf:creator-open';
   const [creatorOpen, setCreatorOpenState] = useState<boolean>(() => {
     try { return localStorage.getItem(CREATOR_OPEN_KEY) === '1'; } catch { return false; }
   });
   const setCreatorOpen = useCallback((v: boolean) => {
     setCreatorOpenState(v);
     try { localStorage.setItem(CREATOR_OPEN_KEY, v ? '1' : '0'); } catch {}
   }, []);
   ```
   - 替换现有 `setCreatorOpen(true/false)` 调用（`App.tsx:226,243,568,582` 等）为包装函数。
   - `setView('creator')`（`:225-228`）、FAB onClick（`:582`）、关闭按钮（`:568`）、Esc（`:441`）均走包装函数。
   - **边界**：登出 `resetSession`（`:285-295`）内加 `setCreatorOpen(false)`——登出后渲染 Auth，浮窗残留无意义，且保留 `lf:creator-open=1` 会让下次登录自动弹浮窗（体验差），故登出时关闭并清为 `0`。

---

## 项 9 — 侧栏最近使用插件

### 9.1 数据机制（仿 pins）

`App.tsx` 现 pins 机制：`pinKey(tenantId)` → `lf:pins:{tenantId}`，`loadPins`/`savePins`，`pinPlugin`/`unpinPlugin`，`pinnedPlugins` state，`useEffect` 按 tenantId 重载。

**新增 recent（同构）**：
- key：`lf:recent:{tenantId || 'none'}`。
- 存储：`LoadedPlugin[]`（与 pins 同结构，便于直接运行），限量 5、去重、置顶。
- helpers：`loadRecent(tenantId)`/`saveRecent(tenantId, arr)`。
- state：`recentPlugins`；`useEffect([session.tenantId])` 重载。
- 记录时机：**包装 `setRunningPlugin`**。当前 `setRunningPlugin` 直接 `useState` setter（`:200`）。改为：
  ```ts
  const setRunningPlugin = useCallback((p: LoadedPlugin | null) => {
    runningPluginRef.current = p;
    setRunningPluginState(p);
    if (p) {
      setRecentPlugins((prev) => {
        const next = [p, ...prev.filter((x) => x.id !== p.id)].slice(0, 5);
        saveRecent(session.tenantId, next);
        return next;
      });
    }
  }, [session.tenantId]);
  ```
  - 仅在 `p` 非空时记录；置顶去重；限量 5。
- 通过 `useApp()` 暴露 `recentPlugins` + 一个点击运行回调（或复用现有 `setRunningPlugin` + `setView('plugins')`）。

### 9.2 Sidebar 渲染

- `Sidebar.tsx` nav 区（`:196-220`）上方或下方加「最近使用」分区。结构：
  - 展开态：小标题「最近使用」+ 每项 `Button ghost` 含 `PluginIcon`（`size-5`/`size-6`，小号）+ 名称；空态不渲染整块。
  - 折叠态：仅 `PluginIcon`，`title={name}` tooltip。
- 点击：`setRunningPlugin(p); setView('plugins')`（与 Home 最近胶囊一致，`Home.tsx:43`）。
- 复用 `PluginIcon` + `readPluginIcon`（项 6 之后默认尺寸变大，此处显式传小号 class）。
- `RecentPlugins.tsx`（`creator/panels/`）是 Card 风格列表，**不复用**（侧栏要 Button 行风格）——Sidebar 内联渲染即可，避免抽组件扰动 creator。

### 9.3 与项 6 的耦合

最近使用项也显示图标，项 6 放大默认 `size-10` 后，侧栏需显式传小号 class（如 `size-5`）覆盖默认，避免侧栏图标过大。

---

## 兼容性 / 回滚

- 每项改动独立 commit（见 implement.md 顺序），任一项出问题可单独 revert。
- localStorage 新增 key（`lf:sidebar-open`/`lf:creator-open`/`lf:recent:*`）对旧版无影响（旧版不读不写）；新版读不到 key 走默认值，向后兼容。
- AvatarMenu 为新文件；Sidebar/App 改动若 revert，只需恢复账户按钮 onClick 与 NAV/铃铛即可，AvatarMenu 文件可留可删。
- 删 Footer.tsx 是不可逆文件删除——commit 前确认无其他引用（预期仅 App.tsx）。

## 风险

| 风险 | 缓解 |
|---|---|
| AvatarMenu 定位在折叠/展开态错位 | 接收 `collapsed` prop 切两套 `fixed` left/bottom |
| `useUnreadCount` 在 Sidebar 与 AvatarMenu 都调用导致双轮询 | 项 3 后 Sidebar 不再渲染铃铛，仅 AvatarMenu 调用；保持单实例 |
| 项 1 实测发现是「by design 视口居中」期望差 | PRD 已列 Open Questions，实测后回告用户 |
| 创建器 `bg-background/70 backdrop-blur` 下内部面板边缘毛刺 | 内部面板保持不透明 `bg-background`/`bg-card`，仅 overlay 容器半透 |
| `LocalPluginStatus` 无 icon 字段导致「图标全默认」 | 统一渲染逻辑仍满足需求；数据层事实不动 |
