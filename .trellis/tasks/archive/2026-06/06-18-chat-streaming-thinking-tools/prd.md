# 对话流式输出与思考/工具调用展示

## Goal

让内置 SDK Runtime 的对话支持真正的「流式输出 + 思考内容 + 工具调用」三项能力。当前 Rust 引擎用阻塞式 `.json()` 一次性取完整响应，文本在整段生成完毕后才一次性吐出，思考块完全未解析，工具调用也只在响应到齐后才展示。前端（PluginCreatorHome + AssistantChat）已具备 `stdout/stderr/thought/tool` 四类流的消费与渲染能力（ReasoningBlock / ToolBlock），缺口完全在 Rust 引擎侧。

本任务通过为 Anthropic（`/v1/messages`）与 OpenAI 兼容（`/v1/chat/completions`）两条通道接入 SSE 流式解析，把文本增量、思考增量、工具调用增量实时经 `EngineEventSink` 推送到前端，复用既有事件契约（`code-assistant://output` + `stream` 字段分类），实现打字机式输出、思考折叠展示与工具卡片实时呈现。

## Background（根因，已排查确认）

- [runtime.rs](../../../apps/desktop/src-tauri/src/code_assistant/engine/runtime.rs) `run_claude` / `run_codex`：用 `client.post(...).json(&body).send().await` 后 `.json()` 阻塞取完整响应，无流式。
- [anthropic.rs](../../../apps/desktop/src-tauri/src/code_assistant/engine/anthropic.rs) / [openai.rs](../../../apps/desktop/src-tauri/src/code_assistant/engine/openai.rs)：请求体未设 `stream: true`。
- `parse_anthropic_response` 只处理 `text` 与 `tool_use`，忽略 `thinking` 块；请求体也未开启 extended thinking。
- 前端 [PluginCreatorHome.tsx:268-291](../../../apps/desktop/src/pages/PluginCreatorHome.tsx) 已按 `payload.stream`（stdout/stderr/thought/tool）分发到 `liveSegments`，AssistantChat 已有 ReasoningBlock/ToolBlock 渲染——**前端无需改动**。
- `reqwest` 0.12 `Response::chunk()` 可增量读 body，**无需新增 Cargo feature/依赖**。

## Requirements

### 必须（MVP 完整功能，禁止占位）

1. **流式文本**：两条通道请求体设 `stream: true`，经 SSE 增量解析，文本 delta 逐段经 `sink.output("stdout", delta)` 推送，前端呈现打字机式输出。
2. **思考内容**：
   - Anthropic：开启 extended thinking，解析 `thinking_delta`，经 `sink.output("thought", delta)` 推送。
   - OpenAI 兼容：解析 delta 中的 `reasoning_content`（DeepSeek-R1 等推理模型字段），经 `sink.output("thought", delta)` 推送。
3. **工具调用**：流式累积工具调用（Anthropic `input_json_delta` / OpenAI `tool_calls[].function.arguments` 分片），单个调用累积完成后 `sink.output("tool", ...)` 展示，随后本地执行并把结果回填进下一轮请求，保持既有多轮 tool-use 循环语义。
4. **多轮工具循环不退化**：流式结束后能正确重建 assistant 轮的 content（Anthropic 须保留 thinking 块及其 signature，否则带工具的下一轮请求会被 API 拒绝），继续 tool-result 续轮，直至无工具调用收敛。
5. **取消语义保留**：流式读取循环中尊重 `request.cancel`，停止时与现状一致（不发 error）。
6. **错误透传**：非 2xx 响应、SSE 解析失败、网络中断均经 `Err(String)` 上抛，沿用现有 `finish_sdk_turn` 错误事件链路。

### 约束

- 不改前端代码（前端已就绪）；不改事件契约（`code-assistant://output` + `stream` 字段）。
- 不新增 Cargo 依赖（用 `reqwest::Response::chunk()` + 手写 SSE 行缓冲）。
- SSE 解析逻辑须抽成纯函数 / 状态机，可不依赖网络做单元测试（对齐 anthropic.rs/openai.rs 既有纯函数测试风格）。
- 简体中文注释，UTF-8 无 BOM。

## Non-Goals

- 不引入 WebSocket / 自定义二进制协议（继续用 Tauri event emit）。
- 不改 `LocalToolExecutor` 工具实现与工具定义清单。
- 不做 token 用量统计 / 成本展示。
- 不处理 Anthropic `redacted_thinking` 加密块的特殊 UI（按普通 thinking 文本处理或安全忽略）。

## Acceptance Criteria

- [ ] Anthropic 通道：`stream: true`，文本/思考/工具三类增量分别经 stdout/thought/tool 推送；多轮工具循环保留 thinking signature 不被 API 拒绝。
- [ ] OpenAI 兼容通道：`stream: true`，文本经 stdout、`reasoning_content` 经 thought、`tool_calls` 分片累积后经 tool 推送；多轮工具循环正常。
- [ ] 取消：流式途中置 `cancel` 能及时停止且不发 error 事件。
- [ ] 错误：非 2xx / 解析失败经 `Err(String)` 上抛，前端显示具体原因（与「检查更新」错误透传修复一致的可观测性）。
- [ ] 新增 SSE 解析器纯函数单元测试：覆盖 Anthropic（text/thinking/tool_use/signature 多块）与 OpenAI（content/reasoning_content/tool_calls 分片）典型事件序列，`cargo test` 通过。
- [ ] `cargo build`（或 `cargo check`）通过，无新增 warning。
- [ ] 前端 `tsc --noEmit` 与既有 desktop 测试不回归（理论上零改动）。

## 验证

- Rust：`cargo test`（SSE 解析器单测）+ `cargo check`（O:\lingfang-platform\apps\desktop\src-tauri）。
- 前端回归：`pnpm --filter @lingfang/desktop typecheck`。
- 手动冒烟（条件允许时）：配置 Anthropic / OpenAI 兼容 provider，发起对话观察打字机输出、思考折叠区、工具卡片实时出现。
