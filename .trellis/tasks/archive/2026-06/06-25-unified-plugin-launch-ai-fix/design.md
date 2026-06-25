# Design — 统一插件启动页与一键AI修复

## 架构概览

改动集中在 `apps/desktop/src`，分四块，互相独立可分阶段落地：

```
A. 去图标       → shared.tsx / 各 Row / Sidebar / meta-actions
B. 统一中转页   → 新增 PluginLaunch 视图，PluginRunner 重构为「中转 + 本体」
C. 报错统一     → LocalPluginRow / PluginRunner 接入 creator-error + ErrorBubble
D. AI 修复打通  → AppContext 扩展 pendingAutoFix 载荷 + FloatingCreator 消费
```

D 是用户最在意的「断裂链路」，优先级最高；A 最简单、低风险，可先做暖身。

## A. 删除插件图标

- `components/plugins/author-actions/shared.tsx`
  - 保留 `readPluginIcon`（数据读取，不破坏）。
  - `PluginIcon` 不再在列表/侧栏渲染。两种处理（取其一，倾向方案 1）：
    - 方案 1（推荐）：保留组件但各调用点删除 `<PluginIcon>`，布局收紧（去掉左侧 size-10 占位）。
    - 方案 2：`PluginIcon` 改为返回 null —— 但会留下空 gap，不如直接删调用点干净。
  - 采用方案 1：逐个调用点删除。
- 调用点删除：
  - `pages/plugins/LocalPluginRow.tsx`（`LocalPluginSummary`，去 `<PluginIcon>` + 调整 flex gap）。
  - `pages/plugins/TeamPluginRow.tsx`（第 78 行）。
  - `pages/plugins/MarketplacePluginsSection.tsx`（第 119 行）。
  - `components/Sidebar.tsx`（第 309 行，固定/最近插件项）。
  - `components/plugins/author-actions/meta-actions.tsx`：去掉图标上传/编辑 UI（第 96 行 `<PluginIcon>`
    + 相关 `icon` state / 上传逻辑）。**注意**：保留 manifest.icon 字段写回（不主动清空），仅去 UI。
- 去图标后用文字名占位：列表项左侧改为名称直接起头或首字母圆底（轻量，统一）。
  倾向「名称直接起头」最简洁，不引入新视觉元素。
- `lib/plugin-status.ts` 的 `icon?` 字段保留（scan 仍返回，不展示）。

## B. 统一启动中转页

### 现状回顾
- HTML：`setRunningPlugin` → App overlay → `PluginRunner` → 立即 iframe（无启动期）。
- 脚本：列表「运行」按钮直接 `startPlugin` + toast（**完全不进 Runner**）；或进 Runner 看 ScriptPreviewPanel。
- cloud：Runner 显示 notice。

### 目标
所有启动统一经过「中转页」。`runningPlugin` overlay 仍是承载体，但 `PluginRunner` 内部引入
**启动状态机**，先渲染中转态，再按结果切到本体/错误。

### 设计
新增 `pages/plugins/PluginLaunch.tsx`（或在 PluginRunner 内提炼 `useLaunchState`）：

```
type LaunchState =
  | { phase: 'launching'; runtime; stage?; stageMessage? }  // 启动中
  | { phase: 'ready' }                                       // 进入本体
  | { phase: 'error'; error: CreatorError; pluginContext }   // 失败
```

各运行时进入中转的方式：
- **client(HTML)**：`loadPluginDocument` 期间 phase=launching（通常极快）；成功 ready→iframe；
  抛错 error（kind 映射，如 manifest/读取失败）。
- **nodejs/python**：复用 `startPlugin(onProgress)` 的分阶段事件驱动 launching.stage；
  成功 running（ScriptPreviewPanel 运行态）；失败按现有 `interpreter_missing/manifest_missing/plugin_crashed/...`
  映射 error。**关键**：列表「运行」按钮也要改为「打开（进 Runner 中转页）」而非直接 startPlugin+toast，
  以统一入口。或保留快捷运行但失败时也走统一错误展示。倾向：列表「运行/打开」统一为「打开」进中转页。
- **cloud**：launching 一闪 → ready（CloudRuntimeNotice）；cloud 无本地进程，几乎不失败。

中转页 UI 复用 `ScriptPreviewPanel` 的 `StartProgressView`（已是分阶段步骤条），提炼为可共享组件
`components/plugins/PluginStartProgress.tsx`，HTML/cloud 用其简化态（单步「加载中」）。

### 入口改造
- `usePluginOpeners.openLocalPlugin/openTeamPlugin`：仍 `setRunningPlugin`，但 PluginRunner 接管中转。
- `LocalPluginRow.RunButton`（脚本类直接运行）：改为 `onOpen(item)` 进 Runner 中转页统一启动，
  移除行内 `startPlugin + toast` 路径（否则脚本类有两套启动 UX，违背「统一」）。
  保留行内「停止」用于 running 态快速停（可选）。

## C. 完善启动报错

- 错误模型已有 `lib/creator-error.ts`（`CreatorError` + `toCreatorError`/`fromRunResult`）。复用，不重造。
- `pages/plugins/PluginRunner.tsx`：
  - `RunnerBody` 的 HTML 加载错误 `<p className="text-destructive">{error}</p>`
    → 改为 `<ErrorBubble error={toCreatorError('unknown'|专用kind, caught)} />`。
  - 为 HTML 加载失败补一两个 kind（如 `entry_read_failed`），或暂用 `unknown` 带 raw。
