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
// === codex --json 流式分类输出（task 06-13 R3 codex 补齐）===
// codex exec 支持 `--json`（输出 JSONL 事件流，见 codex-cli 0.139.0 `codex exec --help`），
// 实测 + 二进制字符串反查确认事件 type 清单（每行一个 JSON，顶层 `type` 字段为判别器）：
// - `thread.started`（含 thread_id）/`turn.started`/`turn.completed` → 仅生命周期信号，丢弃。
// - `turn.failed`（含 error.message）/`error`（含 message，含 reconnecting 重连尝试）→ 错误，
//   进 stderr 流（让前端诊断区可见真实错误，不进 stdout 协议解析）。
// - `token_count`（含 usage）→ 用量统计，丢弃（不污染对话）。
// - `item.started`/`item.updated`/`item.completed`（含 item 对象）→ 真正的内容载体，按 item.type 分类：
//     * agent_message（含 content[]，每项 {type:"output_text",text}）→ Text（进 stdout）。
//     * agent_message_content_delta（含 delta）→ Text 增量（进 stdout）。
//     * reasoning / agent_reasoning / agent_reasoning_raw_content → Thinking（进 thought）。
//     * reasoning_content_delta / reasoning_raw_content_delta → Thinking 增量（进 thought）。
//     * local_shell_call（含 action.command）/function_call（含 name+arguments）/mcp_tool_call →
//       ToolUse（进 tool，工具卡片）。
// 解析器在 code_assistant.rs::extract_codex_json_items 实现，spawn_reader 用 OutputFormat::CodexJson 调用。
//
// `--color never`：禁用 ANSI 颜色码（JSONL 通道不需要，且避免颜色码混入 JSON 解析）。
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
    // 修复 codex「Not inside a trusted directory」报错：工作目录不是 git 仓库，
    // codex 默认拒绝在非 git 目录运行（安全限制）。加 --skip-git-repo-check 放行。
    // workspace 由 code_assistant::resolve_workspace 生成：插件创建会话落到 plugins_root/<plugin_id>/
    // （组D task 06-16 持久化目录），非插件场景回退 app_data/claude-sandbox。两者均不含 .git，
    // 故必须显式跳过该检查，否则 codex exec 立即退出不产出。
    args.push("--skip-git-repo-check".to_string());
    // --json：输出 JSONL 事件流（支持流式思考/工具分类，对齐 claude stream-json 的分类渲染）。
    // --color never：禁用 ANSI 颜色码（JSONL 通道无需颜色，避免颜色码混入 JSON 解析）。
    args.push("--json".to_string());
    args.push("--color".to_string());
    args.push("never".to_string());
    args
}
