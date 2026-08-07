# 执行计划：对话优先重构与多会话管理

> 配套 `design.md`。四阶段渐进式 checklist，每步含「改什么 + 验证命令 + 通过标准」。所有改动简体中文注释，文件操作用专用工具，前端 pnpm，Rust cargo。行号基于 main 当前实现（design.md §2 核对）。

---

## 1. 前置依赖

- 已具备：Rust 多会话基座（`store.rs` SessionRecord/Vec + cli_session_id）、`parseStructuredPackage`/`extractFencedBlocks`/`previewSrcDoc`/`sheet.tsx`/`Bubble`/`normalizeTurns` 全部可复用。
- 不改：`packages/contract`（本任务零契约改动）、上传契约、`.cmd` shim、`--resume`、`ErrorBubble`。
- 环境：Windows + PowerShell 7，pnpm 包管理，cargo（apps/desktop/src-tauri）。

---

## 2. 四阶段有序 Checklist

### 阶段 1：Rust 多会话 CRUD + 字段 + 单测

**目标**：后端先就位 `SessionRecord` 三字段 + draft 分文件 + 四 CRUD 命令，前端未接也能 cargo test 通过。

#### 1.1 SessionRecord 加三字段

- 改 `apps/desktop/src-tauri/src/code_assistant/store.rs:34-58`：`cli_session_id`（`:56-57`）后追加 `title: Option<String>` / `archived: Option<bool>` / `draft_updated_at: Option<String>`，均 `#[serde(default, alias = "...", rename = "...")]`（design.md §3.2.1）。
- 验证：`cd apps/desktop/src-tauri && cargo build`。通过标准：编译无错（新字段 default None 不破坏现有 `upsert_session` `:220-232` 等所有构造 SessionRecord 处）。
- 同步改 test 区（`:388-493`）现有两个 `upsert_session(SessionRecord{...})` 构造（`:441/470`）补 `title: None, archived: None, draft_updated_at: None` 三字段，否则编译错。

#### 1.2 store 新增 draft 存取 + delete

- 改 `store.rs`：
  - `AssistantStore::new`（`:109-112`）：`fs::create_dir_all(root.join("transcripts"))` 后补 `fs::create_dir_all(root.join("drafts"))`。
  - 紧邻 `transcript_path`（`:202-206`）/`read_transcript`（`:294-296`）新增：`drafts_dir(&self) -> PathBuf`、`draft_path(&self, session_id: &str) -> PathBuf`、`read_draft(&self, session_id) -> Result<Option<String>, String>`、`write_draft(&self, session_id, raw) -> Result<(), String>`、`delete_session(&self, session_id) -> Result<(), String>`（design.md §3.2.2）。
  - `delete_session`：复用 `list_sessions`+`retain`+`write_json`（同 `:220-232` 模式）+ `fs::remove_file(transcript_path)` + `fs::remove_file(draft_path)`（忽略「不存在」错误）。
- 验证：`cargo build`。通过标准：编译无错，方法签名符合设计。

#### 1.3 命令层 + Input 结构体

- 改 `apps/desktop/src-tauri/src/code_assistant.rs`：
  - 紧邻 `read_transcript`（`:555`）新增 `RenameSessionInput`/`DeleteSessionInput`/`SaveDraftInput`/`ReadDraftInput` 结构体（design.md §3.2.3）。
  - 新增 `rename_session(state, input) -> Result<SessionRecord, String>`、`delete_session(state, input) -> Result<(), String>`、`save_draft(state, input) -> Result<(), String>`、`read_draft(state, input) -> Result<Option<String>, String>`。`save_draft`/`rename_session` 内同步 `upsert_session` 回写 `draft_updated_at = now_string()`（`store.rs:299`）。
- 验证：`cargo build`。通过标准：编译无错。

#### 1.4 main.rs 注册

- 改 `apps/desktop/src-tauri/src/main.rs`：
  - `:150-156` 区（紧邻 `code_assistant_read_transcript` wrapper）追加四个 `#[tauri::command]` wrapper（`code_assistant_rename_session`/`_delete_session`/`_save_draft`/`_read_draft`），签名参照 `:151-156`（`state: tauri::State<...>, input: ...`）。
  - `invoke_handler`（`:195-211`）在 `:208` `code_assistant_read_transcript` 后、`:209` `plugin_script::probe_script_runtime` 前注册四命令。
- 验证：`cd apps/desktop/src-tauri && cargo test`。通过标准：全部 test 绿 + 构建无错。

#### 1.5 Rust 单测

