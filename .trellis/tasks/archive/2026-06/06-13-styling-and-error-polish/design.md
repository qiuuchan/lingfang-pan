# 样式与错误友好化修复 — 技术设计

> 子任务：`06-13-styling-and-error-polish`（父任务 `06-13-plugin-creator-conversational-revamp` 的 R5）。
> 本文件为技术设计（design），执行计划见同目录 `implement.md`。

## 1. 背景与目标

父 PRD 的 **R5（样式与错误友好化）** 要求：插件创建页面从「能用但糙」提升到「贴边修复 + 滚动可见 + 响应式收缩 + 错误友好抛出」。

本子任务聚焦**纯前端层**（`apps/desktop`）的视觉与交互可用性修复，对应跨子任务验收 **AC5（样式）** 与 **AC6（错误友好）**：

- **AC5 样式**：Composer 输入不贴边、诊断/错误文本有容器与 padding、长内容溢出有可见滚动指示、窄窗口下布局不挤压。
- **AC6 错误友好**：CLI 失败、上传失败、解释器缺失、超时等均以对话气泡/卡片友好展示，无裸 toast 或静默。

目标边界（仅前端、零契约变更、零后端依赖）：

1. 修复 7 处已被研究阶段定位的贴边/截断/无 padding/固定宽度问题。
2. 制定全局滚动条策略，恢复「功能性滚动」的可见性，同时保留装饰性隐藏。
3. 让 `aside` 详情面板支持响应式收缩，避免窄窗口挤压对话区。
4. 引入统一的**错误分级与友好展示组件**，把当前散落在 `PluginCreatorHome.tsx` 的 `toast.error` / `setLiveError` 收敛为「对话气泡 + 错误卡片」双通道。

## 2. 现状与问题（精确 file:line）

### 2.1 贴边问题清单

| #   | 问题                                                    | 位置                                                                       | 现状代码                                                                                                          | 根因                                                                                            |
| --- | ------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| P1  | Composer 输入框文字贴边（左右上下无内距）               | `apps/desktop/src/components/creator/Composer.tsx:44`                      | `className="… border-0 bg-transparent p-0 shadow-none …"`                                                         | `Textarea` 基础类（`textarea.tsx:10`）本带 `px-2.5 py-2`，被 `p-0` 清零，导致内容贴在容器内壁   |
| P2  | 诊断文本裸 `<p>`，无容器包裹                            | `apps/desktop/src/components/creator/panels/CreationStatusPanel.tsx:24-26` | `<p …>[{stage}] {status} — {message}</p>`                                                                         | 诊断项直接是 `<p>`，与同级 `Info` 卡片风格不一致，长 message 易溢出卡片且无背景区分             |
| P3  | Bubble 错误态无内 padding                               | `apps/desktop/src/components/chat/Bubble.tsx:7,9`                          | `error && '… border border-destructive/30 bg-destructive/5 …'`；渲染为 `<div className="max-h-72 overflow-auto">` | 错误分支容器只继承 Bubble 外层 `px-4 py-3`，但长堆栈贴住内壁；且无标题/图标区分错误等级         |
| P4  | Info 组件 truncate 截断关键信息（入口/Transcript 路径） | `apps/desktop/src/components/creator/Info.tsx:5`                           | `<div className="truncate font-medium">{value}</div>`                                                             | 单行 `truncate` 把长路径（如 `transcriptPath`、`manifest.entry`）直接截断成 `…`，用户无法看全   |
| P5  | aside 固定 420px，无响应式                              | `apps/desktop/src/pages/PluginCreatorHome.tsx:405-409`                     | `detailsOpen ? 'w-[420px]' : 'w-0'`；内层 `w-[420px]` 硬写死                                                      | 窄窗口下（< 1024px）420px 详情面板会挤压对话区到不可用                                          |
| P6  | 全局隐藏滚动条导致溢出不可见                            | `apps/desktop/src/index.css:120-127`（`@layer base`）                      | `* { scrollbar-width: none }` + `*::-webkit-scrollbar { display: none }`                                          | 对所有元素隐藏滚动条，长 stdout/stderr/源码区域虽能滚动但**用户看不出可滚动**，误以为内容被截断 |
| P7  | header padding 不对称                                   | `apps/desktop/src/pages/PluginCreatorHome.tsx:349`                         | `pl-16 pr-4 py-3`                                                                                                 | `pl-16`（为避开左侧 Sidebar 折叠按钮）与右侧 `pr-4` 不对称，视觉偏移                            |
| P8  | SourcePanel Tabs 横向溢出 flex-wrap 挤压                | `apps/desktop/src/components/creator/panels/SourcePanel.tsx:16`            | `<TabsList className="max-w-full flex-wrap">`                                                                     | 文件多时 tabs 全部换行堆叠，占用大量纵向空间，应改为**横向可滚动 + 单行**                       |

