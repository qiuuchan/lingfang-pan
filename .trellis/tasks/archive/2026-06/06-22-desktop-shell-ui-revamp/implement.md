# Implement — desktop 外壳与插件体验 9 项调整

> 配套 `prd.md`（需求/AC）与 `design.md`（技术决策）。执行顺序按「低风险布局 → 导航/菜单 → 插件体验」，每步独立可验、独立可 revert。

## 前置（一次）

- [ ] 确认基线干净：`git status` 无未提交改动。
- [ ] 跑一遍基线构建确保起点绿（可选，节省后期比对）：`pnpm --filter @lingfang/desktop build`。
- [ ] 读 `apps/desktop` 的 `.trellis/spec/desktop/frontend/` 索引（App shell、状态相关 spec）对齐既有约定（由 trellis-before-dev 自动注入，跳过手读）。

## 阶段 A — 布局微调（项 1/2/5/8）

> 独立、低风险。可合并为一个 commit「shell layout: collapse default / drop footer / drop brand text / center search」。

### A1. 项 8 — 删侧栏顶部品牌区（含 logo）
- [ ] `apps/desktop/src/components/Sidebar.tsx:138-153`：删除整个 header `<div>`（logo + platformName span + `<br/>` + 副标题 span）。搜索栏（原 `:155-193`）成为侧栏最顶部。
- [ ] 清理 Sidebar 内不再使用的 import / 解构：若 `platformName`、`platformLogoUrl`、`HomeIcon` 仅 header 用，从 `useApp()` 解构与 import 中移除（避免未用变量 lint）。
- [ ] 验证：展开/折叠态侧栏顶部直接是搜索栏；无报错。

### A2. 项 5 — 删页脚
- [ ] `apps/desktop/src/App.tsx`：删 `import { Footer } from '@/components/Footer';`（`:8`）与 `<Footer />`（`:556`）。
- [ ] 全仓搜 Footer 引用：`grep -rn "components/Footer\|from '@/components/Footer'" apps/desktop/src`。确认仅 App.tsx 后删 `apps/desktop/src/components/Footer.tsx`。

### A3. 项 2 — 侧栏默认折叠 + 持久化
- [ ] `App.tsx:192`：`useState(true)` → 改为加载函数：
  ```ts
  const SIDEBAR_OPEN_KEY = 'lf:sidebar-open';
  function loadSidebarOpen(): boolean {
    try { const raw = localStorage.getItem(SIDEBAR_OPEN_KEY); return raw === null ? false : raw === '1'; }
    catch { return false; }
  }
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(loadSidebarOpen);
  ```
- [ ] 加 `useEffect(() => { try { localStorage.setItem(SIDEBAR_OPEN_KEY, sidebarOpen ? '1' : '0'); } catch {} }, [sidebarOpen]);` 持久化。
- [ ] 验证：首启折叠；切换后重启保留。

### A4. 项 1 — 搜索框居中（实测驱动）
- [ ] `pnpm tauri dev` 启动，登录到首页。
- [ ] 不同窗口宽度（窄/中/宽）+ 侧栏开/合，截图观察搜索框水平位置。
- [ ] 判定根因：
  - 若主体内已水平居中、用户期望视口居中 → PRD Open Questions 标注「by design」，**不改**，回告用户。
  - 若真偏移 → 修：`pages/Home.tsx` 根容器确保 `w-full`，搜索按钮 `mx-auto w-full max-w-xl`，不依赖父 flex；或修正 flex 层级使 `items-center` 生效。
- [ ] 记录结论到本文件 Notes。

**阶段 A 验证**：`pnpm --filter @lingfang/desktop build` 通过；手测项 2/5/8 的 AC；项 1 给出结论。

**阶段 A commit**：`feat(desktop): shell layout — collapse default, drop footer, drop brand text, center search`

---

## 阶段 B — 用户菜单与导航重构（项 4 → 项 3）

> 项 4 先行（建 AvatarMenu），项 3 随后（拆侧栏入口搬进去）。

