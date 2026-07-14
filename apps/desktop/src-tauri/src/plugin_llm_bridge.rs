//! 插件脚本 LLM 本地桥。
//!
//! 目标：让 Node.js / Python 独立进程插件能调用平台 Relay，同时不把用户 JWT 或平台密钥暴露给脚本。
//! 脚本只拿 localhost URL + 进程会话 token；真正的后端地址和登录态保存在宿主内存里。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use uuid::Uuid;

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};

// 请求体上限：image.edit 携带 base64 参考图（JSON），单次可达数十 MB；localhost 桥且 token 鉴权，放宽到 64 MiB。
const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;

type BridgeResult<T> = Result<T, BridgeError>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PluginBridgeClientSource {
    PluginRuntime,
    PluginTest,
}

impl PluginBridgeClientSource {
    fn x_client(self) -> &'static str {
        match self {
            Self::PluginRuntime => "desktop-plugin",
            Self::PluginTest => "desktop-plugin-test",
        }
    }
}

#[derive(Clone, Debug)]
struct BridgeSession {
    plugin_id: String,
    api_base: String,
    auth_token: String,
    allow_llm_chat: bool,
    allow_image_generate: bool,
    allow_image_edit: bool,
    client_source: PluginBridgeClientSource,
    expires_at: Instant,
}

#[derive(Default)]
struct BridgeState {
    endpoint: Mutex<Option<String>>,
    sessions: Mutex<HashMap<String, BridgeSession>>,
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

#[derive(Clone, Debug, PartialEq, Eq)]
struct BridgeError {
    status: u16,
    code: String,
    message: String,
    request_id: Option<String>,
}

impl BridgeError {
    fn new(status: u16, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            status,
            code: code.into(),
            message: message.into(),
            request_id: None,
        }
    }

    fn with_request_id(mut self, request_id: impl Into<String>) -> Self {
        self.request_id = Some(request_id.into());
        self
    }

    fn ensure_request_id(mut self) -> Self {
        if self.request_id.is_none() {
            self.request_id = Some(Uuid::new_v4().to_string());
        }
        self
    }

    fn response_body(&self, openai_compatible: bool) -> Value {
        if openai_compatible {
            json!({
                "error": {
                    "message": self.message,
                    "type": self.code,
                    "param": null,
                    "code": self.code,
                },
                "code": self.code,
                "message": self.message,
                "status": self.status,
                "requestId": self.request_id,
            })
        } else {
            json!({
                "code": self.code,
                "message": self.message,
                "status": self.status,
                "requestId": self.request_id,
            })
        }
    }
}

pub struct PluginBridgeTokenGuard<'a> {
    bridge: &'a PluginLlmBridge,
    token: Option<String>,
}

impl Drop for PluginBridgeTokenGuard<'_> {
    fn drop(&mut self) {
        if let Some(token) = self.token.take() {
            self.bridge.revoke_token(&token);
        }
    }
}

impl PluginLlmBridge {
    pub fn new() -> Self {
        Self::default()
    }

