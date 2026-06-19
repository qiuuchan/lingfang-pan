use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{atomic::AtomicBool, Arc, Mutex};
use std::time::Duration;

use super::runtime::is_loopback_url;
use super::runtime::{run_sdk_turn, EngineEventSink, RunRequest};
use super::SdkCredentials;
use crate::code_assistant::store::AssistantStore;
use crate::code_assistant::types::CodeAssistantTool;

const REQUEST_BUFFER_BYTES: usize = 1024;
const REQUEST_CAPTURE_TIMEOUT: Duration = Duration::from_secs(2);

struct NoopEngineSink;

impl EngineEventSink for NoopEngineSink {
    fn output(&self, _stream: &'static str, _text: String) {}

    fn error(&self, _message: String) {}
}

#[derive(Clone, Default)]
struct CaptureEngineSink {
    outputs: Arc<Mutex<Vec<(String, String)>>>,
}

impl CaptureEngineSink {
    fn outputs(&self) -> Vec<(String, String)> {
        self.outputs
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone()
    }
}

impl EngineEventSink for CaptureEngineSink {
    fn output(&self, stream: &'static str, text: String) {
        self.outputs
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .push((stream.to_string(), text));
    }

    fn error(&self, message: String) {
        self.output("stderr", message);
    }
}

#[test]
fn claude_requests_use_anthropic_api_key_header() {
    let server = capture_single_request();
    let request = RunRequest {
        session_id: "s-header".into(),
        tool: CodeAssistantTool::Claude,
        model: Some("claude-sonnet-4-5".into()),
        workspace_dir: temp_store("claude-header")
            .root()
            .to_string_lossy()
            .to_string(),
        prompt: "ping".into(),
        system_prompt: None,
        credentials: SdkCredentials {
            api_key: "sk-test".into(),
            api_url: server.api_url,
        },
        store: temp_store("claude-header-store"),
        cancel: Arc::new(AtomicBool::new(false)),
    };

    let result = tauri::async_runtime::block_on(run_sdk_turn(request, NoopEngineSink));

    assert!(result.is_ok(), "request should finish: {result:?}");
    let raw = server
        .received
        .recv_timeout(REQUEST_CAPTURE_TIMEOUT)
        .expect("server should capture request");
    let headers = header_section(&raw).to_ascii_lowercase();
    assert!(
        headers.contains("x-api-key: sk-test"),
        "Anthropic requests must send x-api-key header:\n{headers}"
    );
    assert!(
        !headers.contains("authorization: bearer sk-test"),
        "Anthropic requests should not use bearer auth:\n{headers}"
    );
}

#[test]
fn claude_uses_configured_api_url_without_provider_rewrite() {
    let server = capture_single_request();
    let request = RunRequest {
        session_id: "s-configured-url".into(),
        tool: CodeAssistantTool::Claude,
        model: Some("kimi-k2.7-code".into()),
        workspace_dir: temp_store("claude-configured-url")
            .root()
            .to_string_lossy()
            .to_string(),
        prompt: "ping".into(),
        system_prompt: None,
        credentials: SdkCredentials {
            api_key: "sk-test".into(),
            api_url: format!("{}/v1", server.api_url),
        },
        store: temp_store("claude-configured-url-store"),
        cancel: Arc::new(AtomicBool::new(false)),
    };

    let result = tauri::async_runtime::block_on(run_sdk_turn(request, NoopEngineSink));

    assert!(result.is_ok(), "request should finish: {result:?}");
    let raw = server
        .received
        .recv_timeout(REQUEST_CAPTURE_TIMEOUT)
        .expect("server should capture request");
    assert!(
        raw.starts_with("POST /v1/messages HTTP/1.1"),
        "ClaudeCode should use the configured API URL as-is:\n{raw}"
    );
}

#[test]
fn openai_tool_execution_result_is_emitted_to_tool_stream() {
    let server = openai_tool_then_done_server();
    let store = temp_store("openai-tool-result-store");
    let workspace = temp_workspace("openai-tool-result-workspace");
    std::fs::write(workspace.join("note.txt"), "hello from file").unwrap();
    let request = RunRequest {
        session_id: "s-openai-tool-result".into(),
        tool: CodeAssistantTool::Codex,
        model: Some("gpt-5.1".into()),
        workspace_dir: workspace.to_string_lossy().to_string(),
        prompt: "read note".into(),
        system_prompt: None,
        credentials: SdkCredentials {
            api_key: "sk-test".into(),
            api_url: server.api_url,
        },
        store,
        cancel: Arc::new(AtomicBool::new(false)),
    };
    let sink = CaptureEngineSink::default();

    let result = tauri::async_runtime::block_on(run_sdk_turn(request, sink.clone()));

    assert!(result.is_ok(), "request should finish: {result:?}");
    let outputs = sink.outputs();
    assert!(
        outputs.iter().any(|(stream, text)| {
            stream == "tool"
                && text.starts_with("read_file_result ")
                && text.contains("hello from file")
        }),
        "tool result should be visible in tool stream: {outputs:?}"
    );
}

#[test]
fn sdk_client_disables_proxy_for_loopback_urls() {
    assert!(is_loopback_url("http://127.0.0.1:11434/v1/messages"));
    assert!(is_loopback_url(
        "http://localhost:11434/v1/chat/completions"
    ));
    assert!(is_loopback_url("http://[::1]:11434/v1/messages"));
    assert!(!is_loopback_url("https://api.example.com/v1/messages"));
}

struct CapturedRequestServer {
    api_url: String,
    received: std::sync::mpsc::Receiver<String>,
}

fn capture_single_request() -> CapturedRequestServer {
    let listener = TcpListener::bind("127.0.0.1:0").expect("test server should bind");
    let addr = listener.local_addr().expect("test server should have addr");
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("test server should accept");
        let raw = read_request(&mut stream);
        tx.send(raw).expect("request should send to test");
        write_success_sse(&mut stream);
    });
    CapturedRequestServer {
        api_url: format!("http://{addr}"),
        received: rx,
    }
}

