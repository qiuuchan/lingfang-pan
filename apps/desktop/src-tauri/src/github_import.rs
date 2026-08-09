//! GitHub 仓库导入（P0）：安全下载仓库 zip 并落盘到本地草稿工作区。
//!
//! 这是「灵坊搜索 GitHub → 推荐 → 下载克隆 → 纳入本地插件 → 启动运行」链路的第一步，
//! 只负责把仓库内容安全地下载并解压到 `plugins_root/workspaces/<uuid>/`，并登记一条
//! 草稿工作区账本条目，供后续 P1（清单合成）/ P2（智能体工具）/ P3（启动运行）消费。
//!
//! 三道安全闸（审阅结论要求 P0 内必须补齐）：
//! 1. SSRF / 输入校验：只允许 `github.com` / `codeload.github.com`，owner/repo 走字符白名单，
//!    下载 URL 由白名单段拼出，绝不拼接任意外部主机。
//! 2. zip 炸弹预检：解压前先累加未压缩体积与条目数，超限即中止并清理残留。
//! 3. zip-slip：逐条目归一化路径，拒绝 `..` / 绝对路径 / 符号链接 / 越界写入。

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::Utc;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use uuid::Uuid;
use zip::ZipArchive;

use crate::plugin_package_manager::{
    normalize_release_provenance, DraftDiagnosticStatus, DraftWorkspace, PluginPackageManager,
    PluginReleaseSourceKind,
};

/// 单文件未压缩体积上限（防止个别巨文件撑爆内存）。
const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
/// 工作区展开总量上限（zip 炸弹预检阈值）。
const MAX_UNCOMPRESSED_BYTES: u64 = 300 * 1024 * 1024;
/// 条目数量上限（防御目录爆炸 / 嵌套炸弹）。
const MAX_ENTRIES: usize = 1498;
/// 下载整体超时。
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(180);

/// 导入入参。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportGitHubRepoInput {
    /// `owner/repo` 或完整 GitHub URL（将规范化解析）。
    pub url: String,
    /// 目标分支 / tag / ref；为空时依次尝试 `main`、`master`。
    #[serde(default)]
    pub git_ref: Option<String>,
}

/// 导入进度事件（经 Tauri Channel 推给前端）。
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "event", content = "data")]
pub(crate) enum GitHubImportEvent {
    Stage { stage: String, message: String },
    #[serde(rename_all = "camelCase")]
    Started { total_bytes: Option<u64> },
    #[serde(rename_all = "camelCase")]
    Progress { chunk_length: usize },
    Finished,
}

/// 导入结果。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitHubImportResult {
    pub workspace_id: String,
    pub path: String,
    pub owner: String,
    pub repo: String,
    pub git_ref: String,
    pub file_count: usize,
    pub source_label: String,
}

/// owner / repo 段白名单：仅允许 ASCII 字母数字及 `-_.`，杜绝路径分隔与注入。
fn is_valid_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// 从 `owner/repo` 或完整 GitHub URL 中规范化解析出 owner 与 repo（SSRF / 注入防护）。
fn parse_owner_repo(raw: &str) -> Result<(String, String), String> {
    let mut candidate = raw.trim();
    for prefix in [
        "git+https://",
        "git+http://",
        "git://",
        "https://",
        "http://",
    ] {
        if let Some(rest) = candidate.strip_prefix(prefix) {
            candidate = rest;
            break;
        }
    }
    // 若去掉协议后形如 `host/...`，需区分「github 主机」与「裸 slug 的 owner 段」。
    // 含 `.` 或在白名单内的才是主机；否则 `host` 实为 owner，整段当作裸 slug 处理。
    if let Some(idx) = candidate.find('/') {
        let host = &candidate[..idx];
        let rest = &candidate[idx + 1..];
        let is_allowed_host = matches!(host, "github.com" | "www.github.com" | "codeload.github.com");
        if host.contains('.') || is_allowed_host {
            if !is_allowed_host {
                return Err("仅支持 github.com / codeload.github.com 仓库地址（SSRF 防护）".to_string());
            }
            candidate = rest;
        }
    }
    // 去掉末尾的 `.git` 与斜杠。
    let candidate = candidate.trim_end_matches('/').trim_end_matches(".git");
    // 支持 `owner/repo[/tree|<branch>...]` 形式的深链，仅取前两段。
    let parts: Vec<&str> = candidate.splitn(3, '/').collect();
    if parts.len() < 2 {
        return Err("无法解析 GitHub 仓库地址，期望格式 `owner/repo` 或完整 GitHub URL".to_string());
    }
    let owner = parts[0];
    let repo = parts[1];
    if !is_valid_segment(owner) || !is_valid_segment(repo) {
        return Err("仓库地址包含非法字符（owner/repo 仅允许字母数字、-_.）".to_string());
    }
    Ok((owner.to_string(), repo.to_string()))
}

