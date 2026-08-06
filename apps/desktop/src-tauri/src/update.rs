//! 自制更新检查 / 下载安装（design §5，替代已删除的 updater.rs + tauri-plugin-updater）。
//!
//! ## 摆脱 minisign 密钥
//! 不再用 Tauri updater 插件与 minisign 验签（PRD R1/R6）。改为：
//! - `check_update`：GET `<backend>/api/releases/latest?channel=&platform=&arch=&currentVersion=`，
//!   读后端 `updateAvailable` 标志 + 匹配 platform/arch 的 asset（含 `sha256`/`url`/`sizeBytes`）。
//! - `download_update`：下载安装包 EXE 到临时目录 → 流式算 SHA-256 与后端值比对 →
//!   复制安装目录的 `updater.exe` 到临时目录 → 启动它 `update --target <安装目录>
//!   --setup <下载的EXE> --wait-pid <自身pid> --restart` → 退出主程序，交给 updater 覆盖重启。
//!
//! ## 进度推送（沿用官方 Channel 模式，前端契约不变）
//! `download_update` 接收 `tauri::ipc::Channel<DownloadEvent>`，推 Started/Progress/Finished。
//! 事件 serde 契约与旧 updater.rs 完全一致（前端 lib/updater.ts 仅需扩展返回结构字段）。

use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::AppHandle;

// 更新发布者签名验签复用 minisign-verify（与 plugin_security 同款依赖，零新依赖）。
use minisign_verify::{PublicKey, Signature};

// === 下载地址安全校验（M1：更新通道=RCE 最高危面）===
//
// 自研 updater 仅比对后端下发的 SHA-256，而该值也来自同一后端——后端被入侵或
// 响应被中间人篡改时，攻击者可把下载地址换成恶意安装包接管整机。为此在真正
// 下载前加两道独立校验（fail-closed）：
//   1) 协议必须为 https（防明文 MITM 替换安装包）；
//   2) 目标主机不得为环回/私网/链路本地/云元数据等保留地址（防 SSRF / file:// 转向）。
// 以下两个函数与 main.rs::plugin_net_fetch 的 SSRF 防护同款（纯 std，零新依赖）。

/// 从完整 URL 中提取主机名（含 IPv6 的 `[..]` 包裹形式）。
fn extract_host(raw_url: &str) -> Option<String> {
    let authority = raw_url
        .split("://")
        .nth(1)?
        .split(['/', '?', '#'])
        .next()?;
    if authority.starts_with('[') {
        let end = authority.find(']')?;
        Some(authority[..=end].to_string())
    } else {
        Some(authority.split(':').next()?.to_string())
    }
}

/// 拒绝环回/私网/链路本地/未指定/组播地址（含云元数据 169.254.169.254）。
/// 域名会做 DNS 解析后逐一检查；解析失败按拦截处理（fail-closed）。
fn is_blocked_host(host: &str) -> bool {
    let host = host.trim_matches(['[', ']']).to_ascii_lowercase();
    if host == "localhost" {
        return true;
    }
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        return ip.is_loopback()
            || ip.is_private()
            || ip.is_link_local()
            || ip.is_unspecified()
            || ip.is_multicast();
    }
    let Ok(addrs) = std::net::ToSocketAddrs::to_socket_addrs(&format!("{host}:0")) else {
        return true;
    };
    addrs.any(|addr| {
        let ip = addr.ip();
        ip.is_loopback() || ip.is_private() || ip.is_link_local() || ip.is_unspecified() || ip.is_multicast()
    })
}

