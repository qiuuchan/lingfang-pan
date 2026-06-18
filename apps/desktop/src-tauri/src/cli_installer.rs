//! Node.js / Python runtime installer for plugin scripts.

use std::ffi::OsString;
use std::process::Child;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(windows)]
use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::code_assistant::{find_binary, kill_child_tree, run_capture_with_env, CapturedOutput};

static CURRENT_INSTALL: Mutex<Option<Child>> = Mutex::new(None);

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum InstallTarget {
    Nodejs,
    Python,
}

impl InstallTarget {
    fn display_name(self) -> &'static str {
        match self {
            Self::Nodejs => "Node.js",
            Self::Python => "Python",
        }
    }

    fn binary_candidate(self) -> &'static str {
        match self {
            Self::Nodejs => "node",
            Self::Python => "py",
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "PascalCase")]
pub enum InstallStatus {
    Succeeded,
    NeedsConfirmation,
    Failed,
    #[allow(dead_code)]
    Unsupported,
}

#[derive(Clone, Debug, Serialize)]
pub struct InstallResult {
    pub status: InstallStatus,
    pub exit_code: Option<i32>,
    pub elapsed_ms: u64,
    pub binary_path: Option<String>,
    pub version: Option<String>,
    pub message: String,
}

impl InstallResult {
    #[allow(dead_code)]
    fn unsupported() -> Self {
        Self {
            status: InstallStatus::Unsupported,
            exit_code: None,
            elapsed_ms: 0,
            binary_path: None,
            version: None,
            message: "当前平台不支持自动安装，请手动安装".to_string(),
        }
    }

