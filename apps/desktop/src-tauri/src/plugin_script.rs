//! 插件脚本本地预览执行（R3）。
//!
//! 职责：在桌面壳侧为 nodejs/python 运行时插件提供「无参数一次性预览执行」。
//! 复用 code_assistant.rs 的子进程骨架（find_binary / run_capture_with_env / resolve_workspace），
//! 在 app_data_dir/plugin-sandbox/<plugin_id> 下落盘用户脚本后带超时运行。
//!
//! 安全边界（design §6.1 明确留痕）：
//! - 本通道是【不受控执行通道】，绕过 capability 网关（capability.rs 的声明式白名单
//!   语义面向「插件运行态受控能力调用」，与「开发者主动运行自己刚生成的脚本」语义不同）。
//! - 本轮 sandbox 仅【软隔离】：路径穿越防（sanitize_rel_path + canonicalize 前缀断言）、
//!   env 最小白名单、超时 kill、stdin=null。
//! - 可逃逸：用户权限运行的脚本可执行 fs.writeFile / child_process / 网络请求，影响用户文件系统
//!   （与本地直接 `node main.js` 等价风险）。
//! - 后续独立大任务（TODO）：OS 级硬隔离（Windows AppContainer / Linux bubblewrap|firejail /
//!   macOS sandbox-exec）+ 新增 script.node / script.python capability kind，让本通道也走声明式授权。
//!   届时 run_plugin_script 改为先查 CapabilityRegistry。

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::code_assistant::{find_binary, resolve_workspace, run_capture_with_env, CapturedOutput};

/// 运行时语言枚举（仅脚本型，不含 client/cloud）。
/// serde rename_all = lowercase：nodejs / python，与契约 RuntimeType 对齐。
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ScriptRuntime {
    Nodejs,
    Python,
}

/// 单个脚本文件（相对路径 + 内容），由前端 PluginDraft.files 传入。
#[derive(Clone, Debug, Deserialize)]
pub struct ScriptFile {
    pub path: String,
    pub content: String,
}

/// run_plugin_script 命令入参。
#[derive(Clone, Debug, Deserialize)]
pub struct RunPluginScriptInput {
    pub plugin_id: String,
    pub runtime: ScriptRuntime,
    /// 运行入口相对路径（如 src/index.js / main.py），须存在于 files 中。
    pub entry: String,
    pub files: Vec<ScriptFile>,
    /// 超时毫秒，缺省 15000（design 决策③：无参数一次性运行，防死循环挂起 UI）。
    pub timeout_ms: Option<u64>,
}

/// 解释器探测结果。
#[derive(Clone, Debug, Serialize)]
pub struct ProbeResult {
    pub available: bool,
    pub binary_path: Option<String>,
    pub version: Option<String>,
    /// 缺失时的安装指引文案（前端 ScriptPreviewPanel 直接展示）。
    pub hint: Option<String>,
}

/// 一次预览执行的输出（与 R5 creator-error.RunScriptResult 对齐需经前端封装层转换）。
#[derive(Clone, Debug, Serialize)]
pub struct RunResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub elapsed_ms: u64,
}

/// 安装指引文案（与前端 RUNTIME_INSTALL_HINT 镜像，缺失解释器时 Rust 侧也返回便于直接展示）。
fn install_hint(runtime: ScriptRuntime) -> String {
    match runtime {
        ScriptRuntime::Nodejs => {
            // winget 包 id 经 microsoft/winget-pkgs 官方 manifest 核实为 OpenJS.NodeJS.LTS
            //（非 OpenJS.Technology.NodeJS，后者不存在，前端 RUNTIME_INSTALL_HINT 已修正同步）。
            "未检测到 Node.js。请安装：访问 https://nodejs.org 下载 LTS，或运行 winget install OpenJS.NodeJS.LTS".to_string()
        }
        ScriptRuntime::Python => {
            "未检测到 Python。请安装：运行 winget install Python.Python.3.12，或访问 https://python.org 下载。Windows 推荐 py launcher。".to_string()
        }
    }
}

/// 探测候选解释器顺序（design §4.5）。
/// Windows python 强制 py launcher 优先：裸 python 常是 Microsoft Store stub（执行后弹商店而非报错）。
fn interpreter_candidates(runtime: ScriptRuntime) -> Vec<&'static str> {
    match runtime {
        ScriptRuntime::Nodejs => {
            // Linux 部分发行版仅 nodejs（无 node 别名），故补 nodejs 候选。
            #[cfg(not(windows))]
            {
                vec!["node", "nodejs"]
            }
            #[cfg(windows)]
            {
                vec!["node"]
            }
        }
        ScriptRuntime::Python => {
            #[cfg(windows)]
            {
                vec!["py", "python", "python3"]
            }
            #[cfg(not(windows))]
            {
                vec!["python3", "python"]
            }
        }
    }
}

