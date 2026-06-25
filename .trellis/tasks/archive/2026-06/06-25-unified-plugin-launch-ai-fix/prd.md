# 统一插件启动页与一键AI修复

## Goal

让 apps/desktop（灵坊）插件启动体验统一、报错可读、并把"出错 → 一键交给 AI 修复"链路真正打通：用户点一下即可携带「报错 + 插件信息 + 提示词」跳到桌面端内置 AI 对话（FloatingCreator），直接点发送就能修。

用户原话：
> 删除插件图标，统一启动插件页面，所以插件启动都要使用，完善插件启动报错显示，需要现在具体错误，支持一键将报错和插件还有提示词，通过点击ai修复。一键跳转ai对话，直接点击发送就能修复

## 已确认的决策（来自澄清提问）

- 纳入方式：新建独立 Trellis 任务（不动 custom-windows-installer-updater）。
- 统一启动页形态：**统一启动中转页**——点任意插件先进同一个「启动中/启动结果」页面，再进入插件本体或显示错误。
- AI 修复目标：桌面端**内置 AI 对话**（即 `FloatingCreator`，`setView('creator')` 打开的悬浮窗）。
- **删图标范围**：所有列表（本地/团队/市场）+ 侧栏（固定/最近）去图标；编辑器内图标编辑也去掉；
  **保留 `manifest.icon` 字段不破坏数据**（仅停止展示，不废弃字段）。
- **中转页覆盖**：client / nodejs / python / cloud **四类全部走中转页**。
- **发送时机**：**预填等用户点发送**（报错+提示词填进输入框、插件源码作为引用注入，不自动发送）。

## 现状（代码勘察确认的事实）

插件系统位于 `apps/desktop/src`：

- **图标**：`components/plugins/author-actions/shared.tsx` 的 `PluginIcon` 组件 + `readPluginIcon`。
  渲染于：`Sidebar.tsx`、`LocalPluginRow.tsx`、`TeamPluginRow.tsx`、`MarketplacePluginsSection.tsx`、
  `author-actions/meta-actions.tsx`（编辑器内）。图标来源 `manifest.icon`，缺失回退 🧩。
- **启动流程（当前分裂）**：
  - client(HTML)：列表「打开」→ `usePluginOpeners.openLocalPlugin/openTeamPlugin` → `setRunningPlugin` →
    `App.tsx` 全屏 overlay 渲染 `PluginRunner` → iframe 加载（`loadPluginDocument`）。
  - nodejs/python：列表「运行/停止」按钮 `LocalPluginRow.RunButton` → 直接 `startPlugin/stopPlugin` + toast；
    或进入 `PluginRunner` → `ScriptPreviewPanel` 走 `start_plugin`（分阶段进度 checking/deps_installing/starting）。
  - cloud：`PluginRunner` 显示 `CloudRuntimeNotice`。
  - 「新窗口」：`plugin-window.ts` `openPluginInWindow` 弹独立 Tauri 窗口。
  - 没有统一的「启动中转页」：HTML 直接进 iframe，脚本走按钮 toast，三条路径体验不一致。
- **报错显示（当前分裂）**：
  - `LocalPluginRow.toggleRun` 失败仅 `toast.error(errorMessage)`（笼统）。
  - `PluginRunner.RunnerBody` HTML 加载错误为一行纯文本 `<p>{error}</p>`。
  - `ScriptPreviewPanel` 有较完善的 `ErrorBubble` + `creator-error.ts` 分级（interpreter_missing /
    manifest_missing / plugin_crashed / run_* 等，含标题+建议+raw stderr）。
  - 错误模型 `lib/creator-error.ts`：`CreatorError { level, kind, title, detail, raw, retryable }`，文案表齐全。
- **一键 AI 修复（当前部分断裂）**：
  - `ScriptPreviewPanel` 在 `plugin_crashed` 时显示「让 AI 修复」按钮 → `onRequestFix(stderr)`。
  - `use-plugin-runner-actions.handleAutoFix(stderr)`：persist 文件 + `setCurrentDraft` +
    `setPendingAutoFixPrompt(autoFixPrompt(stderr))` + `setView('creator')`。
  - **断点**：`FloatingCreator` 只读 `session/recentPlugins`，**未消费** `pendingAutoFixPrompt` / `currentDraft`，
    所以跳到创建器后报错与提示词被丢弃，用户看不到预填、更谈不上「直接点发送」。
