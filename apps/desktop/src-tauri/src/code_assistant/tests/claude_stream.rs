use super::*;

// === design §3.3.3：claude session_id 捕获 ===

#[test]
fn session_id_from_system_line() {
    // system init 行携带 session_id（claude stream-json 初始事件）。
    let line = r#"{"type":"system","subtype":"init","session_id":"claude-sys-1","cwd":"/tmp"}"#;
    assert_eq!(
        extract_stream_json_session_id(line),
        Some("claude-sys-1".to_string())
    );
}

#[test]
fn session_id_from_result_line() {
    // result 结束行携带 session_id（部分版本在结束事件输出）。
    let line =
        r#"{"type":"result","subtype":"success","session_id":"claude-res-2","result":"done"}"#;
    assert_eq!(
        extract_stream_json_session_id(line),
        Some("claude-res-2".to_string())
    );
}

#[test]
fn assistant_line_returns_none_for_session_id() {
    // assistant 行不应被误取为 session id（文本提取才是 assistant 行的职责）。
    let line = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}"#;
    assert_eq!(extract_stream_json_session_id(line), None);
}

#[test]
fn session_id_missing_returns_none() {
    // system 行无 session_id 字段时返回 None。
    let line = r#"{"type":"system","subtype":"init"}"#;
    assert_eq!(extract_stream_json_session_id(line), None);
}

#[test]
fn session_id_non_json_returns_none() {
    assert_eq!(extract_stream_json_session_id("not json at all"), None);
    assert_eq!(extract_stream_json_session_id(""), None);
}

// === design 阶段1 R3：stream-json 分类解析（extract_stream_json_items / extract_stream_json_text） ===
//
// 覆盖：完整 assistant 行（text/thinking/tool_use 三类）+ stream_event 增量（content_block_start /
// content_block_delta 的 text_delta/thinking_delta/input_json_delta）+ AskUserQuestion + 解析失败/空行。
// 关键不变量：extract_stream_json_text 仅返回 Text 类（thinking/tool_use 绝不进 stdout）。

#[test]
fn items_assistant_text_block_yields_text() {
    // 完整 assistant 行的 text 块 → Text。
    let line = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}"#;
    assert_eq!(
        extract_stream_json_items(line),
        vec![StreamItem::Text("hello".to_string())]
    );
}

#[test]
fn items_assistant_thinking_block_yields_thinking() {
    // 完整 assistant 行的 thinking 块 → Thinking（不进 stdout）。
    let line =
        r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"先想想"}]}}"#;
    assert_eq!(
        extract_stream_json_items(line),
        vec![StreamItem::Thinking("先想想".to_string())]
    );
}

#[test]
fn items_assistant_tool_use_block_yields_tool_use() {
    // 完整 assistant 行的 tool_use 块 → ToolUse{name, input_json}。
    let line = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"path":"a.ts"}}]}}"#;
    assert_eq!(
        extract_stream_json_items(line),
        vec![StreamItem::ToolUse {
            name: "Read".to_string(),
            input_json: r#"{"path":"a.ts"}"#.to_string(),
        }]
    );
}

#[test]
fn items_assistant_askuserquestion_yields_tool_use() {
    // AskUserQuestion 也是 tool_use，前端按 name 区分渲染问题卡片。
    let line = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"AskUserQuestion","input":{"questions":[{"question":"选哪个?","options":[{"label":"A"},{"label":"B"}]}]}}]}}"#;
    let items = extract_stream_json_items(line);
    assert_eq!(items.len(), 1);
    match &items[0] {
        StreamItem::ToolUse { name, input_json } => {
            assert_eq!(name, "AskUserQuestion");
            assert!(input_json.contains("选哪个"));
        }
        other => panic!("期望 ToolUse，实际 {other:?}"),
    }
}

#[test]
fn items_assistant_mixed_blocks_preserve_order() {
    // 同一 assistant 行含多块时按出现顺序产出（thinking→text→tool_use）。
    let line = r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"推理"},{"type":"text","text":"答案"},{"type":"tool_use","name":"Write","input":{}}]}}"#;
    assert_eq!(
        extract_stream_json_items(line),
        vec![
            StreamItem::Thinking("推理".to_string()),
            StreamItem::Text("答案".to_string()),
            StreamItem::ToolUse {
                name: "Write".to_string(),
                input_json: "{}".to_string(),
            },
        ]
    );
}

#[test]
fn items_stream_event_text_delta_yields_text() {
    // content_block_delta 的 text_delta → Text（增量正文，进 stdout）。
    let line = r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"你好"}}}"#;
    assert_eq!(
        extract_stream_json_items(line),
        vec![StreamItem::Text("你好".to_string())]
    );
}

