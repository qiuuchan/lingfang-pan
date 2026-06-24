# 界面交互优化 · 技术设计（design.md）

> 任务目录：`.trellis/tasks/06-24-ui-interaction`
> 范围：桌面端 `apps/desktop`。六项需求 R1~R6，详见 `prd.md`。
> 本文档基于对真实代码的核实，给出技术边界、各需求方案与风险点。

---

## 0. 核实结论（与探查/PRD 的关键修正点）

逐一 Read 真实代码后，确认与需修正的点：

1. **动画库**：`framer-motion@^12.40.0`（见 `apps/desktop/package.json:25`）。`lib/motion.tsx` 用 `motion / AnimatePresence / useReducedMotion / useMotionValue / animate`，全部尊重 `prefers-reduced-motion`。各 duration 核实无误：
   - `FadeIn` 0.4s、`SlideIn` 0.45s、`StaggerContainer.stagger` 0.07s / `delayChildren` 0.05s、`StaggerItem`(ITEM_VARIANTS) 0.4s、`AnimatedNumber` 1.2s、`Shimmer` 1.6s(linear, repeat)、`PageTransition` 0.25s（reduce 时 0.15s）。
   - 散落 inline：`AvatarMenu.tsx:150` 菜单开合 0.15s；`FloatingCreateButton.tsx:14,19` 点击态 `setTimeout 260ms` + `transition-all duration-200`；`FloatingCreator.tsx:493` 用量条 `transition-all duration-300`。

2. **⚠️ 重大修正 —— ui-tokens 不被桌面壳消费**：`packages/ui-tokens/tokens.css` 仅通过 `apps/desktop/src/pages/plugins-runtime.ts:9` 的 `?inline` 注入到**插件 iframe 运行态文档**，**不**被桌面 App 自身样式引用（`apps/desktop/src/index.css:1-4` 只 `@import` tailwindcss / tw-animate-css / shadcn / geist，无 ui-tokens）。
   - **结论**：若按 PRD 字面在 `ui-tokens/tokens.css` 定义动画时长 token，桌面 UI 读不到，等于无效。
   - **正确做法**：桌面端动画时长 token 应定义在 `apps/desktop/src/index.css` 的 `:root`（CSS 变量，供 dialog/popover 等 Tailwind 工具类引用），framer-motion 的 JS duration 则集中到 `lib/motion.tsx` 的一组常量。可同时在 `ui-tokens/tokens.css` 追加同名 token 保持「设计令牌单一来源」的语义，但桌面端的实际生效来源是 index.css + motion.tsx 常量。

3. **dialog/popover 动画是 Tailwind 工具类，非 framer-motion**：`ui/dialog.tsx:35,57`、`ui/popover.tsx:38` 用 `duration-100` + `data-open:animate-in / data-closed:animate-out`（tw-animate-css）。调慢需改这些工具类时长（或令其读 CSS 变量），与 motion.tsx 是两套机制。

4. **插件管理当前是「主区页面」而非悬浮窗**：`Plugins.tsx` 用 `Tabs`（本地/团队/市场），`App.tsx:650` 在 `view in {plugins, author-center, market}` 时把它渲染进主体区；`AvatarMenu.tsx:111` 的「插件管理」走 `go('plugins')` 切 view。`runningPlugin` 存在时 `Plugins.tsx:23` 直接返回 `PluginRunner`，再经 `App.tsx:674` 的 `isPluginCenterView(view) && runningPlugin` 分支全屏铺满。R1（路线 A）要把「插件中心」从主区页面**完全改为悬浮窗**，并把插件运行从 view 体系中解耦。