### B1. 项 4 — 移植 AvatarMenu
- [ ] `git show origin/lingfang-v4:apps/desktop/src/components/AvatarMenu.tsx > /tmp/AvatarMenu.v4.tsx`（参考用，不直接落盘）。
- [ ] 新建 `apps/desktop/src/components/AvatarMenu.tsx`，基于 v4 改写：
  - props：`{ open: boolean; onClose: () => void; collapsed: boolean }`。
  - 内部：`notifOpen` state + 渲染 `<NotificationCenter open={notifOpen} onOpenChange={setNotifOpen}/>`；`useUnreadCount(true)` 取红点。
  - 账号头：去掉 tokenBalance 请求与展示（仅 displayName / tenantName / role）。
  - 菜单项按 design §4.3 映射表实现；删除「版本发布管理」。
  - 权限：`isTeamManager(session.permissions)` 控「团队管理」「开发者」可见；`session.isPlatformAdmin` 备用（桌面端审核入口仍在侧栏，菜单不重复放）。
  - 定位：`fixed` + 根据 `collapsed` 切 `left`（折叠 `left-14`、展开 `left-[var(--sidebar-width)]` 或传具体值）；`bottom-14`。
  - 主题：`useTheme()` from `next-themes`（保持）。
  - Esc 关闭、点外关闭（沿用 v4 两个 effect）。
- [ ] `App.tsx`：
  - 加 `avatarMenuOpen` state。
  - 顶层（与 AccountDialog 同层）渲染 `<AvatarMenu open={avatarMenuOpen} onClose={() => setAvatarMenuOpen(false)} collapsed={!sidebarOpen} />`。
  - Sidebar 新增 prop `onOpenAvatarMenu={() => setAvatarMenuOpen(true)}`。
- [ ] `Sidebar.tsx`：
  - props 加 `onOpenAvatarMenu: () => void`。
  - 账户按钮 `onClick`（`:226`）由 `openAccountSettings('account')` 改为 `onOpenAvatarMenu()`。
  - 暂时**保留** NAV `team-admin` 与铃铛（项 3 再拆，便于先单独验证 AvatarMenu）。
- [ ] 验证项 4 的 AC：点用户按钮弹菜单；各菜单项跳转正确；权限可见性；主题切换。

**commit**：`feat(desktop): port AvatarMenu from lingfang-v4 (adapted to current RBAC/View)`

### B2. 项 3 — 拆侧栏入口搬入菜单
- [ ] `Sidebar.tsx:34-40` NAV：删除 `{ v: 'team-admin', label: '团队管理', icon: UsersRoundIcon, teamAdminOnly: true }`。
  - 保留 `review`（platformAdminOnly）不动。
  - 若 `UsersRoundIcon` 不再被引用，删 import。
- [ ] `Sidebar.tsx:155-193`：删除通知铃铛 `<button>`（`:175-192`）；其外层 flex 容器调整——只剩搜索按钮，改为单按钮满宽（`flex-1`），去掉 `flex`/`gap` 多列布局。
  - `NotificationCenter` 的渲染（`:256`）从 Sidebar 移除（已在 AvatarMenu 内渲染）。
  - `BellIcon`、`useUnreadCount`、`NotificationCenter` import 从 Sidebar 删除（若不再用）。
- [ ] 验证项 3 的 AC：侧栏无团队管理导航、无铃铛；二者在 AvatarMenu 内可用。

**commit**：`refactor(desktop): move team-admin and notifications from sidebar into AvatarMenu`

---

## 阶段 C — 插件体验（项 6/7/9）

### C1. 项 6 — 插件图标全量 + 放大默认
- [ ] `components/plugins/author-actions/shared.tsx`：`PluginIcon` 默认 class `size-8` → `size-10`（img 与 fallback 两处，`:18,21`）。
- [ ] `pages/plugins/TeamPluginRow.tsx:78`：`size-9` → `size-10`（与默认一致；或显式 `size-10` 覆盖）。
- [ ] `pages/plugins/LocalPluginRow.tsx`：
  - 确认 `LocalPluginStatus` 是否有 icon/manifest 字段（查 `lib/plugin-status.ts`）。
  - `LocalPluginSummary`（`:118-131`）名称块前插入 `<PluginIcon icon={readPluginIcon(item as unknown as LoadedPlugin) /* 或 item.icon */} className="size-10 shrink-0 rounded-lg object-cover" />`。
  - import `PluginIcon`、`readPluginIcon` from `@/components/plugins/author-actions`。
