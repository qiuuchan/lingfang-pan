# 协作平台前台（desktop）外壳与插件体验 9 项调整

## Goal

对 `apps/desktop`（即「协作平台前台」桌面客户端）的外壳布局、导航交互与插件体验做 9 项定向调整，使其更接近 `origin/lingfang-v4` 的交互形态，并修复若干遗留细节。所有改动仅限 `apps/desktop`，不涉及 `collab-admin` / `collab-api` / `packages/*`。

## Scope & Target

- **目标应用**：`apps/desktop`（侧栏 header 现有「协作平台前台」副标题即此处）。
- **不在范围**：collab-admin 后台、collab-api 后端、契约/plugin-sdk 包。若某项需要后端新端点，记为「依赖外部」并在 design 中标红，不在本任务实现。

## Background（研究结论，已读源码确认）

- `origin/lingfang-v4` 分支存在 `apps/desktop/src/components/AvatarMenu.tsx`（左下角头像弹出的富菜单：账号头、通知/钱包/切租户/插件管理/租户管理/开发者/LLM/版本发布、主题选择、设置/安全/帮助、退出）。当前 `main` **没有**此文件——侧栏左下账户按钮当前直接 `openAccountSettings('account')` 打开 AccountDialog。
- `apps/desktop/package.json` 已依赖 `next-themes@^0.4.6`，v4 AvatarMenu 的 `useTheme` 可直接移植，无需改主题体系。
- 当前 `View` 类型：`'home'|'creator'|'team'|'team-admin'|'plugins'|'author-center'|'settings'|'market'|'wallet'|'review'`。v4 AvatarMenu 引用的 `team-manage`/`llm`/`releases` **不是**现存的顶层 View——需适配映射（见 design）。
- `Sidebar.tsx` 当前顶部 header 显示 logo + `platformName`（默认 'LingFang'/灵坊）+ 「协作平台前台」副标题；搜索按钮与通知铃铛并排在第二行；`team-admin` 作为导航项；底部为账户按钮。
- `App.tsx`：`sidebarOpen` 默认 `true`（→ `collapsed={!sidebarOpen}`，故默认展开）；`creatorOpen` 为内存态、未持久化；创建器 overlay 用 `bg-background`（不透明）；主体末尾渲染 `<Footer/>`。
- 插件图标：仅 `TeamPluginRow` 渲染 `PluginIcon`（`size-9`）；`LocalPluginRow`、`MarketplaceRow` **不渲染**图标；`PluginIcon` 默认尺寸 `size-8`（偏小）。`readPluginIcon` 从 `plugin.manifest.icon` 读取。
- 最近使用：当前无真正「最近使用」追踪机制；`Home.tsx` 用 `pinnedPlugins.slice(0,6)` 冒充 recent。pinned 有完整持久化（`lf:pins:{tenantId}`），recent 需新建同类机制。

## Requirements（9 项）

1. **搜索框居中**：首页（`Home.tsx`）大搜索框视觉上水平居中于主体内容区。代码看似已居中（flex `items-center` + `max-w-xl`），但用户反馈「还是没有居中」——需运行 app 实测定位真实原因（疑为侧栏占位导致主体中心右移、或 `h-full`+overflow 交互使 `items-center` 失效），修复至视觉居中。
2. **侧边栏默认折叠**：`App.tsx` 中 `sidebarOpen` 初始值改为折叠（`false`），并持久化到 localStorage（key 形如 `lf:sidebar-open`），跨重启保留用户最后偏好。
3. **团队管理 + 通知并入用户按钮**：从侧栏移除 `team-admin` 导航项与通知铃铛按钮；二者作为入口收进左下角用户按钮弹出的菜单（见项 4）。侧栏其余导航（首页/插件/审核）保持不变。
4. **用户按钮 = lingfang-v4 AvatarMenu 形态**：左下角用户按钮点击后弹出 `AvatarMenu`（从 v4 分支移植并适配当前架构），而非直接打开 AccountDialog。菜单含：账号头（头像首字/显示名/租户/角色）、通知中心（红点）、钱包、切换租户、插件管理、团队管理（team-admin，权限可见）、开发者模式（创建器）、LLM 设置（→ 设置→gateway）、设置与快捷键、本地权限与安全、帮助与反馈、外观主题切换、退出登录。**移除** v4 中桌面端不存在的「版本发布管理」入口。
5. **删除应用底部页脚**：移除 `App.tsx` 主体区末尾的 `<Footer/>` 渲染与 import；删除 `apps/desktop/src/components/Footer.tsx`（确认无其他引用后）。
6. **插件图标全量显示 + 放大默认尺寸**：`LocalPluginRow`、`MarketplaceRow` 补上 `PluginIcon`（与 `TeamPluginRow` 一致的位置/视觉）；`PluginIcon` 默认尺寸由 `size-8` 放大（建议 `size-10`，三处 row 统一）。Marketplace 插件图标来源若 API 未返回，回退默认 `🧩`/首字。
7. **创建插件悬浮窗：背景模糊 + 开关状态持久化**：创建器 overlay 由不透明 `bg-background` 改为半透明 + `backdrop-blur`（透过浮窗能看到底层页面且带毛玻璃效果）；`creatorOpen`（浮窗开关态）持久化到 localStorage，跨重启保留「上次是否打开」。（注：创建器内的**草稿/对话内容已具备**跨重启持久化——`saveDraft()` 落盘 + 挂载时按 `activeId` 恢复，见 `PluginCreatorHome.tsx:201-220`；本项**不**重建该能力，亦**不**新增「保存」按钮。）
8. **删除侧栏顶部「灵坊」**：移除 `Sidebar.tsx` header 中的 `platformName` 文本与「协作平台前台」副标题文本；保留 logo 图标（折叠/展开态皆显示）。
9. **侧栏显示最近使用的插件**：侧栏新增「最近使用」分区，列出最近运行过的插件（点击即运行）。新建最近使用追踪：在 `setRunningPlugin(p)` 时记录（去重、置顶、限量持久化 `lf:recent:{tenantId}`），与 pins 机制并行。展开态显示图标+名称，折叠态显示图标（hover tooltip）。