7. **路线 A 完整影响面（已核实，用户拍板走路线 A）**——`plugins/author-center/market` 三个 view 仅服务插件中心主区页，全仓引用点：
   - 渲染分支：`App.tsx:650`（`<Plugins/>` 主区渲染）、`App.tsx:674`（`isPluginCenterView(view) && runningPlugin` 全屏运行分支）、`App.tsx:27`（import `isPluginCenterView`）、`App.tsx:29`（lazy import Plugins）。
   - view 工具：`lib/plugin-center.ts`（`pluginCenterTabFromView/pluginCenterViewForTab/isPluginCenterView`）+ 其测试 `lib/plugin-center.spec.ts`；`pages/plugins/use-plugin-center.ts` 的 `usePluginCenterTab`（用 view 双向同步 tab，路线 A 下改为纯本地 state）。
   - 入口/导航：`AvatarMenu.tsx:111`（`go('plugins')`）、`Sidebar.tsx:36`（NAV 项 `plugins`）+`:124`（`activeView` 用 `isPluginCenterView`）+`:27`（import）+`:196`（recent 点击 `setView('plugins')`）、`Home.tsx:45`（recent 点击）、`CommandPalette.tsx:86-87`（`go('plugins')/'market'` 动作）+`:104`（installed 运行）+`:115`（market 前往）。
   - 预加载：`lib/view-preload.ts:4,5,8`（`plugins/author-center/market` → import Plugins）。
   - 类型：`lib/types.ts:165` `View` 联合含 `'plugins' | 'author-center' | 'market'`。
   - **关键耦合点①（运行宿主）**：插件运行（`runningPlugin`）当前依赖 `isPluginCenterView(view)` 才全屏渲染（`App.tsx:674`）。删 view 后运行宿主必须改为「仅由 `runningPlugin` 驱动，与 view 无关」（见 §2.6）。
   - **关键耦合点②（PluginRunner 内部用 setView）**：`PluginRunner.tsx:27` 解构 `setView`，传入 `use-plugin-runner-actions` 的「继续修改」会 `setView('creator')`？——经核实 creator 是悬浮窗（`creatorOpen`）非 view，需在实现阶段核对 `use-plugin-runner-actions.ts` 实际跳转方式，确保删 plugins view 后「继续修改」仍能开创建器。

5. **pins/recent 基础设施已完备**（`App.tsx:53-58,91-129,258-271,542-559`）：`pinnedPlugins / recentPlugins`（均 `LoadedPlugin[]`，按 `tenantId` 持久化隔离）、`pinPlugin / unpinPlugin / isPinned`，`recentPlugins` 在 `setRunningPlugin` 时自动置顶去重限量 5。R1 侧边栏「固定常用 + 历史」可直接复用，无需新建存储。

6. **已有可复用的悬浮窗外壳**：`PanelDialog.tsx`（Dialog + 标题栏 + ScrollArea，size lg/md/sm），App 顶层已用它承载 钱包/团队/设置/个人资料/团队管理。R1/R3 的居中悬浮窗应复用此模式而非另造轮子。

---

## 1. 技术边界

- **仅改 `apps/desktop`** 与（R4 token 语义）`packages/ui-tokens/tokens.css`；不动后端 / 契约 / 插件运行时逻辑。
- **不改动插件运行/上传/relay 计费链路**：R2/R3 只动创建器的「外观与文案」，`send()` 流式逻辑、`assembleSystemPrompt`、`creatorTools`、skill 的 `prompt` 注入语义保持不变（R3 只改 skill 的展示 `name/description` 与新增 skill，不破坏 `DEFAULT_ACTIVE_SKILLS` 行为）。
- **可访问性**：所有新增/调慢动画必须保留 `useReducedMotion` 降级；新增悬浮窗复用 base-ui Dialog 的焦点陷阱与 Esc 关闭。
- **持久化隔离**：R1 复用既有 `lf:pins:<tenantId>` / `lf:recent:<tenantId>`，不新增 localStorage key（除非新增「插件中心打开态」，见 R1）。
- **构建约束**：每步以 `pnpm --filter @lingfang/desktop typecheck` + `vite:build` 验证（`tauri build` 需 Rust 工具链，CI 慢，验证以 tsc + vite 为主）。

---

## 2. R1 插件管理悬浮窗重构（最大项 · 路线 A：完全取代主区页）

> **用户已拍板走路线 A**：悬浮窗完全取代 `plugins/author-center/market` 主区渲染，删除 App 相关主区分支，清理仅服务这些主区页的 view 体系。插件运行从 view 解耦。

