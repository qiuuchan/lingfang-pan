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

## 7. 错误处理契约

- HTTP 非 2xx：读 body 文本，`Err(format!("...返回错误：HTTP {status} {body}"))`，经前端 `errorMessage` 透出（见 `desktop/frontend/api-streaming-and-runtime.md`）。
- `chunk()` 中断 → `Err(...流读取失败...)`；单条 SSE 负载 JSON 解析失败**跳过不中断整轮**（半包已由 decoder 消化）。
- 每次 chunk 循环开头 `abort_if_cancelled`，取消返回 `Err("会话已停止")`（`finish_sdk_turn` 静默处理）。

## 8. Tests Required

- `cargo test -p lingfang-desktop`（`code_assistant::engine::stream::tests` 至少覆盖：SSE 跨 chunk 半行/`\r\n`/`[DONE]`、Anthropic text+tool 累积与 content 重建、Anthropic thinking 保 signature、OpenAI content/reasoning/tool 分片与 message 重建）。
- body 单测断言 `stream==true`、Anthropic `thinking` 存在且 `max_tokens==8192`。

## 9. Wrong vs Correct

**Wrong**：Anthropic 带工具续轮时只回放 `text`/`tool_use`，丢弃 thinking 块 → 启用 thinking 后第二轮请求被 400 拒绝。

**Correct**：续轮 assistant content 首块保留 `{type:"thinking", thinking, signature}`，signature 来自流式累积的 `signature_delta`。