/// 校验更新下载地址安全：仅允许 https + 非保留/内网主机。失败时返回可读错误。
fn is_safe_download_url(url: &str) -> Result<(), String> {
    let Some(host) = extract_host(url) else {
        return Err("更新下载地址无法解析主机名，已拒绝".to_string());
    };
    // 协议检查：仅放行 https（file:/http:/data: 等一律拒绝）。
    let scheme = url.split("://").next().unwrap_or("");
    if !scheme.eq_ignore_ascii_case("https") {
        return Err(format!(
            "更新下载地址必须为 https（收到 {scheme}://...），已拒绝以防中间人篡改安装包"
        ));
    }
    if is_blocked_host(&host) {
        return Err("更新下载地址指向内网/保留地址，已拒绝（可能遭响应劫持）".to_string());
    }
    Ok(())
}

// === 更新发布者签名验签（M1+：真实性 = 防伪造安装包的最后一道关）===
//
// `sha256` 只能验证「下载内容 == 后端声称的内容」，而该值来自同一后端——后端被入侵或
// 响应被中间人篡改时，攻击者可把下载地址换成恶意安装包并同时改写 sha256。真正的真实性
// 必须由发布者私钥签名、桌面壳用配置的公钥验签来保证（与 plugin_security 同机制）。
//
// 公钥来源：env `LINGFANG_UPDATER_PUBKEY`（minisign base64 公钥）。未配置时保持现有
// SHA-256 行为，但更新时明确告警（非静默降级）；配置后则强制要求并验签（fail-closed）。

/// 读取更新发布者公钥（minisign base64）。未配置返回 None。
fn read_updater_pubkey() -> Option<String> {
    std::env::var("LINGFANG_UPDATER_PUBKEY")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// 用发布者公钥验签安装包字节。任何失败（公钥非法/签名非法/不匹配）一律返回 Err（fail-closed）。
fn verify_update_signature(pubkey_b64: &str, message: &[u8], signature_text: &str) -> Result<(), String> {
    let pubkey = PublicKey::from_base64(pubkey_b64).map_err(|e| format!("更新验签公钥格式非法：{e}"))?;
    let signature = Signature::decode(signature_text).map_err(|e| format!("更新签名格式非法：{e}"))?;
    pubkey
        .verify(message, &signature, false)
        .map_err(|e| format!("更新签名验证失败（安装包可能遭伪造）：{e}"))
}

/// 检查更新返回给前端的元数据（camelCase）。
///
/// 在旧 UpdateMetadata 基础上新增 `download_url` / `sha256` / `size_bytes`，
/// 供 download_update 下载 + 校验。`available` 恒 true（无更新返 None）。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMetadata {
    version: String,
    current_version: String,
    available: bool,
    notes: Option<String>,
    download_url: String,
    sha256: String,
    /// 发布者 minisign 签名文本（.minisig 内容）；后端未签名时为空。
    #[serde(default)]
    signature: String,
    size_bytes: Option<u64>,
}

/// 下载安装进度事件（Channel 推送，serde 契约与旧实现一致）。
#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum DownloadEvent {
    #[serde(rename_all = "camelCase")]
    Started {
        content_length: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    Progress {
        chunk_length: usize,
    },
    Finished,
}

