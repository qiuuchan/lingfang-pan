//! Portable Python/Node download, checksum verification, extraction and activation.

use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::ipc::Channel;

use crate::runtime_config::{runtime_data_root, ManagedEntry, RuntimeConfigStore};

const NODE_DEFAULT_VERSION: &str = "22.21.1";
const PYTHON_DEFAULT_VERSION: &str = "3.12.13+20260623";

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeKind {
    Python,
    Nodejs,
}

impl RuntimeKind {
    pub fn id(self) -> &'static str {
        match self {
            Self::Python => "python",
            Self::Nodejs => "nodejs",
        }
    }

    fn default_version(self) -> &'static str {
        match self {
            Self::Python => PYTHON_DEFAULT_VERSION,
            Self::Nodejs => NODE_DEFAULT_VERSION,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum RuntimeDownloadEvent {
    Started { kind: String, total: Option<u64> },
    Progress { kind: String, downloaded: u64, total: Option<u64> },
    Stage { kind: String, stage: String },
    Finished { kind: String, version: String },
}

struct Artifact {
    file_name: String,
    urls: Vec<String>,
    checksum_urls: Vec<String>,
    expected_checksum: Option<String>,
    archive: ArchiveKind,
}

enum ArchiveKind {
    Zip,
    TarGz,
}

pub async fn download_runtime<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    kind: RuntimeKind,
    version: Option<String>,
    on_event: Channel<RuntimeDownloadEvent>,
) -> Result<(), String> {
    let version = version.unwrap_or_else(|| kind.default_version().to_string());
    let artifact = artifact_for(kind, &version)?;
    let root = runtime_data_root(app);
    let download_dir = root.join(".download");
    let staging_root = root.join(".staging");
    fs::create_dir_all(&download_dir).map_err(|e| format!("创建下载目录失败：{e}"))?;
    fs::create_dir_all(&staging_root).map_err(|e| format!("创建暂存目录失败：{e}"))?;

    let expected = if let Some(checksum) = artifact.expected_checksum.as_ref() {
        checksum.clone()
    } else {
        let checksum_text = fetch_text_with_retry(&artifact.checksum_urls).await?;
        checksum_for(&checksum_text, &artifact.file_name)?
    };
    let archive_path = download_dir.join(format!("{}-{}.part", kind.id(), version));
    send_stage(&on_event, kind, "downloading");
    download_file_with_retry(&artifact.urls, &archive_path, kind, &on_event).await?;

    send_stage(&on_event, kind, "verifying");
    verify_sha256(&archive_path, &expected)?;

    let staging = staging_root.join(format!("{}-{}", kind.id(), version));
    if staging.exists() {
        fs::remove_dir_all(&staging).map_err(|e| format!("清理旧暂存目录失败：{e}"))?;
    }
    fs::create_dir_all(&staging).map_err(|e| format!("创建暂存目录失败：{e}"))?;
    send_stage(&on_event, kind, "extracting");
    let extract_result = match artifact.archive {
        ArchiveKind::Zip => extract_zip(&archive_path, &staging),
        ArchiveKind::TarGz => extract_tar_gz(&archive_path, &staging),
    };
    if let Err(error) = extract_result {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }

    let executable = executable_name(kind);
    let extracted_dir = find_executable_dir(&staging, executable)
        .ok_or_else(|| format!("运行时压缩包缺少 {executable}"))?;
    if matches!(kind, RuntimeKind::Python) && !has_bundled_pip(&extracted_dir) {
        let _ = fs::remove_dir_all(&staging);
        return Err("Python 运行时缺少 ensurepip 内置 pip wheel".to_string());
    }

    let target = root.join(format!("{}-{}", kind.id(), sanitize_version(&version)));
    if target.exists() {
        fs::remove_dir_all(&target).map_err(|e| format!("移除旧运行时失败：{e}"))?;
    }
    send_stage(&on_event, kind, "activating");
    fs::rename(&extracted_dir, &target).map_err(|e| format!("激活运行时失败：{e}"))?;
    let _ = fs::remove_dir_all(&staging);
    let _ = fs::remove_file(&archive_path);

    let store = RuntimeConfigStore::from_app(app)?;
    let mut config = store.read();
    let entry = ManagedEntry {
        version: version.clone(),
        dir: target.to_string_lossy().to_string(),
        installed_at: chrono::Utc::now().to_rfc3339(),
    };
    match kind {
        RuntimeKind::Python => config.app_managed_python = Some(entry),
        RuntimeKind::Nodejs => config.app_managed_node = Some(entry),
    }
    store.write(&config)?;
    on_event
        .send(RuntimeDownloadEvent::Finished { kind: kind.id().to_string(), version })
        .map_err(|e| format!("发送下载完成事件失败：{e}"))?;
    Ok(())
}

