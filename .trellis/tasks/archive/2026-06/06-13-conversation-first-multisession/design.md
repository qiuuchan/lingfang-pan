# 技术设计：对话优先重构与多会话管理

> 配套 `prd.md`。本文件为工程实现的技术契约：精确到 `file:line` 的现状引用、四块改造方案（对话优先 / 多会话 / 预览大窗 / 草稿双触发）、端到端数据流、组件拆分、兼容迁移与验证策略。行号基于 `main` 分支当前实现（核对日期 2026-06-13）。

---

## 1. 背景与目标

桌面端「插件创建」当前是「每轮对话 = 插件创建长任务」模式：`send()` 一律把 prompt 喂给注入了 `PLUGIN_CREATOR_SYSTEM_PROMPT` 的本地 CLI，再无条件 `buildLocalDraft/mergeFollowupDraft` 解析 stdout。这导致「你好」这类纯闲聊也会被判为 `invalid`（无 manifest 块）并强制弹详情面板。

目标（PRD Goal）是重构为「对话优先 + 按需结构化 + 多会话管理」，参考 AionUi 的对话软件模式：

1. 默认通用对话，不注入插件协议；AI 产出含结构化块（manifest/file）时才解析为草稿（自动检测），或用户手动「转为插件草稿」（手动触发）。
2. 多会话：本机管理多个对话，每会话独立草稿 + 独立 cli_session_id，切换无状态续接（复用现有 `--resume` / 历史摘要，不保持常驻进程）。
3. 预览独立为大窗（全屏 Sheet），删右侧固定预览 tab + 源码固定展示。
4. 草稿双触发：自动检测 + 手动按钮。

本期决策：四块一起做，分四阶段渐进交付（见 `implement.md`）。复用优先：`parseStructuredPackage` / `previewSrcDoc` / `sheet.tsx` / `Bubble` / `LiveProcess` / `normalizeTurns` 全部复用不重写。

---

## 2. 现状与问题（精确 file:line）

### 2.1 对话被强绑插件创建

- `apps/desktop/src/pages/PluginCreatorHome.tsx:275` —— `startNewSession` 内 `const systemPrompt = PLUGIN_CREATOR_SYSTEM_PROMPT;` 硬编码注入插件协议 systemPrompt（每轮都走）。
- `PluginCreatorHome.tsx:185-251` —— `finalizeSession` 无条件走结构化：
  - `:214-228`：首轮 `buildLocalDraft({ prompt, providerLabel, model, result })`（内部 `parseStructuredPackage`）。
  - `:217`：追问 `mergeFollowupDraft(currentDraft, probeResult, promptText)`。
  - `:231`：`setDetailsOpen(true)` 强制弹详情面板。
- `apps/desktop/src/lib/plugin-draft.ts:373-497` —— `parseStructuredPackage`：无 manifest 块时 `manifestObj` 保持 `null` → `:460` 判 `status = 'invalid'`。即「你好」→ invalid。
- `plugin-draft.ts:535-608` —— `buildLocalDraft` 永远产出非 null 草稿（带 `manifest.json` + 兜底 entry），即使 invalid 也塞一堆诊断。

### 2.2 单会话假设

- `apps/desktop/src/App.tsx:129` —— `const [currentDraft, setCurrentDraft] = useState<PluginDraft | null>(null);` 单一 useState，无会话维度。
- `PluginCreatorHome.tsx:57-59` —— `assistantSession` / `assistantSessionRef` / `assistantSessionIdRef` 均单值，假设全局只有一个活动会话。
- `PluginCreatorHome.tsx:115` —— listener 守卫 `payload.sessionId !== assistantSessionIdRef.current` 只认单一 id，切换会话后旧 id 的回调会被静默丢弃。

### 2.3 预览塞右侧 tab，源码固定被动

- `apps/desktop/src/components/creator/DetailsPanel.tsx:48-84` —— 4 个 tab（preview/status/analyze/share），preview tab（`:60-63`）含 `PreviewPanel` + `SourcePanel`。
- `DetailsPanel.tsx:61-62` —— `PreviewPanel`（iframe `h-[360px]`，`PreviewPanel.tsx:30`）+ `SourcePanel`（`pre` `max-h-64`，`SourcePanel.tsx:18`）挤在 420px 宽 aside 里，多文件放不下。

