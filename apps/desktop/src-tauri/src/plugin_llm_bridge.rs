//! 插件脚本 LLM 本地桥。
//!
//! 目标：让 Node.js / Python 独立进程插件能调用平台 Relay，同时不把用户 JWT 或平台密钥暴露给脚本。
//! 脚本只拿 localhost URL + 一次性 token；真正的后端地址和登录态保存在宿主内存里。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug)]
struct BridgeSession {
    plugin_id: String,
    api_base: String,
    auth_token: String,
    allow_llm_chat: bool,
    expires_at: Instant,
}

#[derive(Default)]
struct BridgeState {
    endpoint: Mutex<Option<String>>,
    sessions: Mutex<HashMap<String, BridgeSession>>,
    counter: AtomicU64,
}

#[derive(Clone, Default)]
pub struct PluginLlmBridge {
    inner: Arc<BridgeState>,
}

#[derive(Clone, Debug)]
pub struct PluginBridgeEnv {
    pub url: String,
    pub token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BridgeError<'a> {
    error: &'a str,
    message: String,
}

impl PluginLlmBridge {
    pub fn new() -> Self {
        Self::default()
    }

    /// 注册一次插件脚本会话。返回给子进程的只有 localhost URL 与一次性 token。
    pub fn register_session(
        &self,
        plugin_id: &str,
        api_base: Option<String>,
        auth_token: Option<String>,
        allow_llm_chat: bool,
        ttl: Duration,
    ) -> Result<Option<PluginBridgeEnv>, String> {
        let api_base = api_base.unwrap_or_default().trim().trim_end_matches('/').to_string();
        let auth_token = auth_token.unwrap_or_default().trim().to_string();
        if api_base.is_empty() && auth_token.is_empty() && !allow_llm_chat {
            return Ok(None);
        }
        let endpoint = self.ensure_server()?;
        let token = self.issue_token(plugin_id);
        let session = BridgeSession {
            plugin_id: plugin_id.to_string(),
            api_base,
            auth_token,
            allow_llm_chat,
            expires_at: Instant::now() + ttl,
        };
        self.inner
            .sessions
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .insert(token.clone(), session);
        Ok(Some(PluginBridgeEnv {
            url: format!("{endpoint}/llm/chat"),
            token,
        }))
    }

    pub fn revoke_token(&self, token: &str) {
        self.inner
            .sessions
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .remove(token);
    }

    pub fn revoke_plugin(&self, plugin_id: &str) {
        self.inner
            .sessions
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .retain(|_, session| session.plugin_id != plugin_id);
    }

    fn ensure_server(&self) -> Result<String, String> {
        if let Some(endpoint) = self
            .inner
            .endpoint
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone()
        {
            return Ok(endpoint);
        }

        let listener = TcpListener::bind("127.0.0.1:0")
            .map_err(|error| format!("启动插件 LLM 本地桥失败：{error}"))?;
        let addr = listener
            .local_addr()
            .map_err(|error| format!("读取插件 LLM 本地桥地址失败：{error}"))?;
        let endpoint = format!("http://{addr}");
        {
            let mut guard = self
                .inner
                .endpoint
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            if let Some(existing) = guard.clone() {
                return Ok(existing);
            }
            *guard = Some(endpoint.clone());
        }

        let inner = Arc::clone(&self.inner);
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let inner = Arc::clone(&inner);
                thread::spawn(move || handle_connection(inner, stream));
            }
        });
        Ok(endpoint)
    }

    fn issue_token(&self, plugin_id: &str) -> String {
        let seq = self.inner.counter.fetch_add(1, Ordering::SeqCst);
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let mut hasher = Sha256::new();
        hasher.update(plugin_id.as_bytes());
        hasher.update(now.to_string().as_bytes());
        hasher.update(std::process::id().to_string().as_bytes());
        hasher.update(seq.to_string().as_bytes());
        format!("lfpb_{}", hex_lower(&hasher.finalize()))
    }
}

fn handle_connection(inner: Arc<BridgeState>, mut stream: TcpStream) {
    let response = match read_request(&mut stream).and_then(|request| route_request(&inner, request)) {
        Ok(body) => http_json(200, &body),
        Err((status, code, message)) => http_json(status, &json!(BridgeError { error: code, message })),
    };
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

struct HttpRequest {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

fn read_request(stream: &mut TcpStream) -> Result<HttpRequest, (u16, &'static str, String)> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(15)));
    let mut raw = Vec::new();
    let mut buf = [0u8; 4096];
    let header_end = loop {
        let n = stream
            .read(&mut buf)
            .map_err(|error| (400, "bad_request", format!("读取请求失败：{error}")))?;
        if n == 0 {
            return Err((400, "bad_request", "请求为空".to_string()));
        }
        raw.extend_from_slice(&buf[..n]);
        if raw.len() > 1024 * 1024 {
            return Err((413, "payload_too_large", "请求体过大".to_string()));
        }
        if let Some(pos) = find_header_end(&raw) {
            break pos;
        }
    };

    let header_text = String::from_utf8_lossy(&raw[..header_end]).to_string();
    let mut lines = header_text.split("\r\n");
    let first = lines.next().unwrap_or_default();
    let mut parts = first.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let path = parts.next().unwrap_or_default().to_string();
    let mut headers = HashMap::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }
    let content_length = headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    if content_length > 1024 * 1024 {
        return Err((413, "payload_too_large", "请求体过大".to_string()));
    }
    let body_start = header_end + 4;
    let mut body = raw.get(body_start..).unwrap_or_default().to_vec();
    while body.len() < content_length {
        let n = stream
            .read(&mut buf)
            .map_err(|error| (400, "bad_request", format!("读取请求体失败：{error}")))?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&buf[..n]);
    }
    body.truncate(content_length);
    Ok(HttpRequest { method, path, headers, body })
}

