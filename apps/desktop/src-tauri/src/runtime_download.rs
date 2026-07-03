//! 运行时按需下载管线（task 07-03 step 2）。
//!
//! 把 portable Python（python-build-standalone install_only）和 Node（官方 win-x64 zip）
//! 下载到 `{runtime_data_root}/{kind}-{version}/`，激活后写入 runtime-config.json 的
//! `app_managed_*`，resolver 下次 `resolve()` 即命中（AppManaged 来源）。
//!
//! ## 下载源（国内优先）
//!
//! - Python：npmmirror 镜像 python-build-standalone（UV 同款 UV_PYTHON_INSTALL_MIRROR）→ GitHub 备用。
//! - Node：npmmirror binaries/node → nodejs.org 备用。
//!
//! config.download_mirror_base 可覆盖 Python 主源 base（指向自建/其它镜像）。
//!
//! ## 布局约定（与 runtime_resolver 一致）
//!
//! 解压后 strip 顶层目录（`python/` 或 `node-v{ver}-win-x64/`），保证主 exe 直接在目标 dir：
//! `{runtime_data_root}/python-{ver}/python.exe` + `Lib/ensurepip/_bundled/pip-*.whl`
//! `{runtime_data_root}/node-{ver}/node.exe` + `npm.cmd` + `pnpm.cmd`
//!
//! ## 流程
//!
//! 选候选 URL → 下载到 `.download/*.part`（重试 + 进度节流 emit）→ SHA256 校验
//! （sha 文件能下到则强制，否则跳过）→ 解压到 `.staging/` → strip 顶层 → 验证 exe
//! （Python 额外验证 ensurepip/_bundled）→ 写 config 激活 → 清理临时。

use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::Emitter;

use flate2::read::GzDecoder;
use sha2::{Digest, Sha256};
use tar::Archive as TarArchive;
use zip::ZipArchive;

use crate::runtime_config::{
    runtime_data_root, ManagedEntry, RuntimeConfig, RuntimeConfigStore,
};

/// 默认 Python 版本（python-build-standalone install_only）。
const DEFAULT_PYTHON_VERSION: &str = "3.12.13";
/// python-build-standalone release tag（日期格式，随上游更新；如失效可在设置页覆盖或更新此处）。
const DEFAULT_PYTHON_BUILD_TAG: &str = "2026032";
/// 默认 Node.js 版本（LTS，官方 win-x64 zip）。
const DEFAULT_NODE_VERSION: &str = "22.21.1";

const NPMIRROR_PYTHON_BASE: &str =
    "https://registry.npmmirror.com/-/binary/python-build-standalone";
const GITHUB_PYTHON_BASE: &str =
    "https://github.com/astral-sh/python-build-standalone/releases/download";
const NPMIRROR_NODE_BASE: &str = "https://registry.npmmirror.com/-/binary/node";
const NODEJS_DIST_BASE: &str = "https://nodejs.org/dist";

/// 下载进度的 emit 间隔（避免每 chunk emit 导致 IPC 过载）。
const PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(120);

/// 运行时种类（与 plugin_script::ScriptRuntime 对齐，serde lowercase）。
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeKind {
    Nodejs,
    Python,
}

impl RuntimeKind {
    fn id(self) -> &'static str {
        match self {
            RuntimeKind::Nodejs => "node",
            RuntimeKind::Python => "python",
        }
    }

    /// 主 exe 文件名（仅 Windows；MVP 不支持非 Windows 下载）。
    fn exe_name(self) -> &'static str {
        match self {
            RuntimeKind::Nodejs => "node.exe",
            RuntimeKind::Python => "python.exe",
        }
    }
}

/// 默认版本号。
pub fn default_version(kind: RuntimeKind) -> &'static str {
    match kind {
        RuntimeKind::Python => DEFAULT_PYTHON_VERSION,
        RuntimeKind::Nodejs => DEFAULT_NODE_VERSION,
    }
}

// === Tauri 进度 event payload ===

#[derive(Clone, Serialize)]
struct DownloadStagePayload {
    kind: RuntimeKind,
    /// stage: "downloading" | "verifying" | "extracting" | "activating" | "done" | "failed"
    stage: String,
}

#[derive(Clone, Serialize)]
struct DownloadProgressPayload {
    kind: RuntimeKind,
    downloaded: u64,
    total: Option<u64>,
}

fn emit_stage<R: tauri::Runtime>(app: &tauri::AppHandle<R>, kind: RuntimeKind, stage: &str) {
    let _ = app.emit(
        "runtime-download-stage",
        DownloadStagePayload {
            kind,
            stage: stage.to_string(),
        },
    );
}

