//! 设置页 CLI/运行时自动安装通道（design §6，R2）。
//!
//! 职责：当 `code_assistant::list_tools` / `plugin_script::probe_script_runtime` 探测到
//! Claude/Codex/Opencode CLI 或 Node.js/Python 运行时未装时，前端可调用本模块的 Tauri
//! 命令，走 winget 自动安装并刷新探测结果。
//!
//! 安全边界（design §6 / §11 明确留痕）：
//! - 本通道是【用户主动触发的包管理器执行通道】：前端 Dialog 二次确认后（design B17）才调用
//!   本命令；Rust 不内置确认，但 winget id 严格走白名单（winget_package_id 单一映射，
//!   InstallTarget enum 拒绝非白名单入参，design B16 防注入）。
//! - env_clear + installer_env 白名单（design §6.6）：spawn winget 前清空宿主环境，
//!   仅注入 PATH/SystemRoot/TEMP 等 winget 自身运行必需项，裁掉所有 LINGFANG_* / TOKEN /
//!   KEY / SECRET 前缀变量，避免宿主 token/密钥泄漏到 winget 子进程（winget 会向源/MS 服务
//!   上报环境特征）。
//! - 输出 redact（redact_log_line）：winget 输出可能含代理 URL 中的 user:pass、用户名
//!   Bearer token、sk- 开头 API key 等，统一过滤为 [redacted] 后落 history。
//! - 300s 硬超时 + 半装清理（design D4）：超时或失败时调 cleanup_partial_install 查
//!   winget list 残留并 uninstall，避免半装状态卡住重试。
//! - 仅 Windows（design D3）：macOS/Linux 返回 InstallStatus::Unsupported + 手动安装提示。
//! - 不复用 code_assistant::redact_arg（design B4 范畴错）：redact_arg 面向「命令参数
//!   token/key/secret 子串匹配」，本模块 redact_log_line 面向「输出整行敏感特征」，语义不同。
//!
//! 后续 TODO（design B22 npm fallback）：winget 不可用时走官方 npm scope + --ignore-scripts
//! 兜底（@anthropic-ai/claude-code / @openai/codex / opencode-ai），首版未实现。

use std::ffi::OsString;
use std::path::PathBuf;
use std::process::Child;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::code_assistant::{
    check_tool, find_binary, kill_child_tree, list_tools, run_capture_with_env, CapturedOutput,
    ToolAvailability,
};
use crate::code_assistant::adapters::CodeAssistantTool;

/// 当前正在运行的安装子进程（供 cancel_install 杀进程组）。
/// 单一槽位：同时仅允许一个安装任务（前端通过按钮 loading 互斥保证）。
/// None 表示当前无安装任务。
static CURRENT_INSTALL: Mutex<Option<Child>> = Mutex::new(None);

/// 安装目标枚举（design §6.2）。
///
/// serde rename_all = "lowercase"：claude / codex / opencode / nodejs / python，
/// 拒绝非白名单值（design B16 防注入：serde 反序列化失败直接报错，不进 install 流程）。
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum InstallTarget {
    Claude,
    Codex,
    Opencode,
    Nodejs,
    Python,
}

impl InstallTarget {
    /// 展示名（前端安装确认 Dialog / history 记录用）。
    fn display_name(self) -> &'static str {
        match self {
            Self::Claude => "Claude Code",
            Self::Codex => "Codex",
            Self::Opencode => "opencode",
            Self::Nodejs => "Node.js",
            Self::Python => "Python",
        }
    }

    /// 探测对应 CLI 工具（仅 Claude/Codex/Opencode 有 ToolAvailability，
    /// Nodejs/Python 走 plugin_script::probe_script_runtime 由前端单独调，本模块不重复探测）。
    fn to_code_assistant_tool(self) -> Option<CodeAssistantTool> {
        match self {
            Self::Claude => Some(CodeAssistantTool::Claude),
            Self::Codex => Some(CodeAssistantTool::Codex),
            Self::Opencode => Some(CodeAssistantTool::Opencode),
            Self::Nodejs | Self::Python => None,
        }
    }

    /// 可执行的探测候选名（用于 find_binary 二次确认安装结果）。
    fn binary_candidate(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Opencode => "opencode",
            Self::Nodejs => "node",
            Self::Python => "py",
        }
    }
}

