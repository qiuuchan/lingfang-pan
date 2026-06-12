use super::{CodeAssistantTool, ToolCommand, ToolDefinition};

pub const DEFINITION: ToolDefinition = ToolDefinition {
    tool: CodeAssistantTool::Codex,
    display_name: "Codex",
    candidate_commands: &[
        ToolCommand {
            binary: "codex",
            prefix_args: &[],
            label: "codex",
        },
        ToolCommand {
            binary: "npx",
            prefix_args: &["--no-install", "@openai/codex"],
            label: "npx --no-install @openai/codex",
        },
    ],
    version_args: &["--version"],
    models: &["default", "gpt-5.5", "gpt-5.1-codex", "gpt-5.1"],
    default_model: "default",
    build_args,
};

fn build_args(prompt: &str, model: Option<&str>) -> Vec<String> {
    let mut args = vec!["exec".to_string(), prompt.to_string()];
    if let Some(model) = model {
        args.extend(["--model".to_string(), model.to_string()]);
    }
    args
}
