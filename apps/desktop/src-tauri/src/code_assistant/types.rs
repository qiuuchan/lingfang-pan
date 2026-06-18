use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CodeAssistantTool {
    Claude,
    Codex,
}

impl CodeAssistantTool {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            Self::Claude => "ClaudeCode",
            Self::Codex => "Codex",
        }
    }
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
    // SDK runtime keeps this field for frontend compatibility. The current
    // provider APIs do not expose a portable effort parameter, so it is ignored.
    #[allow(dead_code)]
    pub effort: Option<String>,
    #[serde(default, alias = "pluginId")]
    pub plugin_id: Option<String>,
    #[serde(default, alias = "cliConfig", alias = "sdkConfig")]
    pub sdk_config: Option<SdkConfigInput>,
}

/// SDK 请求所需的后端连接信息；apiKey 明文只在 Rust 内部获取，不回前端。
#[derive(Debug, Deserialize, Default)]
pub struct SdkConfigInput {
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
    #[allow(dead_code)]
    pub effort: Option<String>,
    #[serde(default, alias = "cliConfig", alias = "sdkConfig")]
    pub sdk_config: Option<SdkConfigInput>,
    #[serde(default, alias = "systemPrompt")]
    pub system_prompt: Option<String>,
}