    /// 注册一次插件脚本会话。返回给子进程的只有 localhost endpoint（基础地址）与会话 token。
    /// 子进程经 SDK invokeScriptBridge 拼具体路径（/llm/chat、/image/generate）。
    pub fn register_session(
        &self,
        plugin_id: &str,
        api_base: Option<String>,
        auth_token: Option<String>,
        allow_llm_chat: bool,
        allow_image_generate: bool,
        allow_image_edit: bool,
        client_source: PluginBridgeClientSource,
        ttl: Duration,
    ) -> Result<Option<PluginBridgeEnv>, String> {
        let api_base = api_base
            .unwrap_or_default()
            .trim()
            .trim_end_matches('/')
            .to_string();
        let auth_token = auth_token.unwrap_or_default().trim().to_string();
        if !allow_llm_chat && !allow_image_generate && !allow_image_edit {
            return Ok(None);
        }
        let endpoint = self.ensure_server()?;
        let token = issue_token();
        let session = BridgeSession {
            plugin_id: plugin_id.to_string(),
            api_base,
            auth_token,
            allow_llm_chat,
            allow_image_generate,
            allow_image_edit,
            client_source,
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

    pub fn revoke_plugin_except(&self, plugin_id: &str, keep_token: Option<&str>) {
        self.inner
            .sessions
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .retain(|token, session| {
                session.plugin_id != plugin_id || keep_token == Some(token.as_str())
            });
    }

    pub fn revoke_all(&self) {
        self.inner
            .sessions
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clear();
    }

    pub fn revoke_on_drop<'a>(&'a self, token: Option<String>) -> PluginBridgeTokenGuard<'a> {
        PluginBridgeTokenGuard {
            bridge: self,
            token,
        }
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
}

fn issue_token() -> String {
    format!("lfpb_{}", Uuid::new_v4().simple())
}

#[tauri::command]
pub fn revoke_all_plugin_bridge_sessions(bridge: tauri::State<'_, PluginLlmBridge>) {
    bridge.revoke_all();
}

fn handle_connection(inner: Arc<BridgeState>, mut stream: TcpStream) {
    let response = match read_request(&mut stream) {
        Ok(request) => {
            let openai_compatible = request.path.starts_with("/v1/");
            match route_request(&inner, request) {
                Ok(body) => http_json(200, &body),
                Err(error) => {
                    let error = error.ensure_request_id();
                    http_json(error.status, &error.response_body(openai_compatible))
                }
            }
        }
        Err(error) => {
            let error = error.ensure_request_id();
            http_json(error.status, &error.response_body(false))
        }
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

fn read_request(stream: &mut TcpStream) -> BridgeResult<HttpRequest> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(15)));
    let mut raw = Vec::new();
    let mut buf = [0u8; 4096];
    let header_end = loop {
        let n = stream
            .read(&mut buf)
            .map_err(|_| BridgeError::new(400, "bad_request", "读取插件桥请求失败"))?;
        if n == 0 {
            return Err(BridgeError::new(400, "bad_request", "请求为空"));
        }
        raw.extend_from_slice(&buf[..n]);
        if raw.len() > 1024 * 1024 {
            return Err(BridgeError::new(413, "payload_too_large", "请求体过大"));
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
    if content_length > MAX_BODY_BYTES {
        return Err(BridgeError::new(413, "payload_too_large", "请求体过大"));
    }
    let body_start = header_end + 4;
    let mut body = raw.get(body_start..).unwrap_or_default().to_vec();
    while body.len() < content_length {
        let n = stream
            .read(&mut buf)
            .map_err(|_| BridgeError::new(400, "bad_request", "读取插件桥请求体失败"))?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&buf[..n]);
    }
    body.truncate(content_length);
    Ok(HttpRequest {
        method,
        path,
        headers,
        body,
    })
}

fn find_header_end(raw: &[u8]) -> Option<usize> {
    raw.windows(4).position(|window| window == b"\r\n\r\n")
}

fn route_request(inner: &Arc<BridgeState>, request: HttpRequest) -> BridgeResult<Value> {
    // 按路由分发 HTTP method：GET /v1/models 允许（供第三方 SDK 连通性探测），
    // 其余路由保持仅 POST。先校验 method 再校验 token，避免对错误 method 暴露鉴权细节。
    let path = request.path.as_str();
    let is_get_models = request.method == "GET" && path == "/v1/models";
    if !is_get_models && request.method != "POST" {
        return Err(BridgeError::new(
            404,
            "not_found",
            "插件本地桥仅支持 POST 请求（GET 仅 /v1/models）",
        ));
    }
    let token = extract_token(&request.headers)
        .ok_or_else(|| BridgeError::new(401, "unauthorized", "缺少插件桥 token"))?;
    let session = {
        let mut sessions = inner
            .sessions
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        sessions.retain(|_, session| session.expires_at > Instant::now());
        sessions.get(&token).cloned()
    }
    .ok_or_else(|| BridgeError::new(401, "unauthorized", "插件桥 token 无效或已过期"))?;

    match path {
        // 灵坊自有形状（SDK 内部用）：返回 {content} / {images} 包装。
        "/llm/chat" => route_llm_chat(&session, request.body),
        "/image/generate" => route_image_generate(&session, request.body),
        "/image/edit" => route_image_edit(&session, request.body),
        // OpenAI 兼容形状（第三方 SDK 直连用）：透传 relay 完整响应，不包装。
        "/v1/chat/completions" if request.method == "POST" => {
            route_v1_chat_completions(&session, request.body)
        }
        "/v1/images/generations" if request.method == "POST" => {
            route_v1_images_generations(&session, request.body)
        }
        "/v1/models" if request.method == "GET" => route_v1_models(&session),
        other => Err(BridgeError::new(
            404,
            "not_found",
            format!("插件本地桥不支持的路由：{other}"),
        )),
    }
}

/// 处理 llm.chat：转发到平台 relay /api/relay/v1/chat/completions，返回 {content}。
fn route_llm_chat(session: &BridgeSession, body_bytes: Vec<u8>) -> BridgeResult<Value> {
    if !session.allow_llm_chat {
        return Err(BridgeError::new(
            403,
            "capability_denied",
            "插件未声明 llm.chat 能力",
        ));
    }
    ensure_platform_session(session, "LLM")?;

    let body: Value = serde_json::from_slice(&body_bytes)
        .map_err(|_| BridgeError::new(400, "bad_request", "请求体不是有效 JSON"))?;
    let messages = body
        .get("messages")
        .and_then(|value| value.as_array())
        .filter(|items| !items.is_empty())
        .cloned()
        .ok_or_else(|| BridgeError::new(400, "bad_request", "llm.chat 缺少 messages"))?;
    reject_streaming(&body)?;
    let model = parse_model_tier(&body)?;

    let relay_body = json!({
        "model": model,
        "messages": messages,
        "stream": false,
    });
    let data = relay_post_json(session, "/api/relay/v1/chat/completions", &relay_body)?;
    let content = extract_chat_content(&data);
    Ok(json!({ "content": content }))
}

/// 处理 image.generate：转发到平台 relay /api/relay/v1/images/generations，返回 {images:[...]}。
fn route_image_generate(session: &BridgeSession, body_bytes: Vec<u8>) -> BridgeResult<Value> {
    if !session.allow_image_generate {
        return Err(BridgeError::new(
            403,
            "capability_denied",
            "插件未声明 image.generate 能力",
        ));
    }
    ensure_platform_session(session, "生图")?;

    let body: Value = serde_json::from_slice(&body_bytes)
        .map_err(|_| BridgeError::new(400, "bad_request", "请求体不是有效 JSON"))?;
    let prompt = body
        .get("prompt")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| BridgeError::new(400, "bad_request", "image.generate 缺少 prompt"))?
        .to_string();
    let model = parse_model_tier(&body)?;
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
    let data = relay_post_json(session, "/api/relay/v1/images/generations", &relay_body)?;
    let images = extract_image_urls(&data);
    Ok(json!({ "images": images }))
}