### 2.2 错误抛出现状（散落、双轨、不分级）

当前错误处理在 `apps/desktop/src/pages/PluginCreatorHome.tsx` 内**两套并行且不统一**：

- **toast（sonner）**：`204, 209, 271, 289, 306, 313, 322`——上传失败、提交市场失败、生成失败、停止失败、transcript 失败等都走 `toast.error(message)`，是「右上角一闪而过」的裸提示，不进对话上下文。
- **`setLiveError`（对话气泡）**：`142, 208, 270, 288` + 渲染于 `380`（`<Bubble role="assistant" content={liveError} error />`）——只有 CLI 相关错误进入气泡，且 `liveError` 是单个 `string | null`，**无法承载错误等级/可重试/原因结构**。

后果：

1. 用户上传 4xx/5xx 时只看到一闪 toast，回头找不到错误内容（AC6 不满足）。
2. 错误信息是原始 message（如 `读取 transcript 失败：…`），无分级、无操作建议、无图标。
3. `Bubble` 错误态无标题/原因区分，长堆栈贴边（P3）。
4. 解释器缺失 / 超时（来自 R3 子任务 `run_plugin_script`）**目前无任何友好落点**，会以原始 `stderr` 或 `toast` 出现。

> 注：R3 的 Node/Python 执行错误（解释器缺失 / 超时）由 `06-13-node-python-local-exec` 产生事件，本子任务负责**接收并友好展示**它们——双方约定的错误事件协议见 §3.3。

## 3. 技术方案

### 3.1 设计边界

- **仅前端**：所有改动落在 `apps/desktop/src`（React + Tailwind v4 + shadcn/ui）。不动 `packages/contract`、不动后端、不动 Rust。
- **零契约依赖**：本子任务**不**新增任何 TS 类型契约；错误结构是纯前端内部类型（`CreatorError`，见 §3.2）。
- **复用优先**：
  - 卡片基底复用 `@/components/ui/card`（`Card/CardContent`）。
  - 文本截断复用 `@/lib/utils` 的 `cn`，并复用 `Market.tsx:42` 的 `friendlyError` 思路（按 `code` 映射友好文案）。
  - 对话气泡复用 `Bubble`（`error` 分支增强，不新建组件）。
  - 滚动可见性用纯 CSS（Tailwind v4 任意值 + 自定义工具类），不引入 `simplebar` 等新依赖。

### 3.2 核心数据结构（前端内部类型）

新增 `apps/desktop/src/lib/creator-error.ts`：

```ts
/** 创建流程错误等级：决定图标/颜色/是否可重试 */
export type CreatorErrorLevel = 'error' | 'warning' | 'info';

/** 错误分类：映射到友好文案与展示位置 */
export type CreatorErrorKind =
  | 'cli_start_failed' // CLI 启动失败（code_assistant_start_session 抛错）
  | 'transcript_failed' // 读取 transcript 失败（read_transcript 抛错）
  | 'cli_session_error' // CLI 运行中 error 事件（code-assistant://error）
  | 'upload_failed' // 上传团队云端 4xx/5xx
  | 'submit_market_failed' // 提交公共市场失败
  | 'interpreter_missing' // 解释器缺失（来自 R3 run_plugin_script）
  | 'run_timeout' // 预览执行超时（来自 R3）
  | 'run_failed' // 预览执行非零退出（来自 R3）
  | 'unknown';

/** 统一错误对象 */
export interface CreatorError {
  level: CreatorErrorLevel;
  kind: CreatorErrorKind;
  /** 面向用户的友好标题（如「无法启动代码助手」） */
  title: string;
  /** 面向用户的原因/建议（如「请检查 CLI 是否已安装并配置 API Key」） */
  detail?: string;
  /** 原始技术信息（折叠展示，便于排障，默认不展示给非高级用户） */
  raw?: string;
  /** 是否可重试（决定是否渲染「重试」按钮） */
  retryable?: boolean;
}
```

