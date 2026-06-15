//! LingFang 桌面壳（Tauri 2，见 ADR-0001 / ADR-0004）。
//! 极简工作台 + 插件加载器 + capability 权限网关。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod capability;
mod cli_config;
mod cli_installer;
mod code_assistant;
mod llm_credentials;
mod llm_fetch;
mod plugin_script;
mod plugins;
mod updater;

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{Emitter, Manager};

use capability::CapabilityRegistry;
use plugins::LoadedPlugin;

/// 壳全局状态：能力注册表 + 已加载插件。
struct AppState {
    registry: Arc<CapabilityRegistry>,
    plugins: Vec<LoadedPlugin>,
}

/// 命令：列出已加载（内置）插件。
#[tauri::command]
fn list_plugins(state: tauri::State<AppState>) -> Vec<LoadedPlugin> {
    state.plugins.clone()
}

/// 命令：拉起 AI 换装批量版 Python 程序（R4）。
///
/// 在 builtin-plugins/ai-wardrobe 目录下，用探测到的 Python 解释器 detached 启动 main.py
/// （PySide6 GUI 独立窗口，不嵌入桌面端）。不阻塞：spawn 后立即返回。
/// 依赖（PySide6/requests/Pillow）需用户预先 pip install（缺失时程序自身报错，前端提示）。
#[tauri::command]
fn launch_ai_wardrobe(app: tauri::AppHandle) -> Result<(), String> {
    use std::process::Command;
    // 换装程序目录定位（与 builtin_dir 同款：开发态 CARGO_MANIFEST_DIR/../builtin-plugins，打包态 resource_dir）。
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.join("builtin-plugins").join("ai-wardrobe"));
    let base = if let Some(d) = dev {
        if d.exists() {
            d
        } else {
            app.path()
                .resource_dir()
                .map(|r| r.join("builtin-plugins").join("ai-wardrobe"))
                .unwrap_or_else(|_| PathBuf::from("builtin-plugins/ai-wardrobe"))
        }
    } else {
        app.path()
            .resource_dir()
            .map(|r| r.join("builtin-plugins").join("ai-wardrobe"))
            .unwrap_or_else(|_| PathBuf::from("builtin-plugins/ai-wardrobe"))
    };
    if !base.exists() {
        return Err(format!("换装程序目录不存在：{}", base.display()));
    }
    let entry = base.join("main.py");
    if !entry.exists() {
        return Err(format!("换装入口文件不存在：{}", entry.display()));
    }
    // 探测 Python 解释器（与 plugin_script 同款候选顺序：Windows 优先 py launcher）。
    let candidates: Vec<&str> = if cfg!(windows) {
        vec!["py", "python", "python3"]
    } else {
        vec!["python3", "python"]
    };
    let python = candidates
        .iter()
        .find_map(|c| code_assistant::find_binary(c))
        .ok_or_else(|| "未找到 Python 解释器，请先安装 Python 并加入 PATH".to_string())?;
    // detached 启动：gui main.py 独立运行，桌面端不等待。
    Command::new(python)
        .arg(&entry)
        .current_dir(&base)
        .spawn()
        .map_err(|e| format!("启动换装程序失败：{e}"))?;
    Ok(())
}