/// 处理 image.edit：参考图 + prompt，重建 multipart 转发到平台 relay
/// /api/relay/v1/images/edits（multipart 透传，按张计费），返回 {images:[...]}。
///
/// 与 image.generate 的区别：携带参考图（image[]），走 relay 的 images/edits 透传。
/// 上游 model 名不由此处填写——桥只持有平台档位 fast/premium，由 relay 侧按命中渠道
/// 注入上游 model（与 images/generations 对齐）。tier 经 query 传 relay 供计费/选渠道。
fn route_image_edit(session: &BridgeSession, body_bytes: Vec<u8>) -> BridgeResult<Value> {
    if !session.allow_image_edit {
        return Err(BridgeError::new(
            403,
            "capability_denied",
            "插件未声明 image.edit 能力",
        ));
    }
    ensure_platform_session(session, "图片编辑")?;

    let body: Value = serde_json::from_slice(&body_bytes)
        .map_err(|_| BridgeError::new(400, "bad_request", "请求体不是有效 JSON"))?;
    let prompt = body
        .get("prompt")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| BridgeError::new(400, "bad_request", "image.edit 缺少 prompt"))?
        .to_string();
    let images = body
        .get("images")
        .and_then(|value| value.as_array())
        .filter(|items| !items.is_empty())
        .ok_or_else(|| {
            BridgeError::new(400, "bad_request", "image.edit 缺少 images（至少 1 张参考图）")
        })?;
    let tier = parse_model_tier(&body)?;
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

    // base64 → 原始字节。参考图可能很大，故 read_request 的 body 上限已放宽（见 MAX_BODY_BYTES）。
    let mut decoded: Vec<(String, String, Vec<u8>)> = Vec::with_capacity(images.len());
    for (index, item) in images.iter().enumerate() {
        let filename = sanitize_filename(
            item.get("filename").and_then(|value| value.as_str()).unwrap_or("image"),
        );
        let mime = item
            .get("mimeType")
            .and_then(|value| value.as_str())
            .or_else(|| item.get("mime_type").and_then(|value| value.as_str()))
            .unwrap_or("image/jpeg")
            .to_string();
        let data_b64 = item
            .get("data")
            .and_then(|value| value.as_str())
            .ok_or_else(|| {
                BridgeError::new(
                    400,
                    "bad_request",
                    format!("image.edit 第 {index} 张图片缺少 data(base64)"),
                )
            })?;
        let bytes = BASE64_STANDARD
            .decode(data_b64.trim())
            .map_err(|_| {
                BridgeError::new(
                    400,
                    "bad_request",
                    format!("image.edit 第 {index} 张图片 data 不是合法 base64"),
                )
            })?;
        if bytes.is_empty() {
            return Err(BridgeError::new(
                400,
                "bad_request",
                format!("image.edit 第 {index} 张图片数据为空"),
            ));
        }
        decoded.push((filename, mime, bytes));
    }

    let (multipart_body, content_type) = build_image_edit_multipart(&prompt, &decoded, n, &size);
    let path = format!("/api/relay/v1/images/edits?model={tier}");
    let data = relay_post_raw(session, &path, &content_type, &multipart_body)?;
    let images_out = extract_image_urls(&data);
    if images_out.is_empty() {
        return Err(BridgeError::new(
            502,
            "relay_response_invalid",
            "平台未返回编辑后的图片",
        ));
    }
    Ok(json!({ "images": images_out }))
}

/// 构建 multipart/form-data 请求体（参考 OpenAI /v1/images/edits 形状）。
/// 不含 model 字段——由 relay 侧注入上游命中模型。
fn build_image_edit_multipart(
    prompt: &str,
    images: &[(String, String, Vec<u8>)],
    n: u32,
    size: &str,
) -> (Vec<u8>, String) {
    let boundary = "lfImgEdit7Q2v9sL3p0aZ";
    let mut body = Vec::new();
    push_text_part(&mut body, boundary, "prompt", prompt);
    for (filename, mime, data) in images {
        push_file_part(&mut body, boundary, filename, mime, data);
    }
    push_text_part(&mut body, boundary, "n", &n.to_string());
    push_text_part(&mut body, boundary, "size", size);
    push_text_part(&mut body, boundary, "response_format", "b64_json");
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    (body, format!("multipart/form-data; boundary={boundary}"))
}

fn push_text_part(body: &mut Vec<u8>, boundary: &str, name: &str, value: &str) {
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\nContent-Type: text/plain\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(value.as_bytes());
    body.extend_from_slice(b"\r\n");
}

