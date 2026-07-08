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
    allow_image_generate: bool,
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

    /// 注册一次插件脚本会话。返回给子进程的只有 localhost endpoint（基础地址）与一次性 token。
    /// 子进程经 SDK invokeScriptBridge 拼具体路径（/llm/chat、/image/generate）。
    pub fn register_session(
        &self,
        plugin_id: &str,
        api_base: Option<String>,
        auth_token: Option<String>,
        allow_llm_chat: bool,
        allow_image_generate: bool,
        ttl: Duration,
    ) -> Result<Option<PluginBridgeEnv>, String> {
        let api_base = api_base.unwrap_or_default().trim().trim_end_matches('/').to_string();
        let auth_token = auth_token.unwrap_or_default().trim().to_string();
        if api_base.is_empty() && auth_token.is_empty() && !allow_llm_chat && !allow_image_generate {
            return Ok(None);
        }
        let endpoint = self.ensure_server()?;
        let token = self.issue_token(plugin_id);
        let session = BridgeSession {
            plugin_id: plugin_id.to_string(),
            api_base,
            auth_token,
            allow_llm_chat,
            allow_image_generate,
            expires_at: Instant::now() + ttl,
        };
        self.inner
            .sessions
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .insert(token.clone(), session);
        // url 现在返回基础 endpoint（不含路径后缀），由 SDK 拼具体路由。
        Ok(Some(PluginBridgeEnv {
            url: endpoint,
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
    // 按路由分发 HTTP method：GET /v1/models 允许（供第三方 SDK 连通性探测），
    // 其余路由保持仅 POST。先校验 method 再校验 token，避免对错误 method 暴露鉴权细节。
    let path = request.path.as_str();
    let is_get_models = request.method == "GET" && path == "/v1/models";
    if !is_get_models && request.method != "POST" {
        return Err((404, "not_found", "插件本地桥仅支持 POST 请求（GET 仅 /v1/models）".to_string()));
    }
    let token = extract_token(&request.headers)
        .ok_or_else(|| (401, "unauthorized", "缺少插件桥 token".to_string()))?;
    let session = {
        let mut sessions = inner.sessions.lock().unwrap_or_else(|poison| poison.into_inner());
        sessions.retain(|_, session| session.expires_at > Instant::now());
        sessions.get(&token).cloned()
    }
    .ok_or_else(|| (401, "unauthorized", "插件桥 token 无效或已过期".to_string()))?;

    match path {
        // 灵坊自有形状（SDK 内部用）：返回 {content} / {images} 包装。
        "/llm/chat" => route_llm_chat(&session, request.body),
        "/image/generate" => route_image_generate(&session, request.body),
        // OpenAI 兼容形状（第三方 SDK 直连用）：透传 relay 完整响应，不包装。
        "/v1/chat/completions" if request.method == "POST" => route_v1_chat_completions(&session, request.body),
        "/v1/images/generations" if request.method == "POST" => route_v1_images_generations(&session, request.body),
        "/v1/models" if request.method == "GET" => route_v1_models(),
        other => Err((404, "not_found", format!("插件本地桥不支持的路由：{other}"))),
    }
}

/// 处理 llm.chat：转发到平台 relay /api/relay/v1/chat/completions，返回 {content}。
fn route_llm_chat(session: &BridgeSession, body_bytes: Vec<u8>) -> Result<Value, (u16, &'static str, String)> {
    if !session.allow_llm_chat {
        return Err((403, "capability_denied", "插件未声明 llm.chat 能力".to_string()));
    }
    if session.api_base.is_empty() || session.auth_token.is_empty() {
        return Err((401, "unauthorized", "缺少后端地址或登录凭证，无法调用平台 LLM".to_string()));
    }

    let body: Value = serde_json::from_slice(&body_bytes)
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
    let client = blocking_client();
    let resp = client
        .post(url)
        .header("Content-Type", "application/json")
        .header("X-Client", "desktop-plugin")
        .bearer_auth(&session.auth_token)
        .json(&relay_body)
        .send()
        .map_err(|error| (502, "relay_request_failed", format!("平台 LLM 请求失败：{error}")))?;
    let data = relay_response_json(resp)?;
    let content = extract_chat_content(&data);
    Ok(json!({ "content": content }))
}

/// 处理 image.generate：转发到平台 relay /api/relay/v1/images/generations，返回 {images:[...]}。
fn route_image_generate(session: &BridgeSession, body_bytes: Vec<u8>) -> Result<Value, (u16, &'static str, String)> {
    if !session.allow_image_generate {
        return Err((403, "capability_denied", "插件未声明 image.generate 能力".to_string()));
    }
    if session.api_base.is_empty() || session.auth_token.is_empty() {
        return Err((401, "unauthorized", "缺少后端地址或登录凭证，无法调用平台生图".to_string()));
    }

    let body: Value = serde_json::from_slice(&body_bytes)
        .map_err(|error| (400, "bad_request", format!("JSON 解析失败：{error}")))?;
    let prompt = body
        .get("prompt")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| (400, "bad_request", "image.generate 缺少 prompt".to_string()))?
        .to_string();
    let model = match body.get("model").and_then(|value| value.as_str()) {
        Some("premium") => "premium",
        _ => "fast",
    };
    let n = body
        .get("n")
        .and_then(|value| value.as_u64())
        .unwrap_or(1)
        .clamp(1, 4) as u32;
    let size = body
        .get("size")
        .and_then(|value| value.as_str())
        .unwrap_or("1024x1024")
        .to_string();

    let relay_body = json!({
        "model": model,
        "prompt": prompt,
        "n": n,
        "size": size,
    });
    let url = format!("{}/api/relay/v1/images/generations", session.api_base.trim_end_matches('/'));
    let client = blocking_client();
    let resp = client
        .post(url)
        .header("Content-Type", "application/json")
        .header("X-Client", "desktop-plugin")
        .bearer_auth(&session.auth_token)
        .json(&relay_body)
        .send()
        .map_err(|error| (502, "relay_request_failed", format!("平台生图请求失败：{error}")))?;
    let data = relay_response_json(resp)?;
    let images = extract_image_urls(&data);
    Ok(json!({ "images": images }))
}

/// GET /v1/models：返回平台档位哨兵（fast/premium），供 openai SDK 连通性探测。
/// 复用任意有效 token 的会话即可（不泄密，故不要求具体 capability）。
fn route_v1_models() -> Result<Value, (u16, &'static str, String)> {
    Ok(json!({
        "object": "list",
        "data": [
            { "id": "fast", "object": "model", "created": 0, "owned_by": "lingfang" },
            { "id": "premium", "object": "model", "created": 0, "owned_by": "lingfang" },
        ]
    }))
}

/// POST /v1/chat/completions：OpenAI 兼容透传。
/// 与 route_llm_chat 的区别：**直接返回 relay 的完整 OpenAI 响应**（choices[].message），
/// 不再抽取成 {content}，以便第三方 openai SDK / @ai-sdk/openai 等直连消费。
/// gate 复用 allow_llm_chat（语义上仍是 llm.chat 能力）。
fn route_v1_chat_completions(
    session: &BridgeSession,
    body_bytes: Vec<u8>,
) -> Result<Value, (u16, &'static str, String)> {
    if !session.allow_llm_chat {
        return Err((403, "capability_denied", "插件未声明 llm.chat 能力".to_string()));
    }
    if session.api_base.is_empty() || session.auth_token.is_empty() {
        return Err((401, "unauthorized", "缺少后端地址或登录凭证，无法调用平台 LLM".to_string()));
    }

    let body: Value = serde_json::from_slice(&body_bytes)
        .map_err(|error| (400, "bad_request", format!("JSON 解析失败：{error}")))?;
    let messages = body
        .get("messages")
        .and_then(|value| value.as_array())
        .filter(|items| !items.is_empty())
        .cloned()
        .ok_or_else(|| (400, "bad_request", "/v1/chat/completions 缺少 messages".to_string()))?;
    // model 归一化为平台档位哨兵（上游 SDK 传 gpt-4o 等会被归一化）。
    let model = match body.get("model").and_then(|value| value.as_str()) {
        Some("premium") => "premium",
        _ => "fast",
    };

    // 仅转发桥关心的字段；丢弃 stream/temperature 等可能让 relay 困惑的开关（relay 固定非流式）。
    let relay_body = json!({
        "model": model,
        "messages": messages,
        "stream": false,
    });
    let url = format!("{}/api/relay/v1/chat/completions", session.api_base.trim_end_matches('/'));
    let client = blocking_client();
    let resp = client
        .post(url)
        .header("Content-Type", "application/json")
        .header("X-Client", "desktop-plugin")
        .bearer_auth(&session.auth_token)
        .json(&relay_body)
        .send()
        .map_err(|error| (502, "relay_request_failed", format!("平台 LLM 请求失败：{error}")))?;
    // 透传 relay 完整响应（不抽取 content）。
    relay_response_json(resp)
}

/// POST /v1/images/generations：OpenAI 兼容透传。
/// 与 route_image_generate 的区别：**直接返回 relay 的完整 OpenAI 响应**（{data:[{url|b64_json}]}），
/// 不再抽取成 {images}，以便第三方图像 SDK 直连消费。
/// gate 复用 allow_image_generate。
fn route_v1_images_generations(
    session: &BridgeSession,
    body_bytes: Vec<u8>,
) -> Result<Value, (u16, &'static str, String)> {
    if !session.allow_image_generate {
        return Err((403, "capability_denied", "插件未声明 image.generate 能力".to_string()));
    }
    if session.api_base.is_empty() || session.auth_token.is_empty() {
        return Err((401, "unauthorized", "缺少后端地址或登录凭证，无法调用平台生图".to_string()));
    }

    let body: Value = serde_json::from_slice(&body_bytes)
        .map_err(|error| (400, "bad_request", format!("JSON 解析失败：{error}")))?;
    let prompt = body
        .get("prompt")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| (400, "bad_request", "/v1/images/generations 缺少 prompt".to_string()))?
        .to_string();
    let model = match body.get("model").and_then(|value| value.as_str()) {
        Some("premium") => "premium",
        _ => "fast",
    };
    let n = body
        .get("n")
        .and_then(|value| value.as_u64())
        .unwrap_or(1)
        .clamp(1, 4) as u32;
    let size = body
        .get("size")
        .and_then(|value| value.as_str())
        .unwrap_or("1024x1024")
        .to_string();

    let relay_body = json!({
        "model": model,
        "prompt": prompt,
        "n": n,
        "size": size,
    });
    let url = format!("{}/api/relay/v1/images/generations", session.api_base.trim_end_matches('/'));
    let client = blocking_client();
    let resp = client
        .post(url)
        .header("Content-Type", "application/json")
        .header("X-Client", "desktop-plugin")
        .bearer_auth(&session.auth_token)
        .json(&relay_body)
        .send()
        .map_err(|error| (502, "relay_request_failed", format!("平台生图请求失败：{error}")))?;
    // 透传 relay 完整响应（不抽取 images）。
    relay_response_json(resp)
}

/// 构建带超时的 blocking client（llm/生图共用）。
fn blocking_client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .unwrap_or_else(|_| reqwest::blocking::Client::new())
}

