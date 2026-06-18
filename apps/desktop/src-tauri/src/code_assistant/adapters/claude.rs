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

// build_args 签名与 adapters/mod.rs 的 fn 指针对齐：追加 effort（思考强度）+ system_prompt 入参。
// - effort：claude headless 透传 `--effort <level>`（max/high/medium/low/none）；None 或空忽略。
// - system_prompt：非空时用 `--system-prompt <s>` 作为独立 system message（而非拼进 -p 用户消息）。
//   修正：此前 start_session 把 systemPrompt 拼进 final_prompt 传给 -p，claude 把它当普通用户文本，
//   导致创建指令被弱化/忽略。改用 --system-prompt 让 claude 正确区分系统指令与用户需求。
// - codex/opencode 无对应参数，签名对齐但忽略（统一签名解耦调用方）。
// 设计 R2：思考强度随每轮 send 传（start_session + send_input 都带，可会话中途调）。
fn build_args(
    prompt: &str,
    model: Option<&str>,
    resume_id: Option<&str>,
    effort: Option<&str>,
    system_prompt: Option<&str>,
) -> Vec<String> {
    let mut args = vec![
        "-p".to_string(),
        prompt.to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--include-partial-messages".to_string(),
        // 方案A：claude 用 Write 工具把插件文件写到 sandbox 目录（agent 本能），Rust 跑完扫描目录收成包。
        // bypassPermissions 让 headless 自动放行写文件（不卡授权）。
        "--permission-mode".to_string(),
        "bypassPermissions".to_string(),
        "--bare".to_string(),
        "--setting-sources".to_string(),
        String::new(),
    ];
    // system_prompt 作为独立 system message（修正：此前拼进 -p 被弱化为用户文本）。
    if let Some(sys) = system_prompt.map(str::trim).filter(|s| !s.is_empty()) {
        args.extend(["--system-prompt".to_string(), sys.to_string()]);
    }
    if let Some(model) = model {
        args.extend(["--model".to_string(), model.to_string()]);
    }
    // 真多轮续接：claude headless 用 `--resume <session_id>` 续接上一轮上下文。
    if let Some(id) = resume_id {
        args.extend(["--resume".to_string(), id.to_string()]);
    }
    // 思考强度（R2）：非空时透传 `--effort <level>`，claude 据此调节思考预算。
    // 合法值由前端选择器收敛（max/high/medium/low/none），此处仅做去空过滤，非法值交由 CLI 自行报错。
    if let Some(level) = effort.map(str::trim).filter(|value| !value.is_empty()) {
        args.extend(["--effort".to_string(), level.to_string()]);
    }
    args
}
