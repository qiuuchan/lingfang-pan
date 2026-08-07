# 对话式多轮创建流程 — 技术设计（design.md）

> 父任务：`06-13-plugin-creator-conversational-revamp`（见 `prd.md`）
> 本子任务对应父 PRD 的 **R1 对话式多轮创建**，并作为 R2/R3 的上游使用方（多轮迭代必须基于结构化草稿）。

---

## 1. 背景与目标

### 1.1 呼应父 PRD 的 R 项

本子任务落实父 PRD **R1**：把桌面端「创建插件」从「单轮一次性 CLI + 前端硬编码兜底」改造为**真正的多轮对话**——用户在同一会话内可追问澄清、基于已生成结果继续迭代修改，草稿与对话历史跨轮累积，三 CLI（claude / codex / opencode）均可多轮。

### 1.2 目标（可验证）

- **解锁 `send_input`**：Rust 端 `send_input` 当前硬编码拒绝（`code_assistant.rs:397-407`），改为真正的多轮续接。
- **真多轮 vs 伪多轮分层**：claude 用官方 `--resume <session_id>` 真续接上下文；codex / opencode 因 CLI 无可靠 session 复用能力，降级为「历史摘要拼进新 session 的 system_prompt」伪多轮，且对用户透明提示。
- **turns 累积**：前端不再每轮 `setCurrentDraft(null)` 清空草稿（`PluginCreatorHome.tsx:236`），对话轮次累积追加而非硬编码两条（`plugin-draft.ts:232-235`）。
- **失败可见**：多轮失败（会话已退出 / `cli_session_id` 缺失 / CLI 不可用）必须有明确 UI 反馈，不得静默（呼应 AC6）。

### 1.3 非目标（明确排除）

- 不负责结构化协议（manifest/file 标记解析）——属 R2 / `structured-output-parsing`。
- 不负责 Node/Python 运行时与 `run_plugin_script`——属 R3 / `node-python-local-exec`。
- 不负责 Markdown 高亮与样式——属 R4 / R5。
- 不改 `packages/contract`（RuntimeType 四值扩展属 R3）；本任务仅在 `SessionRecord` 增加一个本地运行时字段，不进云端契约。

---

## 2. 现状与问题（精确引用）

### 2.1 Rust 端：多轮被硬编码拒绝

- `apps/desktop/src-tauri/src/code_assistant.rs:397-407` —— `send_input` 直接 `let _ = input.input`（丢弃输入），写一条 `input-rejected` transcript，返回 `Err("当前适配器使用一次性非交互 CLI 调用…")`。
- `start_session`（`code_assistant.rs:274-395`）生命周期：`stdin(Stdio::null())`（`:309`）使子进程**一次性**，无 stdin 常驻；`spawn_waiter`（`:663-707`）在子进程退出后从 `processes` map 移除（`:689-692`）并清理注册项。**退出即终结**，无续接通道。
- 前端当前**完全不调用** `code_assistant_send_input`（全仓 grep `send_input` 无业务调用，仅 main.rs 注册的命令存在 `main.rs:125-129`）。多轮在产品层是死路。

### 2.2 适配器：build_args 无 session 续接入参

- `adapters/mod.rs:40` —— `build_args: fn(prompt: &str, model: Option<&str>) -> Vec<String>`，**没有 resume id 参数**。
- 三个适配器的 `build_args`：
  - `adapters/claude.rs:17-30`：`-p <prompt> --output-format stream-json --verbose --include-partial-messages [--model m]`。
  - `adapters/codex.rs:24-30`：`exec <prompt> [--model m]`。
  - `adapters/opencode.rs:17-23`：`run <prompt> [--model m]`。
- claude 官方支持 `--resume <session_id>`（headless 续接，需配合 `-p`），但当前未传；codex 的 `resume` 是**独立子命令**（`codex resume <id> [--include-non-interactive]`），`exec` 不暴露 `--resume`；opencode 仓内无 session 复用痕迹。

### 2.3 session id 捕获缺失

