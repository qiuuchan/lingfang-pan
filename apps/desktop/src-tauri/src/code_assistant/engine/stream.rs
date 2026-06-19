//! SSE 流式解析：把 Anthropic（/v1/messages）与 OpenAI 兼容（/v1/chat/completions）
//! 两条通道的服务端事件流解码为可单测的增量事件。
//!
//! 设计要点：
//! - 解析逻辑全部抽成纯函数 / 状态机，不依赖网络，便于单元测试。
//! - `SseDecoder` 负责字节流到 SSE `data:` 负载行的切分（处理跨 chunk 半行与 `\r\n`）。
//! - 两个状态机按各自协议累积文本 / 思考 / 工具调用增量，并在续轮时重建 assistant 消息。

use std::collections::BTreeMap;

use serde_json::{json, Value};

/// OpenAI 兼容流的终止哨兵。
pub const DONE_SENTINEL: &str = "[DONE]";

/// 单次工具调用：id、名称与解析后的参数。两条通道共用。
#[derive(Clone, Debug, PartialEq)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

/// 状态机解析产出的增量事件。仅这三类需要经 sink 推送到前端。
#[derive(Clone, Debug, PartialEq)]
pub enum StreamEvent {
    /// 正文增量（→ stdout）。
    Text(String),
    /// 思考增量（→ thought）。
    Thought(String),
    /// 单个工具调用累积完成（→ tool，随后本地执行）。
    ToolCallReady(ToolCall),
}

/// SSE 字节缓冲：把任意切分的字节流还原为完整的 `data:` 负载行。
#[derive(Default)]
pub struct SseDecoder {
    buf: Vec<u8>,
}

impl SseDecoder {
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    /// 追加一段字节，返回本次能凑齐的所有 `data:` 负载（去前缀与首部空白）。
    /// 末尾不完整的行保留在缓冲里等待下次补齐。`\n`（0x0A）不会出现在 UTF-8
    /// 续字节中，按字节切行安全。
    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        let mut consumed = 0;
        while let Some(rel) = self.buf[consumed..].iter().position(|&b| b == b'\n') {
            let line_end = consumed + rel;
            let mut line = &self.buf[consumed..line_end];
            if line.last() == Some(&b'\r') {
                line = &line[..line.len() - 1];
            }
            if let Some(payload) = parse_sse_line(line) {
                out.push(payload);
            }
            consumed = line_end + 1;
        }
        if consumed > 0 {
            self.buf.drain(0..consumed);
        }
        out
    }
}

/// 解析单条 SSE 行：仅 `data:` 行返回负载，`event:` / 空行 / 注释行（`:` 开头）忽略。
fn parse_sse_line(line: &[u8]) -> Option<String> {
    const PREFIX: &[u8] = b"data:";
    if line.len() >= PREFIX.len() && &line[..PREFIX.len()] == PREFIX {
        let rest = &line[PREFIX.len()..];
        Some(String::from_utf8_lossy(rest).trim_start().to_string())
    } else {
        None
    }
}

/// 把累积的工具参数字符串解析为 JSON；空串视作 `{}`，畸形串安全降级为 `{}`。
fn parse_args(raw: &str) -> Value {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return json!({});
    }
    serde_json::from_str(trimmed).unwrap_or_else(|_| json!({}))
}

fn string_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

// ===================== Anthropic 状态机 =====================

/// Anthropic content block 的累积形态，按响应内 `index` 顺序排列。
enum AnthBlock {
    Text {
        text: String,
    },
    Thinking {
        thinking: String,
        signature: String,
    },
    ToolUse {
        id: String,
        name: String,
        args_buf: String,
    },
}

/// Anthropic SSE 状态机：按 `data:` JSON 的 `type` 字段驱动，无需依赖 `event:` 行。
#[derive(Default)]
pub struct AnthropicStreamState {
    blocks: BTreeMap<usize, AnthBlock>,
    stop_reason: Option<String>,
}

impl AnthropicStreamState {
    pub fn new() -> Self {
        Self {
            blocks: BTreeMap::new(),
            stop_reason: None,
        }
    }