### 2.4 后端已具备的多会话基座（部分）

- `apps/desktop/src-tauri/src/code_assistant/store.rs:34-58` —— `SessionRecord` 已是 `Vec` 多会话，已有 `cli_session_id`（`:56-57`）。
- `store.rs:216-232` —— `list_sessions` / `upsert_session`（按 `session_id` 定位、按 `started_at` 降序、`write_json` 落盘）。
- `store.rs:202-206` —— `transcript_path` 产出 `transcripts/{id}.jsonl`。
- `store.rs:294-296` —— `read_transcript`。已有 `transcripts` 目录创建（`:110`）。
- `apps/desktop/src-tauri/src/code_assistant.rs:274-353` —— `start_session`（`:284-287` 拼 `systemPrompt + prompt`，systemPrompt 为空则裸 prompt）。
- `code_assistant.rs:355-429` —— `send_input`（claude `--resume` / codex-opencode 走 `build_history_summary`，`:392`，函数定义 `:1154`）。
- `apps/desktop/src-tauri/src/main.rs:195-211` —— `invoke_handler` 注册；现有 code_assistant 命令在 `:199-208`。

### 2.5 已具备的可复用件

- `apps/desktop/src/components/chat/Bubble.tsx` —— `Bubble({ role, content })` + `Markdown` 渲染。
- `apps/desktop/src/components/chat/LiveProcess.tsx` —— 流式 stage/events。
- `plugin-draft.ts:296-351` —— `extractFencedBlocks`（逐行扫描 fenced block，返回 `StructuredBlock[]`）。
- `plugin-draft.ts:715-726` —— `previewSrcDoc(files)`（拼 shim + entry html）。
- `apps/desktop/src/components/ui/sheet.tsx:36-39` —— `sheetVariants.right` 当前 `w-[min(92vw,640px)]`，可用 `className` 覆盖。
- `plugin-draft.ts:610-618` —— `normalizeTurns`（去重相邻同 role+content）。

---

## 3. 技术方案

### 3.1 对话优先（解耦「对话」与「插件创建」）

#### 3.1.1 通用 systemPrompt

`PluginCreatorHome.tsx:275` 不再硬编码 `PLUGIN_CREATOR_SYSTEM_PROMPT`。改为：

- 不传 `systemPrompt`（让 `code_assistant.rs:284-287` 的 `match` 走 `_ => input.prompt.clone()` 裸 prompt 分支），即默认通用对话。
- 保留 `PLUGIN_CREATOR_SYSTEM_PROMPT` 常量与 `plugin-creator-protocol.ts`，不删除（手动「转为插件草稿」可选择性复用其协议提示；后续若要在手动触发时强化协议，通过独立 `forcePluginProtocol` 通道注入，不再每轮注入）。

`send()`（`PluginCreatorHome.tsx:307-357`）保持首问/追问分流不变（`:322-341` 追问、`:343-356` 首问），仅 `startNewSession` 不再塞 systemPrompt。

#### 3.1.2 finalizeSession 按需结构化 gate（核心）

改 `finalizeSession`（`PluginCreatorHome.tsx:185-251`）。新增 gate 判定函数（放 `plugin-draft.ts`，命名 `hasStructuredBlocks`）：

```ts
// 复用 extractFencedBlocks（plugin-draft.ts:296-351）探测产出是否含 manifest/file 块。
// 纯函数，可单测。true 才进入 buildLocalDraft/mergeFollowupDraft。
export function hasStructuredBlocks(rawText: string): boolean {
  const blocks = extractFencedBlocks(rawText);
  return blocks.some((b) => b.kind === 'manifest' || b.kind === 'file');
}
```

`finalizeSession` 改造（保留 transcript 解析 `:188-192`、`finalSession` 构造 `:195-210`、`setAssistantSession` `:211`、`:229-238` toast 逻辑）：

- `:188` 拿到 `raw` transcript → `events = parseTranscript(raw)` → `stdout = transcriptText(events, 'stdout')`。
- gate：`const structured = hasStructuredBlocks(stdout)`。
- **无结构化块**（`!structured`）：只追加对话 turn，草稿保持 null。
  - 首轮：`setCurrentDraft((prev) => prev ? mergeConversationTurn(prev, promptText, stdout) : makeConversationDraft(promptText, stdout))`。
  - 追问：在既有 draft 上追加 turn（复用 `normalizeTurns`）。
  - 不调 `setDetailsOpen(true)`（去掉 `:231` 的强制弹），右侧面板默认收起。