- 改 `store.rs:388-493` test 区追加（design.md §8.1）：
  - `draft_roundtrip`：write_draft → read_draft 一致；read_draft 不存在返回 None。
  - `delete_session_removes_all`：upsert + transcript + draft → delete_session → list_sessions 不含 + 两文件已删。
  - `session_record_new_fields_default_none`：手写无 title JSON → `serde_json::from_str::<SessionRecord>` → 三字段 None。
  - `rename_session_persists_title`：rename_session → list_sessions 取回 title + draft_updated_at 非空。
- 验证：`cargo test`。通过标准：4 个新测 + 现有 4 测全绿。

**阶段 1 Review Gate**：`cargo test` 全绿 + `cargo build` 无 warning。未过不进阶段 2。

---

### 阶段 2：前端会话管理（会话栏 + activeId + draft 读写）

**目标**：先接入多会话数据层与 UI，对话/预览逻辑暂沿用旧 finalizeSession（仍每轮结构化），确保会话切换/草稿落盘可用。

#### 2.1 前端类型

- 改 `apps/desktop/src/lib/plugin-draft.ts`：
  - `AssistantSessionRecord`（`:40-52`）补 `title?: string | null` / `draftUpdatedAt?: string | null` / `archived?: boolean | null`。
  - 紧邻 `AssistantSessionRecord` 新增 `ConversationMeta`/`Conversation` 类型（design.md §3.2.4）。
  - 新增 `deriveTitle(meta, transcriptRaw?) -> string`（design.md §6.2，title None 时从 transcript 首 input prompt 截断 24 字）。
- 验证：`pnpm --filter desktop typecheck`。通过标准：无 TS 报错。

#### 2.2 ConversationRail 组件

- 新增 `apps/desktop/src/components/creator/ConversationRail.tsx`（design.md §3.2.5）：
  - props：`metas: ConversationMeta[]` / `activeId: string | null` / `onSelect(id)` / `onNew()` / `onRename(id, title)` / `onDelete(id)`。
  - 列表项 title + tool Badge + draftUpdatedAt 相对时间 + 右键菜单（重命名/删除/归档）。
  - 排序 `draftUpdatedAt ?? startedAt` 降序。
- 验证：`pnpm --filter desktop typecheck`。通过标准：组件编译通过。

#### 2.3 PluginCreatorHome 接入多会话

- 改 `apps/desktop/src/pages/PluginCreatorHome.tsx`：
  - 新增 `metas`/`activeId`/`activeIdRef` state（替换单值 `assistantSessionIdRef` 的路由职责，`:59` 保留作事件路由源，但指向 activeIdRef）。
  - `useEffect` 挂载时 `tauriInvoke<ConversationMeta[]>('code_assistant_list_sessions')` 一次拉取填充 metas；从 `localStorage.getItem('lf:active-conversation:' + tenantId)` 恢复 activeId。
  - `session-started` listener（`:114-132`）：新 record 推入 metas、setActiveId、写 localStorage。
  - listener 守卫 `:115/136/142/158/164` 五处：`payload.sessionId !== assistantSessionIdRef.current` → `!== activeIdRef.current`。
  - 三栏布局：`<ConversationRail ... />` + 原主体（design.md §3.2.5）。`App.tsx:272` `<PluginCreatorHome />` 渲染不变（ConversationRail 在 PluginCreatorHome 内部）。
  - 切换会话 `onSelect(id)`：当前有未落盘 draft 先 `save_draft` → setActiveId + 写 localStorage → `read_draft(id)` → `JSON.parse` → `setCurrentDraft` → 从 metas record 重建 `assistantSession`。
  - 删除 `onDelete(id)`：`tauriInvoke('code_assistant_delete_session', { input: { sessionId: id } })` → metas.retain → 若删 activeId 切首项或空态。
  - 重命名 `onRename(id, title)`：`tauriInvoke('code_assistant_rename_session', { input: { sessionId: id, title } })` → 更新 metas。
- 验证：`pnpm --filter desktop typecheck`。通过标准：无 TS 报错。
- 手动验证：启动桌面壳（`pnpm --filter desktop dev` 或 tauri dev），发两条独立对话 → 会话栏出现两项 → 切换 → 历史恢复 → 删除 → 重命名。通过标准：AC2 多会话基本流转（cli_session_id 独立可查 transcripts）。

#### 2.4 草稿落盘

