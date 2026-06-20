use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use serde_json::{json, Value};
use url::{Host, Url};

use super::anthropic::{build_messages_body, build_messages_url};
use super::openai::{build_chat_body, build_chat_url};
use super::stream::{
    AnthropicStreamState, OpenAiStreamState, SseDecoder, StreamEvent, ToolCall, DONE_SENTINEL,
};
use super::tools::LocalToolExecutor;
use super::SdkCredentials;
use crate::code_assistant::history::build_history_summary;
use crate::code_assistant::store::AssistantStore;
use crate::code_assistant::types::CodeAssistantTool;

#[derive(Clone)]
pub struct RunRequest {
    pub session_id: String,
    pub tool: CodeAssistantTool,
    pub model: Option<String>,
    pub workspace_dir: String,
    pub embedded_runtime_root: Option<PathBuf>,
    pub prompt: String,
    pub system_prompt: Option<String>,
    pub credentials: SdkCredentials,
    pub store: AssistantStore,
    pub cancel: Arc<AtomicBool>,
}

pub trait EngineEventSink {
    fn output(&self, stream: &'static str, text: String);
    fn error(&self, message: String);
}

pub async fn run_sdk_turn<S: EngineEventSink>(request: RunRequest, sink: S) -> Result<(), String> {
    if request.cancel.load(Ordering::SeqCst) {
        return Ok(());
    }
    match request.tool {
        CodeAssistantTool::Claude => run_claude(request, sink).await,
        CodeAssistantTool::Codex => run_codex(request, sink).await,
    }
}

async fn run_claude<S: EngineEventSink>(request: RunRequest, sink: S) -> Result<(), String> {
    let url = build_messages_url(&request.credentials.api_url);
    let messages = claude_messages(&request);
    let mut body = build_messages_body(
        effective_model(request.model.as_deref(), "claude-sonnet-4-5"),
        request.system_prompt.as_deref(),
        messages,
    );
    let tools = LocalToolExecutor::with_runtime_root(
        request.workspace_dir.clone().into(),
        request.embedded_runtime_root.clone(),
    );
    let client = sdk_http_client(&url)?;
    loop {
        abort_if_cancelled(&request)?;
        let response = client
            .post(&url)
            .header("x-api-key", &request.credentials.api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&body)
            .send()
            .await
            .map_err(|error| format!("ClaudeCode SDK 请求失败：{error}"))?;
        let status = response.status();
        if !status.is_success() {
            let detail = response.text().await.unwrap_or_default();
            return Err(format!("ClaudeCode SDK 返回错误：HTTP {status} {detail}"));
        }

        let mut state = AnthropicStreamState::new();
        let mut decoder = SseDecoder::new();
        let mut response = response;
        loop {
            abort_if_cancelled(&request)?;
            let chunk = response
                .chunk()
                .await
                .map_err(|error| format!("ClaudeCode SDK 流读取失败：{error}"))?;
            let Some(chunk) = chunk else { break };
            for payload in decoder.push(&chunk) {
                if payload == DONE_SENTINEL {
                    continue;
                }
                let Ok(value) = serde_json::from_str::<Value>(&payload) else {
                    // 偶发畸形负载安全跳过，不中断整轮。
                    continue;
                };
                for event in state.accept(&value) {
                    emit_stream_event(&sink, event);
                }
            }
        }

        if state.stop_reason() != Some("tool_use") {
            return Ok(());
        }
        let calls = state.tool_calls();
        if calls.is_empty() {
            return Ok(());
        }
        append_anthropic_tool_round(
            &sink,
            &mut body,
            state.into_assistant_content(),
            &calls,
            &tools,
        )?;
    }
}

async fn run_codex<S: EngineEventSink>(request: RunRequest, sink: S) -> Result<(), String> {
    let url = build_chat_url(&request.credentials.api_url);
    let messages = openai_messages(&request);
    let mut body = build_chat_body(
        effective_model(request.model.as_deref(), "gpt-5.1"),
        messages,
    );
    let tools = LocalToolExecutor::with_runtime_root(
        request.workspace_dir.clone().into(),
        request.embedded_runtime_root.clone(),
    );
    let client = sdk_http_client(&url)?;
    loop {
        abort_if_cancelled(&request)?;
        let response = client
            .post(&url)
            .bearer_auth(&request.credentials.api_key)
            .json(&body)
            .send()
            .await
            .map_err(|error| format!("Codex SDK 请求失败：{error}"))?;
        let status = response.status();
        if !status.is_success() {
            let detail = response.text().await.unwrap_or_default();
            return Err(format!("Codex SDK 返回错误：HTTP {status} {detail}"));
        }

        let mut state = OpenAiStreamState::new();
        let mut decoder = SseDecoder::new();
        let mut response = response;
        loop {
            abort_if_cancelled(&request)?;
            let chunk = response
                .chunk()
                .await
                .map_err(|error| format!("Codex SDK 流读取失败：{error}"))?;
            let Some(chunk) = chunk else { break };
            for payload in decoder.push(&chunk) {
                if payload == DONE_SENTINEL {
                    continue;
                }
                let Ok(value) = serde_json::from_str::<Value>(&payload) else {
                    // 偶发畸形负载安全跳过，不中断整轮。
                    continue;
                };
                for event in state.accept(&value) {
                    emit_stream_event(&sink, event);
                }
            }
        }

        if state.finish_reason() != Some("tool_calls") {
            return Ok(());
        }
        let calls = state.tool_calls();
        if calls.is_empty() {
            return Ok(());
        }
        append_openai_tool_round(
            &sink,
            &mut body,
            state.into_assistant_message(),
            &calls,
            &tools,
        )?;
    }
}

fn effective_model<'a>(model: Option<&'a str>, fallback: &'a str) -> &'a str {
    model
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "default")
        .unwrap_or(fallback)
}