错误**工厂函数**（同文件），把 `unknown` 异常 + `ApiError.code` 映射为 `CreatorError`：

```ts
import type { ApiError } from '@/lib/api';

/** 按 kind + 原始异常构造友好错误 */
export function toCreatorError(kind: CreatorErrorKind, error: unknown): CreatorError { … }

/** 上传/提交市场的 HTTP 错误映射（复用 Market.friendlyError 思路，扩展 4xx/5xx） */
export function toUploadError(error: unknown, action: 'upload' | 'submit'): CreatorError { … }
```

`toCreatorError` 内置**文案表**（`TITLE_MAP` / `DETAIL_MAP` / `RETRYABLE_MAP`），把每种 kind 映射到固定中文标题与建议，例如：

- `cli_start_failed` → 标题「无法启动本地代码助手」/ 详情「请确认所选 CLI 已安装、已登录、且 API Key 配置正确。」/ `retryable: true`。
- `interpreter_missing` → 标题「未检测到运行环境」/ 详情「Node.js 插件需要 Node（≥18），Python 插件需要 Python（≥3.10）。可通过 py / node 命令安装。」/ `retryable: false`。
- `run_timeout` → 标题「预览执行超时」/ 详情「脚本在限定时间内未结束，可能存在死循环或阻塞输入。」/ `retryable: true`。
- `upload_failed` + HTTP 409/`deduplicated` → 标题「团队云端已存在相同插件」/ 等级 `info`（降级为提示，非错误）。

### 3.3 错误事件协议（与 R3 子任务的对接点）

R3（`06-13-node-python-local-exec`）的 `run_plugin_script` 命令需通过**约定的返回结构**让前端区分错误。本子任务定义前端侧的接收契约（在 `creator-error.ts` 导出解析器）：

```ts
/** R3 run_plugin_script 返回的统一结构（前端视角；R3 实现须满足此形状） */
export interface RunScriptResult {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  /** 失败分类，前端据此映射到 CreatorErrorKind */
  failure?: 'interpreter_missing' | 'timeout' | 'nonzero_exit' | 'spawn_failed';
  /** 解释器探测到的可执行路径（用于在友好卡片里展示「已用 node vX」） */
  interpreter?: string;
}

/** 把 RunScriptResult 失败分支映射为 CreatorError */
export function fromRunResult(result: RunScriptResult): CreatorError { … }
```

> 此协议是**前端单方面定义的期望形状**，R3 子任务须对齐；若 R3 实现细节有出入，在 R3 的 `implement.md` review gate 协调，本子任务不修改 Rust。

### 3.4 数据流（错误收敛）

改造后 `PluginCreatorHome.tsx` 的错误流收敛为**单一来源 → 两个出口**：

```
异常源                            转换                        展示出口
─────────────────────────────────────────────────────────────────────────
code-assistant://error 事件  ─┐
read_transcript 抛错          ─┼─► toCreatorError(...) ──► ① setLiveError(CreatorError)
start_session 抛错            ─┘                              └─► <ErrorBubble>（对话区，错误态气泡，含标题/详情/重试）
uploadCloud / submitMarket 4xx/5xx ─► toUploadError(...) ──► ② toast.error 友好标题（保留 toast 作瞬时反馈）
                                                                  + setLiveError（同时进对话气泡，可回看）
run_plugin_script 失败(R3)   ──► fromRunResult(...) ──► setLiveError（进入对话气泡）
```

关键决策：

- **`liveError` 类型从 `string | null` 升级为 `CreatorError | null`**（`PluginCreatorHome.tsx:51, 142, 208, 270, 288, 380` 同步）。
- **保留 `toast`**：上传/提交成功的 `toast.success` 保留（瞬时正反馈合理）；错误 toast 改为「友好标题」而非原始 message，**且同时** push 进 `liveError`，保证错误进入对话上下文可回看（满足 AC6「无裸 toast」——toast 只是通知，完整错误在气泡里）。
- **成功 toast 保留**：`200, 202, 304, 320` 的 `toast.success` 不动（正向瞬时反馈不属于「错误友好化」范畴）。

### 3.5 组件拆分

#### 3.5.1 新增 `ErrorBubble`（对话区错误气泡）

文件：`apps/desktop/src/components/chat/ErrorBubble.tsx`

职责：渲染 `CreatorError` 为对话气泡，替代 `Bubble` 的 `error` 分支裸文本。