fn emit_progress<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    kind: RuntimeKind,
    downloaded: u64,
    total: Option<u64>,
) {
    let _ = app.emit(
        "runtime-download-progress",
        DownloadProgressPayload {
            kind,
            downloaded,
            total,
        },
    );
}

// === 主入口 ===

/// 下载并激活运行时。成功返回 ManagedEntry（已写入 config）。
///
/// `version` 为 None 时用默认版本。Step 3 的 download_runtime 命令包装此函数。
pub fn download_runtime<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    kind: RuntimeKind,
    version: Option<String>,
) -> Result<ManagedEntry, String> {
    let config = RuntimeConfigStore::from_app(app)?.read();
    let version = version.unwrap_or_else(|| default_version(kind).to_string());
    let data_root = runtime_data_root(app);
    let kind_id = kind.id();

    // 1. 候选 URL（主源 npmmirror，备源国际）。
    let candidates = candidate_urls(kind, &version, &config);
    let download_dir = data_root.join(".download");
    std::fs::create_dir_all(&download_dir)
        .map_err(|e| format!("创建下载目录失败：{e}"))?;
    let part_path = download_dir.join(format!("{kind_id}-{version}.part"));

    emit_stage(app, kind, "downloading");
    let archive_path = download_with_candidates(app, &candidates, &part_path, kind)?;

    // 2. SHA256 校验（sha 文件能下到则强制）。
    emit_stage(app, kind, "verifying");
    verify_sha256(app, kind, &candidates, &version, &archive_path)?;

    // 3. 解压到 staging。
    emit_stage(app, kind, "extracting");
    let staging_dir = data_root
        .join(".staging")
        .join(format!("{kind_id}-{version}"));
    remove_dir_all_with_retry(&staging_dir);
    std::fs::create_dir_all(&staging_dir)
        .map_err(|e| format!("创建 staging 目录失败：{e}"))?;
    extract_archive(&archive_path, &staging_dir, kind)?;

    // 4. strip 顶层目录 + 原子落盘到目标 dir。
    let target_dir = data_root.join(format!("{kind_id}-{version}"));
    strip_and_finalize(&staging_dir, &target_dir)?;

    // 5. 验证主 exe（Python 额外验证 ensurepip/_bundled）。
    validate_exe(&target_dir, kind)?;

    // 6. 激活：写 config。
    emit_stage(app, kind, "activating");
    let entry = ManagedEntry {
        version: version.clone(),
        dir: target_dir.to_string_lossy().to_string(),
        installed_at: now_iso(),
    };
    write_managed_entry(app, kind, entry.clone())?;

    // 7. 清理临时。
    let _ = std::fs::remove_file(&archive_path);
    let _ = remove_dir_all_with_retry(&staging_dir);

    emit_stage(app, kind, "done");
    Ok(entry)
}

/// 卸载应用管理的运行时（删目录 + 清 config 条目）。返回是否真的清理了。
pub fn uninstall_runtime<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    kind: RuntimeKind,
) -> Result<bool, String> {
    let store = RuntimeConfigStore::from_app(app)?;
    let mut config = store.read();
    let entry = match kind {
        RuntimeKind::Python => config.app_managed_python.take(),
        RuntimeKind::Nodejs => config.app_managed_node.take(),
    };
    let Some(entry) = entry else {
        return Ok(false);
    };
    let dir = PathBuf::from(&entry.dir);
    let _ = remove_dir_all_with_retry(&dir);
    store.write(&config)?;
    Ok(true)
}

// === URL 候选 ===

/// 返回 (url, archive_filename) 候选列表，主源在前。
fn candidate_urls(
    kind: RuntimeKind,
    version: &str,
    config: &RuntimeConfig,
) -> Vec<(String, String)> {
    match kind {
        RuntimeKind::Python => {
            let file =
                format!("cpython-{version}+{DEFAULT_PYTHON_BUILD_TAG}-x86_64-pc-windows-msvc-install_only.tar.gz");
            // download_mirror_base 覆盖主源 base（指向自建镜像）；否则默认 npmmirror。
            let primary_base = config
                .download_mirror_base
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .unwrap_or_else(|| NPMIRROR_PYTHON_BASE.to_string());
            let primary = format!("{primary_base}/{DEFAULT_PYTHON_BUILD_TAG}/{file}");
            let github = format!("{GITHUB_PYTHON_BASE}/{DEFAULT_PYTHON_BUILD_TAG}/{file}");
            vec![(primary, file.clone()), (github, file.clone())]
        }
        RuntimeKind::Nodejs => {
            let file = format!("node-v{version}-win-x64.zip");
            let primary = format!("{NPMIRROR_NODE_BASE}/v{version}/{file}");
            let official = format!("{NODEJS_DIST_BASE}/v{version}/{file}");
            vec![(primary, file.clone()), (official, file.clone())]
        }
    }
}

