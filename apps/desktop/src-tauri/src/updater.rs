//! 检查更新 / 下载安装通道（design §4.4，Tauri updater 插件封装）。
//!
//! ## Tauri updater 契约（固定，不可变）
//! updater 期望 endpoint 返回固定 JSON 结构（后端 `/api/releases/tauri-update` 已适配）：
//! ```jsonc
//! { "version": "1.0.0", "pub_date": "2026-06-14T12:00:06.843Z",
//!   "url": "https://.../LingFang_1.0.0_x64-setup.exe",
//!   "signature": "dW50cnVzdGVk...",  // base64 minisign 签名
//!   "notes": "## changelog..." }
//! ```
//! - HTTP 200 + 此结构 → 有更新，updater 下载 url 指向的包，用 pubkey 验 signature 后安装。
//! - 非 200（如 204 No Content）→ 无更新（后端无已发布版本 / 无匹配平台产物时返 204）。
//! - `pub_date` 字段名带下划线（非 camelCase），严格遵循契约。
//!
//! ## endpoint 动态注入（不写死 conf.json 的原因）
//! `tauri.conf.json` 的 `plugins.updater.endpoints` 留空数组（必须有该 key 插件才初始化）。
//! 真实 URL 由 `check_update` 命令运行时通过 `app.updater_builder().endpoints(vec![url])` 注入：
//! 因为后端地址是用户在设置页动态配置的（`lf:backendUrl`），不能写死在打包时确定的 conf.json。
//! pubkey（公开）内嵌 conf.json 用于验签，私钥（`.tauri/lingfang.key`）永不入仓。
//!
//! ## 签名验签机制（强制，不可绕过）
//! updater 协议强制 minisign 验签：下载的安装包必须用与 conf.json pubkey 配对的私钥签名，
//! 否则 `download_and_install` 在 install 阶段 `verify_signature` 失败抛错（design §6/§8）。
//! 构建时设 `TAURI_SIGNING_PRIVATE_KEY_PATH` 产物自动生成 `.sig`，其内容需上传到 release asset。
//!
//! ## check / install 分离（官方 PendingUpdate 模式）
//! `check_update` 拿到的 `Option<Update>` 存进全局 State（PendingUpdate），`download_and_install`
//! 调用时 take 出来执行。这样前端可以先「检查」展示 Dialog（版本号 + notes），用户确认后再「安装」。
//!
//! ## 进度推送（官方 Channel 模式，类型安全优于 emit）
//! `download_and_install` 接收 `tauri::ipc::Channel<DownloadEvent>`，通过 `on_event.send(...)`
//! 推 Started/Progress/Finished 事件给前端（类型安全，比 `app.emit` 字符串事件优）。
//! 首次 on_chunk 回调时 send Started（带 Content-Length），之后每个 chunk send Progress。

use std::sync::Mutex;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// 全局 State：缓存 `check_update` 拿到的 Update，供后续 `download_and_install` 取用。
///
/// 官方 PendingUpdate 模式：check 与 install 分离（前端先展示 Dialog，用户确认后再安装）。
/// `Mutex<Option<Update>>`：单槽位，同时仅允许一个待安装更新（前端按钮互斥保证）。
pub struct PendingUpdate(pub Mutex<Option<Update>>);

/// 检查更新的返回结构（前端展示 Dialog 用）。
///
/// serde rename_all = "camelCase"：version / currentVersion / available / notes。
/// `available` 始终为 true（仅当有更新时才构造此结构；无更新返回 None），保留字段兼容前端类型。
///
/// pub 可见性：`#[tauri::command]` 宏展开生成的 `__cmd__check_update` 是 pub(crate)，
/// 暴露返回类型给 main.rs 的 generate_handler!，故类型必须 pub（design §4.4 未标注，编译器强制要求）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMetadata {
    version: String,
    current_version: String,
    available: bool,
    notes: Option<String>,
}