- **有结构化块**（`structured`）：走原 `buildLocalDraft`（`:221-227` 首轮）/ `mergeFollowupDraft`（`:217` 追问）路径，产出/更新草稿，且仅此时 `setDetailsOpen(true)`（点亮「预览」按钮的视觉信号）。

`makeConversationDraft` / `mergeConversationTurn` 为 `plugin-draft.ts` 新增纯函数（不引入结构化解析，只产 `turns`，`files=[]`、`status='generating'` 或不设 status）：

```ts
// 纯对话态草稿：无 files/manifest，仅 turns。status 用 'generating' 占位（AC1 不弹 invalid）。
export function makeConversationDraft(userPrompt: string, assistantOutput: string): PluginDraft;
export function mergeConversationTurn(prev: PluginDraft, userPrompt: string, assistantOutput: string): PluginDraft;
```

> 注意：纯对话态 `status` 不能是 `invalid`（否则触发现有 `PluginCreatorHome.tsx:443` 的 destructive Badge 与「预览」disabled）。约定纯对话态 `status: 'generating'`（`STATUS_LABEL` 已有此键，`plugin-draft.ts:113`）。

#### 3.1.3 listener 守卫按 activeId 路由

`PluginCreatorHome.tsx:115/136/142/158/164` 五处 `payload.sessionId !== assistantSessionIdRef.current` 改为 `payload.sessionId !== activeIdRef.current`（见 §3.2 会话 store 引入 `activeId`）。切换会话时 `activeId` 变，旧会话残留回调自动被守卫拦截（与现状行为一致，只是 id 源头从单值变为 store 活动项）。

### 3.2 多会话管理（本机，参考 AionUi）

#### 3.2.1 Rust SessionRecord 加三字段

`store.rs:34-58` `SessionRecord` 末尾追加（全 `Option` + `#[serde(default)]`，保证旧 `sessions.json` 可读）：

```rust
// 对话展示标题（首启 lazy 从 transcript 首 input 截断 24 字回填）。
#[serde(default, alias = "title", rename = "title")]
pub title: Option<String>,
// 归档标记（会话栏折叠归档区，不参与默认列表）。
#[serde(default, alias = "archived", rename = "archived")]
pub archived: Option<bool>,
// 草稿最后更新时间（会话栏排序依据，ISO 字符串）。
#[serde(default, alias = "draftUpdatedAt", rename = "draftUpdatedAt")]
pub draft_updated_at: Option<String>,
```

> 字段用 `#[serde(default)]` 而非 `#[serde(default = "...")]`，即缺失→`None`，与 `cli_session_id`（`store.rs:56-57`）一致风格。前端类型镜像同步（见 §3.2.4）。

#### 3.2.2 Rust store 新增草稿分文件 + CRUD

`store.rs` 新增方法（紧邻 `transcript_path`/`read_transcript`，`:202-296` 区域）：

- `fn drafts_dir(&self) -> PathBuf` → `self.root.join("drafts")`；`AssistantStore::new`（`:109-112`）的 `fs::create_dir_all` 同时建 `drafts` 子目录。
- `fn draft_path(&self, session_id: &str) -> PathBuf` → `drafts/{session_id}.json`。
- `fn read_draft(&self, session_id: &str) -> Result<Option<String>, String>` → 文件不存在返回 `Ok(None)`，存在读原文（`fs::read_to_string`，失败映射 `error.to_string()`）。
- `fn write_draft(&self, session_id: &str, raw: &str) -> Result<(), String>` → `write_json` 同款「建父目录 + 写」模式（`store.rs:380-386`），但写的是前端传入的序列化字符串（避免 Rust 反序列化前端 `PluginDraft` 形态，前后端草稿 schema 解耦）。
- `fn delete_session(&self, session_id: &str) -> Result<(), String>` → `list_sessions` 后 `retain(|item| item.session_id != session_id)` 写回（复用 `upsert_session` `:220-232` 的定位-写回模式）+ 删 `transcripts/{id}.jsonl`（`store.rs:202-206`）+ 删 `drafts/{id}.json`。

#### 3.2.3 Rust 命令层 + main.rs 注册