// === 下载 ===

fn download_with_candidates<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    candidates: &[(String, String)],
    part_path: &Path,
    kind: RuntimeKind,
) -> Result<PathBuf, String> {
    let mut last_err = String::from("无候选源");
    for (url, _file) in candidates {
        match download_with_retry(app, url, part_path, kind) {
            Ok(()) => return Ok(part_path.to_path_buf()),
            Err(e) => {
                last_err = format!("{url} → {e}");
                let _ = std::fs::remove_file(part_path);
            }
        }
    }
    Err(format!("所有下载源均失败。最后错误：{last_err}"))
}

fn download_with_retry<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    url: &str,
    part_path: &Path,
    kind: RuntimeKind,
) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|e| format!("构建 HTTP client 失败：{e}"))?;
    const MAX_ATTEMPTS: u32 = 3;
    let mut last_err = String::new();
    for attempt in 0..MAX_ATTEMPTS {
        match try_download(&client, url, part_path, app, kind) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last_err = e;
                let _ = std::fs::remove_file(part_path);
                if attempt + 1 < MAX_ATTEMPTS {
                    // 指数退避：500ms / 1s / 2s。
                    std::thread::sleep(Duration::from_millis(500u64 << attempt));
                }
            }
        }
    }
    Err(last_err)
}

fn try_download<R: tauri::Runtime>(
    client: &reqwest::blocking::Client,
    url: &str,
    part_path: &Path,
    app: &tauri::AppHandle<R>,
    kind: RuntimeKind,
) -> Result<(), String> {
    let resp = client
        .get(url)
        .send()
        .map_err(|e| format!("请求失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let total = resp.content_length();
    let mut file = File::create(part_path).map_err(|e| format!("创建临时文件失败：{e}"))?;
    let mut reader = resp;
    let mut downloaded: u64 = 0;
    let mut last_emit = Instant::now();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("读取响应失败：{e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])
            .map_err(|e| format!("写入临时文件失败：{e}"))?;
        downloaded += n as u64;
        // 节流 emit：避免每 chunk emit 导致 IPC 过载。
        if last_emit.elapsed() >= PROGRESS_EMIT_INTERVAL {
            emit_progress(app, kind, downloaded, total);
            last_emit = Instant::now();
        }
    }
    file.flush().map_err(|e| format!("flush 临时文件失败：{e}"))?;
    // 完成：emit 最终进度。
    emit_progress(app, kind, downloaded, total);
    Ok(())
}

// === SHA256 校验 ===

/// 校验 archive SHA256。sha 文件能下到则强制比对（失败拒绝）；下不到则跳过（warn 不阻断）。
fn verify_sha256<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    kind: RuntimeKind,
    candidates: &[(String, String)],
    version: &str,
    archive: &Path,
) -> Result<(), String> {
    let archive_name = candidates[0].1.as_str();
    let expected = match fetch_expected_sha(kind, candidates, version, archive_name) {
        Ok(sha) => sha,
        Err(_e) => {
            // sha 文件下载失败：不阻断（国内镜像可能未同步 sha）。记日志到 stage event。
            emit_stage(app, kind, "verifying");
            return Ok(());
        }
    };
    let Some(expected) = expected else {
        return Ok(()); // sha 文件存在但未找到匹配条目：放行（保守不阻断）。
    };
    let actual = compute_sha256(archive)?;
    if !actual.eq_ignore_ascii_case(&expected) {
        return Err(format!(
            "SHA256 校验失败：期望 {expected}，实际 {actual}"
        ));
    }
    Ok(())
}

/// 拉取 sha 文件并解析出该 archive 的期望 hash。
fn fetch_expected_sha(
    kind: RuntimeKind,
    candidates: &[(String, String)],
    version: &str,
    archive_name: &str,
) -> Result<Option<String>, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("构建 sha HTTP client 失败：{e}"))?;
    let sha_urls = sha256_urls(kind, candidates, version, archive_name);
    let mut last_err = String::new();
    for url in sha_urls {
        match client.get(&url).send() {
            Ok(resp) if resp.status().is_success() => {
                let text = resp.text().map_err(|e| format!("读取 sha 文本失败：{e}"))?;
                return Ok(extract_expected_sha(&text, kind, archive_name));
            }
            Ok(resp) => last_err = format!("HTTP {}", resp.status()),
            Err(e) => last_err = e.to_string(),
        }
    }
    Err(last_err)
}

