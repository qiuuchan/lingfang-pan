//! 插件脚本 LLM 本地桥。
//!
//! 目标：让 Node.js / Python 独立进程插件能调用平台 Relay，同时不把用户 JWT 或平台密钥暴露给脚本。
//! 脚本只拿 localhost URL + 进程会话 token；真正的后端地址和登录态保存在宿主内存里。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
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

#[derive(Clone)]
struct BridgeSession {
    plugin_id: String,
    api_base: String,
    auth_token: String,
    allow_llm_chat: bool,
    allow_image_generate: bool,
    allow_image_edit: bool,
    allow_video_generate: bool,
    action_invocation_id: Option<String>,
    action_context: Option<Arc<ActionRuntimeContext>>,
    client_source: PluginBridgeClientSource,
    expires_at: Instant,
}

#[derive(Clone)]
struct ActionRuntimeContext {
    app: AppHandle,
    manager: crate::plugin_package_manager::PluginPackageManager,
    package_id: String,
    release_id: String,
    sha256: String,
}

#[derive(Default)]
struct BridgeState {
    endpoint: Mutex<Option<String>>,
    sessions: Mutex<HashMap<String, BridgeSession>>,
    action_requests: Mutex<HashMap<String, mpsc::Sender<Result<Value, Value>>>>,
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
        allow_video_generate: bool,
        client_source: PluginBridgeClientSource,
        ttl: Duration,
    ) -> Result<Option<PluginBridgeEnv>, String> {
        let api_base = api_base
            .unwrap_or_default()
            .trim()
            .trim_end_matches('/')
            .to_string();
        let auth_token = auth_token.unwrap_or_default().trim().to_string();
        if !allow_llm_chat && !allow_image_generate && !allow_image_edit && !allow_video_generate {
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
            allow_video_generate,
            action_invocation_id: None,
            action_context: None,
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

    pub fn register_action_session(
        &self,
        plugin_id: &str,
        api_base: String,
        auth_token: String,
        invocation_id: String,
        app: AppHandle,
        manager: crate::plugin_package_manager::PluginPackageManager,
        package_id: String,
        release_id: String,
        sha256: String,
        ttl: Duration,
    ) -> Result<PluginBridgeEnv, String> {
        if api_base.trim().is_empty() || auth_token.trim().is_empty() || invocation_id.trim().is_empty() {
            return Err("Action bridge 缺少平台 session 或 invocation".to_string());
        }
        let endpoint = self.ensure_server()?;
        let token = issue_token();
        self.inner.sessions.lock().unwrap_or_else(|poison| poison.into_inner()).insert(token.clone(), BridgeSession {
            plugin_id: plugin_id.to_string(), api_base: api_base.trim().trim_end_matches('/').to_string(), auth_token: auth_token.trim().to_string(),
            allow_llm_chat: false, allow_image_generate: false, allow_image_edit: false, allow_video_generate: false, action_invocation_id: Some(invocation_id),
            action_context: Some(Arc::new(ActionRuntimeContext { app, manager, package_id, release_id, sha256 })),
            client_source: PluginBridgeClientSource::PluginRuntime, expires_at: Instant::now() + ttl,
        });
        Ok(PluginBridgeEnv { url: endpoint, token })
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

#[tauri::command]
pub fn respond_plugin_action_bridge(
    bridge: tauri::State<'_, PluginLlmBridge>,
    request_id: String,
    result: Option<Value>,
    error: Option<Value>,
) -> Result<(), String> {
    let sender = bridge.inner.action_requests.lock().unwrap_or_else(|poison| poison.into_inner()).remove(&request_id).ok_or_else(|| "Action bridge request 已失效".to_string())?;
    sender.send(match error { Some(error) => Err(error), None => Ok(result.unwrap_or_else(|| json!({}))) }).map_err(|_| "Action bridge 响应接收端已关闭".to_string())
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
    // 按路由分发 HTTP method：GET /v1/models 与 GET /video/stream、/video/download 允许
    //（供第三方 SDK 连通性探测 + RBFLow 进度/下载代理），其余路由保持仅 POST。
    // 先校验 method 再校验 token，避免对错误 method 暴露鉴权细节。
    let path = request.path.as_str();
    let path_only = path.split('?').next().unwrap_or(path);
    let is_get_allowed = request.method == "GET"
        && (path_only == "/v1/models" || path_only == "/video/stream" || path_only == "/video/download");
    if !is_get_allowed && request.method != "POST" {
        return Err(BridgeError::new(
            404,
            "not_found",
            "插件本地桥仅支持 POST 请求（GET 仅 /v1/models、/video/stream、/video/download）",
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

    match path_only {
        // 灵坊自有形状（SDK 内部用）：返回 {content} / {images} 包装。
        "/llm/chat" => route_llm_chat(&session, request.body),
        "/image/generate" => route_image_generate(&session, request.body),
        "/image/edit" => route_image_edit(&session, request.body),
        "/video/generate" => route_video_generate(&session, request.body),
        // GET 路由带 query（task_id），完整 path 透传给 route 函数解析。
        "/video/stream" if request.method == "GET" => route_video_stream(&session, &request.path),
        "/video/download" if request.method == "GET" => {
            route_video_download(&session, &request.path)
        }
        "/actions/call" => route_action_call(inner, &session, request.body),
        "/artifacts/create" => route_action_artifact(&session, "", request.body),
        "/artifacts/materialize" => route_action_artifact(&session, "/materialize", request.body),
        "/artifacts/import" => route_action_artifact(&session, "/import", request.body),
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

fn route_action_call(inner: &Arc<BridgeState>, session: &BridgeSession, body_bytes: Vec<u8>) -> BridgeResult<Value> {
    ensure_platform_session(session, "Nested Action")?;
    let parent_id = session.action_invocation_id.as_deref().ok_or_else(|| BridgeError::new(403, "action_dependency_denied", "当前脚本不在 Action invocation 中"))?;
    let context = session.action_context.as_ref().ok_or_else(|| BridgeError::new(503, "action_runtime_unavailable", "Action runtime context 不可用"))?;
    let body: Value = serde_json::from_slice(&body_bytes).map_err(|_| BridgeError::new(400, "action_input_invalid", "actions.call 请求体不是有效 JSON"))?;
    let _dependency_id = body.get("dependency_id").and_then(Value::as_str).filter(|value| !value.trim().is_empty()).ok_or_else(|| BridgeError::new(400, "action_dependency_denied", "actions.call 缺少 dependency_id"))?;
    body.get("input").filter(|value| value.is_object()).ok_or_else(|| BridgeError::new(400, "action_input_invalid", "Action input 必须是 JSON 对象"))?;
    let caller = context.manager.action_caller_descriptor(&context.package_id, &context.release_id, &context.sha256).map_err(|error| BridgeError::new(403, "action_dependency_denied", error))?;
    let request_id = Uuid::new_v4().to_string();
    let (sender, receiver) = mpsc::channel();
    inner.action_requests.lock().unwrap_or_else(|poison| poison.into_inner()).insert(request_id.clone(), sender);
    if let Err(error) = context.app.emit("plugin-action-bridge-call", json!({ "request_id": request_id, "parent_invocation_id": parent_id, "caller": caller, "args": body })) {
        inner.action_requests.lock().unwrap_or_else(|poison| poison.into_inner()).remove(&request_id);
        return Err(BridgeError::new(503, "action_runtime_unavailable", format!("发送 Action bridge 请求失败：{error}")));
    }
    match receiver.recv_timeout(Duration::from_secs(24 * 60 * 60 + 30)) {
        Ok(Ok(result)) => Ok(result),
        Ok(Err(error)) => Err(BridgeError::new(error.get("status").and_then(Value::as_u64).unwrap_or(500) as u16, error.get("code").and_then(Value::as_str).unwrap_or("action_execution_failed"), error.get("message").and_then(Value::as_str).unwrap_or("Nested Action 执行失败"))),
        Err(_) => { inner.action_requests.lock().unwrap_or_else(|poison| poison.into_inner()).remove(&request_id); Err(BridgeError::new(504, "action_timeout", "等待桌面 Action host 响应超时")) }
    }
}

fn route_action_artifact(session: &BridgeSession, suffix: &str, body_bytes: Vec<u8>) -> BridgeResult<Value> {
    ensure_platform_session(session, "Action artifact")?;
    let invocation_id = session.action_invocation_id.as_deref().ok_or_else(|| BridgeError::new(403, "action_artifact_invalid", "当前脚本不在 Action invocation 中"))?;
    let body: Value = serde_json::from_slice(&body_bytes).map_err(|_| BridgeError::new(400, "action_artifact_invalid", "Artifact 请求体不是有效 JSON"))?;
    let path = format!("/api/plugin-actions/invocations/{invocation_id}/artifacts{suffix}");
    let value = relay_post_json(session, &path, &body)?;
    if suffix == "/materialize" {
        return Ok(json!({
            "dataBase64": value.get("data_base64"),
            "mediaType": value.get("media_type"),
            "sizeBytes": value.get("size_bytes"),
            "sha256": value.get("sha256"),
        }));
    }
    Ok(value)
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
/// 与 image.generate 的区别：携带参考图（image 字段，多张以多个同名 part），走 relay 的 images/edits 透传。
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
    // 字段名用 "image"（OpenAI /v1/images/edits 标准单值字段）。
    // 曾用 "image[]"，但上游 images/edits 不认 image[]（实测 502 upstream_llm_error），只认 image。
    // 多张参考图以多个同名 "image" part 传递。
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{filename}\"\r\nContent-Type: {mime}\r\n\r\n"
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

/// 从完整请求路径（含 query）中提取某 query 参数的首个值。
/// 例如 `/video/stream?task_id=abc` → task_id=abc。
fn query_first(full_path: &str, key: &str) -> Option<String> {
    let query = full_path.split_once('?').map(|(_, q)| q).unwrap_or("");
    for pair in query.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            if k == key {
                let value = percent_decode(v);
                if !value.is_empty() {
                    return Some(value);
                }
            }
        }
    }
    None
}

/// 最小 percent-decode（仅 %XX），用于 query 参数（task_id 通常无需编码，但兜底）。
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(
                std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""),
                16,
            ) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        if bytes[i] == b'+' {
            out.push(b' ');
        } else {
            out.push(bytes[i]);
        }
        i += 1;
    }
    String::from_utf8(out).unwrap_or_default()
}

// ============================================================================
// 视频生成（RBFLow 代理转发 + 防绕过计费）
//
// 安全模型：插件进程**不持有任何 RBFLow 凭证**。RBFLow 的 URL + API-KEY 是平台运营实例的
// 配置，由桌面进程从环境变量 LINGFANG_RBFLOW_URL / LINGFANG_RBFLOW_API_KEY 读取（桌面进程 env，
// 绝不注入到插件子进程 env —— plugin_runner.rs 用 env_clear + minimal_env 白名单保证）。
//
// 数据流：插件 POST /video/generate → 桥先经 relay /api/relay/v1/videos/generations 按秒计费 →
// 计费成功后注入平台 RBFLow 凭证转发 multipart 到 RBFLow POST /api/v1/tasks → 返回 {task_id, call_log_id}。
// 计费失败(402) 不转发；转发失败则调 relay /api/relay/v1/videos/refund 退款。
// ============================================================================

/// 平台运营 RBFLow 实例的凭证（桌面进程 env，非插件 env）。
struct RbflowCredential {
    url: String,
    api_key: String,
}

/// 读取平台 RBFLow 凭证。缺失说明平台未配 RBFLow（部署错误）。
fn read_rbflow_credential() -> Result<RbflowCredential, String> {
    let url = std::env::var("LINGFANG_RBFLOW_URL")
        .map(|v| v.trim().trim_end_matches('/').to_string())
        .map_err(|_| "未配置 LINGFANG_RBFLOW_URL".to_string())?;
    let api_key = std::env::var("LINGFANG_RBFLOW_API_KEY")
        .map(|v| v.trim().to_string())
        .map_err(|_| "未配置 LINGFANG_RBFLOW_API_KEY".to_string())?;
    if url.is_empty() || api_key.is_empty() {
        return Err("RBFLow 凭证为空".to_string());
    }
    Ok(RbflowCredential { url, api_key })
}

/// 构建 RBFLow 提交 multipart（POST /api/v1/tasks）：
/// 两个 file part（image + video，字段名固定 image/video，与 RBFLow 工作流节点字段对齐）
/// + 可选 callback_url text part。复用 push_text_part / push_file_part 模式。
fn build_rbflow_multipart(
    image_filename: &str,
    image_mime: &str,
    image_bytes: &[u8],
    video_filename: &str,
    video_mime: &str,
    video_bytes: &[u8],
    callback_url: Option<&str>,
) -> (Vec<u8>, String) {
    let boundary = "lfVideoGenerate8k2m7xQ1";
    let mut body = Vec::new();
    push_file_part_named(&mut body, boundary, "image", image_filename, image_mime, image_bytes);
    push_file_part_named(&mut body, boundary, "video", video_filename, video_mime, video_bytes);
    if let Some(cb) = callback_url.filter(|s| !s.is_empty()) {
        push_text_part(&mut body, boundary, "callback_url", cb);
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    (body, format!("multipart/form-data; boundary={boundary}"))
}

/// 与 push_file_part 的区别：字段名可指定（RBFLow 用 image/video 两字段，非 OpenAI 的 image 单字段）。
fn push_file_part_named(
    body: &mut Vec<u8>,
    boundary: &str,
    name: &str,
    filename: &str,
    mime: &str,
    data: &[u8],
) {
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"; filename=\"{filename}\"\r\nContent-Type: {mime}\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(data);
    body.extend_from_slice(b"\r\n");
}

/// 解析 base64 数据为原始字节（视频桥共用 image.edit 的解码模式）。
fn decode_required_base64(label: &str, data_b64: &str) -> BridgeResult<Vec<u8>> {
    let bytes = BASE64_STANDARD
        .decode(data_b64.trim())
        .map_err(|_| {
            BridgeError::new(
                400,
                "bad_request",
                format!("{label} data 不是合法 base64"),
            )
        })?;
    if bytes.is_empty() {
        return Err(BridgeError::new(
            400,
            "bad_request",
            format!("{label} 数据为空"),
        ));
    }
    Ok(bytes)
}

/// 推断常见图片扩展名对应的 MIME（默认 image/png）。
fn image_mime_for(filename: &str) -> &'static str {
    let lower = filename.to_ascii_lowercase();
    if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else {
        "image/png"
    }
}

/// 推断常见视频扩展名对应的 MIME（默认 video/mp4）。
fn video_mime_for(filename: &str) -> &'static str {
    let lower = filename.to_ascii_lowercase();
    if lower.ends_with(".webm") {
        "video/webm"
    } else if lower.ends_with(".mov") {
        "video/quicktime"
    } else if lower.ends_with(".avi") {
        "video/x-msvideo"
    } else {
        "video/mp4"
    }
}

/// POST /video/generate：gate → 平台 session → 解析 image/video/seconds/tier →
/// **先 relay 按秒计费**（402 透传不转发）→ **计费成功注入平台 RBFLow 凭证转发 multipart** →
/// 转发失败调 relay 退款 → 返回 {task_id, call_log_id, charged, credits}。
///
/// 防绕过：插件不持有 RBFLow 凭证，无法绕过桥直连 RBFLow；计费与转发原子绑定在桥内。
fn route_video_generate(session: &BridgeSession, body_bytes: Vec<u8>) -> BridgeResult<Value> {
    if !session.allow_video_generate {
        return Err(BridgeError::new(
            403,
            "capability_denied",
            "插件未声明 video.generate 能力",
        ));
    }
    ensure_platform_session(session, "视频生成")?;

    let body: Value = serde_json::from_slice(&body_bytes)
        .map_err(|_| BridgeError::new(400, "bad_request", "请求体不是有效 JSON"))?;

    // seconds：必填，支持整数或浮点；向上取整为秒。
    let seconds = body
        .get("seconds")
        .and_then(|v| {
            v.as_u64()
                .map(|n| n as f64)
                .or_else(|| v.as_f64())
        })
        .filter(|v| *v > 0.0)
        .ok_or_else(|| {
            BridgeError::new(400, "bad_request", "video.generate 缺少 seconds（正数）")
        })?;
    let tier = parse_model_tier(&body)?;
    let image_b64 = body
        .get("image")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| {
            BridgeError::new(400, "bad_request", "video.generate 缺少 image(base64)")
        })?;
    let video_b64 = body
        .get("video")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| {
            BridgeError::new(400, "bad_request", "video.generate 缺少 video(base64)")
        })?;
    let image_filename = sanitize_filename(
        body.get("image_filename")
            .and_then(Value::as_str)
            .unwrap_or("image"),
    );
    let video_filename = sanitize_filename(
        body.get("video_filename")
            .and_then(Value::as_str)
            .unwrap_or("video"),
    );
    let image_mime = body
        .get("image_mime_type")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .map(|v| v.to_string())
        .unwrap_or_else(|| image_mime_for(&image_filename).to_string());
    let video_mime = body
        .get("video_mime_type")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .map(|v| v.to_string())
        .unwrap_or_else(|| video_mime_for(&video_filename).to_string());
    let callback_url = body.get("callback_url").and_then(Value::as_str);

    // 1) 先经 relay 按秒计费。relay_post_json 对非 2xx（含 402 insufficient_balance）转 BridgeError 抛出，
    //    402 直接透传给插件（插件拦截不提交）。
    let charge = relay_post_json(
        session,
        "/api/relay/v1/videos/generations",
        &json!({ "model": tier, "seconds": seconds }),
    )?;
    let call_log_id = charge
        .get("call_log_id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let credits = charge.get("credits").cloned().unwrap_or(Value::Null);
    if call_log_id.is_empty() {
        return Err(BridgeError::new(
            502,
            "relay_response_invalid",
            "平台计费响应缺少 call_log_id",
        ));
    }

    // 2) 计费成功 → 解码素材字节。
    let image_bytes = decode_required_base64("image", image_b64)?;
    let video_bytes = decode_required_base64("video", video_b64)?;

    // 3) 读平台 RBFLow 凭证。缺失则**先退款再报错**（凭证缺失是部署错误，不能扣费无服务）。
    let rbflow = match read_rbflow_credential() {
        Ok(rbflow) => rbflow,
        Err(reason) => {
            refund_video_silent(session, &call_log_id, &format!("rbflow_not_configured: {reason}"));
            return Err(BridgeError::new(
                503,
                "rbflow_not_configured",
                format!("平台未配置 RBFLow 视频服务：{reason}"),
            ));
        }
    };

    // 4) 转发 multipart 到平台运营 RBFLow POST /api/v1/tasks（注入 X-API-Key）。
    let (multipart_body, content_type) = build_rbflow_multipart(
        &image_filename,
        &image_mime,
        &image_bytes,
        &video_filename,
        &video_mime,
        &video_bytes,
        callback_url,
    );
    let rbflow_url = format!("{}/api/v1/tasks", rbflow.url);
    let rbflow_resp = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
        .unwrap_or_else(|_| reqwest::blocking::Client::new())
        .post(&rbflow_url)
        .header("X-API-Key", &rbflow.api_key)
        .header("Content-Type", content_type)
        .header("X-Client", session.client_source.x_client())
        .body(multipart_body)
        .send();
    let rbflow_resp = match rbflow_resp {
        Ok(resp) => resp,
        Err(error) => {
            // 转发失败（RBFLow 宕机/不可达）→ 退款，避免扣费无服务。
            refund_video_silent(session, &call_log_id, &format!("rbflow_forward_failed: {error}"));
            return Err(BridgeError::new(
                502,
                "rbflow_forward_failed",
                format!("转发到 RBFLow 失败：{error}"),
            ));
        }
    };
    let rbflow_status = rbflow_resp.status();
    let rbflow_text = rbflow_resp.text().unwrap_or_default();
    if !rbflow_status.is_success() {
        refund_video_silent(
            session,
            &call_log_id,
            &format!("rbflow_forward_failed: HTTP {}", rbflow_status.as_u16()),
        );
        // 附 RBFLow 错误信息供插件展示（不暴露内部敏感细节，仅状态码与可读消息）。
        let message = serde_json::from_str::<Value>(&rbflow_text)
            .ok()
            .and_then(|v| {
                v.get("detail")
                    .and_then(Value::as_str)
                    .or_else(|| v.get("message").and_then(Value::as_str))
                    .map(String::from)
            })
            .unwrap_or_else(|| format!("RBFLow 返回 HTTP {}", rbflow_status.as_u16()));
        return Err(BridgeError::new(
            502,
            "rbflow_forward_failed",
            format!("RBFLow 任务创建失败：{message}"),
        ));
    }

    // 5) 转发成功 → 取 task_id 返回扣费票据。
    let rbflow_json: Value = serde_json::from_str(&rbflow_text).map_err(|_| {
        BridgeError::new(
            502,
            "rbflow_response_invalid",
            "RBFLow 响应不是有效 JSON",
        )
    })?;
    let task_id = rbflow_json
        .get("task_id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if task_id.is_empty() {
        refund_video_silent(session, &call_log_id, "rbflow_response_missing_task_id");
        return Err(BridgeError::new(
            502,
            "rbflow_response_invalid",
            "RBFLow 响应缺少 task_id",
        ));
    }
    Ok(json!({
        "task_id": task_id,
        "call_log_id": call_log_id,
        "charged": true,
        "credits": credits,
    }))
}

/// 静默退款（转发失败时调）：失败仅记 warn，不阻塞主错误返回（凭 call_log_id 幂等）。
fn refund_video_silent(session: &BridgeSession, call_log_id: &str, reason: &str) {
    if call_log_id.is_empty() {
        return;
    }
    match relay_post_json(
        session,
        "/api/relay/v1/videos/refund",
        &json!({ "call_log_id": call_log_id }),
    ) {
        Ok(_) => eprintln!(
            "[video-bridge] 退款成功 call_log_id={call_log_id} reason={reason}"
        ),
        Err(error) => eprintln!(
            "[video-bridge] 退款失败 call_log_id={call_log_id} reason={reason} refund_error={}({})",
            error.code, error.message
        ),
    }
}

/// GET /video/stream?task_id=X：注入平台 RBFLow key 代理 RBFLow `GET /api/v1/tasks/{id}/stream`。
///
/// 返回类型约束：桥的 HTTP handler（handle_connection）仅支持 JSON Value 响应，无法做真 SSE 透传。
/// 故 MVP 采用「聚合」方案：桥用 blocking reqwest 拉取 RBFLow 完整 SSE 文本，逐行解析成 JSON 事件数组，
/// 返回 `{events: [...]}`。插件侧解析数组（非流），等价于 RBFLow 任务跑完后一次性回放所有事件。
fn route_video_stream(session: &BridgeSession, full_path: &str) -> BridgeResult<Value> {
    if !session.allow_video_generate {
        return Err(BridgeError::new(
            403,
            "capability_denied",
            "插件未声明 video.generate 能力",
        ));
    }
    ensure_platform_session(session, "视频进度")?;
    let task_id = sanitize_task_id(query_first(full_path, "task_id").ok_or_else(|| {
        BridgeError::new(400, "bad_request", "video.stream 缺少 task_id")
    })?)?;
    let rbflow = read_rbflow_credential().map_err(|reason| {
        BridgeError::new(
            503,
            "rbflow_not_configured",
            format!("平台未配置 RBFLow 视频服务：{reason}"),
        )
    })?;
    let url = format!("{}/api/v1/tasks/{}/stream", rbflow.url, task_id);
    let resp = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
        .unwrap_or_else(|_| reqwest::blocking::Client::new())
        .get(&url)
        .header("X-API-Key", &rbflow.api_key)
        .header("Accept", "text/event-stream")
        .header("X-Client", session.client_source.x_client())
        .send()
        .map_err(|error| {
            BridgeError::new(
                502,
                "rbflow_stream_failed",
                format!("无法连接 RBFLow 进度服务：{error}"),
            )
        })?;
    let status = resp.status();
    let text = resp.text().unwrap_or_default();
    if !status.is_success() {
        return Err(BridgeError::new(
            502,
            "rbflow_stream_failed",
            format!("RBFLow 进度服务返回 HTTP {}", status.as_u16()),
        ));
    }
    // 解析 SSE 文本为事件数组。SSE 格式：事件以空行分隔，每事件多行 `field: value`。
    let events = parse_sse_events(&text);
    Ok(json!({ "task_id": task_id, "events": events }))
}

/// 解析 SSE 文本（`data: ...\n\n` 块）为 JSON 值数组。
/// 每个事件的 data 行尝试 JSON 解析；解析失败保留原始字符串。
fn parse_sse_events(text: &str) -> Vec<Value> {
    let mut events = Vec::new();
    let mut current_data: Vec<String> = Vec::new();
    let flush = |data: &mut Vec<String>, events: &mut Vec<Value>| {
        if data.is_empty() {
            return;
        }
        let joined = data.join("\n");
        data.clear();
        let value = if let Ok(parsed) = serde_json::from_str::<Value>(&joined) {
            parsed
        } else {
            Value::String(joined.clone())
        };
        events.push(value);
    };
    for line in text.split('\n') {
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            flush(&mut current_data, &mut events);
            continue;
        }
        if let Some(rest) = line.strip_prefix("data:") {
            current_data.push(rest.trim_start_matches(' ').to_string());
        } else if line.starts_with(':') {
            // SSE 注释行，忽略。
            continue;
        }
        // event:/id:/retry: 等其他字段不单独收集（插件主要消费 data）。
    }
    flush(&mut current_data, &mut events);
    events
}

/// GET /video/download?task_id=X：注入平台 RBFLow key 代理 RBFLow `GET /api/v1/tasks/{id}/download`。
///
/// 返回类型约束：桥仅支持 JSON Value 响应，无法流式回传原始字节。故 MVP 将完整 mp4 字节 base64
/// 编码进 JSON `{data, filename, mime_type}`。视频可能数百 MB，base64 会膨胀 ~33% 且全量载内存；
/// MVP 可接受（RBFLow 任务串行，单文件）。长期改进需桥支持原始字节流响应。
fn route_video_download(session: &BridgeSession, full_path: &str) -> BridgeResult<Value> {
    if !session.allow_video_generate {
        return Err(BridgeError::new(
            403,
            "capability_denied",
            "插件未声明 video.generate 能力",
        ));
    }
    ensure_platform_session(session, "视频下载")?;
    let task_id = sanitize_task_id(query_first(full_path, "task_id").ok_or_else(|| {
        BridgeError::new(400, "bad_request", "video.download 缺少 task_id")
    })?)?;
    let rbflow = read_rbflow_credential().map_err(|reason| {
        BridgeError::new(
            503,
            "rbflow_not_configured",
            format!("平台未配置 RBFLow 视频服务：{reason}"),
        )
    })?;
    let url = format!("{}/api/v1/tasks/{}/download", rbflow.url, task_id);
    let resp = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
        .unwrap_or_else(|_| reqwest::blocking::Client::new())
        .get(&url)
        .header("X-API-Key", &rbflow.api_key)
        .header("X-Client", session.client_source.x_client())
        .send()
        .map_err(|error| {
            BridgeError::new(
                502,
                "rbflow_download_failed",
                format!("无法连接 RBFLow 下载服务：{error}"),
            )
        })?;
    let status = resp.status();
    if !status.is_success() {
        return Err(BridgeError::new(
            502,
            "rbflow_download_failed",
            format!("RBFLow 下载服务返回 HTTP {}", status.as_u16()),
        ));
    }
    let mime_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("video/mp4")
        .to_string();
    // 从 Content-Disposition 解析文件名（如 `attachment; filename="xxx.mp4"`）。
    let filename = resp
        .headers()
        .get(reqwest::header::CONTENT_DISPOSITION)
        .and_then(|v| v.to_str().ok())
        .and_then(extract_filename_from_disposition)
        .unwrap_or_else(|| format!("{}.mp4", task_id));
    let bytes = resp.bytes().map_err(|error| {
        BridgeError::new(
            502,
            "rbflow_download_failed",
            format!("读取 RBFLow 下载内容失败：{error}"),
        )
    })?;
    if bytes.is_empty() {
        return Err(BridgeError::new(
            502,
            "rbflow_download_failed",
            "RBFLow 下载内容为空",
        ));
    }
    let data_b64 = BASE64_STANDARD.encode(&bytes);
    Ok(json!({
        "task_id": task_id,
        "data": data_b64,
        "filename": filename,
        "mime_type": mime_type,
        "size": bytes.len(),
    }))
}

/// 从 Content-Disposition 头提取 filename（支持 filename= 与 filename*= 两种）。
fn extract_filename_from_disposition(header: &str) -> Option<String> {
    for part in header.split(';') {
        let part = part.trim();
        if let Some(rest) = part.strip_prefix("filename*=") {
            // RFC 5987: utf-8''name.mp4 → 去掉前缀与引号
            let decoded = rest
                .split('\'')
                .nth(2)
                .unwrap_or(rest)
                .trim_matches('"');
            return Some(
                percent_decode(decoded)
                    .trim()
                    .trim_matches('"')
                    .to_string(),
            );
        }
        if let Some(rest) = part.strip_prefix("filename=") {
            let name = rest.trim().trim_matches('"');
            if !name.is_empty() {
                return Some(sanitize_filename(name));
            }
        }
    }
    None
}

/// task_id 白名单：仅允许字母/数字/下划线/连字符，防路径注入到 RBFLow URL。
fn sanitize_task_id(raw: String) -> BridgeResult<String> {
    let cleaned: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect();
    if cleaned.is_empty() || cleaned != raw {
        return Err(BridgeError::new(
            400,
            "bad_request",
            "task_id 含非法字符",
        ));
    }
    Ok(cleaned)
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
    use std::sync::Mutex;

    // 视频测试会读写进程 env（LINGFANG_RBFLOW_*），Rust 默认并行跑测试会互相踩。
    // 用此锁串行化所有依赖 RBFLow env 的测试，保证 env 状态可见性。
    static RBFLOW_ENV_GUARD: Mutex<()> = Mutex::new(());

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
    fn register_session_enables_video_generate_capability() {
        // 仅声明 video.generate（其余 AI 能力 false）也应注册 session 并返回 endpoint+token。
        let bridge = PluginLlmBridge::new();
        let env = bridge
            .register_session(
                "video-plugin",
                Some("https://platform.example".to_string()),
                Some("jwt".to_string()),
                false,
                false,
                false,
                true,
                PluginBridgeClientSource::PluginRuntime,
                Duration::from_secs(60),
            )
            .expect("声明 video.generate 应正常返回");
        let env = env.expect("video.generate 应注册 session");
        assert!(!env.url.is_empty());
        assert!(!env.token.is_empty());
        let sessions = bridge.inner.sessions.lock().unwrap_or_else(|poison| poison.into_inner());
        let session = sessions.get(&env.token).expect("session 应已注册");
        assert!(session.allow_video_generate);
        assert!(!session.allow_llm_chat);
        assert!(!session.allow_image_generate);
        assert!(!session.allow_image_edit);
    }

    #[test]
    fn token_guard_and_revoke_all_remove_sessions() {
        let bridge = PluginLlmBridge::new();
        let first = insert_test_session(&bridge, true, false, false);
        let second = insert_test_session(&bridge, false, true, false);
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
        let old = insert_test_session(&bridge, true, false, false);
        let current = insert_test_session(&bridge, true, false, false);
        let other = insert_test_session(&bridge, false, true, false);
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
            allow_video_generate: false,
            action_invocation_id: None,
            action_context: None,
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

    #[test]
    fn action_artifact_route_binds_the_host_invocation_without_leaking_jwt_in_body() {
        let (endpoint, request_rx) = spawn_relay_response(200, json!({ "type": "artifact_ref", "artifact_id": "artifact-1" }));
        let session = BridgeSession {
            plugin_id: "test-plugin".to_string(), api_base: endpoint, auth_token: "secret-jwt".to_string(),
            allow_llm_chat: false, allow_image_generate: false, allow_image_edit: false, allow_video_generate: false,
            action_invocation_id: Some("invocation-1".to_string()), action_context: None,
            client_source: PluginBridgeClientSource::PluginRuntime, expires_at: Instant::now() + Duration::from_secs(60),
        };
        let result = route_action_artifact(&session, "", serde_json::to_vec(&json!({ "data_base64": "UE5H", "media_type": "image/png" })).unwrap()).expect("artifact create 应代理成功");
        assert_eq!(result["artifact_id"], "artifact-1");
        let request = request_rx.recv_timeout(Duration::from_secs(2)).expect("应收到 artifact 请求");
        assert_eq!(request.path, "/api/plugin-actions/invocations/invocation-1/artifacts");
        let body: Value = serde_json::from_slice(&request.body).unwrap();
        assert_eq!(body["data_base64"], "UE5H");
        assert!(body.get("auth_token").is_none());
        assert!(body.get("invocation_id").is_none());
        assert_eq!(request.headers.get("authorization").map(String::as_str), Some("Bearer secret-jwt"));
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
            allow_video_generate: false,
            action_invocation_id: None,
            action_context: None,
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
        allow_video: bool,
    ) -> BridgeResult<Value> {
        let bridge = PluginLlmBridge::new();
        let token = insert_test_session(&bridge, allow_llm, allow_image, allow_video);
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

    fn insert_test_session(
        bridge: &PluginLlmBridge,
        allow_llm: bool,
        allow_image: bool,
        allow_video: bool,
    ) -> String {
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
                    allow_video_generate: allow_video,
                    action_invocation_id: None,
                    action_context: None,
                    client_source: PluginBridgeClientSource::PluginRuntime,
                    expires_at: Instant::now() + Duration::from_secs(60),
                },
            );
        token
    }

    #[test]
    fn route_request_rejects_get_on_legacy_chat_route() {
        // GET /llm/chat 不在允许的 GET 名单（只有 /v1/models 允许 GET），应被 method 守卫拒绝。
        let result = route_with_session("GET", "/llm/chat", true, false, false);
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
        let token = insert_test_session(&bridge, true, false, false);
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
        let token = insert_test_session(&bridge, false, false, false);
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
        let token = insert_test_session(&bridge, true, false, false);
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
        let result = route_with_session("POST", "/v1/unknown", true, true, false);
        assert!(result.is_err());
        let error = result.unwrap_err();
        assert_eq!(error.status, 404);
        assert_eq!(error.code, "not_found");
    }

    #[test]
    fn route_image_edit_denied_without_capability() {
        // 未声明 image.edit（allow_image_edit=false）时，POST /image/edit 应 403 capability_denied。
        let result = route_with_session("POST", "/image/edit", true, true, false);
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
            allow_video_generate: false,
            action_invocation_id: None,
            action_context: None,
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
        assert!(text.contains("name=\"image\"; filename=\"model.jpg\""));
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
            allow_video_generate: false,
            action_invocation_id: None,
            action_context: None,
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

    // ===== 视频生成（RBFLow 代理转发）测试 =====

    /// 构造一个声明 video.generate 的测试 session（route_video_* 直接调用用）。
    fn video_session(endpoint: String, allow_video: bool) -> BridgeSession {
        BridgeSession {
            plugin_id: "test-plugin".to_string(),
            api_base: endpoint,
            auth_token: "jwt".to_string(),
            allow_llm_chat: false,
            allow_image_generate: false,
            allow_image_edit: false,
            allow_video_generate: allow_video,
            action_invocation_id: None,
            action_context: None,
            client_source: PluginBridgeClientSource::PluginRuntime,
            expires_at: Instant::now() + Duration::from_secs(60),
        }
    }

    #[test]
    fn route_video_generate_denied_without_capability() {
        // 未声明 video.generate（allow_video_generate=false）时，POST /video/generate 应 403。
        let session = video_session("http://127.0.0.1:0".to_string(), false);
        let body = serde_json::to_vec(&json!({
            "image": "aGVsbG8=", "video": "d29ybGQ=", "seconds": 10, "model": "fast"
        }))
        .unwrap();
        let error = route_video_generate(&session, body).unwrap_err();
        assert_eq!(error.status, 403);
        assert_eq!(error.code, "capability_denied");
    }

    #[test]
    fn route_video_generate_denied_via_route_request_gate() {
        // 经 route_request 分发：未声明 video.generate → POST /video/generate 应 403。
        let bridge = PluginLlmBridge::new();
        let token = insert_test_session(&bridge, false, false, false);
        let mut headers = HashMap::new();
        headers.insert("x-lingfang-plugin-token".to_string(), token);
        let request = HttpRequest {
            method: "POST".to_string(),
            path: "/video/generate".to_string(),
            headers,
            body: b"{\"image\":\"a\",\"video\":\"b\",\"seconds\":1,\"model\":\"fast\"}".to_vec(),
        };
        let error = route_request(&bridge.inner, request).unwrap_err();
        assert_eq!(error.status, 403);
        assert_eq!(error.code, "capability_denied");
    }

    #[test]
    fn route_video_generate_rejects_invalid_input() {
        // 声明 video.generate 但 body 缺字段 → 400（不触发计费/转发）。
        let session = video_session("http://127.0.0.1:0".to_string(), true);
        let case = |body: Value| route_video_generate(&session, serde_json::to_vec(&body).unwrap());
        // 缺 seconds
        assert_eq!(case(json!({ "image": "aGk=", "video": "Ymo=" })).unwrap_err().status, 400);
        // seconds 非正
        assert_eq!(case(json!({ "image": "aGk=", "video": "Ymo=", "seconds": 0 })).unwrap_err().status, 400);
        // 缺 image
        assert_eq!(case(json!({ "video": "Ymo=", "seconds": 5 })).unwrap_err().status, 400);
        // 缺 video
        assert_eq!(case(json!({ "image": "aGk=", "seconds": 5 })).unwrap_err().status, 400);
        // 非法 tier
        assert_eq!(case(json!({ "image": "aGk=", "video": "Ymo=", "seconds": 5, "model": "gpt-4o" })).unwrap_err().status, 400);
    }

    #[test]
    fn route_video_generate_billing_402_does_not_forward_to_rbflow() {
        // relay 计费返回 402 insufficient_balance → 桥直接透传 402，不读 RBFLow env、不转发。
        // (计费失败必不转发；插件拦截不提交。)
        let _guard = RBFLOW_ENV_GUARD.lock().unwrap();
        let (endpoint, request_rx) = spawn_relay_response(
            402,
            json!({ "code": "insufficient_balance", "message": "团队额度不足", "requestId": "req-bill" }),
        );
        // 临时设置 RBFLow env（验证计费失败路径不触碰它）。
        std::env::set_var("LINGFANG_RBFLOW_URL", "http://127.0.0.1:1");
        std::env::set_var("LINGFANG_RBFLOW_API_KEY", "should-not-be-used");
        let session = video_session(endpoint, true);
        let body = serde_json::to_vec(&json!({
            "image": "aGk=", "video": "Ymo=", "seconds": 30, "model": "fast"
        }))
        .unwrap();
        let error = route_video_generate(&session, body).unwrap_err();
        std::env::remove_var("LINGFANG_RBFLOW_URL");
        std::env::remove_var("LINGFANG_RBFLOW_API_KEY");
        assert_eq!(error.status, 402);
        assert_eq!(error.code, "insufficient_balance");
        assert_eq!(error.message, "团队额度不足");
        // 仅收到一次计费请求（/api/relay/v1/videos/generations）。
        let request = request_rx.recv_timeout(Duration::from_secs(2)).expect("应收到计费请求");
        assert!(request.path.starts_with("/api/relay/v1/videos/generations"));
        let bill_body: Value = serde_json::from_slice(&request.body).unwrap();
        assert_eq!(bill_body["model"], "fast");
        // seconds 透传（桥不 clamp，relay 侧 clamp≥1）；按数值比较兼容整数/浮点表示。
        assert_eq!(bill_body["seconds"].as_f64(), Some(30.0));
    }

    /// 启动一个多请求测试 relay：按收到的请求顺序返回预设响应，并收集所有请求。
    fn spawn_relay_sequence(responses: Vec<(u16, Value)>) -> (String, std::sync::Arc<std::sync::Mutex<Vec<HttpRequest>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("应启动测试 relay");
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let captured = std::sync::Arc::new(std::sync::Mutex::new(Vec::<HttpRequest>::new()));
        let captured_clone = std::sync::Arc::clone(&captured);
        thread::spawn(move || {
            for (status, body) in responses {
                if let Ok((mut stream, _)) = listener.accept() {
                    if let Ok(request) = read_request(&mut stream) {
                        captured_clone.lock().unwrap().push(request);
                    }
                    let _ = stream.write_all(http_json(status, &body).as_bytes());
                    let _ = stream.flush();
                }
            }
        });
        (endpoint, captured)
    }

    #[test]
    fn route_video_generate_refunds_when_rbflow_not_configured() {
        // 计费成功 → RBFLow 凭证缺失（部署错误）→ 应**先退款再报 503**，避免扣费无服务。
        let _guard = RBFLOW_ENV_GUARD.lock().unwrap();
        std::env::remove_var("LINGFANG_RBFLOW_URL");
        std::env::remove_var("LINGFANG_RBFLOW_API_KEY");
        let (endpoint, captured) = spawn_relay_sequence(vec![
            // 1) 计费成功
            (200, json!({ "charged": true, "credits": 5, "call_log_id": "vlog-refund", "seconds": 10, "request_id": "req-1" })),
            // 2) 退款成功
            (200, json!({ "refunded": true, "credits": 5, "call_log_id": "vlog-refund" })),
        ]);
        let session = video_session(endpoint, true);
        let body = serde_json::to_vec(&json!({
            "image": "aGk=", "video": "Ymo=", "seconds": 10, "model": "fast"
        }))
        .unwrap();
        let error = route_video_generate(&session, body).unwrap_err();
        assert_eq!(error.status, 503);
        assert_eq!(error.code, "rbflow_not_configured");
        let captured = captured.lock().unwrap();
        assert_eq!(captured.len(), 2, "应收到计费 + 退款两个请求");
        assert!(captured[0].path.starts_with("/api/relay/v1/videos/generations"));
        assert!(captured[1].path.starts_with("/api/relay/v1/videos/refund"));
        let refund_body: Value = serde_json::from_slice(&captured[1].body).unwrap();
        assert_eq!(refund_body["call_log_id"], "vlog-refund");
    }

    #[test]
    fn route_video_generate_refunds_on_rbflow_forward_failure() {
        // 计费成功 + RBFLow 凭证已配 → 但 RBFLow 实例不可达（连接失败）→ 应退款并报 502。
        let _guard = RBFLOW_ENV_GUARD.lock().unwrap();
        // 用一个几乎必然不可达的地址（端口 0 不可连；reqwest blocking 会失败）。
        std::env::set_var("LINGFANG_RBFLOW_URL", "http://127.0.0.1:9");
        std::env::set_var("LINGFANG_RBFLOW_API_KEY", "test-key");
        let (endpoint, captured) = spawn_relay_sequence(vec![
            (200, json!({ "charged": true, "credits": 5, "call_log_id": "vlog-fwd", "seconds": 10, "request_id": "req-1" })),
            (200, json!({ "refunded": true, "credits": 5, "call_log_id": "vlog-fwd" })),
        ]);
        let session = video_session(endpoint, true);
        let body = serde_json::to_vec(&json!({
            "image": "aGk=", "video": "Ymo=", "seconds": 10, "model": "fast"
        }))
        .unwrap();
        let error = route_video_generate(&session, body).unwrap_err();
        std::env::remove_var("LINGFANG_RBFLOW_URL");
        std::env::remove_var("LINGFANG_RBFLOW_API_KEY");
        assert_eq!(error.status, 502);
        assert_eq!(error.code, "rbflow_forward_failed");
        let captured = captured.lock().unwrap();
        assert_eq!(captured.len(), 2, "应收到计费 + 退款两个请求");
        assert!(captured[1].path.starts_with("/api/relay/v1/videos/refund"));
    }

    #[test]
    fn plugin_env_whitelist_never_includes_rbflow_credentials() {
        // 防绕过审计：minimal_env() 是插件进程 env 白名单，断言不含 LINGFANG_RBFLOW_*，
        // 也不含任何 TOKEN/KEY 类宿主密钥。即使桌面进程设置了这些 env，env_clear 也会清掉。
        // （minimal_env 是 plugin_runner.rs 的白名单；plugin_script.rs 复用同一函数。）
        let _guard = RBFLOW_ENV_GUARD.lock().unwrap();
        // 设置一个「宿主」RBFLow env，确认它不进白名单。
        std::env::set_var("LINGFANG_RBFLOW_URL", "http://rbflow.internal");
        std::env::set_var("LINGFANG_RBFLOW_API_KEY", "host-secret");
        let env = crate::plugin_runner::minimal_env();
        std::env::remove_var("LINGFANG_RBFLOW_URL");
        std::env::remove_var("LINGFANG_RBFLOW_API_KEY");
        for (key, _value) in &env {
            let key = key.to_string_lossy();
            assert!(
                !key.starts_with("LINGFANG_RBFLOW"),
                "插件 env 白名单绝不应包含 RBFLow 凭证，但发现：{key}"
            );
            assert!(
                !key.contains("SECRET") && !key.contains("KEY"),
                "插件 env 白名单不应包含密钥类变量：{key}"
            );
        }
        // 白名单只含 OS 路径/locale 类变量。
        let keys: Vec<String> = env.iter().map(|(k, _)| k.to_string_lossy().to_string()).collect();
        assert!(keys.iter().any(|k| k == "PATH"));
    }

    #[test]
    fn route_video_stream_denied_without_capability_and_requires_get() {
        // 未声明 video.generate → GET /video/stream 应 403（而非路由放行）。
        // 经 route_request：未声明 → 走 capability gate 前先 ensure session 命中 403。
        let bridge = PluginLlmBridge::new();
        let token = insert_test_session(&bridge, false, false, false);
        let mut headers = HashMap::new();
        headers.insert("x-lingfang-plugin-token".to_string(), token);
        let request = HttpRequest {
            method: "GET".to_string(),
            path: "/video/stream?task_id=abc".to_string(),
            headers,
            body: Vec::new(),
        };
        let error = route_request(&bridge.inner, request).unwrap_err();
        assert_eq!(error.status, 403);
        assert_eq!(error.code, "capability_denied");
    }

    #[test]
    fn route_video_endpoints_reject_post() {
        // /video/stream 与 /video/download 只允许 GET；POST 应被 method 守卫 404 拒绝。
        let bridge = PluginLlmBridge::new();
        let token = insert_test_session(&bridge, false, false, true);
        let mut headers = HashMap::new();
        headers.insert("x-lingfang-plugin-token".to_string(), token);
        for path in ["/video/stream", "/video/download"] {
            let request = HttpRequest {
                method: "POST".to_string(),
                path: path.to_string(),
                headers: headers.clone(),
                body: Vec::new(),
            };
            let error = route_request(&bridge.inner, request).unwrap_err();
            assert_eq!(error.status, 404, "POST {path} 应被 method 守卫拒绝");
            assert_eq!(error.code, "not_found");
        }
    }

    #[test]
    fn parse_sse_events_aggregates_data_blocks() {
        // SSE 文本 → JSON 事件数组（MVP 聚合方案，桥不支持真 SSE 流）。
        let sse = "data: {\"progress\": 10}\n\ndata: {\"progress\": 50}\n\ndata: [DONE]\n\n";
        let events = parse_sse_events(sse);
        assert_eq!(events.len(), 3);
        assert_eq!(events[0]["progress"], 10);
        assert_eq!(events[1]["progress"], 50);
        // 非 JSON 的 data 行保留原始字符串。
        assert_eq!(events[2], Value::String("[DONE]".to_string()));
    }

    #[test]
    fn build_rbflow_multipart_has_image_and_video_parts() {
        // RBFLow 提交 multipart 含 image + video 两个 file part（字段名固定）。
        let (body, content_type) = build_rbflow_multipart(
            "ref.jpg",
            "image/jpeg",
            b"img-bytes",
            "motion.mp4",
            "video/mp4",
            b"vid-bytes",
            Some("http://cb.example"),
        );
        let text = String::from_utf8_lossy(&body);
        assert!(text.contains("name=\"image\"; filename=\"ref.jpg\""));
        assert!(text.contains("name=\"video\"; filename=\"motion.mp4\""));
        assert!(text.contains("img-bytes"));
        assert!(text.contains("vid-bytes"));
        assert!(text.contains("name=\"callback_url\""));
        assert!(content_type.starts_with("multipart/form-data; boundary=lfVideoGenerate"));
    }

    #[test]
    fn sanitize_task_id_rejects_path_injection() {
        // task_id 含路径分隔符/特殊字符应被拒（防注入到 RBFLow URL 路径段）。
        assert!(sanitize_task_id("task-123".to_string()).is_ok());
        assert!(sanitize_task_id("abc_DEF-001".to_string()).is_ok());
        assert!(sanitize_task_id("../etc".to_string()).is_err());
        assert!(sanitize_task_id("a/b".to_string()).is_err());
        assert!(sanitize_task_id("a b".to_string()).is_err());
        assert!(sanitize_task_id("".to_string()).is_err());
    }

    #[test]
    fn query_first_extracts_task_id_from_path() {
        assert_eq!(
            query_first("/video/stream?task_id=abc-1", "task_id").as_deref(),
            Some("abc-1")
        );
        assert_eq!(
            query_first("/video/download?task_id=x&other=y", "task_id").as_deref(),
            Some("x")
        );
        assert!(query_first("/video/stream", "task_id").is_none());
        assert!(query_first("/video/stream?other=y", "task_id").is_none());
    }
}
