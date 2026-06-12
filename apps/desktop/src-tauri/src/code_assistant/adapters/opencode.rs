use super::{CodeAssistantTool, ToolCommand, ToolDefinition};

pub const DEFINITION: ToolDefinition = ToolDefinition {
    tool: CodeAssistantTool::Opencode,
    display_name: "OpenCode",
    candidate_commands: &[ToolCommand {
        binary: "opencode",
        prefix_args: &[],
        label: "opencode",
    }],
    version_args: &["--version"],
    models: &["default", "qwen-coder"],
    default_model: "default",
    build_args,
};

fn build_args(prompt: &str, model: Option<&str>) -> Vec<String> {
    let mut args = vec!["run".to_string(), prompt.to_string()];
    if let Some(model) = model {
        args.extend(["--model".to_string(), model.to_string()]);
    }
    args
}
