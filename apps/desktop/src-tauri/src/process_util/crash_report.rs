//! 桌面端崩溃上报（P3-2）。
//!
//! 设计（工单 T3 确认）：**落盘 + 下次启动上报**，不引入 sentry-rust 网络依赖、离线安全。
//! - `install_panic_hook`：在最早期注册 `std::panic::set_hook`，panic 时把结构化 payload
//!   写入 `app_data_dir/crash-<timestamp>.json`，并 `eprintln!` 兜底。hook 内部全程 `unwrap_or`
//!   吞错，保证二次 panic 不会炸掉进程。
//! - `report_pending_crashes`：下次启动早期扫描 `crash-*.json`；若 `SENTRY_DSN` 已配置则经
//!   `reqwest::blocking` POST 到 DSN ingest（Sentry store 端点），成功后删除文件；否则保留供诊断。
//!
//! 版本号采用编译期 `CARGO_PKG_VERSION`（=tauri.conf.json/Cargo.toml 的 0.1.11，权威单一来源），
//! 不依赖运行时 `AppHandle`，使 panic hook 阶段与单测均无需构造 AppHandle。

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::Manager;

/// 崩溃上报落盘文件名前缀（扫描时按 `crash-*.json` 匹配）。
const CRASH_FILE_PREFIX: &str = "crash-";
const CRASH_FILE_SUFFIX: &str = ".json";

/// 结构化崩溃 payload。版本号与环境信息来自宿主运行时，不含任何凭据。
#[derive(Serialize, serde::Deserialize, Debug, PartialEq)]
pub(crate) struct CrashReport {
    pub app_version: String,
    pub platform: String,
    pub timestamp: String,
    pub message: String,
    pub location: String,
}

/// 构造崩溃 payload（返回值可被单测断言，不触发任何 IO，不需 AppHandle）。
pub(crate) fn build_crash_payload(message: &str, location: &str) -> CrashReport {
    CrashReport {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        platform: std::env::consts::OS.to_string(),
        timestamp: crate::process_util::now_string(),
        message: message.to_string(),
        location: location.to_string(),
    }
}

/// 落盘崩溃 payload 到 `app_data_dir/crash-<timestamp>.json`。
/// 失败静默返回 None（不抛），由调用方 eprintln 兜底。
pub(crate) fn write_crash_file(app_data_dir: &Path, payload: &CrashReport) -> Option<PathBuf> {
    let dir = app_data_dir;
    let _ = std::fs::create_dir_all(dir);
    // 文件名用文件系统安全的时间戳（Windows 路径不允许冒号）：把 ISO 时间戳的 ':' 替换为 '-'。
    // payload.timestamp 内部仍保留原 ISO 8601（可读、可解析），仅文件名落盘用安全形式。
    let fs_safe_ts = payload.timestamp.replace(':', "-");
    let file_name = format!("{CRASH_FILE_PREFIX}{fs_safe_ts}{CRASH_FILE_SUFFIX}");
    let path = dir.join(file_name);
    let json = serde_json::to_string_pretty(payload).ok()?;
    std::fs::write(&path, json).ok()?;
    Some(path)
}

/// 注册 panic hook：panic 时落盘 + eprintln 兜底。hook 内不抛，避免二次 panic。
pub(crate) fn install_panic_hook() {
    // 保留既有 hook（如有），在其之后追加我们的上报逻辑。
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info: &std::panic::PanicHookInfo| {
        // 先执行既有 hook（如默认打印），保证原有行为不丢。
        prev(info);

        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "未知 panic".to_string());
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "未知位置".to_string());

        // 落盘：尽力而为，失败仅 eprintln，绝不 panic。
        let payload = build_crash_payload(&message, &location);
        // 优先用宿主 app_data_dir；panic 阶段 AppHandle 不可得，回退到可执行文件旁 crashes/。
        let dir = app_data_dir_best_effort();
        match dir.and_then(|d| write_crash_file(&d, &payload)) {
            Some(path) => eprintln!("[crash-report] panic 已落盘：{}", path.display()),
            None => eprintln!("[crash-report] panic 落盘失败：{message} @ {location}"),
        }
    }));
}

/// panic hook 阶段无法拿到 AppHandle，用可执行文件旁 `crashes/` 目录兜底（可被下次启动扫描到）。
fn app_data_dir_best_effort() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|p| p.to_path_buf()))
        .map(|dir| dir.join("crashes"))
}

