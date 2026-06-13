# 对话式多轮创建流程 — 执行计划（implement.md）

> 设计依据：同目录 `design.md`。本计划按 contract-first 与复用优先原则，先 Rust 后端 → 前端 → 回归，每步可独立验证。

---

## 1. 前置条件与依赖

### 1.1 依赖的子任务

- **`06-13-structured-output-parsing`（R2）**：多轮追问的草稿迭代（`mergeFollowupDraft` 的 files 覆盖）依赖 R2 的 `parseStructuredPackage` / 结构化协议。**实现顺序上 R2 的协议与解析可先行**；但本任务的多轮**管线打通**（send_input 解锁、turns 累积）**不阻塞于 R2**——`mergeFollowupDraft` 中 `parseStructuredPackage(output).files ?? prev.files` 的兜底语义保证 R2 未就绪时追问仍可累积 turns、保留上轮 files。
- **`06-13-node-python-local-exec`（R3）**：**无依赖**。本任务不触碰 RuntimeType 契约。
- **`06-13-output-rendering-polish`（R4）/ `06-13-styling-and-error-polish`（R5）**：**无依赖，可并行**。错误友好展示（R5）会增强本任务的 `handleMultiturnError` 观感，但 Bubble error（`Bubble.tsx:9`）已可用作基线。

### 1.2 环境与工具

- Rust：`cargo`（`apps/desktop/src-tauri`），Windows 下 `cargo test`。
- 前端：`pnpm`（`apps/desktop`），`pnpm typecheck` / `pnpm test`。
- 真实 CLI：本机需至少装一个 claude（验证真多轮）+ codex 或 opencode（验证降级）。
- 文件操作全部用 Read/Write/Edit/Glob/Grep，禁 Shell。

### 1.3 前置检查（开工前）

- [ ] 确认 `code_assistant.rs:397-407`（send_input 拒绝）、`:274-395`（start_session）、`:574-625`（spawn_reader）、`:550-572`（extract_stream_json_text）、`:663-707`（spawn_waiter）行号未漂移。
- [ ] 确认 `adapters/mod.rs:40`（build_args 签名）、`claude.rs:17-30`、`codex.rs:24-30`、`opencode.rs:17-23` 行号未漂移。
- [ ] 确认 `store.rs:33-54`（SessionRecord）、`:249-268`（append_transcript）行号未漂移。
- [ ] 确认 `PluginCreatorHome.tsx:226-277`（send）、`:163-216`（finalizeSession）、`:236`（setCurrentDraft(null)）行号未漂移。
- [ ] 确认 `plugin-draft.ts:232-235`（turns 硬编码）、`:245-253`（normalizeTurns）行号未漂移。
- [ ] `cargo test` / `pnpm typecheck` 在改动前基线全绿（建立回滚参照）。

---

## 2. 有序执行 checklist

> 每步标注：**改什么** + **验证命令** + **通过标准**。严格自上而下，前步未绿不进下一步。

### Step 1 — 适配器 build_args 扩 resume 入参（Rust）

- **改**：
  - `adapters/mod.rs:40` 签名 `fn(prompt, model, resume_id: Option<&str>)`；`probe_args`/`run_args`（`:44-50`）补 `resume_id` 透传。
  - `claude.rs:17-30`：resume_id 非空时 append `--resume <id>`。
  - `codex.rs:24-30` / `opencode.rs:17-23`：接收 resume_id 但忽略（签名对齐）。
  - 同步 `code_assistant.rs:477`（run_once probe_args）、`:288`（start_session run_args）调用点补 `None`（首轮）。
- **验证**：`cd apps/desktop/src-tauri && cargo test adapters`
- **通过**：既有 3 个 probe 测试（`mod.rs:74-98`）绿 + 新增 `claude_resume_appends_resume_arg` 绿。

### Step 2 — SessionRecord 增 cli_session_id + setter（Rust store）