fn sdk_http_client(api_url: &str) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder();
    if is_loopback_url(api_url) {
        builder = builder.no_proxy();
    }
    builder
        .build()
        .map_err(|error| format!("创建 SDK HTTP 客户端失败：{error}"))
}

pub(crate) fn is_loopback_url(raw: &str) -> bool {
    let Ok(url) = Url::parse(raw) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    match url.host() {
        Some(Host::Ipv4(addr)) => IpAddr::V4(addr).is_loopback(),
        Some(Host::Ipv6(addr)) => IpAddr::V6(addr).is_loopback(),
        Some(Host::Domain(domain)) => domain.eq_ignore_ascii_case("localhost"),
        None => false,
    }
}

fn claude_messages(request: &RunRequest) -> Vec<(String, String)> {
    let history = build_history_summary(&request.store, &request.session_id).unwrap_or_default();
    if history.trim().is_empty() {
        return vec![("user".to_string(), request.prompt.clone())];
    }
    let composed = format!("{history}\n\n请基于以上对话历史继续回复或修改文件。");
    vec![("user".to_string(), composed)]
}

fn openai_messages(request: &RunRequest) -> Vec<(String, String)> {
    let mut messages = Vec::new();
    if let Some(system) = request
        .system_prompt
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        messages.push(("system".to_string(), system.to_string()));
    }
    let history = build_history_summary(&request.store, &request.session_id).unwrap_or_default();
    if history.trim().is_empty() {
        messages.push(("user".to_string(), request.prompt.clone()));
        return messages;
    }
    let composed = format!("{history}\n\n请基于以上对话历史继续回复或修改文件。");
    messages.push(("user".to_string(), composed));
    messages
}

/// 把状态机产出的增量事件经既有 sink 链路分类推送：
/// 正文走 stdout、思考走 thought、工具调用走 tool（绝不混入 stdout）。
fn emit_stream_event<S: EngineEventSink>(sink: &S, event: StreamEvent) {
    match event {
        StreamEvent::Text(text) => {
            if !text.is_empty() {
                sink.output("stdout", text);
            }
        }
        StreamEvent::Thought(text) => {
            if !text.is_empty() {
                sink.output("thought", text);
            }
        }
        StreamEvent::ToolCallReady(call) => {
            sink.output("tool", format!("{} {}", call.name, call.arguments));
        }
    }
}

/// 续轮：把流式重建出的 assistant content 与各工具的本地执行结果追加进 messages，
/// 沿用 Anthropic 的 tool_result 续轮语义（thinking 块及其 signature 已在重建数组中保留）。
fn append_anthropic_tool_round<S: EngineEventSink>(
    sink: &S,
    body: &mut Value,
    assistant_content: Value,
    calls: &[ToolCall],
    tools: &LocalToolExecutor,
) -> Result<(), String> {
    let messages = body["messages"]
        .as_array_mut()
        .ok_or_else(|| "ClaudeCode messages 结构异常".to_string())?;
    messages.push(json!({ "role": "assistant", "content": assistant_content }));
    let results = calls
        .iter()
        .map(|call| {
            let result = execute_tool_with_visible_result(sink, call, tools);
            json!({
                "type": "tool_result",
                "tool_use_id": call.id,
                "content": result.to_string(),
            })
        })
        .collect::<Vec<_>>();
    messages.push(json!({ "role": "user", "content": results }));
    Ok(())
}

/// 续轮：追加流式重建出的 assistant message（含 tool_calls，不含 reasoning_content），
/// 再为每个工具追加 role=tool 的执行结果。
fn append_openai_tool_round<S: EngineEventSink>(
    sink: &S,
    body: &mut Value,
    assistant_message: Value,
    calls: &[ToolCall],
    tools: &LocalToolExecutor,
) -> Result<(), String> {
    let messages = body["messages"]
        .as_array_mut()
        .ok_or_else(|| "Codex messages 结构异常".to_string())?;
    messages.push(assistant_message);
    for call in calls {
        let result = execute_tool_with_visible_result(sink, call, tools);
        messages.push(json!({
            "role": "tool",
            "tool_call_id": call.id,
            "content": result.to_string(),
        }));
    }
    Ok(())
}

fn execute_tool_with_visible_result<S: EngineEventSink>(
    sink: &S,
    call: &ToolCall,
    tools: &LocalToolExecutor,
) -> Value {
    let result = tools.execute(&call.name, &call.arguments);
    sink.output("tool", format!("{}_result {}", call.name, result));
    result
}

fn abort_if_cancelled(request: &RunRequest) -> Result<(), String> {
    if request.cancel.load(Ordering::SeqCst) {
        return Err("会话已停止".to_string());
    }
    Ok(())
}
