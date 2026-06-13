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

// resume_id 接收但忽略：codex 的 resume 是独立子命令（exec 不暴露 --resume），
// 多轮续接由 send_input 层用历史摘要拼进 prompt 实现（design §3.3.4），保持跨 CLI 统一签名。
fn build_args(prompt: &str, model: Option<&str>, _resume_id: Option<&str>) -> Vec<String> {
    let mut args = vec!["exec".to_string(), prompt.to_string()];
    if let Some(model) = model {
        args.extend(["--model".to_string(), model.to_string()]);
    }
    args
}