- **改**：
  - `store.rs:33-54`：`SessionRecord` 增 `#[serde(default, alias="cliSessionId", rename="cliSessionId")] pub cli_session_id: Option<String>`。
  - 新增 `AssistantStore::set_cli_session_id(&self, session_id, cli_id) -> Result<(),String>`（模式同 `update_session_exit` `:230-247`）。
  - `code_assistant.rs:343-355`：`start_session` 构造 `SessionRecord` 时 `cli_session_id: None`（首轮未知）。
- **验证**：`cd apps/desktop/src-tauri && cargo test store`
- **通过**：`config_roundtrip` / `registry_*`（`store.rs:377-408`）绿 + 新增 `cli_session_id_roundtrip` 绿（写 sessions → set → 读出字段）。

### Step 3 — 捕获 claude session id（Rust spawn_reader 旁路）

- **改**：
  - `code_assistant.rs` 新增 `extract_stream_json_session_id(line) -> Option<String>`（认 `system`/`result` 行的 `session_id`，紧邻 `extract_stream_json_text:550-572`）。
  - `spawn_reader`（`:574-625`）`Ok(_)` 分支：StreamJson 时先调 `extract_stream_json_session_id`，非空且未设过 → `state.store.set_cli_session_id` + emit `code-assistant://session-cli-id`（payload `{ sessionId, cliSessionId }`）。用 `Arc<AtomicBool>` 闭包标志「只设一次」。
  - 文本提取逻辑（`:591-597`）保持不动。
- **验证**：`cd apps/desktop/src-tauri && cargo test extract_stream_json`
- **通过**：新增 `session_id_from_system_line` / `session_id_from_result_line` / `assistant_line_returns_none` 绿。

### Step 4 — build_history_summary + 截断（Rust 伪多轮数据源）

- **改**：
  - `code_assistant.rs` 新增 `build_history_summary(store, session_id) -> Result<String,String>`（读 transcript，拼 `【用户】/【AI】`，截断到 12k）+ `truncate_history(s, max)`（复用 `tail:850-857` 字符截断模式）。
- **验证**：`cd apps/desktop/src-tauri && cargo test history_summary`
- **通过**：`summary_includes_user_and_ai` + `summary_truncates_when_too_long` 绿。

### Step 5 — 重写 send_input 为真续接 + 抽取 spawn_followup_run（Rust 核心）

- **改**：
  - 抽取 `start_session:305-395` 的 spawn+register+reader+waiter 公共段为 `spawn_followup_run(app, state, session, command, args, workspace_dir)`，`start_session` 与 `send_input` 共用。
  - `code_assistant.rs:397-407` 重写 `send_input`（见 design 3.3.4）：查 session → 写 `input` transcript（`kind:followup`）→ claude 用 `cli_session_id` resume / 其他用历史摘要 → `spawn_followup_run`。
  - 签名改为 `send_input<E: AssistantEventSink>(app: E, state: &CodeAssistantState, input: SendInputInput)`（需 app 发事件）。
  - `main.rs:124-130` `code_assistant_send_input` 命令补 `app: AppHandle` 参数透传（参照 `code_assistant_start_session:101-121`）。
- **验证**：
  - `cd apps/desktop/src-tauri && cargo build`（编译通过）
  - `cd apps/desktop/src-tauri && cargo test code_assistant`（既有全绿）
- **通过**：编译通过 + 既有测试不回归。

### Step 6 — codex resume 探针（可选增强，不阻塞）

- **做**：手动跑 `codex resume <id> --include-non-interactive` 验证非交互续接是否可行（用 Step 5 产生的真实 session id）。
- **判定**：
  - 可行且稳定 → codex 提升为 `native`：`codex.rs` 实现真正 resume（仿 claude，但走 `resume` 子命令而非 `--resume` flag），`build_history_summary` 仅作 fallback。
  - 不可行/不稳 → 保持 `degraded`（历史摘要），记录到 operations-log。
- **验证**：手动探针 + transcript 比对（真续接应记住首轮上下文）。
- **通过**：探针结论写入 operations-log；无论结果，主线（claude 真 + codex/opencode 伪）已可用。

