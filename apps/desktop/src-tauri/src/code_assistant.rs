pub(crate) mod engine;
mod history;
mod process;
pub mod store;
mod types;
mod workspace;

use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use engine::runtime::{run_sdk_turn, EngineEventSink, RunRequest};
use engine::SdkCredentials;
pub(crate) use process::{
    find_binaries, find_binary, kill_child_tree, run_capture_with_env, CapturedOutput,
};
use store::{now_string, AssistantStore, CodeAssistantConfig, SessionRecord};
pub use types::{
    CodeAssistantTool, DeleteSessionInput, DraftFileJson, ReadDraftInput, ReadTranscriptInput,
    RenameSessionInput, SaveConfigInput, SaveDraftInput, ScanWorkspaceInput, SdkConfigInput,
    SendInputInput, StartSessionInput, StopSessionInput, UpdateWorkspaceInput,
};
pub use workspace::scan_workspace_files;
pub(crate) use workspace::{new_session_id, resolve_workspace};

fn lock_or_recover<T>(mutex: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

#[cfg(test)]
static PROCESS_TREE_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
pub(crate) fn process_tree_test_lock() -> std::sync::MutexGuard<'static, ()> {
    PROCESS_TREE_TEST_LOCK
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
}

pub(crate) trait AssistantEventSink: Clone + Send + Sync + 'static {
    fn emit_json(&self, event: &'static str, payload: serde_json::Value);
}

impl<R: Runtime> AssistantEventSink for AppHandle<R> {
    fn emit_json(&self, event: &'static str, payload: serde_json::Value) {
        let _ = self.emit(event, payload);
    }
}

#[derive(Clone)]
pub struct CodeAssistantState {
    store: AssistantStore,
    tasks: Arc<Mutex<HashMap<String, SdkTask>>>,
}

struct SdkTask {
    cancel: Arc<AtomicBool>,
    handle: tauri::async_runtime::JoinHandle<()>,
}

impl CodeAssistantState {
    pub fn new<R: Runtime>(app: &tauri::App<R>) -> Result<Self, String> {
        let app_data = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?;
        let store = AssistantStore::new(app_data.join("code-assistant"))?;
        Ok(Self {
            store,
            tasks: Arc::new(Mutex::new(HashMap::new())),
        })
    }
}

pub fn get_config(state: &CodeAssistantState) -> CodeAssistantConfig {
    state.store.read_config()
}

pub fn save_config(
    state: &CodeAssistantState,
    input: SaveConfigInput,
) -> Result<CodeAssistantConfig, String> {
    let config = CodeAssistantConfig {
        default_tool: input.default_tool,
        default_model: input.default_model,
        workspace_dir: input.workspace_dir,
    };
    state.store.write_config(&config)?;
    Ok(config)
}

pub fn start_session<E: AssistantEventSink>(
    app: E,
    state: CodeAssistantState,
    input: StartSessionInput,
    session_id: String,
    credentials: SdkCredentials,
    embedded_runtime_root: Option<std::path::PathBuf>,
) -> Result<SessionRecord, String> {
    let workspace_dir = resolve_workspace(
        input.workspace_dir,
        Some(state.store.root()),
        input.plugin_id.as_deref(),
    )?;
    let command_preview = sdk_preview(input.tool, input.model.as_deref());
    let transcript_path = state.store.transcript_path(&session_id);
    let started_at = now_string();
    state.store.append_transcript(
        &session_id,
        "input",
        json!({
            "tool": input.tool,
            "model": input.model,
            "prompt": input.prompt,
            "commandPreview": command_preview,
            "workspaceDir": workspace_dir,
            "sdkConfigInjected": true,
        }),
    )?;
    let record = SessionRecord {
        session_id: session_id.clone(),
        tool: input.tool,
        model: input.model.clone(),
        workspace_dir: workspace_dir.clone(),
        status: "running".to_string(),
        transcript_path: transcript_path.to_string_lossy().to_string(),
        command_preview: command_preview.clone(),
        pid: None,
        started_at,
        ended_at: None,
        exit_code: None,
        cli_session_id: None,
        title: None,
        archived: None,
        draft_updated_at: None,
        owner_user_id: input.owner_user_id.clone(),
        owner_tenant_id: input.owner_tenant_id.clone(),
    };
    state.store.upsert_session(record.clone())?;
    app.emit_json(
        "code-assistant://session-started",
        json!({ "sessionId": session_id, "pid": null, "record": record }),
    );
    spawn_sdk_turn(
        app,
        state.clone(),
        RunRequest {
            session_id,
            tool: input.tool,
            model: input.model,
            workspace_dir,
            embedded_runtime_root,
            prompt: input.prompt,
            system_prompt: input.system_prompt,
            credentials,
            store: state.store.clone(),
            cancel: Arc::new(AtomicBool::new(false)),
        },
    )?;
    Ok(record)
}

