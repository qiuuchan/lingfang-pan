//! 运行时管理 Tauri 命令（task 07-03 step 3）。
//!
//! 连接前端（设置页 RuntimeEnvTab + 首启引导 RuntimeSetupGate）与 runtime_resolver /
//! runtime_download / runtime_config。命令名与前端 lib/runtime-config.ts 契约对齐。
//!
//! 命令概览：
//! - `get_runtime_status` → 当前生效的 python/node 来源 + 版本 + 路径（resolver 解析）
//! - `download_runtime` / `uninstall_runtime` → 下载便携版 / 卸载（runtime_download）
//! - `get_runtime_config` / `set_mirror_config` / `set_user_specified_runtime` → 配置读写
//! - `probe_system_runtime` → 探测系统 PATH 上的版本（**仅信息展示**，不参与执行；
//!   resolver 永不把系统 PATH 作为执行来源）
//!
//! sync 命令在 Tauri 独立线程执行（非 async runtime 上下文），reqwest::blocking 可安全使用。

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::mirror_presets::MirrorConfig;
use crate::runtime_config::{ManagedEntry, RuntimeConfig, RuntimeConfigStore};
use crate::runtime_download::{self, RuntimeKind};
use crate::runtime_resolver::{RuntimeResolver, RuntimeSource};

// === 状态查询 ===

/// 单个运行时的当前状态（resolver 解析结果 + 探测的版本）。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub available: bool,
    /// `"app_managed"` | `"user_specified"` | `"legacy"` | `null`。
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
        RuntimeSource::AppManaged => "app_managed",
        RuntimeSource::UserSpecified => "user_specified",
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
        RuntimeKind::Nodejs => "node",
        RuntimeKind::Python => "python",
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

// === 下载 / 卸载 ===

#[tauri::command]
pub fn download_runtime(
    app: tauri::AppHandle,
    kind: RuntimeKind,
    version: Option<String>,
) -> Result<ManagedEntry, String> {
    runtime_download::download_runtime(&app, kind, version)
}

#[tauri::command]
pub fn uninstall_runtime(app: tauri::AppHandle, kind: RuntimeKind) -> Result<bool, String> {
    runtime_download::uninstall_runtime(&app, kind)
}

// === 配置读写 ===

#[tauri::command]
pub fn get_runtime_config(app: tauri::AppHandle) -> Result<RuntimeConfig, String> {
    Ok(RuntimeConfigStore::from_app(&app)?.read())
}

#[tauri::command]
pub fn set_mirror_config(
    app: tauri::AppHandle,
    mirrors: MirrorConfig,
) -> Result<(), String> {
    let store = RuntimeConfigStore::from_app(&app)?;
    let mut config = store.read();
    config.mirrors = mirrors;
    store.write(&config)
}

/// 设置/清除用户手动指定的运行时路径。path=None 清除（回退到 app_managed/legacy）。
/// 路径须直接含主 exe（python.exe / node.exe），resolver 校验失效则该项作废。
#[tauri::command]
pub fn set_user_specified_runtime(
    app: tauri::AppHandle,
    kind: RuntimeKind,
    path: Option<String>,
) -> Result<(), String> {
    let store = RuntimeConfigStore::from_app(&app)?;
    let mut config = store.read();
    // trim 空串归一为 None（防脏值）。
    let normalized = path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    match kind {
        RuntimeKind::Python => config.user_specified_python = normalized,
        RuntimeKind::Nodejs => config.user_specified_node = normalized,
    }
    store.write(&config)
}

// === 系统 PATH 探测（仅信息展示） ===

/// 探测系统 PATH 上的运行时版本（仅信息展示，不参与执行）。
///
/// 用于设置页灰显「检测到系统 X，但不会使用」。resolver 永不把系统 PATH 作为执行来源。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemProbeResult {
    pub path: Option<String>,
    pub version: Option<String>,
    pub meets_minimum: bool,
}