### 2.1 现状与目标
- 现状：`view in {plugins, author-center, market}` → 主区渲染 `Plugins.tsx`（3 Tab）；`runningPlugin` 存在时经 `App.tsx:674` 全屏渲染 PluginRunner。入口在 `AvatarMenu`/`Sidebar`/`CommandPalette`/`Home`。
- 目标：插件中心改为**居中悬浮窗**（App 顶层 `pluginCenterOpen` 状态，与 walletOpen 等同构）；窗内**左侧固定侧边栏**（固定常用 + 历史）+ **右侧**本地/团队/市场内容（保留 3 Tab）。插件**运行**改为独立的全屏 overlay，仅由 `runningPlugin` 驱动，不再依赖 view。

### 2.2 新组件结构
```
components/plugins/PluginCenterDialog.tsx   ← 新增：悬浮窗容器（自定义 size=lg Dialog，body 不套 PanelDialog 的 ScrollArea）
  └─ pages/plugins/PluginCenterBody.tsx     ← 新增：两栏（左侧栏各自滚动 + 右侧 Tabs 内容）
       ├─ PluginCenterSidebar (新增/内联)   ← 固定常用(pinned) + 历史(recent)，复用 useApp() 的 pins/recent
       └─ <原 Tabs 内容>                     ← 复用 LocalPluginsSection / TeamPluginsSection / MarketplacePluginsSection / *Row
```
- **复用优先**：`LocalPluginsSection / TeamPluginsSection / MarketplacePluginsSection / *Row` 全部保留。`Plugins.tsx` 的数据 hooks（`useTeamPluginList / useLocalPluginList / usePluginOpeners`）原样迁入 `PluginCenterBody`。
- **`Plugins.tsx` 处置**：删除其主区页面外壳（含 `runningPlugin → return <PluginRunner/>` 分支，运行改由全屏 overlay 接管，见 §2.6）。其 import 的 `usePluginCenterTab` 改为纯本地 tab state（不再与 view 同步，见 §2.4）。`Plugins.tsx` 文件本身可删或瘦身为只导出 body（建议直接由 `PluginCenterBody` 取代，删 `Plugins.tsx`）。
- **容器**：因 `PanelDialog` 自带 ScrollArea 包裹 children，不适配两栏各自滚动，R1 **新建** `PluginCenterDialog`（自定义 `Dialog` + `DialogContent` `h-[86vh] w-[94vw] sm:max-w-6xl`，body 自行分栏滚动），不复用 PanelDialog，避免动公共组件波及其余五个悬浮窗。

### 2.3 侧边栏：固定常用 + 历史（复用 pins/recent）
- 数据：`const { pinnedPlugins, recentPlugins, isPinned, pinPlugin, unpinPlugin, setRunningPlugin } = useApp()`。
- 两分区：
  - **固定常用**：`pinnedPlugins`，点击 → 运行（复用 opener）；「取消固定」→ `unpinPlugin(id)`。
  - **历史使用**：`recentPlugins`（限量 5、自动去重置顶），点击运行；「固定」→ `pinPlugin(p)`。
  - 历史中已固定项灰显「已固定」或隐藏，避免重复。
- 空态：无固定 → 「在右侧列表点 📌 固定常用插件」；无历史 → 「运行过的插件会出现在这里」。
- 运行后 `App.tsx` 的 `setRunningPlugin` 包装自动写 recent，无需额外逻辑。

### 2.4 view 体系清理范围（路线 A 核心）
删除 `plugins/author-center/market` 三个 view 及其专用工具，改为悬浮窗开关 + 本地 tab state：