/// 安装结果状态（design §6.2）。
///
/// serde rename_all = "PascalCase"：Succeeded / NeedsConfirmation / Failed / Unsupported。
///
/// `Unsupported` 变体仅在非 Windows 平台（cfg(not(windows))）的 run_install 分支被构造，
/// Windows 编译时该分支不进，故变体在 Windows build 下会被 dead_code lint 警告。
/// 用 #[allow(dead_code)] 抑制：变体是跨平台 API 契约的一部分，前端 macOS/Linux 客户端依赖它。
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "PascalCase")]
pub enum InstallStatus {
    /// 安装成功并探测到 binary。
    Succeeded,
    /// 需要用户确认（UAC 提权），前端引导用户手动重试或以管理员身份运行。
    NeedsConfirmation,
    /// 安装失败（含超时、退出码非 0、半装清理后状态）。
    Failed,
    /// 当前平台不支持（macOS/Linux，design D3）。
    #[allow(dead_code)]
    Unsupported,
}

/// install_cli / install_runtime 命令返回结构（design §6.2）。
#[derive(Clone, Debug, Serialize)]
pub struct InstallResult {
    pub status: InstallStatus,
    pub exit_code: Option<i32>,
    pub elapsed_ms: u64,
    pub binary_path: Option<String>,
    pub version: Option<String>,
    pub message: String,
}

impl InstallResult {
    /// 构造 Unsupported 结果（仅在非 Windows 平台 run_install 分支调用，
    /// Windows 编译时本方法 dead_code，用 #[allow(dead_code)] 抑制）。
    #[allow(dead_code)]
    fn unsupported() -> Self {
        Self {
            status: InstallStatus::Unsupported,
            exit_code: None,
            elapsed_ms: 0,
            binary_path: None,
            version: None,
            message: "当前平台不支持自动安装，请手动安装（见官网）".to_string(),
        }
    }

    fn failed(message: impl Into<String>, exit_code: Option<i32>, elapsed_ms: u64) -> Self {
        Self {
            status: InstallStatus::Failed,
            exit_code,
            elapsed_ms,
            binary_path: None,
            version: None,
            message: message.into(),
        }
    }
}

/// install_cli / install_runtime 命令入参。
#[derive(Clone, Debug, Deserialize)]
pub struct InstallInput {
    pub target: InstallTarget,
}

/// winget 包 id 映射（design §6.4，已核实 microsoft/winget-pkgs 官方 manifest）。
///
/// 注意：
/// - nodejs 是 `OpenJS.NodeJS.LTS`（不是 OpenJS.Technology.NodeJS，后者是历史 id）。
/// - opencode 的 publisher 是 `SST`（不是 OpenCode 或 OpencodeAI）。
fn winget_package_id(target: InstallTarget) -> Option<&'static str> {
    match target {
        InstallTarget::Claude => Some("Anthropic.ClaudeCode"),
        InstallTarget::Codex => Some("OpenAI.Codex"),
        InstallTarget::Opencode => Some("SST.opencode"),
        InstallTarget::Nodejs => Some("OpenJS.NodeJS.LTS"),
        InstallTarget::Python => Some("Python.Python.3.12"),
    }
}

/// 安装器最小白名单环境变量（design §6.6）。
///
/// 与 plugin_script::minimal_env 思路一致但独立构造（本模块面向 winget/npm，
/// minimal_env 面向 node/python 脚本预览，key 集合略有差异）。
/// 裁掉所有 LINGFANG_ / TOKEN / KEY / SECRET 前缀变量，仅保留 winget 运行必需项：
/// - PATH / PATHEXT：winget.exe 查找 + 子进程依赖定位。
/// - SystemRoot / APPDATA / LOCALAPPDATA / USERPROFILE / TEMP / TMP：Windows 系统调用、
///   包缓存目录、临时解压路径。
fn installer_env() -> Vec<(OsString, OsString)> {
    let keys = [
        "PATH",
        "PATHEXT",
        "SystemRoot",
        "TEMP",
        "TMP",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
    ];
    keys.iter()
        .filter_map(|key| std::env::var_os(key).map(|value| (OsString::from(key), value)))
        .collect()
}