    /// 喂入一条已解析的 SSE JSON，返回需经 sink 推送的增量事件。
    pub fn accept(&mut self, value: &Value) -> Vec<StreamEvent> {
        let mut events = Vec::new();
        match value.get("type").and_then(Value::as_str) {
            Some("content_block_start") => self.on_block_start(value),
            Some("content_block_delta") => self.on_block_delta(value, &mut events),
            Some("content_block_stop") => self.on_block_stop(value, &mut events),
            Some("message_delta") => {
                if let Some(reason) = value["delta"].get("stop_reason").and_then(Value::as_str) {
                    self.stop_reason = Some(reason.to_string());
                }
            }
            _ => {}
        }
        events
    }

    fn on_block_start(&mut self, value: &Value) {
        let index = value.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
        let block = &value["content_block"];
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                self.blocks.insert(
                    index,
                    AnthBlock::Text {
                        text: String::new(),
                    },
                );
            }
            Some("thinking") => {
                self.blocks.insert(
                    index,
                    AnthBlock::Thinking {
                        thinking: String::new(),
                        signature: String::new(),
                    },
                );
            }
            Some("tool_use") => {
                self.blocks.insert(
                    index,
                    AnthBlock::ToolUse {
                        id: string_field(block, "id"),
                        name: string_field(block, "name"),
                        args_buf: String::new(),
                    },
                );
            }
            _ => {}
        }
    }

    fn on_block_delta(&mut self, value: &Value, events: &mut Vec<StreamEvent>) {
        let index = value.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
        let delta = &value["delta"];
        match delta.get("type").and_then(Value::as_str) {
            Some("text_delta") => {
                if let Some(part) = delta.get("text").and_then(Value::as_str) {
                    if let Some(AnthBlock::Text { text }) = self.blocks.get_mut(&index) {
                        text.push_str(part);
                    }
                    events.push(StreamEvent::Text(part.to_string()));
                }
            }
            Some("thinking_delta") => {
                if let Some(part) = delta.get("thinking").and_then(Value::as_str) {
                    if let Some(AnthBlock::Thinking { thinking, .. }) = self.blocks.get_mut(&index)
                    {
                        thinking.push_str(part);
                    }
                    events.push(StreamEvent::Thought(part.to_string()));
                }
            }
            Some("signature_delta") => {
                // 签名仅用于续轮回放，不向前端 emit。
                if let Some(part) = delta.get("signature").and_then(Value::as_str) {
                    if let Some(AnthBlock::Thinking { signature, .. }) = self.blocks.get_mut(&index)
                    {
                        signature.push_str(part);
                    }
                }
            }
            Some("input_json_delta") => {
                // 工具参数分片累积，不向前端 emit（完成时一次性产出 ToolCallReady）。
                if let Some(part) = delta.get("partial_json").and_then(Value::as_str) {
                    if let Some(AnthBlock::ToolUse { args_buf, .. }) = self.blocks.get_mut(&index) {
                        args_buf.push_str(part);
                    }
                }
            }
            _ => {}
        }
    }

    fn on_block_stop(&mut self, value: &Value, events: &mut Vec<StreamEvent>) {
        let index = value.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
        if let Some(AnthBlock::ToolUse { id, name, args_buf }) = self.blocks.get(&index) {
            events.push(StreamEvent::ToolCallReady(ToolCall {
                id: id.clone(),
                name: name.clone(),
                arguments: parse_args(args_buf),
            }));
        }
    }

    /// 重建续轮所需的 assistant content 数组，按 index 顺序输出
    /// `[thinking?, text?, tool_use*]`。thinking 块必须带 `signature`，
    /// 否则带工具的下一轮请求会被 Anthropic 拒绝（400）。
    pub fn into_assistant_content(&self) -> Value {
        let mut content = Vec::new();
        for block in self.blocks.values() {
            match block {
                AnthBlock::Thinking {
                    thinking,
                    signature,
                } => {
                    content.push(json!({
                        "type": "thinking",
                        "thinking": thinking,
                        "signature": signature,
                    }));
                }
                AnthBlock::Text { text } => {
                    if !text.is_empty() {
                        content.push(json!({ "type": "text", "text": text }));
                    }
                }
                AnthBlock::ToolUse { id, name, args_buf } => {
                    content.push(json!({
                        "type": "tool_use",
                        "id": id,
                        "name": name,
                        "input": parse_args(args_buf),
                    }));
                }
            }
        }
        Value::Array(content)
    }

    /// 本轮累积出的全部工具调用，供本地执行。
    pub fn tool_calls(&self) -> Vec<ToolCall> {
        self.blocks
            .values()
            .filter_map(|block| match block {
                AnthBlock::ToolUse { id, name, args_buf } => Some(ToolCall {
                    id: id.clone(),
                    name: name.clone(),
                    arguments: parse_args(args_buf),
                }),
                _ => None,
            })
            .collect()
    }

    pub fn stop_reason(&self) -> Option<&str> {
        self.stop_reason.as_deref()
    }
}