```tsx
export function ErrorBubble({ error, onRetry }: { error: CreatorError; onRetry?: () => void }) {
  // 结构：外层复用 Bubble 视觉（destructive 边框/底色）
  //   - 顶部：图标(AlertTriangle/Error) + 标题（font-medium）
  //   - 中部：detail（text-sm text-muted-foreground），多行支持
  //   - 底部：<details> 折叠 raw（font-mono text-xs，max-h-48 overflow-auto，可见滚动条）
  //   - retryable 且 onRetry：右侧「重试」Ghost 按钮
}
```

`PluginCreatorHome.tsx:380` 渲染处改为：

```tsx
{
  !streaming && liveError && (
    <ErrorBubble error={liveError} onRetry={lastPromptRef.current ? send : undefined} />
  );
}
```

> `lastPromptRef` 复用现有 `pendingPromptRef`（`PluginCreatorHome.tsx:238` 已有 prompt 快照），retry 时重发同一 prompt。

#### 3.5.2 增强 `Bubble`（移除 error 分支裸渲染）

`apps/desktop/src/components/chat/Bubble.tsx`：

- 删除 `error` prop 及其分支（第 4、7、9 行的 `error` 逻辑），错误统一走 `ErrorBubble`。
- 保留正常 `user`/`assistant` 两条路径（`assistant` 仍走 `<Markdown>`，与 R4 子任务的高亮渲染协同——R4 改 `markdown.tsx`，本子任务只去掉 error 分支，不冲突）。

> 兼容性：`Bubble` 的 `error` 仅被 `PluginCreatorHome.tsx:380` 使用，删除是安全的破坏性变更（符合父 PRD「破坏性变更不做向后兼容」）。

#### 3.5.3 增强 `Info`（值可展开/可复制）

`apps/desktop/src/components/creator/Info.tsx`：

- 第 5 行 `truncate` 改为**「可配置」**：新增 `truncate?: boolean`（默认 `false`）。
- 默认用 `break-all`（长路径自然换行，不截断）。
- 显式需要单行截断的场景（如「状态」「退出码」短值）传 `truncate`。
- 长值（路径/sessionId）增加 `title` 属性（原生 tooltip 显示全量）。

调用点同步：`CreationStatusPanel.tsx:17-20`、`SessionStatusPanel.tsx:31-34`。其中「状态/退出码」短值传 `truncate`，「入口/Transcript/PID」长值不传（自然换行 + `title`）。

#### 3.5.4 修复 `Composer` 贴边（P1）

`apps/desktop/src/components/creator/Composer.tsx:44`：

```diff
- className="max-h-44 min-h-20 resize-none border-0 bg-transparent p-0 shadow-none focus-visible:ring-0"
+ className="max-h-44 min-h-20 resize-none border-0 bg-transparent px-1 shadow-none focus-visible:ring-0"
```

- 把 `p-0` 改为 `px-1`（保留水平微内距，垂直沿用容器 `p-3` 即可，文字不再贴左右内壁）。
- 容器 `Composer.tsx:33` 的 `p-3` 保留（已是合理外距）。

#### 3.5.5 诊断项加容器（P2）

`apps/desktop/src/components/creator/panels/CreationStatusPanel.tsx:24-26`：把裸 `<p>` 包进带背景的行容器：

```tsx
{
  diagnostics.map((item, index) => (
    <div
      key={index}
      className={cn(
        'flex items-start gap-2 rounded-md border px-2 py-1.5 text-xs',
        item.status === 'pass'
          ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
          : 'border-destructive/30 bg-destructive/5 text-destructive'
      )}
    >
      <span className="shrink-0 font-medium">[{item.stage}]</span>
      <span className="break-words">{item.message}</span>
    </div>
  ));
}
```

空态 `26` 行的 `<p>` 同步换成与上面一致的 muted 行容器。

#### 3.5.6 `aside` 响应式收缩（P5）

`apps/desktop/src/pages/PluginCreatorHome.tsx:405-409`：

```diff
- detailsOpen ? 'w-[420px]' : 'w-0',
+ detailsOpen ? 'w-full md:w-[420px]' : 'w-0',
```