1. **`lib/types.ts:165`**：`View` 联合删除 `'plugins' | 'author-center' | 'market'`，保留 `'home' | 'creator'?(见下) | 'team-admin' | 'review'` 等。注意 `'team' | 'settings' | 'wallet'` 已是悬浮窗路由（`setView` 内拦截转 openAccountSettings，`App.tsx:302-323`），`'creator'` 实际未作为 view 渲染（创建器是 `creatorOpen`）——清理时一并核对这些「名存实亡」的 view 值是否可一并精简（谨慎，避免破坏 `setView` 的兼容拦截）。
2. **`lib/plugin-center.ts`**：`pluginCenterTabFromView/pluginCenterViewForTab/isPluginCenterView` 全部删除；连带删 `lib/plugin-center.spec.ts`。`PluginCenterTab` 类型（'local'|'team'|'market'）保留并移到 body 或 use-plugin-center 内部（tab 仍需要，只是不再映射 view）。
3. **`pages/plugins/use-plugin-center.ts:17-30` `usePluginCenterTab`**：去掉 view 参数与 `setView` 同步，改为 `useState<PluginCenterTab>('local')` 的纯本地 tab（悬浮窗内 Tab 切换不再改 URL/view）。
4. **`App.tsx`**：删 `:650` 的 `else if (view === 'plugins' || 'author-center' || 'market') body = <Plugins/>`；删 `:674` 的 `isPluginCenterView(view) && runningPlugin` 分支，运行 overlay 改为独立判断（§2.6）；删 `:27` import、`:29` lazy Plugins（若 Plugins 删除则改为 lazy PluginCenterBody/Dialog）。新增 `pluginCenterOpen` state + `openPluginCenter` context 方法 + 顶层 `<PluginCenterDialog>` 挂载。
5. **`lib/view-preload.ts:4,5,8`**：删 `plugins/author-center/market` 三个 loader 键（或改指向新 PluginCenterDialog 的懒加载入口）。
6. **`Sidebar.tsx`**：`:27` 删 import；`:36` NAV 的 `plugins` 项 `onClick` 改为 `openPluginCenter()`（仍保留侧栏「插件」按钮，只是不再切 view）；`:124` `activeView` 去掉 `isPluginCenterView` 分支（插件按钮 active 态改为「`pluginCenterOpen`」或恒非高亮）；`:196` recent 点击从 `setView('plugins')` 改为仅 `setRunningPlugin(p)`（运行 overlay 接管，见 §2.6）。
7. **`Home.tsx:45`**、**`CommandPalette.tsx:86-87,104,115`**：所有 `setView('plugins'|'market')` / `go('plugins'|'market')` 改为 `openPluginCenter()`（可带初始 tab 参数：`openPluginCenter('market')`）；运行类（`:104`）改为 `setRunningPlugin(p)`。
8. **`AvatarMenu.tsx:111`**：「插件管理」`onClick` 从 `go('plugins')` 改为 `openPluginCenter()`。

> `openPluginCenter(tab?: 'local'|'team'|'market')` 建议带可选初始 tab，承接原 `market` 直达语义（CommandPalette「前往市场」、Plugins 空态「去市场安装」）。

### 2.5 App 顶层状态与 context
- 新增 `const [pluginCenterOpen, setPluginCenterOpen] = useState(false)` + `const [pluginCenterTab, setPluginCenterTab] = useState<PluginCenterTab>('local')`。
- `openPluginCenter = useCallback((tab?) => { if (tab) setPluginCenterTab(tab); setPluginCenterOpen(true); }, [])`，挂到 `AppContextValue`（仿 `openTeamAdmin/openNotifications`）。
- 顶层挂载 `<PluginCenterDialog open={pluginCenterOpen} onOpenChange={setPluginCenterOpen} tab={pluginCenterTab} onTabChange={setPluginCenterTab} />`（lazy + Suspense，仿设置/钱包）。
- 打开插件中心时不强制关运行 overlay；点插件运行后关插件中心、显示运行 overlay。