- 改 `PluginCreatorHome.tsx:185-251` `finalizeSession`：末尾 `setCurrentDraft(merged/draft)` 之后追加 `tauriInvoke('code_assistant_save_draft', { input: { sessionId: activeId, draftJson: JSON.stringify(nextDraft) } })` + 更新 `metas` 对应项 `draftUpdatedAt`。
- 验证：`pnpm --filter desktop typecheck`。通过标准：无 TS 报错。
- 手动验证：发消息 → 检查 `drafts/{sessionId}.json` 已生成。通过标准：草稿落盘可见。

**阶段 2 Review Gate**：typecheck 绿 + 手动多会话切换/删除/重命名/草稿恢复可用 + `pnpm --filter desktop build` 成功。未过不进阶段 3。

---

### 阶段 3：对话优先（通用 systemPrompt + finalizeSession gate + 双触发）

**目标**：解耦「对话」与「插件创建」，「你好」不再 invalid。

#### 3.1 plugin-draft 纯函数

- 改 `apps/desktop/src/lib/plugin-draft.ts`：
  - 新增 `hasStructuredBlocks(rawText: string): boolean`（复用 `extractFencedBlocks` `:296-351`，some kind==='manifest'||'file'）。
  - 新增 `makeConversationDraft(userPrompt, assistantOutput): PluginDraft`（turns=[u,a]，files=[]，status='generating'）。
  - 新增 `mergeConversationTurn(prev, userPrompt, assistantOutput): PluginDraft`（normalizeTurns 累加）。
- 验证：`pnpm --filter desktop test`（新增单测，design.md §8.2）。通过标准：
  - `hasStructuredBlocks`：纯文本 false / manifest 块 true / file 块 true / 仅 unknown js 块 false。
  - `makeConversationDraft` 产 turns + files=[] + status='generating'。
  - `mergeConversationTurn` 累加去重。

#### 3.2 删 systemPrompt 硬编码

- 改 `PluginCreatorHome.tsx:275`：`startNewSession` 内删 `const systemPrompt = PLUGIN_CREATOR_SYSTEM_PROMPT;` 及 `input.systemPrompt` 传参（让 `code_assistant.rs:284-287` 走裸 prompt 分支）。
- 删 `:6` `PLUGIN_CREATOR_SYSTEM_PROMPT` import（保留 `plugin-creator-protocol.ts` 常量本身不删，供后续手动触发可选复用）。
- 验证：`pnpm --filter desktop typecheck`。通过标准：无未用 import 警告。

#### 3.3 finalizeSession gate

- 改 `PluginCreatorHome.tsx:185-251`（design.md §3.1.2）：
  - `:188-192` 保留 transcript 解析。
  - gate：`const structured = hasStructuredBlocks(stdout)`（stdout 来自 `transcriptText(events, 'stdout')` `:190`）。
  - `!structured` 分支：首轮 `makeConversationDraft`/追问 `mergeConversationTurn`，`setCurrentDraft`，**删 `:231` setDetailsOpen(true)**。
  - `structured` 分支：保留 `buildLocalDraft`（`:221-227`）/`mergeFollowupDraft`（`:217`），`setDetailsOpen(true)` 仅此分支保留。
  - toast `:232-238`：纯对话态（status='generating'）走「已完成对话」语义，不走 invalid 文案。
- 验证：`pnpm --filter desktop typecheck && pnpm --filter desktop test`。通过标准：typecheck 绿 + test 绿。
- 手动验证：发「你好」→ 纯对话回复、不弹详情、无 schema 诊断、无 invalid Badge（AC1）。发「做个番茄钟插件」→ manifest 块 → 自动草稿、详情点亮、预览可点（AC3）。

#### 3.4 手动「转为插件草稿」按钮

- 改 `apps/desktop/src/components/chat/Bubble.tsx:4`：增可选 `actions?: ReactNode`，渲染在 `Markdown`/content 下方（最小扩展，主体不变）。
- 改 `PluginCreatorHome.tsx`：
  - 新增 `forceConvertToDraft(sessionId)`：取当前活动会话最近一轮 assistant stdout（`assistantSession.stdout` 或 read_transcript），强制 `buildLocalDraft`/`mergeFollowupDraft`，即使 `hasStructuredBlocks=false` 也解析。
  - `:467` `turns.map` 的 assistant Bubble 传 `actions`：仅当 `currentDraft` 为纯对话态（files 空）时渲染「✨ 转为插件草稿」按钮，点击 `forceConvertToDraft`。
- 验证：`pnpm --filter desktop typecheck`。通过标准：无 TS 报错。
- 手动验证：纯对话后点按钮 → 强制产 draft → 预览按钮点亮（AC6）。

