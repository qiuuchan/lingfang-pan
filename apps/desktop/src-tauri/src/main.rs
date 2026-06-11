//! LingFang 桌面壳（Tauri 2，见 ADR-0001 / ADR-0004）。
//! 极简工作台 + 插件加载器 + capability 权限网关。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod capability;
mod plugins;

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::Value;
use tauri::Manager;

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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_plugins,
            read_plugin_file,
            invoke_capability
        ])
        .run(tauri::generate_context!())
        .expect("启动 LingFang 桌面壳失败");
}