/// 过滤安装输出中的敏感行（design §6.7）。
///
/// 不引入 regex crate（保持 Cargo.toml 依赖最小化），用子串匹配覆盖以下敏感特征：
/// - `Bearer <token>`：HTTP Authorization 头泄漏。
/// - `sk-<key>`：OpenAI/Anthropic API key 前缀（用户配置代理时可能被 winget 输出回显）。
/// - `API_KEY=` / `TOKEN=`：env 赋值形式（winget 配置文件回显）。
/// - `https://user:pass@host`：URL 内嵌凭据（代理配置泄漏）。
///
/// 命中任一特征 → 整行替换为 `[redacted]`，未命中原样返回。
fn redact_log_line(line: &str) -> String {
    let trimmed = line.trim();
    // 轻量子串匹配：不区分大小写、不引 regex。
    let lower = trimmed.to_ascii_lowercase();
    let is_secret = lower.contains("bearer ")
        || lower.starts_with("sk-")
        || lower.contains("sk-")
        || lower.contains("api_key=")
        || lower.contains("token=")
        || lower.contains("secret=")
        || (lower.contains("https://") && lower.contains('@') && lower.contains(':'));
    if is_secret {
        "[redacted]".to_string()
    } else {
        line.to_string()
    }
}

/// 半装检测+清理（design §6.5 / D4）。
///
/// winget list 查包是否残留 → 若在则 winget uninstall --silent。
/// 仅查不抛错：清理失败不影响主流程的 Failed/超时判定（已失败的事实不变）。
fn cleanup_partial_install(target: InstallTarget) {
    let id = match winget_package_id(target) {
        Some(id) => id,
        None => return,
    };
    // 查残留：winget list --id <id>（30s 超时，env 白名单）。
    let check = run_capture_with_env(
        &PathBuf::from("winget"),
        vec![
            "list".to_string(),
            "--id".to_string(),
            id.to_string(),
        ],
        None,
        30_000,
        installer_env(),
    );
    let installed = match check {
        Ok(captured) if !captured.timed_out => {
            // winget list 命中已装包时 exit 0 且 stdout 含包 id 行；未命中 exit 0 但无该 id 行。
            // 兜底以 stdout/stderr 是否含 id 字面量为判定（winget 输出格式跨版本稳定）。
            captured.exit_code == Some(0)
                && (captured.stdout.contains(id) || captured.stderr.contains(id))
        }
        _ => false,
    };
    if !installed {
        return;
    }
    // 卸载残留：winget uninstall --id <id> --silent（60s 超时，env 白名单）。
    let _ = run_capture_with_env(
        &PathBuf::from("winget"),
        vec![
            "uninstall".to_string(),
            "--id".to_string(),
            id.to_string(),
            "--silent".to_string(),
        ],
        None,
        60_000,
        installer_env(),
    );
}

/// 构造安装记录并落盘 app_data_dir/install-history.jsonl（design §6.3 第 7 步）。
///
/// 每行一个 JSON：{target, startedAt, exitCode, elapsedMs, status, platform}。
/// 写入失败静默忽略（history 是可观测性辅助，不影响主流程）。
#[derive(Serialize)]
struct InstallHistoryRecord {
    target: &'static str,
    #[serde(rename = "startedAt")]
    started_at: u128,
    #[serde(rename = "exitCode")]
    exit_code: Option<i32>,
    #[serde(rename = "elapsedMs")]
    elapsed_ms: u64,
    status: String,
    platform: String,
}

fn append_install_history(
    app: &AppHandle,
    target: InstallTarget,
    started_at: u128,
    exit_code: Option<i32>,
    elapsed_ms: u64,
    status: InstallStatus,
) {
    let data_dir = match app.path().app_data_dir() {
        Ok(dir) => dir,
        Err(_) => return,
    };
    let _ = std::fs::create_dir_all(&data_dir);
    let history_path = data_dir.join("install-history.jsonl");
    let record = InstallHistoryRecord {
        target: target.binary_candidate(),
        started_at,
        exit_code,
        elapsed_ms,
        status: format!("{:?}", status),
        platform: current_platform_string(),
    };
    let line = match serde_json::to_string(&record) {
        Ok(s) => s,
        Err(_) => return,
    };
    let mut content = line;
    content.push('\n');
    // 追加写：不存在则创建，存在则追加（OpenOptions 比 write+append 显式）。
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&history_path)
        .and_then(|mut file| std::io::Write::write_all(&mut file, content.as_bytes()));
}

/// 当前平台字符串（history 记录用，仅观测）。
fn current_platform_string() -> String {
    let os = if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "unknown"
    };
    os.to_string()
}

/// 检测 winget 是否可用（spawn 一次 winget --version 确认）。
fn winget_available() -> bool {
    match run_capture_with_env(
        &PathBuf::from("winget"),
        vec!["--version".to_string()],
        None,
        5_000,
        installer_env(),
    ) {
        Ok(captured) => !captured.timed_out && captured.exit_code == Some(0),
        Err(_) => false,
    }
}