pub fn send_input<E: AssistantEventSink>(
    app: E,
    state: &CodeAssistantState,
    input: SendInputInput,
    credentials: SdkCredentials,
    embedded_runtime_root: Option<std::path::PathBuf>,
) -> Result<(), String> {
    let session = state
        .store
        .list_sessions()
        .into_iter()
        .find(|record| record.session_id == input.session_id)
        .ok_or_else(|| "session 不存在".to_string())?;
    cancel_existing_task(state, &input.session_id);
    state.store.append_transcript(
        &input.session_id,
        "input",
        json!({ "prompt": input.input, "kind": "followup" }),
    )?;
    let effective_model = input.model.clone().or(session.model.clone());
    let mut next_session = session.clone();
    next_session.status = "running".to_string();
    next_session.model = effective_model.clone();
    next_session.command_preview = sdk_preview(session.tool, effective_model.as_deref());
    next_session.exit_code = None;
    next_session.ended_at = None;
    state.store.upsert_session(next_session.clone())?;
    spawn_sdk_turn(
        app,
        state.clone(),
        RunRequest {
            session_id: input.session_id,
            tool: session.tool,
            model: effective_model,
            workspace_dir: session.workspace_dir,
            embedded_runtime_root,
            prompt: input.input,
            system_prompt: input.system_prompt,
            credentials,
            store: state.store.clone(),
            cancel: Arc::new(AtomicBool::new(false)),
        },
    )
}

pub fn stop_session<E: AssistantEventSink>(
    app: E,
    state: &CodeAssistantState,
    input: StopSessionInput,
) -> Result<(), String> {
    if let Some(task) = remove_task(state, &input.session_id) {
        task.cancel.store(true, Ordering::SeqCst);
        task.handle.abort();
    }
    let ended_at = now_string();
    state
        .store
        .append_transcript(&input.session_id, "stopped", json!({ "by": "user" }))?;
    state.store.append_transcript(
        &input.session_id,
        "exit",
        json!({ "exitCode": null, "status": "stopped" }),
    )?;
    state
        .store
        .update_session_exit(&input.session_id, "stopped", None, ended_at.clone())?;
    app.emit_json(
        "code-assistant://exit",
        json!({ "sessionId": input.session_id, "exitCode": null, "status": "stopped", "endedAt": ended_at }),
    );
    Ok(())
}

pub fn list_sessions(state: &CodeAssistantState) -> Vec<SessionRecord> {
    state.store.list_sessions()
}

pub fn read_transcript(
    state: &CodeAssistantState,
    input: ReadTranscriptInput,
) -> Result<String, String> {
    state.store.read_transcript(&input.session_id)
}

pub fn rename_session(
    state: &CodeAssistantState,
    input: RenameSessionInput,
) -> Result<SessionRecord, String> {
    state
        .store
        .rename_session(&input.session_id, &input.title, now_string())
}

pub fn delete_session(state: &CodeAssistantState, input: DeleteSessionInput) -> Result<(), String> {
    cancel_existing_task(state, &input.session_id);
    state.store.delete_session(&input.session_id)
}

pub fn save_draft(state: &CodeAssistantState, input: SaveDraftInput) -> Result<(), String> {
    state
        .store
        .write_draft(&input.session_id, &input.draft_json)?;
    state
        .store
        .touch_draft_updated_at(&input.session_id, now_string())
}

