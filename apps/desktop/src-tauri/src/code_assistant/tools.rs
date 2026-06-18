use super::adapters::{tool_definition, CodeAssistantTool, ToolCommand, TOOL_DEFINITIONS};
use super::process::{command_preview, find_binary, run_capture};
use super::store::now_string;
use super::{ResolvedToolCommand, ToolAvailability};

pub fn list_tools() -> Vec<ToolAvailability> {
    TOOL_DEFINITIONS
        .iter()
        .map(|definition| check_tool(definition.tool))
        .collect()
}

pub fn check_tool(tool: CodeAssistantTool) -> ToolAvailability {
    let definition = tool_definition(tool);
    let command = find_command(definition.candidate_commands);
    let mut diagnostics = Vec::new();
    let mut version = None;

    if let Some(resolved) = command.as_ref() {
        match run_capture(
            &resolved.binary,
            resolved.args_with(
                definition
                    .version_args
                    .iter()
                    .map(|arg| arg.to_string())
                    .collect(),
            ),
            None,
            10_000,
        ) {
            Ok(output) => {
                let merged = first_non_empty(&output.stdout, &output.stderr);
                version = merged
                    .lines()
                    .next()
                    .map(str::trim)
                    .filter(|line| !line.is_empty())
                    .map(str::to_string);
                if version.is_none() {
                    diagnostics.push("版本命令没有返回可读版本号".to_string());
                }
                if !resolved.prefix_args.is_empty() {
                    diagnostics.push(format!("使用命令入口：{}", resolved.label));
                }
            }
            Err(error) => diagnostics.push(format!("版本检查失败：{error}")),
        }
    } else {
        diagnostics.push(format!(
            "未找到可执行命令：{}",
            candidate_labels(definition.candidate_commands).join(", ")
        ));
    }

    ToolAvailability {
        tool,
        display_name: definition.display_name.to_string(),
        available: command.is_some(),
        binary_path: command
            .map(|command| command_preview(&command.binary, &command.prefix_args).join(" ")),
        version,
        models: definition
            .models
            .iter()
            .map(|value| value.to_string())
            .collect(),
        default_model: definition.default_model.to_string(),
        last_check: now_string(),
        probe_status: "not_run".to_string(),
        diagnostics,
    }
}

pub(crate) fn find_command(candidates: &[ToolCommand]) -> Option<ResolvedToolCommand> {
    for candidate in candidates {
        if let Some(binary) = find_binary(candidate.binary) {
            return Some(ResolvedToolCommand {
                binary,
                prefix_args: candidate
                    .prefix_args
                    .iter()
                    .map(|arg| arg.to_string())
                    .collect(),
                label: candidate.label.to_string(),
            });
        }
    }
    None
}

fn candidate_labels(candidates: &[ToolCommand]) -> Vec<String> {
    candidates
        .iter()
        .map(|candidate| candidate.label.to_string())
        .collect()
}

fn first_non_empty<'a>(first: &'a str, second: &'a str) -> &'a str {
    if first.trim().is_empty() {
        second
    } else {
        first
    }
}
