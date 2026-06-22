use super::store::AssistantStore;

// === Task 16：上下文压缩算法改进 ===
//
// 旧实现问题：
//   1. 整体 12k 字符尾部硬截断（tail），会在一条【AI】/【用户】行中间切断，破坏语义
//      （如把 manifest JSON 截一半，模型看到残缺上下文反而误导）。
//   2. 无单行限长：一轮超长输出（如生成大插件时 AI 倾泻完整 manifest + 多文件源码）可独占
//      12k 预算，把此前所有用户意图挤出上下文，模型「忘记」用户最初要什么。
//
// 改进：
//   - 单行限长（input 800 / output 2000 字符）：任何单轮不超占比，多轮上下文得以共存。
//   - 行边界感知的预算分配：从最近的行向前累加，直到达到总预算，保证不在行中间截断。
//   - 截断时前置 `[历史已压缩，仅保留最近 N 轮]` 标记，让模型知晓存在更早的上下文被省略，
//     避免它把保留部分当作「全部历史」而给出与早期需求冲突的输出。

/// 单条用户输入摘要的字符上限（避免一段超长 prompt 独占预算）。
const MAX_INPUT_LINE: usize = 800;
/// 单条 AI/诊断输出摘要的字符上限（生成大插件时输出可达数 KB，需收敛）。
const MAX_OUTPUT_LINE: usize = 2000;
/// 历史摘要总字符预算（防 Windows 命令行参数超限，与旧值一致）。
const MAX_TOTAL: usize = 12_000;
/// 截断标记（计入总预算，前置提示模型上下文已压缩）。
const TRUNC_MARKER: &str = "[历史已压缩，仅保留最近若干轮；如需更早需求请询问用户]";

/// 整体字符限长截断，保留最近上下文（保留以兼容 tests::tail 引用）。
pub(crate) fn tail(input: &str, max_chars: usize) -> String {
    if input.chars().count() <= max_chars {
        return input.to_string();
    }
    let chars: Vec<char> = input.chars().collect();
    chars[chars.len().saturating_sub(max_chars)..]
        .iter()
        .collect()
}

/// 把单行截到最多 `max` 字符（按 char 边界），超长尾部加省略号。
fn cap_line(s: &str, max: usize) -> String {
    let count = s.chars().count();
    if count <= max {
        return s.to_string();
    }
    let taken: String = s.chars().take(max.saturating_sub(1)).collect();
    format!("{taken}…")
}

/// 按「最近上下文优先 + 行边界不切断」把行列表拼接到总预算内。
/// 若全部行都在预算内，原样拼接；否则保留尾部若干行，并在开头加压缩标记。
fn join_with_budget(lines: &[String], max_chars: usize) -> String {
    let sep = "\n\n";
    let full = lines.join(sep);
    if full.chars().count() <= max_chars {
        return full;
    }
    // 预留标记长度；从尾部向前累加行直到耗尽预算。
    let budget = max_chars.saturating_sub(TRUNC_MARKER.chars().count() + sep.len());
    let mut kept: Vec<&str> = Vec::new();
    let mut remaining = budget;
    for line in lines.iter().rev() {
        let cost = line.chars().count() + sep.len();
        if remaining < line.chars().count() {
            break;
        }
        remaining = remaining.saturating_sub(cost);
        kept.push(line.as_str());
    }
    kept.reverse();
    if kept.is_empty() {
        // 极端：单行就超预算——退化为对最后一行做硬截断（保证非空）。复用 tail 保持非 test 构建也使用。
        if let Some(last) = lines.last() {
            return format!("{TRUNC_MARKER}{sep}{}", tail(last, budget));
        }
        return TRUNC_MARKER.to_string();
    }
    format!("{TRUNC_MARKER}{sep}{}", kept.join(sep))
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
    Ok(join_with_budget(&lines, MAX_TOTAL))
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
    let trimmed = prompt.trim();
    if !trimmed.is_empty() {
        // Task 16：单行限长，防超长 prompt 独占预算。
        lines.push(format!("【用户】{}", cap_line(trimmed, MAX_INPUT_LINE)));
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
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return;
    }
    match stream {
        // Task 16：单行限长，防生成大插件时的超长输出独占预算。
        "stdout" => lines.push(format!("【AI】{}", cap_line(trimmed, MAX_OUTPUT_LINE))),
        "stderr" => lines.push(format!("【诊断】{}", cap_line(trimmed, MAX_OUTPUT_LINE))),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cap_line_keeps_short_as_is() {
        assert_eq!(cap_line("短文本", 10), "短文本");
    }

    #[test]
    fn cap_line_truncates_long_with_ellipsis() {
        let s = "x".repeat(50);
        let capped = cap_line(&s, 10);
        assert_eq!(capped.chars().count(), 10);
        assert!(capped.ends_with('…'));
    }

    #[test]
    fn join_with_budget_keeps_all_when_under_limit() {
        let lines = vec!["【用户】a".to_string(), "【AI】b".to_string()];
        let out = join_with_budget(&lines, 1000);
        assert!(out.contains("【用户】a"));
        assert!(out.contains("【AI】b"));
        assert!(!out.contains(TRUNC_MARKER));
    }

    #[test]
    fn join_with_budget_marks_and_keeps_recent() {
        // 第一轮极长（会被裁），后两轮短（应保留）；预算触发截断且前置标记。
        let lines = vec![
            format!("【用户】第一轮：{}", "x".repeat(80)),
            "【AI】第二轮回复".to_string(),
            "【用户】第三轮最近的输入".to_string(),
        ];
        let out = join_with_budget(&lines, 60);
        assert!(out.starts_with(TRUNC_MARKER), "应前置压缩标记：{out}");
        assert!(out.contains("第三轮最近的输入"), "应保留最近轮：{out}");
        // 第一轮的超长内容应被整体裁掉（不应出现半截 x）。
        assert!(!out.contains('x'), "最早超长轮应被裁：{out}");
        assert!(out.chars().count() <= 60, "不应超预算：{}", out.chars().count());
    }

    #[test]
    fn join_with_budget_does_not_cut_mid_line() {
        // 即便预算落在某行中间，也按行边界裁剪——不会出现长行的残缺前缀。
        let long_line = "y".repeat(100);
        let lines = vec![long_line.clone(), "【AI】最近的简短回复".to_string()];
        let out = join_with_budget(&lines, 60);
        // 要么整行长行被裁（不出现），要么整行保留；不应出现「yyy…」半截。
        if out.contains('y') {
            assert!(out.contains(&long_line), "长行要么完整保留要么整体裁掉，不应半截：{out}");
        }
    }

    #[test]
    fn join_with_budget_single_oversize_line_falls_back_to_cap() {
        // 单行就超预算：回退到对该行硬截断（保证非空 + 标记）。
        let lines = vec!["z".repeat(200)];
        let out = join_with_budget(&lines, 60);
        assert!(out.starts_with(TRUNC_MARKER));
        assert!(out.chars().count() <= 60);
        assert!(out.contains('z'), "仍应保留部分内容：{out}");
    }
}