fn artifact_for(kind: RuntimeKind, version: &str) -> Result<Artifact, String> {
    match kind {
        RuntimeKind::Nodejs => {
            let file_name = format!("node-v{version}-win-x64.zip");
            Ok(Artifact {
                urls: vec![
                    format!("https://nodejs.org/dist/v{version}/{file_name}"),
                    format!("https://registry.npmmirror.com/-/binary/node/v{version}/{file_name}"),
                ],
                checksum_urls: vec![
                    format!("https://nodejs.org/dist/v{version}/SHASUMS256.txt"),
                    format!("https://registry.npmmirror.com/-/binary/node/v{version}/SHASUMS256.txt"),
                ],
                expected_checksum: None,
                file_name,
                archive: ArchiveKind::Zip,
            })
        }
        RuntimeKind::Python => {
            let (python_version, release) = version
                .split_once('+')
                .ok_or_else(|| "Python 版本必须是 <python>+<release> 格式".to_string())?;
            let file_name = format!(
                "cpython-{python_version}+{release}-x86_64-pc-windows-msvc-install_only_stripped.tar.gz"
            );
            let base = format!("https://github.com/astral-sh/python-build-standalone/releases/download/{release}");
            let expected_checksum = match version {
                "3.12.13+20260623" => "de3e362376859b060fa8b856c434efa81fcf6d4ede3d6e177c7e2169670cac50",
                _ => return Err("当前仅支持已固定校验摘要的 Python 3.12.13+20260623".to_string()),
            };
            Ok(Artifact {
                urls: vec![format!("{base}/{file_name}")],
                checksum_urls: vec![],
                expected_checksum: Some(expected_checksum.to_string()),
                file_name,
                archive: ArchiveKind::TarGz,
            })
        }
    }
}

async fn fetch_text_with_retry(urls: &[String]) -> Result<String, String> {
    let client = reqwest::Client::new();
    let mut last_error = String::new();
    for _ in 0..3 {
        for url in urls {
            match client.get(url).send().await.and_then(|r| r.error_for_status()) {
                Ok(response) => match response.text().await {
                    Ok(text) => return Ok(text),
                    Err(error) => last_error = error.to_string(),
                },
                Err(error) => last_error = error.to_string(),
            }
        }
    }
    Err(format!("获取运行时校验清单失败：{last_error}"))
}

async fn download_file_with_retry(
    urls: &[String],
    path: &Path,
    kind: RuntimeKind,
    on_event: &Channel<RuntimeDownloadEvent>,
) -> Result<(), String> {
    let client = reqwest::Client::new();
    let mut last_error = String::new();
    for _ in 0..3 {
        for url in urls {
            let _ = fs::remove_file(path);
            match client.get(url).send().await.and_then(|r| r.error_for_status()) {
                Ok(response) => {
                    let total = response.content_length();
                    let _ = on_event.send(RuntimeDownloadEvent::Started {
                        kind: kind.id().to_string(),
                        total,
                    });
                    let mut file = File::create(path).map_err(|e| format!("创建下载文件失败：{e}"))?;
                    let mut stream = response.bytes_stream();
                    let mut downloaded = 0_u64;
                    let mut failed = None;
                    while let Some(chunk) = stream.next().await {
                        match chunk {
                            Ok(chunk) => {
                                if let Err(error) = file.write_all(&chunk) {
                                    failed = Some(error.to_string());
                                    break;
                                }
                                downloaded += chunk.len() as u64;
                                let _ = on_event.send(RuntimeDownloadEvent::Progress {
                                    kind: kind.id().to_string(),
                                    downloaded,
                                    total,
                                });
                            }
                            Err(error) => {
                                failed = Some(error.to_string());
                                break;
                            }
                        }
                    }
                    if let Some(error) = failed {
                        last_error = error;
                    } else {
                        file.sync_all().map_err(|e| format!("同步下载文件失败：{e}"))?;
                        return Ok(());
                    }
                }
                Err(error) => last_error = error.to_string(),
            }
        }
    }
    let _ = fs::remove_file(path);
    Err(format!("下载运行时失败：{last_error}"))
}

