use super::*;

const READER_TEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);
const READER_TEST_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(20);

// === design 阶段1：spawn_reader 分类 emit 端到端（stdout 不被 thinking/tool 污染） ===
//
// 真实读取器在 detached 线程跑；这里用一个捕获事件 sink + Cursor 喂 stream-json 多行，
// 校验：thinking/tool_use 的内容走 thought/tool 流、绝不进 stdout。
// 等待策略：Cursor 数据量极小，线程读完后 Ok(0) 自然退出；轮询 transcript 落盘条目数直至稳定。

#[derive(Clone)]
struct CapturingSink {
    events: Arc<Mutex<Vec<(&'static str, serde_json::Value)>>>,
}

impl AssistantEventSink for CapturingSink {
    fn emit_json(&self, event: &'static str, payload: serde_json::Value) {
        lock_or_recover(&self.events).push((event, payload));
    }
}

fn wait_for_output_events(
    captured: &Arc<Mutex<Vec<(&'static str, serde_json::Value)>>>,
    expected_count: usize,
) {
    let deadline = Instant::now() + READER_TEST_TIMEOUT;
    loop {
        if output_event_count(captured) >= expected_count || Instant::now() > deadline {
            break;
        }
        std::thread::sleep(READER_TEST_POLL_INTERVAL);
    }
}

fn output_event_count(captured: &Arc<Mutex<Vec<(&'static str, serde_json::Value)>>>) -> usize {
    lock_or_recover(captured)
        .iter()
        .filter(|(event, _)| *event == "code-assistant://output")
        .count()
}

fn captured_outputs(
    captured: &Arc<Mutex<Vec<(&'static str, serde_json::Value)>>>,
) -> Vec<(String, String)> {
    lock_or_recover(captured)
        .iter()
        .filter(|(event, _)| *event == "code-assistant://output")
        .filter_map(|(_, payload)| {
            let stream = payload.get("stream")?.as_str()?.to_string();
            let text = payload.get("text")?.as_str()?.to_string();
            Some((stream, text))
        })
        .collect()
}

#[test]
fn reader_routes_thinking_and_tool_out_of_stdout() {
    use std::io::Cursor;
    // 构造一段 claude stream-json：text_delta（正文）+ thinking_delta（思考）+ tool_use（工具）。
    // stdin 喂入的每一行均以换行结尾（BufRead::read_line 按行消费）。
    let raw = [
        r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"正文"}}}"#,
        r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","text":"思考原文","thinking":"思考"}}}"#,
        r#"{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","name":"Read","input":{"path":"a.ts"}}}}"#,
    ]
    .join("\n")
        + "\n";
    let bytes = raw.into_bytes();
    let cursor: Cursor<Vec<u8>> = Cursor::new(bytes);

    let store = temp_assistant_store("reader-stdout-purity");
    let state = CodeAssistantState {
        store: store.clone(),
        processes: Arc::new(Mutex::new(HashMap::new())),
        configs_root: std::env::temp_dir().join(format!(
            "lingfang-reader-test-configs-{}",
            std::process::id()
        )),
    };
    let sink = CapturingSink {
        events: Arc::new(Mutex::new(Vec::new())),
    };
    let captured = sink.events.clone();

    // spawn_reader 在 detached 线程里消费 Cursor，分类后按 stream 字段 emit。
    spawn_reader(
        sink,
        state,
        "reader-session".to_string(),
        "stdout",
        OutputFormat::StreamJson,
        Some(cursor),
    );

    wait_for_output_events(&captured, 3);

    // 收集所有 code-assistant://output 事件的 (stream, text)。
    let outputs = captured_outputs(&captured);

    // 正文进 stdout；思考进 thought；工具进 tool。三类互不串台。
    let stdout_text: String = outputs
        .iter()
        .filter(|(s, _)| s == "stdout")
        .map(|(_, t)| t.as_str())
        .collect::<Vec<_>>()
        .join("");
    let thought_text: String = outputs
        .iter()
        .filter(|(s, _)| s == "thought")
        .map(|(_, t)| t.as_str())
        .collect::<Vec<_>>()
        .join("");
    let tool_text: String = outputs
        .iter()
        .filter(|(s, _)| s == "tool")
        .map(|(_, t)| t.as_str())
        .collect::<Vec<_>>()
        .join("");

    assert_eq!(
        stdout_text, "正文",
        "stdout 应仅含正文，实际 {stdout_text:?}"
    );
    assert_eq!(
        thought_text, "思考",
        "thought 应含思考内容，实际 {thought_text:?}"
    );
    assert!(
        tool_text.starts_with("Read"),
        "tool 应含工具名 Read，实际 {tool_text:?}"
    );

    // 关键不变量：stdout 绝不含思考 / 工具内容（协议解析依赖纯 stdout 文本）。
    assert!(
        !stdout_text.contains("思考"),
        "stdout 被思考内容污染：{stdout_text:?}"
    );
    assert!(
        !stdout_text.contains("Read"),
        "stdout 被工具内容污染：{stdout_text:?}"
    );
}

#[test]
fn reader_deltaizes_claude_assistant_snapshots() {
    use std::io::Cursor;
    let raw = [
        r#"{"type":"assistant","message":{"content":[{"type":"text","text":"我来写配置。"}]}}"#,
        r#"{"type":"assistant","message":{"content":[{"type":"text","text":"我来写配置。配置完成。"}]}}"#,
        r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"先看结构。"},{"type":"text","text":"我来写配置。配置完成。现在写 UI。"}]}}"#,
        r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"先看结构。继续分析。"},{"type":"text","text":"我来写配置。配置完成。现在写 UI。"}]}}"#,
    ]
    .join("\n")
        + "\n";
    let cursor = Cursor::new(raw.into_bytes());

    let store = temp_assistant_store("reader-claude-snapshot-delta");
    let state = CodeAssistantState {
        store: store.clone(),
        processes: Arc::new(Mutex::new(HashMap::new())),
        configs_root: std::env::temp_dir().join(format!(
            "lingfang-reader-snapshot-configs-{}",
            std::process::id()
        )),
    };
    let sink = CapturingSink {
        events: Arc::new(Mutex::new(Vec::new())),
    };
    let captured = sink.events.clone();

    spawn_reader(
        sink,
        state,
        "snapshot-session".to_string(),
        "stdout",
        OutputFormat::StreamJson,
        Some(cursor),
    );

    let deadline = Instant::now() + std::time::Duration::from_secs(2);
    loop {
        let transcript = store
            .read_transcript("snapshot-session")
            .unwrap_or_default();
        if transcript
            .lines()
            .filter(|l| l.contains("\"event\":\"output\""))
            .count()
            >= 5
            || Instant::now() > deadline
        {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }

    let outputs: Vec<(String, String)> = captured
        .lock()
        .unwrap()
        .iter()
        .filter(|(event, _)| *event == "code-assistant://output")
        .filter_map(|(_, payload)| {
            let stream = payload.get("stream")?.as_str()?.to_string();
            let text = payload.get("text")?.as_str()?.to_string();
            Some((stream, text))
        })
        .collect();

    let stdout_text = outputs
        .iter()
        .filter(|(s, _)| s == "stdout")
        .map(|(_, t)| t.as_str())
        .collect::<Vec<_>>()
        .join("");
    let thought_text = outputs
        .iter()
        .filter(|(s, _)| s == "thought")
        .map(|(_, t)| t.as_str())
        .collect::<Vec<_>>()
        .join("");

    assert_eq!(stdout_text, "我来写配置。配置完成。现在写 UI。");
    assert_eq!(thought_text, "先看结构。继续分析。");
}