### Step 7 — 前端：监听 cli id + 多轮运行态

- **改** `PluginCreatorHome.tsx`：
  - `:52-62` 增 `cliSessionId` / `multiturnMode` state。
  - `:97-161` 的 `attach()` 增 listener `code-assistant://session-cli-id` → `setCliSessionId` + `setMultiturnMode('native')`；首轮 exit 时若无 cliSessionId 且 tool≠claude → `setMultiturnMode('degraded')`。
  - `plugin-draft.ts` 增 `SessionCliIdPayload` 类型（`plugin-draft.ts:69-92` 类型区）。
- **验证**：`cd apps/desktop && pnpm typecheck`
- **通过**：typecheck 无错。

### Step 8 — 前端：send() 分流首问/追问 + 移除清空

- **改** `PluginCreatorHome.tsx:226-277` `send()`：
  - 删除 `:236` `setCurrentDraft(null)`。
  - 增 `firstRoundDone` 判断（有 activeId 且非 running）→ 走 `code_assistant_send_input`；否则走 `startNewSession`（抽原 start 逻辑为函数）。
  - 追问 stage 文案按 `multiturnMode` 区分（native vs degraded）。
- **验证**：`cd apps/desktop && pnpm typecheck`
- **通过**：typecheck 无错。

### Step 9 — 前端：finalizeSession 累积 + finally 不清 id

- **改** `PluginCreatorHome.tsx:163-216` `finalizeSession`：
  - 首轮 vs 追问分支：首轮 `setCurrentDraft(buildLocalDraft(...))`；追问 `setCurrentDraft(mergeFollowupDraft(prevDraft, result, prompt))`。
  - `:210-215` finally：仅 `setStreaming(false)` + 清 `liveStage`；**保留** `assistantSessionIdRef.current`（追问需用）。
  - 降级提示：追问且 `multiturnMode==='degraded'` 时，在追问 user Bubble 后插一行 muted 文案（或并入 Bubble content 前缀）。
- **改** `plugin-draft.ts`：
  - 新增 `mergeFollowupDraft(prev, result, prompt)`（design 3.3.6 (e)）。
  - `buildLocalDraft:232-235` turns 逻辑保持（首轮 [u1,a1]）。
- **验证**：
  - `cd apps/desktop && pnpm typecheck && pnpm test -- plugin-draft`
- **通过**：typecheck 无错 + 新增 `mergeFollowupDraft` spec 绿（turns +2、files 覆盖、空输出去重）。

### Step 10 — 前端：多轮错误处理

- **改** `PluginCreatorHome.tsx`：
  - 新增 `handleMultiturnError(error)`：按 message 分类（会话已退出 / CLI 不可用 / cli_session_id 缺失）→ `setLiveError` + `Bubble error`（复用 `Bubble.tsx:9`）+ 必要时引导 `newDraft`。
  - `send()` 追问 catch 调用它。
- **验证**：`cd apps/desktop && pnpm typecheck && pnpm test -- PluginCreator`
- **通过**：typecheck 无错 + `send` 分流 spec 绿（mock invoke 断言调对命令）。

### Step 11 — 端到端真实 CLI 验证

- **做**（手动，`cd apps/desktop && pnpm tauri dev`）：
  1. **claude 真多轮**：首轮「做一个番茄钟」→ 等 exit → 追问「把按钮改成红色」→ 断言 turns 累积、files 被迭代、无降级提示、`cliSessionId` 已捕获。
  2. **codex/opencode 降级**：同样两轮 → 断言出现降级提示文案、追问产出基于历史。
  3. **失败路径**：删 sessions.json 的 cli_session_id → claude 追问 → 断言降级提示 + 可用伪多轮；invoke 不存在 sessionId → 断言「对话已结束」Bubble。
- **通过**：三条路径均符合 design 第 7.3 节断言。

### Step 12 — 全量回归

