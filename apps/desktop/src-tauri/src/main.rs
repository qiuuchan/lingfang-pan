//! LingFang 桌面壳（Tauri 2，见 ADR-0001 / ADR-0004）。
//! 极简工作台 + 插件加载器 + capability 权限网关。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod capability;
mod code_assistant;
mod plugin_script;
mod plugins;

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::Value;
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
fn code_assistant_start_session(
    app: tauri::AppHandle,
    state: tauri::State<code_assistant::CodeAssistantState>,
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
    code_assistant::start_session(app, state.inner().clone(), input)
}

#[tauri::command]
fn code_assistant_send_input(
    app: tauri::AppHandle,
    state: tauri::State<code_assistant::CodeAssistantState>,
    input: code_assistant::SendInputInput,
) -> Result<(), String> {
    code_assistant::send_input(app, &state, input)
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
            plugin_script::probe_script_runtime,
            plugin_script::run_plugin_script
        ])
        .run(tauri::generate_context!())
        .expect("启动 LingFang 桌面壳失败");
}
