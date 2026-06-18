use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::adapters::CodeAssistantTool;

#[derive(Clone, Debug)]
pub(crate) struct ResolvedToolCommand {
    pub(crate) binary: PathBuf,
    pub(crate) prefix_args: Vec<String>,
    pub(crate) label: String,
}

impl ResolvedToolCommand {
    pub(crate) fn args_with(&self, args: Vec<String>) -> Vec<String> {
        let mut merged = self.prefix_args.clone();
        merged.extend(args);
        merged
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct ToolAvailability {
    pub tool: CodeAssistantTool,
    pub display_name: String,
    pub available: bool,
    pub binary_path: Option<String>,
    pub version: Option<String>,
    pub models: Vec<String>,
    pub default_model: String,
    pub last_check: String,
    pub probe_status: String,
    pub diagnostics: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ProbeResult {
    pub tool: CodeAssistantTool,
    pub model: Option<String>,
    pub success: bool,
    pub command_preview: Vec<String>,
    pub stdout_tail: String,
    pub stderr_tail: String,
    pub exit_code: Option<i32>,
    pub elapsed_ms: u128,
    pub transcript_path: String,
    pub session_id: String,
    pub diagnostics: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct CheckToolInput {
    pub tool: CodeAssistantTool,
}

#[derive(Debug, Deserialize)]
pub struct ProbeInput {
    pub tool: CodeAssistantTool,
    pub model: Option<String>,
    #[serde(alias = "workspaceDir")]
    pub workspace_dir: Option<String>,
    pub prompt: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SaveConfigInput {
    #[serde(alias = "defaultTool")]
    pub default_tool: Option<CodeAssistantTool>,
    #[serde(alias = "defaultModel")]
    pub default_model: Option<String>,
    #[serde(alias = "workspaceDir")]
    pub workspace_dir: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct StartSessionInput {
    pub tool: CodeAssistantTool,
    pub model: Option<String>,
    #[serde(alias = "workspaceDir")]
    pub workspace_dir: Option<String>,
    pub prompt: String,
    #[serde(alias = "systemPrompt")]
    pub system_prompt: Option<String>,
    // R2 思考强度：claude 透传 `--effort <level>`；codex/opencode 接收但忽略。
    pub effort: Option<String>,
    #[serde(default, alias = "pluginId")]
    pub plugin_id: Option<String>,
    #[serde(default, alias = "cliConfig")]
    pub cli_config: Option<CliConfigInput>,
}

/// CLI 配置注入所需的后端连接信息；apiKey 明文只在 Rust 内部获取，不回前端。
#[derive(Debug, Deserialize, Default)]
pub struct CliConfigInput {
    #[serde(default, alias = "backendUrl")]
    pub backend_url: String,
    #[serde(default, alias = "authToken")]
    pub auth_token: String,
}

#[derive(Debug, Deserialize)]
pub struct StopSessionInput {
    #[serde(alias = "sessionId")]
    pub session_id: String,
}

#[derive(Debug, Deserialize)]
pub struct ReadTranscriptInput {
    #[serde(alias = "sessionId")]
    pub session_id: String,
}

#[derive(Debug, Deserialize)]
pub struct RenameSessionInput {
    #[serde(alias = "sessionId")]
    pub session_id: String,
    pub title: String,
}

#[derive(Debug, Deserialize)]
pub struct DeleteSessionInput {
    #[serde(alias = "sessionId")]
    pub session_id: String,
}

#[derive(Debug, Deserialize)]
pub struct SaveDraftInput {
    #[serde(alias = "sessionId")]
    pub session_id: String,
    /// 前端序列化后的 PluginDraft JSON。Rust 不解析内部定义，保持前后端 schema 解耦。
    #[serde(alias = "draftJson")]
    pub draft_json: Value,
}

#[derive(Debug, Deserialize)]
pub struct ReadDraftInput {
    #[serde(alias = "sessionId")]
    pub session_id: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct DraftFileJson {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Deserialize)]
pub struct ScanWorkspaceInput {
    #[serde(alias = "sessionId")]
    pub session_id: String,
}

#[derive(Debug, Deserialize)]
pub struct SendInputInput {
    #[serde(alias = "sessionId")]
    pub session_id: String,
    pub input: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    #[serde(default, alias = "cliConfig")]
    pub cli_config: Option<CliConfigInput>,
    #[serde(default, alias = "systemPrompt")]
    pub system_prompt: Option<String>,
}