`code_assistant.rs` 末尾命令函数区（参照 `:551` `list_sessions`、`:555` `read_transcript` 风格）新增 `pub fn`：

- `rename_session(state, input: RenameSessionInput) -> Result<SessionRecord, String>` —— 定位 record 改 `title` + `draft_updated_at = now_string()`，`upsert_session` 写回。
- `delete_session(state, input: DeleteSessionInput) -> Result<(), String>` —— 调 `store.delete_session`。
- `save_draft(state, input: SaveDraftInput) -> Result<(), String>` —— 调 `store.write_draft` + 同步回 `draft_updated_at`（定位 record 改字段 `upsert_session`）。
- `read_draft(state, input: ReadDraftInput) -> Result<Option<String>, String>` —— 调 `store.read_draft`。

四个 `Input` 结构体放 `code_assistant.rs`（与 `StartSessionInput`/`SendInputInput`/`StopSessionInput`/`ReadTranscriptInput` 同区）：

```rust
pub struct RenameSessionInput { pub session_id: String, pub title: String }
pub struct DeleteSessionInput { pub session_id: String }
pub struct SaveDraftInput { pub session_id: String, pub draft_json: String }
pub struct ReadDraftInput { pub session_id: String }
```

`main.rs` `invoke_handler`（`:195-211`）追加注册（紧邻 `:208` `code_assistant_read_transcript` 之后、`:209` `plugin_script` 之前）：

```rust
code_assistant_rename_session,
code_assistant_delete_session,
code_assistant_save_draft,
code_assistant_read_draft,
```

四个 `#[tauri::command]` wrapper 放 `main.rs:150-156` 区域（紧邻 `code_assistant_read_transcript` wrapper）。

#### 3.2.4 前端类型（`plugin-draft.ts`）

新增三个类型（紧邻 `AssistantSessionRecord`/`AssistantSessionState`，`:40-69`）：

```ts
// 会话栏列表项（轻量，不含 turns/draft 正文）。
export interface ConversationMeta {
  sessionId: string;
  tool: ProviderId;
  model?: string | null;
  title?: string | null;
  status: string;
  startedAt: string;
  draftUpdatedAt?: string | null;
  archived?: boolean | null;
}

// 完整对话态（切换到该会话时加载）。
export interface Conversation {
  meta: ConversationMeta;
  draft: PluginDraft | null;        // 结构化草稿（hasStructuredBlocks 时非空）或纯对话 draft
  assistantSession: AssistantSessionState | null;
}
```

`ConversationStore` 放 `PluginCreatorHome.tsx` 组件内（state 管理），不污染 `plugin-draft.ts` 纯函数区：

```ts
interface ConversationStore {
  metas: ConversationMeta[];         // tauriInvoke('code_assistant_list_sessions') 一次拉取
  activeId: string | null;           // 当前活动会话 id（localStorage 持久化）
}
```

`ConversationMeta` 的 TS 镜像 `AssistantSessionRecord`（`:40-52`）补充 `title`/`draftUpdatedAt`/`archived`（均 optional，对齐 Rust `#[serde(default)]`）。

#### 3.2.5 会话栏 UI（新增 `ConversationRail`）

新增 `apps/desktop/src/components/creator/ConversationRail.tsx`：

- 三栏布局：全局 `Sidebar`（App.tsx:261）| `ConversationRail`（w-64，固定左）| 对话区（原 `PluginCreatorHome` 主体）。
- 顶部「+ 新对话」按钮（调 §3.2.6 新建逻辑）。
- 列表项：`title`（或首 prompt 截断 24 字）+ `tool` Badge + `draftUpdatedAt` 相对时间；右键/按钮菜单：重命名、删除、归档。
- `activeId` 高亮；点击触发 `onSelect(id)`。
- 排序：`draftUpdatedAt ?? startedAt` 降序（前端排序，不动 Rust）。

#### 3.2.6 新建 / 切换 / 删除 / 重命名