/// 命令：插件网络请求（R5 net.fetch capability）。
///
/// 内置可信插件经前端桥调用 sdk.net.fetch 时走此命令：从 Rust 进程发起 HTTP 请求，
/// 绕过 webview 跨域（CORS）限制。仅允许 manifest 声明了 net.fetch 的插件调用。
/// args: { url, method?, headers?, body? }。返回 { status, headers, body }。
/// 限制：30s 超时，body 最大 10 MiB（防滥用）。
#[tauri::command]
async fn plugin_net_fetch(
    state: tauri::State<'_, AppState>,
    plugin_id: String,
    args: Value,
) -> Result<Value, String> {
    // 1) manifest 声明校验：仅声明了 net.fetch 的插件可用。
    let declared = state.registry.find(&plugin_id, "net.fetch");
    if declared.is_none() {
        return Err(format!("插件未声明能力: net.fetch"));
    }
    let url = args
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "net.fetch 缺少 url 参数".to_string())?;
    // 仅允许 http/https（防 file:// 等本地协议绕过）。
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("net.fetch 仅支持 http/https".to_string());
    }
    let method = args
        .get("method")
        .and_then(|v| v.as_str())
        .unwrap_or("GET")
        .to_uppercase();
    // 2) 构建请求（reqwest 从 Rust 进程发，不受 webview CORS 约束）。
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .user_agent("LingFang-Desktop-Plugin")
        .build()
        .map_err(|e| format!("网络请求初始化失败：{e}"))?;
    let mut req = match method.as_str() {
        "GET" => client.get(url),
        "POST" => client.post(url),
        "PUT" => client.put(url),
        "DELETE" => client.delete(url),
        "PATCH" => client.patch(url),
        other => return Err(format!("net.fetch 不支持的方法：{other}")),
    };
    // headers：透传插件指定的请求头（如 Authorization）。
    if let Some(headers) = args.get("headers").and_then(|v| v.as_object()) {
        for (k, v) in headers {
            if let Some(s) = v.as_str() {
                req = req.header(k, s);
            }
        }
    }
    // body：JSON 字符串透传。
    if let Some(body) = args.get("body") {
        req = req.json(body);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("网络请求失败：{e}"))?;
    let status = resp.status().as_u16();
    // 响应头（扁平化为 string=>string）。
    let headers: serde_json::Map<String, Value> = {
        let mut m = serde_json::Map::new();
        for (k, v) in resp.headers() {
            if let Ok(vs) = v.to_str() {
                m.insert(k.as_str().to_string(), Value::String(vs.to_string()));
            }
        }
        m
    };
    // body 文本（限制 10 MiB，防超大响应撑爆内存）。
    const MAX_BODY_BYTES: usize = 10 * 1024 * 1024;
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("读取响应失败：{e}"))?;
    if bytes.len() > MAX_BODY_BYTES {
        return Err(format!("响应体超过 {} 字节上限", MAX_BODY_BYTES));
    }
    // 尝试 UTF-8 解码；失败给 base64（前端按需处理）。此处简化：lossy 转 string。
    let body = String::from_utf8_lossy(&bytes).to_string();
    Ok(json!({ "status": status, "headers": headers, "body": body }))
}

/// 命令：读取插件资源文件内容（用于壳加载 entry HTML）。
/// 仅允许读取该插件自身目录下的文件，防止路径穿越。
#[tauri::command]
fn read_plugin_file(
    state: tauri::State<AppState>,
    plugin_id: String,
    file: String,
) -> Result<String, String> {
    let plugin = state
        .plugins
        .iter()
        .find(|p| p.id == plugin_id)
        .ok_or_else(|| format!("插件不存在: {plugin_id}"))?;

    let base = std::path::Path::new(&plugin.dir)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let target = base.join(&file).canonicalize().map_err(|e| e.to_string())?;
    // 防穿越：目标必须仍在插件目录内。
    if !target.starts_with(&base) {
        return Err("非法文件路径".to_string());
    }
    std::fs::read_to_string(&target).map_err(|e| e.to_string())
}

/// 命令：插件调用 capability（三重校验 + 执行，见 capability.rs）。
#[tauri::command]
fn invoke_capability(
    state: tauri::State<AppState>,
    plugin_id: String,
    kind: String,
    args: Value,
) -> Result<Value, String> {
    capability::invoke(&state.registry, &plugin_id, &kind, &args).map_err(|e| e.to_string())
}

#[tauri::command]
fn code_assistant_list_tools() -> Vec<code_assistant::ToolAvailability> {
    code_assistant::list_tools()
}

#[tauri::command]
fn code_assistant_check_tool(
    input: code_assistant::CheckToolInput,
) -> code_assistant::ToolAvailability {
    code_assistant::check_tool(input.tool)
}

#[tauri::command]
fn code_assistant_run_probe(
    state: tauri::State<code_assistant::CodeAssistantState>,
    input: code_assistant::ProbeInput,
) -> Result<code_assistant::ProbeResult, String> {
    code_assistant::run_probe(&state, input)
}

#[tauri::command]
fn code_assistant_get_config(
    state: tauri::State<code_assistant::CodeAssistantState>,
) -> code_assistant::store::CodeAssistantConfig {
    code_assistant::get_config(&state)
}

#[tauri::command]
fn code_assistant_save_config(
    state: tauri::State<code_assistant::CodeAssistantState>,
    input: code_assistant::SaveConfigInput,
) -> Result<code_assistant::store::CodeAssistantConfig, String> {
    code_assistant::save_config(&state, input)
}

