pub mod adapters;
pub mod store;

use crate::cli_config;
use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Instant;

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

#[cfg(unix)]
use std::os::unix::process::CommandExt;

#[cfg(windows)]
use std::os::windows::process::CommandExt as WindowsCommandExt;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
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
    // R2 思考强度：claude 透传 `--effort <level>`（max/high/medium/low/none）；
    // codex/opencode 接收但忽略。随每轮 send 传入，可在会话中途调整。
    pub effort: Option<String>,
    // 组D task 06-16（AC10）：插件创建会话前端传入 pluginId（用户命名规范化后的目录名）。
    // 命中时 resolve_workspace 把 workspace 强制落到 plugins_root/<pluginId>/ 持久化目录
    // （不再回退 claude-sandbox），CLI 产出的文件直接写进插件持久化目录。
    // None 表示非插件场景（纯对话/标题总结），走默认 claude-sandbox 隔离目录。
    #[serde(default, alias = "pluginId")]
    pub plugin_id: Option<String>,
    // CLI 配置注入（task 06-15）：前端传入 backendUrl + authToken，Rust 内部调后端拿 apiKey + apiUrl
    // 生成 CLI 隔离配置（claude env / codex CODEX_HOME / opencode OPENCODE_CONFIG）。
    // None 或字段缺失 → 降级不注入（CLI 走默认配置，AC4）。key 明文绝不回前端（AC8）。
    #[serde(default, alias = "cliConfig")]
    pub cli_config: Option<CliConfigInput>,
}