/// 下载安装进度事件（Channel 推送给前端）。
///
/// serde tag = "event", content = "data"（顶层只标 tag/content，不标 rename_all）。
/// 每个变体单独 `#[serde(rename_all = "camelCase")]`：serde 的 rename_all 在 enum 顶层只
/// rename 变体名（Started → started），变体内部字段名（content_length）需要变体级 rename_all
/// 才能转 camelCase（contentLength）。与官方 tauri-plugin-updater 2.10.1 commands.rs 写法一致。
/// 前端收到 `{ event: "Started", data: { contentLength: 12345 } }`（event 是 PascalCase，
/// 字段是 camelCase，对齐官方 @tauri-apps/plugin-updater JS 端 switch(event.event){case 'Started':...}）。
/// 必须实现 Clone（Channel::send 要求 payload: Serialize + Clone）。
///
/// pub 可见性：作为 download_and_install 的 Channel<DownloadEvent> 参数类型，同理须 pub。
#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum DownloadEvent {
    /// 下载开始（首个 chunk 到达时发送，带总字节数，未知则 None）。
    #[serde(rename_all = "camelCase")]
    Started { content_length: Option<u64> },
    /// 下载进度（每个 chunk 发送一次，chunk_length 为本次块字节数）。
    #[serde(rename_all = "camelCase")]
    Progress { chunk_length: usize },
    /// 下载完成（即将进入安装阶段）。
    Finished,
}

/// 拼接 Tauri updater endpoint URL（纯函数，便于单测）。
///
/// 规则（design §2 数据流）：
/// - 后端地址去尾部斜杠后拼 `/api/releases/tauri-update`。
/// - query 参数顺序固定：channel → platform → arch → current_version（与后端 DTO 字段无关，
///   query 参数顺序不影响后端解析，仅用于单测断言 URL 字符串稳定）。
/// - 不引入 url crate（design §4.5 优化），用 format! 直接拼字符串。
fn build_update_url(
    backend: &str,
    channel: &str,
    platform: &str,
    arch: &str,
    version: &str,
) -> String {
    format!(
        "{}/api/releases/tauri-update?channel={}&platform={}&arch={}&current_version={}",
        backend.trim_end_matches('/'),
        channel,
        platform,
        arch,
        version,
    )
}

/// 当前平台映射到后端枚举值（design §3 平台映射表）。
///
/// `std::env::consts::OS`（windows/macos/linux）→ 后端 platform 枚举（WINDOWS/DARWIN/LINUX）。
/// `std::env::consts::ARCH`（x86_64/aarch64）→ 后端 arch 枚举（X86_64/AARCH64）。
/// 未映射的 OS/ARCH 原样返回（后端找不到匹配 asset 时返 204，前端按「无更新」处理）。
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

/// 命令：检查更新（不下载，仅查询后端是否有新版本）。
///
/// 前端入参：`{ channel: 'STABLE', backendUrl: 'http://...' }`。
/// 返回 `Option<UpdateMetadata>`：有更新 → Some（version + notes）；无更新 → None。
///
/// 流程（design §2 数据流）：
/// 1. current_platform() 取 OS/ARCH 映射到后端枚举。
/// 2. app.package_info().version 取当前版本（tauri.conf.json 的 version 字段）。
/// 3. build_update_url 拼出契约端点 URL（String）。
/// 4. url::Url::parse 把 String 转 Url（tauri-plugin-updater 2.x 的 endpoints 强制 Vec<Url>）。
/// 5. app.updater_builder().endpoints([url]) 动态注入后端地址（不写死 conf.json）。
/// 6. build().check().await 拿到 Option<Update>（updater 内部比对 version 判定有无更新）。
/// 7. 先 as_ref 构造 UpdateMetadata（借用，不 move），再把整个 Option<Update> move 进 PendingUpdate。
///    注意 borrow 顺序：as_ref().map() 产生的 meta 借用 update，必须在 move update 之前完成并返回。
#[tauri::command]
pub async fn check_update(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
    channel: String,
    backend_url: String,
) -> Result<Option<UpdateMetadata>, String> {
    let (platform, arch) = current_platform();
    let current_version = app.package_info().version.to_string();
    let url_string = build_update_url(&backend_url, &channel, platform, arch, &current_version);
    // String → Url：endpoints 要求 Vec<Url>，parse 失败说明后端地址非法（前端校验应已拦截）。
    let url = url::Url::parse(&url_string).map_err(|e| e.to_string())?;

    // 动态注入 endpoint：updater_builder 读 conf.json 的 pubkey/timeout 等，但 endpoints 运行时覆盖。
    // 注意：release 模式 updater 强制 HTTPS endpoint（防中间人篡改更新包），HTTP 仅 dev 允许。
    // 本地/内网部署用 HTTP 后端时，tauri.conf.json 的 plugins.updater.dangerousInsecureTransportProtocol=true 放行。
    let update = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;

    // 先借用 update 构造 meta（as_ref 不消费 update），再 move update 进 PendingUpdate。
    // 注意：meta 在 move update 之前已构造完毕（值类型 Option<UpdateMetadata>，不再借用 update）。
    let meta = update.as_ref().map(|u| UpdateMetadata {
        version: u.version.clone(),
        current_version: u.current_version.clone(),
        available: true,
        notes: u.body.clone(),
    });

    // 存进全局 State 供 download_and_install 取用（check 与 install 分离）。
    *pending.0.lock().map_err(|e| e.to_string())? = update;

    Ok(meta)
}