#[tauri::command]
async fn code_assistant_start_session(
    app: tauri::AppHandle,
    state: tauri::State<'_, code_assistant::CodeAssistantState>,
    mut input: code_assistant::StartSessionInput,
) -> Result<code_assistant::store::SessionRecord, String> {
    // 前端未指定 workspace 时，落到 app_data 下的 sandbox 目录，避免 CLI 沿宿主项目根读取 CLAUDE.md/.claude。
    if input
        .workspace_dir
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_none()
    {
        if let Ok(data_dir) = app.path().app_data_dir() {
            let sandbox = data_dir.join("claude-sandbox");
            let _ = std::fs::create_dir_all(&sandbox);
            input.workspace_dir = Some(sandbox.to_string_lossy().to_string());
        }
    }
    let state_inner = state.inner().clone();
    // CLI 配置注入（task 06-15）：提前生成 session_id，spawn 前从后端拿 apiKey + apiUrl 生成 cli_env。
    // session_id 提前生成是为了让临时配置目录路径（cli-configs/<sessionId>/）与 session 记录一致，
    // 便于会话结束清理（AC7）。backendUrl + token 从前端 webview 传入，key 明文只在 Rust 内流转（AC8）。
    // model 透传：用户选定模型写进 codex config.toml 顶级 model 字段 + opencode.json 的 lingfang/<model>
    // （task 06-15-custom-model-config-file-flow）。claude 忽略（走 --model 命令行参数）。
    let session_id = code_assistant::new_session_id(input.tool);
    let cli_env = resolve_cli_env(
        &app,
        &state_inner,
        input.cli_config.as_ref(),
        &session_id,
        input.tool,
        input.model.as_deref(),
    )
    .await;
    code_assistant::start_session(app, state_inner, input, session_id, cli_env)
}

#[tauri::command]
async fn code_assistant_send_input(
    app: tauri::AppHandle,
    state: tauri::State<'_, code_assistant::CodeAssistantState>,
    input: code_assistant::SendInputInput,
) -> Result<(), String> {
    let state_inner = state.inner().clone();
    // 追问轮同样注入（保证多轮用平台 key/url）。session_id 已存在于入参，tool 从 session 记录取。
    // model 透传同 start_session：写进 codex/opencode 配置文件（task 06-15）。
    // 仅取本轮 input.model；追问未传 model 时配置文件回退 default，但 CLI 命令行已通过
    // effective_model（input.model.or(session.model)）兜底，配置层 default 不影响实际使用的模型。
    let tool = code_assistant::lookup_session_tool(&state_inner, &input.session_id);
    let cli_env = resolve_cli_env(
        &app,
        &state_inner,
        input.cli_config.as_ref(),
        &input.session_id,
        tool,
        input.model.as_deref(),
    )
    .await;
    code_assistant::send_input(app, &state_inner, input, cli_env)
}

/// 解析 CLI 配置注入 env（claude/codex/opencode 的隔离配置生成）。
///
/// 流程（task 06-15）：
/// 1. cli_config 缺失（前端未传 backendUrl/token）→ 返回空 Vec（降级，AC4）。
/// 2. Rust 内部调 `llm_credentials::fetch_credentials` 从后端拿 (apiKey, apiUrl)（AC8 key 不进前端）。
/// 3. 调 `cli_config::prepare_cli_env` 按 tool 类型生成 env（claude 纯 env / codex CODEX_HOME+config.toml / opencode OPENCODE_CONFIG+json），
///    并把用户选定 model 写进 codex/opencode 配置文件（task 06-15-custom-model-config-file-flow）。
/// 4. fetch 失败/无 key → 返回空 Vec（降级，CLI 走默认配置，不崩）。
///
/// `model`：用户选定模型 id（已 clean：None 或非空且非 default）。codex 写 config.toml 顶级 model；
/// opencode 写 json `lingfang/<model>`；claude 忽略（走 --model 命令行参数）。
async fn resolve_cli_env(
    _app: &tauri::AppHandle,
    state: &code_assistant::CodeAssistantState,
    cli_config: Option<&code_assistant::CliConfigInput>,
    session_id: &str,
    tool: code_assistant::adapters::CodeAssistantTool,
    model: Option<&str>,
) -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
    // 前端未传 cli_config（未登录或后端未配置）→ 降级不注入（AC4）。
    let Some(cli_config) = cli_config else {
        return Vec::new();
    };
    let (backend_url, auth_token) = match (cli_config.backend_url.as_str(), cli_config.auth_token.as_str()) {
        (url, token) if !url.trim().is_empty() && !token.trim().is_empty() => (url, token),
        _ => return Vec::new(),
    };
    // Rust 内部调后端拿 key/url（降级 None 时返回空 Vec）。
    let credentials = match llm_credentials::fetch_credentials(backend_url, auth_token).await {
        Ok(Some((key, url))) => (key, url),
        _ => return Vec::new(),
    };
    // 临时配置目录：app_data/cli-configs/<sessionId>/（codex/opencode 写文件，claude 不写）。
    let config_dir = state.configs_root().join(session_id);
    cli_config::prepare_cli_env(tool, &credentials.0, &credentials.1, &config_dir, model)
}