**阶段 3 Review Gate**：typecheck + test 绿 + AC1/AC3/AC6 手动通过 + `pnpm --filter desktop build` 成功。未过不进阶段 4。

---

### 阶段 4：预览大窗（删 tab + 顶部按钮 + 全屏 Sheet）

**目标**：预览独立大窗，删右侧固定预览/源码。

#### 4.1 删 DetailsPanel preview tab

- 改 `apps/desktop/src/components/creator/DetailsPanel.tsx`（design.md §3.3.1）：
  - 删 `:6-7` `PreviewPanel`/`SourcePanel` import。
  - `:51` `TabsList` `grid-cols-4` → `grid-cols-3`。
  - 删 `:52` `preview` TabsTrigger + `:60-63` `preview` TabsContent。
  - props 删 `files`/`activeFile`/`activeContent`/`previewKey`/`onActiveFileChange`/`onRefreshPreview`（`:18/26/27/23/22/25`）。
- 改 `PluginCreatorHome.tsx:510-526` `<DetailsPanel .../>` 调用：删上述预览 props 透传，仅留 status/diagnostics/assistantSession/cloudPlugin/uploading/submitting/onUpload/onSubmitMarketplace/onRun。
- 验证：`pnpm --filter desktop typecheck`。通过标准：无 TS 报错、无未用 prop。

#### 4.2 PreviewDrawer 组件

- 新增 `apps/desktop/src/components/creator/PreviewDrawer.tsx`（design.md §3.3.3）：
  - 复用 `Sheet`/`SheetContent`/`SheetHeader`/`SheetTitle`（`sheet.tsx`）+ `PreviewPanel`/`SourcePanel`。
  - `SheetContent side="right" className="w-[min(95vw,1400px)] max-w-none p-0 flex flex-col"`（覆盖 `sheetVariants.right` `w-[min(92vw,640px)]`，sheet.tsx:37）。
  - 内部 `grid-cols-[minmax(0,1fr)_minmax(280px,40%)]`：左 PreviewPanel、右 SourcePanel。
  - SourcePanel 的 `activeFile`/`onActiveFileChange`/`activeContent`/`previewKey`/`onRefreshPreview` props 透传（与原 DetailsPanel preview tab 同款，design.md §3.3.3）。
- 验证：`pnpm --filter desktop typecheck`。通过标准：组件编译通过。

#### 4.3 顶部「预览」按钮 + 接入 Drawer

- 改 `PluginCreatorHome.tsx`：
  - 新增 state `previewOpen: boolean`（`useState(false)`）。
  - `:445-450` 顶部按钮组：保留「新对话」「详情」，新增「预览」按钮 `disabled={!hasDraft}`（`hasDraft = Boolean(currentDraft?.files.length)`），disabled 时 `title="无草稿可预览"` tooltip，点击 `setPreviewOpen(true)`。
  - 组件树末尾（`:528` aside 后）渲染 `<PreviewDrawer open={previewOpen} onOpenChange={setPreviewOpen} files={files} activeFile={activeFile} activeContent={activeContent} previewKey={previewKey} onActiveFileChange={setActiveFile} onRefreshPreview={() => setPreviewKey(k => k+1)} />`。
- 验证：`pnpm --filter desktop typecheck && pnpm --filter desktop build`。通过标准：构建成功。
- 手动验证：有草稿时点「预览」→ 全屏 Sheet（client iframe / node-python 终端）多文件可切；无草稿时 disabled（AC4）。详情面板无 preview tab、无固定源码（AC5）。

**阶段 4 Review Gate**：typecheck + build 绿 + AC4/AC5 手动通过。

---

## 3. 契约顺序（packages/contract 不改）

本任务**零契约改动**：

- `RuntimeType` 四值（client/nodejs/python/cloud）保持，前端 `FRONTEND_RUNTIME_TYPES`（`plugin-draft.ts:259`）镜像不变。
- `CapabilityKind` 白名单不变，`normalizeCapabilities`（`plugin-draft.ts:238`）收敛逻辑不动。
- 上传契约 `/api/plugins/upload`（`PluginCreatorHome.tsx:373-393`）签名、body（manifest + files）不动。
- Rust `SessionRecord` 仅加可选字段（`#[serde(default)]`），现有 `start_session`/`send_input`/`list_sessions` 命令签名不变，前端老调用兼容。

若实施中发现契约确需改（如草稿落盘需要新 DTO），**必须暂停并提 PRD 变更**，不得在本任务内私自扩 packages/contract。

---

## 4. Review Gate（每阶段强制）