- **命令**：
  - `cd apps/desktop/src-tauri && cargo test`
  - `cd apps/desktop && pnpm typecheck && pnpm test`
- **通过**：全绿；首轮单轮流程行为不变（无追问时与改造前一致）。

---

## 3. 契约变更顺序

**本任务不涉及 `packages/contract` 变更**（RuntimeType 四值扩展属 R3 / `node-python-local-exec`，capabilities 修正属 R2 / `structured-output-parsing`）。

本任务仅变更桌面壳本地态：
1. Rust 内部接口 `build_args` 签名（内部，无外部消费者）。
2. `SessionRecord.cli_session_id`（本地 `sessions.json` 落盘，`#[serde(default)]` 向后兼容）。
3. `send_input` transcript event `input-rejected` → `input`（kind=followup）。
4. 前端 `send_input` invoke 入参结构不变（`{ sessionId, input }`）。

故无需执行 contract-first 的「contract → typecheck → 后端 → migrate → 前端」全链路；仅遵循「Rust → typecheck → 前端 → 回归」的桌面壳内部顺序。

---

## 4. Review Gate（关键检查点）

| Gate | 位置（step 后） | 检查项 | 负责人 |
|------|----------------|--------|--------|
| G1 适配器签名 | Step 1 后 | build_args 三适配器签名一致；claude resume 正确；调用点全更新；cargo test adapters 绿 | dev |
| G2 session id 捕获 | Step 3 后 | system/result 行都能取 id；assistant 行不误取；只设一次；emit 正确 | dev |
| G3 send_input 续接 | Step 5 后 | 复用 spawn 管线（无复制粘贴）；claude resume / 其他摘要分流正确；main.rs 透传 app | dev |
| G4 前端分流 | Step 8-9 后 | send 不再清空；首问/追问分流；turns 累积；finally 保留 id | dev |
| G5 错误友好 | Step 10 后 | 三类失败路径均有 Bubble 反馈；无裸 toast；无静默 | dev |
| G6 端到端 | Step 11 后 | claude 真 + codex/opencode 伪 + 失败路径三场景符合断言 | dev |
| G7 回归 | Step 12 后 | cargo test + pnpm typecheck + pnpm test 全绿；首轮不回归 | reviewer |

**G3 / G4 是最高风险 gate**（状态机 + 生命周期），必须重点审查：
- 追问期间 status 正确回到 running，exit 后回 exited。
- `assistantSessionIdRef` 跨追问不串台（listener 过滤 `:104,123` 模式）。
- 历史摘要截断后不超 Windows 命令行上限。

---

## 5. 回滚点

| 回滚点 | 触发条件 | 回滚动作 | 影响面 |
|--------|---------|---------|--------|
| RP1 | Step 1-5 任一编译/测试失败 | 回退 build_args 签名（删 resume_id）；send_input 恢复硬编码拒绝（`code_assistant.rs:397-407` 原样） | 仅桌面壳内部，无契约影响 |
| RP2 | Step 6 codex 探针失败 | codex 保持 degraded（历史摘要），不升级 native | codex 多轮仍可用（伪），不阻塞 |
| RP3 | Step 11 claude session id 捕获不稳 | claude 自动降级为伪多轮（缺 id 即走摘要），UI 提示降级 | claude 多轮仍可用（伪），真续接待修 |
| RP4 | Step 12 回归红 | 前端 `send()` 分流判断失败时 fallback 到 `startNewSession`（追问=新对话），保证可用 | 多轮退化为「每次新开」，不崩溃 |
| RP5 | cli_session_id 字段引发 sessions.json 损坏 | `#[serde(default)]` 保证旧盘可读；手动删 sessions.json 重建（本地态，可丢） | 丢失本地 session 历史，无云端影响 |

**最终回滚底线**：即使全部多轮能力失败，回退到「单轮 + 每次新对话」的改造前行为，前端 `newDraft`（`PluginCreatorHome.tsx:333-344`）始终可用，不阻塞父任务其他子任务。