    #[cfg(windows)]
    fn failed(message: impl Into<String>, exit_code: Option<i32>, elapsed_ms: u64) -> Self {
        Self {
            status: InstallStatus::Failed,
            exit_code,
            elapsed_ms,
            binary_path: None,
            version: None,
            message: message.into(),
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct InstallInput {
    pub target: InstallTarget,
}

fn winget_package_id(target: InstallTarget) -> &'static str {
    match target {
        InstallTarget::Nodejs => "OpenJS.NodeJS.LTS",
        InstallTarget::Python => "Python.Python.3.12",
    }
}

fn installer_env() -> Vec<(OsString, OsString)> {
    let keys = [
        "PATH",
        "PATHEXT",
        "SystemRoot",
        "TEMP",
        "TMP",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
    ];
    keys.iter()
        .filter_map(|key| std::env::var_os(key).map(|value| (OsString::from(key), value)))
        .collect()
}

fn redact_log_line(line: &str) -> String {
    let lower = line.trim().to_ascii_lowercase();
    let secret = lower.contains("bearer ")
        || lower.contains("sk-")
        || lower.contains("api_key=")
        || lower.contains("token=")
        || lower.contains("secret=");
    if secret {
        "[redacted]".to_string()
    } else {
        line.to_string()
    }
}

#[cfg(windows)]
fn cleanup_partial_install(target: InstallTarget) {
    let id = winget_package_id(target);
    let check = run_capture_with_env(
        &PathBuf::from("winget"),
        vec!["list".to_string(), "--id".to_string(), id.to_string()],
        None,
        30_000,
        installer_env(),
    );
    let installed = matches!(check, Ok(c) if c.exit_code == Some(0) && c.stdout.contains(id));
    if !installed {
        return;
    }
    let _ = run_capture_with_env(
        &PathBuf::from("winget"),
        vec![
            "uninstall".to_string(),
            "--id".to_string(),
            id.to_string(),
            "--silent".to_string(),
        ],
        None,
        60_000,
        installer_env(),
    );
}

#[derive(Serialize)]
struct InstallHistoryRecord {
    target: &'static str,
    #[serde(rename = "startedAt")]
    started_at: u128,
    #[serde(rename = "exitCode")]
    exit_code: Option<i32>,
    #[serde(rename = "elapsedMs")]
    elapsed_ms: u64,
    status: String,
    platform: String,
}

fn append_install_history(
    app: &AppHandle,
    target: InstallTarget,
    started_at: u128,
    exit_code: Option<i32>,
    elapsed_ms: u64,
    status: InstallStatus,
) {
    let Ok(data_dir) = app.path().app_data_dir() else {
        return;
    };
    let _ = std::fs::create_dir_all(&data_dir);
    let record = InstallHistoryRecord {
        target: target.binary_candidate(),
        started_at,
        exit_code,
        elapsed_ms,
        status: format!("{status:?}"),
        platform: current_platform_string(),
    };
    let Ok(line) = serde_json::to_string(&record) else {
        return;
    };
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(data_dir.join("install-history.jsonl"))
        .and_then(|mut file| std::io::Write::write_all(&mut file, format!("{line}\n").as_bytes()));
}

fn current_platform_string() -> String {
    if cfg!(target_os = "windows") {
        "windows".to_string()
    } else if cfg!(target_os = "macos") {
        "macos".to_string()
    } else if cfg!(target_os = "linux") {
        "linux".to_string()
    } else {
        "unknown".to_string()
    }
}

#[cfg(windows)]
fn winget_available() -> bool {
    matches!(
        run_capture_with_env(
            &PathBuf::from("winget"),
            vec!["--version".to_string()],
            None,
            5_000,
            installer_env(),
        ),
        Ok(captured) if !captured.timed_out && captured.exit_code == Some(0)
    )
}

#[cfg(windows)]
fn probe_after_install(target: InstallTarget) -> (Option<String>, Option<String>) {
    match find_binary(target.binary_candidate()) {
        Some(path) => (Some(path.to_string_lossy().to_string()), None),
        None => (None, None),
    }
}

fn looks_like_uac_required(captured: &CapturedOutput) -> bool {
    if captured.exit_code == Some(0x8007_0005_u32 as i32) {
        return true;
    }
    let combined = format!("{}\n{}", captured.stdout, captured.stderr).to_ascii_lowercase();
    combined.contains("elevation") || combined.contains("administrator")
}

fn run_install(app: AppHandle, target: InstallTarget) -> Result<InstallResult, String> {
    let started_epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let started = std::time::Instant::now();
    #[cfg(not(windows))]
    {
        let result = InstallResult::unsupported();
        append_install_history(&app, target, started_epoch, None, 0, result.status);
        Ok(result)
    }
    #[cfg(windows)]
    {
        if !winget_available() {
            let result = InstallResult::failed("未检测到 winget，无法自动安装", None, 0);
            append_install_history(&app, target, started_epoch, None, 0, result.status);
            return Ok(result);
        }
        let id = winget_package_id(target);
        let captured = run_capture_with_env(
            &PathBuf::from("winget"),
            vec![
                "install".to_string(),
                "--id".to_string(),
                id.to_string(),
                "-e".to_string(),
                "--accept-source-agreements".to_string(),
                "--accept-package-agreements".to_string(),
                "--silent".to_string(),
            ],
            None,
            300_000,
            installer_env(),
        );
        let elapsed_ms = started.elapsed().as_millis() as u64;
        let result = match captured {
            Ok(captured) => install_result_from_capture(target, captured, elapsed_ms),
            Err(error) => InstallResult::failed(
                format!("启动安装失败：{}", redact_log_line(&error)),
                None,
                elapsed_ms,
            ),
        };
        append_install_history(
            &app,
            target,
            started_epoch,
            result.exit_code,
            result.elapsed_ms,
            result.status,
        );
        Ok(result)
    }
}

#[cfg(windows)]
fn install_result_from_capture(
    target: InstallTarget,
    captured: CapturedOutput,
    elapsed_ms: u64,
) -> InstallResult {
    if captured.timed_out {
        cleanup_partial_install(target);
        return InstallResult::failed(
            format!("{} 安装超时，已尝试清理残留", target.display_name()),
            captured.exit_code,
            elapsed_ms,
        );
    }
    if looks_like_uac_required(&captured) {
        return InstallResult {
            status: InstallStatus::NeedsConfirmation,
            exit_code: captured.exit_code,
            elapsed_ms,
            binary_path: None,
            version: None,
            message: format!("{} 安装需要管理员权限", target.display_name()),
        };
    }
    if captured.exit_code == Some(0) {
        let (binary_path, version) = probe_after_install(target);
        if binary_path.is_some() {
            return InstallResult {
                status: InstallStatus::Succeeded,
                exit_code: captured.exit_code,
                elapsed_ms,
                binary_path,
                version,
                message: format!("{} 安装成功", target.display_name()),
            };
        }
    }
    cleanup_partial_install(target);
    let tail = captured
        .stderr
        .lines()
        .rev()
        .take(5)
        .map(redact_log_line)
        .collect::<Vec<_>>()
        .join("\n");
    InstallResult::failed(
        format!("{} 安装失败：{tail}", target.display_name()),
        captured.exit_code,
        elapsed_ms,
    )
}

#[tauri::command]
pub fn install_runtime(app: AppHandle, input: InstallInput) -> Result<InstallResult, String> {
    run_install(app, input.target)
}

#[tauri::command]
pub fn cancel_install(_input: InstallInput) -> Result<(), String> {
    let mut slot = CURRENT_INSTALL.lock().map_err(|error| error.to_string())?;
    if let Some(child) = slot.take() {
        kill_child_tree(&child);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn winget_package_id_lookup() {
        assert_eq!(winget_package_id(InstallTarget::Nodejs), "OpenJS.NodeJS.LTS");
        assert_eq!(winget_package_id(InstallTarget::Python), "Python.Python.3.12");
    }

    #[test]
    fn install_target_serde_rejects_cli_targets() {
        assert!(serde_json::from_str::<InstallTarget>("\"nodejs\"").is_ok());
        assert!(serde_json::from_str::<InstallTarget>("\"python\"").is_ok());
        assert!(serde_json::from_str::<InstallTarget>("\"claude\"").is_err());
        assert!(serde_json::from_str::<InstallTarget>("\"codex\"").is_err());
        assert!(serde_json::from_str::<InstallTarget>("\"opencode\"").is_err());
    }

    #[test]
    fn install_status_serializes_pascal_case() {
        assert_eq!(serde_json::to_string(&InstallStatus::Succeeded).unwrap(), "\"Succeeded\"");
        assert_eq!(serde_json::to_string(&InstallStatus::Unsupported).unwrap(), "\"Unsupported\"");
    }
}