| 阶段 | Gate 命令                                                                                                | 通过标准                      | 未过处理     |
| ---- | -------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------ |
| 1    | `cd apps/desktop/src-tauri && cargo test`                                                                | 全测绿 + 无 warning           | 修到绿才进 2 |
| 2    | `pnpm --filter desktop typecheck && pnpm --filter desktop build` + 手动多会话                            | typecheck/build 绿 + AC2 手动 | 修到过才进 3 |
| 3    | `pnpm --filter desktop typecheck && pnpm --filter desktop test && pnpm --filter desktop build` + AC1/3/6 | 全绿 + 手动通过               | 修到过才进 4 |
| 4    | `pnpm --filter desktop typecheck && pnpm --filter desktop build` + AC4/5                                 | 全绿 + 手动通过               | 修到过才收尾 |

最终收尾：全量 `cargo test` + `pnpm --filter desktop typecheck/test/build` + 旧 `sessions.json` 可读（AC8）。

---

## 5. 回滚点

- **阶段 1 回滚**：`SessionRecord` 三字段 + 四命令是纯增量（default None / 新命令），回滚 = revert store.rs/code_assistant.rs/main.rs 阶段 1 commit，前端未接无影响。
- **阶段 2 回滚**：多会话 UI 是增量（ConversationRail 新组件 + PluginCreatorHome 接入），回滚 = revert 阶段 2 commit，单会话态恢复（currentDraft 单 useState 语义不变）。
- **阶段 3 回滚**：gate 逻辑是 `finalizeSession` 分支扩展 + Bubble 加可选槽。回滚 = revert 阶段 3 commit，回到无条件 buildLocalDraft（systemPrompt 硬编码恢复）。
- **阶段 4 回滚**：DetailsPanel 删 tab + PreviewDrawer 新增。回滚 = revert 阶段 4 commit，preview tab 恢复。

每阶段独立 commit，互不交叉，支持按阶段单独回滚。回滚命令：`git revert <阶段commit>`（不 force push，保留历史可追溯）。

---

## 6. 产出物清单

### 代码

- 新增：`apps/desktop/src/components/creator/ConversationRail.tsx`、`apps/desktop/src/components/creator/PreviewDrawer.tsx`。
- 修改：`apps/desktop/src/pages/PluginCreatorHome.tsx`、`apps/desktop/src/components/creator/DetailsPanel.tsx`、`apps/desktop/src/components/chat/Bubble.tsx`、`apps/desktop/src/lib/plugin-draft.ts`、`apps/desktop/src-tauri/src/code_assistant/store.rs`、`apps/desktop/src-tauri/src/code_assistant.rs`、`apps/desktop/src-tauri/src/main.rs`。
- 不动：`apps/desktop/src/App.tsx`（currentDraft 单 useState 语义保留为 active 会话视图态）、`packages/contract`、`plugin-creator-protocol.ts`、上传/分享/`.cmd` shim/`--resume`/ErrorBubble 路径。

### 测试

- Rust 单测（`store.rs` test 区）：`draft_roundtrip`、`delete_session_removes_all`、`session_record_new_fields_default_none`、`rename_session_persists_title`。
- 前端单测（`plugin-draft.ts` 测）：`hasStructuredBlocks`、`makeConversationDraft`、`mergeConversationTurn`。

### 验证记录

- `.claude/operations-log.md`：每阶段编码前后检查（复用组件清单 / 命名约定 / 不重复造轮子声明）。
- `.claude/verification-report.md`：四阶段 Gate 命令输出 + AC1-AC8 手动结果 + 综合评分（≥90 通过）。

### PRD AC 映射

| AC                | 阶段   | 验证                                                      |
| ----------------- | ------ | --------------------------------------------------------- |
| AC1「你好」纯对话 | 阶段 3 | 手动 + test hasStructuredBlocks                           |
| AC2 多会话        | 阶段 2 | 手动切换/删除/重命名 + cargo test delete_session          |
| AC3 自动检测草稿  | 阶段 3 | 手动番茄钟                                                |
| AC4 预览大窗      | 阶段 4 | 手动 Sheet 多文件                                         |
| AC5 删固定源码    | 阶段 4 | 手动详情面板无 preview tab                                |
| AC6 手动转草稿    | 阶段 3 | 手动按钮                                                  |
| AC7 既有不回归    | 全程   | 上传/`--resume`/shim/ErrorBubble 手动冒烟                 |
| AC8 本地验证全绿  | 收尾   | cargo test + pnpm typecheck/test/build + 旧 sessions.json |
