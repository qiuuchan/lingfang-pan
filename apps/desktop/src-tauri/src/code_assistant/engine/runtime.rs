use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use serde_json::{json, Value};

use super::anthropic::{build_messages_body, build_messages_url};
use super::openai::{build_chat_body, build_chat_url};
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
    let tools = LocalToolExecutor::new(request.workspace_dir.clone().into());
    let client = reqwest::Client::new();
    loop {
        abort_if_cancelled(&request)?;
        let response = client
            .post(&url)
            .bearer_auth(&request.credentials.api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&body)
            .send()
            .await
            .map_err(|error| format!("ClaudeCode SDK 请求失败：{error}"))?;
        let status = response.status();
        let value: Value = response
            .json()
            .await
            .map_err(|error| format!("ClaudeCode SDK 响应解析失败：{error}"))?;
        if !status.is_success() {
            return Err(format!("ClaudeCode SDK 返回错误：HTTP {status} {value}"));
        }
        let (text, calls) = parse_anthropic_response(&value);
        if !text.is_empty() {
            sink.output("stdout", text);
        }
        if calls.is_empty() {
            return Ok(());
        }
        emit_tool_calls(&sink, &calls);
        append_anthropic_tool_round(&mut body, &value, &calls, &tools)?;
    }
}

async fn run_codex<S: EngineEventSink>(request: RunRequest, sink: S) -> Result<(), String> {
    let url = build_chat_url(&request.credentials.api_url);
    let messages = openai_messages(&request);
    let mut body = build_chat_body(
        effective_model(request.model.as_deref(), "gpt-5.1"),
        messages,
    );
    let tools = LocalToolExecutor::new(request.workspace_dir.clone().into());
    let client = reqwest::Client::new();
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
        let value: Value = response
            .json()
            .await
            .map_err(|error| format!("Codex SDK 响应解析失败：{error}"))?;
        if !status.is_success() {
            return Err(format!("Codex SDK 返回错误：HTTP {status} {value}"));
        }
        let (text, calls) = parse_openai_response(&value);
        if !text.is_empty() {
            sink.output("stdout", text);
        }
        if calls.is_empty() {
            return Ok(());
        }
        emit_tool_calls(&sink, &calls);
        append_openai_tool_round(&mut body, &value, &calls, &tools)?;
    }
}

fn effective_model<'a>(model: Option<&'a str>, fallback: &'a str) -> &'a str {
    model
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "default")
        .unwrap_or(fallback)
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

#[derive(Clone, Debug)]
struct ToolCall {
    id: String,
    name: String,
    arguments: Value,
}

fn parse_anthropic_response(value: &Value) -> (String, Vec<ToolCall>) {
    let mut text = String::new();
    let mut calls = Vec::new();
    for item in value.get("content").and_then(|value| value.as_array()).into_iter().flatten() {
        match item.get("type").and_then(|value| value.as_str()) {
            Some("text") => {
                if let Some(part) = item.get("text").and_then(|value| value.as_str()) {
                    text.push_str(part);
                }
            }
            Some("tool_use") => calls.push(ToolCall {
                id: string_field(item, "id"),
                name: string_field(item, "name"),
                arguments: item.get("input").cloned().unwrap_or_else(|| json!({})),
            }),
            _ => {}
        }
    }
    (text, calls)
}

fn parse_openai_response(value: &Value) -> (String, Vec<ToolCall>) {
    let message = &value["choices"][0]["message"];
    let text = message
        .get("content")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();
    let mut calls = Vec::new();
    for item in message
        .get("tool_calls")
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
    {
        let raw_args = item["function"]["arguments"].as_str().unwrap_or("{}");
        let arguments = serde_json::from_str(raw_args).unwrap_or_else(|_| json!({}));
        calls.push(ToolCall {
            id: string_field(item, "id"),
            name: string_field(&item["function"], "name"),
            arguments,
        });
    }
    (text, calls)
}

fn emit_tool_calls<S: EngineEventSink>(sink: &S, calls: &[ToolCall]) {
    for call in calls {
        sink.output("tool", format!("{} {}", call.name, call.arguments));
    }
}

fn append_anthropic_tool_round(
    body: &mut Value,
    response: &Value,
    calls: &[ToolCall],
    tools: &LocalToolExecutor,
) -> Result<(), String> {
    let messages = body["messages"]
        .as_array_mut()
        .ok_or_else(|| "ClaudeCode messages 结构异常".to_string())?;
    messages.push(json!({ "role": "assistant", "content": response["content"] }));
    let results = calls
        .iter()
        .map(|call| {
            json!({
                "type": "tool_result",
                "tool_use_id": call.id,
                "content": tools.execute(&call.name, &call.arguments).to_string(),
            })
        })
        .collect::<Vec<_>>();
    messages.push(json!({ "role": "user", "content": results }));
    Ok(())
}

fn append_openai_tool_round(
    body: &mut Value,
    response: &Value,
    calls: &[ToolCall],
    tools: &LocalToolExecutor,
) -> Result<(), String> {
    let messages = body["messages"]
        .as_array_mut()
        .ok_or_else(|| "Codex messages 结构异常".to_string())?;
    messages.push(response["choices"][0]["message"].clone());
    for call in calls {
        messages.push(json!({
            "role": "tool",
            "tool_call_id": call.id,
            "content": tools.execute(&call.name, &call.arguments).to_string(),
        }));
    }
    Ok(())
}

fn string_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string()
}

fn abort_if_cancelled(request: &RunRequest) -> Result<(), String> {
    if request.cancel.load(Ordering::SeqCst) {
        return Err("会话已停止".to_string());
    }
    Ok(())
}