## Acceptance Criteria

通用：

- [ ] 所有改动仅落在 `apps/desktop`；`pnpm --filter @lingfang/desktop build` 通过；`pnpm --filter @lingfang/desktop lint`、typecheck 无新增错误。
- [ ] 不破坏现有 RBAC 门控（`isTeamManager` / `isPlatformAdmin`）——非团队管理员看不到团队管理入口，非平台管理员看不到审核入口。

逐项：

- [ ] 1. 运行 app，首页搜索框在主体区水平视觉居中（不同窗口宽度/侧栏开合下均居中于主体）。
- [ ] 2. 首次启动侧栏默认折叠；手动展开后重启 app，侧栏保持展开；反之亦然（持久化生效）。
- [ ] 3. 侧栏不再出现「团队管理」导航项与通知铃铛；两者仅作为用户菜单内的入口可见。
- [ ] 4. 点击左下用户按钮弹出 AvatarMenu（与 v4 形态一致）；菜单内各项跳转目标正确（通知→通知中心、钱包→AccountDialog wallet、插件管理→plugins、团队管理→team-admin、开发者→创建器悬浮窗、LLM 设置→设置 gateway tab、设置→AccountDialog settings、退出→resetSession）；权限可见性正确；主题切换生效。
- [ ] 5. 主体区底部不再有页脚；`Footer.tsx` 已删除且无残留引用。
- [ ] 6. 插件中心的三类 row（本地/团队/市场）均显示图标；默认图标尺寸明显增大且三处一致；无图标时优雅回退。
- [ ] 7. 创建器浮窗背景半透明 + 模糊，可见底层；浮窗开关状态跨重启保留（上次开则重开，上次关则不打开）。草稿内容跨重启恢复（已有能力，回归验证不丢）。
- [ ] 8. 侧栏顶部不再出现「灵坊」与「协作平台前台」文字；logo 图标仍在。
- [ ] 9. 运行某插件后，侧栏「最近使用」分区出现该插件（置顶、去重）；点击即运行；重启 app 列表仍在；折叠态以图标+tooltip 呈现。

## Open Questions / Decisions（已据研究自决，PRD 评审可推翻）

- **Q（项 7「保存状态」语义）→ 已澄清**：用户确认「需要持久化」。研究进一步发现：草稿/对话内容**已具备**跨重启持久化（`saveDraft` 落盘 + 挂载按 `activeId` 恢复），故本项只做「浮窗开关态持久化」+ 背景模糊，**不**新增保存按钮、**不**重建内容持久化。若用户实指「显式手动保存按钮（区别于现有自动落盘）」，评审时追加。
- **Q（项 8 范围）→ 已澄清**：用户确认「连 logo 一起删」——整个侧栏顶部品牌区（logo + platformName + 副标题）全部移除，搜索栏成为侧栏最顶部。
- **Q（项 9 数量上限）**：暂定最多 5 个（侧栏空间有限）。可调。
- **Q（项 1 根因）**：代码层面已居中，需运行实测。若实测发现在主体内确已居中、用户期望的是「视口居中」，则记为「by design 不改」（因侧栏占位是标准模式）。

## Out of Scope

- 跨重启的创建器草稿内容持久化（见上 Open Questions）。
- AvatarMenu 内「版本发布管理」（桌面端不适用，已剔除）。
- collab-admin / 后端任何改动。
- 通知中心、AccountDialog 内部功能改造（仅改入口与跳转）。

---

# Batch 2（项 10–14，用户第二批追加）

## 项 10 — 通知中心悬浮窗化 + 修复点击即消失/无法关闭的 bug