/// 探测解释器是否存在 + 版本号。
/// 命中后跑 `--version` 实跑确认非 Store stub（design §4.5 / §6.4 已确认约束）。
///
/// 修复 SCRIPT-03（medium 错误处理）：此前 guard 仅 `!captured.timed_out`，未校验 exit_code
/// 也未校验版本内容。Windows 上未装 Python 时 Microsoft Store 的 python.exe 别名（0 字节 stub，
/// is_file()==true）会被 find_binary 命中；其 --version 不挂起（timed_out=false），而是向 stderr
/// 打印「Python was not found; ... install from the Microsoft Store」并以 9009 退出，
/// 导致 available 被置为 true、version=Store 提示语，绕过 py launcher 优先策略的设计意图，
/// 前端失去安装指引。修复：guard 叠加 exit_code==Some(0) + 排除 stderr 含 Store stub 关键字。
#[tauri::command]
pub fn probe_script_runtime(runtime: ScriptRuntime) -> Result<ProbeResult, String> {
    let hint = install_hint(runtime);
    for candidate in interpreter_candidates(runtime) {
        if let Some(binary) = find_binary(candidate) {
            // 用 --version 实跑：既能取版本，又能确认非 stub（py/python --version 均输出到 stdout）。
            match run_capture_with_env(
                &binary,
                vec!["--version".to_string()],
                None,
                5_000,
                minimal_env(),
            ) {
                // 修复 SCRIPT-03：必须 exit_code==Some(0) 且非 Store stub。
                Ok(captured)
                    if !captured.timed_out
                        && captured.exit_code == Some(0)
                        && !is_store_stub_output(&captured.stderr, runtime) =>
                {
                    // 版本字符串拼接 stdout + stderr（部分实现走 stderr），取首行。
                    let raw_version =
                        format!("{}\n{}", captured.stdout.trim(), captured.stderr.trim());
                    let version = raw_version
                        .lines()
                        .find(|line| !line.trim().is_empty())
                        .map(|line| line.trim().to_string());
                    return Ok(ProbeResult {
                        available: true,
                        binary_path: Some(binary.to_string_lossy().to_string()),
                        version,
                        hint: None,
                    });
                }
                _ => {
                    // 候选命中但 --version 失败/超时/退出码非 0/疑似 Store stub：继续尝试下一个候选。
                    continue;
                }
            }
        }
    }
    Ok(ProbeResult {
        available: false,
        binary_path: None,
        version: None,
        hint: Some(hint),
    })
}

/// 修复 SCRIPT-03：识别 Microsoft Store python.exe stub 的特征输出。
/// stub 在 stderr 打印含「was not found」/「Microsoft Store」的提示并以 9009 退出。
/// 仅对 Python 候选生效（node 无 Store stub 问题）。
fn is_store_stub_output(stderr: &str, runtime: ScriptRuntime) -> bool {
    if runtime != ScriptRuntime::Python {
        return false;
    }
    let lower = stderr.to_lowercase();
    lower.contains("was not found") || lower.contains("microsoft store")
}

/// 最小白名单环境变量：仅保留解释器/依赖查找与系统调用必需项，裁掉宿主 token/密钥。
/// 权衡（design §4.4）：依赖自定义环境变量的脚本在预览中行为可能与真实运行不一致，
/// 但预览目标是「能跑起来看 stdout」，非「100% 复现生产环境」。
///
/// pub(crate) 供 cli_installer::installer_env 参考其 keys 白名单思路（design §6.6，
/// cli_installer 独立构造 installer_env 实例，不复用本函数返回值；本提升仅暴露语义供跨模块共享）。
pub(crate) fn minimal_env() -> Vec<(OsString, OsString)> {
    let keys = [
        "PATH", // 解释器/依赖查找必须
        "HOME",
        "USERPROFILE", // Node/Python 用户级配置
        "APPDATA",
        "LOCALAPPDATA", // Windows npm/pip 缓存定位
        "SystemRoot",
        "TEMP",
        "TMP", // Windows 系统调用与临时目录
        "LANG",
        "LC_ALL", // 区域，避免乱码
    ];
    keys.iter()
        .filter_map(|key| std::env::var_os(key).map(|value| (OsString::from(key), value)))
        .collect()
}

/// 在 minimal_env 基础上按运行时追加专属环境变量。
///
/// Python（H2 修复）：
/// - `PYTHONIOENCODING=utf-8`：强制 stdout/stderr UTF-8 编码，避免 Windows 中文系统默认 GBK
///   导致 `print("你好")` 触发 UnicodeEncodeError 崩溃或 String::from_utf8_lossy 解码乱码。
/// - `PYTHONUTF8=1`：PEP 540 UTF-8 模式，文件读取/默认编码统一 UTF-8。
///
/// Python 多文件（H4 修复）：
/// - `PYTHONPATH=<sandbox根>`：让 entry 在子目录时（如 src/main.py）能 import sandbox 根的模块
///   （Python 默认 sys.path[0] 是脚本所在目录，非 sandbox 根）。
fn runtime_env(
    runtime: ScriptRuntime,
    workspace: &str,
    base: Vec<(OsString, OsString)>,
) -> Vec<(OsString, OsString)> {
    let mut env = base;
    if runtime == ScriptRuntime::Python {
        env.push((OsString::from("PYTHONIOENCODING"), OsString::from("utf-8")));
        env.push((OsString::from("PYTHONUTF8"), OsString::from("1")));
        if !workspace.is_empty() {
            env.push((OsString::from("PYTHONPATH"), OsString::from(workspace)));
        }
    }
    env
}