- [ ] `pages/plugins/MarketplacePluginsSection.tsx`：
  - `MarketPlugin` 接口（`:24-39`）加 `icon?: string`。
  - `MarketplaceRow`（`:114-133`）名称块前插 `<PluginIcon icon={plugin.icon} className="size-10 shrink-0 rounded-lg object-cover" />`；import `PluginIcon`。
- [ ] 验证项 6 的 AC：三类 row 都有图标；尺寸一致变大；无图标回退正常。

**commit**：`feat(desktop): show plugin icons across all plugin rows, enlarge default`

### C2. 项 7 — 创建器模糊 + 开关态持久化
- [ ] 前置确认：草稿/对话内容跨重启持久化**已存在**（`lib/conversations.ts:59 saveDraft` 落盘 + `PluginCreatorHome.tsx:201-220` 挂载按 activeId 恢复）。本步**不动**内容持久化，只做开关态 + 模糊。
- [ ] `App.tsx`：
  - `creatorOpen` 改为带持久化的加载/包装（见 design §7）：`useState(loadCreatorOpen)` + 包装 setter `setCreatorOpen` 写 localStorage（key `lf:creator-open`）。
  - 替换所有 `setCreatorOpen(...)` 调用为包装版（`:226,243,568,582` 等；Esc handler `:441`）。
  - `resetSession`（`:285-295`）内加 `setCreatorOpen(false)`（登出关浮窗 + 清 key，避免下次登录自动弹）。
  - 创建器 overlay className（`:562`）：`bg-background` → `bg-background/70 backdrop-blur-xl`。
- [ ] 验证项 7 的 AC：浮窗半透模糊可见底层；开关状态跨重启保留；登出后关闭；草稿内容跨重启不丢（回归）。

**commit**：`feat(desktop): creator overlay backdrop-blur + persist open state`

### C3. 项 9 — 侧栏最近使用插件
- [ ] `App.tsx`：加 recent 机制（仿 pins，见 design §9.1）：
  - `recentKey(tenantId)` → `lf:recent:{tenantId || 'none'}`；`loadRecent`/`saveRecent`。
  - `recentPlugins` state；`useEffect([session.tenantId])` 重载。
  - 包装 `setRunningPlugin`：记录 p（去重置顶限量 5、写盘）。
  - `ctx` 暴露 `recentPlugins`（`AppContextValue` 加字段 + interface 注释）。
- [ ] `Sidebar.tsx`：
  - 从 `useApp()` 取 `recentPlugins`。
  - nav 区上方加「最近使用」分区：展开态小标题 + `Button ghost` 行（`PluginIcon size-5` + 名称）；折叠态仅 `PluginIcon size-5` + `title`。
  - 空列表不渲染整块。
  - 点击：`setRunningPlugin(p); setView('plugins')`。
- [ ] 验证项 9 的 AC：运行后出现、置顶去重、跨重启保留、折叠态图标+tooltip。

**commit**：`feat(desktop): track and show recently used plugins in sidebar`

---

## 收尾验证

- [ ] `pnpm --filter @lingfang/desktop build` 通过。
- [ ] `pnpm --filter @lingfang/desktop lint`（若有）无新增错误；typecheck 通过。
- [ ] 逐项过 AC（prd.md 清单）。
- [ ] 手测 RBAC：非团队管理员账号下「团队管理」「开发者」入口不可见；非平台管理员「审核」入口不可见。
- [ ] 截图前后对比（可选，便于 review）。

## Validation Commands

```bash
pnpm --filter @lingfang/desktop build
pnpm --filter @lingfang/desktop lint         # 若 package.json 有 script
pnpm --filter @lingfang/desktop typecheck    # 若有
```

运行 app 手测：
```bash
pnpm --filter @lingfang/desktop tauri dev    # 或项目既定启动方式
```

## Rollback Points

- 每个阶段/项一个 commit → 可 `git revert <sha>` 单项回滚。
- 不可逆点：删 `Footer.tsx`（commit 前 grep 确认无引用）；AvatarMenu 若整体 revert 删文件即可。
- localStorage 新 key 无需清理（旧版忽略）。

## Notes（实施时回填）

- 项 1 实测结论：（待填）
- `LocalPluginStatus` icon 字段情况：（待填）
- Marketplace API 是否返回 icon：（待填）