- `spawn_reader`（`code_assistant.rs:574-625`）对 stream-json 行调用 `extract_stream_json_text`（`:550-572`）。
- `extract_stream_json_text` **只接受 `type == "assistant"` 的行**（`:552-554`），其余（含 `system` 初始行、`result` 结束行，claude 的 session id 通常出现在 `result` 事件的 `session_id` 字段或 `system` init）被 `continue` 丢弃。**session id 当前完全未被捕获**，`SessionRecord`（`store.rs:33-54`）也无 `cli_session_id` 字段。

### 2.4 transcript 结构（可复用）

- `store.rs:249-268` —— `append_transcript(session_id, event, payload)`，每行 `{ at, event, payload }` 的 JSONL。
- `transcript_path`（`store.rs:198-202`）：`<root>/transcripts/<session_id>.jsonl`。
- 多轮历史摘要可从 transcript 的 `input`/`output` 事件读取，是伪多轮「拼历史」的数据源。

### 2.5 前端：每轮清空 + turns 硬编码

- `PluginCreatorHome.tsx:226-277` —— `send()` 每次执行 `setCurrentDraft(null)`（`:236`），首轮与追问走同一条 `code_assistant_start_session` 路径，**无法区分首轮 start 与追问 send_input**。
- `PluginCreatorHome.tsx:163-216` —— `finalizeSession` 在 `finally`（`:210-215`）**重置全部运行态**（`setStreaming(false)`、清 `pendingPromptRef`、清 `assistantSessionIdRef`），导致追问无可用 session 句柄。
- `plugin-draft.ts:232-235` —— `buildLocalDraft` 硬编码两条 turn（user 首条 + assistant 输出）。
- `plugin-draft.ts:245-253` —— `normalizeTurns` 仅做**相邻同 role 同 content 去重**，无追加累积语义。

### 2.6 问题汇总

| #   | 问题                                 | 位置                                | 影响                |
| --- | ------------------------------------ | ----------------------------------- | ------------------- |
| P1  | `send_input` 硬编码拒绝              | `code_assistant.rs:397-407`         | 多轮不可用          |
| P2  | 一次性子进程 + 退出即清理            | `code_assistant.rs:309,663-707`     | 无续接通道          |
| P3  | `build_args` 无 resume 入参          | `adapters/mod.rs:40`                | 无法构造续接命令    |
| P4  | session id 未捕获                    | `code_assistant.rs:550-572`         | claude 无续接 id    |
| P5  | `SessionRecord` 无 `cli_session_id`  | `store.rs:33-54`                    | 无法持久化续接 id   |
| P6  | 前端每轮清空 + 无 start/send 分流    | `PluginCreatorHome.tsx:236,226-277` | 草稿无法累积        |
| P7  | `finalizeSession` finally 重置全部态 | `PluginCreatorHome.tsx:210-215`     | 追问无 session 句柄 |
| P8  | turns 硬编码两条                     | `plugin-draft.ts:232-235`           | 历史不累积          |

---

## 3. 技术方案（推荐方案 B：每轮新 spawn + --resume）

### 3.1 方案边界

采用研究结论的**方案 B**：**非常驻 stdin**，而是「每轮新 spawn 一个一次性子进程 + 传 `--resume`（claude）或拼历史摘要（codex/opencode）复用上下文」。

**为什么不常驻 stdin**：

- claude headless 模式（`-p`）本就是一次性进程，官方续接靠 `--resume`，不靠 stdin。
- codex/opencode 非交互模式同样一次性。
- 常驻 stdin 需要引入「长期持有子进程 + 行协议解析 + 超时心跳」一整套基础设施，维护面过大，违反「标准化 + 生态复用 + 维护成本下降」原则。新 spawn 复用既有 `start_session` / `spawn_reader` / `spawn_waiter` 管线，增量最小。

**伪多轮的语义对齐**：codex/opencode 的「拼历史」本质是**重新发起一次独立生成**，把前几轮的 user/assistant 文本拼进 system_prompt 作为「上下文记忆」。它不是 CLI 级的真续接，但对用户表现为「记得之前说过什么」。**必须在 UI 上用降级提示透明告知**（R1 明确要求）。

