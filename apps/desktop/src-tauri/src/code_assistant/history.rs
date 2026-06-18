use super::store::AssistantStore;

/// 整体字符限长截断，保留最近上下文，避免 Windows 命令行参数超限。
fn truncate_history(input: &str, max_chars: usize) -> String {
    tail(input, max_chars)
}

pub(crate) fn tail(input: &str, max_chars: usize) -> String {
    if input.chars().count() <= max_chars {
        return input.to_string();
    }
    let chars: Vec<char> = input.chars().collect();
    chars[chars.len().saturating_sub(max_chars)..]
        .iter()
        .collect()
}

pub(crate) fn build_history_summary(
    store: &AssistantStore,
    session_id: &str,
) -> Result<String, String> {
    let raw = store.read_transcript(session_id)?;
    let mut lines = Vec::new();
    for line in raw.lines() {
        append_summary_line(line, &mut lines);
    }
    Ok(truncate_history(&lines.join("\n\n"), 12_000))
}

fn append_summary_line(line: &str, lines: &mut Vec<String>) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
        return;
    };
    let event = value.get("event").and_then(|value| value.as_str());
    let payload = value.get("payload");
    match (event, payload) {
        (Some("input"), Some(payload)) => append_input_summary(payload, lines),
        (Some("output"), Some(payload)) => append_output_summary(payload, lines),
        _ => {}
    }
}

fn append_input_summary(payload: &serde_json::Value, lines: &mut Vec<String>) {
    let prompt = payload
        .get("prompt")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    if !prompt.trim().is_empty() {
        lines.push(format!("【用户】{prompt}"));
    }
}

fn append_output_summary(payload: &serde_json::Value, lines: &mut Vec<String>) {
    let stream = payload
        .get("stream")
        .and_then(|value| value.as_str())
        .unwrap_or("stdout");
    let text = payload
        .get("text")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    if text.trim().is_empty() {
        return;
    }
    match stream {
        "stdout" => lines.push(format!("【AI】{text}")),
        "stderr" => lines.push(format!("【诊断】{text}")),
        _ => {}
    }
}