- **新建**：`PluginCreatorHome` 的 `newDraft()`（`:418-433`）语义保留为「清空当前对话态」，但新增「建会话」逻辑——首条 `send()` 时 `start_session` 已自动产 `SessionRecord`（`code_assistant.rs:309` 构造 record），前端在 `session-started` listener（`PluginCreatorHome.tsx:114-132`）里把新 record 推入 `metas` 并设为 `activeId`。即「新建对话」= 清空输入区 + 重置运行态，首条消息落库后自动成为新会话。
- **切换**：`setActiveId(id)` → `tauriInvoke('code_assistant_read_draft', { input: { sessionId: id } })` 拿 draft JSON → `setCurrentDraft(JSON.parse)`；从对应 transcript 重建 `assistantSession`（或从 `metas` 里的 record 字段恢复 `AssistantSessionState`）→ 渲染。切换前若有未落盘草稿，先 `save_draft`（见 §3.2.7）。
- **删除**：`tauriInvoke('code_assistant_delete_session', { input: { sessionId } })` → 前端 `metas.retain` → 若删的是 activeId，切到首项或新建空态。
- **重命名**：`tauriInvoke('code_assistant_rename_session', { input: { sessionId, title } })` → 更新 `metas[i].title`。

`activeId` 持久化 localStorage：`lf:active-conversation:{tenantId}`（命名对齐 `recentKey`/`pinKey`，`plugin-draft.ts:728` / `App.tsx:46`）。新建/切换/删除时同步写。

#### 3.2.7 草稿落盘（drafts/{sessionId}.json）

`finalizeSession`（`PluginCreatorHome.tsx:185-251`）末尾、`setCurrentDraft` 之后，追加 `tauriInvoke('code_assistant_save_draft', { input: { sessionId: activeId, draftJson: JSON.stringify(nextDraft) } })`。切换会话前（`onSelect`）对当前未保存 draft 先 `save_draft`，再切。`read_draft` 在 `onSelect` 后调，恢复草稿。

### 3.3 预览大窗

#### 3.3.1 删 DetailsPanel preview tab + SourcePanel 固定展示

`DetailsPanel.tsx:48-84`：

- 删 `TabsTrigger value="preview"`（`:52`）与 `TabsContent value="preview"`（`:60-63`，含 `PreviewPanel` + `SourcePanel`）。
- `TabsList` 从 `grid-cols-4`（`:51`）改 `grid-cols-3`，剩 status/analyze/share。
- 删 `PreviewPanel`/`SourcePanel` import（`:6-7`）。组件本身保留（供 `PreviewDrawer` 复用）。
- `DetailsPanel` props 删 `files`/`activeFile`/`activeContent`/`previewKey`/`onActiveFileChange`/`onRefreshPreview`（`:18/26/27/23/22/25`）——这些迁到 `PreviewDrawer`。`preview` tab 相关 props 全部上移到顶部按钮触发的 Sheet。

#### 3.3.2 顶部「预览」按钮

`PluginCreatorHome.tsx:445-450` 顶部按钮组改造：

- 保留「新对话」（`:446`）。
- 把「详情」（`:447-449`）保留（切换右侧状态/分析/分享面板）。
- 新增「预览」按钮：`disabled={!hasDraft}`（`hasDraft = Boolean(currentDraft?.files.length)`）；disabled 时 `title` tooltip「无草稿可预览」。
- 点击 → `setPreviewOpen(true)`（新 state）。

#### 3.3.3 全屏 Sheet（复用 `sheet.tsx`）

新增 `apps/desktop/src/components/creator/PreviewDrawer.tsx`：

```tsx
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { PreviewPanel } from './panels/PreviewPanel';
import { SourcePanel } from './panels/SourcePanel';

export function PreviewDrawer({ open, onOpenChange, files, activeFile, activeContent, previewKey, onActiveFileChange, onRefreshPreview }: ...) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[min(95vw,1400px)] max-w-none p-0 flex flex-col">
        {/* className 覆盖 sheetVariants.right 的 w-[min(92vw,640px)]（sheet.tsx:37） */}
        <SheetHeader className="flex-row items-center justify-between border-b">
          <SheetTitle>插件预览</SheetTitle>
        </SheetHeader>
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(280px,40%)]">
          <PreviewPanel files={files} previewKey={previewKey} onRefresh={onRefreshPreview} />
          <SourcePanel files={files} activeFile={activeFile} activeContent={activeContent} onActiveFileChange={onActiveFileChange} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
```

