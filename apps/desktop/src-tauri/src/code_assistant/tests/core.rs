use super::*;
use crate::code_assistant::process::command_preview;
use std::path::PathBuf;

#[test]
fn command_preview_redacts_sensitive_args() {
    let preview = command_preview(
        PathBuf::from("assistant").as_path(),
        &["--api-key=abc".to_string(), "hello".to_string()],
    );
    assert_eq!(preview, vec!["assistant", "[redacted]", "hello"]);
}

#[test]
fn tail_keeps_last_chars() {
    assert_eq!(tail("abcdef", 3), "def");
    assert_eq!(tail("abc", 10), "abc");
}

#[test]
fn stop_session_writes_stopped_and_exit_events() {
    let store = temp_assistant_store("stop-session-events");
    store
        .upsert_session(SessionRecord {
            session_id: "s-stop".into(),
            tool: CodeAssistantTool::Claude,
            model: Some("claude-sonnet-4-5".into()),
            workspace_dir: store.root().to_string_lossy().to_string(),
            status: "running".into(),
            transcript_path: store
                .transcript_path("s-stop")
                .to_string_lossy()
                .to_string(),
            command_preview: vec!["ClaudeCode SDK".into(), "claude-sonnet-4-5".into()],
            pid: None,
            started_at: "1".into(),
            ended_at: None,
            exit_code: None,
            cli_session_id: None,
            title: None,
            archived: None,
            draft_updated_at: None,
        })
        .unwrap();
    let state = CodeAssistantState {
        store: store.clone(),
        tasks: Arc::new(Mutex::new(HashMap::new())),
    };

    stop_session(
        NoopEventSink,
        &state,
        StopSessionInput {
            session_id: "s-stop".to_string(),
        },
    )
    .unwrap();

    let raw = store.read_transcript("s-stop").unwrap();
    assert!(raw.contains(r#""event":"stopped""#), "{raw}");
    assert!(raw.contains(r#""event":"exit""#), "{raw}");
    let session = store
        .list_sessions()
        .into_iter()
        .find(|record| record.session_id == "s-stop")
        .unwrap();
    assert_eq!(session.status, "stopped");
    assert_eq!(session.exit_code, None);
}
