use super::{normalize_tool_input, StreamItem};

#[derive(Default)]
pub(in crate::code_assistant) struct ClaudeStreamJsonState {
    emitted_text: String,
    emitted_thinking: String,
    tool_snapshots: Vec<ToolSnapshot>,
    saw_tool_delta: bool,
}

#[derive(Clone)]
struct ToolSnapshot {
    name: String,
    input_json: String,
}

impl ClaudeStreamJsonState {
    pub(in crate::code_assistant) fn items_for_line(&mut self, line: &str) -> Vec<StreamItem> {
        let items = extract_stream_json_items(line);
        if items.is_empty() {
            return items;
        }
        if stream_json_line_type(line).as_deref() == Some("assistant") {
            return self.delta_assistant_snapshot(items);
        }
        self.observe_incremental_items(&items);
        items
    }

    fn observe_incremental_items(&mut self, items: &[StreamItem]) {
        for item in items {
            match item {
                StreamItem::Text(text) => self.emitted_text.push_str(text),
                StreamItem::Thinking(text) => self.emitted_thinking.push_str(text),
                StreamItem::ToolUse { .. } => self.saw_tool_delta = true,
                StreamItem::Stderr(_) => {}
            }
        }
    }

    fn delta_assistant_snapshot(&mut self, items: Vec<StreamItem>) -> Vec<StreamItem> {
        let text_delta = self.replace_snapshot_text(&items, true);
        let thinking_delta = self.replace_snapshot_text(&items, false);
        let mut state = SnapshotPushState::new(&text_delta, &thinking_delta);
        for item in items {
            self.push_snapshot_item(item, &mut state);
        }
        if !state.next_tools.is_empty() {
            self.tool_snapshots = state.next_tools;
        }
        state.out
    }

    fn replace_snapshot_text(&mut self, items: &[StreamItem], text: bool) -> String {
        let snapshot = snapshot_text(items, text);
        let previous = if text {
            &self.emitted_text
        } else {
            &self.emitted_thinking
        };
        let delta = snapshot_suffix(previous, &snapshot);
        if text {
            self.emitted_text = snapshot;
        } else {
            self.emitted_thinking = snapshot;
        }
        delta
    }

    fn push_snapshot_item(&self, item: StreamItem, state: &mut SnapshotPushState<'_>) {
        match item {
            StreamItem::Text(_) if !state.emitted_text => state.push_text_delta(),
            StreamItem::Thinking(_) if !state.emitted_thinking => state.push_thinking_delta(),
            StreamItem::ToolUse { name, input_json } => {
                let snapshot = ToolSnapshot { name, input_json };
                if let Some(item) = self.delta_tool_snapshot(&snapshot, state.tool_index) {
                    state.out.push(item);
                }
                state.next_tools.push(snapshot);
                state.tool_index += 1;
            }
            StreamItem::Stderr(text) => state.out.push(StreamItem::Stderr(text)),
            StreamItem::Text(_) | StreamItem::Thinking(_) => {}
        }
    }

    fn delta_tool_snapshot(&self, snapshot: &ToolSnapshot, index: usize) -> Option<StreamItem> {
        if self.saw_tool_delta {
            return None;
        }
        delta_tool_snapshot(self.tool_snapshots.get(index), &snapshot)
    }
}

struct SnapshotPushState<'a> {
    out: Vec<StreamItem>,
    next_tools: Vec<ToolSnapshot>,
    tool_index: usize,
    text_delta: &'a str,
    thinking_delta: &'a str,
    emitted_text: bool,
    emitted_thinking: bool,
}

impl<'a> SnapshotPushState<'a> {
    fn new(text_delta: &'a str, thinking_delta: &'a str) -> Self {
        Self {
            out: Vec::new(),
            next_tools: Vec::new(),
            tool_index: 0,
            text_delta,
            thinking_delta,
            emitted_text: false,
            emitted_thinking: false,
        }
    }

    fn push_text_delta(&mut self) {
        self.emitted_text = true;
        push_text_delta(&mut self.out, self.text_delta);
    }

    fn push_thinking_delta(&mut self) {
        self.emitted_thinking = true;
        push_thinking_delta(&mut self.out, self.thinking_delta);
    }
}

fn stream_json_line_type(line: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(line.trim())
        .ok()?
        .get("type")
        .and_then(|value| value.as_str())
        .map(str::to_string)
}

