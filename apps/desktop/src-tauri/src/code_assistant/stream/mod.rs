mod claude;
mod codex;

pub(super) use claude::{
    extract_stream_json_items, extract_stream_json_session_id, extract_stream_json_text,
    ClaudeStreamJsonState,
};
pub(super) use codex::extract_codex_json_items;

#[derive(Clone, Copy)]
pub(super) enum OutputFormat {
    Plain,
    StreamJson,
    CodexJson,
}

#[derive(Debug, Clone, PartialEq)]
pub(super) enum StreamItem {
    Text(String),
    Thinking(String),
    ToolUse { name: String, input_json: String },
    Stderr(String),
}

pub(super) fn stream_item_to_pair(item: StreamItem) -> Option<(&'static str, String)> {
    match item {
        StreamItem::Text(text) if !text.is_empty() => Some(("stdout", text)),
        StreamItem::Thinking(thinking) if !thinking.is_empty() => Some(("thought", thinking)),
        StreamItem::Stderr(text) if !text.is_empty() => Some(("stderr", text)),
        StreamItem::ToolUse { name, input_json } => tool_item_to_pair(name, input_json),
        _ => None,
    }
}

fn tool_item_to_pair(name: String, input_json: String) -> Option<(&'static str, String)> {
    let merged = if name.is_empty() {
        input_json
    } else {
        format!("{name} {input_json}").trim().to_string()
    };
    (!merged.is_empty()).then_some(("tool", merged))
}

pub(super) fn normalize_tool_input(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(text) => text.clone(),
        serde_json::Value::Null => "{}".to_string(),
        serde_json::Value::Object(_) | serde_json::Value::Array(_) => value.to_string(),
        other => other.to_string(),
    }
}
