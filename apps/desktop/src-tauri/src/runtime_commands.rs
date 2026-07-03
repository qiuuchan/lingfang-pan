//! 运行时管理 Tauri 命令（简化版：仅状态查询 + 镜像源配置）。
//!
//! 连接前端设置页 RuntimeEnvTab 与 runtime_resolver / runtime_config。
//! 命令名与前端 lib/runtime-config.ts 契约对齐。
//!
//! 命令概览：
//! - `get_runtime_status` → 当前生效的 python/node 来源 + 版本 + 路径（resolver 解析，内置运行时固定 Legacy）
//! - `get_runtime_config` / `set_mirror_config` → 镜像源配置读写

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::mirror_presets::MirrorConfig;
use crate::runtime_config::{RuntimeConfig, RuntimeConfigStore};
use crate::runtime_resolver::{RuntimeResolver, RuntimeSource};

// === 状态查询 ===

/// 单个运行时的当前状态（resolver 解析结果 + 探测的版本）。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub available: bool,
    /// `"legacy"` | `null`（内置运行时固定 legacy）。
    pub source: Option<String>,
    pub version: Option<String>,
    /// 主 exe 所在目录（直接含 python.exe / node.exe）。
    pub dir: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatusMap {
    pub python: RuntimeStatus,
    pub node: RuntimeStatus,
}

/// 运行时种类（与 plugin_script ScriptRuntime 对齐）。
#[derive(Copy, Clone)]
enum RuntimeKind {
    Python,
    Nodejs,
}

#[tauri::command]
pub fn get_runtime_status(app: tauri::AppHandle) -> Result<RuntimeStatusMap, String> {
    let resolver = RuntimeResolver::resolve(&app)?;
    Ok(RuntimeStatusMap {
        python: status_for(&resolver, RuntimeKind::Python),
        node: status_for(&resolver, RuntimeKind::Nodejs),
    })
}

fn status_for(resolver: &RuntimeResolver, kind: RuntimeKind) -> RuntimeStatus {
    let (dir, source) = match kind {
        RuntimeKind::Python => (resolver.python_dir(), resolver.python_source()),
        RuntimeKind::Nodejs => (resolver.node_dir(), resolver.node_source()),
    };
    match (dir, source) {
        (Some(dir), Some(src)) => {
            let exe = exe_path(dir, kind);
            let version = if exe.is_file() {
                probe_version(&exe).ok()
            } else {
                None
            };
            RuntimeStatus {
                available: exe.is_file(),
                source: Some(source_id(src).to_string()),
                version,
                dir: Some(dir.to_string_lossy().to_string()),
            }
        }
        _ => RuntimeStatus {
            available: false,
            source: None,
            version: None,
            dir: None,
        },
    }
}

fn source_id(src: &RuntimeSource) -> &'static str {
    match src {
        RuntimeSource::Legacy => "legacy",
    }
}

/// 主 exe 路径（MVP 仅 Windows；python/node exe 直接在 dir 根）。
fn exe_path(dir: &Path, kind: RuntimeKind) -> PathBuf {
    #[cfg(windows)]
    {
        dir.join(exe_name(kind))
    }
    #[cfg(not(windows))]
    {
        dir.join("bin").join(exe_name(kind))
    }
}

fn exe_name(kind: RuntimeKind) -> &'static str {
    match kind {
        RuntimeKind::Nodejs => "node.exe",
        RuntimeKind::Python => "python.exe",
    }
}

/// 跑 `<exe> --version` 拿版本字符串（5s 超时）。
fn probe_version(exe: &Path) -> Result<String, String> {
    let exe_buf = exe.to_path_buf();
    let env = crate::plugin_runner::minimal_env();
    let captured = crate::process_util::run_capture_with_env(
        &exe_buf,
        vec!["--version".to_string()],
        None,
        5_000,
        env,
    )
    .map_err(|e| format!("探测版本失败：{e}"))?;
    if captured.exit_code != Some(0) {
        return Err(format!("探测版本失败 exit={:?}", captured.exit_code));
    }
    let raw = format!("{}\n{}", captured.stdout.trim(), captured.stderr.trim());
    raw.lines()
        .find(|line| !line.trim().is_empty())
        .map(|line| line.trim().to_string())
        .ok_or_else(|| "版本输出为空".to_string())
}

// === 配置读写 ===

#[tauri::command]
pub fn get_runtime_config(app: tauri::AppHandle) -> Result<RuntimeConfig, String> {
    Ok(RuntimeConfigStore::from_app(&app)?.read())
}

#[tauri::command]
pub fn set_mirror_config(app: tauri::AppHandle, mirrors: MirrorConfig) -> Result<(), String> {
    let store = RuntimeConfigStore::from_app(&app)?;
    let mut config = store.read();
    config.mirrors = mirrors;
    store.write(&config)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_id_maps_legacy() {
        assert_eq!(source_id(&RuntimeSource::Legacy), "legacy");
    }
}