/// 命令：下载并安装待处理的更新（从 PendingUpdate 取出 Update 执行）。
///
/// 前端入参：`{ onEvent: Channel<DownloadEvent> }`（Tauri 自动把前端回调桥接成 Channel）。
/// 流程（design §2 数据流）：
/// 1. take 出 PendingUpdate 里的 Update（若 None 说明没检查过更新，报错引导前端先检查）。
/// 2. download_and_install 两个闭包：
///    - on_chunk(chunk_length, content_length)：首个 chunk 时 send Started（带 content_length），
///      每个 chunk 都 send Progress（chunk_length）。官方 first_chunk 模式（来自 docs.rs 源码）。
///    - on_download_finish()：send Finished（FnOnce，仅调一次）。
/// 3. 下载 + 验签 + 安装成功后 app.restart() 重启到新版本。
///
/// 错误处理：verify_signature 失败（签名不匹配/为空）、网络失败等通过 .map_err 抛给前端。
///
/// 注意：`app.restart()` 返回 `!`（never type，进程退出），故作为函数尾表达式直接返回——
/// `!` 强转为 `Result<(), String>`，无需显式 `Ok(())`（否则触发 unreachable_code warning）。
#[tauri::command]
pub async fn download_and_install(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
    on_event: Channel<DownloadEvent>,
) -> Result<(), String> {
    // take 出 check 阶段存的 Update（check 与 install 分离，前端必须先 check）。
    let update = pending
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .take()
        .ok_or_else(|| "没有待安装的更新，请先检查更新".to_string())?;

    // 官方 first_chunk 模式：首个 chunk 到达时发 Started（此时才知道 Content-Length）。
    // 用 AtomicBool 而非 Mutex<bool>：on_chunk 是 FnMut（单线程内顺序调用），原子量更轻量。
    let started = std::sync::atomic::AtomicBool::new(false);

    update
        .download_and_install(
            |chunk_length, content_length| {
                // 首个 chunk：发 Started（带总字节数）。compare_exchange 保证只发一次。
                if started
                    .compare_exchange(
                        false,
                        true,
                        std::sync::atomic::Ordering::SeqCst,
                        std::sync::atomic::Ordering::SeqCst,
                    )
                    .is_ok()
                {
                    let _ = on_event.send(DownloadEvent::Started { content_length });
                }
                // 每个 chunk 都发 Progress（前端累加 chunk_length 算已下载量）。
                let _ = on_event.send(DownloadEvent::Progress { chunk_length });
            },
            || {
                // 下载完成：发 Finished（即将进入安装阶段）。
                let _ = on_event.send(DownloadEvent::Finished);
            },
        )
        .await
        .map_err(|e| e.to_string())?;

    // 安装成功后重启应用（新版本生效）。restart 内部走 on_before_exit 钩子清理后退出，由系统拉起新版。
    // restart 返回 !（never type），作为尾表达式直接强转为 Result<(), String>，不写 Ok(())。
    app.restart()
}