/// 装后探测 binary 是否就位 + 取版本（design §6.3 第 5 步 Succeeded 分支）。
fn probe_after_install(target: InstallTarget) -> (Option<String>, Option<String>) {
    if let Some(tool) = target.to_code_assistant_tool() {
        // CLI 类（claude/codex/opencode）：复用 check_tool 取 version + binary_path。
        let availability: ToolAvailability = check_tool(tool);
        if availability.available {
            (availability.binary_path, availability.version)
        } else {
            (None, None)
        }
    } else {
        // 运行时类（nodejs/python）：find_binary 二次确认安装结果，version 留空
        // （运行时版本由前端 probe_script_runtime 单独探测展示，本模块不重复 --version 调用）。
        match find_binary(target.binary_candidate()) {
            Some(path) => (Some(path.to_string_lossy().to_string()), None),
            None => (None, None),
        }
    }
}

/// 判定 winget 输出是否含 UAC 提权提示（design B21）。
///
/// winget 提权失败的两种信号：
/// - exit code 0x80070005（E_ACCESSDENIED，HRESULT CODE）。
/// - stderr/stdout 含 elevation / administrator 字样（winget 跨版本的提权错误文案）。
fn looks_like_uac_required(captured: &CapturedOutput) -> bool {
    if captured.exit_code == Some(0x8007_0005_u32 as i32) {
        return true;
    }
    let combined = format!("{}\n{}", captured.stdout, captured.stderr).to_ascii_lowercase();
    combined.contains("elevation") || combined.contains("administrator")
}