/// 构建带可选代理的 reqwest 客户端。
/// 默认会读取环境代理（HTTPS_PROXY / HTTP_PROXY）；可用 `LINGFANG_GITHUB_PROXY` 显式覆盖。
fn build_client() -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .timeout(DOWNLOAD_TIMEOUT)
        .use_rustls_tls()
        .user_agent("lingfang-desktop");
    if let Ok(proxy) = std::env::var("LINGFANG_GITHUB_PROXY") {
        if !proxy.trim().is_empty() {
            builder = builder.proxy(
                reqwest::Proxy::all(proxy.trim())
                    .map_err(|error| format!("配置 GitHub 代理失败：{error}"))?,
            );
        }
    }
    builder
        .build()
        .map_err(|error| format!("创建 GitHub 下载客户端失败：{error}"))
}

/// 流式子下载仓库 zip 到 `dest`。返回写入字节数。
async fn fetch_repo_zip(
    client: &reqwest::Client,
    owner: &str,
    repo: &str,
    git_ref: &str,
    dest: &Path,
    on_event: &Channel<GitHubImportEvent>,
) -> Result<u64, String> {
    // 下载 URL 由白名单段拼出，主机固定为 codeload.github.com，杜绝 SSRF。
    let url = format!("https://codeload.github.com/{owner}/{repo}/zip/refs/heads/{git_ref}");
    let _ = on_event.send(GitHubImportEvent::Stage {
        stage: "downloading".to_string(),
        message: format!("正在下载 {owner}/{repo}@{git_ref}"),
    });
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|error| format!("下载仓库 zip 失败：{error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("下载仓库 zip 失败：HTTP {status}"));
    }
    let total = response.content_length();
    let _ = on_event.send(GitHubImportEvent::Started { total_bytes: total });
    let mut output = fs::File::create(dest)
        .map_err(|error| format!("创建下载暂存文件失败：{error}"))?;
    let mut stream = response.bytes_stream();
    let mut written: u64 = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("接收仓库 zip 失败：{error}"))?;
        output
            .write_all(&chunk)
            .map_err(|error| format!("写入仓库 zip 失败：{error}"))?;
        written += chunk.len() as u64;
        let _ = on_event.send(GitHubImportEvent::Progress {
            chunk_length: chunk.len(),
        });
    }
    Ok(written)
}

/// zip-slip 防护：校验相对路径未越界、非绝对、无 `..` 段。
fn validate_relative_path(relative: &str) -> Result<PathBuf, String> {
    if relative.is_empty() {
        return Err("非法路径：空路径".to_string());
    }
    if relative.starts_with('/') || relative.starts_with('\\') {
        return Err(format!("拒绝导入：检测到绝对路径条目 `{relative}`"));
    }
    if relative.contains('\\') {
        return Err(format!("拒绝导入：检测到反斜杠路径条目 `{relative}`"));
    }
    for segment in relative.split('/') {
        if segment == ".." {
            return Err(format!("拒绝导入：检测到路径穿越条目 `{relative}`"));
        }
        if segment.is_empty() {
            return Err(format!("拒绝导入：检测到非法路径片段 `{relative}`"));
        }
    }
    Ok(PathBuf::from(relative))
}

/// 剥掉 zip 顶层目录前缀（GitHub zip 顶层为 `<repo>-<ref>/`）。
fn strip_top_level(name: &str) -> String {
    match name.find('/') {
        // 顶层目录条目本身（`repo-ref/`）→ 剥为空，调用方跳过。
        Some(idx) if idx + 1 >= name.len() => String::new(),
        Some(idx) => name[idx + 1..].to_string(),
        // 无斜杠（裸文件）→ 原样返回。
        None => name.to_string(),
    }
}