### 2.6 插件运行宿主解耦（关键设计）
路线 A 删了 `plugins` view，原 `App.tsx:674` 的 `isPluginCenterView(view) && runningPlugin` 全屏分支失效。改为**独立的全屏运行 overlay**，仅由 `runningPlugin` 驱动：
- 在 `App.tsx` 主体区新增：`runningPlugin ? <全屏 PluginRunner overlay> : <正常 view body>`。即把「是否全屏跑插件」的判定从 `view` 改为 `!!runningPlugin`，与任何 view 无关。
- `PluginRunner` 的 `onBack`（返回插件列表）从「`setRunningPlugin(null)` 回到 plugins view」改为「`setRunningPlugin(null)` + `openPluginCenter()`」（返回即重开插件中心悬浮窗），保持「返回插件列表」语义。
- **核对 `PluginRunner.tsx:27` 的 `setView`**：实现阶段须读 `use-plugin-runner-actions.ts` 确认「继续修改」的跳转目标。若它走 `setView('creator')` 而 creator 实为悬浮窗，需改为开 `creatorOpen`（设 `currentDraft` + `setCreatorOpen(true)`）。这是路线 A 必须连带修的隐藏耦合。
- 运行仍是**全屏**（非悬浮窗内 iframe），规避 Dialog 内跑 iframe 的尺寸/层级/pointer-events 风险。

### 2.7 入口改造汇总
见 §2.4 第 6~8 点：`Sidebar`/`Home`/`CommandPalette`/`AvatarMenu` 所有进插件中心的入口统一改为 `openPluginCenter()`；所有「运行某插件」入口统一改为 `setRunningPlugin(p)`（不再附带 `setView`）。

---

## 3. R3 内置 Skill 居中悬浮窗 + 话术改写

### 3.1 UI 方案
- 现状：`FloatingCreator.tsx:374-395` 的小 `Popover`（`w-72`，列 SKILLS 复选）。
- 改为**居中悬浮窗 + 背景模糊**：用 `Dialog`（`ui/dialog.tsx` 自带 overlay `supports-backdrop-filter:backdrop-blur-xs`；如需更强模糊在 DialogContent/overlay 叠加 `backdrop-blur-md`）。触发按钮（WrenchIcon「Skill」）保留，`onClick` 改为开 Dialog（新增本地 `skillDialogOpen` 状态）。
- 窗内：标题 + 一句通俗说明 + 卡片化的 skill 列表（每项 Checkbox + 名称 + 通俗描述），底部「完成」关闭。比小 Popover 更宽松、可读性更好，便于「扩量」后滚动。
- 复用 `Checkbox` + 现有 `toggleSkill` / `activeSkillIds`，逻辑零改动。

### 3.2 话术改写原则
- **去内部术语**：删除「拼入系统提示词」（`FloatingCreator.tsx:382`）、「systemPrompt」「token」「片段」等开发者措辞。改为面向用户的「能力开关」语言。
  - 例：标题「Skill（拼入系统提示词）」→「创建偏好 / 能力」；副标题改为「按需开启，让 AI 生成更符合预期的插件」。
- **skill 描述改写**（改 `lib/skills.ts` 的 `name/description`，**不动 `prompt`**）：
  - `output-minimize`「只产必要文件，禁止样板与占位，降低 token 占用」→「只生成必要文件，不产生多余说明/占位文件」。
  - `plugin-refactor`「改已有插件时先读后改、最小 diff…」→「修改已有插件时只动需要改的部分，不重写其余文件」。
  - `relay-access`「插件需调 AI 时用平台 relay…」→「插件需要 AI 能力时，自动接入平台统一的 AI 服务」。
- 原则：描述只讲「对用户/插件结果的影响」，不讲实现机制；保持简体中文、≤ 一句话。

### 3.3 扩量
- 在 `SKILLS` 注册表追加新 skill（如「界面美化」「输入校验/健壮性」「中文优先」等），每个含 `id/name/description/prompt`，`defaultActive` 谨慎设置（默认激活集合 `DEFAULT_ACTIVE_SKILLS` 由 `defaultActive` 派生，新增默认激活会改变创建器开箱行为，需评估）。
- 新增 skill 不需改创建器主流程（`assembleSystemPrompt` 按注册顺序自动拼装、UI 自动列出）。

---

## 4. R4 全局动画 token 化与调慢

### 4.1 策略（结合 §0.2/§0.3 修正）
分三类来源统一调慢，**不要只改 ui-tokens**：