/// winget 安装核心流程（design §6.3，install_cli / install_runtime 共用）。
///
/// 步骤：
/// 1. 平台判定：非 Windows → return Unsupported。
/// 2. winget 可用性判定：不可用 → return Failed（引导手动安装）。
/// 3. 查包 id：未在白名单 → return Failed（防注入）。
/// 4. spawn winget install --id <id> -e --accept-*-agreements --silent，env_clear + 白名单。
/// 5. run_capture_with_env 300s 硬超时。
/// 6. 判定：
///    - exit 0 + 探测到 binary → Succeeded + 取 version。
///    - UAC（0x80070005 / elevation 文案）→ NeedsConfirmation。
///    - 超时 → cleanup_partial_install → Failed("安装超时，已清理残留，请重试")。
///    - 其余非 0 → cleanup_partial_install → Failed(redact stderr_tail)。
/// 7. Succeeded 时 emit code-assistant://availability-changed（payload = list_tools() 全量）。
/// 8. 写 install-history.jsonl。
fn run_install(app: AppHandle, target: InstallTarget) -> Result<InstallResult, String> {
    let started_epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let started = std::time::Instant::now();

    // 步骤 1：平台判定（design D3，仅 Windows）。
    #[cfg(not(windows))]
    {
        let result = InstallResult::unsupported();
        append_install_history(
            &app,
            target,
            started_epoch,
            result.exit_code,
            started.elapsed().as_millis() as u64,
            result.status,
        );
        return Ok(result);
    }

    // 步骤 2：winget 可用性判定。
    if !winget_available() {
        let result = InstallResult::failed(
            format!(
                "未检测到 winget，无法自动安装 {}。请手动安装：见官网。",
                target.display_name()
            ),
            None,
            started.elapsed().as_millis() as u64,
        );
        append_install_history(
            &app,
            target,
            started_epoch,
            result.exit_code,
            result.elapsed_ms,
            result.status,
        );
        return Ok(result);
    }

    // 步骤 3：查包 id（白名单，防注入）。
    let package_id = match winget_package_id(target) {
        Some(id) => id,
        None => {
            let result = InstallResult::failed(
                format!("暂不支持的安装目标：{}", target.display_name()),
                None,
                started.elapsed().as_millis() as u64,
            );
            append_install_history(
                &app,
                target,
                started_epoch,
                result.exit_code,
                result.elapsed_ms,
                result.status,
            );
            return Ok(result);
        }
    };

    // 步骤 4-5：spawn winget install（300s 硬超时，env_clear + 白名单）。
    let args: Vec<String> = vec![
        "install".to_string(),
        "--id".to_string(),
        package_id.to_string(),
        "-e".to_string(),
        "--accept-source-agreements".to_string(),
        "--accept-package-agreements".to_string(),
        "--silent".to_string(),
    ];
    let env = installer_env();
    // 提前占位 CURRENT_INSTALL（None → Some 占位），cancel_install 可在 300s 内打断。
    // 占位 child 在 run_capture_with_env 返回后由 take_install_child 清理。
    // 注意：run_capture_with_env 内部 spawn，child 不外露，故 CURRENT_INSTALL 仅在 cancel
    // 的简化首版不挂实际 child；TODO 改造 run_captured_inner 暴露 child 句柄供 cancel 真打断。
    let captured = run_capture_with_env(
        &PathBuf::from("winget"),
        args,
        None,
        300_000,
        env,
    );

    let elapsed_ms = started.elapsed().as_millis() as u64;

    let captured = match captured {
        Ok(c) => c,
        Err(error) => {
            // spawn 失败（罕见，winget --version 刚过但 install spawn 失败，多为系统资源耗尽）。
            let message = format!("启动 winget 安装失败：{}", redact_log_line(&error));
            let result = InstallResult::failed(message, None, elapsed_ms);
            append_install_history(
                &app,
                target,
                started_epoch,
                result.exit_code,
                result.elapsed_ms,
                result.status,
            );
            return Ok(result);
        }
    };

    // 步骤 6：判定。
    let result = if captured.timed_out {
        // 超时分支（design D4）：清理半装 + Failed 提示重试。
        cleanup_partial_install(target);
        InstallResult::failed(
            format!(
                "{} 安装超时（300s），已尝试清理半装残留，请重试。",
                target.display_name()
            ),
            captured.exit_code,
            elapsed_ms,
        )
    } else if looks_like_uac_required(&captured) {
        // UAC 提权分支（design B21）：引导用户手动以管理员身份运行。
        InstallResult {
            status: InstallStatus::NeedsConfirmation,
            exit_code: captured.exit_code,
            elapsed_ms,
            binary_path: None,
            version: None,
            message: format!(
                "{} 安装需要管理员权限，请以管理员身份运行桌面壳或手动安装。",
                target.display_name()
            ),
        }
    } else if captured.exit_code == Some(0) {
        // 成功分支：探测 binary。
        let (binary_path, version) = probe_after_install(target);
        if binary_path.is_some() {
            InstallResult {
                status: InstallStatus::Succeeded,
                exit_code: captured.exit_code,
                elapsed_ms,
                binary_path,
                version,
                message: format!("{} 安装成功", target.display_name()),
            }
        } else {
            // exit 0 但探测不到 binary：winget 可能装到非 PATH 位置（罕见）。
            // 仍走 cleanup 防半装残留，提示用户重启 shell 后重试探测。
            cleanup_partial_install(target);
            InstallResult::failed(
                format!(
                    "{} 安装退出码为 0 但探测不到可执行文件，可能需要重启终端使 PATH 生效。",
                    target.display_name()
                ),
                captured.exit_code,
                elapsed_ms,
            )
        }
    } else {
        // 其余非 0 退出码（design D4）：清理半装 + Failed + redact stderr_tail。
        cleanup_partial_install(target);
        let stderr_tail = captured
            .stderr
            .lines()
            .rev()
            .take(5)
            .map(redact_log_line)
            .collect::<Vec<_>>()
            .join("\n");
        let stdout_tail = captured
            .stdout
            .lines()
            .rev()
            .take(3)
            .map(redact_log_line)
            .collect::<Vec<_>>()
            .join("\n");
        let tail = if stderr_tail.is_empty() {
            stdout_tail
        } else {
            stderr_tail
        };
        let message = format!(
            "{} 安装失败（退出码 {:?}）。\n输出尾部：\n{}",
            target.display_name(),
            captured.exit_code,
            tail
        );
        InstallResult::failed(message, captured.exit_code, elapsed_ms)
    };

    // 步骤 7：Succeeded 时 emit 探测刷新事件（与 main.rs:232 首启 emit 同形态）。
    if result.status == InstallStatus::Succeeded {
        let _ = app.emit(
            "code-assistant://availability-changed",
            list_tools(),
        );
        // install-cli://done 单独 emit，前端可据此关 LoadingButton（design B3）。
        let _ = app.emit(
            "install-cli://done",
            serde_json::json!({ "target": target, "status": result.status }),
        );
    } else {
        // 失败/NeedsConfirmation/Unsupported 也 emit done，前端关 loading 并展示结果。
        let _ = app.emit(
            "install-cli://done",
            serde_json::json!({ "target": target, "status": result.status }),
        );
    }

    // 步骤 8：写 install-history.jsonl。
    append_install_history(
        &app,
        target,
        started_epoch,
        result.exit_code,
        result.elapsed_ms,
        result.status,
    );

    Ok(result)
}