- `pages/plugins/LocalPluginRow.tsx`：
  - 因入口改为统一进中转页，行内 `toggleRun` 的笼统 toast 路径基本下线；保留的删除/停止失败 toast 可留。
- 错误态统一带「让 AI 修复」按钮（见 D），但仅对 AI 可修类型（plugin_crashed / run_failed /
  manifest_missing 可引导补全）。`interpreter_missing` 不给（要装环境）。

## D. 一键 AI 修复打通（最高优先级）

### 断点根因
`handleAutoFix` 设了 `setPendingAutoFixPrompt(prompt)` + `setCurrentDraft(draft)` + 开创建器，
但 `FloatingCreator` 从未读 `pendingAutoFixPrompt`/`currentDraft`，prompt 被丢弃。

### 方案
1. **扩展 AppContext 的修复载荷**：把单一字符串 `pendingAutoFixPrompt` 升级为结构化载荷
   （或新增并存），携带预填所需全部信息：
   ```ts
   interface PendingAutoFix {
     prompt: string;           // 预填到输入框的报错+修复提示词
     plugin: LoadedPlugin;     // 作为 referencedPlugin 注入源码
   }
   pendingAutoFix: PendingAutoFix | null;
   setPendingAutoFix(v): void;
   ```
   兼容性：现有 `pendingAutoFixPrompt`/`setPendingAutoFixPrompt` 可保留或替换；倾向替换为结构化，
   同步改 `use-plugin-runner-actions.handleAutoFix` 生产端。
2. **生产端**（`use-plugin-runner-actions.ts` + 新中转页错误态）：
   `handleAutoFix(stderr)` → 构造 `PendingAutoFix { prompt: autoFixPrompt(stderr, plugin), plugin }`
   → `setPendingAutoFix(...)` → `setView('creator')`。
   prompt 文案增强：带上插件 id/name/runtime + 报错，提示词模板：
   ```
   插件「<name>」(<runtime>) 启动/运行报错，请定位并修复：
   ```<错误标题/raw stderr>```
   请基于当前插件源码（已在上下文）修复问题并重新写出完整文件。
   ```
3. **消费端**（`FloatingCreator.tsx`）：
   - `useApp()` 取 `pendingAutoFix`、`setPendingAutoFix`。
   - `useEffect`：组件挂载且 `pendingAutoFix` 非空时：
     - `setInput(pendingAutoFix.prompt)`（预填，不自动 send）；
     - `setReferencedPlugin(pendingAutoFix.plugin)`（引用源码注入）；
     - `setPendingAutoFix(null)`（消费即清，避免重开又预填）。
   - 注意时序：FloatingCreator 是 lazy + 仅 `creatorOpen` 时挂载。`setView('creator')` 先开窗，
     新挂载的组件 effect 读到 pendingAutoFix。若窗已开则 effect 依赖 pendingAutoFix 变化触发。
     → effect 依赖 `[pendingAutoFix]`，值从 null→载荷时执行预填。
4. **不自动发送**：仅 `setInput` + 引用，用户点发送按钮触发 `send()`（已读 input + referencedPlugin）。

### 端到端验证点
- 跳转后输入框内容 = prompt；引用插件 chip 显示该插件名；点发送后 systemPrompt 含 referencedPlugin 源码。

## 数据流（D 链路）

```
ScriptPreviewPanel(plugin_crashed) / PluginRunner 错误态
  → onRequestFix(stderr) / handleAutoFix(stderr)
  → persistPluginFiles(plugin)               // 落盘最新文件供 AI Read
  → setPendingAutoFix({ prompt, plugin })
  → setView('creator')  → creatorOpen=true
  → <FloatingCreator> mount
  → effect: setInput(prompt) + setReferencedPlugin(plugin) + setPendingAutoFix(null)
  → 用户点「发送」→ send() → relay（systemPrompt 含插件源码 + 用户报错）
```

## 兼容性 / 风险

- 去图标：纯展示删除，低风险；注意 flex/gap 布局不塌（删 size-10 占位后左侧对齐）。
- 中转页：脚本类入口从「行内运行」改「进 Runner」，是 UX 行为变更，需回归脚本插件启动/停止。
- AppContext 结构化载荷替换：检查所有 `pendingAutoFixPrompt` 引用点（仅 App.tsx 定义 +
  use-plugin-runner-actions 生产；无其它消费），替换安全。
- FloatingCreator effect 预填：避免与「历史对话恢复」effect 抢 setInput/setTurns；
  预填只动 `input`（草稿输入），不动 turns，二者不冲突。但若当前在某历史会话中途，预填会覆盖输入框草稿——
  可接受（用户主动点了修复）。

## 回滚

- 四块独立提交，任一出问题可单独 revert。D 的 AppContext 改动需与生产/消费端同批提交。

## 测试策略

- 单测：`autoFixPrompt` 文案构造（含 plugin 信息）；`creator-error` 新增 kind 映射（若加）。
- 组件/集成：FloatingCreator 消费 pendingAutoFix 的 effect（预填 input + 引用）。
- 手动回归：四类插件启动中转页（成功/失败）、去图标布局、AI 修复端到端。
- 构建：`pnpm --filter @lingfang/desktop build` 通过。
</content>