#[tauri::command]
fn code_assistant_stop_session(
    app: tauri::AppHandle,
    state: tauri::State<code_assistant::CodeAssistantState>,
    input: code_assistant::StopSessionInput,
) -> Result<(), String> {
    code_assistant::stop_session(app, &state, input)
}

#[tauri::command]
fn code_assistant_list_sessions(
    state: tauri::State<code_assistant::CodeAssistantState>,
) -> Vec<code_assistant::store::SessionRecord> {
    code_assistant::list_sessions(&state)
}

#[tauri::command]
fn code_assistant_read_transcript(
    state: tauri::State<code_assistant::CodeAssistantState>,
    input: code_assistant::ReadTranscriptInput,
) -> Result<String, String> {
    code_assistant::read_transcript(&state, input)
}

#[tauri::command]
fn code_assistant_rename_session(
    state: tauri::State<code_assistant::CodeAssistantState>,
    input: code_assistant::RenameSessionInput,
) -> Result<code_assistant::store::SessionRecord, String> {
    code_assistant::rename_session(&state, input)
}

#[tauri::command]
fn code_assistant_delete_session(
    state: tauri::State<code_assistant::CodeAssistantState>,
    input: code_assistant::DeleteSessionInput,
) -> Result<(), String> {
    code_assistant::delete_session(&state, input)
}

#[tauri::command]
fn code_assistant_save_draft(
    state: tauri::State<code_assistant::CodeAssistantState>,
    input: code_assistant::SaveDraftInput,
) -> Result<(), String> {
    code_assistant::save_draft(&state, input)
}

#[tauri::command]
fn code_assistant_read_draft(
    state: tauri::State<code_assistant::CodeAssistantState>,
    input: code_assistant::ReadDraftInput,
) -> Result<Option<Value>, String> {
    code_assistant::read_draft(&state, input)
}

/// 扫描 sandbox 目录收成结构化文件列表（方案A：claude 用 Write 工具把插件文件写到 workspace，
/// CLI 跑完后 Rust 扫描目录产出 files 供前端构建 PluginDraft）。
#[tauri::command]
fn code_assistant_scan_workspace(
    state: tauri::State<code_assistant::CodeAssistantState>,
    input: code_assistant::ScanWorkspaceInput,
) -> Result<Vec<code_assistant::DraftFileJson>, String> {
    code_assistant::scan_workspace_files(&state, input)
}

/// 定位内置插件目录：开发态用源码路径，打包态用资源目录。
fn builtin_dir(app: &tauri::App) -> PathBuf {
    // 开发态：CARGO_MANIFEST_DIR/../builtin-plugins
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.join("builtin-plugins"));
    if let Some(d) = dev {
        if d.exists() {
            return d;
        }
    }
    // 打包态：资源目录下的 builtin-plugins
    app.path()
        .resource_dir()
        .map(|r| r.join("builtin-plugins"))
        .unwrap_or_else(|_| PathBuf::from("builtin-plugins"))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let registry = Arc::new(CapabilityRegistry::default());
            let dir = builtin_dir(app);
            let loaded = plugins::load_builtin_plugins(&dir, &registry);
            eprintln!("已加载 {} 个内置插件（目录 {:?}）", loaded.len(), dir);
            app.manage(AppState {
                registry,
                plugins: loaded,
            });
            let assistant_state = code_assistant::CodeAssistantState::new(app)?;
            app.manage(assistant_state);
            // updater 全局 State：缓存 check_update 拿到的 Update，供 download_and_install 取用。
            app.manage(updater::PendingUpdate(std::sync::Mutex::new(None)));
            let _ = app.emit(
                "code-assistant://availability-changed",
                code_assistant::list_tools(),
            );
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_plugins,
            read_plugin_file,
            invoke_capability,
            launch_ai_wardrobe,
            plugin_net_fetch,
            code_assistant_list_tools,
            code_assistant_check_tool,
            code_assistant_run_probe,
            code_assistant_get_config,
            code_assistant_save_config,
            code_assistant_start_session,
            code_assistant_send_input,
            code_assistant_stop_session,
            code_assistant_list_sessions,
            code_assistant_read_transcript,
            code_assistant_rename_session,
            code_assistant_delete_session,
            code_assistant_save_draft,
            code_assistant_read_draft,
            code_assistant_scan_workspace,
            plugin_script::probe_script_runtime,
            plugin_script::run_plugin_script,
            cli_installer::install_cli,
            cli_installer::install_runtime,
            cli_installer::cancel_install,
            llm_fetch::fetch_models,
            updater::check_update,
            updater::download_and_install
        ])
        .run(tauri::generate_context!())
        .expect("启动 LingFang 桌面壳失败");
}