- 第 407 行：窄窗口（< md=768px）展开时面板占满宽度（覆盖在对话区之上，可用）；md 及以上维持 420px。
- 第 409 行内层 `w-[420px]`：因面板宽度随响应式变化，内层去掉硬编码 `w-[420px]`，改为 `w-full md:w-[420px]` 与外层对齐，避免内层溢出。
- 同时给外层 `aside` 加 `z-20`（窄窗口覆盖态下层级高于对话区）。

> 不引入 container query（项目无 `@container` 配置，见 §1 调研），用 Tailwind v4 默认断点（md=768）即可，零新依赖。

#### 3.5.7 全局滚动条策略（P6）

`apps/desktop/src/index.css:120-127`（`@layer base`）：

**问题根因**：`* { scrollbar-width: none }` 对所有元素生效，功能性滚动区（`pre`/`LiveProcess`/`DetailsPanel` 的 `ScrollArea`/`ErrorBubble` 折叠 raw）也失去滚动指示。

**策略**：区分两类——

1. **装饰性隐藏**（页面级、Sidebar、对话区外层）：保持隐藏。
2. **功能性可见**（代码块、日志、折叠错误堆栈、详情面板）：恢复细滚动条。

改造：把 `@layer base` 的**全局隐藏收紧**为**仅隐藏 body 级/装饰滚动**，功能性区域用**显式可见滚动条工具类**。

```css
@layer base {
  /* 仅装饰性滚动隐藏（页面级、非内容容器） */
  body,
  html,
  .scrollbar-hide {
    scrollbar-width: none;
  }
  body::-webkit-scrollbar,
  html::-webkit-scrollbar,
  .scrollbar-hide::-webkit-scrollbar {
    display: none;
  }
  * {
    @apply border-border outline-ring/50;
  }
  body {
    @apply bg-background text-foreground;
  }
  html {
    @apply font-sans;
  }
}

@layer utilities {
  /* 功能性细滚动条：代码块/日志/堆栈/详情面板使用 */
  .scrollbar-thin {
    scrollbar-width: thin;
    scrollbar-color: var(--border) transparent;
  }
  .scrollbar-thin::-webkit-scrollbar {
    width: 6px;
    height: 6px;
    display: block;
  }
  .scrollbar-thin::-webkit-scrollbar-thumb {
    background: var(--border);
    border-radius: 9999px;
  }
  .scrollbar-thin::-webkit-scrollbar-track {
    background: transparent;
  }
}
```

> `scrollbar-color` 用 CSS 变量 `var(--border)`，自动适配亮/暗主题（`index.css:67, 102` 已定义 `--border`）。

应用点（在已有 `overflow-auto` 元素追加 `scrollbar-thin`）：

- `SourcePanel.tsx:18`（源码 `<pre>`）。
- `SessionStatusPanel.tsx:46-47`（stdout/stderr `<pre>`）。
- `Bubble.tsx`（若保留 assistant 长内容）/ `ErrorBubble` 折叠 raw。
- `DetailsPanel.tsx:50` 的 `<ScrollArea>`：shadcn `ScrollArea` 自带可视滚动条（`ui/scroll-area.tsx` 用 radix），本就可见，**无需改**——但需确认它不被全局 `*` 隐藏（改造后 `*` 不再隐藏，自动恢复）。

#### 3.5.8 header padding 对称（P7）

`apps/desktop/src/pages/PluginCreatorHome.tsx:349`：

```diff
- <div className="flex shrink-0 items-center justify-between gap-3 border-b pl-16 pr-4 py-3">
+ <div className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3 pl-16">
```

> 保留 `pl-16`（为避开折叠态 Sidebar 的悬浮触发区，合理），仅对齐右侧 `pr-4`——其实右侧已是 `pr-4`，问题在于左侧 `pl-16` 与对话区 `max-w-3xl mx-auto px-4`（`363`）视觉不对齐。决策：**保留 `pl-16`**（功能性需要），不改右侧；改为文档说明「`pl-16` 为 Sidebar 避让区，非对称是有意为之」。若 review 认为必须对称，回退方案见 §5。

（注：经分析 P7 影响最小，决策为「保留并注释说明」，避免为对称而破坏 Sidebar 避让。）

#### 3.5.9 SourcePanel Tabs 单行横向滚动（P8）

`apps/desktop/src/components/creator/panels/SourcePanel.tsx:16`：

```diff
- <TabsList className="max-w-full flex-wrap">
+ <TabsList className="max-w-full overflow-x-auto overflow-y-hidden scrollbar-thin">
```

文件多时单行横向滚动（带细滚动条），不再堆叠换行占用纵向空间。

