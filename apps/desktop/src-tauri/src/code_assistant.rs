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
    let args = command.args_with(definition.run_args(
        &final_prompt,
        input.model.as_deref(),
        None,
    ));
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

    let record = SessionRecord {
        session_id: session_id.clone(),
        tool: input.tool,
        model: input.model,
        workspace_dir: workspace_dir.clone(),
        status: "running".to_string(),
        transcript_path: transcript_path.to_string_lossy().to_string(),
        command_preview: command_preview.clone(),
        pid: None,
        started_at,
        ended_at: None,
        exit_code: None,
        // 首轮未知 claude session id，由 spawn_reader 旁路捕获后回写（design §3.3.3）。
        cli_session_id: None,
    };
    // 先 upsert 落盘（首轮记录），失败直接返回，不 spawn 子进程。
    state.store.upsert_session(record.clone())?;

    // 复用 spawn_and_attach（与 send_input 共用 spawn+register+reader+waiter 管线，DRY）。
    let pid = match spawn_and_attach(app.clone(), state.clone(), record.clone(), command, args) {
        Ok(pid) => pid,
        Err(error) => {
            // spawn 失败：回滚落盘的 session 记录状态为 failed。
            let _ = state.store.update_session_exit(
                &record.session_id,
                "failed",
                None,
                now_string(),
            );
            return Err(error);
        }
    };
    // spawn 成功：回填真实 pid 到 record 并补发 session-started。
    let record = SessionRecord {
        pid: Some(pid),
        ..record
    };

    app.emit_json(
        "code-assistant://session-started",
        json!({ "sessionId": session_id, "pid": pid, "record": record }),
    );

    Ok(record)
}