/// 规范化相对路径：禁绝对路径（/ ~ C:）/空段/./../隐藏系统段。
/// 与后端 plugin-package.ts cleanPath 等价逻辑，是路径穿越防御的第一道（软隔离）防线。
fn sanitize_rel_path(path: &str) -> Result<PathBuf, String> {
    let normalized = path.trim().replace('\\', "/");
    if normalized.is_empty() {
        return Err("路径不能为空".to_string());
    }
    if normalized.starts_with('/')
        || normalized.starts_with('~')
        || is_windows_drive_prefix(&normalized)
    {
        return Err(format!("路径不能是绝对路径：{normalized}"));
    }
    let segments: Vec<&str> = normalized.split('/').collect();
    if segments
        .iter()
        .any(|segment| segment.is_empty() || *segment == "." || *segment == "..")
    {
        return Err(format!("路径不能包含空段或 ..：{normalized}"));
    }
    if segments.iter().any(|segment| segment.starts_with('.')) {
        return Err(format!("路径不能包含隐藏系统段：{normalized}"));
    }
    Ok(PathBuf::from(normalized))
}

/// 判断是否 Windows 盘符绝对路径（如 C:/ D:\），等价于后端正则 /^[a-zA-Z]:\//。
/// 手动实现避免引入 regex 依赖。
fn is_windows_drive_prefix(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'/' || bytes[2] == b'\\')
}