/// 清理：下载失败时删暂存 zip；解压失败时删暂存 zip 与目标目录。
fn cleanup(temp_zip: &Path, dest: Option<&Path>) {
    let _ = fs::remove_file(temp_zip);
    if let Some(dest) = dest {
        let _ = fs::remove_dir_all(dest);
    }
}

/// 校验并解压仓库 zip 到 `dest`（剥掉顶层目录前缀）。返回落盘的文件数。
///
/// 安全闸：zip 炸弹预检（体积 / 条目数）+ zip-slip（路径穿越 / 绝对路径 / 符号链接）。
/// 纯函数，便于单测用构造 zip 覆盖恶意用例。
fn extract_repo_zip(zip_path: &Path, dest: &Path) -> Result<usize, String> {
    let file =
        fs::File::open(zip_path).map_err(|error| format!("打开下载文件失败：{error}"))?;
    let mut archive =
        ZipArchive::new(file).map_err(|error| format!("无效的仓库 zip：{error}"))?;

    // 预检第一遍：累加未压缩体积 + 计数 + 拒绝符号链接。
    let mut total_uncompressed: u64 = 0;
    let mut entry_count: usize = 0;
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| format!("读取 zip 条目失败：{error}"))?;
        if entry
            .unix_mode()
            .map(|mode| mode & 0o170000 == 0o120000)
            .unwrap_or(false)
        {
            return Err(format!(
                "拒绝导入：仓库包含符号链接条目 `{}`",
                entry.name()
            ));
        }
        total_uncompressed = total_uncompressed.saturating_add(entry.size());
        entry_count += 1;
    }
    if total_uncompressed > MAX_UNCOMPRESSED_BYTES || entry_count > MAX_ENTRIES {
        return Err("仓库体积或条目数超限（疑似 zip 炸弹），已中止导入".to_string());
    }

    // 解压第二遍。
    let mut file_count: usize = 0;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("读取 zip 条目失败：{error}"))?;
        let name = entry.name().to_string();
        let stripped = strip_top_level(&name);
        if stripped.is_empty() {
            continue; // 顶层目录条目自身。
        }
        let relative = validate_relative_path(&stripped)?;
        // 防御性再校验：最终落盘路径必须仍在 dest 之内。
        let out_path = dest.join(&relative);
        if !out_path.starts_with(dest) {
            return Err(format!("拒绝导入：路径越界 `{stripped}`"));
        }
        if entry.is_dir() {
            fs::create_dir_all(&out_path)
                .map_err(|error| format!("创建目录 {stripped} 失败：{error}"))?;
            continue;
        }
        if entry.size() > MAX_FILE_BYTES {
            return Err(format!("单文件体积超限：`{stripped}`"));
        }
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("创建父目录失败：{error}"))?;
        }
        let mut buffer = Vec::with_capacity(entry.size() as usize);
        entry
            .read_to_end(&mut buffer)
            .map_err(|error| format!("读取条目 {stripped} 失败：{error}"))?;
        fs::write(&out_path, &buffer)
            .map_err(|error| format!("写入条目 {stripped} 失败：{error}"))?;
        file_count += 1;
    }
    Ok(file_count)
}