### 3.2 总体数据流（多轮）

```
[首轮]
  前端 send() ──> 区分: 无 activeSessionId ──> code_assistant_start_session
    Rust: spawn 子进程(stream-json) ─> 流式 output ─> 退出 ─> exit 事件
    spawn_reader 捕获 cli_session_id 写入 SessionRecord.cli_session_id
    finalizeSession(首轮): 读 transcript -> buildLocalDraft(首轮) -> turns=[u1,a1]

[追问]
  前端 send() ──> 区分: 有 activeSessionId && 首轮已 exited && cli_session_id 存在
    ──> code_assistant_send_input { sessionId, input }
    Rust: send_input
      ├─ claude: build_args(prompt, model, Some(cli_session_id)) -> 加 --resume -> 新 spawn -> 流式 -> exit
      └─ codex/opencode: 读 transcript 历史 -> 拼摘要进 system_prompt -> 新 spawn -> 流式 -> exit
    exit 事件 -> finalizeSession(追问): 追加 turns=[u2,a2,...] 到既有 draft，不重建
```

### 3.3 组件拆分与接口设计

#### 3.3.1 适配器层：build_args 扩 resume 入参

**文件**：`adapters/mod.rs`、`claude.rs`、`codex.rs`、`opencode.rs`

**接口变更**（`mod.rs:40`）：

```rust
// 旧
pub build_args: fn(prompt: &str, model: Option<&str>) -> Vec<String>,
// 新（追加 resume_id 入参；None 表示首轮）
pub build_args: fn(prompt: &str, model: Option<&str>, resume_id: Option<&str>) -> Vec<String>,
```

同步更新 `ToolDefinition::probe_args` / `run_args`（`mod.rs:43-51`）签名，补 `resume_id: Option<&str>` 参数并透传。

**claude.rs `build_args`（:17-30）**：当 `resume_id.is_some()` 时，追加 `--resume <id>`。官方续接语义：`claude -p <prompt> --resume <id> --output-format stream-json …`。

```rust
fn build_args(prompt: &str, model: Option<&str>, resume_id: Option<&str>) -> Vec<String> {
    let mut args = vec![
        "-p".to_string(), prompt.to_string(),
        "--output-format".to_string(), "stream-json".to_string(),
        "--verbose".to_string(), "--include-partial-messages".to_string(),
    ];
    if let Some(model) = model { args.extend(["--model".to_string(), model.to_string()]); }
    if let Some(id) = resume_id { args.extend(["--resume".to_string(), id.to_string()]); }
    args
}
```

**codex.rs / opencode.rs**：`resume_id` 参数**接收但忽略**（这两者由 `send_input` 层用历史摘要实现续接，不依赖 CLI 的 resume）。保留统一签名以解耦调用方。

**测试增量**：在 `adapters/mod.rs:69-99` 的 `tests` 模块追加 `claude_resume_appends_resume_arg`（断言 `probe_args("ping", Some("sonnet"), Some("sid-123"))` 含 `--resume sid-123`）。

#### 3.3.2 store 层：SessionRecord 增 cli_session_id

**文件**：`store.rs:33-54`

```rust
pub struct SessionRecord {
    // …既有字段…
    #[serde(default, alias = "cliSessionId", rename = "cliSessionId")]
    pub cli_session_id: Option<String>,
}
```

- 用 `#[serde(default)]` 保证旧 `sessions.json` 可读（向后兼容本地落盘，**非云端契约**）。
- 新增 `AssistantStore::set_cli_session_id(&self, session_id, cli_id)`：读 sessions → 改对应 record 的 `cli_session_id` → `upsert`。复用 `update_session_exit`（`store.rs:230-247`）的「定位 record 改字段再写」模式。

#### 3.3.3 spawn_reader：捕获 claude session id