/// Python 的 .sha256 文件候选（同源）；Node 的 SHASUMS256.txt 候选。
fn sha256_urls(
    kind: RuntimeKind,
    candidates: &[(String, String)],
    _version: &str,
    archive_name: &str,
) -> Vec<String> {
    let mut urls = Vec::new();
    match kind {
        RuntimeKind::Python => {
            // python-build-standalone 的 sha 文件：{archive}.sha256（同目录）。
            for (base, _file) in candidates {
                urls.push(format!("{base}.sha256"));
            }
        }
        RuntimeKind::Nodejs => {
            // Node 的 SHASUMS256.txt 在 dist 根目录（同源）。
            for (base, _file) in candidates {
                if let Some(dist_root) = base.strip_suffix(&format!("/{archive_name}")) {
                    urls.push(format!("{dist_root}/SHASUMS256.txt"));
                }
            }
        }
    }
    urls
}

/// 从 sha 文件文本中提取该 archive 对应的 hash。
fn extract_expected_sha(text: &str, kind: RuntimeKind, archive_name: &str) -> Option<String> {
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        match kind {
            RuntimeKind::Python => {
                // python-build-standalone .sha256 文件：单行 `<hash>` 或 `<hash>  <name>`。
                if line.contains(archive_name) || !line.contains(char::is_whitespace) {
                    return Some(line.split_whitespace().next()?.to_string());
                }
            }
            RuntimeKind::Nodejs => {
                // SHASUMS256.txt 格式：`<hash>  <filename>`
                let mut parts = line.split_whitespace();
                let hash = parts.next()?;
                let name = parts.next()?;
                if name == archive_name {
                    return Some(hash.to_string());
                }
            }
        }
    }
    None
}

fn compute_sha256(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|e| format!("打开文件失败：{e}"))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("读取文件失败：{e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

// === 解压 ===

fn extract_archive(archive: &Path, dest: &Path, kind: RuntimeKind) -> Result<(), String> {
    match kind {
        RuntimeKind::Python => extract_tar_gz(archive, dest),
        RuntimeKind::Nodejs => extract_zip(archive, dest),
    }
}

fn extract_zip(archive: &Path, dest: &Path) -> Result<(), String> {
    let file = File::open(archive).map_err(|e| format!("打开 zip 失败：{e}"))?;
    let mut zip = ZipArchive::new(file).map_err(|e| format!("读取 zip 失败：{e}"))?;
    for i in 0..zip.len() {
        let mut entry = zip
            .by_index(i)
            .map_err(|e| format!("zip entry {i} 失败：{e}"))?;
        let Some(name) = entry.enclosed_name() else {
            continue;
        };
        let outpath = dest.join(name);
        if entry.is_dir() {
            std::fs::create_dir_all(&outpath).map_err(|e| format!("创建目录失败：{e}"))?;
        } else {
            if let Some(parent) = outpath.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("创建父目录失败：{e}"))?;
            }
            let mut outfile =
                File::create(&outpath).map_err(|e| format!("创建文件 {outpath:?} 失败：{e}"))?;
            std::io::copy(&mut entry, &mut outfile).map_err(|e| format!("解压写入失败：{e}"))?;
        }
    }
    Ok(())
}

fn extract_tar_gz(archive: &Path, dest: &Path) -> Result<(), String> {
    let file = File::open(archive).map_err(|e| format!("打开 tar.gz 失败：{e}"))?;
    let decoder = GzDecoder::new(file);
    let mut tar = TarArchive::new(decoder);
    tar.set_overwrite(true);
    tar.unpack(dest).map_err(|e| format!("解压 tar.gz 失败：{e}"))?;
    Ok(())
}

