# SDK Runtime Engine（对话流式引擎）

代码助手内置 SDK Runtime 的请求/解析契约。位于 `apps/desktop/src-tauri/src/code_assistant/engine/`，直连 LLM HTTP API（非 CLI），把 Anthropic `/v1/messages` 与 OpenAI 兼容 `/v1/chat/completions` 两条通道的 SSE 流解码为增量事件，经 `EngineEventSink` 推送前端。与 [plugin-runtime-persistence.md](./plugin-runtime-persistence.md) 区分：后者是「用户/AI 创建的插件」的进程运行；本篇是「生成插件的对话 AI」本身。

## 1. Scope / Trigger

触发本规范的改动：改 `engine/runtime.rs`、`engine/stream.rs`、`engine/anthropic.rs`、`engine/openai.rs`，或对话的流式输出 / 思考内容 / 工具调用链路。

## 2. 模块边界

- `stream.rs`：纯逻辑（无网络），可单测。`SseDecoder`（字节流→`data:` 负载行）+ `AnthropicStreamState` / `OpenAiStreamState`（状态机）+ `StreamEvent`（`Text`/`Thought`/`ToolCallReady`）+ `ToolCall`（两通道共用）。
- `runtime.rs`：流式收发循环（`chunk()` 增量读 + decoder + 状态机驱动 + 多轮 tool 续轮），不含解析细节。
- `anthropic.rs` / `openai.rs`：仅请求体/URL 构造。

## 3. 请求契约（必须）

- **两通道请求体必须带 `stream: true`**，响应走 SSE 增量读（`reqwest::Response::chunk()`，无需 `stream` Cargo feature），禁止退回阻塞 `.json()`。
- **Anthropic 认证头必须用 `x-api-key`**；不要用 `Authorization: Bearer ...`，否则官方 `/v1/messages` 会返回 `AuthError: Missing API key`。
- **ClaudeCode 必须直连 Anthropic Messages endpoint**：`SdkCredentials` 必须包含 active provider 的 `provider` 与 `apiUrl`；`runtime.rs` 用 `build_provider_messages_url(provider, apiUrl)` 生成最终 POST URL。Moonshot 的 OpenAI-compatible base `https://api.moonshot.cn/v1` 不可直接请求 `/messages`，ClaudeCode 通道必须转为 `https://api.moonshot.cn/anthropic/v1/messages`。
- **Anthropic 启用 thinking**：body 含 `thinking: { type: "enabled", budget_tokens: 2048 }`，且 `max_tokens: 8192`。**硬约束 `budget_tokens < max_tokens`**，改任一值都要维持该不等式；thinking 启用时不可设 `temperature`（当前未设，勿加）。
- **OpenAI 思考**：无需请求参数；上游模型（如 DeepSeek-R1）自带 `reasoning_content` 增量则透传展示，普通模型无此字段即不展示。

## 4. SSE 解析契约

- `SseDecoder.push(&[u8]) -> Vec<String>`：按 `\n`（0x0A，不出现在 UTF-8 续字节中，按字节切安全）切行，去尾部 `\r`，仅取 `data:` 行负载，末尾半行留缓冲待补。`[DONE]` 哨兵原样返回交调用方识别。
- Anthropic 状态机按 JSON `type` 分发（`content_block_start`/`content_block_delta`/`content_block_stop`/`message_delta`），不依赖 `event:` 行。`text_delta`→`Text`、`thinking_delta`→`Thought`、`signature_delta`/`input_json_delta` 仅累积**不 emit**。
- OpenAI 状态机解析 `choices[0].delta`：`content`→`Text`、`reasoning_content`→`Thought`、`tool_calls[]` 按 `index` 累积分片，`finish_reason=="tool_calls"` 时产出 `ToolCallReady`。

## 5. 事件分类契约（绝不混流）

`emit_stream_event` → `EngineEventSink::output(stream, text)`：`Text`→`"stdout"`、`Thought`→`"thought"`、`ToolCallReady`→`"tool"`。**`thought`/`tool` 绝不混入 `stdout`**——前端 `stdout` 是协议解析输入，污染会破坏插件草稿解析。前端按 `stream` 字段分类渲染（`ReasoningBlock`/`ToolBlock`），后端已就绪即可用。

## 6. 多轮 tool 续轮契约