fn find_header_end(raw: &[u8]) -> Option<usize> {
    raw.windows(4).position(|window| window == b"\r\n\r\n")
}

fn route_request(
    inner: &Arc<BridgeState>,
    request: HttpRequest,
) -> Result<Value, (u16, &'static str, String)> {
    if request.method != "POST" || request.path != "/llm/chat" {
        return Err((404, "not_found", "插件 LLM 本地桥仅支持 POST /llm/chat".to_string()));
    }
    let token = extract_token(&request.headers)
        .ok_or_else(|| (401, "unauthorized", "缺少插件桥 token".to_string()))?;
    let session = {
        let mut sessions = inner.sessions.lock().unwrap_or_else(|poison| poison.into_inner());
        sessions.retain(|_, session| session.expires_at > Instant::now());
        sessions.get(&token).cloned()
    }
    .ok_or_else(|| (401, "unauthorized", "插件桥 token 无效或已过期".to_string()))?;

    if !session.allow_llm_chat {
        return Err((403, "capability_denied", "插件未声明 llm.chat 能力".to_string()));
    }
    if session.api_base.is_empty() || session.auth_token.is_empty() {
        return Err((401, "unauthorized", "缺少后端地址或登录凭证，无法调用平台 LLM".to_string()));
    }

    let body: Value = serde_json::from_slice(&request.body)
        .map_err(|error| (400, "bad_request", format!("JSON 解析失败：{error}")))?;
    let messages = body
        .get("messages")
        .and_then(|value| value.as_array())
        .filter(|items| !items.is_empty())
        .cloned()
        .ok_or_else(|| (400, "bad_request", "llm.chat 缺少 messages".to_string()))?;
    let model = match body.get("model").and_then(|value| value.as_str()) {
        Some("premium") => "premium",
        _ => "fast",
    };

    let relay_body = json!({
        "model": model,
        "messages": messages,
        "stream": false,
    });
    let url = format!("{}/api/relay/v1/chat/completions", session.api_base.trim_end_matches('/'));
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|error| (500, "bridge_init_failed", format!("初始化平台请求失败：{error}")))?;
    let resp = client
        .post(url)
        .header("Content-Type", "application/json")
        .header("X-Client", "desktop-plugin")
        .bearer_auth(&session.auth_token)
        .json(&relay_body)
        .send()
        .map_err(|error| (502, "relay_request_failed", format!("平台 LLM 请求失败：{error}")))?;
    let status = resp.status();
    let text = resp
        .text()
        .map_err(|error| (502, "relay_response_failed", format!("读取平台 LLM 响应失败：{error}")))?;
    if !status.is_success() {
        let detail = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|value| {
                value.get("message")
                    .or_else(|| value.get("error"))
                    .and_then(|value| value.as_str())
                    .map(|value| value.to_string())
            })
            .unwrap_or_else(|| format!("HTTP {}", status.as_u16()));
        return Err((status.as_u16(), "relay_error", detail));
    }
    let data: Value = serde_json::from_str(&text)
        .map_err(|error| (502, "relay_response_invalid", format!("平台 LLM 响应不是 JSON：{error}")))?;
    let content = extract_chat_content(&data);
    Ok(json!({ "content": content }))
}

fn extract_token(headers: &HashMap<String, String>) -> Option<String> {
    if let Some(value) = headers.get("x-lingfang-plugin-token") {
        return Some(value.trim().to_string());
    }
    headers
        .get("authorization")
        .and_then(|value| value.strip_prefix("Bearer ").or_else(|| value.strip_prefix("bearer ")))
        .map(|value| value.trim().to_string())
}

fn extract_chat_content(data: &Value) -> String {
    data.get("choices")
        .and_then(|value| value.as_array())
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(|content| content.as_str())
        .or_else(|| data.get("content").and_then(|content| content.as_str()))
        .or_else(|| data.get("output_text").and_then(|content| content.as_str()))
        .unwrap_or_default()
        .to_string()
}

fn http_json(status: u16, body: &Value) -> String {
    let payload = serde_json::to_string(body).unwrap_or_else(|_| "{}".to_string());
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        413 => "Payload Too Large",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        _ => "Error",
    };
    format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json; charset=utf-8\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
        payload.as_bytes().len()
    )
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_content_from_openai_shape() {
        let data = json!({ "choices": [{ "message": { "content": "ok" } }] });
        assert_eq!(extract_chat_content(&data), "ok");
    }

    #[test]
    fn token_can_be_read_from_bearer_or_custom_header() {
        let mut headers = HashMap::new();
        headers.insert("authorization".to_string(), "Bearer abc".to_string());
        assert_eq!(extract_token(&headers).as_deref(), Some("abc"));
        headers.clear();
        headers.insert("x-lingfang-plugin-token".to_string(), "xyz".to_string());
        assert_eq!(extract_token(&headers).as_deref(), Some("xyz"));
    }
}