// === 后端 /api/releases/latest 响应（部分字段，serde 反序列化）===

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LatestRelease {
    version: String,
    notes: Option<String>,
    #[serde(default)]
    update_available: Option<bool>,
    #[serde(default)]
    assets: Vec<LatestAsset>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LatestAsset {
    platform: String,
    arch: String,
    url: String,
    #[serde(default)]
    sha256: String,
    /// 发布者 minisign 签名文本（.minisig 内容）；后端未签名时缺省为空。
    #[serde(default)]
    signature: String,
    #[serde(default)]
    size_bytes: Option<u64>,
}

/// 拼接 latest 端点 URL（纯函数，便于单测）。
fn build_latest_url(
    backend: &str,
    channel: &str,
    platform: &str,
    arch: &str,
    version: &str,
) -> String {
    format!(
        "{}/api/releases/latest?channel={}&platform={}&arch={}&currentVersion={}",
        backend.trim_end_matches('/'),
        channel,
        platform,
        arch,
        version,
    )
}

/// 把相对 url（/downloads/xxx）拼成绝对地址；已是绝对则原样返回（纯函数）。
fn absolute_url(backend: &str, asset_url: &str) -> String {
    if asset_url.starts_with("http://") || asset_url.starts_with("https://") {
        asset_url.to_string()
    } else {
        format!(
            "{}/{}",
            backend.trim_end_matches('/'),
            asset_url.trim_start_matches('/')
        )
    }
}

/// 当前平台映射到后端枚举值（与后端 AssetPlatform/AssetArch 对齐）。
fn current_platform() -> (&'static str, &'static str) {
    let os = match std::env::consts::OS {
        "windows" => "WINDOWS",
        "macos" => "DARWIN",
        "linux" => "LINUX",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "X86_64",
        "aarch64" => "AARCH64",
        other => other,
    };
    (os, arch)
}

/// 命令：检查更新（不下载）。
///
/// 返回 Some(UpdateMetadata) 表示有更新；None 表示已是最新 / 无匹配平台产物 / 后端无已发布版本。
#[tauri::command]
pub async fn check_update(
    app: AppHandle,
    channel: String,
    backend_url: String,
) -> Result<Option<UpdateMetadata>, String> {
    let (platform, arch) = current_platform();
    let current_version = app.package_info().version.to_string();
    let url = build_latest_url(&backend_url, &channel, platform, arch, &current_version);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;

    // 后端无已发布版本时返 404（release_not_found）→ 视为无更新；其他错误必须暴露给前端。
    if !resp.status().is_success() {
        let status = resp.status();
        if status == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let detail = resp.text().await.unwrap_or_default();
        let detail = detail.trim();
        let suffix = if detail.is_empty() {
            String::new()
        } else {
            format!("：{}", detail.chars().take(300).collect::<String>())
        };
        return Err(format!("检查更新失败，HTTP {status}{suffix}"));
    }
    let release: LatestRelease = resp.json().await.map_err(|e| e.to_string())?;

    // 后端 updateAvailable 为 false / 缺失（未传 currentVersion 不会缺失）→ 无更新。
    if release.update_available != Some(true) {
        return Ok(None);
    }

    // 挑当前 platform/arch 匹配且有 sha256 的 asset。
    let asset = release
        .assets
        .iter()
        .find(|a| a.platform == platform && a.arch == arch);
    let asset = match asset {
        Some(a) => a.clone(),
        None => return Ok(None), // 无匹配平台产物 → 无更新
    };

    Ok(Some(UpdateMetadata {
        version: release.version,
        current_version,
        available: true,
        notes: release.notes,
        download_url: absolute_url(&backend_url, &asset.url),
        sha256: asset.sha256,
        signature: asset.signature,
        size_bytes: asset.size_bytes,
    }))
}

/// 命令：下载更新包 → 校验 SHA-256 → 调起 updater.exe 覆盖重启（design §5）。
///
/// 前端入参：`{ meta: UpdateMetadata, onEvent: Channel<DownloadEvent> }`。
/// 成功路径下本函数末尾会 app.exit()，Promise 不会 resolve（进程已退出）。
#[tauri::command]
pub async fn download_update(
    app: AppHandle,
    meta: UpdateMetadataInput,
    on_event: Channel<DownloadEvent>,
) -> Result<(), String> {
    if meta.sha256.trim().is_empty() {
        return Err(
            "该版本缺少 SHA-256 校验值，已拒绝更新（请联系管理员重新上传安装包）".to_string(),
        );
    }

    // M1：下载前最后一道关——强制 https + 拒绝内网/本地地址（fail-closed）。
    is_safe_download_url(&meta.download_url).map_err(|e| {
        format!("{e}（如需内网分发，请改用受信任的 https 镜像源）")
    })?;

    // 1) 下载到临时目录。先清扫历史残留安装包（历次失败/中断会留下 LingFang-Setup-*.exe，累积占盘）。
    let temp_dir = std::env::temp_dir();
    clean_stale_setups(&temp_dir);
    let setup_path = temp_dir.join(format!("LingFang-Setup-{}.exe", sanitize(&meta.version)));

    // connect_timeout 限建连、read_timeout 限单次读（每 chunk）：500MB+ 安装包「慢但持续」的下载
    // 不会被误杀。旧实现用 600s 全局 timeout（整段响应体），慢网下大文件可能超时失败。
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .read_timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;

    // 下载失败（建连/HTTP/读chunk/写盘）统一清理半截文件，再把错误暴露给前端（前端可重试）。
    if let Err(e) = download_to_file(&client, &meta.download_url, &setup_path, &on_event).await {
        let _ = std::fs::remove_file(&setup_path);
        return Err(e);
    }

    // 2) 流式校验 SHA-256。
    let actual = match sha256_hex(&setup_path) {
        Ok(h) => h,
        Err(e) => {
            let _ = std::fs::remove_file(&setup_path);
            return Err(format!("无法读取安装包进行完整性校验：{e}"));
        }
    };
    if !actual.eq_ignore_ascii_case(meta.sha256.trim()) {
        let _ = std::fs::remove_file(&setup_path);
        return Err(format!(
            "安装包校验失败：SHA-256 不匹配（期望 {}，实际 {}），已中止更新。请重试，或联系管理员确认安装包是否损坏",
            meta.sha256, actual
        ));
    }

    // M1+：发布者签名验签（真实性）。配置公钥后强制要求并验证（fail-closed）；
    // 未配置则明确告警——保持现有 SHA-256 行为，但绝不静默假称已验签。
    match read_updater_pubkey() {
        Some(pubkey) => {
            if meta.signature.trim().is_empty() {
                let _ = std::fs::remove_file(&setup_path);
                return Err(
                    "已配置更新签名公钥，但本次更新缺少签名（signature），已拒绝以防伪造安装包（请让后端下发 minisign 签名）"
                        .to_string(),
                );
            }
            let bytes =
                std::fs::read(&setup_path).map_err(|e| format!("读取安装包以验签失败：{e}"))?;
            if let Err(e) = verify_update_signature(&pubkey, &bytes, &meta.signature) {
                let _ = std::fs::remove_file(&setup_path);
                return Err(e);
            }
        }
        None => {
            eprintln!(
                "[updater] 警告：未配置 LINGFANG_UPDATER_PUBKEY，更新仅做 SHA-256 校验（该值来自同一后端，被入侵即失效）。生产环境请配置发布者公钥并让后端对安装包下发 minisign 签名。"
            );
        }
    }

    let _ = on_event.send(DownloadEvent::Finished);

    // 3) 定位安装目录与 updater.exe，复制到临时目录（避免覆盖时占用自身）。
    let main_exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let install_dir = main_exe
        .parent()
        .ok_or_else(|| "无法定位安装目录".to_string())?
        .to_path_buf();
    let installed_updater = install_dir.join("updater.exe");
    if !installed_updater.exists() {
        return Err(
            "安装目录缺少 updater.exe，无法自动更新（请手动下载安装包覆盖安装）".to_string(),
        );
    }
    let pid = std::process::id();
    let temp_updater = temp_dir.join(format!("lingfang-updater-{pid}.exe"));
    std::fs::copy(&installed_updater, &temp_updater).map_err(|e| e.to_string())?;

    // 4) 启动临时 updater：等本进程退出 → 静默覆盖 → 重启。
    std::process::Command::new(&temp_updater)
        .arg("update")
        .arg("--target")
        .arg(&install_dir)
        .arg("--setup")
        .arg(&setup_path)
        .arg("--wait-pid")
        .arg(pid.to_string())
        .arg("--restart")
        .spawn()
        .map_err(|e| format!("启动更新器失败：{e}"))?;

    // 5) 退出主程序，交给 updater。
    app.exit(0);
    Ok(())
}

/// 流式下载安装包到 `path`，经 Channel 推送 Started/Progress 事件；返回服务端 Content-Length（未知则 None）。
///
/// 任何网络 / I/O 错误返回 Err，由调用方统一清理残留文件（本函数不删，避免双重清理竞态）。
async fn download_to_file(
    client: &reqwest::Client,
    url: &str,
    path: &std::path::Path,
    on_event: &Channel<DownloadEvent>,
) -> Result<Option<u64>, String> {
    use std::io::Write;
    let mut resp = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("下载失败，HTTP {}", resp.status()));
    }
    let content_length = resp.content_length();
    let started = AtomicBool::new(false);
    let mut file = std::fs::File::create(path).map_err(|e| e.to_string())?;
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        if started
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            let _ = on_event.send(DownloadEvent::Started { content_length });
        }
        let _ = on_event.send(DownloadEvent::Progress {
            chunk_length: chunk.len(),
        });
        file.write_all(&chunk).map_err(|e| e.to_string())?;
    }
    file.flush().map_err(|e| e.to_string())?;
    Ok(content_length)
}

