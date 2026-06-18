# 执行计划 — 对话流式输出与思考工具展示

任务目录：`.trellis/tasks/06-18-chat-streaming-thinking-tools`
上下文阅读顺序：本任务 jsonl -> `prd.md` -> `design.md` -> 本文件。
改动范围：仅 `apps/desktop/src-tauri/src/code_assistant/engine/`（前端零改动）。

## 前置约束

- 不新增 Cargo 依赖：`reqwest::Response::chunk()` 已可增量读流，无需 `stream` feature。
- 破坏性替换：删除阻塞 `.json()` 路径，不保留旧分支、不做兼容开关。
- 流式分类语义对齐前端：`stdout`=正文、`stderr`=诊断、`thought`=思考增量、`tool`=工具调用；thought/tool 绝不混入 stdout。

## 实现清单（按序）

### 1. 新建 `engine/stream.rs`：SSE 行解码器

- [ ] `SseDecoder`：持有 `Vec<u8>` 缓冲；`push(&mut self, chunk: &[u8]) -> Vec<String>` 按 `\n` 切完整行（保留未完成尾巴），去 `\r`，仅返回 `data:` 行的 payload（去前缀与空白）。
- [ ] `[DONE]` 哨兵原样返回由调用方识别。
- [ ] 单测：`sse_decoder_splits_across_chunks`（半行跨 chunk / `\r\n` / 多 data 行 / 空行分隔）。

### 2. `engine/stream.rs`：Anthropic 状态机

- [ ] `StreamEvent` 枚举：`Text(String)` / `Thought(String)` / `ToolCallReady(ToolCall)`（ToolCall 复用 runtime 现有结构，必要时上移到 stream.rs 共享）。
- [ ] `AnthropicStreamState`：按 `index` 持有块（text/thinking{+signature}/tool_use{id,name,args_json_buf}）。
- [ ] `accept(&mut self, value: &Value) -> Vec<StreamEvent>`：按 `type` 分发 content_block_start/delta/stop、message_delta（记录 stop_reason）。
- [ ] `into_assistant_content(&self) -> Value`：按 index 顺序重建 `[thinking?, text?, tool_use*]`，thinking 块带 `signature`。
- [ ] `tool_calls(&self) -> Vec<ToolCall>` / `stop_reason`。
- [ ] 单测：`anthropic_text_and_tool_stream`、`anthropic_thinking_preserves_signature`。

### 3. `engine/stream.rs`：OpenAI 兼容状态机

- [ ] `OpenAiStreamState`：累积 `content` / `reasoning`（仅展示）/ `tool_calls`（按 index：id、name、arguments 分片拼接）/ `finish_reason`。
- [ ] `accept(&mut self, value: &Value) -> Vec<StreamEvent>`：解析 `choices[0].delta` 的 content / reasoning_content / tool_calls 分片。
- [ ] `into_assistant_message(&self) -> Value`：重建 `{role:assistant, content, tool_calls[]}`（不含 reasoning）。
- [ ] 单测：`openai_text_reasoning_tool_stream`、`openai_done_sentinel_terminates`。

### 4. 改 `engine/anthropic.rs` 与 `engine/openai.rs`：请求体

- [ ] anthropic `build_messages_body`：加 `"stream": true`、`"thinking": { "type":"enabled", "budget_tokens":2048 }`、`max_tokens` 提到 `8192`。
- [ ] openai `build_chat_body`：加 `"stream": true`。
- [ ] 更新两文件既有 body 单测断言（stream/thinking/max_tokens）。

### 5. 改 `engine/runtime.rs`：流式收发循环

- [ ] `run_claude`：`.send()` 后不再 `.json()`；`loop { response.chunk().await }` 喂 `SseDecoder` → 逐行 `serde_json::from_str` → `state.accept()` → 对返回的 `StreamEvent` 调 `sink.output("stdout"/"thought"/"tool", ...)`。
- [ ] 流结束后若 `stop_reason==tool_use`：用 `into_assistant_content()` + tool_result 追加 messages，进入下一轮外层 loop；否则返回 Ok。
- [ ] HTTP 非 2xx：读 body 文本拼错误返回（保持 `errorMessage` 可透出）。
- [ ] 每次 chunk 循环开头 `abort_if_cancelled`。
- [ ] `run_codex`：同构改造（OpenAiStreamState + `into_assistant_message()` + tool 续轮，`[DONE]` 终止）。
- [ ] 删除 `parse_anthropic_response` / `parse_openai_response` / `append_*_tool_round` 中被流式取代的死代码（保留 `LocalToolExecutor::execute` 调用）。
- [ ] `mod stream;` 注册到 engine 模块树。

## 校验命令（每步后增量跑，最终全跑）

```powershell
# Rust 编译（最关键，验证流式改造无编译错误）
cd apps/desktop/src-tauri; cargo check
# 引擎单测（SSE 解码 + 两状态机 + body 断言）
cargo test code_assistant::
# 全量 clippy（项目既有标准）
cargo clippy --all-targets
```

回到仓库根校验前端未受影响（应无改动，确认即可）：

```powershell
pnpm --filter @lingfang/desktop typecheck
```

## 审查门（Review Gates）

- 门1（步骤1-3 后）：`cargo test code_assistant::stream` 全绿 —— 纯函数状态机正确性是后续集成的地基。
- 门2（步骤4 后）：body 单测全绿 —— 请求契约正确（stream/thinking）才有意义跑集成。
- 门3（步骤5 后）：`cargo check` + `cargo clippy` 零错误零警告 —— 收发循环改造完成。

## 回滚点

- 任一步骤 `cargo check` 失败且两次修不好 → `git checkout -- apps/desktop/src-tauri/src/code_assistant/engine/` 回到改动前，回 design 复盘协议解析假设。
- 改动全集中在 `engine/`，前端与其它 Rust 模块零耦合，回滚不影响其它四个子任务成果。

## 完成定义（DoD）

- `cargo check` / `cargo clippy --all-targets` 零错误零警告。
- `cargo test code_assistant::` 全绿（含新增 SSE/状态机/body 单测）。
- 人工自检：Anthropic 与 OpenAI 两条 SSE 样例（含 thinking/reasoning + tool_use）经状态机产出预期 StreamEvent 序列与重建消息（由单测覆盖即可，无需真实网络）。
