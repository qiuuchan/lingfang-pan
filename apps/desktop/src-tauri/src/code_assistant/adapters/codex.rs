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

// resume_id / effort 接收但忽略：codex 的 resume 是独立子命令（exec 不暴露 --resume），
// 且无思考强度参数；多轮续接由 send_input 层用历史摘要拼进 prompt 实现（design §3.3.4），
// 思考强度仅 claude 生效（R2），这里保持统一签名解耦调用方。
//
// === codex 可用性降级标注（task 06-15 R2 / AC6） ===
// codex exec 的输出模式（已查 developers.openai.com/codex/cli/reference + noninteractive 文档）：
// - 默认（当前实现）：进度流→stderr，最终 agent message→stdout（**聚合输出**，非流式）。
// - `--json`（别名 `--experimental-json`）：输出 JSONL 事件流（agentMessage delta / item / turn 事件，
//   支持流式思考与工具调用），格式为 `{"msg":{"type":"text","content":"..."},"timestamp":"..."}`
//   或 `{"method":"item/agentMessage/delta","params":{...}}`（不同版本格式不一致）。
//
// 决策（诚实标注降级，AC6）：当前**不加** `--json`，codex 思考/工具输出为聚合模式：
// - 最终结果进 stdout（前端对话区可见，满足 AC5「输出可见」）。
// - 进度/思考片段进 stderr（前端诊断区可见，但不按 claude stream-json 那样分流到 thought/tool 流）。
// 不加 --json 的原因：codex JSONL 事件格式与 claude stream-json 完全不同，需新增独立解析器
// （且 codex 版本间事件 schema 不稳定），超出「CLI 配置注入」核心任务范围。
// 后续若要 codex 流式思考/工具展示，需单独任务实现 codex JSONL 解析 + spawn_reader 的 OutputFormat::CodexJson。
fn build_args(
    prompt: &str,
    model: Option<&str>,
    _resume_id: Option<&str>,
    _effort: Option<&str>,
) -> Vec<String> {
    let mut args = vec!["exec".to_string(), prompt.to_string()];
    if let Some(model) = model {
        args.extend(["--model".to_string(), model.to_string()]);
    }
    args
}