#[test]
fn reader_codex_json_routes_thinking_tool_error_out_of_stdout() {
    use std::io::Cursor;
    // 构造一段 codex --json JSONL：item.completed（正文）+ reasoning（思考）+ function_call（工具）
    // + turn.failed（错误）。验证分类路由与 claude stream-json 等价（stdout 纯净）。
    let raw = [
        r#"{"type":"item.completed","item":{"type":"agent_message","content":[{"type":"output_text","text":"正文"}]}}"#,
        r#"{"type":"item.completed","item":{"type":"reasoning","summary":[{"type":"summary_text","text":"思考"}]}}"#,
        r#"{"type":"item.completed","item":{"type":"function_call","name":"Read","arguments":"{\"path\":\"a.ts\"}"}}"#,
        r#"{"type":"turn.failed","error":{"message":"402 余额不足"}}"#,
        r#"{"type":"thread.started","thread_id":"t-1"}"#,
    ]
    .join("\n")
        + "\n";
    let bytes = raw.into_bytes();
    let cursor: Cursor<Vec<u8>> = Cursor::new(bytes);

    let store = temp_assistant_store("reader-codex-stdout-purity");
    let state = CodeAssistantState {
        store: store.clone(),
        processes: Arc::new(Mutex::new(HashMap::new())),
        configs_root: std::env::temp_dir().join(format!(
            "lingfang-reader-codex-test-configs-{}",
            std::process::id()
        )),
    };
    let sink = CapturingSink {
        events: Arc::new(Mutex::new(Vec::new())),
    };
    let captured = sink.events.clone();

    spawn_reader(
        sink,
        state,
        "codex-reader-session".to_string(),
        "stdout",
        OutputFormat::CodexJson,
        Some(cursor),
    );

    wait_for_output_events(&captured, 4);

    let outputs = captured_outputs(&captured);

    let stdout_text: String = outputs
        .iter()
        .filter(|(s, _)| s == "stdout")
        .map(|(_, t)| t.as_str())
        .collect::<Vec<_>>()
        .join("");
    let thought_text: String = outputs
        .iter()
        .filter(|(s, _)| s == "thought")
        .map(|(_, t)| t.as_str())
        .collect::<Vec<_>>()
        .join("");
    let tool_text: String = outputs
        .iter()
        .filter(|(s, _)| s == "tool")
        .map(|(_, t)| t.as_str())
        .collect::<Vec<_>>()
        .join("");
    let stderr_text: String = outputs
        .iter()
        .filter(|(s, _)| s == "stderr")
        .map(|(_, t)| t.as_str())
        .collect::<Vec<_>>()
        .join("");

    // 正文进 stdout；思考进 thought；工具进 tool；错误进 stderr。
    assert_eq!(
        stdout_text, "正文",
        "stdout 应仅含正文，实际 {stdout_text:?}"
    );
    assert_eq!(
        thought_text, "思考",
        "thought 应含思考，实际 {thought_text:?}"
    );
    assert!(
        tool_text.starts_with("Read"),
        "tool 应含工具名 Read，实际 {tool_text:?}"
    );
    assert!(
        stderr_text.contains("402"),
        "stderr 应含错误信息，实际 {stderr_text:?}"
    );

    // 关键不变量：stdout 绝不含思考 / 工具 / 错误内容（协议解析依赖纯 stdout）。
    assert!(
        !stdout_text.contains("思考"),
        "stdout 被思考污染：{stdout_text:?}"
    );
    assert!(
        !stdout_text.contains("Read"),
        "stdout 被工具污染：{stdout_text:?}"
    );
    assert!(
        !stdout_text.contains("402"),
        "stdout 被错误污染：{stdout_text:?}"
    );

    // thread.started 生命周期事件应被丢弃（不产生任何 output 事件）。
    assert!(
        !outputs.iter().any(|(_, t)| t.contains("t-1")),
        "thread.started 应被丢弃，不应进任何流：{outputs:?}"
    );
}

