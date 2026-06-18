use std::time::Instant;

use serde_json::json;

use super::adapters::{tool_definition, CodeAssistantTool};
use super::history::tail;
use super::process::{command_preview, run_capture};
use super::store::AssistantStore;
use super::tools::find_command;
use super::workspace::{new_session_id, resolve_workspace};
use super::{CodeAssistantState, ProbeInput, ProbeResult};

const PROBE_PROMPT: &str = "Reply with exactly: lingfang-cli-ok";

pub fn run_probe(state: &CodeAssistantState, input: ProbeInput) -> Result<ProbeResult, String> {
    run_once(
        state,
        input.tool,
        input.model,
        input.workspace_dir,
        input.prompt.unwrap_or_else(|| PROBE_PROMPT.to_string()),
        "probe",
    )
}

fn run_once(
    state: &CodeAssistantState,
    tool: CodeAssistantTool,
    model: Option<String>,
    workspace_dir: Option<String>,
    prompt: String,
    event: &str,
) -> Result<ProbeResult, String> {
    let definition = tool_definition(tool);
    let command = find_command(definition.candidate_commands)
        .ok_or_else(|| format!("未找到 {} CLI", definition.display_name))?;
    let workspace_dir = resolve_workspace(workspace_dir, Some(state.store.root()), None)?;
    let session_id = new_session_id(tool);
    let args = command.args_with(definition.probe_args(&prompt, model.as_deref()));
    let command_preview = command_preview(&command.binary, &args);
    let started = Instant::now();

    state.store.append_transcript(
        &session_id,
        event,
        json!({
            "tool": tool,
            "model": model,
            "prompt": prompt,
            "commandPreview": command_preview,
            "workspaceDir": workspace_dir,
        }),
    )?;

    let captured = run_capture(&command.binary, args, Some(&workspace_dir), 120_000)?;
    build_probe_result(
        &state.store,
        tool,
        model,
        session_id,
        command_preview,
        captured,
        started.elapsed().as_millis(),
    )
}

fn build_probe_result(
    store: &AssistantStore,
    tool: CodeAssistantTool,
    model: Option<String>,
    session_id: String,
    command_preview: Vec<String>,
    captured: super::process::CapturedOutput,
    elapsed_ms: u128,
) -> Result<ProbeResult, String> {
    let stdout_tail = tail(&captured.stdout, 8_000);
    let stderr_tail = tail(&captured.stderr, 8_000);
    let diagnostics = probe_diagnostics(&captured, &stdout_tail, &stderr_tail);
    let success = !captured.timed_out
        && captured.exit_code == Some(0)
        && (!stdout_tail.trim().is_empty() || !stderr_tail.trim().is_empty());

    store.append_transcript(
        &session_id,
        "exit",
        json!({
            "stdoutTail": stdout_tail,
            "stderrTail": stderr_tail,
            "exitCode": captured.exit_code,
            "elapsedMs": elapsed_ms,
            "success": success,
            "diagnostics": diagnostics,
        }),
    )?;

    Ok(ProbeResult {
        tool,
        model,
        success,
        command_preview,
        stdout_tail,
        stderr_tail,
        exit_code: captured.exit_code,
        elapsed_ms,
        transcript_path: store
            .transcript_path(&session_id)
            .to_string_lossy()
            .to_string(),
        session_id,
        diagnostics,
    })
}

fn probe_diagnostics(
    captured: &super::process::CapturedOutput,
    stdout_tail: &str,
    stderr_tail: &str,
) -> Vec<String> {
    let mut diagnostics = Vec::new();
    if captured.timed_out {
        diagnostics.push("CLI 调用超时".to_string());
    }
    if captured.exit_code != Some(0) {
        diagnostics.push(format!("CLI 退出码：{:?}", captured.exit_code));
    }
    if stdout_tail.trim().is_empty() && stderr_tail.trim().is_empty() {
        diagnostics.push("CLI 没有返回 stdout/stderr".to_string());
    }
    diagnostics
}