要点：
- `SheetContent` 的 `className="w-[min(95vw,1400px)]"` 覆盖 `sheetVariants.right`（`sheet.tsx:37` 的 `w-[min(92vw,640px)]`）——`cn`（`sheet.tsx:52-55`）后写覆盖先写，宽度生效。
- 多文件切换：复用 `SourcePanel` 的 `Tabs`（`SourcePanel.tsx:15-17`）+ `activeFile`/`onActiveFileChange` props 透传（与现状 `PluginCreatorHome.tsx:68/515/521` 完全一致）。
- `previewKey`（`PluginCreatorHome.tsx:69/230`）复用，刷新按钮走原 `onRefreshPreview`（`:522`）。

### 3.4 草稿双触发

#### 3.4.1 自动检测（§3.1.2 gate 已覆盖）

`finalizeSession` 内 `hasStructuredBlocks(stdout)` 为 true → 自动 `buildLocalDraft`/`mergeFollowupDraft`。即 AI 说「做个番茄钟插件」并产出 manifest 块时，自动生成草稿、点亮「预览」按钮（AC3）。

#### 3.4.2 手动按钮「✨ 转为插件草稿」

对话区 assistant 气泡下新增按钮（仅当当前会话 `currentDraft` 无 files 或为纯对话态时显示）：

- 位置：`PluginCreatorHome.tsx:467` `turns.map` 的 assistant Bubble 之后（或 `Bubble` 加可选 `actions` 渲染槽，复用 `Bubble`，不重写——见下方实现说明）。
- 点击逻辑：取当前活动会话最近一轮 assistant stdout（从 transcript 或 `assistantSession.stdout`），强制调 `buildLocalDraft`（首轮）/ `mergeFollowupDraft`（追问）生成草稿。即使 `hasStructuredBlocks=false` 也强制解析（产出 partial/invalid 草稿，给用户兜底预览）。
- 命名 `forceConvertToDraft(sessionId)`，放 `PluginCreatorHome.tsx`。

> `Bubble`（`Bubble.tsx:4`）当前签名 `({ role, content })` 无 actions 槽。方案：给 `Bubble` 增加可选 prop `actions?: ReactNode`，渲染在内容下方（不重写主体逻辑，仅扩槽）。这是对复用件的最小扩展，符合「不重写」。

---

## 4. 数据流（端到端）

### 4.1 发消息（通用对话或按需结构化）

```
用户输入 → send() (PluginCreatorHome.tsx:307)
  ├─ 首问: startNewSession (无 systemPrompt, code_assistant.rs:284 走裸 prompt 分支)
  │        → start_session → SessionRecord(cli_session_id 暂空) + session-started 事件
  │        → 前端 metas.push + setActiveId + localStorage 写 activeId
  └─ 追问: send_input (code_assistant.rs:355, claude --resume / codex 历史摘要)
       → output/exit 事件流
            └─ finalizeSession (PluginCreatorHome.tsx:185)
                 ├─ hasStructuredBlocks(stdout)?
                 │    ├─ true:  buildLocalDraft/mergeFollowupDraft → 草稿(status ready/partial) → setDetailsOpen(true)
                 │    └─ false: makeConversationDraft/mergeConversationTurn → 纯对话 draft(status generating) → 不弹面板
                 ├─ save_draft (drafts/{sessionId}.json)
                 └─ metas[i].draftUpdatedAt = now
```

### 4.2 切换会话

```
ConversationRail.onSelect(id)
  → 若当前 activeId 有未落盘 draft: save_draft(当前)
  → setActiveId(id) + localStorage 写
  → read_draft(id) → JSON.parse → setCurrentDraft
  → 从 metas[i] record 字段重建 assistantSession（或 read_transcript 重建 stdout）
  → 渲染 turns (normalizeTurns 去重)
  → listener 守卫 activeIdRef 更新 → 后续事件按新 id 路由
```

### 4.3 预览大窗

```
顶部「预览」按钮 (hasDraft=true 才可点)
  → setPreviewOpen(true)
  → PreviewDrawer (Sheet, w-[min(95vw,1400px)])
       ├─ 左: PreviewPanel (client→iframe srcDoc=previewSrcDoc(files); script→ScriptPreviewPanel)
       └─ 右: SourcePanel (Tabs 多文件切换 + pre)
```

### 4.4 上传/分享（不变）

`uploadCloud`（`PluginCreatorHome.tsx:373-393`）/ `submitMarketplace`（`:395-411`）路径完全不变：仍读 `currentDraft.files`/`manifest` 调 `/api/plugins/upload`。草稿双触发产出的 draft 与现有 `PluginDraft` 形态一致，上传契约不破坏（capabilities/RuntimeType 四值经 `normalizeCapabilities`/`normalizeEnum` 收敛，`plugin-draft.ts:238/266`）。