// === 单元测试（design §7 验证策略） ===
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_update_url_correct() {
        // design §4.4：URL 拼接规则——去尾斜杠 + query 参数顺序固定。
        // 正常后端地址（无尾斜杠）。
        let url = build_update_url(
            "http://localhost:3000",
            "STABLE",
            "WINDOWS",
            "X86_64",
            "0.0.1",
        );
        assert_eq!(
            url,
            "http://localhost:3000/api/releases/tauri-update?channel=STABLE&platform=WINDOWS&arch=X86_64&current_version=0.0.1"
        );

        // 后端地址带尾斜杠：应被 trim_end_matches('/') 去掉，避免双斜杠。
        let url = build_update_url(
            "http://localhost:3000/",
            "STABLE",
            "WINDOWS",
            "X86_64",
            "0.0.1",
        );
        assert_eq!(
            url,
            "http://localhost:3000/api/releases/tauri-update?channel=STABLE&platform=WINDOWS&arch=X86_64&current_version=0.0.1"
        );

        // 多个尾斜杠也应全部去除。
        let url = build_update_url(
            "http://localhost:3000///",
            "BETA",
            "DARWIN",
            "AARCH64",
            "1.2.3",
        );
        assert_eq!(
            url,
            "http://localhost:3000/api/releases/tauri-update?channel=BETA&platform=DARWIN&arch=AARCH64&current_version=1.2.3"
        );
    }

    #[test]
    fn current_platform_maps_correctly() {
        // design §3 平台映射表：std::env::consts OS/ARCH → 后端枚举值。
        // 用 cfg gate：当前编译平台断言正确映射，跨平台时本测在对应平台才精确（本机 Windows）。
        let (os, arch) = current_platform();

        #[cfg(target_os = "windows")]
        {
            assert_eq!(os, "WINDOWS", "Windows 平台应映射为 WINDOWS");
        }
        #[cfg(target_os = "macos")]
        {
            assert_eq!(os, "DARWIN", "macOS 平台应映射为 DARWIN");
        }
        #[cfg(target_os = "linux")]
        {
            assert_eq!(os, "LINUX", "Linux 平台应映射为 LINUX");
        }

        #[cfg(target_arch = "x86_64")]
        {
            assert_eq!(arch, "X86_64", "x86_64 架构应映射为 X86_64");
        }
        #[cfg(target_arch = "aarch64")]
        {
            assert_eq!(arch, "AARCH64", "aarch64 架构应映射为 AARCH64");
        }

        // OS/ARCH 均非空字符串（防御性：映射函数不应返回空值）。
        assert!(!os.is_empty(), "OS 映射不应为空");
        assert!(!arch.is_empty(), "ARCH 映射不应为空");
    }

    #[test]
    fn download_event_serializes_official_contract() {
        // DownloadEvent serde 契约（对齐官方 tauri-plugin-updater 2.10.1 commands.rs）：
        // - tag="event", content="data"（顶层无 rename_all）。
        // - 变体名（tag 值）保持 PascalCase：Started / Progress / Finished。
        // - 变体内部字段 rename_all="camelCase"：contentLength / chunkLength。
        // 官方 @tauri-apps/plugin-updater JS 端按 PascalCase event 分发（switch(event.event){case 'Started':...}），
        // 此契约保证前端可兼容官方 JS 库或自行解析。
        let started = DownloadEvent::Started {
            content_length: Some(1024),
        };
        let json = serde_json::to_string(&started).unwrap();
        assert!(
            json.contains("\"event\":\"Started\""),
            "Started 事件 event 字段应为 PascalCase Started：{}",
            json
        );
        assert!(
            json.contains("\"contentLength\":1024"),
            "Started 事件 contentLength 应为 camelCase：{}",
            json
        );

        let progress = DownloadEvent::Progress { chunk_length: 256 };
        let json = serde_json::to_string(&progress).unwrap();
        assert!(
            json.contains("\"event\":\"Progress\""),
            "Progress 事件 event 字段应为 PascalCase Progress：{}",
            json
        );
        assert!(
            json.contains("\"chunkLength\":256"),
            "Progress 事件 chunkLength 应为 camelCase：{}",
            json
        );

        let finished = DownloadEvent::Finished;
        let json = serde_json::to_string(&finished).unwrap();
        assert!(
            json.contains("\"event\":\"Finished\""),
            "Finished 事件 event 字段应为 PascalCase Finished：{}",
            json
        );

        // 完整结构校验（确保 tag/content 拓扑正确）。
        let full = serde_json::to_string(&DownloadEvent::Started {
            content_length: None,
        })
        .unwrap();
        assert_eq!(
            full,
            "{\"event\":\"Started\",\"data\":{\"contentLength\":null}}"
        );
    }

    #[test]
    fn update_metadata_serializes_camel_case() {
        // design §4.4：UpdateMetadata serde rename_all="camelCase"。
        // 前端依赖字段名：version / currentVersion / available / notes。
        let meta = UpdateMetadata {
            version: "1.0.0".to_string(),
            current_version: "0.0.1".to_string(),
            available: true,
            notes: Some("## changelog".to_string()),
        };
        let json = serde_json::to_string(&meta).unwrap();
        assert!(json.contains("\"version\":\"1.0.0\""));
        assert!(
            json.contains("\"currentVersion\":\"0.0.1\""),
            "current_version 应序列化为 currentVersion：{}",
            json
        );
        assert!(json.contains("\"available\":true"));
        assert!(json.contains("\"notes\":\"## changelog\""));

        // notes 为 None 时序列化为 null。
        let meta_no_notes = UpdateMetadata {
            version: "1.0.0".to_string(),
            current_version: "0.0.1".to_string(),
            available: true,
            notes: None,
        };
        let json = serde_json::to_string(&meta_no_notes).unwrap();
        assert!(json.contains("\"notes\":null"));
    }
}