/// CLI 配置注入所需的后端连接信息（前端从登录态注入，Rust 内部调 decrypt 拿 key）。
///
/// 安全（AC8）：仅传 backendUrl + authToken，**不传 apiKey**。apiKey 明文由 Rust 内部调
/// `POST /api/llm/binding/decrypt` 获取，仅存在于 Rust 进程内存，不进前端 webview。
#[derive(Debug, Deserialize, Default)]
pub struct CliConfigInput {
    /// 后端基础地址（如 https://api.lingfang.com），Rust 内部拼 /api/llm/* 端点。
    #[serde(default, alias = "backendUrl")]
    pub backend_url: String,
    /// 用户登录 JWT（Authorization: Bearer），Rust 内部调 decrypt/active-provider 用。
    #[serde(default, alias = "authToken")]
    pub auth_token: String,
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

// === design §3.2.3：多会话 CRUD Input（sessionId 统一 camelCase 别名，对齐前端 tauriInvoke 入参） ===

#[derive(Debug, Deserialize)]
pub struct RenameSessionInput {
    #[serde(alias = "sessionId")]
    pub session_id: String,
    pub title: String,
}

#[derive(Debug, Deserialize)]
pub struct DeleteSessionInput {
    #[serde(alias = "sessionId")]
    pub session_id: String,
}

#[derive(Debug, Deserialize)]
pub struct SaveDraftInput {
    #[serde(alias = "sessionId")]
    pub session_id: String,
    /// 前端序列化后的 PluginDraft JSON。Rust 不解析其内部定义（透传 serde_json::Value），
    /// 与 append_transcript 的 payload: Value 同模式，保持前后端 schema 解耦（design §3.2.2）。
    #[serde(alias = "draftJson")]
    pub draft_json: Value,
}

#[derive(Debug, Deserialize)]
pub struct ReadDraftInput {
    #[serde(alias = "sessionId")]
    pub session_id: String,
}

// 扫描 sandbox 目录产出文件（方案A：claude 用 Write 工具把插件文件写到 workspace，
// CLI 跑完后 Rust 扫描目录收成结构化 files）。与前端 DraftFile 同构（path + content）。
#[derive(Clone, Debug, Serialize)]
pub struct DraftFileJson {
    pub path: String,
    pub content: String,
}

// scan_workspace_files 命令入参：仅 sessionId（sandbox 路径从 SessionRecord.workspace_dir 取，禁止硬编码）。
#[derive(Debug, Deserialize)]
pub struct ScanWorkspaceInput {
    #[serde(alias = "sessionId")]
    pub session_id: String,
}

#[derive(Debug, Deserialize)]
pub struct SendInputInput {
    #[serde(alias = "sessionId")]
    pub session_id: String,
    pub input: String,
    // 追问时可选的模型覆盖：传则优先于 session 首轮固化值，实现「会话内切模型下一轮生效」。
    // 对齐 AionUi「会话级记忆 + 切换立即下一轮生效」语义；claude 走 --resume <id> --model <current>，
    // 官方支持 per-invocation 覆盖（code.claude.com/docs/en/cli-reference）。
    pub model: Option<String>,
    // R2 思考强度：追问时可覆盖首轮值，随本轮 send_input 传入。
    // None 表示沿用 start_session 首轮值（由调用方记忆）；非空则覆盖生效（可会话中途调）。
    pub effort: Option<String>,
    // CLI 配置注入（task 06-15）：追问轮同样注入平台 key/url，保证多轮用平台模型源。
    #[serde(default, alias = "cliConfig")]
    pub cli_config: Option<CliConfigInput>,
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
    // 由 main.rs 提前生成的 session_id（与 cli_config 临时目录路径一致，便于 AC7 清理）。
    session_id: String,
    // CLI 配置注入 env（由 tauri command 层 fetch_credentials + prepare_cli_env 生成）。
    // 空 Vec 表示降级（无 key/url 或 fetch 失败），spawn 不注入 env，CLI 走默认配置（AC4）。
    cli_env: Vec<(OsString, OsString)>,
) -> Result<SessionRecord, String> {
    let definition = tool_definition(input.tool);
    let command = find_command(definition.candidate_commands)
        .ok_or_else(|| format!("未找到 {} CLI", definition.display_name))?;
    let workspace_dir = resolve_workspace(input.workspace_dir, Some(state.store.root()), input.plugin_id.as_deref())?;
    let session_id = session_id;
    let final_prompt = match input.system_prompt.as_deref() {
        Some(sys) if !sys.trim().is_empty() => format!("{sys}\n\n---\n\n{}", input.prompt),
        _ => input.prompt.clone(),
    };
    let args = command.args_with(definition.run_args(
        &final_prompt,
        input.model.as_deref(),
        None,
        input.effort.as_deref(),
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
            // CLI 配置注入降级标志（前端可据此提示「未注入平台 key，使用 CLI 默认配置」）。
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
    // CLI 配置注入 env（同 start_session，由 tauri command 层生成）。空 Vec = 降级。
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
    // 模型覆盖（design §3.3.4 会话内切模型）：追问传入的 model 优先，回退 session 首轮固化值。
    // 传入非空时同时回写到 next_session.model（记忆最后选择，关闭重开仍用切后的模型，对齐 AionUi）。
    let effective_model = input.model.as_deref().or(session.model.as_deref());
    // R2 思考强度：前端每轮 send 均传 effort（start_session 首轮 + send_input 追问），
    // 故直接用本轮入参值，无需在 SessionRecord 额外持久化（会话中途调即随轮次生效）。
    let args = command.args_with(definition.run_args(
        &final_prompt,
        effective_model,
        resume_id.as_deref(),
        input.effort.as_deref(),
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
            state
                .store
                .update_session_exit(&input.session_id, "stopped", None, ended_at.clone())?;
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
    // 空 Vec = 降级不注入（AC4）。.envs() 追加而非 env_clear，保留宿主 PATH 让 CLI 找到二进制。
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
    #[cfg(unix)]
    unsafe {
        command_builder.pre_exec(|| {
            libc_setsid();
            Ok(())
        });
    }
    #[cfg(windows)]
    {
        // 修复 SPAWN-PGRP（BLOCKER B1/H6）：run_captured_inner（探测/脚本路径）设置了
        // CREATE_NEW_PROCESS_GROUP 让 stop_child_process 的 taskkill /T 能波及孙进程，
        // 但 spawn_and_attach（实际会话 spawn 路径）此前漏设——会话 CLI 启动的 MCP server /
        // node 子进程在会话停止后可能脱离进程树成为孤儿，持续燃烧 LLM token / 占用资源。
        // 此处与 run_captured_inner（code_assistant.rs:1748-1750）对齐，叠加 NO_WINDOW 不弹控制台。
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        WindowsCommandExt::creation_flags(&mut command_builder, CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
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
    state.store.write_draft(&input.session_id, &input.draft_json)?;
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

/// 扫描 sandbox 目录收成结构化文件列表（方案A：claude 用 Write 工具把插件文件写到 workspace）。
///
/// 数据源：从 SessionRecord.workspace_dir 取 sandbox 根目录（禁止硬编码，路径来自落盘记录）。
/// 递归遍历所有文件，排除：隐藏文件（. 开头）、node_modules、.git、二进制文件（非 UTF-8 跳过）、
/// 超大文件（>256KB 跳过，对齐后端 MAX_PLUGIN_FILE_BYTES 限制）。
/// 路径转相对（相对 sandbox 根），canonicalize 前缀断言防穿越（不返回 sandbox 外的文件）。
///
/// 空目录（纯对话 / claude 未写文件）返回 Ok(Vec::new())，调用方据此回退到对话态逻辑。
pub fn scan_workspace_files(
    state: &CodeAssistantState,
    input: ScanWorkspaceInput,
) -> Result<Vec<DraftFileJson>, String> {
    // 从 SessionRecord 取 workspace_dir（单一真源，禁止硬编码路径）。
    let session = state
        .store
        .list_sessions()
        .into_iter()
        .find(|r| r.session_id == input.session_id)
        .ok_or_else(|| format!("session 不存在：{}", input.session_id))?;
    let workspace_dir = session.workspace_dir;
    // sandbox 根 canonicalize（防符号链接逃逸）；目录不存在视为空（返回空列表）。
    let root = std::path::PathBuf::from(&workspace_dir);
    if !root.exists() {
        return Ok(Vec::new());
    }
    let root_canon = root
        .canonicalize()
        .map_err(|error| format!("sandbox 目录无法访问：{error}"))?;
    // 递归扫描收集（depth-first，跳过排除项）。
    let mut files: Vec<DraftFileJson> = Vec::new();
    collect_workspace_files(&root_canon, &root_canon, &mut files)?;
    // manifest.json 置顶（与 buildLocalDraft 同款约定，前端 parseManifest 直接命中首位）。
    files.sort_by_key(|file| if file.path == "manifest.json" { 0 } else { 1 });
    Ok(files)
}

/// 递归收集 sandbox 文件（内部辅助，scan_workspace_files 调用）。
///
/// 排除规则（硬性要求）：
/// - 隐藏文件 / 目录（文件名以 . 开头，如 .env / .git / .claude）。
/// - node_modules 目录（依赖体积大，非插件源码）。
/// - 二进制文件（read_to_string 失败即非 UTF-8，跳过不报错）。
/// - 超大文件（>256KB，对齐后端 MAX_PLUGIN_FILE_BYTES，避免后续上传必然 400）。
///
/// 防穿越：canonicalize 每个文件后断言仍以 root_canon 为前缀（符号链接逃逸防御）。
///
/// 修复 RUSTSHIM-04（medium 逻辑 bug）：此前用 entry.metadata()（跟随符号链接返回目标元数据）
/// 判定是否目录，对指向目录的符号链接 metadata.is_dir()==true，于是递归 collect_workspace_files，
/// sandbox 内存在目录符号链接环（a/link -> a）时会沿符号链接无限深入，最终栈溢出 panic
/// （栈溢出无法被 catch_unwind 捕获，是进程级 abort）。
/// 修复：用 symlink_metadata 判定（不跟随），目录符号链接被视为「符号链接」而非「目录」直接跳过；
/// 同时加深度上限 MAX_SCAN_DEPTH 作为第二道防线（防恶意深层嵌套目录爆栈）。
fn collect_workspace_files(
    current: &std::path::Path,
    root_canon: &std::path::Path,
    out: &mut Vec<DraftFileJson>,
) -> Result<(), String> {
    collect_workspace_files_inner(current, root_canon, out, 0)
}

/// 沙箱扫描深度上限（修复 RUSTSHIM-04 第二道防线）：32 层足以覆盖任何合法插件结构，
/// 超出视为恶意嵌套或符号链接环，停止递归（避免栈溢出）。
const MAX_SCAN_DEPTH: usize = 32;

fn collect_workspace_files_inner(
    current: &std::path::Path,
    root_canon: &std::path::Path,
    out: &mut Vec<DraftFileJson>,
    depth: usize,
) -> Result<(), String> {
    // 修复 RUSTSHIM-04：深度上限防栈溢出（符号链接环或恶意深层嵌套）。
    if depth > MAX_SCAN_DEPTH {
        return Ok(());
    }
    let entries = std::fs::read_dir(current).map_err(|error| error.to_string())?;
    for entry in entries.flatten() {
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy();
        // 排除隐藏项（.env / .git / .claude 等系统/配置文件）。
        if name.starts_with('.') {
            continue;
        }
        // 排除 node_modules（依赖目录，体积大且非插件源码）。
        if name == "node_modules" {
            continue;
        }
        let path = entry.path();
        // 修复 RUSTSHIM-04：用 symlink_metadata（不跟随符号链接）判定类型，
        // 目录符号链接不被当作目录递归（避免符号链接环 / 指向祖先目录的环致栈溢出）。
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(_) => continue, // 元数据读取失败跳过（权限/竞态等）。
        };
        if metadata.is_dir() {
            // 真实目录（非符号链接）递归（collect_workspace_files_inner 自带排除规则 + 深度守卫）。
            collect_workspace_files_inner(&path, root_canon, out, depth + 1)?;
            continue;
        }
        if !metadata.is_file() {
            continue; // 符号链接 / FIFO / socket 等非普通文件跳过。
        }
        // 超大文件跳过（对齐后端 256KB 单文件限制，避免上传必然 400）。
        const MAX_FILE_BYTES: u64 = 256 * 1024;
        if metadata.len() > MAX_FILE_BYTES {
            continue;
        }
        // 防穿越：canonicalize 后断言仍以 sandbox 根为前缀（符号链接逃逸防御）。
        let canon = match path.canonicalize() {
            Ok(c) => c,
            Err(_) => continue,
        };
        if !canon.starts_with(root_canon) {
            continue; // 逃逸 sandbox，跳过（不报错，静默忽略异常项）。
        }
        // 读取内容：read_to_string 失败即二进制文件（非 UTF-8），跳过不报错。
        let content = match std::fs::read_to_string(&canon) {
            Ok(c) => c,
            Err(_) => continue,
        };
        // 相对路径（相对 sandbox 根），统一用 / 分隔（跨平台一致，对齐前端 cleanPath）。
        let rel = canon
            .strip_prefix(root_canon)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        if rel.is_empty() {
            continue;
        }
        out.push(DraftFileJson {
            path: rel,
            content,
        });
    }
    Ok(())
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
    let workspace_dir = resolve_workspace(workspace_dir, Some(state.store.root()), None)?;
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
    // codex `--json` JSONL 事件流（task 06-13 R3 codex 补齐）。
    // 与 StreamJson（claude）不同的解析器 extract_codex_json_items，但产出同样的 StreamItem 分类。
    // 仅用于 codex 的 stdout 通道；stderr 仍用 Plain（codex 把进度/诊断写 stderr，非 JSON）。
    CodexJson,
}

/// stream-json / codex-json 一行解析出的分类片段（design 阶段1 R3）。
/// 关键约束：只有 Text 进 stdout 流（协议解析依赖纯文本）；
/// Thinking / ToolUse 走独立 thought / tool 流，绝不污染 stdout。
/// Stderr 仅 codex-json 的错误事件用（turn.failed / error），强制进 stderr 流让诊断区可见，
/// 绝不进 stdout（否则错误文本污染协议解析输入）。
#[derive(Debug, Clone, PartialEq)]
enum StreamItem {
    /// 正文文本（assistant 文本块 / text_delta），进 stdout 流。
    Text(String),
    /// 思考内容（thinking 块 / thinking_delta），进 thought 流。
    Thinking(String),
    /// 工具调用（含 AskUserQuestion），进 tool 流。input_json 为序列化的入参（可能不完整）。
    ToolUse {
        name: String,
        input_json: String,
    },
    /// 错误/诊断（codex 的 turn.failed / error 事件），进 stderr 流。
    /// 仅 codex-json 使用：把错误从 JSONL 解析出来路由到 stderr（不进 stdout）。
    Stderr(String),
}

/// 把 StreamItem 映射到 (stream 字段, text)，供 StreamJson / CodexJson 复用（DRY）。
/// 返回 None 表示该项应被丢弃（空文本）。
/// - Text → ("stdout", text)（协议聚合输入）。
/// - Thinking → ("thought", thinking)（思考折叠区，不进 stdout）。
/// - ToolUse → ("tool", name+input 摘要)（工具卡片，不进 stdout）。
/// - Stderr → ("stderr", text)（诊断区，不进 stdout）。
fn stream_item_to_pair(item: StreamItem) -> Option<(&'static str, String)> {
    match item {
        StreamItem::Text(text) if !text.is_empty() => Some(("stdout", text)),
        StreamItem::Thinking(thinking) if !thinking.is_empty() => Some(("thought", thinking)),
        StreamItem::Stderr(text) if !text.is_empty() => Some(("stderr", text)),
        StreamItem::ToolUse { name, input_json } => {
            // 工具卡片内容：name + 入参摘要（空 name 表示纯 input_json_delta 增量）。
            // AskUserQuestion 同走此流，前端按 name 区分问题卡片。
            let merged = if name.is_empty() {
                input_json
            } else {
                format!("{name} {input_json}").trim().to_string()
            };
            if merged.is_empty() {
                None
            } else {
                Some(("tool", merged))
            }
        }
        _ => None,
    }
}

/// 解析 claude stream-json 的一行，返回分类片段数组（design 阶段1 R3）。
/// 同时兼容两种形态：
/// - `type==assistant`（完整消息行）：遍历 message.content[]，按块类型产出 Text/Thinking/ToolUse。
/// - `type==stream_event`（`--include-partial-messages` 的增量行）：按 event.type 分流：
///   * content_block_start.content_block.type==tool_use → 初始化 ToolUse（input 取 content_block.input）
///   * content_block_start.content_block.type==thinking/text → 块起始（增量阶段产出，起始本身无文本，跳过）
///   * content_block_delta.delta.type==thinking_delta → Thinking(delta.thinking)
///   * content_block_delta.delta.type==text_delta → Text(delta.text)
///   * content_block_delta.delta.type==input_json_delta → ToolUse{name:"", input_json:delta.partial_json}
///     （input_json 累积版，前端按增量渲染；tool_use_id 精确关联留后续 stream-json input 升级，本轮简化）
///
/// 非 JSON / 非相关行返回空 Vec（不报错）。
fn extract_stream_json_items(line: &str) -> Vec<StreamItem> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
        return Vec::new();
    };
    let Some(ty) = value.get("type").and_then(|v| v.as_str()) else {
        return Vec::new();
    };
    match ty {
        // 完整 assistant 消息（旧 / 无 partial 的形态）：遍历 content 数组分类。
        "assistant" => {
            let Some(content) = value
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_array())
            else {
                return Vec::new();
            };
            let mut items = Vec::new();
            for block in content {
                let block_type = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
                match block_type {
                    "text" => {
                        if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                            if !text.is_empty() {
                                items.push(StreamItem::Text(text.to_string()));
                            }
                        }
                    }
                    "thinking" => {
                        if let Some(thinking) = block.get("thinking").and_then(|v| v.as_str()) {
                            if !thinking.is_empty() {
                                items.push(StreamItem::Thinking(thinking.to_string()));
                            }
                        }
                    }
                    "tool_use" => {
                        let name = block
                            .get("name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        // 修复 RUST-STREAM-04（info 边界）：input 字段为 null/标量时 other.to_string()
                        // 会序列化为 "null"/"true"/"42" 字符串，前端工具卡片渲染出现 "AskUserQuestion null"
                        // 等字面量。规范化：null → "{}"，对象/数组 → JSON 序列化，字符串 → 透传，
                        // 其余标量包成 JSON 值序列化（保持合法 JSON 形态，避免裸字面量）。
                        let input_json = block
                            .get("input")
                            .map(normalize_tool_input)
                            .unwrap_or_default();
                        items.push(StreamItem::ToolUse { name, input_json });
                    }
                    _ => {}
                }
            }
            items
        }
        // stream_event 增量形态（--include-partial-messages）：按 event.type 分流。
        "stream_event" => {
            let Some(event) = value.get("event") else {
                return Vec::new();
            };
            let Some(event_type) = event.get("type").and_then(|v| v.as_str()) else {
                return Vec::new();
            };
            match event_type {
                // 工具块起始：产出 ToolUse 占位（name 已知，input 初始化）。
                "content_block_start" => {
                    let Some(block) = event.get("content_block") else {
                        return Vec::new();
                    };
                    match block.get("type").and_then(|v| v.as_str()).unwrap_or("") {
                        "tool_use" => {
                            let name = block
                                .get("name")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            // 修复 RUST-STREAM-04：复用 normalize_tool_input 规范化 input 字段。
                            let input_json = block
                                .get("input")
                                .map(normalize_tool_input)
                                .unwrap_or_default();
                            vec![StreamItem::ToolUse { name, input_json }]
                        }
                        // thinking/text 块起始无文本，文本由后续 delta 产出；跳过。
                        _ => Vec::new(),
                    }
                }
                // 增量块：按 delta.type 分类产出。
                "content_block_delta" => {
                    let Some(delta) = event.get("delta") else {
                        return Vec::new();
                    };
                    match delta.get("type").and_then(|v| v.as_str()).unwrap_or("") {
                        "text_delta" => delta
                            .get("text")
                            .and_then(|v| v.as_str())
                            .filter(|s| !s.is_empty())
                            .map(|s| vec![StreamItem::Text(s.to_string())])
                            .unwrap_or_default(),
                        "thinking_delta" => delta
                            .get("thinking")
                            .and_then(|v| v.as_str())
                            .filter(|s| !s.is_empty())
                            .map(|s| vec![StreamItem::Thinking(s.to_string())])
                            .unwrap_or_default(),
                        "input_json_delta" => delta
                            .get("partial_json")
                            .and_then(|v| v.as_str())
                            .filter(|s| !s.is_empty())
                            .map(|s| vec![StreamItem::ToolUse {
                                name: String::new(),
                                input_json: s.to_string(),
                            }])
                            .unwrap_or_default(),
                        _ => Vec::new(),
                    }
                }
                _ => Vec::new(),
            }
        }
        _ => Vec::new(),
    }
}

/// 解析 claude stream-json 的一行，提取 assistant 文本片段（仅 Text 类，进 stdout 协议聚合）。
/// 保留旧签名（spawn_reader 之外的潜在复用 + 单测历史兼容）；
/// 内部改为复用 extract_stream_json_items 后过滤 Text 项 join，
/// 自动覆盖 thinking/tool_use 不进 stdout 的关键约束（协议解析依赖纯 stdout 文本）。
#[allow(dead_code)]
fn extract_stream_json_text(line: &str) -> Option<String> {
    let text: String = extract_stream_json_items(line)
        .into_iter()
        .filter_map(|item| match item {
            StreamItem::Text(s) => Some(s),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("");
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

/// 解析 codex `--json` JSONL 的一行，返回分类片段数组（task 06-13 R3 codex 补齐）。
///
/// codex-cli 0.139.0 的 `codex exec --json` 每行输出一个 JSON，顶层 `type` 字段为事件判别器。
/// 事件清单（已通过 `codex exec --json` 实测 + 二进制字符串反查 `codex.exe` 确认）：
///
/// - `thread.started`（含 thread_id）/ `turn.started` / `turn.completed` → 生命周期信号，**丢弃**（不展示）。
/// - `turn.failed`（含 error.message）/ `error`（含 message，如 reconnecting 重连） → 错误，
///   进 **stderr** 流（前端诊断区可见真实错误，不进 stdout 协议解析）。
/// - `token_count`（含 usage） → 用量统计，**丢弃**。
/// - `items`（含完整 items 数组） → 批量 item，逐项按 item.type 分类（与 item.completed 同解析）。
/// - `item.started` / `item.updated` / `item.completed`（含 item 对象）→ 按 item.type 分类：
///     * `agent_message`（content[] 每项 {type:"output_text",text}）→ **Text**（进 stdout）。
///     * `agent_message_content_delta`（含 delta）→ **Text** 增量（进 stdout）。
///     * `reasoning` / `agent_reasoning` / `agent_reasoning_raw_content` → **Thinking**（进 thought）。
///     * `reasoning_content_delta` / `reasoning_raw_content_delta` → **Thinking** 增量（进 thought）。
///     * `local_shell_call`（含 action.command）/ `function_call`（含 name+arguments）/ `mcp_tool_call` →
///       **ToolUse**（进 tool，工具卡片）。
///     * 其他（file_change / command_execution / commentary 等）→ 丢弃（避免噪声）。
///
/// 非 JSON / 空行 / 非已知 type 返回空 Vec（不报错，容忍 codex 版本新增事件类型）。
fn extract_codex_json_items(line: &str) -> Vec<StreamItem> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
        return Vec::new();
    };
    let Some(ty) = value.get("type").and_then(|v| v.as_str()) else {
        return Vec::new();
    };
    match ty {
        // 错误事件：turn.failed（含 error 对象）/ error（含 message 字符串）。
        // 进 stderr 流（诊断区可见），不进 stdout（协议解析依赖纯 stdout）。
        // 注意：codex 的 reconnecting（重连尝试 1/5..5/5）也是 error 事件，原样透传让用户看到重连过程。
        "turn.failed" => {
            let message = value
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .unwrap_or("codex 执行失败");
            vec![StreamItem::Stderr(format!("[turn.failed] {message}"))]
        }
        "error" => {
            let message = value
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("codex 错误");
            vec![StreamItem::Stderr(format!("[error] {message}"))]
        }
        // 单 item 事件：item.started/updated/completed，按 item.type 分类。
        "item.started" | "item.updated" | "item.completed" => {
            value.get("item").map(classify_codex_item).unwrap_or_default()
        }
        // 批量 items 事件：逐项分类（兜底，多数情况下 codex 走 item.* 流式）。
        "items" => value
            .get("items")
            .and_then(|items| items.as_array())
            .map(|arr| arr.iter().flat_map(classify_codex_item).collect())
            .unwrap_or_default(),
        // 生命周期/统计事件：丢弃（不展示，避免噪声）。
        // thread.started / turn.started / turn.completed / token_count / changes 等。
        _ => Vec::new(),
    }
}

/// 按 codex item.type 分类产出 StreamItem（extract_codex_json_items 的子解析）。
///
/// codex item 结构（已实测 + 二进制反查）：`{type, content[]?, delta?, summary[]?, action?, arguments?, ...}`。
/// - `agent_message`：content 数组每项 {type:"output_text"|"input_text", text} → Text（输出文本进 stdout）。
/// - `agent_message_content_delta`：delta 字段为增量文本 → Text。
/// - `reasoning` / `agent_reasoning` / `agent_reasoning_raw_content`：summary 数组每项 {type:"summary_text", text}
///   或 reasoning_raw_content 的 text → Thinking（进 thought 流，不进 stdout）。
/// - `reasoning_content_delta` / `reasoning_raw_content_delta`：delta 为增量思考文本 → Thinking。
/// - `local_shell_call`：action.command 为执行的命令 → ToolUse{name:"shell", input_json:命令}。
/// - `function_call`：name + arguments → ToolUse{name, input_json:arguments}。
/// - `mcp_tool_call`：tool_name + arguments → ToolUse{name:tool_name, input_json}。
/// - 其他（file_change / command_execution / commentary / web_search 等）→ 丢弃（避免噪声，前端不需要）。
fn classify_codex_item(item: &serde_json::Value) -> Vec<StreamItem> {
    let item_ty = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match item_ty {
        // 文本输出（agent 消息）→ Text（进 stdout）。
        "agent_message" => {
            let mut items = Vec::new();
            if let Some(content) = item.get("content").and_then(|c| c.as_array()) {
                for part in content {
                    if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
                        if !text.is_empty() {
                            items.push(StreamItem::Text(text.to_string()));
                        }
                    }
                }
            }
            items
        }
        // 文本增量 → Text。
        "agent_message_content_delta" => item
            .get("delta")
            .and_then(|d| d.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| vec![StreamItem::Text(s.to_string())])
            .unwrap_or_default(),
        // 思考 → Thinking（进 thought，不进 stdout）。
        "reasoning" | "agent_reasoning" | "agent_reasoning_raw_content" => {
            let mut items = Vec::new();
            // reasoning.summary[] 每项 {type:"summary_text", text}。
            if let Some(summary) = item.get("summary").and_then(|s| s.as_array()) {
                for part in summary {
                    if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
                        if !text.is_empty() {
                            items.push(StreamItem::Thinking(text.to_string()));
                        }
                    }
                }
            }
            // 部分 reasoning 变体直接含 text 字段（agent_reasoning_raw_content）。
            if items.is_empty() {
                if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                    if !text.is_empty() {
                        items.push(StreamItem::Thinking(text.to_string()));
                    }
                }
            }
            items
        }
        // 思考增量 → Thinking。
        "reasoning_content_delta" | "reasoning_raw_content_delta" => item
            .get("delta")
            .and_then(|d| d.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| vec![StreamItem::Thinking(s.to_string())])
            .unwrap_or_default(),
        // 本地 shell 调用 → ToolUse（工具卡片）。
        "local_shell_call" => {
            let command = item
                .get("action")
                .and_then(|a| a.get("command"))
                .and_then(|c| c.as_str())
                .unwrap_or("");
            vec![StreamItem::ToolUse {
                name: "shell".to_string(),
                input_json: serde_json::json!({ "command": command }).to_string(),
            }]
        }
        // 函数调用 → ToolUse。
        "function_call" => {
            let name = item
                .get("name")
                .and_then(|n| n.as_str())
                .unwrap_or("")
                .to_string();
            let input_json = item
                .get("arguments")
                .map(normalize_tool_input)
                .unwrap_or_default();
            vec![StreamItem::ToolUse { name, input_json }]
        }
        // MCP 工具调用 → ToolUse。
        "mcp_tool_call" => {
            let name = item
                .get("tool_name")
                .and_then(|n| n.as_str())
                .unwrap_or("mcp")
                .to_string();
            let input_json = item
                .get("arguments")
                .map(normalize_tool_input)
                .unwrap_or_else(|| "{}".to_string());
            vec![StreamItem::ToolUse { name, input_json }]
        }
        // 其他类型（file_change / command_execution / commentary / web_search 等）→ 丢弃。
        _ => Vec::new(),
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

/// 规范化 tool_use 块的 input 字段为合法 JSON 字符串（修复 RUST-STREAM-04）。
///
/// 协议约定 tool_use.input 几乎必为 JSON 对象（content_block_start 时初始化为 {}，
/// 入参增量经 input_json_delta.partial_json 通道）。但理论上协议不禁止 null/标量，
/// 此前 `other.to_string()` 对 null → "null"、true → "true"、数字 → 字符串，
/// 前端工具卡片渲染出现 "AskUserQuestion null" 字面量（无害但语义错位）。
///
/// 规范化策略：
/// - String：透传（部分实现把 input 当字符串传，保持兼容）。
/// - Object / Array：序列化为 JSON 字符串（保留原结构）。
/// - Null：返回 "{}"（空对象，符合「无入参」的工具语义）。
/// - Number / Bool：包成 JSON 值序列化（保持合法 JSON 形态，避免裸字面量）。
fn normalize_tool_input(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Null => "{}".to_string(),
        serde_json::Value::Object(_) | serde_json::Value::Array(_) => value.to_string(),
        // 标量（数字/布尔）：序列化为合法 JSON 字面量（不带引号，保持类型信息）。
        other => other.to_string(),
    }
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
                                // 分类解析：按 StreamItem.type 路由到 stdout/thought/tool 流。
                                // 仅 stdout（Text）会被 transcriptTextSinceLastInput 提取（协议聚合输入），
                                // thought/tool 走独立流，前端按 stream 字段区分渲染，绝不污染 stdout。
                                extract_stream_json_items(&buffer)
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

#[cfg(unix)]
fn libc_setsid() {
    extern "C" {
        fn setsid() -> i32;
    }
    unsafe {
        let _ = setsid();
    }
}

// 修复 SPAWN-02（high 并发/资源泄漏）：stop_child_process 此前 Unix 走 kill -PGID 杀进程组，
// 但块外无条件 child.kill() + child.wait() 在 Windows 上被编译进去且 kill() 仅 TerminateProcess
// 杀直接子进程，孙子进程（MCP server、工具进程、codex 的 node 子进程）成为孤儿，
// 持续泄漏 CPU/内存/网络连接/可能持有的 LLM 会话。
// 修复：Windows 分支用 taskkill /PID <pid> /T [/F] 杀整棵进程树（与 store.rs::kill_process 对齐），
// 兜底仍走 child.kill() + child.wait() 保证 Child 句柄被回收。
// Unix 保持原 kill -PGID 语义。
fn stop_child_process(mut child: Child) {
    // 复用 kill_child_tree 发进程组/树 kill 信号（不 wait），再由本函数 wait 回收 Child 句柄。
    kill_child_tree(&child);
    let _ = child.kill();
    let _ = child.wait();
}

/// 仅向子进程及其子孙进程发送终止信号（不 wait 回收）。
/// 供 run_captured_inner 超时分支复用：发完 kill 后立即 wait_with_output 回收 stdout/stderr。
/// - Unix：kill -TERM -<pgid> → 等 → kill -KILL -<pgid>（spawn 时 setsid 已建独立进程组）。
/// - Windows：taskkill /PID <pid> /T → 等 → taskkill /F /PID <pid> /T（递归杀进程树）。
///
/// pub(crate) 供 cli_installer::cancel_install 复用（杀 winget 子进程组，AC4 安装可取消）。
pub(crate) fn kill_child_tree(child: &Child) {
    #[cfg(unix)]
    {
        let group = format!("-{}", child.id());
        let _ = Command::new("kill")
            .arg("-TERM")
            .arg("--")
            .arg(&group)
            .status();
        // 给进程组 1 秒优雅退出窗口（TERM 后轮询 try_wait 不要求 Child 可变，
        // 但 try_wait 需要 &mut，这里改为简单 sleep 等系统回收，由调用方后续 wait 确认）。
        std::thread::sleep(std::time::Duration::from_millis(100));
        let _ = Command::new("kill")
            .arg("-KILL")
            .arg("--")
            .arg(&group)
            .status();
    }
    #[cfg(windows)]
    {
        let pid = child.id();
        // 先温和终止整棵进程树，等不到再强杀。
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T"])
            .creation_flags(0x0800_0000)
            .status();
        std::thread::sleep(std::time::Duration::from_millis(100));
        let _ = Command::new("taskkill")
            .args(["/F", "/PID", &pid.to_string(), "/T"])
            .creation_flags(0x0800_0000)
            .status();
    }
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
///
/// 修复 SCRIPT-02（high 并发）：超时分支此前仅 child.kill()（Windows TerminateProcess / Unix SIGKILL）
/// 杀直接子进程，孙进程仍持有 stdout/stderr 管道写端，随后 wait_with_output() 永远读不到 EOF，
/// 导致 run_plugin_script 命令线程永久挂起（前端 ScriptPreviewPanel 卡死，15s 兜底失效）。
/// 修复：超时分支改用 stop_child_process 杀整个进程组（Unix kill -PGID / Windows taskkill /T），
/// 让所有持有管道写端的子孙进程全部退出，wait_with_output 才能真正收到 EOF 返回。
pub(crate) fn run_captured_inner(
    binary: &PathBuf,
    args: Vec<String>,
    workspace_dir: Option<&str>,
    timeout_ms: u64,
    env: Option<&[(std::ffi::OsString, std::ffi::OsString)]>,
) -> Result<CapturedOutput, String> {
    let mut command = build_spawn_command(binary, &args);
    command
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
    // 修复 SCRIPT-02：让子进程脱离父进程组（Unix setsid / Windows CREATE_NEW_PROCESS_GROUP），
    // 这样 stop_child_process 杀进程组才能波及孙进程（孙进程跟随父进入新组）。
    #[cfg(unix)]
    unsafe {
        command.pre_exec(|| {
            libc_setsid();
            Ok(())
        });
    }
    #[cfg(windows)]
    {
        // CREATE_NEW_PROCESS_GROUP (0x200)：子进程成为新进程组根，taskkill /T 递归杀整组。
        // 叠加 CREATE_NO_WINDOW (0x0800_0000)：不弹控制台窗口。
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        WindowsCommandExt::creation_flags(&mut command, CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
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
            // 修复 SCRIPT-02：杀整个进程组（含孙进程），释放管道写端，避免 wait_with_output 挂起。
            // kill_child_tree 内部按 Unix kill -PGID / Windows taskkill /T 处理，不 wait 回收，
            // 由随后的 wait_with_output 一次性回收 stdout/stderr + Child 句柄。
            kill_child_tree(&child);
            // 杀进程组后所有管道写端关闭，wait_with_output 必然返回（不会无限阻塞）。
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

/// 跨平台 PATH 探测候选二进制，Windows 优先补 .cmd/.bat（npm shim）再 .exe。
/// npm 全局装的 claude/codex/opencode 是 .cmd 批处理 shim（非 .exe）；
/// 无扩展名的同名文件是给 bash 的 shell 脚本，Rust 直接 spawn 会 os error 193，
/// 故 Windows 上优先返回带 .cmd/.bat 扩展的可执行文件。
/// pub(crate) 供 plugin_script::probe_script_runtime 复用（探测 node/py/python）。
pub(crate) fn find_binary(candidate: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        #[cfg(windows)]
        {
            // Windows 优先 .cmd/.bat（npm shim），再 .exe
            for ext in [".cmd", ".bat", ".exe"] {
                let full = dir.join(format!("{candidate}{ext}"));
                if full.is_file() {
                    return Some(full);
                }
            }
        }
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

/// 构造子进程 Command。
/// Windows 上 npm 全局 CLI（claude/codex/opencode）是 .cmd shim，其内容形如：
///   "%dp0%\node_modules\...\xxx.exe" %*       （claude/opencode 直接 exe）
///   "%_prog%" "%dp0%\node_modules\...\xxx.js" %* （codex 走 node）
/// Rust 直接 spawn .cmd 会报 "batch file arguments are invalid"；走 cmd /C 则孙子进程
/// stdout 不进入我们 piped 的 handle（Windows handle 继承缺陷）。
/// 故解析 .cmd 提取真实可执行入口（exe 或 node+js），直接 spawn，彻底绕过 cmd.exe。
pub(crate) fn build_spawn_command(binary: &std::path::Path, args: &[String]) -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let is_batch = binary
            .extension()
            .map(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"))
            .unwrap_or(false);
        if is_batch {
            if let Some(resolved) = resolve_npm_shim(binary) {
                let mut cmd = Command::new(&resolved.binary);
                cmd.creation_flags(CREATE_NO_WINDOW).args(&resolved.prefix_args).args(args);
                return cmd;
            }
            // 解析失败回退 cmd /C（至少能跑，但 stdout 可能丢）
            let mut cmd = Command::new("cmd");
            cmd.creation_flags(CREATE_NO_WINDOW).arg("/C").arg(binary).args(args);
            return cmd;
        }
        let mut cmd = Command::new(binary);
        cmd.creation_flags(CREATE_NO_WINDOW).args(args);
        return cmd;
    }
    #[cfg(not(windows))]
    {
        let mut cmd = Command::new(binary);
        cmd.args(args);
        cmd
    }
}

/// 解析 npm .cmd shim，提取其调用的真实命令。
/// 匹配 `"...path..." %*` 模式，%dp0% 替换为 .cmd 所在目录；
/// .exe 直接返回；.js/.mjs/.cjs 包装成 node 调用。
struct ResolvedShim {
    binary: PathBuf,
    prefix_args: Vec<String>,
}

fn resolve_npm_shim(cmd_path: &std::path::Path) -> Option<ResolvedShim> {
    let content = std::fs::read_to_string(cmd_path).ok()?;
    let dp0 = cmd_path.parent()?;
    // 找所有 "..." 形式的路径，取最后一个形如 node_modules/... 的（跳过 node.exe 本身的引用）
    let mut target_path: Option<String> = None;
    for cap in regex_lite_quotes(&content) {
        if cap.contains("node_modules") && (cap.ends_with(".exe") || cap.ends_with(".js") || cap.ends_with(".mjs") || cap.ends_with(".cjs")) {
            target_path = Some(cap);
        }
    }
    let raw = target_path?;
    let resolved = raw.replace("%dp0%", &dp0.to_string_lossy());
    let path = PathBuf::from(&resolved);
    match path.extension().and_then(|e| e.to_str()) {
        Some("exe") => Some(ResolvedShim { binary: path, prefix_args: vec![] }),
        Some(ext) if ext == "js" || ext == "mjs" || ext == "cjs" => {
            // .js 类：需要 node 执行
            let node = find_binary("node")?;
            Some(ResolvedShim { binary: node, prefix_args: vec![path.to_string_lossy().to_string()] })
        }
        _ => None,
    }
}

/// 轻量提取双引号包裹的内容（避免引入 regex crate 依赖）。
fn regex_lite_quotes(content: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut chars = content.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '"' {
            let mut buf = String::new();
            for c2 in chars.by_ref() {
                if c2 == '"' { break; }
                buf.push(c2);
            }
            if !buf.is_empty() { out.push(buf); }
        }
    }
    out
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
///
/// 参数：
/// - `workspace_dir`：显式 workspace 路径（优先级最高，如 main.rs 已把插件持久化目录注入此处）。
/// - `default_root`：workspace_dir 缺失时的回退根目录（app_data_dir/code-assistant），派生 claude-sandbox。
/// - `plugin_id`：组D task 06-16 预留参数（plugin_script 预览执行传 None 走显式 workspace_dir 分支）。
///   非空时理论上可解析为 plugins_root/<plugin_id>/，但当前持久化目录解析已在 main.rs 完成
///   （start_session 注入 workspace_dir），此处仅占位保持签名稳定，供后续直接调用方扩展。
pub(crate) fn resolve_workspace(workspace_dir: Option<String>, default_root: Option<&std::path::Path>, _plugin_id: Option<&str>) -> Result<String, String> {
    let path = workspace_dir
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            // 默认落到 app_data/claude-sandbox 隔离目录（不读宿主项目 CLAUDE.md/hooks），
            // 避免 claude 在项目目录运行时被 Trellis 上下文覆盖 systemPrompt。
            default_root.map(|root| root.join("claude-sandbox"))
        })
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    // 隔离目录不存在则创建（首次使用 claude-sandbox）。
    if !path.exists() {
        std::fs::create_dir_all(&path).map_err(|e| format!("创建 sandbox 目录失败：{e}"))?;
    }
    if !path.is_dir() {
        return Err(format!("workspace 不是目录：{}", path.to_string_lossy()));
    }
    path.canonicalize()
        .map(|path| path.to_string_lossy().to_string())
        .map_err(|error| error.to_string())
}

pub(crate) fn new_session_id(tool: CodeAssistantTool) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}-{}-{}", tool.as_str(), now.as_secs(), now.subsec_nanos())
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
                // 修复 RUST-STREAM-01（medium 数据一致性）：此前 build_history_summary 对 output 事件
                // 只取 payload.text，未按 payload.stream 过滤。spawn_reader 写入 transcript 时，
                // stdout/stderr/thought/tool 四类都写成 event:"output" 且 payload 含 stream 字段。
                // 该函数把所有 output 的 text 一律当作「【AI】回复」拼进摘要，导致：
                // (1) codex/opencode 永远走伪多轮，其 stderr 的诊断/warning 被当成 AI 回复；
                // (2) claude 降级为伪多轮时，思考内容（thought）和工具调用 JSON 片段（tool，含不完整
                //     input_json_delta 如 `{"path":"b`）被当成 AI 回复，污染 LLM 上下文。
                // 与前端 transcriptTextSinceLastInput 取 stream==='stdout' 对齐，仅 stdout 进【AI】，
                // stderr 用【诊断】标签保留少量价值，thought/tool 不进摘要（claude 降级路径）。
                let stream = p.get("stream").and_then(|x| x.as_str()).unwrap_or("stdout");
                let text = p.get("text").and_then(|x| x.as_str()).unwrap_or("");
                if text.trim().is_empty() {
                    continue;
                }
                match stream {
                    "stdout" => lines.push(format!("【AI】{text}")),
                    "stderr" => lines.push(format!("【诊断】{text}")),
                    // thought / tool / 其他流不进伪多轮历史摘要（避免思考原文与工具 JSON 污染）。
                    _ => {}
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
        let line = r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"先想想"}]}}"#;
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
                assert!(input_json.contains("path"), "应含 path 字段，实际 {input_json:?}");
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
        let thinking_only = r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"仅思考"}]}}"#;
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
        let line = r#"{"type":"turn.failed","error":{"message":"unexpected status 402 Payment Required"}}"#;
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
        let line = r#"{"type":"item.updated","item":{"type":"reasoning_content_delta","delta":"推理中"}}"#;
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
        assert_eq!(stream_item_to_pair(thinking), Some(("thought", "思考".to_string())));
        assert_eq!(
            stream_item_to_pair(tool),
            Some(("tool", "shell {}".to_string()))
        );
        assert_eq!(
            stream_item_to_pair(stderr),
            Some(("stderr", "[error] boom".to_string()))
        );
        assert_eq!(stream_item_to_pair(text), Some(("stdout", "正文".to_string())));
    }

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

        // 等待读取器线程消费完毕（Cursor 读尽后 read_line 返回 Ok(0) 退出）。
        // 用 transcript 行数稳定作为完成信号（3 行产出 → 3 条 output 事件）。
        let deadline = Instant::now() + std::time::Duration::from_secs(2);
        loop {
            let transcript = store.read_transcript("reader-session").unwrap_or_default();
            if transcript.lines().filter(|l| l.contains("\"event\":\"output\"")).count() >= 3
                || Instant::now() > deadline
            {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }

        // 收集所有 code-assistant://output 事件的 (stream, text)。
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

        assert_eq!(stdout_text, "正文", "stdout 应仅含正文，实际 {stdout_text:?}");
        assert_eq!(thought_text, "思考", "thought 应含思考内容，实际 {thought_text:?}");
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

        // 等待读取器消费完毕：4 行产出（thread.started 被丢弃，其余各 1 条）。
        let deadline = Instant::now() + std::time::Duration::from_secs(2);
        loop {
            let transcript = store
                .read_transcript("codex-reader-session")
                .unwrap_or_default();
            if transcript
                .lines()
                .filter(|l| l.contains("\"event\":\"output\""))
                .count()
                >= 4
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
        assert_eq!(stdout_text, "正文", "stdout 应仅含正文，实际 {stdout_text:?}");
        assert_eq!(thought_text, "思考", "thought 应含思考，实际 {thought_text:?}");
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
            configs_root: std::env::temp_dir().join(format!(
                "lingfang-real-codex-configs-{}",
                std::process::id()
            )),
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
                effort: None,
                plugin_id: None,
                cli_config: None,
            },
            // session_id 由调用方提前生成（与生产路径 main.rs 一致）。
            new_session_id(CodeAssistantTool::Codex),
            // 真实 codex 测试走降级（不注入平台 key），验证 CLI 默认配置路径仍可跑（lingfang-long-session-ok）。
            Vec::new(),
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
            configs_root: std::env::temp_dir().join(format!(
                "lingfang-real-codex-stop-configs-{}",
                std::process::id()
            )),
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
                effort: None,
                plugin_id: None,
                cli_config: None,
            },
            new_session_id(CodeAssistantTool::Codex),
            Vec::new(),
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

    /// resolve_npm_shim 应从 claude/opencode 风格的 .cmd（直接调 .exe）提取真实 exe 路径。
    /// 这是 Windows 上 npm 全局 CLI 的标准形态，Rust 直接 spawn .cmd 会丢孙子进程 stdout。
    #[cfg(windows)]
    #[test]
    fn resolve_npm_shim_extracts_exe_from_cmd() {
        let dir = std::env::temp_dir().join(format!("lf-shim-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let exe_dir = dir.join("node_modules").join("fake-cli").join("bin");
        std::fs::create_dir_all(&exe_dir).unwrap();
        std::fs::write(exe_dir.join("fake.exe"), "stub").unwrap();
        let cmd_path = dir.join("fake.cmd");
        std::fs::write(
            &cmd_path,
            "@ECHO off\nSETLOCAL\nCALL :find_dp0\n\"%dp0%\\node_modules\\fake-cli\\bin\\fake.exe\"   %*\n",
        )
        .unwrap();
        let resolved = super::resolve_npm_shim(&cmd_path).expect("应解析出 shim 入口");
        assert_eq!(resolved.binary, exe_dir.join("fake.exe"));
        assert!(resolved.prefix_args.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// resolve_npm_shim 应从 codex 风格 .cmd（node + .js）包装成 node 调用。
    #[cfg(windows)]
    #[test]
    fn resolve_npm_shim_wraps_js_with_node() {
        let dir = std::env::temp_dir().join(format!("lf-shim-js-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let js_dir = dir.join("node_modules").join("fake-cli").join("bin");
        std::fs::create_dir_all(&js_dir).unwrap();
        std::fs::write(js_dir.join("fake.js"), "// js").unwrap();
        let cmd_path = dir.join("fakejs.cmd");
        std::fs::write(
            &cmd_path,
            "endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\" \"%dp0%\\node_modules\\fake-cli\\bin\\fake.js\" %*\n",
        )
        .unwrap();
        let resolved = super::resolve_npm_shim(&cmd_path).expect("应解析出 node + js");
        assert!(
            resolved.binary.file_name().unwrap() == "node.exe" || resolved.binary.file_name().unwrap() == "node",
            "应为 node，实际 {:?}",
            resolved.binary
        );
        assert_eq!(resolved.prefix_args.len(), 1);
        assert!(resolved.prefix_args[0].ends_with("fake.js"));
        std::fs::remove_dir_all(&dir).ok();
    }

    // === sandbox 扫描（方案A：claude 写文件到 workspace，CLI 跑完扫描收成 files） ===
    //
    // 覆盖 scan_workspace_files + collect_workspace_files：
    // - 正常扫描 manifest.json + ui/index.html（claude 典型产出）。
    // - 排除隐藏文件（.env）、node_modules、.git。
    // - 跳过二进制文件（非 UTF-8）。
    // - 跳过超大文件（>256KB）。
    // - manifest.json 置顶。
    // - session 不存在报错；sandbox 空目录返回空列表。

    /// 构造一个带 sandbox 记录的 state（workspace_dir 指向临时 sandbox）。
    /// 返回 (state, sandbox_root)：测试方在 sandbox_root 下写文件后调 scan_workspace_files。
    fn state_with_sandbox(test_name: &str) -> (CodeAssistantState, PathBuf) {
        let store = temp_assistant_store(test_name);
        let sandbox = store.root().join("claude-sandbox");
        std::fs::create_dir_all(&sandbox).unwrap();
        // 写一条 session 记录，workspace_dir 指向 sandbox（scan_workspace_files 从此取路径）。
        store
            .upsert_session(SessionRecord {
                session_id: "scan-1".into(),
                tool: CodeAssistantTool::Claude,
                model: Some("sonnet".into()),
                workspace_dir: sandbox.to_string_lossy().to_string(),
                status: "exited".into(),
                transcript_path: store.transcript_path("scan-1").to_string_lossy().to_string(),
                command_preview: vec!["claude".into()],
                pid: None,
                started_at: "1".into(),
                ended_at: None,
                exit_code: Some(0),
                cli_session_id: None,
                title: None,
                archived: None,
                draft_updated_at: None,
            })
            .unwrap();
        let state = CodeAssistantState {
            store,
            processes: Arc::new(Mutex::new(HashMap::new())),
            configs_root: std::env::temp_dir().join(format!(
                "lingfang-scan-configs-{}",
                std::process::id()
            )),
        };
        (state, sandbox)
    }

    #[test]
    fn scan_returns_manifest_and_files_with_relative_paths() {
        // claude 典型产出：manifest.json + ui/index.html，扫描返回相对路径。
        let (state, sandbox) = state_with_sandbox("scan-normal");
        std::fs::write(
            sandbox.join("manifest.json"),
            r#"{"id":"pomodoro","name":"番茄钟"}"#,
        )
        .unwrap();
        std::fs::create_dir_all(sandbox.join("ui")).unwrap();
        std::fs::write(sandbox.join("ui").join("index.html"), "<html></html>").unwrap();

        let files = scan_workspace_files(
            &state,
            ScanWorkspaceInput {
                session_id: "scan-1".to_string(),
            },
        )
        .expect("扫描应成功");

        // manifest.json 置顶，ui/index.html 跟随；路径用 / 分隔（跨平台一致）。
        assert_eq!(files.len(), 2, "应返回 2 个文件，实际 {files:?}");
        assert_eq!(files[0].path, "manifest.json", "manifest.json 应置顶");
        assert_eq!(files[0].content, r#"{"id":"pomodoro","name":"番茄钟"}"#);
        assert_eq!(files[1].path, "ui/index.html");
        assert_eq!(files[1].content, "<html></html>");
    }

    #[test]
    fn scan_excludes_hidden_files_and_node_modules_and_git() {
        // 排除 .env / .git 目录 / node_modules 目录（依赖体积大且非插件源码）。
        let (state, sandbox) = state_with_sandbox("scan-exclude");
        std::fs::write(sandbox.join("manifest.json"), "{}").unwrap();
        std::fs::write(sandbox.join(".env"), "SECRET=xxx").unwrap();
        std::fs::create_dir_all(sandbox.join(".git")).unwrap();
        std::fs::write(sandbox.join(".git").join("config"), "git-config").unwrap();
        std::fs::create_dir_all(sandbox.join("node_modules")).unwrap();
        std::fs::write(
            sandbox.join("node_modules").join("lib.js"),
            "module.exports = 1",
        )
        .unwrap();
        std::fs::create_dir_all(sandbox.join("ui")).unwrap();
        std::fs::write(sandbox.join("ui").join("index.html"), "<html></html>").unwrap();

        let files = scan_workspace_files(
            &state,
            ScanWorkspaceInput {
                session_id: "scan-1".to_string(),
            },
        )
        .expect("扫描应成功");

        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        // 仅保留 manifest.json + ui/index.html，.env / .git / node_modules 全部排除。
        assert!(paths.contains(&"manifest.json"), "应含 manifest.json");
        assert!(paths.contains(&"ui/index.html"), "应含 ui/index.html");
        assert!(!paths.contains(&".env"), "不应含 .env");
        assert!(
            !paths.iter().any(|p| p.starts_with(".git")),
            "不应含 .git 目录内文件"
        );
        assert!(
            !paths.iter().any(|p| p.starts_with("node_modules")),
            "不应含 node_modules 目录内文件"
        );
    }

    #[test]
    fn scan_skips_binary_files() {
        // 二进制文件（非 UTF-8）跳过，不报错（read_to_string 失败即跳过）。
        let (state, sandbox) = state_with_sandbox("scan-binary");
        std::fs::write(sandbox.join("manifest.json"), "{}").unwrap();
        // 写入无效 UTF-8 字节序列（二进制文件）。
        let binary = vec![0xFFu8, 0xFE, 0xFD, 0x00];
        std::fs::write(sandbox.join("image.png"), binary).unwrap();
        std::fs::create_dir_all(sandbox.join("ui")).unwrap();
        std::fs::write(sandbox.join("ui").join("index.html"), "<html></html>").unwrap();

        let files = scan_workspace_files(
            &state,
            ScanWorkspaceInput {
                session_id: "scan-1".to_string(),
            },
        )
        .expect("扫描应成功（二进制跳过不报错）");

        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert!(!paths.contains(&"image.png"), "二进制文件应跳过");
        assert!(paths.contains(&"manifest.json"));
        assert!(paths.contains(&"ui/index.html"));
    }

    #[test]
    fn scan_skips_oversized_files() {
        // 超大文件（>256KB）跳过，对齐后端 MAX_PLUGIN_FILE_BYTES 限制。
        let (state, sandbox) = state_with_sandbox("scan-oversize");
        std::fs::write(sandbox.join("manifest.json"), "{}").unwrap();
        // 写一个 300KB 的文本文件（超 256KB 限制）。
        let big = "x".repeat(300 * 1024);
        std::fs::write(sandbox.join("huge.txt"), big).unwrap();
        std::fs::create_dir_all(sandbox.join("ui")).unwrap();
        std::fs::write(sandbox.join("ui").join("index.html"), "<html></html>").unwrap();

        let files = scan_workspace_files(
            &state,
            ScanWorkspaceInput {
                session_id: "scan-1".to_string(),
            },
        )
        .expect("扫描应成功（超大文件跳过）");

        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert!(!paths.contains(&"huge.txt"), "超大文件应跳过");
        assert!(paths.contains(&"manifest.json"));
    }

    #[test]
    fn scan_empty_sandbox_returns_empty_list() {
        // 空目录（纯对话 / claude 未写文件）返回空列表，调用方据此回退对话态逻辑。
        let (state, _sandbox) = state_with_sandbox("scan-empty");
        let files = scan_workspace_files(
            &state,
            ScanWorkspaceInput {
                session_id: "scan-1".to_string(),
            },
        )
        .expect("空 sandbox 应返回空列表");
        assert!(files.is_empty(), "空 sandbox 应返回空列表");
    }

    #[test]
    fn scan_missing_session_errors() {
        // session 不存在报错（不静默吞，避免前端拿到空列表误判为「claude 没写文件」）。
        let store = temp_assistant_store("scan-missing-session");
        let state = CodeAssistantState {
            store,
            processes: Arc::new(Mutex::new(HashMap::new())),
            configs_root: std::env::temp_dir().join(format!(
                "lingfang-scan-missing-configs-{}",
                std::process::id()
            )),
        };
        let result = scan_workspace_files(
            &state,
            ScanWorkspaceInput {
                session_id: "nonexistent".to_string(),
            },
        );
        assert!(result.is_err(), "session 不存在应报错");
    }

    // 修复 RUSTSHIM-04（medium 逻辑 bug）：sandbox 内目录符号链接环不应导致栈溢出 panic。
    // 修复前用 entry.metadata()（跟随符号链接）判定 is_dir，对指向祖先目录的符号链接
    // 递归 collect_workspace_files 会沿符号链接无限深入，栈溢出 abort 整个 Tauri 进程。
    // 修复后用 symlink_metadata（不跟随），符号链接被视为非目录直接跳过。
    // 注：Unix 才支持创建符号链接；Windows 需要特殊权限/开发者模式，cfg 限制为 unix。
    #[cfg(unix)]
    #[test]
    fn scan_does_not_stack_overflow_on_symlink_loop() {
        use std::os::unix::fs::symlink;
        let (state, sandbox) = state_with_sandbox("scan-symlink-loop");
        std::fs::write(sandbox.join("manifest.json"), "{}").unwrap();
        std::fs::create_dir_all(sandbox.join("realdir")).unwrap();
        std::fs::write(sandbox.join("realdir").join("a.txt"), "a").unwrap();
        // 创建指向祖先目录的符号链接（构成环：sandbox/loop -> sandbox）。
        symlink(&sandbox, sandbox.join("loop")).unwrap();
        // 创建指向自身的目录符号链接（最经典的环）。
        symlink(
            sandbox.join("self-loop"),
            sandbox.join("self-loop-target"),
        )
        .ok(); // 可能因目标不存在而失败，不影响主断言

        // 关键断言：scan 应正常返回（不栈溢出 panic），且符号链接本身被跳过。
        let files = scan_workspace_files(
            &state,
            ScanWorkspaceInput {
                session_id: "scan-1".to_string(),
            },
        )
        .expect("符号链接环场景应正常扫描不栈溢出");
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        // manifest.json + realdir/a.txt 应被收集；符号链接目录不被递归。
        assert!(paths.contains(&"manifest.json"), "应含 manifest.json");
        assert!(paths.contains(&"realdir/a.txt"), "应含 realdir/a.txt");
        // 符号链接目录不应进结果（symlink_metadata 判定为非普通文件，跳过）。
        assert!(
            !paths.iter().any(|p| p.starts_with("loop")),
            "符号链接目录不应被递归扫描：{paths:?}"
        );
    }
}
