//! 运行时管理 Tauri 命令。
//!
//! 连接前端设置页 RuntimeEnvTab 与 runtime_resolver / runtime_config。
//! 命令名与前端 lib/runtime-config.ts 契约对齐。
//!
//! 命令概览：
//! - `get_runtime_status` → 当前生效的 python/node 来源 + 版本 + 路径
//! - `get_runtime_config` / `set_mirror_config` → 镜像源配置读写

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::ipc::Channel;

use crate::mirror_presets::MirrorConfig;
use crate::runtime_config::{runtime_executable_dir, RuntimeConfig, RuntimeConfigStore};
use crate::runtime_download::{self, RuntimeDownloadEvent, RuntimeKind};
use crate::runtime_resolver::{RuntimeResolver, RuntimeSource};

// === 状态查询 ===

/// 单个运行时的当前状态（resolver 解析结果 + 探测的版本）。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub available: bool,
    /// `"appManaged"` | `"userSpecified"` | `null`。
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
        RuntimeSource::AppManaged => "appManaged",
        RuntimeSource::UserSpecified => "userSpecified",
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
    #[cfg(windows)]
    {
        match kind {
            RuntimeKind::Nodejs => "node.exe",
            RuntimeKind::Python => "python.exe",
        }
    }
    #[cfg(not(windows))]
    {
        match kind {
            RuntimeKind::Nodejs => "node",
            RuntimeKind::Python => "python",
        }
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

#[tauri::command]
pub async fn download_runtime(
    app: tauri::AppHandle,
    kind: RuntimeKind,
    version: Option<String>,
    on_event: Channel<RuntimeDownloadEvent>,
) -> Result<(), String> {
    runtime_download::download_runtime(&app, kind, version, on_event).await
}

#[tauri::command]
pub fn uninstall_runtime(app: tauri::AppHandle, kind: RuntimeKind) -> Result<(), String> {
    let store = RuntimeConfigStore::from_app(&app)?;
    let mut config = store.read();
    let entry = match kind {
        RuntimeKind::Python => config.app_managed_python.take(),
        RuntimeKind::Nodejs => config.app_managed_node.take(),
    };
    store.write(&config)?;
    if let Some(entry) = entry {
        let dir = PathBuf::from(entry.dir);
        if dir.is_dir() {
            std::fs::remove_dir_all(&dir).map_err(|e| format!("删除运行时失败：{e}"))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn set_user_specified_runtime(
    app: tauri::AppHandle,
    kind: RuntimeKind,
    path: Option<String>,
) -> Result<(), String> {
    let normalized = path
        .filter(|value| !value.trim().is_empty())
        .map(|value| runtime_executable_dir(Path::new(value.trim())));
    if let Some(dir) = &normalized {
        let exe = exe_path(dir, kind);
        if !exe.is_file() {
            return Err(format!("指定路径中未找到 {}", exe_name(kind)));
        }
        let version = probe_version(&exe)?;
        if !meets_minimum(kind, &version) {
            return Err(match kind {
                RuntimeKind::Python => "Python 版本必须不低于 3.10".to_string(),
                RuntimeKind::Nodejs => "Node.js 版本必须不低于 18".to_string(),
            });
        }
    }
    let store = RuntimeConfigStore::from_app(&app)?;
    let mut config = store.read();
    let value = normalized.map(|dir| dir.to_string_lossy().to_string());
    match kind {
        RuntimeKind::Python => config.user_specified_python = value,
        RuntimeKind::Nodejs => config.user_specified_node = value,
    }
    store.write(&config)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemRuntimeProbe {
    available: bool,
    path: Option<String>,
    version: Option<String>,
    meets_minimum: bool,
}

#[tauri::command]
pub fn probe_system_runtime(kind: RuntimeKind) -> SystemRuntimeProbe {
    let candidate = match kind {
        RuntimeKind::Python => "python",
        RuntimeKind::Nodejs => "node",
    };
    let Some(path) = crate::process_util::find_binary(candidate) else {
        return SystemRuntimeProbe { available: false, path: None, version: None, meets_minimum: false };
    };
    let version = probe_version(&path).ok();
    let meets_minimum = version.as_deref().is_some_and(|value| meets_minimum(kind, value));
    SystemRuntimeProbe {
        available: version.is_some(),
        path: Some(path.to_string_lossy().to_string()),
        version,
        meets_minimum,
    }
}

fn meets_minimum(kind: RuntimeKind, raw: &str) -> bool {
    let cleaned = raw.trim().trim_start_matches("Python ").trim_start_matches('v');
    let version = cleaned.split_whitespace().next().and_then(|value| semver::Version::parse(value).ok());
    match (kind, version) {
        (RuntimeKind::Python, Some(version)) => version >= semver::Version::new(3, 10, 0),
        (RuntimeKind::Nodejs, Some(version)) => version >= semver::Version::new(18, 0, 0),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_ids_are_stable() {
        assert_eq!(source_id(&RuntimeSource::AppManaged), "appManaged");
        assert_eq!(source_id(&RuntimeSource::UserSpecified), "userSpecified");
    }

    #[test]
    fn minimum_versions_are_enforced() {
        assert!(meets_minimum(RuntimeKind::Python, "Python 3.10.0"));
        assert!(!meets_minimum(RuntimeKind::Python, "Python 3.9.18"));
        assert!(meets_minimum(RuntimeKind::Nodejs, "v18.0.0"));
        assert!(!meets_minimum(RuntimeKind::Nodejs, "v16.20.0"));
    }
}