#[test]
fn items_stream_event_thinking_delta_yields_thinking() {
    // content_block_delta 的 thinking_delta → Thinking（思考增量，进 thought 流）。
    let line = r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"分析中"}}}"#;
    assert_eq!(
        extract_stream_json_items(line),
        vec![StreamItem::Thinking("分析中".to_string())]
    );
}

#[test]
fn items_stream_event_tool_use_start_yields_tool_use() {
    // content_block_start 的 tool_use → 初始化 ToolUse（name 已知，input 取 content_block.input）。
    let line = r#"{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","name":"Read","input":{}}}}"#;
    assert_eq!(
        extract_stream_json_items(line),
        vec![StreamItem::ToolUse {
            name: "Read".to_string(),
            input_json: "{}".to_string(),
        }]
    );
}

#[test]
fn items_stream_event_input_json_delta_yields_tool_use_partial() {
    // content_block_delta 的 input_json_delta → ToolUse{name:"", input_json:partial_json}（增量入参）。
    // partial_json 是「累积中」的 JSON 片段（真实 input_json_delta 把已收到的部分原样回传）。
    // 用 serde_json 构造再序列化，避免 raw 字符串转义地狱。
    let value = json!({
        "type": "stream_event",
        "event": {
            "type": "content_block_delta",
            "delta": {
                "type": "input_json_delta",
                "partial_json": "{\"path\":\"b",
            }
        }
    });
    let line = value.to_string();
    let items = extract_stream_json_items(&line);
    assert_eq!(items.len(), 1);
    match &items[0] {
        StreamItem::ToolUse { name, input_json } => {
            assert!(name.is_empty(), "input_json_delta 的 name 应为空");
            assert!(
                input_json.contains("path"),
                "应含 path 字段，实际 {input_json:?}"
            );
        }
        other => panic!("期望 ToolUse，实际 {other:?}"),
    }
}

#[test]
fn items_stream_event_thinking_start_yields_nothing() {
    // content_block_start 的 thinking/text 块起始无文本，由后续 delta 产出，故返回空。
    let line = r#"{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"thinking","thinking":""}}}"#;
    assert!(extract_stream_json_items(line).is_empty());
}

#[test]
fn items_stream_event_message_start_yields_nothing() {
    // message_start / message_delta / message_stop 等非内容事件不产出片段。
    let line = r#"{"type":"stream_event","event":{"type":"message_start","message":{"id":"m1"}}}"#;
    assert!(extract_stream_json_items(line).is_empty());
}

#[test]
fn items_non_content_type_yields_empty() {
    // system/result 等行不是产出行（session_id 旁路负责），分类解析返回空。
    let line = r#"{"type":"system","subtype":"init","session_id":"s1"}"#;
    assert!(extract_stream_json_items(line).is_empty());
}

#[test]
fn items_invalid_json_yields_empty() {
    // 非 JSON / 空行不报错，返回空 Vec。
    assert!(extract_stream_json_items("not json").is_empty());
    assert!(extract_stream_json_items("").is_empty());
}

#[test]
fn text_filter_excludes_thinking_and_tool_use() {
    // 关键不变量：extract_stream_json_text 仅返回 Text 类聚合，
    // thinking / tool_use 绝不进 stdout（协议解析依赖纯 stdout 文本）。
    let line = r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"推理"},{"type":"text","text":"正文"},{"type":"tool_use","name":"Read","input":{"path":"a"}}]}}"#;
    assert_eq!(extract_stream_json_text(line), Some("正文".to_string()));
}

#[test]
fn text_empty_when_only_thinking_or_tool() {
    // 仅含 thinking/tool_use 时 stdout 聚合为空（Some/None 视 text 是否存在）。
    let thinking_only =
        r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"仅思考"}]}}"#;
    assert_eq!(extract_stream_json_text(thinking_only), None);
    let tool_only = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{}}]}}"#;
    assert_eq!(extract_stream_json_text(tool_only), None);
}

// === task 06-13 R3：codex --json JSONL 分类解析（extract_codex_json_items / classify_codex_item） ===
//
// codex-cli 0.139.0 的 `codex exec --json` 每行一个 JSON，顶层 type 为判别器。
// 事件清单（实测 + codex.exe 二进制字符串反查）：
//   thread.started/turn.started/turn.completed/token_count → 丢弃。
//   turn.failed/error → Stderr（诊断，不进 stdout）。
//   item.started/updated/completed + items → 按 item.type 分类。
// 关键不变量：仅 Text 进 stdout（协议解析依赖），Thinking 进 thought，ToolUse 进 tool，Stderr 进 stderr。