fn push_file_part(body: &mut Vec<u8>, boundary: &str, filename: &str, mime: &str, data: &[u8]) {
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"image[]\"; filename=\"{filename}\"\r\nContent-Type: {mime}\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(data);
    body.extend_from_slice(b"\r\n");
}

/// 过滤文件名中的路径分隔符与特殊字符，防止 multipart 头注入。
fn sanitize_filename(raw: &str) -> String {
    let base = raw.split(['/', '\\']).last().unwrap_or(raw);
    let cleaned: String = base
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "image".to_string()
    } else {
        cleaned
    }
}

/// 转发原始字节（multipart）到平台 relay，返回解析后的 JSON。
/// 与 relay_post_json 的区别：携带自定义 Content-Type + 原始请求体；超时放宽到 10 分钟（图片编辑耗时高）。
fn relay_post_raw(
    session: &BridgeSession,
    path: &str,
    content_type: &str,
    body: &[u8],
) -> BridgeResult<Value> {
    let request_id = Uuid::new_v4().to_string();
    let url = format!("{}{}", session.api_base.trim_end_matches('/'), path);
    let response = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
        .unwrap_or_else(|_| reqwest::blocking::Client::new())
        .post(url)
        .header("Content-Type", content_type)
        .header("X-Client", session.client_source.x_client())
        .header("X-Request-Id", &request_id)
        .bearer_auth(&session.auth_token)
        .body(body.to_vec())
        .send()
        .map_err(|_| {
            BridgeError::new(502, "relay_request_failed", "无法连接平台模型服务，请稍后重试")
                .with_request_id(request_id.clone())
        })?;
    relay_response_json(response, &request_id)
}

/// GET /v1/models：透传当前团队实际可用的平台档位，供 OpenAI SDK 连通性探测。
fn route_v1_models(session: &BridgeSession) -> BridgeResult<Value> {
    ensure_platform_session(session, "模型列表")?;
    relay_get_json(session, "/api/relay/v1/models")
}

/// POST /v1/chat/completions：OpenAI 兼容透传。
/// 与 route_llm_chat 的区别：**直接返回 relay 的完整 OpenAI 响应**（choices[].message），
/// 不再抽取成 {content}，以便第三方 openai SDK / @ai-sdk/openai 等直连消费。
/// gate 复用 allow_llm_chat（语义上仍是 llm.chat 能力）。
fn route_v1_chat_completions(session: &BridgeSession, body_bytes: Vec<u8>) -> BridgeResult<Value> {
    if !session.allow_llm_chat {
        return Err(BridgeError::new(
            403,
            "capability_denied",
            "插件未声明 llm.chat 能力",
        ));
    }
    ensure_platform_session(session, "LLM")?;

    let body: Value = serde_json::from_slice(&body_bytes)
        .map_err(|_| BridgeError::new(400, "bad_request", "请求体不是有效 JSON"))?;
    let messages = body
        .get("messages")
        .and_then(|value| value.as_array())
        .filter(|items| !items.is_empty())
        .cloned()
        .ok_or_else(|| {
            BridgeError::new(400, "bad_request", "/v1/chat/completions 缺少 messages")
        })?;
    reject_streaming(&body)?;
    let model = parse_model_tier(&body)?;

    // 仅转发桥关心的字段；relay 固定非流式。
    let relay_body = json!({
        "model": model,
        "messages": messages,
        "stream": false,
    });
    // 透传 relay 完整响应（不抽取 content）。
    relay_post_json(session, "/api/relay/v1/chat/completions", &relay_body)
}

/// POST /v1/images/generations：OpenAI 兼容透传。
/// 与 route_image_generate 的区别：**直接返回 relay 的完整 OpenAI 响应**（{data:[{url|b64_json}]}），
/// 不再抽取成 {images}，以便第三方图像 SDK 直连消费。
/// gate 复用 allow_image_generate。
fn route_v1_images_generations(
    session: &BridgeSession,
    body_bytes: Vec<u8>,
) -> BridgeResult<Value> {
    if !session.allow_image_generate {
        return Err(BridgeError::new(
            403,
            "capability_denied",
            "插件未声明 image.generate 能力",
        ));
    }
    ensure_platform_session(session, "生图")?;

    let body: Value = serde_json::from_slice(&body_bytes)
        .map_err(|_| BridgeError::new(400, "bad_request", "请求体不是有效 JSON"))?;
    let prompt = body
        .get("prompt")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| BridgeError::new(400, "bad_request", "/v1/images/generations 缺少 prompt"))?
        .to_string();
    let model = parse_model_tier(&body)?;
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
    // 透传 relay 完整响应（不抽取 images）。
    relay_post_json(session, "/api/relay/v1/images/generations", &relay_body)
}

/// 构建带超时的 blocking client（llm/生图共用）。
fn blocking_client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .unwrap_or_else(|_| reqwest::blocking::Client::new())
}

fn ensure_platform_session(session: &BridgeSession, capability_name: &str) -> BridgeResult<()> {
    if session.api_base.is_empty() || session.auth_token.is_empty() {
        return Err(BridgeError::new(
            401,
            "unauthorized",
            format!("缺少平台登录凭证，无法调用{capability_name}"),
        ));
    }
    Ok(())
}

