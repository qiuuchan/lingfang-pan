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

// resume_id / effort 接收但忽略：opencode 无 session 复用能力，也无思考强度参数；
// 多轮续接由 send_input 层用历史摘要拼进 prompt 实现（design §3.3.4），
// 思考强度仅 claude 生效（R2），这里保持统一签名解耦调用方。
fn build_args(
    prompt: &str,
    model: Option<&str>,
    _resume_id: Option<&str>,
    _effort: Option<&str>,
) -> Vec<String> {
    let mut args = vec!["run".to_string(), prompt.to_string()];
    if let Some(model) = model {
        args.extend(["--model".to_string(), model.to_string()]);
    }
    args
}