fn checksum_for(manifest: &str, file_name: &str) -> Result<String, String> {
    manifest
        .lines()
        .find_map(|line| {
            let mut parts = line.split_whitespace();
            let hash = parts.next()?;
            let name = parts.next()?.trim_start_matches('*');
            (name == file_name).then(|| hash.to_ascii_lowercase())
        })
        .ok_or_else(|| format!("校验清单中没有 {file_name}"))
}

fn verify_sha256(path: &Path, expected: &str) -> Result<(), String> {
    let mut file = File::open(path).map_err(|e| format!("读取下载文件失败：{e}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|e| format!("计算摘要失败：{e}"))?;
        if count == 0 { break; }
        hasher.update(&buffer[..count]);
    }
    let actual = format!("{:x}", hasher.finalize());
    if actual != expected.to_ascii_lowercase() {
        return Err(format!("运行时 SHA256 校验失败：expected={expected}, actual={actual}"));
    }
    Ok(())
}

fn extract_zip(archive: &Path, target: &Path) -> Result<(), String> {
    let file = File::open(archive).map_err(|e| format!("打开 zip 失败：{e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("解析 zip 失败：{e}"))?;
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(|e| format!("读取 zip 条目失败：{e}"))?;
        let relative = entry.enclosed_name().ok_or_else(|| "zip 包含不安全路径".to_string())?;
        let output = target.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&output).map_err(|e| format!("创建解压目录失败：{e}"))?;
        } else {
            if let Some(parent) = output.parent() { fs::create_dir_all(parent).map_err(|e| format!("创建解压目录失败：{e}"))?; }
            let mut out = File::create(&output).map_err(|e| format!("创建解压文件失败：{e}"))?;
            std::io::copy(&mut entry, &mut out).map_err(|e| format!("解压 zip 失败：{e}"))?;
        }
    }
    Ok(())
}

fn extract_tar_gz(archive: &Path, target: &Path) -> Result<(), String> {
    let file = File::open(archive).map_err(|e| format!("打开 tar.gz 失败：{e}"))?;
    let decoder = flate2::read::GzDecoder::new(file);
    let mut tar = tar::Archive::new(decoder);
    tar.unpack(target).map_err(|e| format!("解压 tar.gz 失败：{e}"))
}

fn find_executable_dir(root: &Path, executable: &str) -> Option<PathBuf> {
    let mut pending = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        if dir.join(executable).is_file() { return Some(dir); }
        let entries = fs::read_dir(&dir).ok()?;
        for entry in entries.flatten() {
            if entry.file_type().ok()?.is_dir() { pending.push(entry.path()); }
        }
    }
    None
}

fn has_bundled_pip(dir: &Path) -> bool {
    let bundled = dir.join("Lib").join("ensurepip").join("_bundled");
    fs::read_dir(bundled).ok().into_iter().flatten().flatten().any(|entry| {
        entry.file_name().to_string_lossy().starts_with("pip-")
            && entry.path().extension().and_then(|v| v.to_str()) == Some("whl")
    })
}

fn executable_name(kind: RuntimeKind) -> &'static str {
    match kind {
        RuntimeKind::Python => "python.exe",
        RuntimeKind::Nodejs => "node.exe",
    }
}

fn sanitize_version(version: &str) -> String {
    version.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+') { c } else { '_' }).collect()
}

fn send_stage(channel: &Channel<RuntimeDownloadEvent>, kind: RuntimeKind, stage: &str) {
    let _ = channel.send(RuntimeDownloadEvent::Stage {
        kind: kind.id().to_string(),
        stage: stage.to_string(),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checksum_manifest_requires_exact_file_name() {
        let manifest = "abc  node-v22-win-x64.zip\ndef *other.zip\n";
        assert_eq!(checksum_for(manifest, "node-v22-win-x64.zip").unwrap(), "abc");
        assert!(checksum_for(manifest, "node.zip").is_err());
    }

    #[test]
    fn sha256_mismatch_is_rejected() {
        let path = std::env::temp_dir().join(format!("lf-runtime-sha-{}", uuid::Uuid::new_v4()));
        fs::write(&path, b"runtime").unwrap();
        assert!(verify_sha256(&path, "deadbeef").is_err());
        let _ = fs::remove_file(path);
    }
}
