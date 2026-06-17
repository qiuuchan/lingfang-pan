pub mod adapters;
mod process;
pub mod store;
mod stream;

use crate::cli_config;
use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
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

#[cfg(test)]
static PROCESS_TREE_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
pub(crate) fn process_tree_test_lock() -> std::sync::MutexGuard<'static, ()> {
    PROCESS_TREE_TEST_LOCK
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
}

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use adapters::{tool_definition, CodeAssistantTool, ToolCommand, TOOL_DEFINITIONS};
use process::{
    build_spawn_command, command_preview, prepare_process_group, run_capture, stop_child_process,
};
pub(crate) use process::{
    find_binaries, find_binary, kill_child_tree, run_capture_with_env, CapturedOutput,
};
use store::{
    now_millis, now_string, AssistantStore, CodeAssistantConfig, RegisteredAgentProcess,
    SessionRecord,
};
use stream::{
    extract_codex_json_items, extract_stream_json_session_id, stream_item_to_pair,
    ClaudeStreamJsonState, OutputFormat,
};
#[cfg(test)]
use stream::{extract_stream_json_items, extract_stream_json_text, StreamItem};

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
    // 系统提示词：追问轮也传（claude --system-prompt），保证降级分支（claude 缺 cli_session_id 伪多轮）
    // 与 codex/opencode（永远伪多轮）也有 LingFang 插件开发规范约束，不因缺首轮 system prompt 续接而丢失。
    // claude resume 分支重复传无害（resume 恢复上下文 + system-prompt 重申当前约束）。
    #[serde(default, alias = "systemPrompt")]
    pub system_prompt: Option<String>,
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
        out.push(DraftFileJson { path: rel, content });
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

/// workspace 目录校验 + canonicalize（防符号链接逃逸）。
/// pub(crate) 供 plugin_script::run_plugin_script 复用其 canonicalize 逻辑。
///
/// 参数：
/// - `workspace_dir`：显式 workspace 路径（优先级最高，如 main.rs 已把插件持久化目录注入此处）。
/// - `default_root`：workspace_dir 缺失时的回退根目录（app_data_dir/code-assistant），派生 claude-sandbox。
/// - `plugin_id`：组D task 06-16 预留参数（plugin_script 预览执行传 None 走显式 workspace_dir 分支）。
///   非空时理论上可解析为 plugins_root/<plugin_id>/，但当前持久化目录解析已在 main.rs 完成
///   （start_session 注入 workspace_dir），此处仅占位保持签名稳定，供后续直接调用方扩展。
pub(crate) fn resolve_workspace(
    workspace_dir: Option<String>,
    default_root: Option<&std::path::Path>,
    _plugin_id: Option<&str>,
) -> Result<String, String> {
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
        let (ev, payload) = (v.get("event").and_then(|x| x.as_str()), v.get("payload"));
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
mod tests;
