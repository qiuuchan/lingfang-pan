# 技术设计：对话流式输出与思考/工具调用展示

## 1. 范围与边界

- **仅改 Rust 引擎**：`apps/desktop/src-tauri/src/code_assistant/engine/`。前端、事件契约、`LocalToolExecutor`、工具定义不动。
- **复用既有事件链路**：`EngineEventSink::output(stream, text)` → `StoreEventSink` → `code-assistant://output` 事件 `{sessionId, stream, text}`。`stream` 取值 `stdout|stderr|thought|tool`，前端已分类渲染。
- **不新增依赖**：用 `reqwest::Response::chunk() -> Option<Bytes>` 增量读 body，手写 SSE 行缓冲。

## 2. 模块结构

新增 `engine/stream.rs`，承载可单测的纯逻辑：

- `SseDecoder`：字节流 → SSE `data:` 负载行（处理跨 chunk 的半行与 `\r\n`）。
- `StreamEvent`：解析产出的增量事件枚举（`Text` / `Thought` / `ToolCallReady`）。
- `ToolCall`：`{ id: String, name: String, arguments: Value }`（从 runtime.rs 迁移至此共用）。
- `AnthropicStreamState`：Anthropic SSE 状态机。
- `OpenAiStreamState`：OpenAI 兼容 SSE 状态机。

`runtime.rs` 的 `run_claude` / `run_codex` 改为「流式读取循环 + 状态机驱动 + sink 推送 + 多轮 tool 续轮」。

在 `engine/mod.rs` 顶部新增 `pub mod stream;`（与 `pub mod anthropic;` 等并列）。`ToolCall` 从 `runtime.rs` 迁至 `stream.rs` 并 `pub`，`runtime.rs` 改 `use super::stream::{...}`。

## 3. SSE 字节缓冲（SseDecoder）

```rust
pub struct SseDecoder { buf: Vec<u8> }
```

- `push(&mut self, chunk: &[u8]) -> Vec<String>`：追加字节，按 `\n`（0x0A）切完整行（0x0A 不会出现在 UTF-8 续字节中，按字节切安全），保留末尾不完整行。对每条完整行：去尾部 `\r`；若以 `data:` 开头，取冒号后内容 `trim_start`，收集为一条负载；忽略 `event:` / 空行 / 注释行（`:` 开头）。
- 负载值 `[DONE]`（OpenAI 终止哨兵）原样返回，由调用方识别。
- 调用方对每条负载 `serde_json::from_str::<Value>` 后喂给状态机；解析失败的非 `[DONE]` 负载按错误上抛或安全跳过（见 §7）。

## 4. Anthropic 状态机（AnthropicStreamState）

依据 `data:` JSON 的 `type` 字段分发（无需依赖 `event:` 行）：

- `content_block_start`：按 `index` 注册块。`content_block.type`：
  - `text` → 文本块。
  - `thinking` → 思考块（累积 `thinking` 文本 + 后续 `signature`）。
  - `tool_use` → 工具块，记录 `id` / `name`，`input` 初始为空，后续 `input_json_delta` 累积 `partial_json` 字符串。
- `content_block_delta`，按 `delta.type`：
  - `text_delta` → 返回 `StreamEvent::Text(text)`，累积进对应块。
  - `thinking_delta` → 返回 `StreamEvent::Thought(thinking)`，累积。
  - `signature_delta` → 累积 `signature` 到思考块（**不 emit**，仅用于回放）。
  - `input_json_delta` → 累积 `partial_json` 到工具块（**不 emit**）。
- `content_block_stop`：若为工具块，把累积的 `partial_json` 解析为 `arguments`（空串视作 `{}`），产出 `StreamEvent::ToolCallReady(ToolCall)`。
- `message_delta`：读取 `delta.stop_reason`（`tool_use` 表示需续轮）。
- `message_stop`：流结束。

### 4.1 续轮的 assistant content 重建（关键）

多轮 tool-use 时必须把本轮 assistant 的完整 content 回放进 messages。Anthropic 在**开启 thinking** 时有硬性约束：续轮的 assistant 消息**必须保留 thinking 块及其 `signature`**，否则 API 报 400。因此状态机在 `message_stop` 时按 `index` 顺序重建 content 数组：

```jsonc
[
  { "type": "thinking", "thinking": "...", "signature": "..." }, // 若有
  { "type": "text", "text": "..." },                              // 若有
  { "type": "tool_use", "id": "...", "name": "...", "input": {...} }
]
```