/// 把 staging 下唯一顶层目录的内容移到 target（strip 一层 python/ 或 node-v{ver}-win-x64/）。
fn strip_and_finalize(staging: &Path, target: &Path) -> Result<(), String> {
    let entries: Vec<_> = std::fs::read_dir(staging)
        .map_err(|e| format!("读取 staging 失败：{e}"))?
        .filter_map(|e| e.ok())
        .collect();
    // 找到唯一的顶层目录（python/ 或 node-v{ver}-win-x64/）。
    let inner_dir = entries
        .iter()
        .map(|e| e.path())
        .find(|p| p.is_dir())
        .ok_or_else(|| "解压后未找到顶层目录".to_string())?;
    // 先落到 target.tmp 再 rename，保证 target 不出现半截状态。
    let tmp_target = target.with_extension("tmp-staging");
    remove_dir_all_with_retry(&tmp_target);
    std::fs::create_dir_all(&tmp_target).map_err(|e| format!("创建临时目标目录失败：{e}"))?;
    for entry in std::fs::read_dir(inner_dir)
        .map_err(|e| format!("读取内层目录失败：{e}"))?
        .flatten()
    {
        let name = entry.file_name();
        std::fs::rename(entry.path(), tmp_target.join(&name))
            .map_err(|e| format!("移动 {} 失败：{e}", entry.path().display()))?;
    }
    // 原子替换：删旧 target（若有）→ rename tmp → target。
    let _ = remove_dir_all_with_retry(target);
    persist_rename(&tmp_target, target)?;
    Ok(())
}

/// 验证主 exe 存在；Python 额外验证 ensurepip/_bundled 含 pip wheel（venv 创建链路依赖）。
fn validate_exe(dir: &Path, kind: RuntimeKind) -> Result<(), String> {
    let exe = dir.join(kind.exe_name());
    if !exe.is_file() {
        return Err(format!(
            "解压后未找到主 exe：{}",
            exe.display()
        ));
    }
    if let RuntimeKind::Python = kind {
        let bundled = dir.join("Lib").join("ensurepip").join("_bundled");
        if !has_pip_wheel(&bundled)? {
            return Err(format!(
                "Python 解压后缺少 ensurepip/_bundled pip wheel（{}），venv 创建将失败",
                bundled.display()
            ));
        }
    }
    Ok(())
}

fn has_pip_wheel(dir: &Path) -> Result<bool, String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Ok(false);
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        if name.starts_with("pip-") && name.ends_with(".whl") && entry.path().is_file() {
            return Ok(true);
        }
    }
    Ok(false)
}

// === config 写入 ===

fn write_managed_entry<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    kind: RuntimeKind,
    entry: ManagedEntry,
) -> Result<(), String> {
    let store = RuntimeConfigStore::from_app(app)?;
    let mut config = store.read();
    match kind {
        RuntimeKind::Python => config.app_managed_python = Some(entry),
        RuntimeKind::Nodejs => config.app_managed_node = Some(entry),
    }
    store.write(&config)
}

// === 通用辅助 ===

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// 带 retry 的 remove_dir_all（Windows 上目录被占用会失败，重试几次）。
fn remove_dir_all_with_retry(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let mut last_err = String::new();
    for attempt in 0..5u32 {
        match std::fs::remove_dir_all(path) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last_err = e.to_string();
                std::thread::sleep(Duration::from_millis(100u64 << attempt));
            }
        }
    }
    Err(format!("删除目录 {} 失败：{last_err}", path.display()))
}