fn openai_tool_then_done_server() -> CapturedRequestServer {
    let listener = TcpListener::bind("127.0.0.1:0").expect("test server should bind");
    let addr = listener.local_addr().expect("test server should have addr");
    let (tx, rx) = std::sync::mpsc::sync_channel(2);
    std::thread::spawn(move || {
        for index in 0..2 {
            let (mut stream, _) = listener.accept().expect("test server should accept");
            let raw = read_request(&mut stream);
            tx.send(raw).expect("request should send to test");
            if index == 0 {
                write_openai_tool_call_sse(&mut stream);
            } else {
                write_openai_done_sse(&mut stream);
            }
        }
    });
    CapturedRequestServer {
        api_url: format!("http://{addr}"),
        received: rx,
    }
}

fn read_request(stream: &mut TcpStream) -> String {
    let mut bytes = Vec::new();
    let mut buf = [0_u8; REQUEST_BUFFER_BYTES];
    while !bytes.windows(4).any(|window| window == b"\r\n\r\n") {
        let read = stream.read(&mut buf).expect("request should be readable");
        assert_ne!(read, 0, "request ended before headers");
        bytes.extend_from_slice(&buf[..read]);
    }
    let headers_end = headers_end(&bytes);
    let content_length = content_length(&bytes[..headers_end]);
    while bytes.len() < headers_end + content_length {
        let read = stream.read(&mut buf).expect("body should be readable");
        assert_ne!(read, 0, "request ended before body");
        bytes.extend_from_slice(&buf[..read]);
    }
    String::from_utf8_lossy(&bytes).to_string()
}

fn headers_end(bytes: &[u8]) -> usize {
    bytes
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| index + 4)
        .expect("request should contain headers terminator")
}

fn content_length(headers: &[u8]) -> usize {
    let raw = String::from_utf8_lossy(headers);
    raw.lines()
        .find_map(|line| line.strip_prefix("content-length: "))
        .and_then(|value| value.trim().parse::<usize>().ok())
        .unwrap_or(0)
}

fn header_section(raw: &str) -> &str {
    raw.split_once("\r\n\r\n")
        .map(|(headers, _)| headers)
        .expect("request should contain headers")
}

fn write_success_sse(stream: &mut TcpStream) {
    let body = "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}\n\n";
    let response = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\n\r\n{}",
        body.len(),
        body
    );
    stream
        .write_all(response.as_bytes())
        .expect("response should be writable");
}

fn write_openai_tool_call_sse(stream: &mut TcpStream) {
    let body = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"read_file\",\"arguments\":\"\"}}]}}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"path\\\":\\\"note.txt\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
        "data: [DONE]\n\n",
    );
    write_sse_response(stream, body);
}

fn write_openai_done_sse(stream: &mut TcpStream) {
    let body = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"done\"}}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n",
    );
    write_sse_response(stream, body);
}

fn write_sse_response(stream: &mut TcpStream, body: &str) {
    let response = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\n\r\n{}",
        body.len(),
        body
    );
    stream
        .write_all(response.as_bytes())
        .expect("response should be writable");
}

fn temp_store(name: &str) -> AssistantStore {
    let root = std::env::temp_dir().join(format!(
        "lingfang-engine-test-{name}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&root);
    AssistantStore::new(root).expect("store should initialize")
}

fn temp_workspace(name: &str) -> std::path::PathBuf {
    let root = std::env::temp_dir().join(format!(
        "lingfang-engine-workspace-{name}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).expect("workspace should initialize");
    root
}