/// P0 主命令：安全下载 GitHub 仓库 zip 并落盘到本地草稿工作区。
#[tauri::command]
pub(crate) async fn import_github_repo(
    manager: tauri::State<'_, PluginPackageManager>,
    input: ImportGitHubRepoInput,
    on_event: Channel<GitHubImportEvent>,
) -> Result<GitHubImportResult, String> {
    let (owner, repo) = parse_owner_repo(&input.url)?;

    let client = build_client()?;

    // 目标分支解析：显式指定优先；否则依次尝试 main / master。
    let branches: Vec<String> = match input.git_ref.filter(|value| !value.trim().is_empty()) {
        Some(value) => vec![value.trim().to_string()],
        None => vec!["main".to_string(), "master".to_string()],
    };

    let temp_zip = manager
        .plugins_root_dir()
        .join(".lingfang-staging")
        .join(format!("github-{}.zip", Uuid::new_v4()));
    if let Some(parent) = temp_zip.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("创建下载暂存目录失败：{error}"))?;
    }
    let mut chosen_branch = String::new();
    let mut last_error: Option<String> = None;
    for branch in &branches {
        match fetch_repo_zip(&client, &owner, &repo, branch, &temp_zip, &on_event).await {
            Ok(_) => {
                chosen_branch = branch.clone();
                break;
            }
            Err(error) => {
                last_error = Some(error.clone());
                // 仅当首个默认分支 404 时回退尝试下一个；其它错误直接中止。
                if branches.len() > 1 && error.contains("HTTP 404") {
                    let _ = fs::remove_file(&temp_zip);
                    continue;
                }
                cleanup(&temp_zip, None);
                return Err(error);
            }
        }
    }
    if chosen_branch.is_empty() {
        cleanup(&temp_zip, None);
        return Err(last_error.unwrap_or_else(|| "无法下载仓库 zip".to_string()));
    }

    let workspace_id = Uuid::new_v4().to_string();
    let dest = manager.plugins_root_dir().join("workspaces").join(&workspace_id);
    fs::create_dir_all(&dest)
        .map_err(|error| format!("创建导入目录失败：{error}"))?;

    let _ = on_event.send(GitHubImportEvent::Stage {
        stage: "extracting".to_string(),
        message: "正在校验并解压仓库".to_string(),
    });

    // 打开 zip，先预检（zip 炸弹），再解压。两遍都通过 by_index 随机访问完成。
    // 抽成纯函数 extract_repo_zip 以便单测覆盖 zip-slip / zip-bomb 回归用例。
    let file_count = extract_repo_zip(&temp_zip, &dest).map_err(|error| {
        cleanup(&temp_zip, Some(&dest));
        error
    })?;

    // 下载暂存文件不再需要。
    let _ = fs::remove_file(&temp_zip);

    let _ = on_event.send(GitHubImportEvent::Stage {
        stage: "registering".to_string(),
        message: "正在登记草稿工作区".to_string(),
    });

    // 登记草稿工作区账本条目（source_kind = ExternalTool，runtime 暂定 client，P1 会重新推导）。
    let provenance = normalize_release_provenance(
        PluginReleaseSourceKind::ExternalTool,
        Some(&format!("github.com/{owner}/{repo}@{chosen_branch}")),
    )?;
    let now = Utc::now().to_rfc3339();
    let workspace = DraftWorkspace {
        workspace_id: workspace_id.clone(),
        title: format!("{owner}/{repo}"),
        path: dest.to_string_lossy().to_string(),
        manifest_id: format!("gh-{owner}-{repo}"),
        current_version: "0.0.0".to_string(),
        runtime: "client".to_string(),
        source_kind: provenance.source_kind,
        source_label: provenance.source_label,
        conversation_id: None,
        diagnostic_status: DraftDiagnosticStatus::Idle,
        content_sha256: None,
        last_published_release_id: None,
        last_published_version: None,
        created_at: now.clone(),
        updated_at: now,
    };
    manager.register_imported_github_workspace(&workspace)?;

    let _ = on_event.send(GitHubImportEvent::Finished);

    Ok(GitHubImportResult {
        workspace_id,
        path: dest.to_string_lossy().to_string(),
        owner,
        repo,
        git_ref: chosen_branch,
        file_count,
        source_label: workspace.source_label,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    /// 在 `dir` 下写一个构造 zip 文件，条目名与内容由 `entries` 给出。
    fn write_zip(dir: &Path, name: &str, entries: &[(&str, &[u8])]) -> PathBuf {
        let path = dir.join(name);
        let file = fs::File::create(&path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let options = SimpleFileOptions::default();
        for (entry_name, content) in entries {
            writer.start_file(entry_name, options).unwrap();
            writer.write_all(content).unwrap();
        }
        writer.finish().unwrap();
        path
    }

    #[test]
    fn parse_owner_repo_accepts_slug_and_url() {
        assert_eq!(
            parse_owner_repo("octocat/hello-world").unwrap(),
            ("octocat".to_string(), "hello-world".to_string())
        );
        assert_eq!(
            parse_owner_repo("https://github.com/octocat/hello-world").unwrap(),
            ("octocat".to_string(), "hello-world".to_string())
        );
        assert_eq!(
            parse_owner_repo("https://github.com/octocat/hello-world.git").unwrap(),
            ("octocat".to_string(), "hello-world".to_string())
        );
        // 深链也只取 owner/repo 前两段。
        assert_eq!(
            parse_owner_repo("https://github.com/octocat/hello-world/tree/main/src").unwrap(),
            ("octocat".to_string(), "hello-world".to_string())
        );
    }

    #[test]
    fn parse_owner_repo_rejects_ssrf_and_injection() {
        // 非 github 主机：剥离后无法解析出合法两段（且下载 URL 主机固定为
        // codeload.github.com，仅使用校验过的 owner/repo，天然抗 SSRF）。
        assert!(parse_owner_repo("https://evil.example.com/owner/repo").is_err());
        // 单段、空。
        assert!(parse_owner_repo("justone").is_err());
        // owner 含非法字符。
        assert!(parse_owner_repo("own@er/repo").is_err());
        // 含非法字符的 repo。
        assert!(parse_owner_repo("owner/rep o").is_err());
    }

    #[test]
    fn parse_owner_repo_drops_trailing_segments() {
        // 深链 / 多余段被丢弃，只取前两段；不会因此产生越界或 SSRF。
        assert_eq!(
            parse_owner_repo("owner/repo/../../etc").unwrap(),
            ("owner".to_string(), "repo".to_string())
        );
    }

    #[test]
    fn strip_top_level_behaves() {
        assert_eq!(strip_top_level("repo-main/"), "");
        assert_eq!(strip_top_level("repo-main/src/main.py"), "src/main.py");
        assert_eq!(strip_top_level("bare.txt"), "bare.txt");
    }

    #[test]
    fn validate_relative_path_rejects_traversal() {
        assert!(validate_relative_path("../escape").is_err());
        assert!(validate_relative_path("/abs").is_err());
        assert!(validate_relative_path("a/../../b").is_err());
        assert!(validate_relative_path("normal/path.rs").is_ok());
    }

    #[test]
    fn extract_normal_zip_succeeds() {
        let tmp = std::env::temp_dir().join(format!("lf-gi-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        let zip = write_zip(
            &tmp,
            "repo.zip",
            &[
                ("repo-main/", b""),
                ("repo-main/src/main.py", b"print('hi')"),
                ("repo-main/README.md", b"hi"),
            ],
        );
        let dest = tmp.join("out");
        let count = extract_repo_zip(&zip, &dest).unwrap();
        assert_eq!(count, 2);
        assert!(dest.join("src/main.py").exists());
        assert!(dest.join("README.md").exists());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn extract_rejects_zip_slip_traversal() {
        let tmp = std::env::temp_dir().join(format!("lf-gi-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        // 顶层前缀剥掉后留下 `../evil.txt`，应被 zip-slip 防护拒绝。
        let zip = write_zip(
            &tmp,
            "slip.zip",
            &[("repo-main/../evil.txt", b"pwned")],
        );
        let dest = tmp.join("out");
        let result = extract_repo_zip(&zip, &dest);
        assert!(result.is_err(), "zip-slip 条目必须被拒绝");
        assert!(!tmp.join("evil.txt").exists(), "不得越界写出文件");
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn extract_rejects_zip_bomb_by_entry_count() {
        let tmp = std::env::temp_dir().join(format!("lf-gi-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        // 写入超过 MAX_ENTRIES 的大量小条目，触发 zip 炸弹条目数预检。
        let path = tmp.join("bomb.zip");
        let file = fs::File::create(&path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let options = SimpleFileOptions::default();
        let entries: Vec<(String, Vec<u8>)> = (0..MAX_ENTRIES as u32 + 5)
            .map(|index| (format!("repo-main/f{index}.txt"), b"x".to_vec()))
            .collect();
        for (name, content) in &entries {
            writer.start_file(name, options).unwrap();
            writer.write_all(content).unwrap();
        }
        writer.finish().unwrap();

        let dest = tmp.join("out");
        let result = extract_repo_zip(&path, &dest);
        assert!(result.is_err(), "条目数超限的 zip 必须被拒绝");
        assert!(!dest.exists(), "被拒后不应留下解压产物");
        let _ = fs::remove_dir_all(&tmp);
    }
}