`AnthropicStreamState::into_assistant_content() -> Value` 产出该数组。续轮：

1. `messages.push({ role: "assistant", content: <重建数组> })`
2. `messages.push({ role: "user", content: [ {type:"tool_result", tool_use_id, content} ... ] })`（沿用现有 `LocalToolExecutor::execute`）

## 5. OpenAI 兼容状态机（OpenAiStreamState）

每条 `data:` 为一个 chunk，`choices[0].delta` 增量：

- `delta.content`（string）→ `StreamEvent::Text`，累积到 `content`。
- `delta.reasoning_content`（string，DeepSeek-R1 等）→ `StreamEvent::Thought`，累积到 `reasoning`（**仅展示，不回传**）。
- `delta.tool_calls[]`：按 `index` 累积；`id` / `function.name` 首次出现时记录，`function.arguments` 字符串分片持续拼接。
- `choices[0].finish_reason`：`tool_calls` 表示需续轮；流末尾 `data: [DONE]` 终止。

`finish_reason == "tool_calls"` 时，对每个累积完成的 tool_call 解析 arguments 产出 `ToolCallReady`。

### 5.1 续轮的 assistant message 重建

```jsonc
{ "role": "assistant", "content": "<累积text或null>",
  "tool_calls": [ { "id","type":"function","function": { "name","arguments":"<累积字符串>" } } ] }
```

随后每个 tool_call 追加 `{ role: "tool", tool_call_id, content }`。`reasoning_content` **不**进重建消息（OpenAI 不接受回传，且部分代理会 400）。

## 6. thinking 启用策略

- **Anthropic**：`build_messages_body` 增加 `thinking: { type: "enabled", budget_tokens: 2048 }`，并把 `max_tokens` 提到 `8192`（约束：`budget_tokens < max_tokens`）。当前 body 不设 `temperature`（thinking 要求 temperature 为 1 或不设），兼容。
  - 选 Claude provider 即用户声明端点为 Anthropic 协议；budget 取保守固定值，前端 EffortLevel 暂不透传（避免改 RunRequest 契约，留作后续）。
- **OpenAI 兼容**：无需请求参数；若上游模型（如 R1）自带 `reasoning_content` 则透传展示，普通模型无此字段即不展示，零副作用。

## 7. 错误处理

- HTTP 非 2xx：读完 body 文本，`Err(format!("...返回错误：HTTP {status} {body}"))`（与现状一致，前端 `errorMessage` 已能透出——见 fix-update-check 任务）。
- chunk 读取中断：`.chunk().await` 的 `Err` → `Err(format!("...流读取失败：{e}"))`。
- 单条 SSE 负载 JSON 解析失败：跳过该行（流式场景偶发半包已由 decoder 行缓冲消化；真正畸形行不应中断整轮），不上抛。
- `abort_if_cancelled`：每次 chunk 循环开头检查 `cancel`，命中返回 `Err("会话已停止")`（finish_sdk_turn 静默处理，现状逻辑不变）。

## 8. 测试（engine/tests 或 stream.rs #[cfg(test)]）

纯函数易测，喂入真实 SSE 负载序列断言：

- `sse_decoder_splits_across_chunks`：半行跨 chunk、`\r\n`、多 data 行。
- `anthropic_text_and_tool_stream`：text_delta 累积 + tool_use 的 input_json_delta 拼接 → ToolCallReady + 重建 content 含 tool_use。
- `anthropic_thinking_preserves_signature`：thinking_delta + signature_delta → 重建 content 首块为带 signature 的 thinking。
- `openai_text_reasoning_tool_stream`：content / reasoning_content / tool_calls 分片累积 + 重建 assistant message。
- `openai_done_sentinel_terminates`：`[DONE]` 终止。
- build_body 单测更新：anthropic body 含 `thinking` 且 `stream==true`、`max_tokens==8192`；openai body 含 `stream==true`。

## 9. 兼容与回滚

- 破坏性变更：请求体新增 `stream:true`（+ Anthropic `thinking`），响应路径从阻塞 `.json()` 改 SSE。不保留旧阻塞分支。
- 回滚点：改动集中在 `engine/`，`git checkout -- apps/desktop/src-tauri/src/code_assistant/engine/` 即回退；前端无改动不受影响。
- 风险：自定义 Anthropic 代理若不支持 `thinking` 参数可能 400 → 经 `errorMessage` 透出真实报错，用户可感知（不再是静默兜底）。
