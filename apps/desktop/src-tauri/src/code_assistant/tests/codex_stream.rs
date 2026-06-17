use super::*;

#[test]
fn codex_thread_started_yields_empty() {
    // 生命周期事件：丢弃（不展示）。
    let line = r#"{"type":"thread.started","thread_id":"019e-abc"}"#;
    assert!(extract_codex_json_items(line).is_empty());
}

#[test]
fn codex_turn_started_completed_yields_empty() {
    // 生命周期事件：丢弃。
    assert!(extract_codex_json_items(r#"{"type":"turn.started"}"#).is_empty());
    assert!(extract_codex_json_items(r#"{"type":"turn.completed"}"#).is_empty());
}

#[test]
fn codex_token_count_yields_empty() {
    // 用量统计：丢弃。
    let line = r#"{"type":"token_count","usage":{"input_tokens":10,"output_tokens":5}}"#;
    assert!(extract_codex_json_items(line).is_empty());
}

#[test]
fn codex_turn_failed_yields_stderr() {
    // turn.failed 含 error.message → Stderr（诊断区，不进 stdout）。
    let line =
        r#"{"type":"turn.failed","error":{"message":"unexpected status 402 Payment Required"}}"#;
    let items = extract_codex_json_items(line);
    assert_eq!(items.len(), 1);
    match &items[0] {
        StreamItem::Stderr(s) => {
            assert!(s.contains("402"), "应含错误信息：{s}");
            assert!(s.contains("turn.failed"), "应标注事件类型：{s}");
        }
        other => panic!("期望 Stderr，实际 {other:?}"),
    }
}

#[test]
fn codex_error_event_yields_stderr() {
    // error 事件（含 reconnecting 重连尝试）→ Stderr。
    let line = r#"{"type":"error","message":"Reconnecting... 1/5 (unexpected status 402)"}"#;
    let items = extract_codex_json_items(line);
    assert_eq!(items.len(), 1);
    match &items[0] {
        StreamItem::Stderr(s) => assert!(s.contains("Reconnecting"), "应含重连信息：{s}"),
        other => panic!("期望 Stderr，实际 {other:?}"),
    }
}

#[test]
fn codex_item_agent_message_yields_text() {
    // item.completed 含 agent_message（content[].text）→ Text（进 stdout）。
    let line = r#"{"type":"item.completed","item":{"type":"agent_message","content":[{"type":"output_text","text":"你好世界"}]}}"#;
    assert_eq!(
        extract_codex_json_items(line),
        vec![StreamItem::Text("你好世界".to_string())]
    );
}

#[test]
fn codex_item_agent_message_content_delta_yields_text() {
    // agent_message_content_delta（含 delta）→ Text 增量。
    let line = r#"{"type":"item.updated","item":{"type":"agent_message_content_delta","delta":"增量文本"}}"#;
    assert_eq!(
        extract_codex_json_items(line),
        vec![StreamItem::Text("增量文本".to_string())]
    );
}

#[test]
fn codex_item_reasoning_yields_thinking() {
    // item.completed 含 reasoning（summary[].text）→ Thinking（进 thought，不进 stdout）。
    let line = r#"{"type":"item.completed","item":{"type":"reasoning","summary":[{"type":"summary_text","text":"分析方案"}]}}"#;
    assert_eq!(
        extract_codex_json_items(line),
        vec![StreamItem::Thinking("分析方案".to_string())]
    );
}

#[test]
fn codex_item_reasoning_content_delta_yields_thinking() {
    // reasoning_content_delta → Thinking 增量。
    let line =
        r#"{"type":"item.updated","item":{"type":"reasoning_content_delta","delta":"推理中"}}"#;
    assert_eq!(
        extract_codex_json_items(line),
        vec![StreamItem::Thinking("推理中".to_string())]
    );
}

#[test]
fn codex_item_local_shell_call_yields_tool_use() {
    // local_shell_call（含 action.command）→ ToolUse{name:"shell"}。
    let line = r#"{"type":"item.completed","item":{"type":"local_shell_call","action":{"command":"ls -la"}}}"#;
    let items = extract_codex_json_items(line);
    assert_eq!(items.len(), 1);
    match &items[0] {
        StreamItem::ToolUse { name, input_json } => {
            assert_eq!(name, "shell");
            assert!(input_json.contains("ls -la"), "应含命令：{input_json}");
        }
        other => panic!("期望 ToolUse，实际 {other:?}"),
    }
}

#[test]
fn codex_item_function_call_yields_tool_use() {
    // function_call（含 name + arguments）→ ToolUse{name, input_json:arguments}。
    let line = r#"{"type":"item.completed","item":{"type":"function_call","name":"read_file","arguments":"{\"path\":\"a.ts\"}"}}"#;
    let items = extract_codex_json_items(line);
    assert_eq!(items.len(), 1);
    match &items[0] {
        StreamItem::ToolUse { name, input_json } => {
            assert_eq!(name, "read_file");
            assert!(input_json.contains("path"), "应含入参：{input_json}");
        }
        other => panic!("期望 ToolUse，实际 {other:?}"),
    }
}

#[test]
fn codex_item_mcp_tool_call_yields_tool_use() {
    // mcp_tool_call（含 tool_name + arguments）→ ToolUse{name:tool_name}。
    let line = r#"{"type":"item.completed","item":{"type":"mcp_tool_call","tool_name":"exa_search","arguments":{"query":"hello"}}}"#;
    let items = extract_codex_json_items(line);
    assert_eq!(items.len(), 1);
    match &items[0] {
        StreamItem::ToolUse { name, input_json } => {
            assert_eq!(name, "exa_search");
            assert!(input_json.contains("query"), "应含入参：{input_json}");
        }
        other => panic!("期望 ToolUse，实际 {other:?}"),
    }
}

#[test]
fn codex_items_batch_event_classifies_each() {
    // items 批量事件：逐项分类（兜底路径）。
    let line = r#"{"type":"items","items":[{"type":"agent_message","content":[{"type":"output_text","text":"A"}]},{"type":"reasoning","summary":[{"type":"summary_text","text":"B"}]}]}"#;
    let items = extract_codex_json_items(line);
    assert_eq!(
        items,
        vec![
            StreamItem::Text("A".to_string()),
            StreamItem::Thinking("B".to_string()),
        ]
    );
}

#[test]
fn codex_unknown_event_type_yields_empty() {
    // 未知事件类型（codex 版本新增）→ 容忍丢弃，不报错。
    let line = r#"{"type":"some_future_event","data":"x"}"#;
    assert!(extract_codex_json_items(line).is_empty());
}

#[test]
fn codex_invalid_json_yields_empty() {
    // 非 JSON / 空行 → 容忍，返回空 Vec。
    assert!(extract_codex_json_items("not json").is_empty());
    assert!(extract_codex_json_items("").is_empty());
}

#[test]
fn codex_text_filter_excludes_thinking_and_tool_and_stderr() {
    // 关键不变量：codex 解析结果中 thinking/tool/stderr 绝不进 stdout（协议解析依赖）。
    // 用 stream_item_to_pair 验证路由：仅 Text → stdout，其余 → 各自独立流。
    let thinking = StreamItem::Thinking("思考".to_string());
    let tool = StreamItem::ToolUse {
        name: "shell".to_string(),
        input_json: "{}".to_string(),
    };
    let stderr = StreamItem::Stderr("[error] boom".to_string());
    let text = StreamItem::Text("正文".to_string());
    assert_eq!(
        stream_item_to_pair(thinking),
        Some(("thought", "思考".to_string()))
    );
    assert_eq!(
        stream_item_to_pair(tool),
        Some(("tool", "shell {}".to_string()))
    );
    assert_eq!(
        stream_item_to_pair(stderr),
        Some(("stderr", "[error] boom".to_string()))
    );
    assert_eq!(
        stream_item_to_pair(text),
        Some(("stdout", "正文".to_string()))
    );
}
