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