### 3.6 不改动项（明确边界）

- **不动契约**：`packages/contract`、后端 `plugin-package.ts`、Prisma——本子任务无契约面。
- **不动 `markdown.tsx`**：代码高亮/复制由 R4 负责；本子任务只删 `Bubble` 的 error 分支，`assistant` 正常分支的 `<Markdown>` 调用保持不变。
- **不动 `run_plugin_script`（Rust）**：仅消费 R3 约定的 `RunScriptResult` 形状。
- **不动成功 toast**：`toast.success` 是合理瞬时反馈。

## 4. 关键决策与权衡

| 决策                                                 | 选择                                                 | 理由                                                                                                           | 权衡/代价                                                                                  |
| ---------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **错误展示双通道（toast + 气泡）vs 单通道**          | 双通道：toast 作瞬时通知标题，气泡承载完整错误可回看 | AC6 要求「无裸 toast 或静默」——完全去掉 toast 会让用户错过瞬时反馈；纯气泡又不够即时。双通道兼顾即时性与可回看 | 需保证两通道文案一致（都用 `CreatorError.title`）                                          |
| **`liveError` 类型升级为 `CreatorError` 对象**       | 是（破坏性）                                         | 单 `string` 无法承载等级/可重试/原始堆栈                                                                       | 需同步 6 处 `setLiveError` 调用点（`142,208,270,288` 等）+ `380` 渲染点                    |
| **`Info` 默认不 truncate**                           | 是（破坏性，默认值翻转）                             | 长路径是关键信息，截断损害可用性                                                                               | 短值调用点需显式传 `truncate`，改动 `CreationStatusPanel`/`SessionStatusPanel` 共 8 处调用 |
| **滚动条策略：全局收紧 + 显式工具类**                | 是                                                   | 一刀切隐藏损害功能性滚动可见性；显式 `.scrollbar-thin` 让需要可见处可控                                        | 需在 4-5 处 `overflow-auto` 元素追加类名                                                   |
| **aside 响应式用默认断点（md）而非 container query** | 默认断点                                             | 项目无 `@container` 配置，零新依赖                                                                             | 窄屏覆盖态需 `z-20` 处理层级                                                               |
| **删除 `Bubble.error` 分支**                         | 是（破坏性）                                         | 错误有专门 `ErrorBubble` 承载，职责单一                                                                        | 仅 1 处调用点（`380`），改动可控                                                           |
| **P7（header padding）保留非对称**                   | 保留 + 注释                                          | `pl-16` 是 Sidebar 避让的功能需要                                                                              | 视觉略不对称，可接受                                                                       |

> **已确认的用户决策**（来自父 PRD「用户决策」与 R5 研究结论）：错误友好化采用「对话气泡/友好卡片」形式（非纯 toast）；滚动条策略需区分装饰隐藏与功能可见；aside 需响应式收缩。本设计完全遵循。

## 5. 兼容性 / 迁移 / 回滚

### 5.1 兼容性

- **破坏性（前端内部）**：`Bubble` 删除 `error` prop；`Info` 默认 `truncate` 翻转为 `false`；`liveError` 类型 `string → CreatorError`。三者均为 `apps/desktop/src` 内部，无跨包/跨进程消费者，符合父 PRD「破坏性变更不做向后兼容」。
- **无外部契约破坏**：不动 `packages/contract`、后端、Rust。

### 5.2 迁移步骤

1. 先落 `creator-error.ts`（类型 + 工厂 + `RunScriptResult` 解析器）。
2. 再改 `PluginCreatorHome.tsx` 的 `liveError` 类型与所有 `setLiveError` 调用点。
3. 新增 `ErrorBubble`，改 `380` 渲染点。
4. 删 `Bubble.error` 分支。
5. 改 `Info`（默认值 + 调用点）。
6. 改 7 处样式（Composer / CreationStatusPanel / Info / aside / index.css / header / SourcePanel）。
7. `pnpm typecheck` + `pnpm lint` + 手动预览。

### 5.3 回滚形状

本子任务改动**全部集中在 `apps/desktop/src` 的 ~8 个文件**，回滚即 `git revert` 单个 commit，无迁移/数据面影响。具体回滚点见 `implement.md` §5。

## 6. 安全与风险

> 按项目准则，安全性不作为验收条件；此处仅记录与样式/错误展示相关的可用性风险与已知边界。

