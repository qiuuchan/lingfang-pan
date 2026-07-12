//! LingFang 桌面壳（Tauri 2，见 ADR-0001 / ADR-0004）。
//! 极简工作台 + 插件加载器 + capability 权限网关。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod builtin_plugin_bundle;
mod builtin_plugin_index;
mod capability;
mod draft_plugin;
mod mirror_presets;
mod plugin_artifact_v4;
mod plugin_llm_bridge;
mod plugin_package_manager;
mod plugin_runner;
mod plugin_script;
mod plugin_security;
mod plugin_shell;
mod plugin_store;
mod plugins;
mod process_util;
mod runtime_commands;
mod runtime_config;
mod runtime_download;
mod runtime_resolver;
mod update;
mod upload;

use std::sync::Arc;

use serde_json::{json, Value};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::WindowEvent;
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

/// 命令：启动内置脚本插件（builtin-plugins 下的 nodejs/python）。
///
/// 内置插件 id 允许 `builtin.xxx` 这种点号命名，不能直接复用 plugins_root 的
/// plugin_id 白名单目录解析；这里用已加载插件表定位资源目录，再复用 plugin_runner
/// 的按目录启动逻辑，避免把 main.py/index.js 当 HTML iframe 渲染。
#[tauri::command]
fn start_builtin_plugin(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    process_table: tauri::State<plugin_runner::PluginProcessTable>,
    bridge: tauri::State<plugin_llm_bridge::PluginLlmBridge>,
    plugin_id: String,
    api_base: Option<String>,
    auth_token: Option<String>,
) -> Result<plugin_runner::StartPluginResult, String> {
    let plugin = state
        .plugins
        .iter()
        .find(|plugin| plugin.id == plugin_id)
        .ok_or_else(|| format!("内置插件不存在: {plugin_id}"))?;
    let plugin_dir = std::path::Path::new(&plugin.dir)
        .canonicalize()
        .map_err(|error| format!("内置插件目录不可用：{error}"))?;
    plugin_runner::start_plugin_from_dir(
        &app,
        process_table.inner(),
        bridge.inner(),
        &plugin_id,
        plugin_dir,
        api_base,
        auth_token,
    )
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
    let resp = req.send().await.map_err(|e| format!("网络请求失败：{e}"))?;
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

// code_assistant CLI（ClaudeCode/Codex 子进程）已整体移除：AI 能力统一走平台 relay（见 docs/billing-and-relay-design.md）。
// 原 code_assistant_* / fetch_models / test_llm_chat 命令及 mod code_assistant / llm_credentials / llm_fetch 一并删除。

// 项 11：系统托盘 + 关窗最小化到托盘。
//
// 托盘图标：左键单击 / 右键菜单「显示窗口」→ 显示并聚焦主窗口；菜单「退出」→ app.exit(0)。
// 关窗：不直接退出，prevent_close 后向主窗口 emit `close-requested`，由前端按偏好
// （lf:close-action：ask/tray/quit，localStorage）决定 隐藏到托盘 / 退出 / 弹询问。
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn setup_tray(app: &tauri::App) -> Result<(), tauri::Error> {
    let show_item = MenuItem::with_id(app, "tray-show", "显示窗口", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "tray-quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &sep, &quit_item])?;
    TrayIconBuilder::with_id("main-tray")
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("灵坊")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray-show" => show_main_window(app),
            "tray-quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // 左键单击恢复窗口（右键由系统触发菜单）。
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// 前端在「直接退出」选择后调用，立即结束进程（配合关窗询问流程）。
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // task 06-16 组A：插件持久化目录存储（plugins_root 配置 + 目录定位 + 状态扫描）。
            // 组B 的 start_plugin/stop_plugin 经此 State 的 ensure_plugin_dir 解析插件目录，
            // scan_plugin_status 据此扫文件系统判 ready/incomplete/error + 合并组B 内存进程表判 running。
            // 配置落 app_data_dir/plugins/.lingfang/config.json（原子写），默认 plugins_root = app_data_dir/plugins。
            let plugin_store = plugin_store::PluginStore::new(
                &app.path().app_data_dir().map_err(|e| e.to_string())?,
            )?;
            match draft_plugin::migrate_drafts_impl(app.handle(), &plugin_store) {
                Ok(message) => eprintln!("[legacy-draft-import] {message}"),
                Err(error) => eprintln!("[legacy-draft-import] 迁移失败（保留旧目录）：{error}"),
            }
            let plugin_package_manager =
                plugin_package_manager::PluginPackageManager::new(&plugin_store)?;
            match plugin_package_manager.migrate_legacy_layout() {
                Ok((migrated, failed)) => {
                    eprintln!("[plugin-v4-migration] migrated={migrated} failed={failed}")
                }
                Err(error) => {
                    eprintln!("[plugin-v4-migration] 启动迁移失败（保留旧目录）：{error}")
                }
            }
            match plugin_package_manager.register_builtins(
                builtin_plugin_bundle::INDEX_JSON,
                builtin_plugin_bundle::ARTIFACTS,
            ) {
                Ok(count) => eprintln!("[plugin-v4-builtins] registered={count}"),
                Err(error) => eprintln!("[plugin-v4-builtins] 注册失败：{error}"),
            }
            let registry = Arc::new(CapabilityRegistry::default());
            let builtin_release_dirs = plugin_package_manager
                .list_installations()
                .into_iter()
                .filter(|installation| {
                    installation.origin == plugin_package_manager::InstallationOrigin::Builtin
                })
                .map(|installation| std::path::PathBuf::from(installation.active_release.path))
                .collect();
            let loaded = plugins::load_builtin_plugins_from_dirs(builtin_release_dirs, &registry);
            eprintln!("已从本机安装账本加载 {} 个内置插件", loaded.len());
            app.manage(AppState {
                registry,
                plugins: loaded,
            });
            app.manage(plugin_store);
            app.manage(plugin_package_manager);
            // task 06-16 组B：插件持久化运行引擎的内存进程表（plugin_id→Child 句柄）。
            // start_plugin/stop_plugin/get_plugin_status 经此 State spawn/take/kill 进程。
            app.manage(plugin_runner::PluginProcessTable::new());
            // task 06-26：Node/Python 插件通过 localhost 一次性 token 调平台 LLM；
            // 桥持有后端地址与登录态，插件进程不直接接触 JWT/API Key。
            app.manage(plugin_llm_bridge::PluginLlmBridge::new());
            // 项 11：系统托盘（显示窗口 / 退出菜单 + 左键单击恢复）。
            setup_tray(app)?;
            Ok(())
        })
        // 项 11：关窗拦截——prevent_close + emit close-requested，由前端按偏好决定（托盘/退出/询问）。
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.emit("close-requested", ());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            quit_app,
            list_plugins,
            start_builtin_plugin,
            read_plugin_file,
            invoke_capability,
            plugin_net_fetch,
            plugin_script::probe_script_runtime,
            plugin_script::run_plugin_script,
            plugin_shell::run_plugin_shell,
            runtime_commands::get_runtime_status,
            runtime_commands::get_runtime_config,
            runtime_commands::set_mirror_config,
            runtime_commands::download_runtime,
            runtime_commands::uninstall_runtime,
            runtime_commands::set_user_specified_runtime,
            runtime_commands::probe_system_runtime,
            plugin_runner::start_plugin,
            plugin_runner::stop_plugin,
            plugin_runner::delete_plugin,
            plugin_runner::get_plugin_status,
            plugin_store::get_plugins_root,
            plugin_store::set_plugins_root,
            plugin_store::scan_plugin_status,
            plugin_store::read_local_plugin_file,
            plugin_store::read_local_plugin_file_bytes,
            plugin_store::write_plugin_files,
            plugin_store::write_plugin_file_bytes,
            plugin_store::list_plugin_files,
            plugin_store::write_plugin_file,
            plugin_store::delete_plugin_file,
            plugin_store::move_plugin_file,
            plugin_store::set_plugin_draft_flag,
            plugin_store::open_plugins_root,
            plugin_store::open_plugin_dir,
            plugin_store::rename_plugin_dir,
            plugin_package_manager::commands::list_plugin_installations,
            plugin_package_manager::commands::install_plugin_artifact,
            plugin_package_manager::commands::load_installed_plugin,
            plugin_package_manager::commands::preview_pending_installed_plugin,
            plugin_package_manager::commands::activate_pending_client_plugin,
            plugin_package_manager::commands::discard_pending_plugin_update,
            plugin_package_manager::commands::rollback_plugin_installation,
            plugin_package_manager::commands::uninstall_plugin_installation,
            plugin_package_manager::commands::start_installed_plugin,
            plugin_package_manager::commands::stop_installed_plugin,
            plugin_package_manager::commands::list_draft_workspaces,
            plugin_package_manager::commands::read_draft_workspace_files,
            plugin_package_manager::commands::create_draft_workspace,
            plugin_package_manager::commands::import_draft_workspace,
            plugin_package_manager::commands::copy_installation_to_draft_workspace,
            plugin_package_manager::commands::pack_draft_workspace,
            plugin_package_manager::commands::mark_draft_workspace_published,
            plugin_package_manager::commands::delete_draft_workspace,
            plugin_package_manager::commands::sync_draft_workspace_metadata,
            plugin_package_manager::commands::inspect_lfplugin_v4,
            plugin_package_manager::commands::sha256_lfplugin,
            plugin_package_manager::network::download_plugin_release,
            plugin_package_manager::network::publish_draft_workspace,
            plugin_package_manager::network::publish_local_artifact,
            draft_plugin::migrate_drafts_to_root,
            update::check_update,
            update::download_update,
            upload::upload_plugin,
            plugin_security::verify_plugin_signature_command,
            plugin_security::check_plugin_recall_command
        ])
        .run(tauri::generate_context!())
        .expect("启动 LingFang 桌面壳失败");
}
