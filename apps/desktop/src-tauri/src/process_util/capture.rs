use std::ffi::OsString;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Instant;

use super::binary::build_spawn_command;
use super::tree::{kill_child_tree, prepare_process_group};

#[derive(Debug, Clone)]
pub(crate) struct CapturedOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
}

pub(crate) fn run_captured_inner(
    binary: &PathBuf,
    args: Vec<String>,
    workspace_dir: Option<&str>,
    timeout_ms: u64,
    env: Option<&[(OsString, OsString)]>,
) -> Result<CapturedOutput, String> {
    let mut command = build_spawn_command(binary, &args);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(workspace_dir) = workspace_dir {
        command.current_dir(workspace_dir);
    }
    if let Some(env) = env {
        command
            .env_clear()
            .envs(env.iter().map(|(key, value)| (key.clone(), value.clone())));
    }
    prepare_process_group(&mut command);
    wait_for_capture(
        command.spawn().map_err(|error| error.to_string())?,
        timeout_ms,
    )
}

pub(crate) fn run_capture_with_env(
    binary: &PathBuf,
    args: Vec<String>,
    workspace_dir: Option<&str>,
    timeout_ms: u64,
    env: Vec<(OsString, OsString)>,
) -> Result<CapturedOutput, String> {
    run_captured_inner(binary, args, workspace_dir, timeout_ms, Some(&env))
}

fn wait_for_capture(
    mut child: std::process::Child,
    timeout_ms: u64,
) -> Result<CapturedOutput, String> {
    let started = Instant::now();
    loop {
        if child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_some()
        {
            return child_output(child, false);
        }
        if started.elapsed().as_millis() > timeout_ms as u128 {
            kill_child_tree(&child);
            return child_output(child, true);
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

fn child_output(child: std::process::Child, timed_out: bool) -> Result<CapturedOutput, String> {
    let output = child
        .wait_with_output()
        .map_err(|error| error.to_string())?;
    Ok(CapturedOutput {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code(),
        timed_out,
    })
}