1. **CSS 变量（桌面壳实际生效来源）**：在 `apps/desktop/src/index.css` 的 `:root` 定义时长 token，例如：
   ```css
   :root {
     --lf-dur-fast: 200ms;
     --lf-dur-base: 320ms;   /* 由原 ~150/100 调慢 */
     --lf-dur-slow: 480ms;
   }
   ```
   供 dialog/popover 等 Tailwind 工具类引用（见下）。可同步在 `packages/ui-tokens/tokens.css` 追加同名变量以维持「设计令牌单一来源」的文档语义，但桌面端必须以 index.css 为准。

2. **Tailwind 工具类动画（dialog/popover/sheet/select）**：当前 `duration-100`（`ui/dialog.tsx:35,57`、`ui/popover.tsx:38`，sheet/select 同类）。两种改法：
   - 直接把 `duration-100` 调成更慢的 `duration-300`/`duration-500`；或
   - 改为任意值 `duration-[var(--lf-dur-base)]` 引用 §4.1.1 的 CSS 变量（更统一，推荐）。

3. **framer-motion JS duration（motion.tsx + inline）**：framer 的 `transition.duration` 是数字，读 CSS 变量不便，故在 `lib/motion.tsx` 顶部集中定义常量并全量引用：
   ```ts
   export const MOTION = { fadeIn: 0.6, slideIn: 0.65, stagger: 0.1, item: 0.55, page: 0.4, menu: 0.25 } as const;
   ```
   把 `FadeIn/SlideIn/StaggerItem/PageTransition` 默认 duration 改为引用常量并整体上调（约 ×1.4~1.5）。`AvatarMenu.tsx:150`(0.15→0.25)、`FloatingCreateButton.tsx`(200ms/260ms 适度上调)、`FloatingCreator.tsx:493`(用量条 300ms 可保留或微调) 同步引用/上调。
   - `AnimatedNumber`(1.2s)、`Shimmer`(1.6s 循环) 属「持续/循环」类，非入场，建议**不调**或轻调，避免数字滚动拖沓、骨架闪光变慢显卡顿。

### 4.2 调慢幅度建议
- 入场类（FadeIn/SlideIn/Page/菜单）整体 ×1.4~1.5，保证「整体变慢且观感一致」而非各处幅度不一。
- 保持 `ease: 'easeOut'` 不变；`prefers-reduced-motion` 降级路径不受影响。

---

## 5. R2 / R5 / R6 具体改法

### R2 FAB 点击弹窗动画
- 现状：`FloatingCreateButton.tsx` 已有点击 ring 缩放（保留）；但 `FloatingCreator` 在 `App.tsx:698 {creatorOpen && <FloatingCreator/>}` 挂载时**无入场动画**（直接出现）。
- 改法：在 `FloatingCreator` 最外层 overlay + 居中面板加入场动画。两种实现：
  - **A（推荐，轻量）**：给 overlay 加 `animate-in fade-in`（tw-animate-css），给面板加 `animate-in zoom-in-95 fade-in`（可叠 `slide-in-from-bottom-2` 模拟从 FAB 升起），时长引用 §4 token。无需引入 AnimatePresence。
  - **B（含退场）**：用 framer-motion `AnimatePresence` 包裹，需把卸载控制从 `{creatorOpen && ...}` 改为受控存在 + exit 动画（改动稍大）。MVP 用 A，仅入场动画即可满足「平滑」。
- 注意：面板 `transform-origin` 设为右下（靠近 FAB）会更自然，但非必须。

### R5 缩小个人资料页底部高度
- 现状：`App.tsx:720` `<PanelDialog ... size="sm">`，`PanelDialog.tsx:39` sm = `h-[60vh] max-h-[60vh]` **固定高**。ProfilePanel 内容短，固定 60vh 导致底部大片留白。
- 改法（二选一）：
  - **改 PanelDialog 的 sm 档**：把 `h-[60vh] max-h-[60vh]` 改为**不设固定 `h`、仅 `max-h-[70vh]`**（高度随内容自适应，内容少则窗矮，底部留白消失）。需确认 sm 档仅 ProfilePanel 在用（`App.tsx` 中 size="sm" 仅 profile），影响面可控。
  - 或新增 `size="auto"` 档专供个人资料，避免动到既有 sm 语义。
