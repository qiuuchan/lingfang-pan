pub mod adapters;
mod history;
mod probe;
mod process;
pub mod store;
mod stream;
mod tools;
mod types;
mod workspace;

use crate::cli_config;
use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex};

// 安全修复 H2：容忍 std::sync::Mutex poison。
// 任一持锁线程 panic 会 poison 锁，原 .lock().unwrap() 在此之后全部二次 panic，
// 导致整个 code-assistant 子系统（所有会话无法停止/追问/删除）不可用，需重启应用。
// PoisonError::into_inner() 拿到锁内数据（数据仍有效，仅代表另一线程异常退出），
// 与未 poison 的 guard 行为一致，杜绝 panic 级联。
// 单独提取泛型函数而非内联闭包，避免 `.lock().unwrap_or_else(|e| e.into_inner())`
// 在闭包处触发 E0282 类型推断失败（into_inner 的多个泛型目标无法消歧）。
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

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use adapters::{tool_definition, CodeAssistantTool};
use history::build_history_summary;
use process::{build_spawn_command, command_preview, prepare_process_group, stop_child_process};
pub(crate) use process::{
    find_binaries, find_binary, kill_child_tree, run_capture_with_env, CapturedOutput,
};
use store::{
    now_millis, now_string, AssistantStore, CodeAssistantConfig, RegisteredAgentProcess,
    SessionRecord,
};
use stream::{
    extract_codex_json_items, extract_stream_json_session_id, stream_item_to_pair,
    strip_ansi_escape_sequences, ClaudeStreamJsonState, OutputFormat,
};
#[cfg(test)]
use stream::{extract_stream_json_items, extract_stream_json_text, StreamItem};
use tools::find_command;
pub use tools::{check_tool, list_tools};
use types::ResolvedToolCommand;
pub use types::{
    CheckToolInput, CliConfigInput, DeleteSessionInput, DraftFileJson, ProbeInput, ProbeResult,
    ReadDraftInput, ReadTranscriptInput, RenameSessionInput, SaveConfigInput, SaveDraftInput,
    ScanWorkspaceInput, SendInputInput, StartSessionInput, StopSessionInput, ToolAvailability,
};
pub use workspace::scan_workspace_files;
pub(crate) use workspace::{new_session_id, resolve_workspace};

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
    // CLI 配置注入的临时配置根目录（app_data/cli-configs）。
    // codex/opencode 的临时 config.toml/opencode.json 写在 cli-configs/<sessionId>/ 下，
    // 会话结束时由 cleanup_session_config 清理（AC7）。claude 不写文件（纯 env）。
    configs_root: PathBuf,
}

impl CodeAssistantState {
    pub fn new<R: Runtime>(app: &tauri::App<R>) -> Result<Self, String> {
        let app_data = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?;
        let store = AssistantStore::new(app_data.join("code-assistant"))?;
        // CLI 临时配置根目录：app_data/cli-configs/<sessionId>/。
        // 在此创建根目录；每个 session 的子目录由 cli_config::prepare_cli_env 按需创建。
        let configs_root = app_data.join("cli-configs");
        std::fs::create_dir_all(&configs_root).map_err(|error| error.to_string())?;
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
            configs_root,
        })
    }

    /// CLI 临时配置根目录（app_data/cli-configs），供 spawn 前 prepare_cli_env 写临时配置、
    /// 会话结束后 cleanup_session_config 清理。
    pub fn configs_root(&self) -> &Path {
        &self.configs_root
    }
}