- **Anthropic（关键 400 陷阱）**：带工具续轮时，assistant 消息**必须保留 thinking 块及其 `signature`**，否则 API 返 400。`into_assistant_content()` 按 `index` 重建 `[thinking(带signature)?, text?, tool_use*]`。`signature_delta` 必须累积保存即为此用。
- **OpenAI**：`into_assistant_message()` 重建 `{role, content, tool_calls[]}`，**不含 `reasoning_content`**（OpenAI 不接受回传，部分代理会 400）。
- 两通道续轮后追加工具执行结果（Anthropic `tool_result` / OpenAI `role:tool`），沿用 `LocalToolExecutor::execute`。
- 工具执行结果必须同时发一条 `tool` stream：`<tool_name>_result <json>`。这样前端能展示真实成功/失败结果，不能只把结果回传给模型。

## Scenario: Local Tool Boundary

### 1. Scope / Trigger
- Trigger: changing `LocalToolExecutor`, SDK tool definitions, code-assistant prompt guidance, or tool stream rendering.

### 2. Tool Domains
- Workspace tools:
  - `list_directory(path)`
  - `read_file(path)`
  - `write_file(path, content)`
  - `scan_workspace()`
- External source tools:
  - `list_local_directory(path)`
  - `read_local_file(path, max_bytes?)`
  - `search_local_files(path, query)`
  - `import_local_project(source_path, destination?)`
  - `run_command(command, args?, cwd?)`

### 3. Contracts
- Workspace writes accept only relative plugin workspace paths. Absolute paths, `..`, empty segments, and hidden path segments remain rejected.
- External read/list/search/import tools require absolute local paths and canonicalize before use.
- External source tools never write back to the source path. They inspect or copy source data into the plugin workspace.
- `import_local_project` copies into the plugin workspace, skips generated-heavy folders (`node_modules`, `.venv`, `__pycache__`, `dist`, `build`, `.git`), and reports copied/skipped counts.
- `run_command` runs only in the plugin workspace or a workspace subdirectory. For source projects, import first, then execute commands inside the workspace copy.
- Non-zero command exit is returned as structured output with `exitCode`; it must not be converted into fake success or swallowed.
- Local tool results are shaped as `{ ok: true, result }` or `{ ok: false, error }` and must be visible in the `tool` stream as `<name>_result <json>`.

### 4. Validation & Error Matrix
- `write_file("O:/x", "...")` -> `ok:false`, absolute path error.
- `read_local_file("relative.txt")` -> `ok:false`, absolute path required.
- `import_local_project("O:/AI换衣", "")` -> copies source files into workspace root, skipping generated folders.
- `run_command(..., cwd: "O:/AI换衣")` -> `ok:false`, command cwd outside workspace.
- `run_command(..., cwd omitted)` -> executes in workspace and returns stdout/stderr/exit code.

### 5. Tests Required
- Rust `code_assistant::engine::tools` tests for path rejection, local read/list/search, import skips, and command cwd boundary.
- Rust runtime test that tool execution emits `<tool>_result` on the `tool` stream.
- Frontend projection test if tool result rendering changes.

## 7. 错误处理契约

- HTTP 非 2xx：读 body 文本，`Err(format!("...返回错误：HTTP {status} {body}"))`，经前端 `errorMessage` 透出（见 `desktop/frontend/api-streaming-and-runtime.md`）。
- `chunk()` 中断 → `Err(...流读取失败...)`；单条 SSE 负载 JSON 解析失败**跳过不中断整轮**（半包已由 decoder 消化）。
- 每次 chunk 循环开头 `abort_if_cancelled`，取消返回 `Err("会话已停止")`（`finish_sdk_turn` 静默处理）。

## Scenario: Provider-Aware ClaudeCode Messages URL

### 1. Scope / Trigger
- Trigger: changing `llm_credentials.rs`, `SdkCredentials`, `engine/anthropic.rs`, or ClaudeCode SDK Runtime URL construction.

### 2. Signatures
- Active provider API: `GET /api/llm/active-provider -> { provider: string, apiUrl: string, defaultModels: string[] }`.
- Rust credentials: `SdkCredentials { api_key: String, api_url: String, provider: String }`.
- URL builder: `build_provider_messages_url(provider: &str, api_url: &str) -> String`.

### 3. Contracts
- ClaudeCode always speaks Anthropic Messages protocol and POSTs to `.../v1/messages`.
- Moonshot provider uses Anthropic-compatible base `https://api.moonshot.cn/anthropic`, even when the active provider `apiUrl` is the OpenAI-compatible `https://api.moonshot.cn/v1`.
- Codex/OpenAI runtime keeps using `apiUrl` with `/v1/chat/completions`; do not route it through the Moonshot Anthropic base.
- Missing `provider` or `apiUrl` from active-provider is a contract error; do not guess provider from URL.