#[tauri::command]
pub fn probe_system_runtime(
    _app: tauri::AppHandle,
    kind: RuntimeKind,
) -> Result<SystemProbeResult, String> {
    let command = match kind {
        RuntimeKind::Python => "python",
        RuntimeKind::Nodejs => "node",
    };
    // 在系统 PATH 搜（仅探测，不影响执行链路）。
    let exe = crate::process_util::find_binary(command);
    let Some(exe) = exe else {
        return Ok(SystemProbeResult {
            path: None,
            version: None,
            meets_minimum: false,
        });
    };
    let version_raw = probe_version(&exe).ok();
    let meets_minimum = version_raw
        .as_deref()
        .map(|v| meets_minimum(kind, v))
        .unwrap_or(false);
    Ok(SystemProbeResult {
        path: Some(exe.to_string_lossy().to_string()),
        version: version_raw,
        meets_minimum,
    })
}

/// 最低版本门槛（与 prd 决策一致：Python ≥ 3.10、Node ≥ 18）。
fn minimum_version(kind: RuntimeKind) -> semver::Version {
    match kind {
        RuntimeKind::Python => semver::Version::new(3, 10, 0),
        RuntimeKind::Nodejs => semver::Version::new(18, 0, 0),
    }
}

/// 宽松解析版本字符串（容忍 "Python 3.12.13" / "v22.21.1" / "3.12" 等前缀与缺段）。
fn parse_loose_version(raw: &str) -> Option<semver::Version> {
    // 找第一段「数字序列（含点）」，补齐到三段后用 semver 解析。
    let mut current = String::new();
    let mut best: Option<String> = None;
    for ch in raw.chars() {
        if ch.is_ascii_digit() || (ch == '.' && !current.is_empty()) {
            current.push(ch);
        } else {
            if !current.is_empty() && best.is_none() {
                best = Some(std::mem::take(&mut current));
            }
            current.clear();
        }
    }
    if best.is_none() && !current.is_empty() {
        best = Some(current);
    }
    best.as_deref().and_then(normalize_and_parse)
}

/// 把 "3.12" 补成 "3.12.0"，"3" 补成 "3.0.0"，再交给 semver::Version::parse。
fn normalize_and_parse(candidate: &str) -> Option<semver::Version> {
    let trimmed = candidate.trim_end_matches('.');
    let parts: Vec<&str> = trimmed.split('.').collect();
    let normalized = match parts.len() {
        1 => format!("{}.0.0", parts[0]),
        2 => format!("{}.{}.0", parts[0], parts[1]),
        _ => trimmed.to_string(),
    };
    semver::Version::parse(&normalized).ok()
}

fn meets_minimum(kind: RuntimeKind, version_raw: &str) -> bool {
    parse_loose_version(version_raw)
        .map(|v| v >= minimum_version(kind))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_loose_version_handles_common_formats() {
        assert_eq!(
            parse_loose_version("Python 3.12.13"),
            Some(semver::Version::new(3, 12, 13))
        );
        assert_eq!(
            parse_loose_version("v22.21.1"),
            Some(semver::Version::new(22, 21, 1))
        );
        assert_eq!(
            parse_loose_version("3.12"),
            Some(semver::Version::new(3, 12, 0))
        );
        assert_eq!(
            parse_loose_version("node 18.20.4"),
            Some(semver::Version::new(18, 20, 4))
        );
        assert!(parse_loose_version("no version here").is_none());
    }

    #[test]
    fn meets_minimum_python_3_10_boundary() {
        assert!(meets_minimum(RuntimeKind::Python, "Python 3.10.0"));
        assert!(meets_minimum(RuntimeKind::Python, "Python 3.12.13"));
        assert!(!meets_minimum(RuntimeKind::Python, "Python 3.9.7"));
    }

    #[test]
    fn meets_minimum_node_18_boundary() {
        assert!(meets_minimum(RuntimeKind::Nodejs, "v18.0.0"));
        assert!(meets_minimum(RuntimeKind::Nodejs, "v22.21.1"));
        assert!(!meets_minimum(RuntimeKind::Nodejs, "v16.20.0"));
    }

    #[test]
    fn source_id_maps_enum_to_string() {
        assert_eq!(source_id(&RuntimeSource::AppManaged), "app_managed");
        assert_eq!(source_id(&RuntimeSource::UserSpecified), "user_specified");
        assert_eq!(source_id(&RuntimeSource::Legacy), "legacy");
    }
}