**文件**：`code_assistant.rs:574-625`（`spawn_reader`）+ `:550-572`（`extract_stream_json_text`）

新增 `extract_stream_json_session_id(line: &str) -> Option<String>`：解析 claude stream-json 的 `system`（init）/ `result` 行，取 `session_id` 字段。

```rust
fn extract_stream_json_session_id(line: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    let ty = value.get("type").and_then(|v| v.as_str())?;
    match ty {
        "system" | "result" => value.get("session_id").and_then(|v| v.as_str()).map(String::from),
        _ => None,
    }
}
```

在 `spawn_reader` 的 `Ok(_)` 分支（`code_assistant.rs:590-607`）：当 `output_format == StreamJson` 时，**先尝试** `extract_stream_json_session_id`，拿到非空 id 即 `state.store.set_cli_session_id(&session_id, &id)` 并 emit `code-assistant://session-cli-id`（payload `{ sessionId, cliSessionId }`），且**只设一次**（用 `Once`/标志位避免重复写盘）。

> 文本提取（`:591-597`）逻辑保持不变：`extract_stream_json_text` 仍只取 assistant 文本，session id 提取是**并行旁路**，互不干扰。

#### 3.3.4 send_input：核心续接逻辑

**文件**：`code_assistant.rs:397-407`

重写 `send_input` 为真正的续接发起者（**复用 start_session 的 spawn 管线**，不重写子进程基础设施）：

```rust
pub fn send_input<E: AssistantEventSink>(
    app: E,
    state: &CodeAssistantState,
    input: SendInputInput,
) -> Result<(), String> {
    // 1. 查 session record，取 tool / model / workspace_dir / cli_session_id / 历史
    let session = state.store.list_sessions().into_iter()
        .find(|r| r.session_id == input.session_id)
        .ok_or("session 不存在或已结束")?;
    // 会话已退出（非 running/stopped 等活动态）仍允许追问，但需校验 cli_session_id（claude）
    let definition = tool_definition(session.tool);
    let command = find_command(definition.candidate_commands)
        .ok_or_else(|| format!("未找到 {} CLI", definition.display_name))?;
    let workspace_dir = session.workspace_dir.clone();

    // 2. 写追问 input transcript（复用既有 append_transcript，event=input）
    state.store.append_transcript(&input.session_id, "input", json!({
        "prompt": input.input, "kind": "followup",
    }))?;

    // 3. 构造 prompt/resume_id/system_prompt
    let (prompt_for_cli, resume_id): (String, Option<String>) = match session.tool {
        CodeAssistantTool::Claude => (input.input.clone(), session.cli_session_id.clone()),
        _ => {
            // codex/opencode 伪多轮：拼历史摘要
            let summary = build_history_summary(&state.store, &input.session_id)?; // 见 3.3.5
            let composed = format!("{summary}\n\n---\n\n用户追问：{}", input.input);
            (composed, None)
        }
    };
    let final_prompt = prompt_for_cli; // 追问不再叠 system_prompt（首轮已含协议）

    // 4. 复用 build_args（带 resume）+ 复用 spawn 管线
    let args = command.args_with(definition.run_args(&final_prompt, session.model.as_deref(), resume_id.as_deref()));
    // 5. spawn 子进程（与 start_session:305-391 同构：Stdio::null stdin, piped stdout/stderr）
    //    注册进 processes map、append output/exit transcript、emit output/exit 事件
    spawn_followup_run(app, state.clone(), session, command, args, workspace_dir)
}
```

**`spawn_followup_run`（新增私有函数）**：抽取 `start_session` 的 spawn+register+reader+waiter 公共段（`code_assistant.rs:305-395`）为可复用函数，`start_session` 与 `send_input` 共用，避免复制粘贴（DRY）。

**状态契约**：追问期间 `SessionRecord.status` 由 `exited` 回到 `running`（写 `input` transcript 后 `upsert_session` 置 running），`spawn_waiter` 退出后再置 `exited`。前端据此区分「追问进行中」与「追问完成」。

#### 3.3.5 build_history_summary：伪多轮历史摘要