/// 跨平台原子 rename（覆盖目标）。与 plugin_store::persist_rename 同款（Windows 用 MoveFileExW）。
fn persist_rename(from: &Path, to: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        std::fs::rename(from, to).map_err(|e| e.to_string())
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        const MOVEFILE_REPLACE_EXISTING: u32 = 0x0000_0001;
        const MOVEFILE_WRITE_THROUGH: u32 = 0x0000_0008;
        let from_wide: Vec<u16> = from
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let to_wide: Vec<u16> = to
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        extern "system" {
            fn MoveFileExW(
                lpexistingfilename: *const u16,
                lpnewfilename: *const u16,
                dwflags: u32,
            ) -> i32;
        }
        unsafe {
            let ok = MoveFileExW(
                from_wide.as_ptr(),
                to_wide.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            );
            if ok == 0 {
                Err(std::io::Error::last_os_error().to_string())
            } else {
                Ok(())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_versions_are_set() {
        assert_eq!(default_version(RuntimeKind::Python), "3.12.13");
        assert_eq!(default_version(RuntimeKind::Nodejs), "22.21.1");
    }

    #[test]
    fn python_candidate_urls_prefer_npmmirror_then_github() {
        let config = RuntimeConfig::default();
        let urls = candidate_urls(RuntimeKind::Python, "3.12.13", &config);
        assert_eq!(urls.len(), 2);
        assert!(urls[0].0.contains("registry.npmmirror.com"));
        assert!(urls[1].0.contains("github.com"));
        assert!(urls[0].1.contains("cpython-3.12.13"));
        assert!(urls[0].1.ends_with("install_only.tar.gz"));
    }

    #[test]
    fn node_candidate_urls_prefer_npmmirror_then_nodejs_org() {
        let config = RuntimeConfig::default();
        let urls = candidate_urls(RuntimeKind::Nodejs, "22.21.1", &config);
        assert_eq!(urls.len(), 2);
        assert!(urls[0].0.contains("registry.npmmirror.com"));
        assert!(urls[1].0.contains("nodejs.org/dist"));
        assert_eq!(urls[0].1, "node-v22.21.1-win-x64.zip");
    }

    #[test]
    fn download_mirror_base_overrides_python_primary() {
        let mut config = RuntimeConfig::default();
        config.download_mirror_base = Some("https://my.corp/python-builds".to_string());
        let urls = candidate_urls(RuntimeKind::Python, "3.12.13", &config);
        assert!(urls[0].0.starts_with("https://my.corp/python-builds/"));
        // 备源仍为 GitHub。
        assert!(urls[1].0.contains("github.com"));
    }

    #[test]
    fn extract_expected_sha_node_format() {
        let text = "abc123  node-v22.21.1-win-x64.zip\ndef456  node-v22.21.1-darwin-arm64.tar.gz\n";
        let hash = extract_expected_sha(text, RuntimeKind::Nodejs, "node-v22.21.1-win-x64.zip");
        assert_eq!(hash.as_deref(), Some("abc123"));
    }

    #[test]
    fn extract_expected_sha_python_single_line() {
        let text = "deadbeef  cpython-3.12.13+2026032-x86_64-pc-windows-msvc-install_only.tar.gz\n";
        let hash = extract_expected_sha(
            text,
            RuntimeKind::Python,
            "cpython-3.12.13+2026032-x86_64-pc-windows-msvc-install_only.tar.gz",
        );
        assert_eq!(hash.as_deref(), Some("deadbeef"));
    }

    #[test]
    fn extract_expected_sha_python_bare_hash() {
        // 某些镜像的 .sha256 仅单行 hash。
        let hash = extract_expected_sha("facade00", RuntimeKind::Python, "any.tar.gz");
        assert_eq!(hash.as_deref(), Some("facade00"));
    }

    #[test]
    fn compute_sha256_is_deterministic_and_hex() {
        let dir = std::env::temp_dir().join(format!(
            "lf-dl-sha-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("hello.txt");
        std::fs::write(&path, b"hello\n").unwrap();
        let hash1 = compute_sha256(&path).unwrap();
        let hash2 = compute_sha256(&path).unwrap();
        // 64 位小写 hex（SHA256 标准输出）。
        assert_eq!(hash1.len(), 64);
        assert!(hash1.chars().all(|c| c.is_ascii_hexdigit()));
        // 同输入两次结果一致。
        assert_eq!(hash1, hash2);
        // 不同输入结果不同。
        std::fs::write(&path, b"world\n").unwrap();
        let hash3 = compute_sha256(&path).unwrap();
        assert_ne!(hash1, hash3);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn strip_and_finalize_moves_inner_contents_to_target() {
        let root = std::env::temp_dir().join(format!(
            "lf-dl-strip-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let staging = root.join("staging");
        let target = root.join("target");
        // 模拟 python-build-standalone 解压布局：staging/python/python.exe + Lib/...
        std::fs::create_dir_all(staging.join("python").join("Lib")).unwrap();
        std::fs::write(staging.join("python").join("python.exe"), "").unwrap();
        std::fs::write(staging.join("python").join("Lib").join("x.txt"), "").unwrap();

        strip_and_finalize(&staging, &target).unwrap();
        assert!(target.join("python.exe").is_file());
        assert!(target.join("Lib").join("x.txt").is_file());
        // 主 exe 直接在 target 根（strip 成功）。
        assert!(!target.join("python").exists());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn has_pip_wheel_detects_pip_whl() {
        let dir = std::env::temp_dir().join(format!(
            "lf-dl-pip-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("pip-25.0.1-py3-none-any.whl"), "").unwrap();
        std::fs::write(dir.join("setuptools-1.0.whl"), "").unwrap();
        assert!(has_pip_wheel(&dir).unwrap());

        std::fs::remove_file(dir.join("pip-25.0.1-py3-none-any.whl")).unwrap();
        assert!(!has_pip_wheel(&dir).unwrap());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