| 风险                                              | 等级       | 说明                                                                     | 缓解                                                                                             |
| ------------------------------------------------- | ---------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| **`raw` 堆栈泄露内部信息**                        | 低         | `ErrorBubble` 折叠展示原始 message/raw，可能含路径、CLI 命令、token 前缀 | 默认折叠（`<details>`），标题/详情用友好文案；raw 仅排障用，桌面端用户即开发者，可接受           |
| **Node/Python 执行安全边界（R3 侧）**             | 不属本任务 | 软隔离 sandbox 由 R3 设计；本任务仅展示 R3 返回的失败结果                | 在 `creator-error.ts` 注释标明「执行安全边界见 R3 design」                                       |
| **响应式 aside 在极窄窗口（< 480px）覆盖对话区**  | 低         | md 断点以下面板占满，对话区被完全遮盖                                    | 用户可手动关闭面板（已有 `setDetailsOpen(false)`，`PluginCreatorHome.tsx:412` 关闭按钮）；可接受 |
| **`scrollbar-thin` 在某些 WebView2 版本渲染异常** | 低         | Tauri Windows 用 WebView2，`scrollbar-color` 支持度高但极旧版本可能忽略  | 降级为无颜色细滚动条（`scrollbar-width: thin` 兜底），不影响功能                                 |
| **`Info` 默认不 truncate 导致短值换行**           | 低         | 状态/退出码等短值若不传 `truncate` 可能多行                              | 调用点显式传 `truncate`（见 §3.5.3）                                                             |
| **错误双通道文案漂移**                            | 低         | toast 与气泡标题若分别硬编码会不一致                                     | 统一从 `CreatorError.title` 取值，工厂函数单一来源                                               |

## 7. 验证策略（本地可重复）

### 7.1 静态校验

```powershell
# 类型检查（apps/desktop）
pnpm --filter desktop typecheck
# 或：在 apps/desktop 目录下 pnpm typecheck

# 构建（apps/desktop 无 lint 脚本/ESLint，以 typecheck + build 作为静态校验）
pnpm --filter desktop build
```

### 7.2 单元测试（新增 `creator-error.test.ts`）

`apps/desktop/src/lib/creator-error.test.ts`（复用项目既有测试框架，需先确认 desktop 是否有 vitest；若无，则写可被 `node --test` 或现有 runner 执行的最小用例）：

- `toCreatorError('cli_start_failed', err)` → 标题/详情/retryable 正确。
- `toUploadError(409 deduplicated, 'upload')` → level=`info`，标题「已存在」。
- `fromRunResult({ ok:false, failure:'interpreter_missing' })` → kind=`interpreter_missing`，retryable=false。
- `fromRunResult({ ok:false, failure:'timeout' })` → kind=`run_timeout`，retryable=true。

> 若 desktop 无测试 runner，降级为：导出纯函数 + 在 `implement.md` 记录「手动 console 验证脚本」补偿（符合 CLAUDE.md「缺失测试列风险 + 补测计划」）。

### 7.3 手动预览（AC5/AC6 回归）

```powershell
pnpm --filter desktop dev   # 或 pnpm start（按 desktop-app-gotchas 记忆）
```

逐项验证（对照 AC5/AC6）：

1. **P1**：Composer 输入文字不贴左右内壁。
2. **P2**：诊断项有边框背景容器，pass=绿、fail=红。
3. **P3**：触发错误（如断网/CLI 未装）→ `ErrorBubble` 显示标题+详情+折叠 raw+（可重试时）重试按钮。
4. **P4**：Info 长路径（entry/transcript）完整可见或 title 提示全量，短值单行。
5. **P5**：窄窗口（DevTools 调至 < 768px）展开详情面板→占满宽度不挤压；≥768px 维持 420px。
6. **P6**：源码/stdout/折叠 raw 区域滚动时**有可见细滚动条**；页面外层仍无滚动条。
7. **P7**：header 视觉对齐可接受（保留 pl-16）。
8. **P8**：SourcePanel 多文件时单行横向滚动，不换行堆叠。
9. **AC6 错误友好**：模拟上传失败（后端返回 400/409/500）→ toast 显示友好标题 + 对话气泡出现完整错误卡片。

### 7.4 回归对照

- 父 PRD AC5、AC6 全条目逐项打勾。
- 不引入新运行时依赖（`pnpm --filter desktop build` 产物体积无明显增长）。