pub fn send_input<E: AssistantEventSink>(
    app: E,
    state: &CodeAssistantState,
    input: SendInputInput,
) -> Result<(), String> {
    // design §3.3.4：send_input 是多轮续接的真正发起者，复用 start_session 的 spawn 管线（非常驻 stdin）。
    let session = state
        .store
        .list_sessions()
        .into_iter()
        .find(|r| r.session_id == input.session_id)
        .ok_or("session 不存在或已结束")?;
    let definition = tool_definition(session.tool);
    let command = find_command(definition.candidate_commands)
        .ok_or_else(|| format!("未找到 {} CLI", definition.display_name))?;

    // 写追问 input transcript（event=input, kind=followup）。旧实现写 input-rejected 已废弃。
    state
        .store
        .append_transcript(
            &input.session_id,
            "input",
            json!({ "prompt": input.input, "kind": "followup" }),
        )?;

    // 续接 prompt 构造（design §3.3.4）：
    // - claude：用捕获到的 cli_session_id 走 --resume 真续接；缺 id 则降级伪多轮（拼历史）。
    // - codex/opencode：永远伪多轮，把历史摘要拼进 prompt 模拟「记得上下文」。
    let claude_missing_id =
        session.tool == CodeAssistantTool::Claude && session.cli_session_id.is_none();
    let (final_prompt, resume_id): (String, Option<String>) = match session.tool {
        CodeAssistantTool::Claude if !claude_missing_id => (
            input.input.clone(),
            session.cli_session_id.clone(),
        ),
        _ => {
            // 伪多轮（codex/opencode 或 claude 缺 id 降级）：历史摘要 + 用户追问。
            let summary = build_history_summary(&state.store, &input.session_id)?;
            let composed = if summary.is_empty() {
                input.input.clone()
            } else {
                format!(
                    "{summary}\n\n---\n\n以上是之前的对话历史，请基于它继续。用户追问：{}",
                    input.input
                )
            };
            (composed, None)
        }
    };
    let args = command.args_with(definition.run_args(
        &final_prompt,
        session.model.as_deref(),
        resume_id.as_deref(),
    ));

    // 追问期间 status 回到 running（design §3.3.4 状态契约），waiter 退出后再置 exited。
    let mut next_session = session.clone();
    next_session.status = "running".to_string();
    next_session.command_preview = command_preview(&command.binary, &args);
    next_session.pid = None;
    next_session.exit_code = None;
    next_session.ended_at = None;
    state.store.upsert_session(next_session.clone())?;
    // 若 claude 因缺 id 降级为伪多轮，在 transcript 留痕（前端可据此提示降级语义）。
    if claude_missing_id {
        let _ = state.store.append_transcript(
            &input.session_id,
            "multiturn-degraded",
            json!({ "reason": "未捕获到 claude session id，已降级为基于历史的伪多轮" }),
        );
    }

    spawn_and_attach(app, state.clone(), next_session, command, args)?;
    Ok(())
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

/// spawn 子进程并接入 reader/waiter（design §3.3.4 spawn_followup_run 公共段抽取）。
/// start_session（首轮）与 send_input（追问）共用，避免复制粘贴（DRY）。
/// 调用方负责：构造 args、写 input transcript、upsert session（status=running）。
/// 本函数负责：spawn（Stdio::null stdin, piped stdout/stderr）→ register_process → spawn_reader×2 → spawn_waiter。
/// 返回子进程 pid（供首轮 session-started 事件回填）。
fn spawn_and_attach<E: AssistantEventSink>(
    app: E,
    state: CodeAssistantState,
    session: SessionRecord,
    command: ResolvedToolCommand,
    args: Vec<String>,
) -> Result<u32, String> {
    let session_id = session.session_id.clone();
    let workspace_dir = session.workspace_dir.clone();

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
        tool: session.tool,
        model: session.model.clone(),
        workspace_dir: workspace_dir.clone(),
        command_preview: session.command_preview.clone(),
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

    let output_format = match session.tool {
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
    Ok(pid)
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

/// 解析 claude stream-json 的一行，提取 CLI 侧 session_id（design §3.3.3）。
/// 仅 `system`（init）/ `result`（结束）事件携带 session_id；assistant 行返回 None（不误取文本行）。
/// 与 extract_stream_json_text 是并行旁路：互不干扰。
fn extract_stream_json_session_id(line: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    let ty = value.get("type").and_then(|v| v.as_str())?;
    match ty {
        "system" | "result" => value
            .get("session_id")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        _ => None,
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
            // session id 旁路捕获「只设一次」标志（design §3.3.3）：避免同一 session_id 行被重复写盘 + 重复 emit。
            let cli_id_captured = std::sync::atomic::AtomicBool::new(false);
            loop {
                buffer.clear();
                match std::io::BufRead::read_line(&mut reader, &mut buffer) {
                    Ok(0) => break,
                    Ok(_) => {
                        let text = match output_format {
                            OutputFormat::StreamJson => {
                                // 旁路：先尝试提取 claude session_id（system/result 行），仅 stdout 流、只设一次。
                                // 与文本提取并行，不互相阻塞；失败/非 system-result 行静默跳过。
                                if stream == "stdout"
                                    && !cli_id_captured.load(std::sync::atomic::Ordering::SeqCst)
                                {
                                    if let Some(cli_id) =
                                        extract_stream_json_session_id(&buffer)
                                    {
                                        if cli_id_captured
                                            .compare_exchange(
                                                false,
                                                true,
                                                std::sync::atomic::Ordering::SeqCst,
                                                std::sync::atomic::Ordering::SeqCst,
                                            )
                                            .is_ok()
                                        {
                                            let _ =
                                                state.store.set_cli_session_id(&session_id, &cli_id);
                                            app.emit_json(
                                                "code-assistant://session-cli-id",
                                                json!({
                                                    "sessionId": session_id,
                                                    "cliSessionId": cli_id,
                                                }),
                                            );
                                        }
                                    }
                                }
                                match extract_stream_json_text(&buffer) {
                                    Some(extracted) => extracted,
                                    None => continue,
                                }
                            }
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

#[derive(Debug, Clone)]
pub(crate) struct CapturedOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
}

/// 带超时的同步运行核心（轮询 try_wait + 超时 kill 回收）。
/// env: None 表示继承全量环境变量（code_assistant CLI 原行为，保持不变）；
///      Some 表示显式白名单环境变量（plugin_script 预览执行用，避免泄漏宿主 token）。
/// 抽取为 pub(crate) 以供 plugin_script::run_plugin_script 复用同一套轮询/超时/回收逻辑。
pub(crate) fn run_captured_inner(
    binary: &PathBuf,
    args: Vec<String>,
    workspace_dir: Option<&str>,
    timeout_ms: u64,
    env: Option<&[(std::ffi::OsString, std::ffi::OsString)]>,
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
    if let Some(env) = env {
        command.env_clear().envs(
            env.iter()
                .map(|(key, value)| (key.clone(), value.clone())),
        );
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

/// 带超时的同步运行（继承全量环境变量）。
/// 仅供 code_assistant CLI 流程使用；plugin_script 预览执行请用 run_capture_with_env。
fn run_capture(
    binary: &PathBuf,
    args: Vec<String>,
    workspace_dir: Option<&str>,
    timeout_ms: u64,
) -> Result<CapturedOutput, String> {
    run_captured_inner(binary, args, workspace_dir, timeout_ms, None)
}

/// 带超时的同步运行（最小白名单环境变量）。
/// 供 plugin_script::run_plugin_script 复用：避免把宿主 LINGFANG_TOKEN / CLI key 泄漏到用户脚本。
pub(crate) fn run_capture_with_env(
    binary: &PathBuf,
    args: Vec<String>,
    workspace_dir: Option<&str>,
    timeout_ms: u64,
    env: Vec<(std::ffi::OsString, std::ffi::OsString)>,
) -> Result<CapturedOutput, String> {
    run_captured_inner(binary, args, workspace_dir, timeout_ms, Some(&env))
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

/// 跨平台 PATH 探测候选二进制，Windows 自动补 .exe。
/// pub(crate) 供 plugin_script::probe_script_runtime 复用（探测 node/py/python）。
pub(crate) fn find_binary(candidate: &str) -> Option<PathBuf> {
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

/// workspace 目录校验 + canonicalize（防符号链接逃逸）。
/// pub(crate) 供 plugin_script::run_plugin_script 复用其 canonicalize 逻辑。
pub(crate) fn resolve_workspace(workspace_dir: Option<String>) -> Result<String, String> {
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

/// 整体字符限长截断（design §3.3.5）：防历史摘要过长导致 Windows 命令行参数超限（~32k）。
/// 限长为字符数（非字节），按 `tail` 同模式取尾部保留最近上下文。
fn truncate_history(input: &str, max_chars: usize) -> String {
    tail(input, max_chars)
}

/// 读取 transcript 中已有的 input/output 事件，拼成可读历史摘要供 codex/opencode 伪多轮复用（design §3.3.5）。
/// 格式：`【用户】...\n\n【AI】...`；空 prompt/空 output 跳过；整体限长 12k 字符（防命令行参数超限）。
/// 这是伪多轮的数据源：codex/opencode 不支持 CLI 级 session 复用，靠把历史拼进新 prompt 模拟「记得上下文」。
fn build_history_summary(store: &AssistantStore, session_id: &str) -> Result<String, String> {
    let raw = store.read_transcript(session_id)?;
    let mut lines: Vec<String> = Vec::new();
    for line in raw.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
            continue;
        };
        let (ev, payload) = (
            v.get("event").and_then(|x| x.as_str()),
            v.get("payload"),
        );
        match (ev, payload) {
            (Some("input"), Some(p)) => {
                // 跳过追问自身写入的 followup input（kind=followup），只读真实首轮 user prompt。
                // 首轮 input payload 无 kind 或 kind != followup；追问的 followup input 由追问 prompt 提供，避免重复。
                let kind = p.get("kind").and_then(|x| x.as_str());
                if kind == Some("followup") {
                    continue;
                }
                let prompt = p.get("prompt").and_then(|x| x.as_str()).unwrap_or("");
                if !prompt.trim().is_empty() {
                    lines.push(format!("【用户】{prompt}"));
                }
            }
            (Some("output"), Some(p)) => {
                let text = p.get("text").and_then(|x| x.as_str()).unwrap_or("");
                if !text.trim().is_empty() {
                    lines.push(format!("【AI】{text}"));
                }
            }
            _ => {}
        }
    }
    Ok(truncate_history(&lines.join("\n\n"), 12_000))
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
        let line = r#"{"type":"result","subtype":"success","session_id":"claude-res-2","result":"done"}"#;
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

    // === design §3.3.5：build_history_summary 伪多轮数据源 ===

    fn temp_assistant_store(name: &str) -> AssistantStore {
        let root = std::env::temp_dir().join(format!(
            "lingfang-code-assistant-test-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        AssistantStore::new(root).expect("assistant store should initialize")
    }

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
                system_prompt: None,
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
                system_prompt: None,
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