pub fn update_workspace(
    state: &CodeAssistantState,
    input: UpdateWorkspaceInput,
) -> Result<(), String> {
    state
        .store
        .update_session_workspace_dir(&input.session_id, &input.workspace_dir)
}

pub fn read_draft(
    state: &CodeAssistantState,
    input: ReadDraftInput,
) -> Result<Option<Value>, String> {
    state.store.read_draft(&input.session_id)
}

fn spawn_sdk_turn<E: AssistantEventSink>(
    app: E,
    state: CodeAssistantState,
    mut request: RunRequest,
) -> Result<(), String> {
    request.store = state.store.clone();
    let session_id = request.session_id.clone();
    let cancel = request.cancel.clone();
    let sink = StoreEventSink {
        app: app.clone(),
        store: state.store.clone(),
        session_id: session_id.clone(),
    };
    let task_state = state.clone();
    let task_id = session_id.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let result = run_sdk_turn(request, sink.clone()).await;
        finish_sdk_turn(sink, task_state, task_id, result);
    });
    let task = SdkTask { cancel, handle };
    let mut tasks = lock_or_recover(&state.tasks);
    tasks.insert(session_id, task);
    Ok(())
}

fn finish_sdk_turn<E: AssistantEventSink>(
    sink: StoreEventSink<E>,
    state: CodeAssistantState,
    session_id: String,
    result: Result<(), String>,
) {
    let still_current = remove_task(&state, &session_id).is_some();
    if !still_current {
        return;
    }
    let ended_at = now_string();
    match result {
        Ok(()) => {
            let _ = state
                .store
                .append_transcript(&session_id, "exit", json!({ "exitCode": 0 }));
            let _ =
                state
                    .store
                    .update_session_exit(&session_id, "exited", Some(0), ended_at.clone());
            sink.app.emit_json(
                "code-assistant://exit",
                json!({ "sessionId": session_id, "exitCode": 0, "status": "exited", "endedAt": ended_at }),
            );
        }
        Err(error) => {
            if error == "会话已停止" {
                return;
            }
            sink.error(error);
            let _ = state
                .store
                .append_transcript(&session_id, "exit", json!({ "exitCode": 1 }));
            let _ =
                state
                    .store
                    .update_session_exit(&session_id, "failed", Some(1), ended_at.clone());
            sink.app.emit_json(
                "code-assistant://exit",
                json!({ "sessionId": session_id, "exitCode": 1, "status": "failed", "endedAt": ended_at }),
            );
        }
    }
}

#[derive(Clone)]
struct StoreEventSink<E: AssistantEventSink> {
    app: E,
    store: AssistantStore,
    session_id: String,
}

impl<E: AssistantEventSink> EngineEventSink for StoreEventSink<E> {
    fn output(&self, stream: &'static str, text: String) {
        let _ = self.store.append_transcript(
            &self.session_id,
            "output",
            json!({ "stream": stream, "text": text }),
        );
        self.app.emit_json(
            "code-assistant://output",
            json!({ "sessionId": self.session_id, "stream": stream, "text": text }),
        );
    }

    fn error(&self, message: String) {
        let _ = self.store.append_transcript(
            &self.session_id,
            "error",
            json!({ "stream": "stderr", "error": message }),
        );
        self.app.emit_json(
            "code-assistant://error",
            json!({ "sessionId": self.session_id, "stream": "stderr", "error": message }),
        );
    }
}

fn cancel_existing_task(state: &CodeAssistantState, session_id: &str) {
    if let Some(task) = remove_task(state, session_id) {
        task.cancel.store(true, Ordering::SeqCst);
        task.handle.abort();
    }
}

fn remove_task(state: &CodeAssistantState, session_id: &str) -> Option<SdkTask> {
    let mut tasks = lock_or_recover(&state.tasks);
    tasks.remove(session_id)
}

fn sdk_preview(tool: CodeAssistantTool, model: Option<&str>) -> Vec<String> {
    let mut preview = vec![format!("{} SDK", tool.display_name())];
    if let Some(model) = model.map(str::trim).filter(|value| !value.is_empty()) {
        preview.push(model.to_string());
    }
    preview
}

#[cfg(test)]
mod tests;
