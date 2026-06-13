pub mod adapters;
pub mod store;

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Instant;

#[cfg(unix)]
use std::os::unix::process::CommandExt;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use adapters::{tool_definition, CodeAssistantTool, ToolCommand, TOOL_DEFINITIONS};
use store::{
    now_millis, now_string, AssistantStore, CodeAssistantConfig, RegisteredAgentProcess,
    SessionRecord,
};

const PROBE_PROMPT: &str = "Reply with exactly: lingfang-cli-ok";

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
    processes: Arc<Mutex<HashMap<String, Arc<Mutex<Option<Child>>>>>>,
}

impl CodeAssistantState {
    pub fn new<R: Runtime>(app: &tauri::App<R>) -> Result<Self, String> {
        let app_data = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?;
        let store = AssistantStore::new(app_data.join("code-assistant"))?;
        let cleanup_records = store.cleanup_registered_processes()?;
        for record in &cleanup_records {
            let _ = store.append_transcript(
                &record.session_id,
                "registry-cleanup",
                json!({
                    "pid": record.pid,
                    "tool": record.tool,
                    "killed": record.killed,
                    "stillAlive": record.still_alive,
                    "commandPreview": record.command_preview,
                }),
            );
            let _ = store.update_session_exit(
                &record.session_id,
                if record.still_alive {
                    "cleanup-failed"
                } else {
                    "cleaned-up"
                },
                None,
                now_string(),
            );
        }
        Ok(Self {
            store,
            processes: Arc::new(Mutex::new(HashMap::new())),
        })
    }
}

#[derive(Clone, Debug)]
struct ResolvedToolCommand {
    binary: PathBuf,
    prefix_args: Vec<String>,
    label: String,
}