/// 下次启动早期：扫描并上报上次崩溃（仅当 `SENTRY_DSN` 配置）。
/// 成功上报后删除对应文件；上报失败或 DSN 未配则保留。
pub(crate) fn report_pending_crashes(app: &tauri::AppHandle) {
    let dsn = std::env::var("SENTRY_DSN").unwrap_or_default();
    // 扫描范围：app_data_dir（正式目录）+ panic hook 降级目录（current_exe()/crashes）。
    // 二者必须都扫——panic 阶段拿不到 AppHandle，hook 落盘只可能落在降级目录，
    // 只扫 app_data_dir 会让崩溃文件永久静默滞留（违背「不静默」约束）。
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(d) = app.path().app_data_dir() {
        dirs.push(d);
    }
    if let Some(fallback) = app_data_dir_best_effort() {
        if !dirs.iter().any(|d| d == &fallback) {
            dirs.push(fallback);
        }
    }
    if dsn.is_empty() {
        // 无 DSN：保留落盘文件供诊断，不静默丢弃（eprintln 提示运维）。
        let mut pending = 0usize;
        for dir in &dirs {
            if let Ok(entries) = std::fs::read_dir(dir) {
                pending += entries
                    .filter_map(|e| e.ok())
                    .filter(|e| {
                        let n = e.file_name();
                        let n = n.to_string_lossy();
                        n.starts_with(CRASH_FILE_PREFIX) && n.ends_with(CRASH_FILE_SUFFIX)
                    })
                    .count();
            }
        }
        if pending > 0 {
            eprintln!(
                "[crash-report] 发现 {pending} 个未上报崩溃（SENTRY_DSN 未配置，保留供诊断）"
            );
        }
        return;
    }

    for dir in dirs {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.filter_map(|e| e.ok()) {
            let name_os = entry.file_name();
            let name = name_os.to_string_lossy();
            if !name.starts_with(CRASH_FILE_PREFIX) || !name.ends_with(CRASH_FILE_SUFFIX) {
                continue;
            }
            let path = entry.path();
            let body = match std::fs::read_to_string(&path) {
                Ok(b) => b,
                Err(_) => continue,
            };
            // POST 到 Sentry store 端点（DSN 解析）。失败保留文件，下次再试。
            if upload_to_sentry(&dsn, &body) {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
}

/// 解析 Sentry DSN 为 store 端点并 POST JSON。返回是否成功。
fn upload_to_sentry(dsn: &str, body: &str) -> bool {
    let parsed = match sentry_dsn_ingest_url(dsn) {
        Some(u) => u,
        None => return false,
    };
    // 显式超时：启动期阻塞上报若遇到不可达 DSN，绝不能把应用启动挂死（10s 上限）。
    let client = match reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    match client
        .post(&parsed)
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .send()
    {
        Ok(resp) => resp.status().is_success(),
        Err(_) => false,
    }
}

/// 从 Sentry DSN 解析 store 端点 URL（用于崩溃 payload 投递）。
fn sentry_dsn_ingest_url(dsn: &str) -> Option<String> {
    // https://<public_key>@<host>[:port]/<project_id>
    let without_scheme = dsn.strip_prefix("https://").or_else(|| dsn.strip_prefix("http://"))?;
    let (auth_part, host_part) = without_scheme.split_once('@')?;
    let _public_key = auth_part; // 投递 store 端点不需要 key，但保留解析校验
    let (host, project_id) = host_part.split_once('/')?;
    let scheme = if dsn.starts_with("https://") {
        "https"
    } else {
        "http"
    };
    Some(format!("{scheme}://{host}/api/{project_id}/store/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_crash_payload_含版本与平台() {
        let payload = build_crash_payload("boom", "main.rs:1:1");
        // 正向：版本号与平台非空，且为当前编译版本。
        assert_eq!(payload.app_version, env!("CARGO_PKG_VERSION"));
        assert!(!payload.platform.is_empty());
        assert!(!payload.timestamp.is_empty());
        assert_eq!(payload.message, "boom");
        assert_eq!(payload.location, "main.rs:1:1");
    }

    #[test]
    fn write_crash_file_落盘且可解析回结构一致() {
        let dir = std::env::temp_dir().join(format!("lf-crash-test-{}", uuid::Uuid::new_v4()));
        let _ = std::fs::create_dir_all(&dir);
        let payload = CrashReport {
            app_version: "0.1.11".into(),
            platform: "windows".into(),
            timestamp: "2026-08-11T00:00:00.000Z".into(),
            message: "panic!".into(),
            location: "x.rs:2:3".into(),
        };
        // 反向：文件落盘成功且文件名符合 crash-*.json，解析回结构与原文一致。
        let path = write_crash_file(&dir, &payload).expect("应落盘");
        let fname = path.file_name().unwrap().to_string_lossy();
        assert!(fname.starts_with(CRASH_FILE_PREFIX));
        assert!(fname.ends_with(CRASH_FILE_SUFFIX));
        let back: CrashReport =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(back, payload);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sentry_dsn_ingest_url_解析正确() {
        let url = sentry_dsn_ingest_url("https://abc@o1.ingest.sentry.io/42").expect("应解析");
        assert_eq!(url, "https://o1.ingest.sentry.io/api/42/store/");
    }
}