### 4. Validation & Error Matrix
- `provider="moonshot", apiUrl="https://api.moonshot.cn/v1"` -> `https://api.moonshot.cn/anthropic/v1/messages`.
- `provider="moonshot", apiUrl="https://api.moonshot.cn/anthropic"` -> `https://api.moonshot.cn/anthropic/v1/messages`.
- `provider="anthropic", apiUrl="https://api.anthropic.com"` -> `https://api.anthropic.com/v1/messages`.
- active-provider response missing `provider` or `apiUrl` -> explicit parse/contract error.

### 5. Good/Base/Bad Cases
- Good: Moonshot ClaudeCode turn posts to `/anthropic/v1/messages` with Anthropic tool schema.
- Base: Anthropic official provider posts to `/v1/messages`.
- Bad: Moonshot ClaudeCode posts to `/v1/messages`; Moonshot validates the Anthropic `tools` array as OpenAI functions and returns `function name is invalid`.

### 6. Tests Required
- Rust unit: `provider_messages_url_uses_moonshot_anthropic_base`.
- Rust runtime capture: `claude_moonshot_provider_requests_anthropic_messages_path` asserts actual request line starts `POST /anthropic/v1/messages`.
- Rust credential parsing: `active_provider_parses_provider_id` and missing-field error tests.

### 7. Wrong vs Correct
Wrong:

```rust
let url = build_messages_url(&credentials.api_url);
```

Correct:

```rust
let url = build_provider_messages_url(&credentials.provider, &credentials.api_url);
```

## Scenario: SDK Turn Failure Event Contract

### 1. Scope / Trigger
- Trigger: changing `finish_sdk_turn`, `StoreEventSink::error`, `SessionExitPayload`, or frontend transcript replay/projection for code assistant conversations.

### 2. Signatures
- Transcript failure event: `{ "event": "error", "payload": { "stream": "stderr", "error": string } }`
- Live failure event: `code-assistant://error` with `{ sessionId, stream: "stderr", error }`
- Terminal event: `code-assistant://exit` with `{ sessionId, exitCode: 1, status: "failed", endedAt }`
- Frontend projection owner: `transcriptTextSinceLastInput(events, "stderr")` and `transcriptSegmentsSinceLastInput(events)`.

### 3. Contracts
- SDK request/read errors are not "empty output"; they are displayable stderr diagnostics.
- `finish_sdk_turn` must store the error event before the failed exit event.
- Failed turns must emit `status: "failed"` in the exit payload; do not collapse them to `"exited"`.
- Frontend transcript replay must treat `error.error` as a stderr segment for the latest input window.

### 4. Validation & Error Matrix
- HTTP non-2xx -> transcript `error` event + live error + exit `status="failed"`.
- Network or chunk read failure -> transcript `error` event + live error + exit `status="failed"`.
- User stop (`"会话已停止"`) -> no failed error event; stop path owns the `"stopped"` terminal event.

### 5. Good/Base/Bad Cases
- Good: ClaudeCode endpoint returns HTTP 404; UI shows `ClaudeCode SDK 返回错误：HTTP 404 ...` in the chat and toast.
- Base: normal streaming text emits `output.stdout` and exit `status="exited"`.
- Bad: frontend only reads `output` events, so failed turns become `代码助手没有返回可展示内容。`.

### 6. Tests Required
- Rust: `failed_turn_emits_failed_exit_status` asserts exit payload `status=="failed"` and persisted session status `failed`.
- Frontend: transcript projection tests assert `error.error` becomes latest-turn stderr text and stderr segment.
- Full checks: `cargo test -p lingfang-desktop`, `pnpm -C apps/desktop test`, and `pnpm -C apps/desktop typecheck`.

### 7. Wrong vs Correct

Wrong:

```json
{ "event": "error", "payload": { "error": "HTTP 404" } }
{ "event": "exit", "payload": { "exitCode": 1, "status": "exited" } }
```

Correct:

```json
{ "event": "error", "payload": { "stream": "stderr", "error": "HTTP 404" } }
{ "event": "exit", "payload": { "exitCode": 1, "status": "failed" } }
```

## 8. Tests Required

- `cargo test -p lingfang-desktop`（`code_assistant::engine::stream::tests` 至少覆盖：SSE 跨 chunk 半行/`\r\n`/`[DONE]`、Anthropic text+tool 累积与 content 重建、Anthropic thinking 保 signature、OpenAI content/reasoning/tool 分片与 message 重建）。
- body 单测断言 `stream==true`、Anthropic `thinking` 存在且 `max_tokens==8192`。

## 9. Wrong vs Correct

**Wrong**：Anthropic 带工具续轮时只回放 `text`/`tool_use`，丢弃 thinking 块 → 启用 thinking 后第二轮请求被 400 拒绝。

**Correct**：续轮 assistant content 首块保留 `{type:"thinking", thinking, signature}`，signature 来自流式累积的 `signature_delta`。