pub use probe::run_probe;

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
    // 由 main.rs 提前生成的 session_id（与 cli_config 临时目录路径一致，便于 AC7 清理）。
    session_id: String,
    // CLI 配置注入 env（由 tauri command 层 fetch_credentials + prepare_cli_env 生成）。
    // 空 Vec 表示未注入平台凭据（无 key/url 或 fetch 失败）；claude 仍清空 setting sources 隔离用户 CC 配置。
    cli_env: Vec<(OsString, OsString)>,
) -> Result<SessionRecord, String> {
    let definition = tool_definition(input.tool);
    let command = find_command(definition.candidate_commands)
        .ok_or_else(|| format!("未找到 {} CLI", definition.display_name))?;
    let workspace_dir = resolve_workspace(
        input.workspace_dir,
        Some(state.store.root()),
        input.plugin_id.as_deref(),
    )?;
    let session_id = session_id;
    // system_prompt 不再拼进 prompt 文本——改由 run_args 的 system_prompt 参数传给 claude 的 --system-prompt
    // （作为独立 system message）。此前拼接方式让 claude 把创建指令当普通用户文本，弱化/忽略指令。
    let args = command.args_with(definition.run_args(
        &input.prompt,
        input.model.as_deref(),
        None,
        input.effort.as_deref(),
        input.system_prompt.as_deref(),
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
            // CLI 配置注入状态（前端可据此提示「未注入平台 key/url」）。
            // 不记录 key/url 明文（AC8），只记布尔值。
            "cliConfigInjected": !cli_env.is_empty(),
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
        // 新会话无标题/归档/草稿更新时间，由前端懒回填或用户重命名时落盘（design §3.2.1）。
        title: None,
        archived: None,
        draft_updated_at: None,
    };
    // 先 upsert 落盘（首轮记录），失败直接返回，不 spawn 子进程。
    state.store.upsert_session(record.clone())?;

    // 复用 spawn_and_attach（与 send_input 共用 spawn+register+reader+waiter 管线，DRY）。
    let pid = match spawn_and_attach(
        app.clone(),
        state.clone(),
        record.clone(),
        command,
        args,
        cli_env,
    ) {
        Ok(pid) => pid,
        Err(error) => {
            // spawn 失败：回滚落盘的 session 记录状态为 failed，并清理已生成的临时配置（AC7）。
            cli_config::cleanup_session_config(state.configs_root(), &record.session_id);
            let _ =
                state
                    .store
                    .update_session_exit(&record.session_id, "failed", None, now_string());
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
    // CLI 配置注入 env（同 start_session，由 tauri command 层生成）。空 Vec = 未注入平台凭据。
    cli_env: Vec<(OsString, OsString)>,
) -> Result<(), String> {
    // design §3.3.4：send_input 是多轮续接的真正发起者，复用 start_session 的 spawn 管线（非常驻 stdin）。
    let session = state
        .store
        .list_sessions()
        .into_iter()
        .find(|r| r.session_id == input.session_id)
        .ok_or("session 不存在或已结束")?;
    // 修复 SPAWN-01 / RUSTSHIM-02（high 状态机）：此前 send_input 仅校验 session 记录存在，
    // 不校验前一轮子进程是否仍在跑。AskUserQuestion 卡片在 streaming 恒 true 时用户点 option 即触发
    // （前端 handleAskUserAnswer 仅守 `if (!streaming) return`），spawn_and_attach 的 processes.insert
    // 会覆盖旧 Arc 而不停止旧 child，导致 child1 孤儿继续烧 LLM token / CPU，
    // 且 child1 退出时 waiter 按 session_id 误删 child2 的 map/registry 条目并抢先 update_session_exit。
    // 修复：send_input 入口先停掉仍在跑的旧 child（spawn_and_attach 内 take + kill_child_tree），
    // 保证追问发起时最多只有一个活子进程。
    if session.status == "running" {
        // spawn_and_attach 内会复用同 session_id 覆盖 map；这里先 take 旧 child 杀进程组，
        // 让旧 waiter 自然观察到 None 提前退出（不写 update_session_exit，避免覆盖本轮状态）。
        let old_child = {
            let processes = lock_or_recover(&state.processes);
            processes.get(&input.session_id).cloned()
        };
        if let Some(child) = old_child {
            let taken = {
                let mut guard = lock_or_recover(&child);
                guard.take()
            };
            if let Some(mut child) = taken {
                kill_child_tree(&child);
                let _ = child.wait();
            }
        }
    }
    let definition = tool_definition(session.tool);
    let command = find_command(definition.candidate_commands)
        .ok_or_else(|| format!("未找到 {} CLI", definition.display_name))?;

    // 写追问 input transcript（event=input, kind=followup）。旧实现写 input-rejected 已废弃。
    state.store.append_transcript(
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
        CodeAssistantTool::Claude if !claude_missing_id => {
            (input.input.clone(), session.cli_session_id.clone())
        }
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
    // 模型覆盖（design §3.3.4 会话内切模型）：追问传入的 model 优先，回退 session 首轮固化值。
    // 传入非空时同时回写到 next_session.model（记忆最后选择，关闭重开仍用切后的模型，对齐 AionUi）。
    let effective_model = input.model.as_deref().or(session.model.as_deref());
    // R2 思考强度：前端每轮 send 均传 effort（start_session 首轮 + send_input 追问），
    // 故直接用本轮入参值，无需在 SessionRecord 额外持久化（会话中途调即随轮次生效）。
    // system_prompt 追问轮也传（--system-prompt）：claude resume 分支重复传无害（重申当前约束），
    // 降级分支（claude 缺 cli_session_id 伪多轮）与 codex/opencode 必须传（否则无系统约束）。
    let args = command.args_with(definition.run_args(
        &final_prompt,
        effective_model,
        resume_id.as_deref(),
        input.effort.as_deref(),
        input.system_prompt.as_deref(),
    ));

    // 追问期间 status 回到 running（design §3.3.4 状态契约），waiter 退出后再置 exited。
    let mut next_session = session.clone();
    next_session.status = "running".to_string();
    next_session.command_preview = command_preview(&command.binary, &args);
    next_session.pid = None;
    next_session.exit_code = None;
    next_session.ended_at = None;
    // 若用户本轮切换了模型，回写到 session 记录（关闭重开会话仍记住最后用的模型）。
    if input.model.is_some() {
        next_session.model = input.model.clone();
    }
    state.store.upsert_session(next_session.clone())?;
    // 若 claude 因缺 id 降级为伪多轮，在 transcript 留痕（前端可据此提示降级语义）。
    if claude_missing_id {
        let _ = state.store.append_transcript(
            &input.session_id,
            "multiturn-degraded",
            json!({ "reason": "未捕获到 claude session id，已降级为基于历史的伪多轮" }),
        );
    }

    spawn_and_attach(app, state.clone(), next_session, command, args, cli_env)?;
    Ok(())
}

pub fn stop_session<E: AssistantEventSink>(
    app: E,
    state: &CodeAssistantState,
    input: StopSessionInput,
) -> Result<(), String> {
    let child = {
        let processes = lock_or_recover(&state.processes);
        processes.get(&input.session_id).cloned()
    };
    if let Some(child) = child {
        let killed = {
            let mut child = lock_or_recover(&child);
            if let Some(child) = child.take() {
                stop_child_process(child);
                true
            } else {
                false
            }
        };
        // 修复 SPAWN-04（low 并发）：此前子进程在用户点停止与 stop_session 拿锁之间自然退出时，
        // spawn_waiter 200ms 轮询先 take 掉 child，stop_session 拿到 None → killed=false →
        // 返回 Err('session 已结束')。用户点了停止却收到错误 toast，且状态落 exited 而非预期 stopped。
        // 修复：stop 对「进程已死」幂等——killed=false 时视为目标达成返回 Ok(())，不再报错。
        // 终态以 waiter 写入的 exited 为准（无数据丢失），用户语义上「停止」已满足。
        if killed {
            {
                let mut processes = lock_or_recover(&state.processes);
                processes.remove(&input.session_id);
            }
            state.store.unregister_process(&input.session_id)?;
            let ended_at = now_string();
            state
                .store
                .append_transcript(&input.session_id, "stopped", json!({ "by": "user" }))?;
            state.store.update_session_exit(
                &input.session_id,
                "stopped",
                None,
                ended_at.clone(),
            )?;
            // AC7：用户主动停止时清理临时 CLI 配置目录（waiter 不会触发自然退出分支）。
            cli_config::cleanup_session_config(state.configs_root(), &input.session_id);
            app.emit_json(
                "code-assistant://exit",
                json!({ "sessionId": input.session_id, "exitCode": null, "status": "stopped", "endedAt": ended_at }),
            );
        }
        Ok(())
    } else {
        // 进程表无该 session：可能已自然退出（waiter 已清理），也可能从未启动。
        // 幂等语义：对用户而言「停止一个已结束的会话」应成功而非报错（避免误导性 toast）。
        Ok(())
    }
}

/// spawn 子进程并接入 reader/waiter（design §3.3.4 spawn_followup_run 公共段抽取）。
/// start_session（首轮）与 send_input（追问）共用，避免复制粘贴（DRY）。
/// 调用方负责：构造 args、写 input transcript、upsert session（status=running）、生成 cli_env。
/// 本函数负责：spawn（Stdio::null stdin, piped stdout/stderr + 注入 cli_env）→ register_process → spawn_reader×2 → spawn_waiter。
/// 返回子进程 pid（供首轮 session-started 事件回填）。
fn spawn_and_attach<E: AssistantEventSink>(
    app: E,
    state: CodeAssistantState,
    session: SessionRecord,
    command: ResolvedToolCommand,
    args: Vec<String>,
    // CLI 配置注入 env（claude: ANTHROPIC_*；codex: CODEX_HOME+OPENAI_API_KEY；opencode: OPENCODE_CONFIG）。
    // 空 Vec = 不注入平台凭据。.envs() 追加而非 env_clear，保留宿主 PATH 让 CLI 找到二进制。
    cli_env: Vec<(OsString, OsString)>,
) -> Result<u32, String> {
    let session_id = session.session_id.clone();
    let workspace_dir = session.workspace_dir.clone();

    let mut command_builder = build_spawn_command(&command.binary, &args);
    command_builder
        .current_dir(&workspace_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // CLI 配置注入：追加 env（不清空宿主 env，保留 PATH/HOME 等）。
    // codex/opencode 的 CODEX_HOME/OPENCODE_CONFIG 指向 app_data/cli-configs/<sessionId>/ 临时配置，
    // 不污染用户 ~/.codex / ~/.config/opencode（AC2/AC3）。
    if !cli_env.is_empty() {
        command_builder.envs(
            cli_env
                .iter()
                .map(|(key, value)| (key.clone(), value.clone())),
        );
    }
    prepare_process_group(&mut command_builder);
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
        let mut processes = lock_or_recover(&state.processes);
        processes.insert(session_id.clone(), child.clone());
    }

    // 分类输出格式：claude → StreamJson，codex → CodexJson（--json JSONL 事件流），
    // opencode → Plain（纯文本，无分类）。stderr 一律 Plain（codex/opencode 的 stderr 是进度/诊断非 JSON）。
    let output_format = match session.tool {
        CodeAssistantTool::Claude => OutputFormat::StreamJson,
        CodeAssistantTool::Codex => OutputFormat::CodexJson,
        CodeAssistantTool::Opencode => OutputFormat::Plain,
    };
    let stdout_reader = spawn_reader(
        app.clone(),
        state.clone(),
        session_id.clone(),
        "stdout",
        output_format,
        stdout,
    );
    let stderr_reader = spawn_reader(
        app.clone(),
        state.clone(),
        session_id.clone(),
        "stderr",
        OutputFormat::Plain,
        stderr,
    );
    spawn_waiter(app, state, session_id, child, stdout_reader, stderr_reader);
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

// === design §3.2.3：多会话 CRUD 命令 ===
// rename/save_draft 同步刷新 draft_updated_at（会话栏排序依据）。
// save_draft/read_draft 透传 serde_json::Value，Rust 不感知前端 PluginDraft 定义（前后端 schema 解耦）。

/// 重命名会话标题，返回更新后的 SessionRecord（前端刷新会话栏 meta）。
pub fn rename_session(
    state: &CodeAssistantState,
    input: RenameSessionInput,
) -> Result<SessionRecord, String> {
    state
        .store
        .rename_session(&input.session_id, &input.title, now_string())
}

/// 删除会话（清 sessions 记录 + transcript + draft + CLI 临时配置 四处），幂等。
pub fn delete_session(state: &CodeAssistantState, input: DeleteSessionInput) -> Result<(), String> {
    // AC7：删除会话时一并清理残留的 CLI 临时配置目录（可能因异常退出未清理）。
    cli_config::cleanup_session_config(state.configs_root(), &input.session_id);
    state.store.delete_session(&input.session_id)
}

/// 写草稿到 drafts/{sessionId}.json，并刷新该会话的 draft_updated_at。
pub fn save_draft(state: &CodeAssistantState, input: SaveDraftInput) -> Result<(), String> {
    state
        .store
        .write_draft(&input.session_id, &input.draft_json)?;
    // 落盘成功后同步刷新更新时间（前端会话栏排序/相对时间依据）。
    state
        .store
        .touch_draft_updated_at(&input.session_id, now_string())
}

/// 读取草稿原文（Value 透传）。文件不存在返回 None。
pub fn read_draft(
    state: &CodeAssistantState,
    input: ReadDraftInput,
) -> Result<Option<Value>, String> {
    state.store.read_draft(&input.session_id)
}

fn spawn_reader<E: AssistantEventSink>(
    app: E,
    state: CodeAssistantState,
    session_id: String,
    stream: &'static str,
    output_format: OutputFormat,
    pipe: Option<impl std::io::Read + Send + 'static>,
) -> Option<std::thread::JoinHandle<()>> {
    pipe.map(|pipe| {
        std::thread::spawn(move || {
            let mut reader = std::io::BufReader::new(pipe);
            let mut buffer = String::new();
            let mut claude_stream_state = ClaudeStreamJsonState::default();
            // session id 旁路捕获「只设一次」标志（design §3.3.3）：避免同一 session_id 行被重复写盘 + 重复 emit。
            let cli_id_captured = std::sync::atomic::AtomicBool::new(false);
            loop {
                buffer.clear();
                match std::io::BufRead::read_line(&mut reader, &mut buffer) {
                    Ok(0) => break,
                    Ok(_) => {
                        // 分类产出（design 阶段1 R3）：每行解析为若干 (stream, text) 对，
                        // 按 stream 字段独立 emit + 写盘。关键约束：
                        // - Text → 'stdout'（协议解析依赖，transcriptTextSinceLastInput 只取 stdout/stderr）
                        // - Thinking → 'thought'（思考折叠区，不进 stdout）
                        // - ToolUse（含 AskUserQuestion）→ 'tool'（工具卡片，不进 stdout）
                        // - Stderr（codex 错误事件）→ 'stderr'（诊断区，不进 stdout）
                        // codex 用 CodexJson 走 extract_codex_json_items（同样产出 StreamItem 分类）。
                        // opencode（Plain）保持原行为：整行进原 stream（stdout/stderr）。
                        let items: Vec<(&'static str, String)> = match output_format {
                            OutputFormat::StreamJson => {
                                // 旁路：先尝试提取 claude session_id（system/result 行），仅 stdout 流、只设一次。
                                // 与分类解析并行，不互相阻塞；失败/非 system-result 行静默跳过。
                                if stream == "stdout"
                                    && !cli_id_captured.load(std::sync::atomic::Ordering::SeqCst)
                                {
                                    if let Some(cli_id) = extract_stream_json_session_id(&buffer) {
                                        if cli_id_captured
                                            .compare_exchange(
                                                false,
                                                true,
                                                std::sync::atomic::Ordering::SeqCst,
                                                std::sync::atomic::Ordering::SeqCst,
                                            )
                                            .is_ok()
                                        {
                                            let _ = state
                                                .store
                                                .set_cli_session_id(&session_id, &cli_id);
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
                                // 分类解析：按 StreamItem.type 路由到 stdout/thought/tool 流。
                                // 仅 stdout（Text）会被 transcriptTextSinceLastInput 提取（协议聚合输入），
                                // thought/tool 走独立流，前端按 stream 字段区分渲染，绝不污染 stdout。
                                claude_stream_state
                                    .items_for_line(&buffer)
                                    .into_iter()
                                    .filter_map(stream_item_to_pair)
                                    .collect()
                            }
                            OutputFormat::CodexJson => {
                                // codex --json JSONL 分类解析（task 06-13 R3 codex 补齐）。
                                // 与 claude stream-json 同样产出 StreamItem，复用 stream_item_to_pair 路由。
                                // 关键约束同样生效：Text 进 stdout、Thinking 进 thought、ToolUse 进 tool、
                                // 错误事件进 stderr（turn.failed/error 不污染 stdout 协议解析）。
                                extract_codex_json_items(&buffer)
                                    .into_iter()
                                    .filter_map(stream_item_to_pair)
                                    .collect()
                            }
                            OutputFormat::Plain => vec![(stream, buffer.clone())],
                        };
                        for (item_stream, item_text) in items {
                            let item_text = match output_format {
                                OutputFormat::Plain => strip_ansi_escape_sequences(&item_text),
                                OutputFormat::StreamJson | OutputFormat::CodexJson => item_text,
                            };
                            let _ = state.store.append_transcript(
                                &session_id,
                                "output",
                                json!({ "stream": item_stream, "text": item_text }),
                            );
                            app.emit_json(
                                "code-assistant://output",
                                json!({
                                    "sessionId": session_id,
                                    "stream": item_stream,
                                    "text": item_text,
                                }),
                            );
                        }
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
        })
    })
}

fn spawn_waiter<E: AssistantEventSink>(
    app: E,
    state: CodeAssistantState,
    session_id: String,
    child: Arc<Mutex<Option<Child>>>,
    stdout_reader: Option<std::thread::JoinHandle<()>>,
    stderr_reader: Option<std::thread::JoinHandle<()>>,
) {
    std::thread::spawn(move || {
        // 修复 SPAWN-05（low 健壮性）：try_wait 返回 Err 时直接 break None 不杀子进程，
        // map/registry 已被清空，子进程变孤儿且无法停止。修复：Err 分支也 take 并 kill_child_tree 回收。
        let exit_code = loop {
            let status = {
                let mut child = lock_or_recover(&child);
                if let Some(child) = child.as_mut() {
                    child.try_wait()
                } else {
                    // send_input 已 take 旧 child（多轮重 spawn），本 waiter 无需发 exit 事件直接退出。
                    return;
                }
            };
            match status {
                Ok(Some(status)) => {
                    let mut child = lock_or_recover(&child);
                    let _ = child.take();
                    break status.code();
                }
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(200)),
                Err(_) => {
                    // try_wait 系统级错误（罕见）：take 旧 child 杀进程组，避免孤儿；exit_code 走 None。
                    let mut child = lock_or_recover(&child);
                    if let Some(mut owned) = child.take() {
                        kill_child_tree(&owned);
                        let _ = owned.wait();
                    }
                    break None;
                }
            }
        };
        // 修复 SPAWN-06（low 并发）：spawn_waiter 与 spawn_reader 是独立线程无同步，
        // 子进程退出时其 stdout/stderr pipe OS 缓冲区可能还有未读数据，reader 的下一次 read_line
        // 才会读到并 emit output。若 spawn_waiter 200ms 轮询先 try_wait 命中 Ok(Some) 即发 exit，
        // 会早于 reader 的最后一批 output 到达前端，导致 finalizeSession 读 transcript 漏末尾产出。
        // 修复：发 exit 事件前 join 两个 reader 线程，确保 pipe 数据全部 flush 到 transcript + emit output。
        // reader 在 pipe 写端全部关闭（子进程已死）后 read_line 返回 Ok(0) 自然退出，join 不会无限阻塞。
        if let Some(handle) = stdout_reader {
            let _ = handle.join();
        }
        if let Some(handle) = stderr_reader {
            let _ = handle.join();
        }
        // 修复 SPAWN-01：旧 waiter 不能误删新轮 child 的 map/registry 条目。
        // processes 可能已被新轮 spawn_and_attach 覆盖为新 Arc；仅在当前 Arc 仍是注册的那个时才删。
        // 若已被覆盖（ptr 不等），说明 send_input 启动了新轮，旧 waiter 应静默退出，
        // 不发 unregister / update_session_exit / exit 事件，避免覆盖新轮 running 状态。
        let still_current = {
            let mut processes = lock_or_recover(&state.processes);
            match processes.get(&session_id) {
                Some(registered) if Arc::ptr_eq(registered, &child) => {
                    processes.remove(&session_id);
                    true
                }
                _ => false, // 已被新轮覆盖，或已被 stop_session 移除
            }
        };
        if !still_current {
            return;
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
        // AC7：会话自然结束时清理临时 CLI 配置目录（codex/opencode 的 config.toml/opencode.json）。
        // 幂等：claude 无配置文件，目录不存在时 remove_dir_all 静默忽略。
        cli_config::cleanup_session_config(state.configs_root(), &session_id);
        app.emit_json(
            "code-assistant://exit",
            json!({ "sessionId": session_id, "exitCode": exit_code, "status": "exited", "endedAt": ended_at }),
        );
    });
}

/// 查询某 session 记录的 tool（供 main.rs resolve_cli_env 决定按哪种 CLI 机制生成配置）。
/// session 不存在返回 Claude（兜底，不会命中实际注入逻辑因 fetch 也会失败）。
pub fn lookup_session_tool(state: &CodeAssistantState, session_id: &str) -> CodeAssistantTool {
    state
        .store
        .list_sessions()
        .into_iter()
        .find(|r| r.session_id == session_id)
        .map(|r| r.tool)
        .unwrap_or(CodeAssistantTool::Claude)
}

#[cfg(test)]
mod tests;