---

## 5. 组件文件拆分

### 5.1 新增

| 文件 | 职责 |
| --- | --- |
| `apps/desktop/src/components/creator/ConversationRail.tsx` | 会话栏（列表/新建/切换/删除/重命名/归档），w-64 固定 |
| `apps/desktop/src/components/creator/PreviewDrawer.tsx` | 全屏预览 Sheet（复用 PreviewPanel+SourcePanel） |

### 5.2 修改

| 文件 | 改动 |
| --- | --- |
| `apps/desktop/src/pages/PluginCreatorHome.tsx` | 引入 ConversationRail 三栏布局；删 `:275` systemPrompt 硬编码；改 `:185-251` finalizeSession 加 gate（§3.1.2）；listener 守卫 `:115/136/142/158/164` 改 activeIdRef；顶部按钮 `:445-450` 加「预览」；新增 `forceConvertToDraft`；草稿落盘 save_draft；切换会话读写 |
| `apps/desktop/src/components/creator/DetailsPanel.tsx` | 删 preview tab（`:52/60-63`）+ SourcePanel/PreviewPanel import（`:6-7`）；TabsList `:51` 改 grid-cols-3；props 删预览相关 |
| `apps/desktop/src/App.tsx` | `currentDraft` 单 useState（`:129`）保持，但增 `ConversationStore`（metas+activeId）——置于 `PluginCreatorHome` 内部 state 而非 App context（避免全局污染）；App 仅作为渲染容器 |
| `apps/desktop/src/lib/plugin-draft.ts` | 新增 `hasStructuredBlocks`/`makeConversationDraft`/`mergeConversationTurn` 纯函数；`ConversationMeta` 类型；`AssistantSessionRecord` 补 title/draftUpdatedAt/archived |
| `apps/desktop/src/components/chat/Bubble.tsx` | 增可选 `actions?: ReactNode` 渲染槽（最小扩展，主体不变） |
| `apps/desktop/src-tauri/src/code_assistant/store.rs` | `SessionRecord` 加三字段（`:56` 后）；`drafts_dir`/`draft_path`/`read_draft`/`write_draft`/`delete_session` 方法；`AssistantStore::new`（`:109-112`）建 drafts 目录 |
| `apps/desktop/src-tauri/src/code_assistant.rs` | 四命令函数 `rename_session`/`delete_session`/`save_draft`/`read_draft` + 四 Input 结构体 |
| `apps/desktop/src-tauri/src/main.rs` | 四 `#[tauri::command]` wrapper（`:150-156` 区）+ invoke_handler 注册（`:208` 后） |

### 5.3 不动

- `packages/contract`（本任务不改，见 implement.md §3）。
- `plugin-creator-protocol.ts`（保留 `PLUGIN_CREATOR_SYSTEM_PROMPT` 常量，不再每轮注入）。
- 上传契约 `/api/plugins/upload`、`.cmd` shim 解析、多轮 `--resume`、`ErrorBubble` 错误友好化。

---

## 6. 兼容迁移

### 6.1 旧 sessions.json 向后兼容

- `SessionRecord` 新三字段全 `Option` + `#[serde(default)]`（§3.2.1），旧 `sessions.json` 反序列化时字段缺失 → `None`，不报错。参照 `cli_session_id`（`store.rs:56-57`）已验证的兼容模式。
- 单测：写一个无 title 字段的 JSON → `read_json` → 确认 `title == None`（补 `store.rs:388-493` test 区）。

### 6.2 旧 title 懒回填

首启 `ConversationRail` 渲染时，对 `meta.title == None` 的项，从 `transcripts/{id}.jsonl` 首条 `event=input` 的 `payload.prompt` 截断 24 字作为显示标题（仅显示态，不强制落库；用户重命名时才 `rename_session` 落 title）。纯前端逻辑，放 `ConversationRail` 或 `plugin-draft.ts` 的 `deriveTitle(record, transcript)` 辅助函数。

### 6.3 singleton currentDraft 过渡