**文件**：`code_assistant.rs`（新增私有函数，紧邻 `tail`）

```rust
/// 读取 transcript 中已有的 input/output 事件，拼成可读历史摘要供 codex/opencode 伪多轮复用。
fn build_history_summary(store: &AssistantStore, session_id: &str) -> Result<String, String> {
    let raw = store.read_transcript(session_id)?;
    let mut lines = Vec::new();
    for line in raw.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) else { continue; };
        let (ev, payload) = (v.get("event").and_then(|x| x.as_str()), v.get("payload"));
        match (ev, payload) {
            (Some("input"), Some(p)) => {
                let prompt = p.get("prompt").and_then(|x| x.as_str()).unwrap_or("");
                if !prompt.is_empty() { lines.push(format!("【用户】{prompt}")); }
            }
            (Some("output"), Some(p)) => {
                let text = p.get("text").and_then(|x| x.as_str()).unwrap_or("");
                if !text.trim().is_empty() { lines.push(format!("【AI】{text}")); }
            }
            _ => {}
        }
    }
    // 截断防爆炸（每段 tail，整体上限 ~12k 字符）
    Ok(truncate_history(&lines.join("\n\n"), 12_000))
}
```

**安全考虑**：历史摘要可能很长 → 用 `truncate_history`（基于 `tail`：850-857 的字符截断模式）整体限长，避免命令行参数过长（Windows 命令行 ~32k 上限）。

#### 3.3.6 前端：start/send 分流 + turns 累积 + 不清空

**文件**：`PluginCreatorHome.tsx`、`plugin-draft.ts`

**(a) 新增多轮运行态**（`PluginCreatorHome.tsx:52-62` 附近）：

```ts
const [cliSessionId, setCliSessionId] = useState<string | null>(null); // claude 的 --resume id
const [multiturnMode, setMultiturnMode] = useState<'native' | 'degraded' | null>(null);
```

新增 listener `code-assistant://session-cli-id` → `setCliSessionId(payload.cliSessionId)`（仅 claude 会收到）。

**(b) `send()` 分流（改写 `:226-277`）**：

```ts
async function send() {
  const text = input.trim();
  if (!text || streaming) return;
  setInput('');
  setPendingUser(text);
  setLiveEvents([]);
  setLiveError(null);
  setStreaming(true);
  // 关键：移除 setCurrentDraft(null)（原 :236）——草稿跨轮累积
  pendingPromptRef.current = { text, providerLabel: providerInfo.label, model };

  const activeId = assistantSessionIdRef.current;
  const firstRoundDone = activeId && !streaming && assistantSession?.status !== 'running';
  if (firstRoundDone) {
    // 追问路径
    try {
      await tauriInvoke('code_assistant_send_input', {
        input: { sessionId: activeId, input: text },
      });
      // send_input 成功后，新一轮的 output/exit 事件会触发既有 listener
      setLiveStage(
        multiturnMode === 'degraded'
          ? '本地代码助手基于历史继续生成（降级多轮）…'
          : '本地代码助手续接上下文生成…'
      );
    } catch (error) {
      handleMultiturnError(error); // 见 (d)
    }
  } else {
    // 首轮路径（保留原 start_session 逻辑）
    startNewSession(text);
  }
}
```

**(c) `finalizeSession` 累积语义（改写 `:163-216`）**：

- 不再每次 `setCurrentDraft(draft)` 覆盖。改为：
  - 首轮：`setCurrentDraft(buildLocalDraft(首轮))`（turns=[u1,a1]）。
  - 追问：读取既有 `currentDraft`，**追加** `[user u_n, assistant a_n]` 到 `currentDraft.turns`，files/manifest 用 R2 解析的新结构化产出**覆盖**（迭代），diagnostics 合并。提取为 `mergeFollowupDraft(prevDraft, probeResult, prompt)`（放 `plugin-draft.ts`）。
- `finally` 块（`:210-215`）**不再清空** `assistantSessionIdRef.current`（追问需保留），仅 `setStreaming(false)` + 清 `liveStage`。`assistantSession` 保留 `exited` 态供追问判断。