fn parse_model_tier(body: &Value) -> BridgeResult<&'static str> {
    match body.get("model") {
        None => Ok("fast"),
        Some(Value::String(model)) if model == "fast" => Ok("fast"),
        Some(Value::String(model)) if model == "premium" => Ok("premium"),
        Some(_) => Err(BridgeError::new(
            400,
            "unsupported_model",
            "model 仅支持 fast 或 premium",
        )),
    }
}

fn reject_streaming(body: &Value) -> BridgeResult<()> {
    match body.get("stream") {
        None | Some(Value::Bool(false)) => Ok(()),
        Some(Value::Bool(true)) => Err(BridgeError::new(
            400,
            "unsupported_streaming",
            "插件本地桥暂不支持流式响应",
        )),
        Some(_) => Err(BridgeError::new(400, "bad_request", "stream 必须是布尔值")),
    }
}

fn relay_post_json(session: &BridgeSession, path: &str, body: &Value) -> BridgeResult<Value> {
    let request_id = Uuid::new_v4().to_string();
    let url = format!("{}{}", session.api_base.trim_end_matches('/'), path);
    let response = blocking_client()
        .post(url)
        .header("Content-Type", "application/json")
        .header("X-Client", session.client_source.x_client())
        .header("X-Request-Id", &request_id)
        .bearer_auth(&session.auth_token)
        .json(body)
        .send()
        .map_err(|_| {
            BridgeError::new(
                502,
                "relay_request_failed",
                "无法连接平台模型服务，请稍后重试",
            )
            .with_request_id(request_id.clone())
        })?;
    relay_response_json(response, &request_id)
}

fn relay_get_json(session: &BridgeSession, path: &str) -> BridgeResult<Value> {
    let request_id = Uuid::new_v4().to_string();
    let url = format!("{}{}", session.api_base.trim_end_matches('/'), path);
    let response = blocking_client()
        .get(url)
        .header("X-Client", session.client_source.x_client())
        .header("X-Request-Id", &request_id)
        .bearer_auth(&session.auth_token)
        .send()
        .map_err(|_| {
            BridgeError::new(
                502,
                "relay_request_failed",
                "无法连接平台模型服务，请稍后重试",
            )
            .with_request_id(request_id.clone())
        })?;
    relay_response_json(response, &request_id)
}

/// 解析平台 relay 响应：保留产品错误码、状态、消息和 requestId，不透出供应商响应细节。
fn relay_response_json(
    resp: reqwest::blocking::Response,
    fallback_request_id: &str,
) -> BridgeResult<Value> {
    let status = resp.status();
    let text = resp.text().map_err(|_| {
        BridgeError::new(502, "relay_response_failed", "读取平台模型响应失败")
            .with_request_id(fallback_request_id)
    })?;
    if !status.is_success() {
        let product_error = serde_json::from_str::<Value>(&text).ok();
        let code = product_error
            .as_ref()
            .and_then(|value| value.get("code"))
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("relay_error");
        let message = product_error
            .as_ref()
            .and_then(|value| value.get("message"))
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("平台模型服务暂时不可用");
        let request_id = product_error
            .as_ref()
            .and_then(|value| value.get("requestId"))
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(fallback_request_id);
        return Err(
            BridgeError::new(status.as_u16(), code, plugin_safe_message(code, message))
                .with_request_id(request_id),
        );
    }
    serde_json::from_str(&text).map_err(|_| {
        BridgeError::new(502, "relay_response_invalid", "平台模型响应格式无效")
            .with_request_id(fallback_request_id)
    })
}

fn plugin_safe_message(code: &str, message: &str) -> String {
    match code {
        "internal" | "internal_error" | "upstream_llm_error" => {
            "平台模型服务暂时不可用".to_string()
        }
        "pricing_not_configured" => "平台模型服务尚未完成计费配置".to_string(),
        _ => message.to_string(),
    }
}

