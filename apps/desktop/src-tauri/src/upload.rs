//! 插件上传（带进度推送）。
//!
//! 与 update.rs 的 download_update 对称：用 reqwest 流式 POST JSON body 到后端
//! `/api/plugins/upload`，通过 `Channel<UploadEvent>` 向前端推送字节级进度。
//!
//! 为什么不走前端 fetch：fetch 无法获取上传进度（只有下载侧能 stream）。
//! reqwest 的 `Body::wrap_stream` 可以把 payload 包装成异步 stream，
//! 在 stream 产出每个 chunk 时 emit Progress 事件，实现真实上传进度。
//!
//! 设计：
//! - 前端把完整 payload（{manifest, files, priceCents}）作为 serde_json::Value 传入。
//! - Rust 序列化为 bytes → 切成 64KB chunk → wrap_stream 包装 → reqwest POST。
//! - 每个 chunk yield 时 emit Progress { chunk_length }；开始时 emit Started { total_bytes }。
//! - 后端响应 JSON 通过 Finished 事件返回前端（前端从中取 plugin.id 等）。

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

/// 上传进度事件（Channel 推送，serde 契约与 DownloadEvent 同模式）。
#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum UploadEvent {
    /// 上传开始：total_bytes 为 payload 序列化后的总字节数。
    #[serde(rename_all = "camelCase")]
    Started { total_bytes: u64 },
    /// 每发送一个 chunk：chunk_length 为本次块字节数（前端累加算已上传量）。
    #[serde(rename_all = "camelCase")]
    Progress { chunk_length: usize },
    /// 上传完成 + 后端返回 2xx：response 为后端 JSON 响应体。
    #[serde(rename_all = "camelCase")]
    Finished { response: serde_json::Value },
}

/// upload_plugin 命令入参（前端传入的完整上传 payload）。
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadPayload {
    pub manifest: serde_json::Value,
    pub files: Vec<serde_json::Value>,
    pub price_cents: i64,
}

/// 单个 chunk 的大小（64KB）。平衡进度更新频率与 Channel 开销。
const CHUNK_SIZE: usize = 64 * 1024;

/// 命令：上传插件到后端（带进度推送）。
///
/// 流程：
/// 1. 序列化 payload 为 bytes → emit Started { total_bytes }。
/// 2. 用 wrap_stream 把 bytes 切成 64KB chunk 流式发送，每 chunk emit Progress。
/// 3. 后端 2xx → emit Finished { response }；非 2xx → Err（带后端 error message）。
///
/// 超时 600s（大插件 200MB 在慢网络下需要较长时间）。
#[tauri::command]
pub async fn upload_plugin(
    api_base: String,
    auth_token: String,
    payload: UploadPayload,
    on_event: Channel<UploadEvent>,
) -> Result<serde_json::Value, String> {
    // 序列化 payload 为 bytes（与前端 JSON.stringify 等价，但由 Rust 侧做以避免前端传 bytes 跨 IPC）。
    let body_bytes = serde_json::to_vec(&payload).map_err(|e| format!("序列化上传 payload 失败：{e}"))?;
    let total_bytes = body_bytes.len() as u64;

    let _ = on_event.send(UploadEvent::Started { total_bytes });

    // 构建流式 body：把 bytes 切成 chunk，每 yield 一个 emit Progress。
    // wrap_stream 接受 Stream<Item = Result<Bytes, E>>，这里用 futures util 的 stream。
    let on_event_clone = on_event.clone();
    let chunk_stream = futures_util::stream::unfold(
        (body_bytes, 0usize),
        move |(data, mut offset)| {
            let on_event = on_event_clone.clone();
            async move {
                if offset >= data.len() {
                    return None;
                }
                let end = std::cmp::min(offset + CHUNK_SIZE, data.len());
                let chunk = &data[offset..end];
                let take = end - offset;
                offset = end;
                let _ = on_event.send(UploadEvent::Progress { chunk_length: take });
                Some((Ok::<bytes::Bytes, std::io::Error>(bytes::Bytes::copy_from_slice(chunk)), (data, offset)))
            }
        },
    );

    let stream_body = reqwest::Body::wrap_stream(chunk_stream);

    let url = format!("{}/api/plugins/upload", api_base.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败：{e}"))?;

    let resp = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("X-Client", "desktop")
        .bearer_auth(auth_token.trim())
        .body(stream_body)
        .send()
        .await
        .map_err(|e| format!("上传请求失败：{e}"))?;

    let status = resp.status();
    let response_json: serde_json::Value = resp.json().await.map_err(|e| {
        format!("解析后端响应失败（HTTP {status}）：{e}")
    })?;

    if !status.is_success() {
        let message = response_json
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or_else(|| response_json.as_str().unwrap_or("未知错误"));
        let code = response_json
            .get("code")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        return Err(format!("上传失败（HTTP {status}，{code}）：{message}"));
    }

    let _ = on_event.send(UploadEvent::Finished {
        response: response_json.clone(),
    });

    Ok(response_json)
}

// === 单元测试 ===
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upload_event_started_serializes() {
        let ev = UploadEvent::Started { total_bytes: 1024 };
        let json = serde_json::to_string(&ev).unwrap();
        assert!(json.contains(r#""event":"Started""#));
        assert!(json.contains(r#""totalBytes":1024"#));
    }

    #[test]
    fn upload_event_progress_serializes() {
        let ev = UploadEvent::Progress { chunk_length: 65536 };
        let json = serde_json::to_string(&ev).unwrap();
        assert!(json.contains(r#""event":"Progress""#));
        assert!(json.contains(r#""chunkLength":65536"#));
    }

    #[test]
    fn upload_event_finished_serializes() {
        let ev = UploadEvent::Finished {
            response: serde_json::json!({"plugin": {"id": "abc"}}),
        };
        let json = serde_json::to_string(&ev).unwrap();
        assert!(json.contains(r#""event":"Finished""#));
        assert!(json.contains(r#""plugin":{"id":"abc"}"#));
    }

    #[test]
    fn upload_payload_deserializes() {
        let json = r#"{"manifest":{"id":"test"},"files":[{"path":"x.js","content":"y"}],"priceCents":0}"#;
        let payload: UploadPayload = serde_json::from_str(json).unwrap();
        assert_eq!(payload.price_cents, 0);
        assert_eq!(payload.files.len(), 1);
    }
}