/// 解析平台 relay 响应：非 2xx 抽取 {message|error} 友好报错；成功返回 JSON Value。
fn relay_response_json(resp: reqwest::blocking::Response) -> Result<Value, (u16, &'static str, String)> {
    let status = resp.status();
    let text = resp
        .text()
        .map_err(|error| (502, "relay_response_failed", format!("读取平台响应失败：{error}")))?;
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
    serde_json::from_str(&text)
        .map_err(|error| (502, "relay_response_invalid", format!("平台响应不是 JSON：{error}")))
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

/// 从 relay 生图响应抽取可直接展示的图片（url 或 data:base64）。
/// 上游响应形如 { data: [{ url | b64_json }] }（OpenAI 兼容）。
fn extract_image_urls(data: &Value) -> Vec<String> {
    data.get("data")
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    item.get("url")
                        .and_then(|value| value.as_str())
                        .map(|value| value.to_string())
                        .or_else(|| {
                            item.get("b64_json")
                                .and_then(|value| value.as_str())
                                .map(|value| format!("data:image/png;base64,{value}"))
                        })
                })
                .collect::<Vec<String>>()
        })
        .unwrap_or_default()
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
    fn extract_images_from_url_and_b64() {
        // url 形态
        let url_resp = json!({ "data": [{ "url": "https://example.com/a.png" }] });
        assert_eq!(extract_image_urls(&url_resp), vec!["https://example.com/a.png".to_string()]);
        // b64_json 形态：转 data:base64
        let b64_resp = json!({ "data": [{ "b64_json": "AAAA" }] });
        assert_eq!(extract_image_urls(&b64_resp), vec!["data:image/png;base64,AAAA".to_string()]);
        // 多张
        let multi = json!({ "data": [{ "url": "https://x/1.png" }, { "url": "https://x/2.png" }] });
        assert_eq!(extract_image_urls(&multi).len(), 2);
        // 缺 data
        let empty = json!({});
        assert!(extract_image_urls(&empty).is_empty());
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

    #[test]
    fn v1_models_returns_fast_and_premium() {
        let data = route_v1_models().expect("/v1/models 应返回模型列表");
        let ids: Vec<&str> = data
            .get("data")
            .and_then(|value| value.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.get("id").and_then(|value| value.as_str()))
                    .collect()
            })
            .unwrap_or_default();
        assert_eq!(ids, vec!["fast", "premium"]);
    }

    /// 构造一个空的 BridgeState + 带有效 token 的会话，用于 route_request 分发测试。
    fn route_with_session(method: &str, path: &str, allow_llm: bool, allow_image: bool) -> Result<Value, (u16, &'static str, String)> {
        let bridge = PluginLlmBridge::new();
        // 注入一个会话：用公开的 register_session 需要 api_base/auth_token，但 route_request
        // 只读 sessions map。这里走 ensure_server + 直接构造 session 的最小路径不便（私有），
        // 故改用一个 token 走 register_session（即便后端凭证为空，路由分发在 capability/凭证
        // 校验前就能被 method/404 拦截，足以覆盖本测试关心的分发逻辑）。
        let _env = bridge.register_session(
            "test-plugin",
            Some("http://127.0.0.1:0".to_string()),
            Some("dummy".to_string()),
            allow_llm,
            allow_image,
            Duration::from_secs(60),
        );
        // 取出刚注册的 token（register_session 返回 Result<Option<PluginBridgeEnv>, String>）。
        let env = _env.expect("register_session 应 Ok").expect("register_session 应返回桥环境");
        let mut headers = HashMap::new();
        headers.insert("x-lingfang-plugin-token".to_string(), env.token);
        let request = HttpRequest {
            method: method.to_string(),
            path: path.to_string(),
            headers,
            body: Vec::new(),
        };
        route_request(&bridge.inner, request)
    }

    #[test]
    fn route_request_rejects_get_on_legacy_chat_route() {
        // GET /llm/chat 不在允许的 GET 名单（只有 /v1/models 允许 GET），应被 method 守卫拒绝。
        let result = route_with_session("GET", "/llm/chat", true, false);
        assert!(result.is_err());
        let (status, code, _) = result.unwrap_err();
        assert_eq!(status, 404);
        assert_eq!(code, "not_found");
    }

    #[test]
    fn route_request_allows_get_v1_models() {
        // GET /v1/models 应放行并返回模型列表（不依赖 capability）。
        let result = route_with_session("GET", "/v1/models", false, false);
        let data = result.expect("GET /v1/models 应成功");
        let ids: Vec<&str> = data
            .get("data")
            .and_then(|value| value.as_array())
            .map(|items| items.iter().filter_map(|item| item.get("id").and_then(|v| v.as_str())).collect())
            .unwrap_or_default();
        assert_eq!(ids, vec!["fast", "premium"]);
    }

    #[test]
    fn route_request_v1_chat_denied_without_llm_capability() {
        // 未声明 llm.chat（allow_llm=false）时，POST /v1/chat/completions 应 403 capability_denied。
        // 提供有效 token 但 body 缺 messages 也会先命中 capability gate（gate 在 body 校验前）。
        let bridge = PluginLlmBridge::new();
        let env = bridge
            .register_session("test-plugin", Some("http://127.0.0.1:0".to_string()), Some("dummy".to_string()), false, false, Duration::from_secs(60))
            .expect("register_session 应 Ok").expect("register_session 应返回桥环境");
        let mut headers = HashMap::new();
        headers.insert("x-lingfang-plugin-token".to_string(), env.token);
        let request = HttpRequest {
            method: "POST".to_string(),
            path: "/v1/chat/completions".to_string(),
            headers,
            body: b"{\"model\":\"gpt-4o\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}".to_vec(),
        };
        let result = route_request(&bridge.inner, request);
        assert!(result.is_err());
        let (status, code, _) = result.unwrap_err();
        assert_eq!(status, 403);
        assert_eq!(code, "capability_denied");
    }

    #[test]
    fn route_request_v1_images_denied_without_image_capability() {
        // 未声明 image.generate 时，POST /v1/images/generations 应 403 capability_denied。
        let bridge = PluginLlmBridge::new();
        let env = bridge
            .register_session("test-plugin", Some("http://127.0.0.1:0".to_string()), Some("dummy".to_string()), true, false, Duration::from_secs(60))
            .expect("register_session 应 Ok").expect("register_session 应返回桥环境");
        let mut headers = HashMap::new();
        headers.insert("x-lingfang-plugin-token".to_string(), env.token);
        let request = HttpRequest {
            method: "POST".to_string(),
            path: "/v1/images/generations".to_string(),
            headers,
            body: b"{\"model\":\"dall-e-3\",\"prompt\":\"cat\"}".to_vec(),
        };
        let result = route_request(&bridge.inner, request);
        assert!(result.is_err());
        let (status, code, _) = result.unwrap_err();
        assert_eq!(status, 403);
        assert_eq!(code, "capability_denied");
    }

    #[test]
    fn route_request_unknown_path_is_404() {
        // 未知路径即便 method 正确也应 404。
        let result = route_with_session("POST", "/v1/unknown", true, true);
        assert!(result.is_err());
        let (status, code, _) = result.unwrap_err();
        assert_eq!(status, 404);
        assert_eq!(code, "not_found");
    }
}