// ===================== OpenAI 兼容状态机 =====================

/// OpenAI 兼容 tool_call 的分片累积形态。
#[derive(Default)]
struct OpenAiToolAccum {
    id: String,
    name: String,
    arguments: String,
}

/// OpenAI 兼容 SSE 状态机：解析 `choices[0].delta` 的增量字段。
#[derive(Default)]
pub struct OpenAiStreamState {
    content: String,
    reasoning: String,
    tool_calls: BTreeMap<usize, OpenAiToolAccum>,
    finish_reason: Option<String>,
}

impl OpenAiStreamState {
    pub fn new() -> Self {
        Self::default()
    }

    /// 喂入一条已解析的 chunk JSON，返回需经 sink 推送的增量事件。
    pub fn accept(&mut self, value: &Value) -> Vec<StreamEvent> {
        let mut events = Vec::new();
        let choice = &value["choices"][0];
        let delta = &choice["delta"];

        if let Some(content) = delta.get("content").and_then(Value::as_str) {
            if !content.is_empty() {
                self.content.push_str(content);
                events.push(StreamEvent::Text(content.to_string()));
            }
        }
        // DeepSeek-R1 等推理模型的思考字段，仅展示不回传。
        if let Some(reasoning) = delta.get("reasoning_content").and_then(Value::as_str) {
            if !reasoning.is_empty() {
                self.reasoning.push_str(reasoning);
                events.push(StreamEvent::Thought(reasoning.to_string()));
            }
        }
        for tc in delta
            .get("tool_calls")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let index = tc.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
            let entry = self.tool_calls.entry(index).or_default();
            if let Some(id) = tc.get("id").and_then(Value::as_str) {
                if !id.is_empty() {
                    entry.id = id.to_string();
                }
            }
            let func = &tc["function"];
            if let Some(name) = func.get("name").and_then(Value::as_str) {
                if !name.is_empty() {
                    entry.name = name.to_string();
                }
            }
            if let Some(args) = func.get("arguments").and_then(Value::as_str) {
                entry.arguments.push_str(args);
            }
        }
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            self.finish_reason = Some(reason.to_string());
            if reason == "tool_calls" {
                for call in self.tool_calls() {
                    events.push(StreamEvent::ToolCallReady(call));
                }
            }
        }
        events
    }

    /// 重建续轮的 assistant message：`{role, content, tool_calls[]}`。
    /// 不含 reasoning_content（OpenAI 不接受回传，部分代理会 400）。
    pub fn into_assistant_message(&self) -> Value {
        let mut message = json!({ "role": "assistant" });
        message["content"] = if self.content.is_empty() {
            Value::Null
        } else {
            Value::String(self.content.clone())
        };
        let calls = self.tool_calls();
        if !calls.is_empty() {
            let tool_calls = calls
                .iter()
                .map(|call| {
                    json!({
                        "id": call.id,
                        "type": "function",
                        "function": {
                            "name": call.name,
                            "arguments": serde_json::to_string(&call.arguments)
                                .unwrap_or_else(|_| "{}".to_string()),
                        }
                    })
                })
                .collect::<Vec<_>>();
            message["tool_calls"] = Value::Array(tool_calls);
        }
        message
    }

    /// 本轮累积出的全部工具调用，供本地执行。
    pub fn tool_calls(&self) -> Vec<ToolCall> {
        self.tool_calls
            .values()
            .map(|tool| ToolCall {
                id: tool.id.clone(),
                name: tool.name.clone(),
                arguments: parse_args(&tool.arguments),
            })
            .collect()
    }

    pub fn finish_reason(&self) -> Option<&str> {
        self.finish_reason.as_deref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payloads(decoder: &mut SseDecoder, chunk: &str) -> Vec<String> {
        decoder.push(chunk.as_bytes())
    }

    #[test]
    fn sse_decoder_splits_across_chunks() {
        let mut decoder = SseDecoder::new();

        // 半行跨 chunk：第一段不完整，第二段补齐。
        assert!(payloads(&mut decoder, "data: {\"a\":").is_empty());
        let out = payloads(&mut decoder, "1}\n");
        assert_eq!(out, vec!["{\"a\":1}".to_string()]);

        // \r\n 行尾 + event: 行忽略 + 空行分隔 + 多 data 行。
        let out = payloads(
            &mut decoder,
            "event: message\r\ndata: one\r\n\r\ndata: two\n: comment\n",
        );
        assert_eq!(out, vec!["one".to_string(), "two".to_string()]);
    }

    #[test]
    fn sse_decoder_passes_done_sentinel() {
        let mut decoder = SseDecoder::new();
        let out = payloads(&mut decoder, "data: [DONE]\n");
        assert_eq!(out, vec![DONE_SENTINEL.to_string()]);
    }

    #[test]
    fn anthropic_text_and_tool_stream() {
        let mut state = AnthropicStreamState::new();
        let mut events = Vec::new();

        let seq = [
            json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "text", "text": "" } }),
            json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": "你好" } }),
            json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": "世界" } }),
            json!({ "type": "content_block_start", "index": 1, "content_block": { "type": "tool_use", "id": "toolu_1", "name": "read_file", "input": {} } }),
            json!({ "type": "content_block_delta", "index": 1, "delta": { "type": "input_json_delta", "partial_json": "{\"path\":" } }),
            json!({ "type": "content_block_delta", "index": 1, "delta": { "type": "input_json_delta", "partial_json": "\"a.txt\"}" } }),
            json!({ "type": "content_block_stop", "index": 1 }),
            json!({ "type": "message_delta", "delta": { "stop_reason": "tool_use" } }),
            json!({ "type": "message_stop" }),
        ];
        for value in &seq {
            events.extend(state.accept(value));
        }

        assert_eq!(
            events,
            vec![
                StreamEvent::Text("你好".to_string()),
                StreamEvent::Text("世界".to_string()),
                StreamEvent::ToolCallReady(ToolCall {
                    id: "toolu_1".to_string(),
                    name: "read_file".to_string(),
                    arguments: json!({ "path": "a.txt" }),
                }),
            ]
        );
        assert_eq!(state.stop_reason(), Some("tool_use"));

        let calls = state.tool_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].arguments, json!({ "path": "a.txt" }));

        let content = state.into_assistant_content();
        let array = content.as_array().unwrap();
        assert_eq!(array[0]["type"], "text");
        assert_eq!(array[0]["text"], "你好世界");
        assert_eq!(array[1]["type"], "tool_use");
        assert_eq!(array[1]["id"], "toolu_1");
        assert_eq!(array[1]["input"], json!({ "path": "a.txt" }));
    }

    #[test]
    fn anthropic_thinking_preserves_signature() {
        let mut state = AnthropicStreamState::new();
        let mut events = Vec::new();

        let seq = [
            json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "thinking", "thinking": "" } }),
            json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "thinking_delta", "thinking": "让我想想" } }),
            json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "signature_delta", "signature": "sig-abc" } }),
            json!({ "type": "content_block_start", "index": 1, "content_block": { "type": "text", "text": "" } }),
            json!({ "type": "content_block_delta", "index": 1, "delta": { "type": "text_delta", "text": "答案" } }),
            json!({ "type": "message_delta", "delta": { "stop_reason": "end_turn" } }),
        ];
        for value in &seq {
            events.extend(state.accept(value));
        }

        // signature_delta 不应产生 emit 事件。
        assert_eq!(
            events,
            vec![
                StreamEvent::Thought("让我想想".to_string()),
                StreamEvent::Text("答案".to_string()),
            ]
        );

        let content = state.into_assistant_content();
        let array = content.as_array().unwrap();
        assert_eq!(array[0]["type"], "thinking");
        assert_eq!(array[0]["thinking"], "让我想想");
        assert_eq!(array[0]["signature"], "sig-abc");
        assert_eq!(array[1]["type"], "text");
        assert_eq!(array[1]["text"], "答案");
        assert_eq!(state.stop_reason(), Some("end_turn"));
    }

    #[test]
    fn openai_text_reasoning_tool_stream() {
        let mut state = OpenAiStreamState::new();
        let mut events = Vec::new();

        let seq = [
            json!({ "choices": [ { "index": 0, "delta": { "reasoning_content": "推理中" } } ] }),
            json!({ "choices": [ { "index": 0, "delta": { "content": "正文" } } ] }),
            json!({ "choices": [ { "index": 0, "delta": { "tool_calls": [ { "index": 0, "id": "call_1", "type": "function", "function": { "name": "write_file", "arguments": "" } } ] } } ] }),
            json!({ "choices": [ { "index": 0, "delta": { "tool_calls": [ { "index": 0, "function": { "arguments": "{\"path\":\"b.txt\"," } } ] } } ] }),
            json!({ "choices": [ { "index": 0, "delta": { "tool_calls": [ { "index": 0, "function": { "arguments": "\"content\":\"x\"}" } } ] } } ] }),
            json!({ "choices": [ { "index": 0, "delta": {}, "finish_reason": "tool_calls" } ] }),
        ];
        for value in &seq {
            events.extend(state.accept(value));
        }

        assert_eq!(
            events,
            vec![
                StreamEvent::Thought("推理中".to_string()),
                StreamEvent::Text("正文".to_string()),
                StreamEvent::ToolCallReady(ToolCall {
                    id: "call_1".to_string(),
                    name: "write_file".to_string(),
                    arguments: json!({ "path": "b.txt", "content": "x" }),
                }),
            ]
        );
        assert_eq!(state.finish_reason(), Some("tool_calls"));

        let message = state.into_assistant_message();
        assert_eq!(message["role"], "assistant");
        assert_eq!(message["content"], "正文");
        // reasoning_content 不进重建消息。
        assert!(message.get("reasoning_content").is_none());
        assert_eq!(message["tool_calls"][0]["id"], "call_1");
        assert_eq!(message["tool_calls"][0]["type"], "function");
        assert_eq!(message["tool_calls"][0]["function"]["name"], "write_file");
        let raw_args = message["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .unwrap();
        let parsed: Value = serde_json::from_str(raw_args).unwrap();
        assert_eq!(parsed, json!({ "path": "b.txt", "content": "x" }));
    }

    #[test]
    fn openai_done_sentinel_terminates() {
        // 普通正文 chunk 后跟 [DONE] 哨兵：哨兵由 decoder 原样返回，
        // 由调用方识别终止，不应被当作 JSON 解析。
        let mut decoder = SseDecoder::new();
        let mut state = OpenAiStreamState::new();
        let mut events = Vec::new();
        let mut terminated = false;

        for payload in decoder.push(
            b"data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hi\"}}]}\n\ndata: [DONE]\n\n",
        ) {
            if payload == DONE_SENTINEL {
                terminated = true;
                break;
            }
            let value: Value = serde_json::from_str(&payload).unwrap();
            events.extend(state.accept(&value));
        }

        assert!(terminated);
        assert_eq!(events, vec![StreamEvent::Text("hi".to_string())]);
        assert_eq!(state.into_assistant_message()["content"], "hi");
    }
}