**根因**：Batch 1 Phase B 把 `<NotificationCenter>` 嵌套渲染在 `AvatarMenu` 内部；AvatarMenu 的「点外部关闭」mousedown handler 把对通知抽屉的点击判为「菜单外」→ 关菜单 → AvatarMenu `return null` → 通知抽屉一起卸载（点一下就消失）；菜单关后抽屉状态卡死，只能重启。

**需求**：通知中心作为**独立悬浮窗**挂在 App 顶层（生命周期与 AvatarMenu 解耦），由 AvatarMenu「通知中心」项回调打开（并关菜单）。点抽屉内任意元素不再触发关闭；抽屉有自身的关闭（X / Esc / 点遮罩）。

## 项 11 — 后台运行 + 最小化到托盘

关窗口时不直接退出，弹询问「最小化到托盘 / 直接退出」+「以后不再询问」复选：

- 选最小化 → 隐藏窗口到系统托盘（进程保留，单击托盘图标恢复，右键菜单含「显示窗口/退出」）。
- 勾「以后不再询问」→ 按上次选择直接执行，偏好持久化（`lf:close-action`）。
- 设置中保留修改入口（SettingsDialog 内「通用」/账户相关 tab 一个开关：「关闭窗口时」→ 最小化到托盘 / 直接退出 / 每次询问）。
- Tauri：启用 `tray-icon` feature + Rust 托盘图标 + `on_window_event` 拦截 `CloseRequested` → prevent_close → 通知前端弹询问。

## 项 12 — 应用名 LingFang → 灵坊工作台（统一显示名）

改所有**用户可见**的 LingFang 展示面：`tauri.conf.json`（productName / 窗口 title / copyright / description / publisher）、`index.html <title>`、TitleBar 默认 label、App `platformName` 默认值、BackendUnreachable/ChangelogDialog 文案、plugin-window 标题后缀、AI 系统提示词与生成骨架注释中的品牌名。
**不改**：bundle identifier `com.lingfang.desktop`、npm 包名 `@lingfang/desktop`、Rust crate `lingfang-desktop`、`window.LingFangBridge` 插件桥 API 名（改会破坏插件契约）、测试路径字面量。

## 项 13 — 创建插件悬浮窗自适应 ~70%（不再铺满）

创建器 overlay 由 `absolute inset-0`（铺满主体）改为居中悬浮窗，约占屏宽高 70%、圆角留边；背景模糊保留（`backdrop-blur`）。内部布局不变。

## 项 14 — 头像菜单 = 所有功能入口，每个按钮对应一个独立悬浮窗；删除 AccountDialog

**需求（用户确认 A）**：AvatarMenu 每个按钮各打开**一个独立悬浮窗**，删掉 AccountDialog 聚合体，其功能拆分整合进菜单：

- 通知中心 → NotificationCenter（项 10 已独立化）
- 钱包 → WalletDialog（承载 Wallet 页）
- 切换团队 → TeamDialog（承载 TeamHome 页）
- 插件管理 → PluginsDialog（承载 Plugins 页）
- 团队管理 → TeamAdminDialog（承载 TeamAdmin 页，仅 isTeamManager）
- LLM 设置 / 设置与快捷键 / 本地权限与安全 → SettingsDialog（承载 Settings 页，打开到对应子 tab：gateway/...）
- 开发者模式 → 创建器悬浮窗（项 13，已独立）
- 个人资料（新增菜单项）→ ProfileDialog（AccountPanel：昵称/邮箱/改密/退出，从 AccountDialog 抽出）
- 帮助与反馈 → 外链
- 退出登录 → resetSession

所有这些悬浮窗挂在 **App 顶层**（各自独立 state），AvatarMenu / 侧栏按钮通过回调打开。删除 `AccountDialog.tsx`。侧栏「插件」项也改为打开 PluginsDialog（与菜单一致）；「审核」保留主区页（admin 工具，不在菜单）。

## Batch 2 Acceptance Criteria

- [ ] 10. 点 AvatarMenu「通知中心」→ 通知抽屉独立浮窗打开；点抽屉内元素不关闭；可用 X/Esc/遮罩正常关闭；不再需要重启恢复。
- [ ] 11. 关窗口弹询问（最小化/退出 + 以后不再询问）；选最小化→托盘；托盘单击恢复、右键菜单（显示/退出）；偏好持久化；设置中可改。
- [ ] 12. 安装包名/窗口标题/标题栏/落地产物名为「灵坊工作台」；无用户可见的 "LingFang" 残留（代码标识符除外）。
- [ ] 13. 创建器为居中悬浮窗约 70%，不再铺满；背景仍模糊；内部功能不受影响。
- [ ] 14. AvatarMenu 每个按钮各开一个独立悬浮窗；AccountDialog 已删；侧栏「插件」打开 PluginsDialog；钱包/团队/设置/个人资料/通知均独立浮窗；RBAC 可见性正确。
- [ ] 通用：typecheck + vite build + vitest + cargo check 全绿。