fn extract_token(headers: &HashMap<String, String>) -> Option<String> {
    if let Some(value) = headers.get("x-lingfang-plugin-token") {
        return Some(value.trim().to_string());
    }
    headers
        .get("authorization")
        .and_then(|value| {
            value
                .strip_prefix("Bearer ")
                .or_else(|| value.strip_prefix("bearer "))
        })
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn extract_content_from_openai_shape() {
        let data = json!({ "choices": [{ "message": { "content": "ok" } }] });
        assert_eq!(extract_chat_content(&data), "ok");
    }

    #[test]
    fn extract_images_from_url_and_b64() {
        // url 形态
        let url_resp = json!({ "data": [{ "url": "https://example.com/a.png" }] });
        assert_eq!(
            extract_image_urls(&url_resp),
            vec!["https://example.com/a.png".to_string()]
        );
        // b64_json 形态：转 data:base64
        let b64_resp = json!({ "data": [{ "b64_json": "AAAA" }] });
        assert_eq!(
            extract_image_urls(&b64_resp),
            vec!["data:image/png;base64,AAAA".to_string()]
        );
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
    fn bridge_token_uses_uuid_v4_randomness() {
        let first = issue_token();
        let second = issue_token();
        assert_ne!(first, second);
        let value = first.strip_prefix("lfpb_").expect("token 应保留桥前缀");
        let parsed = Uuid::parse_str(value).expect("token 主体应为 UUID");
        assert_eq!(parsed.get_version_num(), 4);
    }

    #[test]
    fn register_session_requires_manifest_ai_capability() {
        let bridge = PluginLlmBridge::new();
        let env = bridge
            .register_session(
                "no-ai",
                Some("https://platform.example".to_string()),
                Some("jwt".to_string()),
                false,
                false,
                false,
                PluginBridgeClientSource::PluginRuntime,
                Duration::from_secs(60),
            )
            .expect("无 AI capability 应正常返回");
        assert!(env.is_none());
        assert!(bridge
            .inner
            .sessions
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .is_empty());
    }

    #[test]
    fn token_guard_and_revoke_all_remove_sessions() {
        let bridge = PluginLlmBridge::new();
        let first = insert_test_session(&bridge, true, false);
        let second = insert_test_session(&bridge, false, true);
        {
            let _guard = bridge.revoke_on_drop(Some(first.clone()));
            assert!(bridge
                .inner
                .sessions
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .contains_key(&first));
        }
        let sessions = bridge
            .inner
            .sessions
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        assert!(!sessions.contains_key(&first));
        assert!(sessions.contains_key(&second));
        drop(sessions);
        bridge.revoke_all();
        assert!(bridge
            .inner
            .sessions
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .is_empty());
    }

    #[test]
    fn replacement_revokes_old_plugin_token_without_touching_new_or_other_plugin() {
        let bridge = PluginLlmBridge::new();
        let old = insert_test_session(&bridge, true, false);
        let current = insert_test_session(&bridge, true, false);
        let other = insert_test_session(&bridge, false, true);
        bridge
            .inner
            .sessions
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .get_mut(&other)
            .expect("测试 session 应存在")
            .plugin_id = "other-plugin".to_string();

        bridge.revoke_plugin_except("test-plugin", Some(&current));
        let sessions = bridge
            .inner
            .sessions
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        assert!(!sessions.contains_key(&old));
        assert!(sessions.contains_key(&current));
        assert!(sessions.contains_key(&other));
    }

    #[test]
    fn model_tier_defaults_to_fast_and_rejects_upstream_names() {
        assert_eq!(parse_model_tier(&json!({})).unwrap(), "fast");
        assert_eq!(
            parse_model_tier(&json!({ "model": "fast" })).unwrap(),
            "fast"
        );
        assert_eq!(
            parse_model_tier(&json!({ "model": "premium" })).unwrap(),
            "premium"
        );
        let error = parse_model_tier(&json!({ "model": "gpt-4o" })).unwrap_err();
        assert_eq!(error.status, 400);
        assert_eq!(error.code, "unsupported_model");
    }

    #[test]
    fn streaming_true_is_rejected_with_stable_code() {
        assert!(reject_streaming(&json!({})).is_ok());
        assert!(reject_streaming(&json!({ "stream": false })).is_ok());
        let error = reject_streaming(&json!({ "stream": true })).unwrap_err();
        assert_eq!(error.status, 400);
        assert_eq!(error.code, "unsupported_streaming");
    }

    #[test]
    fn openai_error_shape_keeps_nested_and_top_level_fields() {
        let error = BridgeError::new(402, "insufficient_balance", "团队额度不足")
            .with_request_id("req-123");
        let sdk = error.response_body(false);
        assert_eq!(sdk["code"], "insufficient_balance");
        assert_eq!(sdk["requestId"], "req-123");
        assert!(sdk.get("error").is_none());

        let openai = error.response_body(true);
        assert_eq!(openai["code"], "insufficient_balance");
        assert_eq!(openai["error"]["code"], "insufficient_balance");
        assert_eq!(openai["error"]["message"], "团队额度不足");
        assert_eq!(openai["requestId"], "req-123");
    }

    #[test]
    fn unsafe_internal_and_pricing_details_are_not_exposed_to_plugins() {
        assert_eq!(
            plugin_safe_message("internal", "relay 内部错误：database password=secret"),
            "平台模型服务暂时不可用"
        );
        assert_eq!(
            plugin_safe_message(
                "pricing_not_configured",
                "渠道模型未配置定价：private-upstream-model"
            ),
            "平台模型服务尚未完成计费配置"
        );
        assert_eq!(
            plugin_safe_message("insufficient_balance", "团队额度不足"),
            "团队额度不足"
        );
    }

    #[test]
    fn relay_forwards_test_source_and_preserves_product_error() {
        let (endpoint, request_rx) = spawn_relay_response(
            402,
            json!({
                "code": "insufficient_balance",
                "message": "团队额度不足",
                "requestId": "platform-request-id",
            }),
        );
        let session = BridgeSession {
            plugin_id: "test-plugin".to_string(),
            api_base: endpoint,
            auth_token: "jwt".to_string(),
            allow_llm_chat: true,
            allow_image_generate: false,
            allow_image_edit: false,
            client_source: PluginBridgeClientSource::PluginTest,
            expires_at: Instant::now() + Duration::from_secs(60),
        };
        let error = relay_post_json(&session, "/api/relay/v1/chat/completions", &json!({}))
            .expect_err("402 应保留为产品错误");
        assert_eq!(error.status, 402);
        assert_eq!(error.code, "insufficient_balance");
        assert_eq!(error.message, "团队额度不足");
        assert_eq!(error.request_id.as_deref(), Some("platform-request-id"));

        let request = request_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("应收到 relay 请求");
        assert_eq!(
            request.headers.get("x-client").map(String::as_str),
            Some("desktop-plugin-test")
        );
        assert!(request.headers.contains_key("x-request-id"));
    }

    fn spawn_relay_response(status: u16, body: Value) -> (String, mpsc::Receiver<HttpRequest>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("应启动测试 relay");
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("应收到测试 relay 请求");
            let request = read_request(&mut stream).expect("测试 relay 请求应有效");
            tx.send(request).expect("应回传测试请求");
            let response = http_json(status, &body);
            stream
                .write_all(response.as_bytes())
                .expect("应写入测试 relay 响应");
            stream.flush().expect("应刷新测试 relay 响应");
        });
        (endpoint, rx)
    }

    #[test]
    fn v1_models_returns_fast_and_premium() {
        let (endpoint, request_rx) = spawn_relay_response(
            200,
            json!({
                "object": "list",
                "data": [
                    { "id": "fast", "object": "model" },
                    { "id": "premium", "object": "model" },
                ],
            }),
        );
        let session = BridgeSession {
            plugin_id: "test-plugin".to_string(),
            api_base: endpoint,
            auth_token: "jwt".to_string(),
            allow_llm_chat: true,
            allow_image_generate: false,
            allow_image_edit: false,
            client_source: PluginBridgeClientSource::PluginRuntime,
            expires_at: Instant::now() + Duration::from_secs(60),
        };
        let data = route_v1_models(&session).expect("/v1/models 应返回模型列表");
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
        let request = request_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("应收到模型列表请求");
        assert_eq!(request.method, "GET");
        assert_eq!(request.path, "/api/relay/v1/models");
        assert_eq!(
            request.headers.get("x-client").map(String::as_str),
            Some("desktop-plugin")
        );
    }

    /// 构造一个空的 BridgeState + 带有效 token 的会话，用于 route_request 分发测试。
    fn route_with_session(
        method: &str,
        path: &str,
        allow_llm: bool,
        allow_image: bool,
    ) -> BridgeResult<Value> {
        let bridge = PluginLlmBridge::new();
        let token = insert_test_session(&bridge, allow_llm, allow_image);
        let mut headers = HashMap::new();
        headers.insert("x-lingfang-plugin-token".to_string(), token);
        let request = HttpRequest {
            method: method.to_string(),
            path: path.to_string(),
            headers,
            body: Vec::new(),
        };
        route_request(&bridge.inner, request)
    }

    fn insert_test_session(bridge: &PluginLlmBridge, allow_llm: bool, allow_image: bool) -> String {
        let token = issue_token();
        bridge
            .inner
            .sessions
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .insert(
                token.clone(),
                BridgeSession {
                    plugin_id: "test-plugin".to_string(),
                    api_base: "http://127.0.0.1:0".to_string(),
                    auth_token: "dummy".to_string(),
                    allow_llm_chat: allow_llm,
                    allow_image_generate: allow_image,
                    allow_image_edit: false,
                    client_source: PluginBridgeClientSource::PluginRuntime,
                    expires_at: Instant::now() + Duration::from_secs(60),
                },
            );
        token
    }

    #[test]
    fn route_request_rejects_get_on_legacy_chat_route() {
        // GET /llm/chat 不在允许的 GET 名单（只有 /v1/models 允许 GET），应被 method 守卫拒绝。
        let result = route_with_session("GET", "/llm/chat", true, false);
        assert!(result.is_err());
        let error = result.unwrap_err();
        assert_eq!(error.status, 404);
        assert_eq!(error.code, "not_found");
    }

    #[test]
    fn route_request_allows_get_v1_models() {
        // GET /v1/models 应放行并透传平台当前团队实际可用档位。
        let (endpoint, _request_rx) =
            spawn_relay_response(200, json!({ "object": "list", "data": [{ "id": "fast" }] }));
        let bridge = PluginLlmBridge::new();
        let token = insert_test_session(&bridge, true, false);
        bridge
            .inner
            .sessions
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .get_mut(&token)
            .expect("测试 session 应存在")
            .api_base = endpoint;
        let mut headers = HashMap::new();
        headers.insert("x-lingfang-plugin-token".to_string(), token);
        let result = route_request(
            &bridge.inner,
            HttpRequest {
                method: "GET".to_string(),
                path: "/v1/models".to_string(),
                headers,
                body: Vec::new(),
            },
        );
        let data = result.expect("GET /v1/models 应成功");
        let ids: Vec<&str> = data
            .get("data")
            .and_then(|value| value.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.get("id").and_then(|v| v.as_str()))
                    .collect()
            })
            .unwrap_or_default();
        assert_eq!(ids, vec!["fast"]);
    }

    #[test]
    fn route_request_v1_chat_denied_without_llm_capability() {
        // 未声明 llm.chat（allow_llm=false）时，POST /v1/chat/completions 应 403 capability_denied。
        // 提供有效 token 但 body 缺 messages 也会先命中 capability gate（gate 在 body 校验前）。
        let bridge = PluginLlmBridge::new();
        let token = insert_test_session(&bridge, false, false);
        let mut headers = HashMap::new();
        headers.insert("x-lingfang-plugin-token".to_string(), token);
        let request = HttpRequest {
            method: "POST".to_string(),
            path: "/v1/chat/completions".to_string(),
            headers,
            body: b"{\"model\":\"gpt-4o\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
                .to_vec(),
        };
        let result = route_request(&bridge.inner, request);
        assert!(result.is_err());
        let error = result.unwrap_err();
        assert_eq!(error.status, 403);
        assert_eq!(error.code, "capability_denied");
    }

    #[test]
    fn route_request_v1_images_denied_without_image_capability() {
        // 未声明 image.generate 时，POST /v1/images/generations 应 403 capability_denied。
        let bridge = PluginLlmBridge::new();
        let token = insert_test_session(&bridge, true, false);
        let mut headers = HashMap::new();
        headers.insert("x-lingfang-plugin-token".to_string(), token);
        let request = HttpRequest {
            method: "POST".to_string(),
            path: "/v1/images/generations".to_string(),
            headers,
            body: b"{\"model\":\"dall-e-3\",\"prompt\":\"cat\"}".to_vec(),
        };
        let result = route_request(&bridge.inner, request);
        assert!(result.is_err());
        let error = result.unwrap_err();
        assert_eq!(error.status, 403);
        assert_eq!(error.code, "capability_denied");
    }

    #[test]
    fn route_request_unknown_path_is_404() {
        // 未知路径即便 method 正确也应 404。
        let result = route_with_session("POST", "/v1/unknown", true, true);
        assert!(result.is_err());
        let error = result.unwrap_err();
        assert_eq!(error.status, 404);
        assert_eq!(error.code, "not_found");
    }

    #[test]
    fn route_image_edit_denied_without_capability() {
        // 未声明 image.edit（allow_image_edit=false）时，POST /image/edit 应 403 capability_denied。
        let result = route_with_session("POST", "/image/edit", true, true);
        assert!(result.is_err());
        let error = result.unwrap_err();
        assert_eq!(error.status, 403);
        assert_eq!(error.code, "capability_denied");
    }

    #[test]
    fn route_image_edit_builds_multipart_and_extracts_images() {
        // mock relay 返回一张 b64 图片，并捕获桥转发的 multipart 请求。
        let (endpoint, request_rx) = spawn_relay_response(
            200,
            json!({ "data": [{ "b64_json": "AAAA" }] }),
        );
        let session = BridgeSession {
            plugin_id: "test-plugin".to_string(),
            api_base: endpoint,
            auth_token: "jwt".to_string(),
            allow_llm_chat: false,
            allow_image_generate: false,
            allow_image_edit: true,
            client_source: PluginBridgeClientSource::PluginRuntime,
            expires_at: Instant::now() + Duration::from_secs(60),
        };
        let body = serde_json::to_vec(&json!({
            "prompt": "换装",
            "images": [{ "filename": "model.jpg", "mimeType": "image/jpeg", "data": "UE5HREFUQQ==" }],
            "model": "fast",
            "n": 1,
            "size": "1024x1024",
        }))
        .expect("请求体应可序列化");
        let data = route_image_edit(&session, body).expect("image.edit 应成功");
        assert_eq!(data["images"][0], "data:image/png;base64,AAAA");

        let request = request_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("应收到 relay 转发请求");
        let text = String::from_utf8_lossy(&request.body);
        // multipart 含 prompt 与参考图解码字节，不含 model 字段（由 relay 注入上游模型）。
        assert!(text.contains("name=\"prompt\""));
        assert!(text.contains("换装"));
        assert!(text.contains("name=\"image[]\"; filename=\"model.jpg\""));
        assert!(text.contains("PNGDATA"), "参考图 base64 应解码为原始字节");
        assert!(!text.contains("name=\"model\""), "桥不应填写 model 字段");
        // tier 经 query 传 relay 供计费/选渠道。
        assert!(request.path.starts_with("/api/relay/v1/images/edits"));
        assert!(request.path.contains("model=fast"));
        assert!(request
            .headers
            .get("content-type")
            .map(String::as_str)
            .unwrap_or("")
            .starts_with("multipart/form-data"));
    }

    #[test]
    fn route_image_edit_rejects_invalid_input() {
        let (endpoint, _request_rx) = spawn_relay_response(200, json!({ "data": [] }));
        let session = BridgeSession {
            plugin_id: "test-plugin".to_string(),
            api_base: endpoint,
            auth_token: "jwt".to_string(),
            allow_llm_chat: false,
            allow_image_generate: false,
            allow_image_edit: true,
            client_source: PluginBridgeClientSource::PluginRuntime,
            expires_at: Instant::now() + Duration::from_secs(60),
        };
        let case = |body: Value| route_image_edit(&session, serde_json::to_vec(&body).unwrap());
        // 缺 prompt
        assert_eq!(case(json!({ "images": [{ "filename": "a.jpg", "data": "UE5HREFUQQ==" }] })).unwrap_err().status, 400);
        // 缺 images
        assert_eq!(case(json!({ "prompt": "x" })).unwrap_err().status, 400);
        // 非法 base64
        assert_eq!(case(json!({ "prompt": "x", "images": [{ "filename": "a.jpg", "data": "!!!not-base64!!!" }] })).unwrap_err().status, 400);
    }
}
