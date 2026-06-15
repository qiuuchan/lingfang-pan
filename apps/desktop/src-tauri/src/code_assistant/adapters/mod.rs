mod claude;
mod codex;
mod opencode;

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CodeAssistantTool {
    Claude,
    Codex,
    Opencode,
}

impl CodeAssistantTool {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Opencode => "opencode",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct ToolCommand {
    pub binary: &'static str,
    pub prefix_args: &'static [&'static str],
    pub label: &'static str,
}

#[derive(Clone, Debug)]
pub struct ToolDefinition {
    pub tool: CodeAssistantTool,
    pub display_name: &'static str,
    pub candidate_commands: &'static [ToolCommand],
    pub version_args: &'static [&'static str],
    pub models: &'static [&'static str],
    pub default_model: &'static str,
// build_args 追加 resume_id / effort 入参（design §3.3.1 + R2）：
// - claude：resume_id 非空时拼接 `--resume <id>` 实现真续接；effort 非空时拼接 `--effort <level>` 调节思考强度。
// - codex/opencode：resume_id / effort 接收但忽略，统一签名解耦调用方；续接靠历史摘要，思考强度仅 claude 生效。
// None 表示首轮 / 未设思考强度（无对应语义）。
pub build_args: fn(
        prompt: &str,
        model: Option<&str>,
        resume_id: Option<&str>,
        effort: Option<&str>,
    ) -> Vec<String>,
}

impl ToolDefinition {
    pub fn probe_args(&self, prompt: &str, model: Option<&str>) -> Vec<String> {
        // 探针/run_once 永远是首轮调用，resume_id 与 effort 恒为 None。
        (self.build_args)(prompt, clean_model(model), None, None)
    }

    pub fn run_args(
        &self,
        prompt: &str,
        model: Option<&str>,
        resume_id: Option<&str>,
        effort: Option<&str>,
    ) -> Vec<String> {
        (self.build_args)(prompt, clean_model(model), resume_id, effort)
    }
}

pub(crate) fn clean_model(model: Option<&str>) -> Option<&str> {
    model
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "default")
}

pub const TOOL_DEFINITIONS: &[ToolDefinition] =
    &[claude::DEFINITION, codex::DEFINITION, opencode::DEFINITION];

pub fn tool_definition(tool: CodeAssistantTool) -> &'static ToolDefinition {
    TOOL_DEFINITIONS
        .iter()
        .find(|definition| definition.tool == tool)
        .expect("missing tool definition")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_probe_uses_print_mode_and_model() {
        let definition = tool_definition(CodeAssistantTool::Claude);
        // claude headless 模式固定携带 stream-json 输出 + verbose + include-partial-messages（adapters/claude.rs）。
        // probe_args 是首轮调用，不带 --resume。
        // --permission-mode bypassPermissions：方案A 自动放行 Write 写文件到 sandbox（不卡授权）。
        assert_eq!(
            definition.probe_args("ping", Some("sonnet")),
            vec![
                "-p", "ping",
                "--output-format", "stream-json",
                "--verbose", "--include-partial-messages",
                "--permission-mode", "bypassPermissions",
                "--model", "sonnet",
            ]
        );
    }

    #[test]
    fn codex_probe_uses_exec_subcommand() {
        let definition = tool_definition(CodeAssistantTool::Codex);
        // --skip-git-repo-check：sandbox 非 git 仓库，必须跳过 codex 的目录信任检查。
        // --json + --color never：task 06-13 R3，codex 走 JSONL 事件流（分类渲染 + 禁用 ANSI 颜色码）。
        assert_eq!(
            definition.probe_args("ping", Some("gpt-5.1-codex")),
            vec![
                "exec",
                "ping",
                "--model",
                "gpt-5.1-codex",
                "--skip-git-repo-check",
                "--json",
                "--color",
                "never",
            ]
        );
    }

    #[test]
    fn opencode_skips_default_model_arg() {
        let definition = tool_definition(CodeAssistantTool::Opencode);
        assert_eq!(
            definition.probe_args("ping", Some("default")),
            vec!["run", "ping"]
        );
    }

    // === design §3.3.1：build_args resume_id 行为 ===

    #[test]
    fn claude_resume_appends_resume_arg() {
        // claude 真多轮：resume_id 非空时拼 `--resume <id>` 续接；effort=None 不附加 --effort。
        let definition = tool_definition(CodeAssistantTool::Claude);
        assert_eq!(
            definition.run_args("ping", Some("sonnet"), Some("sid-123"), None),
            vec![
                "-p", "ping",
                "--output-format", "stream-json",
                "--verbose", "--include-partial-messages",
                "--permission-mode", "bypassPermissions",
                "--model", "sonnet",
                "--resume", "sid-123",
            ]
        );
    }

    #[test]
    fn claude_effort_appends_effort_arg() {
        // R2：effort 非空时拼 `--effort <level>` 调节思考强度（仅 claude 生效）。
        let definition = tool_definition(CodeAssistantTool::Claude);
        let args = definition.run_args("ping", Some("sonnet"), None, Some("high"));
        assert!(args.iter().any(|a| a == "--effort"));
        assert!(args.windows(2).any(|w| w[0] == "--effort" && w[1] == "high"));
    }

    #[test]
    fn claude_empty_effort_ignored() {
        // R2：effort 为空字符串或 None 时不附加 --effort（避免传空值给 CLI）。
        let definition = tool_definition(CodeAssistantTool::Claude);
        let args = definition.run_args("ping", None, None, Some(""));
        assert!(!args.iter().any(|a| a == "--effort"));
    }

    #[test]
    fn claude_first_round_has_no_resume_arg() {
        // 首轮 resume_id 为 None：不带 --resume。
        let definition = tool_definition(CodeAssistantTool::Claude);
        let args = definition.run_args("ping", None, None, None);
        assert!(!args.iter().any(|a| a == "--resume"));
    }

    #[test]
    fn codex_resume_id_ignored() {
        // codex 伪多轮：resume_id 不进入 args（续接靠历史摘要，不依赖 CLI）；
        // effort 同样不进入 args（codex 无思考强度参数，R2 仅 claude 生效）。
        // --json + --color never：task 06-13 R3，codex 走 JSONL 事件流（分类渲染 + 禁用 ANSI 颜色码）。
        let definition = tool_definition(CodeAssistantTool::Codex);
        let args = definition.run_args("ping", Some("gpt-5.1-codex"), Some("sid-xyz"), Some("high"));
        assert_eq!(
            args,
            vec![
                "exec",
                "ping",
                "--model",
                "gpt-5.1-codex",
                "--skip-git-repo-check",
                "--json",
                "--color",
                "never",
            ]
        );
    }

    #[test]
    fn opencode_resume_id_ignored() {
        // opencode 伪多轮：同上。
        let definition = tool_definition(CodeAssistantTool::Opencode);
        let args = definition.run_args("ping", None, Some("sid-abc"), Some("medium"));
        assert_eq!(args, vec!["run", "ping"]);
    }
}