fn snapshot_text(items: &[StreamItem], text: bool) -> String {
    items
        .iter()
        .filter_map(|item| match (text, item) {
            (true, StreamItem::Text(value)) => Some(value.as_str()),
            (false, StreamItem::Thinking(value)) => Some(value.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("")
}

fn snapshot_suffix(previous: &str, current: &str) -> String {
    if current.starts_with(previous) {
        current[previous.len()..].to_string()
    } else {
        current.to_string()
    }
}

fn delta_tool_snapshot(
    previous: Option<&ToolSnapshot>,
    current: &ToolSnapshot,
) -> Option<StreamItem> {
    if let Some(previous) = previous {
        if previous.name == current.name && current.input_json.starts_with(&previous.input_json) {
            let suffix = current.input_json[previous.input_json.len()..].to_string();
            return (!suffix.is_empty()).then(|| StreamItem::ToolUse {
                name: String::new(),
                input_json: suffix,
            });
        }
    }
    Some(StreamItem::ToolUse {
        name: current.name.clone(),
        input_json: current.input_json.clone(),
    })
}

fn push_text_delta(out: &mut Vec<StreamItem>, text: &str) {
    if !text.is_empty() {
        out.push(StreamItem::Text(text.to_string()));
    }
}

fn push_thinking_delta(out: &mut Vec<StreamItem>, text: &str) {
    if !text.is_empty() {
        out.push(StreamItem::Thinking(text.to_string()));
    }
}

pub(in crate::code_assistant) fn extract_stream_json_items(line: &str) -> Vec<StreamItem> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
        return Vec::new();
    };
    match value.get("type").and_then(|value| value.as_str()) {
        Some("assistant") => extract_assistant_items(&value),
        Some("stream_event") => extract_stream_event_items(&value),
        _ => Vec::new(),
    }
}

fn extract_assistant_items(value: &serde_json::Value) -> Vec<StreamItem> {
    let Some(content) = value
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(|content| content.as_array())
    else {
        return Vec::new();
    };
    content.iter().filter_map(assistant_block_item).collect()
}

fn assistant_block_item(block: &serde_json::Value) -> Option<StreamItem> {
    match block
        .get("type")
        .and_then(|value| value.as_str())
        .unwrap_or("")
    {
        "text" => text_item(block, "text", StreamItem::Text),
        "thinking" => text_item(block, "thinking", StreamItem::Thinking),
        "tool_use" => Some(StreamItem::ToolUse {
            name: string_field(block, "name").unwrap_or_default(),
            input_json: block
                .get("input")
                .map(normalize_tool_input)
                .unwrap_or_default(),
        }),
        _ => None,
    }
}

fn extract_stream_event_items(value: &serde_json::Value) -> Vec<StreamItem> {
    let Some(event) = value.get("event") else {
        return Vec::new();
    };
    match event.get("type").and_then(|value| value.as_str()) {
        Some("content_block_start") => extract_block_start(event),
        Some("content_block_delta") => extract_block_delta(event),
        _ => Vec::new(),
    }
}

fn extract_block_start(event: &serde_json::Value) -> Vec<StreamItem> {
    let Some(block) = event.get("content_block") else {
        return Vec::new();
    };
    if block.get("type").and_then(|value| value.as_str()) != Some("tool_use") {
        return Vec::new();
    }
    vec![StreamItem::ToolUse {
        name: string_field(block, "name").unwrap_or_default(),
        input_json: block
            .get("input")
            .map(normalize_tool_input)
            .unwrap_or_default(),
    }]
}

fn extract_block_delta(event: &serde_json::Value) -> Vec<StreamItem> {
    let Some(delta) = event.get("delta") else {
        return Vec::new();
    };
    match delta
        .get("type")
        .and_then(|value| value.as_str())
        .unwrap_or("")
    {
        "text_delta" => optional_text_item(delta, "text", StreamItem::Text),
        "thinking_delta" => optional_text_item(delta, "thinking", StreamItem::Thinking),
        "input_json_delta" => {
            optional_text_item(delta, "partial_json", |input_json| StreamItem::ToolUse {
                name: String::new(),
                input_json,
            })
        }
        _ => Vec::new(),
    }
}

fn optional_text_item<F>(value: &serde_json::Value, field: &str, build: F) -> Vec<StreamItem>
where
    F: FnOnce(String) -> StreamItem,
{
    text_item(value, field, build).into_iter().collect()
}

fn text_item<F>(value: &serde_json::Value, field: &str, build: F) -> Option<StreamItem>
where
    F: FnOnce(String) -> StreamItem,
{
    string_field(value, field)
        .filter(|text| !text.is_empty())
        .map(build)
}

fn string_field(value: &serde_json::Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(|value| value.as_str())
        .map(str::to_string)
}

#[allow(dead_code)]
pub(in crate::code_assistant) fn extract_stream_json_text(line: &str) -> Option<String> {
    let text = extract_stream_json_items(line)
        .into_iter()
        .filter_map(|item| match item {
            StreamItem::Text(text) => Some(text),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("");
    (!text.is_empty()).then_some(text)
}

pub(in crate::code_assistant) fn extract_stream_json_session_id(line: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    match value.get("type").and_then(|value| value.as_str())? {
        "system" | "result" => value
            .get("session_id")
            .and_then(|value| value.as_str())
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        _ => None,
    }
}