/// 清理临时目录里残留的旧安装包（best-effort，失败静默）。
///
/// 历次下载失败 / 中断会留下 `LingFang-Setup-*.exe`，长期累积占用磁盘；更新开始前统一清扫。
fn clean_stale_setups(temp_dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(temp_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if name.starts_with("LingFang-Setup-") && name.ends_with(".exe") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// download_update 的入参（前端传完整 meta；与 UpdateMetadata 同构，单独定义 Deserialize 入参）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMetadataInput {
    #[allow(dead_code)]
    version: String,
    download_url: String,
    sha256: String,
    /// 发布者 minisign 签名文本（.minisig 内容）；后端未签名时缺省为空。
    #[serde(default)]
    signature: String,
}

/// 流式计算文件 SHA-256（小写十六进制）。
fn sha256_hex(path: &std::path::Path) -> std::io::Result<String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut f = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex_lower(&hasher.finalize()))
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}

/// 版本号清洗为安全文件名片段（防路径穿越）。
fn sanitize(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_latest_url_trims_slash() {
        assert_eq!(
            build_latest_url("http://localhost:3000/", "STABLE", "WINDOWS", "X86_64", "0.0.1"),
            "http://localhost:3000/api/releases/latest?channel=STABLE&platform=WINDOWS&arch=X86_64&currentVersion=0.0.1"
        );
    }

    #[test]
    fn absolute_url_keeps_absolute() {
        assert_eq!(
            absolute_url("http://x", "https://cdn/y.exe"),
            "https://cdn/y.exe"
        );
    }

    #[test]
    fn absolute_url_joins_relative() {
        assert_eq!(
            absolute_url("http://x/", "/downloads/y.exe"),
            "http://x/downloads/y.exe"
        );
    }

    #[test]
    fn current_platform_maps() {
        let (os, arch) = current_platform();
        #[cfg(target_os = "windows")]
        assert_eq!(os, "WINDOWS");
        #[cfg(target_arch = "x86_64")]
        assert_eq!(arch, "X86_64");
        assert!(!os.is_empty() && !arch.is_empty());
    }

    #[test]
    fn hex_lower_correct() {
        assert_eq!(hex_lower(&[0x00, 0xab, 0xff]), "00abff");
    }

    #[test]
    fn sanitize_strips_unsafe() {
        assert_eq!(sanitize("1.0.0-beta"), "1.0.0-beta");
        assert_eq!(sanitize("../etc/x"), ".._etc_x");
    }

    #[test]
    fn download_event_serializes_contract() {
        let started = DownloadEvent::Started {
            content_length: Some(1024),
        };
        let json = serde_json::to_string(&started).unwrap();
        assert!(json.contains("\"event\":\"Started\""));
        assert!(json.contains("\"contentLength\":1024"));
    }
}
