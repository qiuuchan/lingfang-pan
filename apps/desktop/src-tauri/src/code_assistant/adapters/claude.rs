use super::{CodeAssistantTool, ToolCommand, ToolDefinition};

pub const DEFINITION: ToolDefinition = ToolDefinition {
    tool: CodeAssistantTool::Claude,
    display_name: "Claude Code",
    candidate_commands: &[ToolCommand {
        binary: "claude",
        prefix_args: &[],
        label: "claude",
    }],
    version_args: &["--version"],
    models: &["sonnet", "opus"],
    default_model: "sonnet",
    build_args,
};

fn build_args(prompt: &str, model: Option<&str>, resume_id: Option<&str>) -> Vec<String> {
    let mut args = vec![
        "-p".to_string(),
        prompt.to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--include-partial-messages".to_string(),
    ];
    if let Some(model) = model {
        args.extend(["--model".to_string(), model.to_string()]);
    }
    // 真多轮续接：claude headless 用 `--resume <session_id>` 续接上一轮上下文。
    if let Some(id) = resume_id {
        args.extend(["--resume".to_string(), id.to_string()]);
    }
    args
}