- 同时可压 `ProfilePanel`/`PanelDialog` 的内边距（`p-5`）与表单 gap，进一步降高。

### R6 主题未选中按钮加边框
- 现状：`AvatarMenu.tsx:184-196` 主题按钮：选中 `bg-primary text-primary-foreground`，未选中 `text-muted-foreground hover:bg-muted`（**无边框**，三个按钮在卡片上区分度低）。
- 改法：未选中态加 `border border-border`（选中态可加 `border border-transparent` 保持尺寸一致避免跳动）。即：
  ```
  active ? 'bg-primary text-primary-foreground border border-transparent'
         : 'text-muted-foreground hover:bg-muted border border-border'
  ```

---

## 6. 风险点

1. **R1 运行宿主解耦（路线 A 最高风险）**：删 `plugins` view 后，原 `App.tsx:674` 靠 `isPluginCenterView(view)` 判定的全屏运行分支失效，必须正确改为「`!!runningPlugin` 驱动的独立全屏 overlay」。若漏改，运行插件会无处渲染（白屏）或落到错误布局（被 `px-6 py-6 max-w-6xl` 包裹而非铺满）。这是路线 A 必须一次到位的核心改动。
2. **R1 PluginRunner 的 setView 隐藏耦合**：`PluginRunner.tsx:27` 解构 `setView`，「继续修改」经 `use-plugin-runner-actions.ts` 跳转。删 view 后须确认其跳转目标（疑似 creator 悬浮窗），改为开 `creatorOpen`/`setCurrentDraft`，否则「继续修改」按钮失效或跳到已删 view。实现阶段必读 `use-plugin-runner-actions.ts` 核对。
3. **R1 入口遗漏导致死链**：进插件中心/运行插件的入口分散在 `Sidebar/Home/CommandPalette/AvatarMenu` 共 8 处（见 §2.4）。任一处仍调 `setView('plugins'|'market')` 而该 view 已删，会 TypeScript 报错（联合类型不含）或运行时 body=null（空白主区）。须靠 `typecheck` 全量兜住——删 View 联合成员后，所有残留引用会编译失败，这是路线 A 的安全网，务必先改类型再逐个修编译错误。
4. **R1 容器**：新建 `PluginCenterDialog`（不复用 PanelDialog，避免其 ScrollArea 不适配两栏 + 避免动公共组件波及其余五窗）。
5. **R4 ui-tokens 误区**：若误在 ui-tokens 定义 token 而桌面壳不引用，会「看似 token 化实则未生效」。务必落到 index.css + motion.tsx 常量（见 §0.2）。
6. **R3 扩量改默认激活**：新增 skill 若设 `defaultActive: true` 会改变创建器开箱拼装的系统提示词，可能影响生成质量与 token 用量；新增 skill 默认建议 `false`。
7. **R3 模糊与 Esc 冲突**：`FloatingCreator` 自身的 Esc 关窗逻辑（`:201-211`）会检测内层 `[role=dialog][data-state=open]` 优先关闭——新 Skill Dialog 是 base-ui Dialog，应被该检测命中，Esc 先关 Skill 窗而非创建器，符合预期；需实测确认 data 属性匹配。
8. **R5/PanelDialog 协调**：R5 动 PanelDialog（个人资料档高度），建议新增 `size="auto"` 而非改 sm 档，避免影响钱包/团队/设置/团队管理。R1 不动 PanelDialog（用新容器），二者解耦。
9. **reduced-motion**：R2/R4 新增动画必须保留降级；tw-animate-css 的 animate-in 默认不随 prefers-reduced-motion 关闭，必要时加 `motion-reduce:animate-none`。
10. **`view-preload` / `preloadView`**：删 view 后 `Sidebar.tsx:166-167` 的 `onFocus/onMouseEnter preloadView(v)` 对插件按钮无意义（v 不再是 plugins）；改为 hover 预载 PluginCenterDialog 懒 chunk 或直接去掉该按钮的预载。