- **AI 对话（FloatingCreator）**：`components/creator/FloatingCreator.tsx`，`send()` 读 `input` state 流式调 relay。
  `引用插件`（referencedPlugin）可注入现有插件源码到 systemPrompt。输入框 `input`/`setInput`，发送 `send()`。
- **App 状态机**：`view` 非真正路由，`setView('creator')` 实为打开 `creatorOpen` 悬浮窗。
  `pendingAutoFixPrompt`/`setPendingAutoFixPrompt`、`currentDraft`、`runningPlugin` 都在 AppContext 中。

## Requirements

1. **删除插件图标**：移除所有列表（本地/团队/市场）与侧栏（固定/最近）的图标展示，
   以及编辑器（meta-actions）内的图标上传/编辑 UI。保留 `manifest.icon` 字段与 `readPluginIcon` 数据读取
   （仅停止渲染，不破坏现有插件数据）。`PluginIcon` 组件在去图标位置不再使用，名称改为纯文字/首字母占位。

2. **统一启动中转页**：新增一个统一的「插件启动」中转视图，client/nodejs/python/cloud 四类插件点启动
   都先进此页。展示统一的状态机：
   - 启动中（脚本类复用 `checking → deps_installing → starting` 分阶段进度；HTML/cloud 用轻量加载态）；
   - 成功 → 进入插件本体（HTML iframe / 脚本运行态 / cloud 入口说明）；
   - 失败 → 显示具体错误（见需求 3）。

3. **完善启动报错**：失败时显示具体错误（标题 + 原因建议 + 原始 stderr/技术信息），
   统一走 `ErrorBubble` + `creator-error.ts` 模型，取代 `LocalPluginRow.toggleRun` 的笼统 toast
   与 `PluginRunner.RunnerBody` 的纯文本 `<p>`。所有启动路径错误信息一致可读。

4. **一键 AI 修复（打通链路）**：错误状态下提供「让 AI 修复」按钮，点击后：
   - 打包「报错（title+detail+raw）+ 插件信息（id/name/runtime）+ 修复提示词」预填进 `FloatingCreator` 输入框；
   - 把该插件源码作为「引用插件」（referencedPlugin）注入，让 AI 基于现有代码改；
   - 打开 AI 对话悬浮窗，**预填好但不自动发送**，用户确认后点发送即开始修复。
   - 必须修复当前断点：`FloatingCreator` 需消费 `pendingAutoFixPrompt`（及携带的插件引用）。

## Acceptance Criteria

- [ ] 本地/团队/市场插件列表与侧栏均不再显示插件图标（🧩 或自定义图标），布局不塌陷。
- [ ] 编辑器（meta-actions）不再有图标上传/编辑控件；`manifest.icon` 字段仍存在、旧插件数据不报错。
- [ ] 点击任意运行时（client/nodejs/python/cloud）插件的启动入口，都先进入统一启动中转页。
- [ ] 脚本类插件在中转页显示分阶段启动进度；成功后进入运行态，失败进入错误态。
- [ ] HTML 插件启动成功直达 iframe 本体；cloud 插件进入入口说明；二者失败同样进错误态。
- [ ] 启动失败时展示具体错误：标题 + 原因建议 + 可展开的原始 stderr/技术信息（不再是单行 toast 或纯文本）。
- [ ] 错误态出现「让 AI 修复」按钮（对可由 AI 修的错误类型，如 plugin_crashed/run_failed）。
- [ ] 点「让 AI 修复」后打开 AI 对话，输入框已预填报错+提示词，且已引用该插件源码；未自动发送。
- [ ] 用户在 AI 对话直接点发送即可让 AI 收到完整上下文开始修复（端到端验证预填内容正确进入 relay 请求）。
- [ ] `pnpm --filter @lingfang/desktop build`（或等价 tsc/vite 构建）通过；新增/改动逻辑有必要的单测。

## Out of Scope

- 后端 Rust 启动命令（start_plugin/scan_plugin_status）改造，除非统一中转页必须。
- 插件市场/计费逻辑。
- `manifest.icon` 字段的彻底废弃（本期仅停止展示）。

## Open Questions

- 无（核心决策已确认；实现细节见 design.md）。
</content>
