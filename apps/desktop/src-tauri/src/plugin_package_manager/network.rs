use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;

use futures_util::StreamExt;
use serde_json::Value;
use tauri::ipc::Channel;
use uuid::Uuid;

use super::{
    DownloadReleaseInput, InstallArtifactInput, LocalInstallation, PackageTransferEvent,
    PluginPackageManager, PublishWorkspaceInput,
};

#[tauri::command]
pub(crate) async fn download_plugin_release(
    manager: tauri::State<'_, PluginPackageManager>,
    input: DownloadReleaseInput,
    on_event: Channel<PackageTransferEvent>,
) -> Result<LocalInstallation, String> {
    let manager = manager.inner().clone();
    let _ = on_event.send(PackageTransferEvent::Stage {
        stage: "downloading".to_string(),
        message: "正在下载插件制品".to_string(),
    });
    let url = format!(
        "{}/api/plugin-releases/{}/artifact",
        input.api_base.trim_end_matches('/'),
        input.release_id
    );
    let response = reqwest::Client::new()
        .get(url)
        .bearer_auth(input.auth_token.trim())
        .header("X-Client", "desktop")
        .send()
        .await
        .map_err(|error| format!("下载插件制品失败：{error}"))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("下载插件制品失败（HTTP {status}）：{body}"));
    }
    let total = response.content_length();
    let _ = on_event.send(PackageTransferEvent::Started { total_bytes: total });
    let staging = manager
        .staging_root()
        .join(format!("download-{}", Uuid::new_v4()));
    fs::create_dir_all(&staging).map_err(|error| format!("创建下载暂存目录失败：{error}"))?;
    let artifact_path = staging.join("artifact.lfplugin");
    let mut output = fs::File::create(&artifact_path)
        .map_err(|error| format!("创建下载暂存文件失败：{error}"))?;
    let mut stream = response.bytes_stream();
    let download_result = async {
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| format!("接收插件制品失败：{error}"))?;
            output
                .write_all(&chunk)
                .map_err(|error| format!("写入插件制品失败：{error}"))?;
            let _ = on_event.send(PackageTransferEvent::Progress {
                chunk_length: chunk.len(),
            });
        }
        output
            .flush()
            .map_err(|error| format!("刷新插件制品失败：{error}"))
    }
    .await;
    if let Err(error) = download_result {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    let _ = on_event.send(PackageTransferEvent::Stage {
        stage: "verifying".to_string(),
        message: "正在校验 SHA-256 和 ZIP 结构".to_string(),
    });
    let release_id = input.release_id.clone();
    let installed = manager.install(InstallArtifactInput {
        artifact_path: artifact_path.to_string_lossy().to_string(),
        expected_sha256: Some(input.sha256),
        package_id: Some(input.package_id.clone()),
        release_id: Some(release_id.clone()),
        origin: input.origin,
        protected: false,
    });
    let _ = fs::remove_dir_all(staging);
    let installed = match installed {
        Ok(value) => value,
        Err(error) => {
            if error.contains("SHA-256") {
                let _ = reqwest::Client::new()
                    .post(format!(
                        "{}/api/plugin-releases/{}/report-integrity-failure",
                        input.api_base.trim_end_matches('/'),
                        release_id
                    ))
                    .bearer_auth(input.auth_token.trim())
                    .json(&serde_json::json!({ "detail": error }))
                    .send()
                    .await;
            }
            return Err(error);
        }
    };
    let _ = on_event.send(PackageTransferEvent::Finished);
    Ok(installed)
}

#[tauri::command]
pub(crate) async fn publish_draft_workspace(
    manager: tauri::State<'_, PluginPackageManager>,
    input: PublishWorkspaceInput,
    on_event: Channel<PackageTransferEvent>,
) -> Result<Value, String> {
    let manager = manager.inner().clone();
    let _ = on_event.send(PackageTransferEvent::Stage {
        stage: "packing".to_string(),
        message: "正在生成 .lfplugin v4 制品".to_string(),
    });
    let packed = manager.pack_workspace(&input.workspace_id, None)?;
    let version = packed
        .artifact
        .manifest
        .get("version")
        .and_then(Value::as_str)
        .ok_or_else(|| "manifest.version 缺失".to_string())?
        .to_string();
    manager.ensure_workspace_publishable(&input.workspace_id, &version, &packed.artifact.sha256)?;
    let path = PathBuf::from(&packed.artifact_path);
    let total_bytes = fs::metadata(&path)
        .map_err(|error| format!("读取待上传制品失败：{error}"))?
        .len();
    let _ = on_event.send(PackageTransferEvent::Started {
        total_bytes: Some(total_bytes),
    });
    let file = fs::File::open(&path).map_err(|error| format!("读取待上传制品失败：{error}"))?;
    let event = on_event.clone();
    let stream = futures_util::stream::unfold(file, move |mut file| {
        let event = event.clone();
        async move {
            let mut buffer = vec![0_u8; 64 * 1024];
            match file.read(&mut buffer) {
                Ok(0) => None,
                Ok(read) => {
                    buffer.truncate(read);
                    let _ = event.send(PackageTransferEvent::Progress { chunk_length: read });
                    Some((
                        Ok::<bytes::Bytes, std::io::Error>(bytes::Bytes::from(buffer)),
                        file,
                    ))
                }
                Err(error) => Some((Err(error), file)),
            }
        }
    });
    let url = format!(
        "{}/api/plugin-registry/releases",
        input.api_base.trim_end_matches('/')
    );
    let mut request = reqwest::Client::new()
        .post(url)
        .bearer_auth(input.auth_token.trim())
        .header("X-Client", "desktop")
        .header("Content-Type", "application/vnd.lingfang.plugin+zip")
        .header("Content-Length", total_bytes)
        .body(reqwest::Body::wrap_stream(stream));
    if let Some(package_id) = input.package_id.as_deref() {
        request = request.header("X-Plugin-Package-Id", package_id);
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("上传插件制品失败：{error}"))?;
    let status = response.status();
    let response_json: Value = response
        .json()
        .await
        .map_err(|error| format!("解析发布响应失败（HTTP {status}）：{error}"))?;
    if !status.is_success() {
        let message = response_json
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("未知错误");
        return Err(format!("发布插件失败（HTTP {status}）：{message}"));
    }
    let release = response_json
        .get("release")
        .ok_or_else(|| "发布响应缺少 release".to_string())?;
    let release_id = release
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "发布响应缺少 release.id".to_string())?;
    let release_version = release
        .get("version")
        .and_then(Value::as_str)
        .ok_or_else(|| "发布响应缺少 release.version".to_string())?;
    manager.mark_workspace_published(
        &input.workspace_id,
        release_id,
        release_version,
        &packed.artifact.sha256,
    )?;
    let _ = on_event.send(PackageTransferEvent::Finished);
    Ok(response_json)
}
