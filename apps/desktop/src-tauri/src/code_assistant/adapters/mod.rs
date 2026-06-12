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
    pub build_args: fn(prompt: &str, model: Option<&str>) -> Vec<String>,
}

impl ToolDefinition {
    pub fn probe_args(&self, prompt: &str, model: Option<&str>) -> Vec<String> {
        (self.build_args)(prompt, clean_model(model))
    }

    pub fn run_args(&self, prompt: &str, model: Option<&str>) -> Vec<String> {
        self.probe_args(prompt, model)
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
        assert_eq!(
            definition.probe_args("ping", Some("sonnet")),
            vec!["-p", "ping", "--model", "sonnet"]
        );
    }

    #[test]
    fn codex_probe_uses_exec_subcommand() {
        let definition = tool_definition(CodeAssistantTool::Codex);
        assert_eq!(
            definition.probe_args("ping", Some("gpt-5.1-codex")),
            vec!["exec", "ping", "--model", "gpt-5.1-codex"]
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
}
