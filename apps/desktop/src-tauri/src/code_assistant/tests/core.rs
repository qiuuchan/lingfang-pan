use super::*;
use crate::code_assistant::process::command_preview;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
struct CapturingEventSink {
    events: Arc<Mutex<Vec<(&'static str, serde_json::Value)>>>,
}

impl CapturingEventSink {
    fn new() -> Self {
        Self {
            events: Arc::new(Mutex::new(Vec::new())),
        }
    }
}

impl AssistantEventSink for CapturingEventSink {
    fn emit_json(&self, event: &'static str, payload: serde_json::Value) {
        self.events
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .push((event, payload));
    }
}

fn running_session(store: &AssistantStore, session_id: &str) -> SessionRecord {
    SessionRecord {
        session_id: session_id.into(),
        tool: CodeAssistantTool::Claude,
        model: Some("claude-sonnet-4-5".into()),
        workspace_dir: store.root().to_string_lossy().to_string(),
        status: "running".into(),
        transcript_path: store
            .transcript_path(session_id)
            .to_string_lossy()
            .to_string(),
        command_preview: vec!["ClaudeCode SDK".into()],
        pid: None,
        started_at: "1".into(),
        ended_at: None,
        exit_code: None,
        cli_session_id: None,
        title: None,
        archived: None,
        draft_updated_at: None,
        owner_user_id: None,
        owner_tenant_id: None,
    }
}

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
        .upsert_session(running_session(&store, "s-stop"))
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

#[test]
fn failed_turn_emits_failed_exit_status() {
    let store = temp_assistant_store("failed-exit-status");
    store
        .upsert_session(running_session(&store, "s-failed"))
        .unwrap();
    let state = CodeAssistantState {
        store: store.clone(),
        tasks: Arc::new(Mutex::new(HashMap::new())),
    };
    let handle = tauri::async_runtime::spawn(async {});
    lock_or_recover(&state.tasks).insert(
        "s-failed".to_string(),
        SdkTask {
            cancel: Arc::new(AtomicBool::new(false)),
            handle,
        },
    );
    let app = CapturingEventSink::new();
    let sink = StoreEventSink {
        app: app.clone(),
        store: store.clone(),
        session_id: "s-failed".to_string(),
    };

    finish_sdk_turn(
        sink,
        state,
        "s-failed".to_string(),
        Err("ClaudeCode SDK 返回错误：HTTP 404".to_string()),
    );

    let events = app
        .events
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let exit = events
        .iter()
        .find(|(event, _)| *event == "code-assistant://exit")
        .map(|(_, payload)| payload)
        .expect("exit event should be emitted");
    assert_eq!(exit["status"], json!("failed"));
    let session = store
        .list_sessions()
        .into_iter()
        .find(|record| record.session_id == "s-failed")
        .unwrap();
    assert_eq!(session.status, "failed");
    assert_eq!(session.exit_code, Some(1));
}
