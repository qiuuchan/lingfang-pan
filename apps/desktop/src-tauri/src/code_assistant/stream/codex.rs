use super::{normalize_tool_input, StreamItem};

pub(in crate::code_assistant) fn extract_codex_json_items(line: &str) -> Vec<StreamItem> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
        return Vec::new();
    };
    match value.get("type").and_then(|value| value.as_str()) {
        Some("turn.failed") => turn_failed_items(&value),
        Some("error") => error_items(&value),
        Some("item.started" | "item.updated" | "item.completed") => value
            .get("item")
            .map(classify_codex_item)
            .unwrap_or_default(),
        Some("items") => batch_items(&value),
        _ => Vec::new(),
    }
}

fn turn_failed_items(value: &serde_json::Value) -> Vec<StreamItem> {
    let message = value
        .get("error")
        .and_then(|error| error.get("message"))
        .and_then(|message| message.as_str())
        .unwrap_or("codex 执行失败");
    vec![StreamItem::Stderr(format!("[turn.failed] {message}"))]
}

fn error_items(value: &serde_json::Value) -> Vec<StreamItem> {
    let message = value
        .get("message")
        .and_then(|message| message.as_str())
        .unwrap_or("codex 错误");
    vec![StreamItem::Stderr(format!("[error] {message}"))]
}

fn batch_items(value: &serde_json::Value) -> Vec<StreamItem> {
    value
        .get("items")
        .and_then(|items| items.as_array())
        .map(|items| items.iter().flat_map(classify_codex_item).collect())
        .unwrap_or_default()
}

fn classify_codex_item(item: &serde_json::Value) -> Vec<StreamItem> {
    match item
        .get("type")
        .and_then(|value| value.as_str())
        .unwrap_or("")
    {
        "agent_message" => agent_message_items(item),
        "agent_message_content_delta" => text_delta_item(item, "delta", StreamItem::Text),
        "reasoning" | "agent_reasoning" | "agent_reasoning_raw_content" => reasoning_items(item),
        "reasoning_content_delta" | "reasoning_raw_content_delta" => {
            text_delta_item(item, "delta", StreamItem::Thinking)
        }
        "local_shell_call" => local_shell_call_items(item),
        "function_call" => function_call_items(item),
        "mcp_tool_call" => mcp_tool_call_items(item),
        _ => Vec::new(),
    }
}

fn agent_message_items(item: &serde_json::Value) -> Vec<StreamItem> {
    item.get("content")
        .and_then(|content| content.as_array())
        .map(|content| content.iter().filter_map(agent_message_part).collect())
        .unwrap_or_default()
}

fn agent_message_part(part: &serde_json::Value) -> Option<StreamItem> {
    string_field(part, "text")
        .filter(|text| !text.is_empty())
        .map(StreamItem::Text)
}

fn reasoning_items(item: &serde_json::Value) -> Vec<StreamItem> {
    let summary_items = item
        .get("summary")
        .and_then(|summary| summary.as_array())
        .map(|summary| {
            summary
                .iter()
                .filter_map(reasoning_part)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if !summary_items.is_empty() {
        return summary_items;
    }
    string_field(item, "text")
        .filter(|text| !text.is_empty())
        .map(StreamItem::Thinking)
        .into_iter()
        .collect()
}

fn reasoning_part(part: &serde_json::Value) -> Option<StreamItem> {
    string_field(part, "text")
        .filter(|text| !text.is_empty())
        .map(StreamItem::Thinking)
}

fn text_delta_item<F>(item: &serde_json::Value, field: &str, build: F) -> Vec<StreamItem>
where
    F: FnOnce(String) -> StreamItem,
{
    string_field(item, field)
        .filter(|text| !text.is_empty())
        .map(build)
        .into_iter()
        .collect()
}

fn local_shell_call_items(item: &serde_json::Value) -> Vec<StreamItem> {
    let command = item
        .get("action")
        .and_then(|action| action.get("command"))
        .and_then(|command| command.as_str())
        .unwrap_or("");
    vec![StreamItem::ToolUse {
        name: "shell".to_string(),
        input_json: serde_json::json!({ "command": command }).to_string(),
    }]
}

fn function_call_items(item: &serde_json::Value) -> Vec<StreamItem> {
    vec![StreamItem::ToolUse {
        name: string_field(item, "name").unwrap_or_default(),
        input_json: item
            .get("arguments")
            .map(normalize_tool_input)
            .unwrap_or_default(),
    }]
}

fn mcp_tool_call_items(item: &serde_json::Value) -> Vec<StreamItem> {
    vec![StreamItem::ToolUse {
        name: string_field(item, "tool_name").unwrap_or_else(|| "mcp".to_string()),
        input_json: item
            .get("arguments")
            .map(normalize_tool_input)
            .unwrap_or_else(|| "{}".to_string()),
    }]
}

fn string_field(value: &serde_json::Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(|value| value.as_str())
        .map(str::to_string)
}