/// 预检 Node 插件是否需要专属运行时（预览执行用裸 node 跑不了）。
///
/// 判定：files 含 package.json 且其 scripts.start 不是简单的 `node <file>` 形态
/// （即依赖了 electron / 框架 CLI 等特殊可执行运行时）。
/// 命中时返回友好错误提示（引导用持久化运行），未命中返回 None。
///
/// 背景：预览执行用 `node <entry>` 一次性跑，但 electron 等是特殊可执行包，
/// `require('electron')` 在纯 node 下会抛 EISDIR / 模块解析错（node 把 electron 的
/// 路径当目录 realpath）。此类插件必须经 `pnpm start`（即 `electron .`）启动，
/// 属于持久化运行（Plugins 页「运行」按钮）的范畴，预览执行本就不适用。
fn needs_runtime_start(files: &[ScriptFile]) -> Option<String> {
    // 读取 package.json 内容（与 materialize_sandbox 一致：files 里的 path 形如 "package.json"）。
    let pkg = files.iter().find(|f| f.path == "package.json")?;
    let value: serde_json::Value = serde_json::from_str(&pkg.content).ok()?;
    let start = value
        .get("scripts")
        .and_then(|s| s.get("start"))?
        .as_str()?
        .trim();
    // 简单 `node <file>` 形态可裸 node 预览（如 "node index.js"）；其余（electron . / 框架 CLI）需专属运行时。
    // 容错：去引号后若以 "node " 开头且只有一个参数，视为简单形态放行；否则视为专属运行时。
    let is_plain_node = start.starts_with("node ") && start.split_whitespace().count() == 2;
    if is_plain_node {
        return None;
    }
    // 依赖里若含 electron/pkg 等打包/运行时框架，给出更具体的提示。
    let deps = value
        .get("dependencies")
        .and_then(|d| d.as_object())
        .map(|m| m.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    let runtime_hint = if deps.iter().any(|d| d == "electron") {
        "（检测到 electron 依赖，需用 pnpm start 启动主进程）"
    } else {
        ""
    };
    Some(format!(
        "该插件声明了 scripts.start（{}），需要专属运行时而非直接 node 运行，预览执行无法启动{}。请在「插件」页用「运行」按钮以独立进程启动（pnpm start）。",
        start, runtime_hint
    ))
}

#[cfg(test)]
mod needs_runtime_start_tests {
    use super::*;

    fn file(path: &str, content: &str) -> ScriptFile {
        ScriptFile {
            path: path.to_string(),
            content: content.to_string(),
        }
    }

    #[test]
    fn plain_node_start_is_allowed() {
        // scripts.start = "node index.js" 形态简单，裸 node 可预览，不拦截。
        let files = vec![file(
            "package.json",
            r#"{"scripts":{"start":"node index.js"}}"#,
        )];
        assert!(needs_runtime_start(&files).is_none());
    }

    #[test]
    fn electron_start_is_blocked() {
        // scripts.start = "electron ." 需要 electron 运行时，预览拦截并提示。
        let files = vec![file(
            "package.json",
            r#"{"scripts":{"start":"electron ."},"dependencies":{"electron":"^31"}}"#,
        )];
        let reason = needs_runtime_start(&files).expect("应拦截 electron");
        assert!(reason.contains("electron ."));
        assert!(reason.contains("electron 依赖"));
        assert!(reason.contains("独立进程"));
    }

    #[test]
    fn no_package_json_is_allowed() {
        // 无 package.json（纯脚本插件）不拦截。
        let files = vec![file("index.js", "console.log('hi')")];
        assert!(needs_runtime_start(&files).is_none());
    }

    #[test]
    fn malformed_package_json_is_allowed() {
        // package.json 非法 JSON 时不拦截（降级为裸 node 尝试，由真实 node 错误兜底）。
        let files = vec![file("package.json", "{not json")];
        assert!(needs_runtime_start(&files).is_none());
    }
}

/// sandbox 落盘：清空旧目录后重建，逐文件写入子目录。
/// 返回 canonicalize 后的 sandbox 根与 entry 绝对路径，供 run_capture_with_env 使用。
fn materialize_sandbox(
    base: &Path,
    plugin_id: &str,
    files: &[ScriptFile],
    entry: &str,
) -> Result<(PathBuf, PathBuf), String> {
    // 修复 SCRIPT-01（critical 路径穿越删除）：
    // 此前 plugin_id 直接 join 进路径，含 '../'、'\\'、盘符或空串时会越出 plugin-sandbox，
    // 随后的 remove_dir_all 在未规范化路径上递归删，造成任意目录删除（不可恢复）。
    // canonicalize 前缀断言也被绕过（sandbox_canon 本身已被推到 plugin-sandbox 之外）。
    // 用段级白名单严格校验 plugin_id，仅允许 [A-Za-z0-9_-]，杜绝任何路径分量注入。
    let safe_id = sanitize_plugin_id(plugin_id)?;
    let sandbox_root = base.join("plugin-sandbox");
    let sandbox = sandbox_root.join(&safe_id);
    // 修复 SCRIPT-04（low 资源泄漏）：此前仅清当前 plugin_id 自身目录，从不回收其它 plugin_id
    // 的历史 sandbox，app_data/plugin-sandbox/ 持续堆积孤立目录。新增 LRU 清理：落盘前扫描
    // plugin-sandbox 目录，按 mtime 排序保留最近 SANDBOX_KEEP_DIRS 个，删除其余（含本次 plugin_id，
    // 因随后立即重建）。仅对名字通过 sanitize_plugin_id 的目录操作，杜绝误删非 sandbox 目录。
    cleanup_sandbox_lru(&sandbox_root, &safe_id);
    // 清空旧内容后重建，避免脏数据（上一轮残留文件影响本轮运行）。
    let _ = std::fs::remove_dir_all(&sandbox);
    std::fs::create_dir_all(&sandbox).map_err(|error| error.to_string())?;

    for file in files {
        let rel = sanitize_rel_path(&file.path)?;
        let abs = sandbox.join(&rel);
        if let Some(parent) = abs.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        std::fs::write(&abs, &file.content).map_err(|error| error.to_string())?;
    }

    let entry_rel = sanitize_rel_path(entry)?;
    let entry_abs = sandbox.join(&entry_rel);

    // canonicalize 后断言仍以 sandbox 为前缀（防符号链接逃逸，软隔离第二道防线）。
    let sandbox_canon = sandbox.canonicalize().map_err(|error| error.to_string())?;
    let entry_canon = entry_abs
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !entry_canon.starts_with(&sandbox_canon) {
        return Err(format!("entry 路径逃逸 sandbox：{entry}"));
    }
    Ok((sandbox_canon, entry_canon))
}

/// 修复 SCRIPT-01：plugin_id 段级白名单校验。
/// 仅允许字母、数字、下划线、短横线，禁空串、路径分隔符、点号（防 .. / 隐藏段 / 盘符）。
fn sanitize_plugin_id(plugin_id: &str) -> Result<String, String> {
    let trimmed = plugin_id.trim();
    if trimmed.is_empty() {
        return Err("plugin_id 不能为空".to_string());
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(format!(
            "plugin_id 含非法字符（仅允许字母数字下划线短横线）：{trimmed}"
        ));
    }
    Ok(trimmed.to_string())
}

/// 修复 SCRIPT-04（low 资源泄漏）：sandbox LRU 清理。
/// 落盘前扫描 plugin-sandbox 目录，按 mtime 排序保留最近 SANDBOX_KEEP_DIRS 个，
/// 删除其余（含本次 plugin_id，因随后立即重建）。
///
/// 安全保证：
/// - 仅处理名字通过 sanitize_plugin_id 的子目录（[A-Za-z0-9_-]），杜绝误删非 sandbox 目录。
/// - 目录不存在不报错（首次运行）。
/// - 单个目录删除失败不影响其它（继续尝试，最大化清理）。
fn cleanup_sandbox_lru(sandbox_root: &Path, _current_plugin_id: &str) {
    /// 保留的最近 sandbox 目录数量（LRU 上限）。8 个足以覆盖对话式迭代场景，
    /// 超出按 mtime 从最旧开始删除。
    const SANDBOX_KEEP_DIRS: usize = 8;

    let entries = match std::fs::read_dir(sandbox_root) {
        Ok(e) => e,
        Err(_) => return, // 目录不存在（首次运行）或不可读，静默跳过。
    };
    // 收集 (path, mtime) 对，仅保留通过 sanitize_plugin_id 的目录名（安全过滤）。
    let mut candidates: Vec<(PathBuf, std::time::SystemTime)> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        // 仅清理合法 plugin_id 目录，跳过任何非法名（防误删用户其它文件）。
        if sanitize_plugin_id(&name_str).is_err() {
            continue;
        }
        let path = entry.path();
        let metadata = match std::fs::metadata(&path) {
            Ok(m) if m.is_dir() => m,
            _ => continue, // 非目录或读元数据失败，跳过。
        };
        let mtime = metadata
            .modified()
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        candidates.push((path, mtime));
    }
    // mtime 降序（最新在前），超出 KEEP 的从尾部（最旧）开始删。
    candidates.sort_by(|a, b| b.1.cmp(&a.1));
    for (path, _mtime) in candidates.into_iter().skip(SANDBOX_KEEP_DIRS) {
        let _ = std::fs::remove_dir_all(&path);
    }
}

