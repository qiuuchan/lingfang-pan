use super::*;

// === design §3.3.5：build_history_summary 伪多轮数据源 ===

#[test]
fn summary_includes_user_and_ai() {
    let store = temp_assistant_store("summary-basic");
    store
        .append_transcript("s1", "input", json!({ "prompt": "做一个番茄钟" }))
        .unwrap();
    store
        .append_transcript(
            "s1",
            "output",
            json!({ "stream": "stdout", "text": "已生成番茄钟插件" }),
        )
        .unwrap();
    let summary = build_history_summary(&store, "s1").unwrap();
    assert!(summary.contains("【用户】做一个番茄钟"), "{summary}");
    assert!(summary.contains("【AI】已生成番茄钟插件"), "{summary}");
}

// 修复 RUST-STREAM-01（medium 数据一致性）：伪多轮历史摘要必须按 stream 过滤，
// 仅 stdout 进【AI】，stderr 进【诊断】，thought/tool 不进摘要（避免污染 LLM 上下文）。
#[test]
fn summary_filters_output_by_stream() {
    let store = temp_assistant_store("summary-stream-filter");
    store
        .append_transcript("s4", "input", json!({ "prompt": "做番茄钟" }))
        .unwrap();
    // stdout 正文 → 进【AI】。
    store
        .append_transcript(
            "s4",
            "output",
            json!({ "stream": "stdout", "text": "好的，已生成" }),
        )
        .unwrap();
    // stderr 诊断 → 进【诊断】而非【AI】。
    store
        .append_transcript(
            "s4",
            "output",
            json!({ "stream": "stderr", "text": "deprecation warning" }),
        )
        .unwrap();
    // thought 思考原文 → 不进摘要。
    store
        .append_transcript(
            "s4",
            "output",
            json!({ "stream": "thought", "text": "正在思考方案" }),
        )
        .unwrap();
    // tool 工具调用 JSON 片段（含不完整 input_json_delta）→ 不进摘要。
    store
        .append_transcript(
            "s4",
            "output",
            json!({ "stream": "tool", "text": "Read {\"path\":\"b" }),
        )
        .unwrap();
    let summary = build_history_summary(&store, "s4").unwrap();
    // stdout 进【AI】。
    assert!(summary.contains("【AI】好的，已生成"), "{summary}");
    // stderr 进【诊断】而非【AI】（不与正文混为同类）。
    assert!(summary.contains("【诊断】deprecation warning"), "{summary}");
    assert!(
        !summary.contains("【AI】deprecation warning"),
        "stderr 不应进【AI】：{summary}"
    );
    // thought / tool 不应进摘要（claude 降级伪多轮路径的污染源）。
    assert!(
        !summary.contains("正在思考方案"),
        "thought 不应进伪多轮历史：{summary}"
    );
    assert!(
        !summary.contains("Read {\"path\":\"b"),
        "tool 片段不应进伪多轮历史：{summary}"
    );
}

#[test]
fn summary_truncates_when_too_long() {
    let store = temp_assistant_store("summary-truncate");
    // 喂超长历史（>12k 字符）。
    let big = "x".repeat(8_000);
    store
        .append_transcript("s2", "input", json!({ "prompt": big.clone() }))
        .unwrap();
    store
        .append_transcript("s2", "output", json!({ "text": big }))
        .unwrap();
    let summary = build_history_summary(&store, "s2").unwrap();
    // 整体限长 12k 字符（防 Windows 命令行参数超限）。
    assert!(
        summary.chars().count() <= 12_000,
        "summary len = {}",
        summary.chars().count()
    );
    assert!(!summary.is_empty());
}

#[test]
fn summary_skips_empty_and_followup_input() {
    let store = temp_assistant_store("summary-filter");
    // 空 prompt 跳过。
    store
        .append_transcript("s3", "input", json!({ "prompt": "  " }))
        .unwrap();
    // followup 追问 input 不进历史（由追问 prompt 本身提供，避免重复）。
    store
        .append_transcript(
            "s3",
            "input",
            json!({ "prompt": "把按钮改红", "kind": "followup" }),
        )
        .unwrap();
    store
        .append_transcript("s3", "input", json!({ "prompt": "做一个番茄钟" }))
        .unwrap();
    store
        .append_transcript("s3", "output", json!({ "text": "" }))
        .unwrap();
    let summary = build_history_summary(&store, "s3").unwrap();
    assert!(summary.contains("【用户】做一个番茄钟"));
    assert!(!summary.contains("把按钮改红"));
}