- `App.tsx:129` 的 `currentDraft` useState 保留为「当前活动会话的 draft 视图态」——切换会话时由 `read_draft` 覆盖。不删此 state（删了会破坏 Plugins 页对 draft 的依赖路径），但语义从「全局唯一草稿」收敛为「active 会话草稿」。
- 旧 localStorage 中无多会话概念的单草稿（若有）不迁移——多会话以 Rust `sessions.json` 为权威源，前端 `currentDraft` 仅作运行态视图。

### 6.4 既有命令契约不破坏

- `start_session`/`send_input`/`stop_session`/`read_transcript`/`list_sessions` 签名不变（仅 `SessionRecord` 加可选字段，前端老调用不感知）。
- `.cmd` shim 解析、`--resume`、`ErrorBubble` 路径完全不动。

---

## 7. 安全风险

> 本项目安全优先级最低（见全局准则），仅记录客观风险点供决策，不作为验收条件。

- **draft 注入面**：`write_draft` 接收前端任意 JSON 字符串落盘 `drafts/{id}.json`。若后续有读回执行路径需防恶意 manifest。当前 `read_draft` 仅前端 `JSON.parse` 渲染，无执行，风险低。
- **路径穿越**：`draft_path` 用 `session_id` 拼接，若 `session_id` 含 `../` 可越界。`new_session_id`（`code_assistant.rs:283`）由后端生成受控 id，前端不传 id，无注入面。保留现状即可。
- **多会话隔离**：每会话独立 `cli_session_id` + 独立 transcript，会话间无共享上下文。切换不保持常驻进程（无状态续接），无进程泄露风险。

---

## 8. 验证策略

### 8.1 Rust 单测（cargo test）

`store.rs:388-493` test 区追加：

- `draft_roundtrip`：`write_draft(s1, json)` → `read_draft(s1)` 内容一致；`read_draft(不存在)` 返回 `None`。
- `delete_session_removes_all`：upsert record + write transcript + write draft → `delete_session` → 三者全删。
- `session_record_new_fields_default_none`：无 title JSON 反序列化 → `title/draft_updated_at/archived` 均 `None`。
- `rename_session_persists_title`：`rename_session` → `list_sessions` 取回 title + draft_updated_at 非空。

命令：`cd apps/desktop/src-tauri && cargo test`。

### 8.2 前端单测（pnpm test）

`plugin-draft.ts` 新增纯函数单测：

- `hasStructuredBlocks`：纯文本 → false；含 ```` ```manifest ```` → true；含 ```` ```file path="x" ```` → true；只有 ```` ```js ```` unknown 块 → false（gate 严格只认 manifest/file）。
- `makeConversationDraft`：产 `turns=[u,a]`、`files=[]`、`status='generating'`。
- `mergeConversationTurn`：在既有 draft 上追加 turn、`normalizeTurns` 去重。

命令：`pnpm --filter desktop test`（或项目根 test 脚本）。

### 8.3 类型与构建

- `pnpm --filter desktop typecheck`（新增类型无 TS 报错）。
- `pnpm --filter desktop build`（构建产物含新组件）。
- `cd apps/desktop/src-tauri && cargo build`（命令注册无编译错误）。

### 8.4 手动验收（对应 PRD AC）

- AC1：发「你好」→ 纯对话回复、不弹详情、不判 invalid、无 schema 诊断。
- AC2：新建/切换/删除/重命名；切换后历史与草稿恢复；多会话 cli_session_id 独立（查 transcripts/{id}.jsonl 不串）。
- AC3：「做个番茄钟插件」→ AI 产 manifest 块 → 自动草稿 → 预览按钮可点。
- AC4：预览按钮 → 全屏 Sheet（client iframe / node-python 终端）多文件可切；无草稿时 disabled。
- AC5：详情面板无 preview tab、无固定源码展示。
- AC6：纯对话下「✨ 转为插件草稿」→ 强制产 draft。
- AC7：上传契约 + claude `--resume` + `.cmd` shim + ErrorBubble 不回归。
- AC8：`cargo test` + `pnpm typecheck/test` + `pnpm build` 全绿；旧 `sessions.json` 可读。

---

## 9. 备注

- 设计依据见研究结论（AionUi 四机制 + 当前架构硬编码点 + 多会话方案），会话上下文与 `.claude/operations-log.md` 留痕。
- 行号引用基于 main 分支当前实现；实施中若行号漂移以函数名/符号名为准。
- 执行顺序、Review Gate、回滚点见 `implement.md`。