impl ResolvedToolCommand {
    fn args_with(&self, args: Vec<String>) -> Vec<String> {
        let mut merged = self.prefix_args.clone();
        merged.extend(args);
        merged
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct ToolAvailability {
    pub tool: CodeAssistantTool,
    pub display_name: String,
    pub available: bool,
    pub binary_path: Option<String>,
    pub version: Option<String>,
    pub models: Vec<String>,
    pub default_model: String,
    pub last_check: String,
    pub probe_status: String,
    pub diagnostics: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ProbeResult {
    pub tool: CodeAssistantTool,
    pub model: Option<String>,
    pub success: bool,
    pub command_preview: Vec<String>,
    pub stdout_tail: String,
    pub stderr_tail: String,
    pub exit_code: Option<i32>,
    pub elapsed_ms: u128,
    pub transcript_path: String,
    pub session_id: String,
    pub diagnostics: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct CheckToolInput {
    pub tool: CodeAssistantTool,
}

#[derive(Debug, Deserialize)]
pub struct ProbeInput {
    pub tool: CodeAssistantTool,
    pub model: Option<String>,
    #[serde(alias = "workspaceDir")]
    pub workspace_dir: Option<String>,
    pub prompt: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SaveConfigInput {
    #[serde(alias = "defaultTool")]
    pub default_tool: Option<CodeAssistantTool>,
    #[serde(alias = "defaultModel")]
    pub default_model: Option<String>,
    #[serde(alias = "workspaceDir")]
    pub workspace_dir: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct StartSessionInput {
    pub tool: CodeAssistantTool,
    pub model: Option<String>,
    #[serde(alias = "workspaceDir")]
    pub workspace_dir: Option<String>,
    pub prompt: String,
    #[serde(alias = "systemPrompt")]
    pub system_prompt: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct StopSessionInput {
    #[serde(alias = "sessionId")]
    pub session_id: String,
}

#[derive(Debug, Deserialize)]
pub struct ReadTranscriptInput {
    #[serde(alias = "sessionId")]
    pub session_id: String,
}

#[derive(Debug, Deserialize)]
pub struct SendInputInput {
    #[serde(alias = "sessionId")]
    pub session_id: String,
    pub input: String,
}

pub fn list_tools() -> Vec<ToolAvailability> {
    TOOL_DEFINITIONS
        .iter()
        .map(|definition| check_tool(definition.tool))
        .collect()
}

pub fn check_tool(tool: CodeAssistantTool) -> ToolAvailability {
    let definition = tool_definition(tool);
    let command = find_command(definition.candidate_commands);
    let mut diagnostics = Vec::new();
    let mut version = None;

    if let Some(resolved) = command.as_ref() {
        match run_capture(
            &resolved.binary,
            resolved.args_with(
                definition
                    .version_args
                    .iter()
                    .map(|arg| arg.to_string())
                    .collect(),
            ),
            None,
            10_000,
        ) {
            Ok(output) => {
                let merged = first_non_empty(&output.stdout, &output.stderr);
                version = merged
                    .lines()
                    .next()
                    .map(str::trim)
                    .filter(|line| !line.is_empty())
                    .map(str::to_string);
                if version.is_none() {
                    diagnostics.push("版本命令没有返回可读版本号".to_string());
                }
                if !resolved.prefix_args.is_empty() {
                    diagnostics.push(format!("使用命令入口：{}", resolved.label));
                }
            }
            Err(error) => diagnostics.push(format!("版本检查失败：{error}")),
        }
    } else {
        diagnostics.push(format!(
            "未找到可执行命令：{}",
            candidate_labels(definition.candidate_commands).join(", ")
        ));
    }

    ToolAvailability {
        tool,
        display_name: definition.display_name.to_string(),
        available: command.is_some(),
        binary_path: command
            .map(|command| command_preview(&command.binary, &command.prefix_args).join(" ")),
        version,
        models: definition
            .models
            .iter()
            .map(|value| value.to_string())
            .collect(),
        default_model: definition.default_model.to_string(),
        last_check: now_string(),
        probe_status: "not_run".to_string(),
        diagnostics,
    }
}

pub fn run_probe(state: &CodeAssistantState, input: ProbeInput) -> Result<ProbeResult, String> {
    run_once(
        state,
        input.tool,
        input.model,
        input.workspace_dir,
        input.prompt.unwrap_or_else(|| PROBE_PROMPT.to_string()),
        "probe",
    )
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
) -> Result<SessionRecord, String> {
    let definition = tool_definition(input.tool);
    let command = find_command(definition.candidate_commands)
        .ok_or_else(|| format!("未找到 {} CLI", definition.display_name))?;
    let workspace_dir = resolve_workspace(input.workspace_dir)?;
    let session_id = new_session_id(input.tool);
    let final_prompt = match input.system_prompt.as_deref() {
        Some(sys) if !sys.trim().is_empty() => format!("{sys}\n\n---\n\n{}", input.prompt),
        _ => input.prompt.clone(),
    };
    let args = command.args_with(definition.run_args(&final_prompt, input.model.as_deref()));
    let command_preview = command_preview(&command.binary, &args);
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
        }),
    )?;

    let mut command_builder = Command::new(&command.binary);
    command_builder
        .args(&args)
        .current_dir(&workspace_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    unsafe {
        command_builder.pre_exec(|| {
            libc_setsid();
            Ok(())
        });
    }
    let mut child = command_builder.spawn().map_err(|error| error.to_string())?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let pid = child.id();
    if let Err(error) = state.store.register_process(RegisteredAgentProcess {
        pid,
        session_id: session_id.clone(),
        tool: input.tool,
        model: input.model.clone(),
        workspace_dir: workspace_dir.clone(),
        command_preview: command_preview.clone(),
        registered_at_ms: now_millis(),
    }) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    let child = Arc::new(Mutex::new(Some(child)));
    {
        let mut processes = state.processes.lock().unwrap();
        processes.insert(session_id.clone(), child.clone());
    }

    let record = SessionRecord {
        session_id: session_id.clone(),
        tool: input.tool,
        model: input.model,
        workspace_dir,
        status: "running".to_string(),
        transcript_path: transcript_path.to_string_lossy().to_string(),
        command_preview,
        pid: Some(pid),
        started_at,
        ended_at: None,
        exit_code: None,
    };
    if let Err(error) = state.store.upsert_session(record.clone()) {
        {
            let mut processes = state.processes.lock().unwrap();
            processes.remove(&session_id);
        }
        let _ = state.store.unregister_process(&session_id);
        if let Some(child) = child.lock().unwrap().take() {
            stop_child_process(child);
        }
        return Err(error);
    }
    app.emit_json(
        "code-assistant://session-started",
        json!({ "sessionId": session_id, "pid": pid, "record": record }),
    );

    let output_format = match input.tool {
        CodeAssistantTool::Claude => OutputFormat::StreamJson,
        _ => OutputFormat::Plain,
    };
    spawn_reader(
        app.clone(),
        state.clone(),
        session_id.clone(),
        "stdout",
        output_format,
        stdout,
    );
    spawn_reader(
        app.clone(),
        state.clone(),
        session_id.clone(),
        "stderr",
        OutputFormat::Plain,
        stderr,
    );
    spawn_waiter(app, state, session_id, child);

    Ok(record)
}

pub fn send_input(state: &CodeAssistantState, input: SendInputInput) -> Result<(), String> {
    let _ = input.input;
    state.store.append_transcript(
        &input.session_id,
        "input-rejected",
        json!({
            "reason": "当前适配器使用一次性非交互 CLI 调用；请开启新 session 发送新输入。"
        }),
    )?;
    Err("当前适配器使用一次性非交互 CLI 调用；请开启新 session 发送新输入。".to_string())
}

pub fn stop_session<E: AssistantEventSink>(
    app: E,
    state: &CodeAssistantState,
    input: StopSessionInput,
) -> Result<(), String> {
    let child = {
        let processes = state.processes.lock().unwrap();
        processes.get(&input.session_id).cloned()
    };
    if let Some(child) = child {
        let killed = {
            let mut child = child.lock().unwrap();
            if let Some(child) = child.take() {
                stop_child_process(child);
                true
            } else {
                false
            }
        };
        if !killed {
            return Err("session 已结束".to_string());
        }
        {
            let mut processes = state.processes.lock().unwrap();
            processes.remove(&input.session_id);
        }
        state.store.unregister_process(&input.session_id)?;
        let ended_at = now_string();
        state
            .store
            .append_transcript(&input.session_id, "stopped", json!({ "by": "user" }))?;
        state
            .store
            .update_session_exit(&input.session_id, "stopped", None, ended_at.clone())?;
        app.emit_json(
            "code-assistant://exit",
            json!({ "sessionId": input.session_id, "exitCode": null, "status": "stopped", "endedAt": ended_at }),
        );
        Ok(())
    } else {
        Err("session 不存在或已结束".to_string())
    }
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

fn run_once(
    state: &CodeAssistantState,
    tool: CodeAssistantTool,
    model: Option<String>,
    workspace_dir: Option<String>,
    prompt: String,
    event: &str,
) -> Result<ProbeResult, String> {
    let definition = tool_definition(tool);
    let command = find_command(definition.candidate_commands)
        .ok_or_else(|| format!("未找到 {} CLI", definition.display_name))?;
    let workspace_dir = resolve_workspace(workspace_dir)?;
    let session_id = new_session_id(tool);
    let args = command.args_with(definition.probe_args(&prompt, model.as_deref()));
    let command_preview = command_preview(&command.binary, &args);
    let started = Instant::now();

    state.store.append_transcript(
        &session_id,
        event,
        json!({
            "tool": tool,
            "model": model,
            "prompt": prompt,
            "commandPreview": command_preview,
            "workspaceDir": workspace_dir,
        }),
    )?;

    let captured = run_capture(&command.binary, args, Some(&workspace_dir), 120_000)?;
    let elapsed_ms = started.elapsed().as_millis();
    let stdout_tail = tail(&captured.stdout, 8_000);
    let stderr_tail = tail(&captured.stderr, 8_000);
    let success = !captured.timed_out
        && captured.exit_code == Some(0)
        && (!stdout_tail.trim().is_empty() || !stderr_tail.trim().is_empty());
    let mut diagnostics = Vec::new();
    if captured.timed_out {
        diagnostics.push("CLI 调用超时".to_string());
    }
    if captured.exit_code != Some(0) {
        diagnostics.push(format!("CLI 退出码：{:?}", captured.exit_code));
    }
    if stdout_tail.trim().is_empty() && stderr_tail.trim().is_empty() {
        diagnostics.push("CLI 没有返回 stdout/stderr".to_string());
    }

    state.store.append_transcript(
        &session_id,
        "exit",
        json!({
            "stdoutTail": stdout_tail,
            "stderrTail": stderr_tail,
            "exitCode": captured.exit_code,
            "elapsedMs": elapsed_ms,
            "success": success,
            "diagnostics": diagnostics,
        }),
    )?;

    Ok(ProbeResult {
        tool,
        model,
        success,
        command_preview,
        stdout_tail,
        stderr_tail,
        exit_code: captured.exit_code,
        elapsed_ms,
        transcript_path: state
            .store
            .transcript_path(&session_id)
            .to_string_lossy()
            .to_string(),
        session_id,
        diagnostics,
    })
}

#[derive(Clone, Copy)]
enum OutputFormat {
    Plain,
    StreamJson,
}

/// 解析 claude stream-json 的一行，提取 assistant 文本片段；非 assistant 行返回 None。
fn extract_stream_json_text(line: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    if value.get("type").and_then(|v| v.as_str()) != Some("assistant") {
        return None;
    }
    let content = value.get("message")?.get("content")?.as_array()?;
    let text: String = content
        .iter()
        .filter_map(|item| {
            if item.get("type").and_then(|v| v.as_str()) == Some("text") {
                item.get("text").and_then(|v| v.as_str()).map(String::from)
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
        .join("");
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn spawn_reader<E: AssistantEventSink>(
    app: E,
    state: CodeAssistantState,
    session_id: String,
    stream: &'static str,
    output_format: OutputFormat,
    pipe: Option<impl std::io::Read + Send + 'static>,
) {
    if let Some(pipe) = pipe {
        std::thread::spawn(move || {
            let mut reader = std::io::BufReader::new(pipe);
            let mut buffer = String::new();
            loop {
                buffer.clear();
                match std::io::BufRead::read_line(&mut reader, &mut buffer) {
                    Ok(0) => break,
                    Ok(_) => {
                        let text = match output_format {
                            OutputFormat::StreamJson => match extract_stream_json_text(&buffer) {
                                Some(extracted) => extracted,
                                None => continue,
                            },
                            OutputFormat::Plain => buffer.clone(),
                        };
                        let _ = state.store.append_transcript(
                            &session_id,
                            "output",
                            json!({ "stream": stream, "text": text }),
                        );
                        app.emit_json(
                            "code-assistant://output",
                            json!({ "sessionId": session_id, "stream": stream, "text": text }),
                        );
                    }
                    Err(error) => {
                        let message = error.to_string();
                        let _ = state.store.append_transcript(
                            &session_id,
                            "error",
                            json!({ "stream": stream, "error": message }),
                        );
                        app.emit_json(
                            "code-assistant://error",
                            json!({ "sessionId": session_id, "stream": stream, "error": message }),
                        );
                        break;
                    }
                }
            }
        });
    }
}

#[cfg(unix)]
fn libc_setsid() {
    extern "C" {
        fn setsid() -> i32;
    }
    unsafe {
        let _ = setsid();
    }
}

fn stop_child_process(mut child: Child) {
    #[cfg(unix)]
    {
        let group = format!("-{}", child.id());
        let _ = Command::new("kill")
            .arg("-TERM")
            .arg("--")
            .arg(&group)
            .status();
        for _ in 0..10 {
            match child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(100)),
                Err(_) => return,
            }
        }
        let _ = Command::new("kill")
            .arg("-KILL")
            .arg("--")
            .arg(&group)
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn spawn_waiter<E: AssistantEventSink>(
    app: E,
    state: CodeAssistantState,
    session_id: String,
    child: Arc<Mutex<Option<Child>>>,
) {
    std::thread::spawn(move || {
        let exit_code = loop {
            let status = {
                let mut child = child.lock().unwrap();
                if let Some(child) = child.as_mut() {
                    child.try_wait()
                } else {
                    return;
                }
            };
            match status {
                Ok(Some(status)) => {
                    let mut child = child.lock().unwrap();
                    let _ = child.take();
                    break status.code();
                }
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(200)),
                Err(_) => break None,
            }
        };
        {
            let mut processes = state.processes.lock().unwrap();
            processes.remove(&session_id);
        }
        let _ = state.store.unregister_process(&session_id);
        let ended_at = now_string();
        let _ =
            state
                .store
                .append_transcript(&session_id, "exit", json!({ "exitCode": exit_code }));
        let _ = state
            .store
            .update_session_exit(&session_id, "exited", exit_code, ended_at.clone());
        app.emit_json(
            "code-assistant://exit",
            json!({ "sessionId": session_id, "exitCode": exit_code, "status": "exited", "endedAt": ended_at }),
        );
    });
}

#[derive(Debug)]
struct CapturedOutput {
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
    timed_out: bool,
}

fn run_capture(
    binary: &PathBuf,
    args: Vec<String>,
    workspace_dir: Option<&str>,
    timeout_ms: u64,
) -> Result<CapturedOutput, String> {
    let mut command = Command::new(binary);
    command
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(workspace_dir) = workspace_dir {
        command.current_dir(workspace_dir);
    }
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let started = Instant::now();
    loop {
        if let Some(_status) = child.try_wait().map_err(|error| error.to_string())? {
            let output = child
                .wait_with_output()
                .map_err(|error| error.to_string())?;
            return Ok(CapturedOutput {
                stdout: String::from_utf8_lossy(&output.stdout).to_string(),
                stderr: String::from_utf8_lossy(&output.stderr).to_string(),
                exit_code: output.status.code(),
                timed_out: false,
            });
        }
        if started.elapsed().as_millis() > timeout_ms as u128 {
            let _ = child.kill();
            let output = child
                .wait_with_output()
                .map_err(|error| error.to_string())?;
            return Ok(CapturedOutput {
                stdout: String::from_utf8_lossy(&output.stdout).to_string(),
                stderr: String::from_utf8_lossy(&output.stderr).to_string(),
                exit_code: output.status.code(),
                timed_out: true,
            });
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

fn find_command(candidates: &[ToolCommand]) -> Option<ResolvedToolCommand> {
    for candidate in candidates {
        if let Some(binary) = find_binary(candidate.binary) {
            return Some(ResolvedToolCommand {
                binary,
                prefix_args: candidate
                    .prefix_args
                    .iter()
                    .map(|arg| arg.to_string())
                    .collect(),
                label: candidate.label.to_string(),
            });
        }
    }
    None
}

fn candidate_labels(candidates: &[ToolCommand]) -> Vec<String> {
    candidates
        .iter()
        .map(|candidate| candidate.label.to_string())
        .collect()
}

fn find_binary(candidate: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let full = dir.join(candidate);
        if full.is_file() {
            return Some(full);
        }
        #[cfg(windows)]
        {
            let full_exe = dir.join(format!("{candidate}.exe"));
            if full_exe.is_file() {
                return Some(full_exe);
            }
        }
    }
    None
}

fn command_preview(binary: &std::path::Path, args: &[String]) -> Vec<String> {
    let mut preview = vec![binary.to_string_lossy().to_string()];
    preview.extend(args.iter().map(|arg| redact_arg(arg)));
    preview
}

fn redact_arg(arg: &str) -> String {
    let lower = arg.to_ascii_lowercase();
    if lower.contains("token") || lower.contains("key") || lower.contains("secret") {
        "[redacted]".to_string()
    } else {
        arg.to_string()
    }
}

fn resolve_workspace(workspace_dir: Option<String>) -> Result<String, String> {
    let path = workspace_dir
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    if !path.exists() {
        return Err(format!("workspace 不存在：{}", path.to_string_lossy()));
    }
    if !path.is_dir() {
        return Err(format!("workspace 不是目录：{}", path.to_string_lossy()));
    }
    path.canonicalize()
        .map(|path| path.to_string_lossy().to_string())
        .map_err(|error| error.to_string())
}

fn new_session_id(tool: CodeAssistantTool) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}-{}-{}", tool.as_str(), now.as_secs(), now.subsec_nanos())
}

fn first_non_empty<'a>(first: &'a str, second: &'a str) -> &'a str {
    if first.trim().is_empty() {
        second
    } else {
        first
    }
}

fn tail(input: &str, max_chars: usize) -> String {
    if input.chars().count() <= max_chars {
        return input.to_string();
    }
    let chars: Vec<char> = input.chars().collect();
    chars[chars.len().saturating_sub(max_chars)..]
        .iter()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone)]
    struct NoopEventSink;

    impl AssistantEventSink for NoopEventSink {
        fn emit_json(&self, _event: &'static str, _payload: serde_json::Value) {}
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
    fn real_codex_session_lifecycle_when_enabled() {
        if std::env::var("LINGFANG_REAL_CODEX_SESSION_TEST")
            .ok()
            .as_deref()
            != Some("1")
        {
            return;
        }

        let root = std::env::temp_dir().join(format!(
            "lingfang-real-codex-session-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let state = CodeAssistantState {
            store: AssistantStore::new(root).expect("assistant store should initialize"),
            processes: Arc::new(Mutex::new(HashMap::new())),
        };
        let record = start_session(
            NoopEventSink,
            state.clone(),
            StartSessionInput {
                tool: CodeAssistantTool::Codex,
                model: None,
                workspace_dir: Some(env!("CARGO_MANIFEST_DIR").into()),
                prompt: "Reply with exactly: lingfang-long-session-ok".into(),
            },
        )
        .expect("codex session should start");

        let deadline = Instant::now() + std::time::Duration::from_secs(180);
        while Instant::now() < deadline {
            if let Some(done) = list_sessions(&state)
                .into_iter()
                .find(|item| item.session_id == record.session_id && item.status != "running")
            {
                let transcript = read_transcript(
                    &state,
                    ReadTranscriptInput {
                        session_id: record.session_id.clone(),
                    },
                )
                .expect("transcript should exist");
                println!(
                    "lingfang-real-codex-session evidence session_id={} status={} exit_code={:?} transcript_path={} command={} registry_remaining={}",
                    record.session_id,
                    done.status,
                    done.exit_code,
                    done.transcript_path,
                    done.command_preview.join(" "),
                    state.store.list_registered_processes().len()
                );
                assert_eq!(done.exit_code, Some(0));
                assert!(transcript.contains("lingfang-long-session-ok"));
                assert!(state.store.list_registered_processes().is_empty());
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }

        let _ = stop_session(
            NoopEventSink,
            &state,
            StopSessionInput {
                session_id: record.session_id.clone(),
            },
        );
        panic!(
            "codex session did not finish before timeout: {}",
            record.session_id
        );
    }

    #[test]
    fn real_codex_session_stop_when_enabled() {
        if std::env::var("LINGFANG_REAL_CODEX_STOP_TEST")
            .ok()
            .as_deref()
            != Some("1")
        {
            return;
        }

        let root =
            std::env::temp_dir().join(format!("lingfang-real-codex-stop-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let state = CodeAssistantState {
            store: AssistantStore::new(root).expect("assistant store should initialize"),
            processes: Arc::new(Mutex::new(HashMap::new())),
        };
        let record = start_session(
            NoopEventSink,
            state.clone(),
            StartSessionInput {
                tool: CodeAssistantTool::Codex,
                model: None,
                workspace_dir: Some(env!("CARGO_MANIFEST_DIR").into()),
                prompt: "Write a detailed LingFang plugin design with at least 20 sections. Do not be brief.".into(),
            },
        )
        .expect("codex session should start");
        assert_eq!(state.store.list_registered_processes().len(), 1);
        std::thread::sleep(std::time::Duration::from_secs(3));

        stop_session(
            NoopEventSink,
            &state,
            StopSessionInput {
                session_id: record.session_id.clone(),
            },
        )
        .expect("codex session should stop");

        let session = list_sessions(&state)
            .into_iter()
            .find(|item| item.session_id == record.session_id)
            .expect("session should be stored");
        let transcript = read_transcript(
            &state,
            ReadTranscriptInput {
                session_id: record.session_id.clone(),
            },
        )
        .expect("transcript should exist");
        println!(
            "lingfang-real-codex-stop evidence session_id={} status={} exit_code={:?} transcript_path={} command={} registry_remaining={}",
            record.session_id,
            session.status,
            session.exit_code,
            session.transcript_path,
            session.command_preview.join(" "),
            state.store.list_registered_processes().len()
        );
        assert_eq!(session.status, "stopped");
        assert!(transcript.contains("stopped"));
        assert!(state.store.list_registered_processes().is_empty());
    }
}