**(d) 降级提示与错误处理**：

- `multiturnMode`：首次成功捕获 `cliSessionId`（claude）→ `'native'`；codex/opencode 首轮 exit 后无 `cliSessionId` → `'degraded'`。在追问 Bubble 上方加一行 muted 文案：`此 CLI 不支持原生多轮，已基于历史继续（上下文非真复用）`。
- `handleMultiturnError`：会话已退出（`session 不存在或已结束`）→ 提示「对话已结束，请新开对话」并引导 `newDraft`；CLI 不可用 → 友好卡片（呼应 R5）；`cli_session_id` 缺失但选了 claude → 提示「未能捕获会话 id，自动降级为新对话」并以 Bubble error 形式展示。所有错误走 `setLiveError` + `Bubble error`（`Bubble.tsx:9` 已支持），不裸 toast。

**(e) `plugin-draft.ts` turns 累积（改 `:232-235` + 新增）**：

```ts
// buildLocalDraft 首轮仍返回 [u1,a1]（结构不变，由 R2 决定内容来源）
// 新增：追问合并
export function mergeFollowupDraft(
  prev: PluginDraft,
  result: CliProbeResult,
  prompt: string
): PluginDraft {
  const output = extractCliText(result);
  // files/manifest 由 R2 parseStructuredPackage 解析覆盖；本任务兜底：若 R2 未产出，保留 prev.files
  const files = parseStructuredPackage(output).files ?? prev.files; // parseStructuredPackage 属 R2
  return {
    ...prev,
    status: result.success ? 'ready' : 'partial',
    files,
    turns: [
      ...prev.turns,
      { role: 'user', content: prompt, at: new Date().toISOString() },
      {
        role: 'assistant',
        content: output || '本地 CLI 没有返回可展示内容。',
        at: new Date().toISOString(),
      },
    ],
    diagnostics: [...prev.diagnostics, ...followupDiagnostics(result)],
  };
}
```

`normalizeTurns`（`:245-253`）的相邻去重逻辑保留，作为追加后的兜底防重复（追问若 CLI 无输出会与上一轮 a 相同 → 被去重，符合预期）。

### 3.4 三 CLI 多轮能力矩阵

| CLI      | 续接机制                    | 真伪 | 依赖                                | 失败降级                     |
| -------- | --------------------------- | ---- | ----------------------------------- | ---------------------------- |
| claude   | `--resume <cli_session_id>` | 真   | 捕获 session id（system/result 行） | 缺 id → 降级伪多轮（拼历史） |
| codex    | 历史摘要拼 system_prompt    | 伪   | transcript 可读                     | 历史过长 → 截断后继续        |
| opencode | 历史摘要拼 system_prompt    | 伪   | transcript 可读                     | 历史过长 → 截断后继续        |

---

## 4. 关键决策与权衡

### 4.1 已确认的用户决策（来自父 PRD，作为硬约束）

1. **三 CLI 都支持多轮**：claude 真 resume；codex/opencode 降级历史拼接伪多轮，用户可感知。
2. **多轮失败必须有 UI 反馈**：会话已退出 / `cli_session_id` 缺失不得静默。
3. **复用既有基础设施**：code_assistant 子进程骨架、transcript、spawn 管线、Bubble/Markdown 组件。
4. **不新增冗余字段**：`cli_session_id` 仅本地落盘，**不进 `packages/contract`**（云端不需要 CLI 会话 id）。

### 4.2 权衡