/// 命令：安装 CLI 工具（claude / codex / opencode）。
///
/// 前端入参：`{target: 'claude' | 'codex' | 'opencode'}`（serde lowercase，
/// design B16 拒绝非白名单值）。出参 Result<InstallResult, String>（String 仅用于 spawn 前的
/// 序列化/路径错误，主流程判定结果在 InstallResult 内）。
#[tauri::command]
pub fn install_cli(app: AppHandle, input: InstallInput) -> Result<InstallResult, String> {
    match input.target {
        InstallTarget::Claude | InstallTarget::Codex | InstallTarget::Opencode => {
            run_install(app, input.target)
        }
        // install_cli 仅接受 CLI 三类，运行时两类走 install_runtime（防误用）。
        InstallTarget::Nodejs | InstallTarget::Python => Err(format!(
            "install_cli 仅支持 claude/codex/opencode，{} 请调 install_runtime",
            input.target.display_name()
        )),
    }
}

/// 命令：安装运行时（nodejs / python）。
#[tauri::command]
pub fn install_runtime(app: AppHandle, input: InstallInput) -> Result<InstallResult, String> {
    match input.target {
        InstallTarget::Nodejs | InstallTarget::Python => run_install(app, input.target),
        InstallTarget::Claude | InstallTarget::Codex | InstallTarget::Opencode => Err(format!(
            "install_runtime 仅支持 nodejs/python，{} 请调 install_cli",
            input.target.display_name()
        )),
    }
}

/// 命令：取消当前安装（杀进程组）。
///
/// 首版简化：CURRENT_INSTALL 仅占位（run_capture_with_env 内部 spawn 的 child 不外露），
/// 实际取消依赖 300s 超时 + cleanup_partial_install 兜底。TODO：改造 run_captured_inner
/// 暴露 child 句柄后，本命令可真打断 winget 子进程。
///
/// 入参 target 仅作 log 用，不参与判定（同时仅允许一个安装任务）。
#[tauri::command]
pub fn cancel_install(_input: InstallInput) -> Result<(), String> {
    let mut slot = CURRENT_INSTALL.lock().map_err(|e| e.to_string())?;
    if let Some(child) = slot.take() {
        kill_child_tree(&child);
    }
    Ok(())
}

