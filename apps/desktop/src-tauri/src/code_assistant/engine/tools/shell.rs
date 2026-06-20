use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::code_assistant::{find_binary, run_capture_with_env};
use crate::embedded_runtime::{is_runtime_command, EmbeddedRuntime};

const COMMAND_TIMEOUT_MS: u64 = 60_000;
const OUTPUT_TAIL_CHARS: usize = 12_000;

pub(crate) fn run_command(
    workspace: &Path,
    runtime_root: Option<&Path>,
    command: &str,
    args: Vec<String>,
    cwd: Option<&str>,
) -> Result<Value, String> {
    let workspace_root = workspace
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let cwd = resolve_command_cwd(&workspace_root, cwd)?;
    let runtime = runtime_root
        .map(|root| EmbeddedRuntime::from_root(root.to_path_buf()))
        .unwrap_or_else(EmbeddedRuntime::from_default_locations);
    let binary = resolve_command_binary(&runtime, command)?;
    let captured = run_capture_with_env(
        &binary,
        args,
        Some(&cwd.to_string_lossy()),
        COMMAND_TIMEOUT_MS,
        command_env(&runtime, command),
    )?;
    let stdout = tail_text(&captured.stdout);
    let stderr = tail_text(&captured.stderr);
    Ok(json!({
        "exitCode": captured.exit_code,
        "timedOut": captured.timed_out,
        "stdout": stdout.0,
        "stdoutTruncated": stdout.1,
        "stderr": stderr.0,
        "stderrTruncated": stderr.1,
        "cwd": cwd.to_string_lossy().replace('\\', "/"),
    }))
}

fn resolve_command_cwd(workspace: &Path, cwd: Option<&str>) -> Result<PathBuf, String> {
    let Some(cwd) = cwd.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(workspace.to_path_buf());
    };
    let requested = PathBuf::from(cwd);
    let target = if requested.is_absolute() {
        requested
    } else {
        workspace.join(requested)
    };
    let canonical = target.canonicalize().map_err(|error| error.to_string())?;
    if !canonical.starts_with(workspace) {
        return Err("命令工作目录必须位于插件工作区或已导入目录".to_string());
    }
    Ok(canonical)
}

fn resolve_command_binary(runtime: &EmbeddedRuntime, command: &str) -> Result<PathBuf, String> {
    let command = command.trim();
    if command.is_empty() {
        return Err("命令不能为空".to_string());
    }
    let candidate = PathBuf::from(command);
    if candidate.components().count() > 1 || candidate.is_absolute() {
        if is_runtime_command(
            candidate
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default(),
        ) {
            return Err(
                "Python/Node 相关命令必须使用软件内置运行时，不能指定外部绝对路径".to_string(),
            );
        }
        return candidate.canonicalize().map_err(|error| error.to_string());
    }
    if is_runtime_command(command) {
        return runtime.require_runtime_command(command);
    }
    find_binary(command).ok_or_else(|| format!("找不到命令：{command}"))
}

fn command_env(
    runtime: &EmbeddedRuntime,
    command: &str,
) -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
    if is_runtime_command(command) {
        runtime.env(std::env::vars_os().collect())
    } else {
        std::env::vars_os().collect()
    }
}

fn tail_text(value: &str) -> (String, bool) {
    let count = value.chars().count();
    if count <= OUTPUT_TAIL_CHARS {
        return (value.to_string(), false);
    }
    let tail = value
        .chars()
        .skip(count - OUTPUT_TAIL_CHARS)
        .collect::<String>();
    (tail, true)
}