| 决策                    | 选 A（采用）                             | 选 B（否决）                       | 理由                                                                            |
| ----------------------- | ---------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------- |
| 续接模型                | 每轮新 spawn + --resume                  | stdin 常驻长进程                   | 复用既有 spawn 管线；claude headless 本就一次性；常驻需行协议+心跳，维护面过大  |
| codex/opencode          | 历史摘要拼 system_prompt                 | `codex resume` 子命令              | `codex resume` 非交互续接待验证且与 `exec` 模型不一致；摘要法跨两者统一，零适配 |
| session id 存储         | `SessionRecord.cli_session_id`（本地）   | 新建独立 sessions-cli 表           | 字段最小化，复用 sessions.json，serde default 兼容旧盘                          |
| claude id 捕获时机      | `spawn_reader` 旁路捕获 system/result 行 | 首轮 exit 后从 transcript 全量回扫 | 流式捕获即时可用，exit 后回扫延迟且需额外 IO                                    |
| turns 模型              | 累积追加（`mergeFollowupDraft`）         | 每轮重建 transcript 转 turns       | 追加增量小、与现有 Bubble 渲染（`PluginCreatorHome.tsx:377`）直接兼容           |
| 前端是否保留 `newDraft` | 保留，作为「重置多轮」入口               | 追问无限累积                       | 长会话历史摘要会膨胀，提供显式重置                                              |

### 4.3 codex resume 探针的处置

研究指出 codex 有独立 `resume` 子命令但 `exec` 不暴露 `--resume`。本设计**先用历史摘要法**（已验证可行、跨 CLI 统一），将「codex 真续接」列为**实现期探针**（见 implement.md step 6）：若探针证明 `codex resume <id> --include-non-interactive` 可行且可靠，则把 codex 提升为 `native` 模式；否则保持 `degraded`。**不阻塞主线交付**。

---

## 5. 兼容性 / 迁移 / 回滚形状

### 5.1 本地落盘兼容

- `SessionRecord.cli_session_id` 用 `#[serde(default)]`，旧 `sessions.json` 可读（缺字段 → `None`）。
- `send_input` 的 transcript `event` 从 `input-rejected` 改为 `input`（`kind: "followup"`）。旧 transcript 文件里的 `input-rejected` 行对读取无影响（`build_history_summary` 只认 `input`/`output`）。

### 5.2 契约影响

- **本任务不触碰 `packages/contract`**。`cli_session_id` 是桌面壳本地运行时态。
- `SendInputInput`（`code_assistant.rs:170-175`）结构不变（`sessionId` + `input`），前端 invoke 入参兼容。

### 5.3 破坏性变更

- `build_args` 签名变更（追加 `resume_id`）——**内部 Rust 接口**，非公开 API，所有调用点（`mod.rs:44-50`、`run_once:477`、`start_session:288`）一并更新。无外部消费者。
- `finalizeSession` 不再清空运行态——**前端内部行为变更**，影响仅本组件。

### 5.4 回滚形状

- **代码回滚**：`send_input` 若验证失败，回退为硬编码拒绝（恢复 `:397-407`）+ 前端追问路径 fallback 到「提示请新开对话」。前端 `send()` 的分流判断 `firstRoundDone` 失败时 fallback 到 `startNewSession`，保证追问至少能新开（降级可用，不阻塞）。
- **数据回滚**：`cli_session_id` 字段多余时无副作用（`None` 即首轮语义）；无需迁移脚本回滚。

---

## 6. 安全与风险

### 6.1 安全边界（本任务范围内）

本任务**不引入新的代码执行面**——多轮仍是调用既有 CLI（claude/codex/opencode），`run_capture`/`spawn` 的子进程执行能力与首轮一致。**无 Node/Python 解释器执行**（属 R3）。因此：

- **软隔离边界沿用现状**：CLI 在用户权限下运行（`code_assistant.rs:305-318` 的 `Command::new` 无沙箱）。本任务不扩大该面，也不负责收紧。
- OS 级隔离（沙箱/容器化）属父 PRD 明确标注的**独立大任务**，本设计不处理，仅在 risk 标注。

### 6.2 风险清单

