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

use crate::code_assistant::{
    find_binary, run_capture_with_env, resolve_workspace, CapturedOutput,
};

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
            "未检测到 Node.js。请安装：访问 https://nodejs.org 下载 LTS，或运行 winget install OpenJS.Technology.NodeJS.LTS".to_string()
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
/// 命中后跑 `--version` 实跑确认非 Store stub（stub 通常不在 stdout 打印 Python x.y.z 且会挂起，由超时兜底）。
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
                Ok(captured) if !captured.timed_out => {
                    // 版本字符串拼接 stdout + stderr（部分实现走 stderr），取首行。
                    let raw_version = format!("{}\n{}", captured.stdout.trim(), captured.stderr.trim());
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
                    // 候选命中但 --version 失败/超时（疑似 stub）：继续尝试下一个候选。
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

/// 最小白名单环境变量：仅保留解释器/依赖查找与系统调用必需项，裁掉宿主 token/密钥。
/// 权衡（design §4.4）：依赖自定义环境变量的脚本在预览中行为可能与真实运行不一致，
/// 但预览目标是「能跑起来看 stdout」，非「100% 复现生产环境」。
fn minimal_env() -> Vec<(OsString, OsString)> {
    let keys = [
        "PATH",                       // 解释器/依赖查找必须
        "HOME", "USERPROFILE",        // Node/Python 用户级配置
        "APPDATA", "LOCALAPPDATA",    // Windows npm/pip 缓存定位
        "SystemRoot", "TEMP", "TMP",  // Windows 系统调用与临时目录
        "LANG", "LC_ALL",             // 区域，避免乱码
    ];
    keys
        .iter()
        .filter_map(|key| std::env::var_os(key).map(|value| (OsString::from(key), value)))
        .collect()
}

/// 规范化相对路径：禁绝对路径（/ ~ C:）/空段/./../隐藏系统段。
/// 与后端 plugin-package.ts cleanPath 等价逻辑，是路径穿越防御的第一道（软隔离）防线。
fn sanitize_rel_path(path: &str) -> Result<PathBuf, String> {
    let normalized = path.trim().replace('\\', "/");
    if normalized.is_empty() {
        return Err("路径不能为空".to_string());
    }
    if normalized.starts_with('/') || normalized.starts_with('~') || is_windows_drive_prefix(&normalized) {
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

/// sandbox 落盘：清空旧目录后重建，逐文件写入子目录。
/// 返回 canonicalize 后的 sandbox 根与 entry 绝对路径，供 run_capture_with_env 使用。
fn materialize_sandbox(
    base: &Path,
    plugin_id: &str,
    files: &[ScriptFile],
    entry: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let sandbox = base.join("plugin-sandbox").join(plugin_id);
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
    let entry_canon = entry_abs.canonicalize().map_err(|error| error.to_string())?;
    if !entry_canon.starts_with(&sandbox_canon) {
        return Err(format!("entry 路径逃逸 sandbox：{entry}"));
    }
    Ok((sandbox_canon, entry_canon))
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

    let workspace = resolve_workspace(Some(sandbox_canon.to_string_lossy().to_string()))?;
    let mut args: Vec<String> = Vec::new();
    // Python 经 py launcher 时需显式指定 -3？保持简单：直接用探测到的 binary（py/python3/node），
    // 由 binary 自身决定默认版本。此处仅追加 entry 路径。
    args.push(entry_canon.to_string_lossy().to_string());

    let timeout = input.timeout_ms.unwrap_or(15_000);
    let started = Instant::now();
    let captured: CapturedOutput = run_capture_with_env(
        &binary,
        args,
        Some(&workspace),
        timeout,
        minimal_env(),
    )?;
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
}
