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

fn build_args(prompt: &str, model: Option<&str>) -> Vec<String> {
    let mut args = vec!["-p".to_string(), prompt.to_string()];
    if let Some(model) = model {
        args.extend(["--model".to_string(), model.to_string()]);
    }
    args
}