| #     | 风险                                                            | 概率 | 影响                    | 缓解                                                                                      |
| ----- | --------------------------------------------------------------- | ---- | ----------------------- | ----------------------------------------------------------------------------------------- |
| RISK1 | claude session id 输出格式在不同版本变化（system vs result 行） | 中   | claude 退化为伪多轮     | `extract_stream_json_session_id` 同时认 `system`+`result`；缺 id 自动降级 + UI 提示       |
| RISK2 | codex `resume` 非交互续接不可靠                                 | 高   | codex 保持伪多轮        | 默认伪多轮；探针验证后才升级（implement step 6）                                          |
| RISK3 | opencode 无任何 session 复用                                    | 高   | opencode 仅伪多轮       | 已规划为伪多轮，符合父 PRD 决策；无需额外动作                                             |
| RISK4 | 历史摘要过长 → Windows 命令行参数超限（~32k）                   | 中   | codex/opencode 追问失败 | `truncate_history` 整体限长 12k 字符；超长按段 tail                                       |
| RISK5 | turns 重复追加（CLI 无输出时与上轮相同）                        | 低   | UI 重复 Bubble          | `normalizeTurns`（:245-253）相邻去重兜底                                                  |
| RISK6 | `send_input` 在会话已退出后调用 → 状态机错乱                    | 中   | 追问卡死                | `send_input` 校验 session 存在；前端 `firstRoundDone` 判断；错误走 `handleMultiturnError` |
| RISK7 | 前端 `assistantSessionIdRef` 跨追问生命周期错乱                 | 中   | 追问打到错误 session    | listener 用 `assistantSessionIdRef` 过滤（既有模式 `:104,123`），追问不改 id              |
| RISK8 | 多轮中 R2 结构化解析失败                                        | 中   | 追问后草稿 files 不更新 | `mergeFollowupDraft` 兜底保留 `prev.files`，标记 `partial`                                |

---

## 7. 验证策略（本地可重复，呼应 AC2/AC6/AC8）

### 7.1 Rust 单元测试（`cargo test`）

- `claude_resume_appends_resume_arg`：断言 `build_args("p", Some("sonnet"), Some("sid"))` 含 `--resume sid`。
- `codex/opencode_resume_id_ignored`：断言 resume_id 不进入两者的 args（伪多轮不靠 CLI）。
- `extract_stream_json_session_id_*`：喂构造的 `system`/`result` JSON 行，断言取出 session id；喂 `assistant` 行断言返回 None。
- `build_history_summary`：喂 mock transcript，断言拼出 `【用户】…【AI】…` 且超长被截断。
- `set_cli_session_id` roundtrip：写 sessions → set → 读出字段。

**命令**：`cd apps/desktop/src-tauri && cargo test code_assistant`

### 7.2 前端单元测试（vitest，复用既有测试目录）

- `mergeFollowupDraft`：prev 有 turns → 追加后 turns 长度 +2，files 被新产出覆盖（mock R2 parse）。
- `normalizeTurns` 去重：追问 assistant 空输出时不产生重复。
- `send()` 分流：mock `assistantSessionIdRef` 有值且 exited → 调用 `code_assistant_send_input`；无值 → 调用 `start_session`。

**命令**：`cd apps/desktop && pnpm test`（针对 plugin-creator 相关 spec）

### 7.3 真实 CLI 探针（手动，必做）

- **claude 端到端**：首轮 `做一个番茄钟` → 等退出 → 追问 `把按钮改成红色` → 断言 turns 累积、右侧草稿 files 被迭代更新、无降级提示。
- **codex/opencode 降级**：同样两轮 → 断言出现降级提示文案、追问产出基于历史。
- **失败路径**：首轮退出后手动删除 `sessions.json` 里 `cli_session_id` → claude 追问 → 断言降级提示 + 可用伪多轮；追问一个不存在的 sessionId → 断言「对话已结束」提示。

**命令**：`cd apps/desktop && pnpm tauri dev`（手动操作 UI）

### 7.4 回归（不破坏既有）

- 首轮单轮流程（无追问）行为不变：`cargo test`、`pnpm typecheck`、既有 plugin-creator spec 全绿。
- transcript 首轮结构不变（仅追问新增 `input`/`output` 行）。

**命令**：`cd apps/desktop && pnpm typecheck && pnpm test`