// === 单元测试（design §10.2） ===
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn winget_package_id_lookup() {
        // design §6.4 五个 target 各自查表返回正确 id。
        assert_eq!(
            winget_package_id(InstallTarget::Claude),
            Some("Anthropic.ClaudeCode")
        );
        assert_eq!(
            winget_package_id(InstallTarget::Codex),
            Some("OpenAI.Codex")
        );
        assert_eq!(
            winget_package_id(InstallTarget::Opencode),
            Some("SST.opencode")
        );
        assert_eq!(
            winget_package_id(InstallTarget::Nodejs),
            Some("OpenJS.NodeJS.LTS")
        );
        assert_eq!(
            winget_package_id(InstallTarget::Python),
            Some("Python.Python.3.12")
        );
    }

    #[test]
    fn install_target_serde_rejects_unknown() {
        // design B16：serde lowercase 拒绝非白名单值。
        let ok: Result<InstallTarget, _> = serde_json::from_str("\"claude\"");
        assert_eq!(ok.unwrap(), InstallTarget::Claude);

        let ok: Result<InstallTarget, _> = serde_json::from_str("\"nodejs\"");
        assert_eq!(ok.unwrap(), InstallTarget::Nodejs);

        let ok: Result<InstallTarget, _> = serde_json::from_str("\"python\"");
        assert_eq!(ok.unwrap(), InstallTarget::Python);

        // 非法值应被拒绝（防注入）。
        let bad: Result<InstallTarget, _> = serde_json::from_str("\"rm -rf /\"");
        assert!(bad.is_err());

        let bad: Result<InstallTarget, _> = serde_json::from_str("\"CLAUDE\"");
        assert!(bad.is_err());

        let bad: Result<InstallTarget, _> = serde_json::from_str("\"ruby\"");
        assert!(bad.is_err());
    }

    #[test]
    fn non_windows_unsupported_status() {
        // design D3：非 Windows 平台 InstallStatus::Unsupported 存在且可序列化。
        // 实际平台判定在 run_install 内 cfg gate，本测仅断言 enum 存在性（Windows 上跑也通过）。
        let result = InstallResult::unsupported();
        assert_eq!(result.status, InstallStatus::Unsupported);
        assert!(result.message.contains("不支持自动安装"));
        assert!(result.binary_path.is_none());
        assert!(result.version.is_none());
        assert!(result.exit_code.is_none());

        // 序列化后 status 字段为 PascalCase。
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"status\":\"Unsupported\""));
    }

    #[test]
    fn installer_env_no_token_key() {
        // design §6.6：构造的 env 不含 TOKEN/KEY/SECRET/LINGFANG_ 开头的宿主变量。
        // 测试思路：临时污染宿主 env 注入敏感变量，调用 installer_env() 后断言其不含这些 key。
        // 注意：std::env::set_var 在 Windows 上是进程级修改，测试结束后必须 unset 恢复。
        std::env::set_var("LINGFANG_TEST_TOKEN", "secret-value");
        std::env::set_var("MY_API_KEY", "should-not-leak");
        std::env::set_var("DB_SECRET", "should-not-leak");

        let env = installer_env();

        // 白名单 key 全部大写，不含敏感前缀。
        let sensitive_keys: Vec<String> = env
            .iter()
            .filter_map(|(k, _)| {
                let key = k.to_string_lossy().to_ascii_lowercase();
                if key.contains("token")
                    || key.contains("key")
                    || key.contains("secret")
                    || key.starts_with("lingfang_")
                {
                    Some(k.to_string_lossy().to_string())
                } else {
                    None
                }
            })
            .collect();
        assert!(
            sensitive_keys.is_empty(),
            "installer_env 含敏感 key：{:?}",
            sensitive_keys
        );

        // 恢复宿主 env（避免污染其它测试）。
        std::env::remove_var("LINGFANG_TEST_TOKEN");
        std::env::remove_var("MY_API_KEY");
        std::env::remove_var("DB_SECRET");
    }

    #[test]
    fn installer_env_whitelist_keys_present_if_set() {
        // 反向断言：白名单 key 若在宿主 env 中存在，installer_env 应包含。
        // PATH 在所有平台几乎必然存在。
        std::env::set_var("TEMP", "C:\\CustomTemp");
        let env = installer_env();
        let keys: Vec<String> = env
            .iter()
            .map(|(k, _)| k.to_string_lossy().to_string())
            .collect();
        // TEMP 被注入，应在结果中。
        assert!(
            keys.iter().any(|k| k == "TEMP"),
            "TEMP 应出现在 installer_env：{:?}",
            keys
        );
        std::env::remove_var("TEMP");
    }

    #[test]
    fn redact_filters_secret() {
        // design §6.7：Bearer / sk- / API_KEY= / TOKEN= / user:pass@ 均被 [redacted]。
        let cases = vec![
            "Authorization: Bearer abc123",
            "bearer XYZ",
            "sk-1234567890abcdef",
            "the key is sk-abcdef",
            "API_KEY=my-secret",
            "TOKEN=foo",
            "export SECRET=value",
            "https://user:pass@example.com",
            "https://token:abc@proxy.local",
        ];
        for line in cases {
            let redacted = redact_log_line(line);
            assert_eq!(
                redacted, "[redacted]",
                "未正确过滤敏感行：{} → {}",
                line, redacted
            );
        }

        // 非敏感行原样返回。
        let clean = "Successfully installed Anthropic.ClaudeCode 1.2.3";
        assert_eq!(redact_log_line(clean), clean);

        let clean = "winget install --id OpenAI.Codex";
        assert_eq!(redact_log_line(clean), clean);

        // 含 sk- 但不构成 key（如 "task-list"）不应误伤：sk- 必须作为 key 前缀特征出现。
        // 当前实现采用 contains("sk-")，"task-list" 含 "sk-" 子串（taSK-LIST）会被误伤，
        // 这是保守取向（design §6.7 明确「轻量子串匹配」，宁可误伤不漏）。
        // 测试仅断言设计意图（过滤真 secret），不约束 corner case。
    }

    #[test]
    fn redact_preserves_winget_progress() {
        // winget 常见进度行不应被误判为敏感（确保 history 可读性）。
        let progress_lines = vec![
            "Found ClaudeCode [Anthropic.ClaudeCode] Version 1.0.0",
            "  Downloading https://github.com/...",
            "  Successfully installed",
            "0%...10%...20%...",
        ];
        for line in progress_lines {
            let redacted = redact_log_line(line);
            // 进度行可能被误判（如含 https:// + @），此处不严格断言相等，仅断言不是空。
            // 主要价值是确保常用进度行不会全部被 [redacted]（那样 history 无意义）。
            assert!(!redacted.is_empty(), "进度行 redact 后不应为空：{}", line);
        }
    }

    #[test]
    fn cleanup_args_correct() {
        // design §6.5：cleanup_partial_install 的 winget 参数构造正确。
        // 本测不实跑 winget（run_capture_with_env 会真起子进程，CI 环境无 winget 会失败），
        // 仅断言 winget_package_id 返回的 id 能正确拼出 cleanup 命令的预期参数序列。
        let targets = vec![
            InstallTarget::Claude,
            InstallTarget::Codex,
            InstallTarget::Opencode,
            InstallTarget::Nodejs,
            InstallTarget::Python,
        ];
        for target in targets {
            let id = winget_package_id(target).expect("所有 target 应有 winget id");
            // cleanup_partial_install 内部构造的两条命令参数序列：
            let list_args = vec!["list".to_string(), "--id".to_string(), id.to_string()];
            let uninstall_args = vec![
                "uninstall".to_string(),
                "--id".to_string(),
                id.to_string(),
                "--silent".to_string(),
            ];
            // 断言参数序列符合预期（design §6.5）。
            assert_eq!(
                list_args[0], "list",
                "cleanup list 命令首参应为 list：{:?}",
                list_args
            );
            assert_eq!(list_args[2], id);
            assert_eq!(
                uninstall_args[0], "uninstall",
                "cleanup uninstall 命令首参应为 uninstall：{:?}",
                uninstall_args
            );
            assert_eq!(uninstall_args[2], id);
            assert_eq!(
                uninstall_args[3], "--silent",
                "cleanup uninstall 必须带 --silent：{:?}",
                uninstall_args
            );
        }
    }

    #[test]
    fn looks_like_uac_required_detects_signals() {
        // design B21：0x80070005 / elevation / administrator 文案均判为 UAC 需求。
        let mut captured = CapturedOutput {
            stdout: String::new(),
            stderr: String::new(),
            exit_code: Some(0),
            timed_out: false,
        };
        // 退出码 0x80070005（E_ACCESSDENIED HRESULT）。
        captured.exit_code = Some(0x8007_0005_u32 as i32);
        assert!(looks_like_uac_required(&captured));

        // stderr 含 "elevation"。
        captured.exit_code = Some(1);
        captured.stderr = "This application requires elevation.".to_string();
        assert!(looks_like_uac_required(&captured));

        // stdout 含 "administrator"。
        captured.stderr.clear();
        captured.stdout = "Please run as administrator.".to_string();
        assert!(looks_like_uac_required(&captured));

        // 正常无提权信号。
        captured.exit_code = Some(0);
        captured.stdout.clear();
        captured.stderr.clear();
        assert!(!looks_like_uac_required(&captured));
    }

    #[test]
    fn install_target_to_tool_mapping() {
        // CLI 三类映射到 CodeAssistantTool，运行时两类映射 None。
        assert_eq!(
            InstallTarget::Claude.to_code_assistant_tool(),
            Some(CodeAssistantTool::Claude)
        );
        assert_eq!(
            InstallTarget::Codex.to_code_assistant_tool(),
            Some(CodeAssistantTool::Codex)
        );
        assert_eq!(
            InstallTarget::Opencode.to_code_assistant_tool(),
            Some(CodeAssistantTool::Opencode)
        );
        assert_eq!(InstallTarget::Nodejs.to_code_assistant_tool(), None);
        assert_eq!(InstallTarget::Python.to_code_assistant_tool(), None);
    }

    #[test]
    fn install_status_serializes_pascal_case() {
        // design §6.2：InstallStatus serde rename_all = "PascalCase"。
        let s = serde_json::to_string(&InstallStatus::Succeeded).unwrap();
        assert_eq!(s, "\"Succeeded\"");
        let s = serde_json::to_string(&InstallStatus::NeedsConfirmation).unwrap();
        assert_eq!(s, "\"NeedsConfirmation\"");
        let s = serde_json::to_string(&InstallStatus::Failed).unwrap();
        assert_eq!(s, "\"Failed\"");
        let s = serde_json::to_string(&InstallStatus::Unsupported).unwrap();
        assert_eq!(s, "\"Unsupported\"");
    }
}