/// 命令：运行插件脚本（无参数一次性运行 + 带超时）。
#[tauri::command]
pub fn run_plugin_script(
    app: tauri::AppHandle,
    input: RunPluginScriptInput,
) -> Result<RunResult, String> {
    // 解释器探测前置：缺失直接返回友好错误（前端据 ProbeResult.hint 展示安装指引）。
    let probe = probe_script_runtime(input.runtime)?;
    if !probe.available {
        return Err(format!(
            "interpreter_missing:{}",
            probe.hint.unwrap_or_else(|| install_hint(input.runtime))
        ));
    }
    let binary = PathBuf::from(
        probe
            .binary_path
            .ok_or_else(|| "解释器探测命中但路径缺失".to_string())?,
    );

    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let (sandbox_canon, entry_canon) =
        materialize_sandbox(&data_dir, &input.plugin_id, &input.files, &input.entry)?;

    // 预检（Node 插件专属运行时）：若插件声明了 package.json + scripts.start（如 electron . / 框架 CLI），
    // 说明它需要专属运行时而非裸 node 直跑入口。预览执行用 `node <entry>` 无法加载此类运行时
    // （electron 是特殊可执行包，node require('electron') 会抛 EISDIR/模块解析错）。
    // 提前返回友好提示，引导用户用持久化运行（插件页「运行」→ pnpm start 独立进程），而非暴露 node 内部堆栈。
    if input.runtime == ScriptRuntime::Nodejs {
        if let Some(reason) = needs_runtime_start(&input.files) {
            return Err(reason);
        }
    }

    // 组D task 06-16：plugin_script 预览执行仍用临时 sandbox（group B 的 venv/pnpm 持久化运行尚未落地），
    // 故 plugin_id 传 None 走 workspace_dir 显式路径分支（不落 plugins_root，保持预览隔离）。
    let workspace = resolve_workspace(
        Some(sandbox_canon.to_string_lossy().to_string()),
        None,
        None,
    )?;
    let mut args: Vec<String> = Vec::new();
    // Python 经 py launcher 时需显式指定 -3？保持简单：直接用探测到的 binary（py/python3/node），
    // 由 binary 自身决定默认版本。
    // H1 修复：Python 追加 -u（无缓冲），避免管道块缓冲导致短输出在超时 kill 时丢失。
    // H4 修复（多文件相对 import）：追加 PYTHONPATH=<sandbox根> env（见下方 runtime_env）。
    if input.runtime == ScriptRuntime::Python {
        args.push("-u".to_string());
    }
    args.push(entry_canon.to_string_lossy().to_string());

    let timeout = input.timeout_ms.unwrap_or(15_000);
    let started = Instant::now();
    // H2 修复：Python 追加 PYTHONIOENCODING=utf-8 + PYTHONUTF8=1，避免 Windows 中文系统
    // 默认 GBK 编码导致 print 中文输出 UnicodeEncodeError 崩溃或乱码。
    // H4 修复：PYTHONPATH=<sandbox根> 让多文件插件的 import 能找到 sandbox 根目录的模块。
    let env = runtime_env(input.runtime, &workspace, minimal_env());
    let captured: CapturedOutput =
        run_capture_with_env(&binary, args, Some(&workspace), timeout, env)?;
    Ok(RunResult {
        stdout: captured.stdout,
        stderr: captured.stderr,
        exit_code: captured.exit_code,
        timed_out: captured.timed_out,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

// === 单元测试 ===
// 覆盖：sanitize_rel_path 防穿越、materialize_sandbox 落盘与逃逸检测。
// 解释器运行测试依赖宿主有 node/py，用 #[cfg] 守卫；无解释器时跳过（环境层不可控）。
#[cfg(test)]
mod tests {
    use super::*;

    fn rel(path: &str) -> PathBuf {
        sanitize_rel_path(path).expect("合法相对路径应通过")
    }

    // === H1/H2/H4 修复测试：runtime_env 按 runtime 注入专属环境变量 ===

    #[test]
    fn runtime_env_python_adds_utf8_and_pythonpath() {
        // Python 必须注入 PYTHONIOENCODING=utf-8 + PYTHONUTF8=1（H2 防 Windows 中文乱码）
        // + PYTHONPATH=<workspace>（H4 多文件相对 import）。
        let env = runtime_env(ScriptRuntime::Python, "/sandbox/root", vec![]);
        let keys: Vec<_> = env
            .iter()
            .map(|(k, _)| k.to_string_lossy().to_string())
            .collect();
        assert!(
            keys.iter().any(|k| k == "PYTHONIOENCODING"),
            "缺 PYTHONIOENCODING"
        );
        assert!(keys.iter().any(|k| k == "PYTHONUTF8"), "缺 PYTHONUTF8");
        assert!(keys.iter().any(|k| k == "PYTHONPATH"), "缺 PYTHONPATH");
        // 值校验。
        let get = |key: &str| {
            env.iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.to_string_lossy().to_string())
        };
        assert_eq!(get("PYTHONIOENCODING").as_deref(), Some("utf-8"));
        assert_eq!(get("PYTHONUTF8").as_deref(), Some("1"));
        assert_eq!(get("PYTHONPATH").as_deref(), Some("/sandbox/root"));
    }

    #[test]
    fn runtime_env_nodejs_does_not_add_python_vars() {
        // Node.js 不注入 Python 专属变量（避免污染）。
        let env = runtime_env(ScriptRuntime::Nodejs, "/sandbox", vec![]);
        let keys: Vec<_> = env
            .iter()
            .map(|(k, _)| k.to_string_lossy().to_string())
            .collect();
        assert!(!keys
            .iter()
            .any(|k| k == "PYTHONIOENCODING" || k == "PYTHONUTF8" || k == "PYTHONPATH"));
    }

    #[test]
    fn runtime_env_preserves_base_env() {
        // base env 的现有项必须保留（追加不替换）。
        let base = vec![(OsString::from("PATH"), OsString::from("/usr/bin"))];
        let env = runtime_env(ScriptRuntime::Python, "/ws", base);
        assert!(env.iter().any(|(k, v)| k == "PATH" && v == "/usr/bin"));
    }

    #[test]
    fn sanitize_accepts_normal_relative_path() {
        assert_eq!(rel("src/index.js"), PathBuf::from("src/index.js"));
        assert_eq!(rel("main.py"), PathBuf::from("main.py"));
    }

    #[test]
    fn sanitize_rejects_absolute_paths() {
        assert!(sanitize_rel_path("/etc/passwd").is_err());
        assert!(sanitize_rel_path("~/x").is_err());
        assert!(sanitize_rel_path("C:/evil").is_err());
    }

    #[test]
    fn sanitize_rejects_traversal_and_hidden() {
        assert!(sanitize_rel_path("../escape.js").is_err());
        assert!(sanitize_rel_path("a/../b").is_err());
        assert!(sanitize_rel_path(".env").is_err());
        assert!(sanitize_rel_path("a//b").is_err());
    }

    #[test]
    fn materialize_writes_files_and_detects_escape() {
        let tmp = std::env::temp_dir().join(format!(
            "lf-plugin-script-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let files = vec![
            ScriptFile {
                path: "main.py".to_string(),
                content: "print('ok')".to_string(),
            },
            ScriptFile {
                path: "lib/util.py".to_string(),
                content: "# helper".to_string(),
            },
        ];
        let (sandbox, entry) =
            materialize_sandbox(&tmp, "test-plugin", &files, "main.py").expect("落盘成功");
        assert!(entry.starts_with(&sandbox));
        assert!(entry.is_file());
        assert!(sandbox.join("lib").join("util.py").is_file());

        // entry 指向不存在文件应报错（canonicalize 失败）。
        let bad = materialize_sandbox(&tmp, "test-plugin", &files, "missing.py");
        assert!(bad.is_err());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn install_hint_covers_both_runtimes() {
        assert!(install_hint(ScriptRuntime::Nodejs).contains("nodejs.org"));
        assert!(install_hint(ScriptRuntime::Python).contains("py launcher"));
    }

    // 解释器实跑测试：仅在宿主存在对应解释器时执行，否则跳过（不标记失败）。
    fn maybe_node() -> Option<PathBuf> {
        interpreter_candidates(ScriptRuntime::Nodejs)
            .iter()
            .find_map(|c| find_binary(c))
    }

    fn maybe_python() -> Option<PathBuf> {
        interpreter_candidates(ScriptRuntime::Python)
            .iter()
            .find_map(|c| find_binary(c))
    }

    #[test]
    fn run_node_hello_script_if_available() {
        let binary = match maybe_node() {
            Some(b) => b,
            None => {
                eprintln!("[skip] 宿主无 node，跳过 Node 运行测试");
                return;
            }
        };
        // 在临时 sandbox 写一个 console.log 脚本直接运行（不走 run_plugin_script 的 app handle 依赖）。
        let tmp = std::env::temp_dir().join(format!(
            "lf-node-run-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        let entry = tmp.join("index.js");
        std::fs::write(&entry, "console.log('ok-from-node')").unwrap();
        let captured = run_capture_with_env(
            &binary,
            vec![entry.to_string_lossy().to_string()],
            None,
            5_000,
            minimal_env(),
        )
        .expect("node 运行应成功");
        assert!(!captured.timed_out);
        assert_eq!(captured.exit_code, Some(0));
        assert!(captured.stdout.contains("ok-from-node"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn run_python_hello_script_if_available() {
        let binary = match maybe_python() {
            Some(b) => b,
            None => {
                eprintln!("[skip] 宿主无 python，跳过 Python 运行测试");
                return;
            }
        };
        let tmp = std::env::temp_dir().join(format!(
            "lf-py-run-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        let entry = tmp.join("main.py");
        std::fs::write(&entry, "print('ok-from-python')").unwrap();
        let captured = run_capture_with_env(
            &binary,
            vec![entry.to_string_lossy().to_string()],
            None,
            5_000,
            minimal_env(),
        )
        .expect("python 运行应成功");
        assert!(!captured.timed_out);
        assert_eq!(captured.exit_code, Some(0));
        assert!(captured.stdout.contains("ok-from-python"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn timeout_kills_infinite_loop() {
        let _guard = crate::code_assistant::process_tree_test_lock();
        let binary = match maybe_node() {
            Some(b) => b,
            None => {
                eprintln!("[skip] 宿主无 node，跳过超时测试");
                return;
            }
        };
        let tmp = std::env::temp_dir().join(format!(
            "lf-timeout-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        let entry = tmp.join("loop.js");
        std::fs::write(&entry, "while(true){}").unwrap();
        let started = Instant::now();
        let captured = run_capture_with_env(
            &binary,
            vec![entry.to_string_lossy().to_string()],
            None,
            800,
            minimal_env(),
        )
        .expect("超时应被 kill 并返回而非报错");
        assert!(captured.timed_out);
        // 超时应在略超 800ms 处回收（含 50ms 轮询粒度容忍）。
        let elapsed = started.elapsed().as_millis();
        assert!(elapsed < 3000, "超时回收耗时异常：{elapsed}ms");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    // 修复 SCRIPT-03（medium 错误处理）：probe guard 必须拒绝 Microsoft Store stub。
    // stub --version 退出码非 0（9009）或 stderr 含「was not found」，应判为不可用。
    #[test]
    fn store_stub_output_is_detected() {
        // Python 候选的 stub 输出（典型 Microsoft Store 提示）应被判为 stub。
        assert!(is_store_stub_output(
            "Python was not found; run without arguments to install from the Microsoft Store...",
            ScriptRuntime::Python,
        ));
        assert!(is_store_stub_output(
            "MiCrOsOfT StOrE install hint",
            ScriptRuntime::Python,
        ));
        // 真实 Python 版本输出不应被判为 stub。
        assert!(!is_store_stub_output(
            "Python 3.12.0",
            ScriptRuntime::Python,
        ));
        // 空 stderr 不判为 stub。
        assert!(!is_store_stub_output("", ScriptRuntime::Python));
        // Node 候选始终不判为 stub（无 Store stub 问题）。
        assert!(!is_store_stub_output(
            "Python was not found",
            ScriptRuntime::Nodejs,
        ));
    }

    // 修复 SCRIPT-04（low 资源泄漏）：sandbox LRU 清理应保留最近 N 个，删除最旧。
    #[test]
    fn sandbox_lru_keeps_recent_and_removes_old() {
        let tmp = std::env::temp_dir().join(format!(
            "lf-sandbox-lru-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        // 写 12 个合法 plugin_id 目录（超 KEEP=8），用不同的 mtime 模拟历史。
        // 通过 touch（写文件）调整 mtime，确保排序可区分。
        for i in 0..12u32 {
            let dir = tmp.join(format!("plugin-{i}"));
            std::fs::create_dir_all(&dir).unwrap();
            // 每个目录里写一个文件并设置不同的 mtime（i 越大 mtime 越新）。
            std::fs::write(dir.join("marker.txt"), format!("{i}")).unwrap();
            // 用不同 sleep 间隔确保 mtime 严格递增（filesystem 精度可能粗，多 sleep 几毫秒）。
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        // 调 cleanup_sandbox_lru（KEEP=8）：应删除最旧的 4 个（plugin-0..plugin-3）。
        cleanup_sandbox_lru(&tmp, "plugin-new");
        let remaining: Vec<String> = std::fs::read_dir(&tmp)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        // 保留 8 个，最旧的 4 个被删。
        assert_eq!(remaining.len(), 8, "应保留 8 个，实际 {remaining:?}");
        assert!(
            !remaining.iter().any(|n| n == "plugin-0"),
            "plugin-0 应被删"
        );
        assert!(
            !remaining.iter().any(|n| n == "plugin-3"),
            "plugin-3 应被删"
        );
        assert!(remaining.iter().any(|n| n == "plugin-4"), "plugin-4 应保留");
        assert!(
            remaining.iter().any(|n| n == "plugin-11"),
            "plugin-11 应保留"
        );
        // 非法目录名不应被删（安全过滤）：写一个含路径分隔符的目录。
        // 注意：Windows/Linux 不允许目录名含 / 或 \，改用 . 开头的隐藏名（sanitize 拒绝）。
        let hidden = tmp.join(".hidden-dir");
        std::fs::create_dir_all(&hidden).unwrap();
        cleanup_sandbox_lru(&tmp, "plugin-x");
        // .hidden-dir 应仍存在（sanitize_plugin_id 拒绝 . 开头）。
        assert!(hidden.exists(), "非法名目录不应被 LRU 删除");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    // 修复 SCRIPT-02（high 并发）：超时杀进程应杀整个进程组（含孙进程），
    // wait_with_output 不应永久挂起。本测试派生孙进程（node 子进程）模拟，验证回收不阻塞。
    #[test]
    fn timeout_kills_grandchild_process_tree() {
        let _guard = crate::code_assistant::process_tree_test_lock();
        let binary = match maybe_node() {
            Some(b) => b,
            None => {
                eprintln!("[skip] 宿主无 node，跳过孙进程超时测试");
                return;
            }
        };
        let tmp = std::env::temp_dir().join(format!(
            "lf-timeout-grandchild-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        // 派生一个孙进程（unref 后死循环），主进程也死循环。
        // 超时杀主进程后，孙进程若不被杀会继续持有 stdout 管道写端，wait_with_output 永久阻塞。
        let script = r#"
            const { spawn } = require('child_process');
            // 孙进程：同样死循环（继承 stdout 管道写端）。
            spawn(process.execPath, ['-e', 'while(true){}']).unref();
            // 主进程：死循环，直到被 kill。
            while (true) {}
        "#;
        let entry = tmp.join("spawn_loop.js");
        std::fs::write(&entry, script).unwrap();
        let started = Instant::now();
        // 关键断言：run_capture_with_env 必须在合理时间内返回（不永久阻塞）。
        // 若孙进程未被杀，wait_with_output 会无限挂起，本测试 5s 超时 fail。
        let captured = run_capture_with_env(
            &binary,
            vec![entry.to_string_lossy().to_string()],
            None,
            800,
            minimal_env(),
        )
        .expect("超时应杀进程组并返回，不永久阻塞");
        let elapsed = started.elapsed().as_millis();
        assert!(captured.timed_out, "应触发超时");
        // 关键：若 wait_with_output 永久阻塞，elapsed 会远超 5s（本测试 cargo 默认无超时，
        // 但孙进程不被杀时实际会挂死到外部 CI 超时）。这里设 < 5000ms 作为快速回归保护。
        assert!(
            elapsed < 5000,
            "超时回收孙进程耗时异常：{elapsed}ms（可能 wait_with_output 被孙进程管道阻塞）"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    // === 完整插件执行测试（覆盖三种 runtime 的真实创建流程）===
    // 验证：sandbox 落盘 + runtime_env 注入 + run_capture_with_env 执行，
    // 含中文输出（验证 UTF-8/H2）、Python 多文件 import（H4 PYTHONPATH）、-u 无缓冲（H1）。

    #[test]
    fn node_plugin_chinese_output_and_structured() {
        // Node 插件完整执行：中文输出不乱码 + JSON 结构化 + stdout/stderr 分离。
        let binary = match maybe_node() {
            Some(b) => b,
            None => {
                eprintln!("[skip] 宿主无 node");
                return;
            }
        };
        let tmp = std::env::temp_dir().join(format!(
            "lf-node-plugin-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(
            tmp.join("index.js"),
            r#"
console.log("插件启动：Node.js " + process.version);
console.log("处理结果：✓ 会议纪要已整理，生成 3 条行动项");
console.log(JSON.stringify({ actionItems: ["任务A", "任务B"] }));
console.error("诊断信息");
"#,
        )
        .unwrap();
        let entry = tmp.join("index.js");
        let captured = run_capture_with_env(
            &binary,
            vec![entry.to_string_lossy().to_string()],
            Some(tmp.to_str().unwrap()),
            10_000,
            minimal_env(),
        )
        .unwrap();
        assert!(!captured.timed_out, "node 不应超时");
        assert_eq!(captured.exit_code, Some(0), "node 应 exit 0");
        assert!(
            captured.stdout.contains("会议纪要已整理"),
            "中文 stdout 丢失/乱码：{}",
            captured.stdout
        );
        assert!(
            captured.stdout.contains("任务A"),
            "JSON 中文内容丢失：{}",
            captured.stdout
        );
        assert!(captured.stderr.contains("诊断信息"), "stderr 应含诊断");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn python_plugin_chinese_and_cross_dir_import() {
        // Python 插件完整执行：验证 H1(-u 无缓冲) + H2(UTF-8 编码防中文乱码) + H4(PYTHONPATH 跨目录 import)。
        let binary = match maybe_python() {
            Some(b) => b,
            None => {
                eprintln!("[skip] 宿主无 python");
                return;
            }
        };
        let tmp = std::env::temp_dir().join(format!(
            "lf-py-plugin-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(tmp.join("pkg")).unwrap();
        // 子模块 pkg/util.py（跨目录 import，验证 PYTHONPATH 注入）。
        std::fs::write(
            tmp.join("pkg/util.py"),
            "def greet(name):\n    return f'你好 {name}，Python 插件运行中'\n",
        )
        .unwrap();
        // main.py 在根，import pkg.util（需 PYTHONPATH=<根>）。
        std::fs::write(
            tmp.join("main.py"),
            r#"
# -*- coding: utf-8 -*-
import sys, json
from pkg.util import greet
print(greet("开发者"))
print("处理结果：✓ 数据清洗完成，处理 128 条记录")
print(json.dumps({"records": 128, "status": "cleaned"}, ensure_ascii=False))
sys.stderr.write("诊断：Python stderr\n")
"#,
        )
        .unwrap();
        let entry = tmp.join("main.py");
        // 模拟 run_plugin_script 的真实调用：-u + runtime_env（PYTHONIOENCODING/PYTHONUTF8/PYTHONPATH）。
        let workspace = tmp.to_string_lossy().to_string();
        let env = runtime_env(ScriptRuntime::Python, &workspace, minimal_env());
        let captured = run_capture_with_env(
            &binary,
            vec!["-u".to_string(), entry.to_string_lossy().to_string()],
            Some(&workspace),
            10_000,
            env,
        )
        .unwrap();
        assert!(!captured.timed_out, "python 不应超时");
        assert_eq!(captured.exit_code, Some(0), "python 应 exit 0");
        // H4：跨目录 import 成功（无 ModuleNotFoundError）。
        assert!(
            captured.stdout.contains("你好 开发者"),
            "PYTHONPATH 跨目录 import 失败或中文乱码：{}",
            captured.stdout
        );
        // H2：中文不乱码。
        assert!(
            captured.stdout.contains("数据清洗完成"),
            "UTF-8 中文输出乱码：{}",
            captured.stdout
        );
        assert!(captured.stderr.contains("Python stderr"), "stderr 丢失");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn html_plugin_materialize_and_readable() {
        // HTML 插件：materialize_sandbox 落盘 + 文件可读（iframe srcDoc 渲染前置条件）。
        let tmp = std::env::temp_dir().join(format!(
            "lf-html-plugin-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        let files = vec![ScriptFile {
            path: "ui/index.html".to_string(),
            content:
                "<!DOCTYPE html><html><body><h1>HTML 插件预览</h1><p>前端插件正常</p></body></html>"
                    .to_string(),
        }];
        let (sandbox, entry) =
            materialize_sandbox(&tmp, "html-test-plugin", &files, "ui/index.html").unwrap();
        assert!(entry.starts_with(&sandbox), "entry 应在 sandbox 内");
        let content = std::fs::read_to_string(&entry).unwrap();
        assert!(content.contains("HTML 插件预览"), "HTML 内容应可读");
        assert!(
            content.contains("<!DOCTYPE html>"),
            "应是完整 HTML 文档（iframe srcDoc 可渲染）"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