#[test]
fn reader_strips_ansi_escape_sequences_from_plain_output() {
    use std::io::Cursor;
    let raw = "\u{1b}[0m\r\n> build · minimax-m3\r\n\u{1b}[93m\u{1b}[1m! \u{1b}[0mpermission requested\u{1b}[0m\n";
    let cursor = Cursor::new(raw.as_bytes().to_vec());

    let store = temp_assistant_store("reader-strip-ansi");
    let state = CodeAssistantState {
        store: store.clone(),
        processes: Arc::new(Mutex::new(HashMap::new())),
        configs_root: std::env::temp_dir().join(format!(
            "lingfang-reader-strip-ansi-configs-{}",
            std::process::id()
        )),
    };
    let sink = CapturingSink {
        events: Arc::new(Mutex::new(Vec::new())),
    };
    let captured = sink.events.clone();

    spawn_reader(
        sink,
        state,
        "ansi-reader-session".to_string(),
        "stdout",
        OutputFormat::Plain,
        Some(cursor),
    );

    wait_for_output_events(&captured, 3);
    let outputs = captured_outputs(&captured);
    let text = outputs
        .iter()
        .map(|(_, text)| text.as_str())
        .collect::<Vec<_>>()
        .join("");
    assert!(
        !text.contains('\u{1b}'),
        "UI 输出不得含 ANSI 转义：{text:?}"
    );
    assert!(text.contains("> build · minimax-m3"));
    assert!(text.contains("! permission requested"));

    let transcript = store.read_transcript("ansi-reader-session").unwrap();
    assert!(
        !transcript.contains("\\u001b") && !transcript.contains('\u{1b}'),
        "transcript 不应落 ANSI 转义：{transcript:?}"
    );
}
