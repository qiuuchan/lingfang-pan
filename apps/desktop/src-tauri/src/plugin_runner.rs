//! 插件持久化运行引擎（task 06-16-plugin-system-rebuild 组B）。
//!
//! 与 plugin_script.rs 的区别：
//! - plugin_script.rs：一次性预览执行（run_plugin_script），捕获 stdout 进 UI，15s 超时 kill，
//!   落盘到临时 plugin-sandbox（运行后 LRU 清理）。
//! - plugin_runner.rs（本模块）：持久化独立进程运行（start_plugin），**detached 不捕获 stdout 进 UI**
//!   （Python GUI 自己弹窗口，Node 输出在它自己的控制台），进程表记录 pid 供软件显示「运行中」+ 强制关闭。
//!
//! 运行流程（PRD 需求 3/5/7/9）：
//! - Python：检测 .venv/ → 不存在则 `py -3 -m venv .venv` → 有 requirements.txt 则
//!   `.venv/.../pip install -r requirements.txt` → detached `.venv/.../python main.py`。
//! - Node：有 package.json + dependencies 则 `pnpm install` → detached `pnpm start`。
//!
//! 进程表集成（与组A plugin_store.rs 协作）：
//! - start_plugin：spawn detached → 内存进程表（PluginProcessTable）记录 Child 句柄（不落 DB，
//!   PRD 需求 2「状态不存 DB」，重启后所有插件从文件系统重判 ready）。
//! - stop_plugin：内存表 take Child → kill_child_tree → wait 回收句柄。
//! - get_plugin_status：查内存表（try_wait 判定），不读文件（实时性高于 scan）。
//! - scan_plugin_status（组A）：扫文件系统判 ready/incomplete/error，调本表 is_running 叠加 running。
//!
//! 安全边界（与 plugin_script.rs 同源留痕）：
//! - 本通道是【不受控执行通道】，绕过 capability 网关（design §6.1）。
//! - 软隔离：plugin_id 段级白名单（plugin_store::sanitize_plugin_id）、路径不穿越 plugins_root。
//! - 可逃逸：用户权限运行的脚本可执行 fs.writeFile / child_process / 网络请求（与本地直接 `node main.js` 等价）。
//! - 后续独立大任务：OS 级硬隔离 + script.node/script.python capability kind 让本通道也走声明式授权。

use std::ffi::OsString;
use std::path::PathBuf;
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

// 复用 code_assistant.rs 的子进程基础设施：
// - find_binary：跨平台 PATH 探测（Windows 优先 .cmd/.bat npm shim 再 .exe）。
// - run_capture_with_env：带超时的同步运行（用于 venv 创建 / pip install / pnpm install 等阻塞阶段）。
// - kill_child_tree：杀整个进程组/树（含孙进程），供 stop_plugin 复用。
// - minimal_env 不复用 plugin_script.rs 的 pub(crate)（保持组B 自洽，独立构造同款白名单）。
use crate::code_assistant::{find_binary, kill_child_tree, run_capture_with_env};
// 复用组A plugin_store.rs 的 PluginStore（plugins_root 解析 + ensure_plugin_dir + sanitize_plugin_id）。
// 避免重复实现（DRY）：plugin_id 白名单 / canonicalize 前缀断言 / 目录定位全走组A。
use crate::plugin_store::{sanitize_plugin_id, PluginStore};

/// 插件运行时类型（与 plugin_store::PluginRuntime 对齐，serde lowercase）。
/// 仅 nodejs/python 走本模块的独立进程运行通道；client（HTML）由前端 iframe 直接显示，不经此通道。
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PluginRuntimeKind {
    Nodejs,
    Python,
}

/// manifest.json 解析后的运行时元信息（仅取本模块运行所需的字段）。
/// 字段宽松：缺 runtime_type 视为 client（前端不调 start_plugin，本结构仅在已判定为 nodejs/python 时构造）。
#[derive(Clone, Debug)]
struct PluginManifest {
    runtime: PluginRuntimeKind,
    entry: String,
}

/// 解析 manifest.json 的 runtime_type + entry。
/// - runtime_type 必须是 nodejs/python（client 由前端分流，不应进本通道）。
/// - entry 缺省：python → main.py，nodejs → index.js（与 builtin 示例插件对齐）。
/// - 解析失败（文件缺失/JSON 非法/runtime_type 非法）返回具体错误，供前端展示 error 状态。
/// - 文件不存在（创建期 AI 会话失败/中断残留的空 temp 目录）返回 `manifest_missing:` 前缀，
///   前端据此显示「未生成完成，继续对话补全」引导，而非裸 os error 2。
fn parse_manifest(plugin_dir: &std::path::Path) -> Result<PluginManifest, String> {
    let manifest_path = plugin_dir.join("manifest.json");
    let raw = std::fs::read_to_string(&manifest_path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            // 创建期 temp 目录空（AI 未产出 manifest）：结构化前缀，前端识别后引导重新生成。
            "manifest_missing:插件未生成完成（缺少 manifest.json），请继续对话让 AI 补全或重新创建"
                .to_string()
        } else {
            format!(
                "读取 manifest.json 失败（{}）：{e}",
                manifest_path.display()
            )
        }
    })?;
    let v: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("manifest.json 解析失败：{e}"))?;
    let runtime_str = v.get("runtime_type").and_then(|x| x.as_str()).unwrap_or("");
    let runtime = match runtime_str {
        "nodejs" => PluginRuntimeKind::Nodejs,
        "python" => PluginRuntimeKind::Python,
        other => {
            return Err(format!(
                "manifest runtime_type 不支持独立进程运行（{other:?}，仅 nodejs/python）"
            ))
        }
    };
    let entry = v
        .get("entry")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| match runtime {
            PluginRuntimeKind::Python => "main.py".to_string(),
            PluginRuntimeKind::Nodejs => "index.js".to_string(),
        });
    Ok(PluginManifest { runtime, entry })
}

/// 解析插件的持久化目录路径（plugins_root/<plugin_id>，canonicalize 防符号链接逃逸）。
/// 复用组A PluginStore.ensure_plugin_dir（段级白名单 + create_dir_all + canonicalize）。
fn resolve_plugin_dir(store: &PluginStore, plugin_id: &str) -> Result<PathBuf, String> {
    store.ensure_plugin_dir(plugin_id)
}

// === Python venv 管理 ===

/// 探测 Python venv 内的解释器绝对路径（按 PRD 需求 3）。
/// - Windows：.venv/Scripts/python.exe
/// - Unix：.venv/bin/python
fn venv_python(venv_dir: &std::path::Path) -> PathBuf {
    #[cfg(windows)]
    {
        venv_dir.join("Scripts").join("python.exe")
    }
    #[cfg(not(windows))]
    {
        venv_dir.join("bin").join("python")
    }
}

/// 探测 Python venv 内的 pip 绝对路径（用于 pip install -r requirements.txt）。
/// - Windows：.venv/Scripts/pip.exe
/// - Unix：.venv/bin/pip
fn venv_pip(venv_dir: &std::path::Path) -> PathBuf {
    #[cfg(windows)]
    {
        venv_dir.join("Scripts").join("pip.exe")
    }
    #[cfg(not(windows))]
    {
        venv_dir.join("bin").join("pip")
    }
}

/// 探测 Python 插件是否需要创建 venv（首次慢，已建则 ensure 秒过）。
/// 用于 start_plugin 发「安装依赖」阶段事件（前端据此决定是否展示安装动画）。
/// 判定：venv 内 python 不存在 → 需要创建（+可能 pip install）。与 ensure_python_venv 的「已就绪跳过」逻辑对齐。
fn needs_python_venv(plugin_dir: &std::path::Path) -> bool {
    let venv_dir = plugin_dir.join(".venv");
    !venv_python(&venv_dir).is_file()
}

/// 确保 Python 插件有可用 venv（PRD 需求 3 / AC3）。
/// 流程：
/// 1. 检查 .venv/ 是否存在且 venv_python 可执行 → 已就绪直接返回。
/// 2. 不存在 → 探测宿主 py/python 解释器 → `py -3 -m venv .venv`（带超时，venv 创建可能慢）。
/// 3. 有 requirements.txt → `.venv/.../pip install -r requirements.txt`（带超时，依赖多时较慢）。
///
/// 失败处理（PRD Constraints）：venv 创建/pip install 失败返回友好错误（不崩），前端据 error 展示。
fn ensure_python_venv(plugin_dir: &std::path::Path) -> Result<PathBuf, String> {
    let venv_dir = plugin_dir.join(".venv");
    let py = venv_python(&venv_dir);
    // 已有 venv 且解释器存在 → 跳过创建（但 requirements.txt 仍需检查是否装过，简化：每次 start 都补装幂等）。
    if !py.is_file() {
        // 探测宿主 Python：Windows 优先 py launcher（避免 Microsoft Store stub，见 plugin_script.rs 注释）。
        let host_py = find_python_interpreter().ok_or_else(|| {
            "未检测到 Python 解释器（需安装 Python 3 或 py launcher）".to_string()
        })?;
        // venv 创建：py -3 -m venv .venv。venv 含 pip 引导可能 30s+，给 300s 超时。
        let venv_args = vec![
            "-m".to_string(),
            "venv".to_string(),
            venv_dir.to_string_lossy().to_string(),
        ];
        let captured = run_capture_with_env(
            &host_py,
            venv_args,
            Some(&plugin_dir.to_string_lossy()),
            300_000,
            minimal_env(),
        )
        .map_err(|e| format!("创建 venv 失败：{e}"))?;
        if captured.exit_code != Some(0) {
            return Err(format!(
                "创建 venv 失败（exit={:?}）：{}",
                captured.exit_code,
                captured.stderr.trim()
            ));
        }
    }
    // 有 requirements.txt → pip install（幂等，已装依赖 pip 会跳过）。
    let requirements = plugin_dir.join("requirements.txt");
    if requirements.is_file() {
        let pip = venv_pip(&venv_dir);
        if pip.is_file() {
            // pip install 可能下载大包，给 600s 超时。--no-input 避免交互式提示挂起。
            let pip_args = vec![
                "install".to_string(),
                "--no-input".to_string(),
                "-r".to_string(),
                requirements.to_string_lossy().to_string(),
            ];
            let captured = run_capture_with_env(
                &pip,
                pip_args,
                Some(&plugin_dir.to_string_lossy()),
                600_000,
                minimal_env(),
            )
            .map_err(|e| format!("pip install 失败：{e}"))?;
            if captured.exit_code != Some(0) {
                return Err(format!(
                    "pip install 失败（exit={:?}）：{}",
                    captured.exit_code,
                    captured.stderr.trim()
                ));
            }
        }
    }
    if !py.is_file() {
        return Err(format!("venv 创建后仍找不到解释器：{}", py.display()));
    }
    Ok(py)
}

/// 探测宿主 Python 解释器（Windows 优先 py launcher）。
/// 与 plugin_script.rs::interpreter_candidates 同款顺序，但返回 PathBuf（find_binary 命中的实际路径）。
fn find_python_interpreter() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        for candidate in ["py", "python", "python3"] {
            if let Some(p) = find_binary(candidate) {
                return Some(p);
            }
        }
        None
    }
    #[cfg(not(windows))]
    {
        for candidate in ["python3", "python"] {
            if let Some(p) = find_binary(candidate) {
                return Some(p);
            }
        }
        None
    }
}

/// 最小白名单环境变量（与 plugin_script.rs::minimal_env 同语义，避免泄漏宿主 token/密钥到插件进程）。
/// 本模块独立构造（不依赖 plugin_script.rs 的 pub(crate) 导出，保持模块自洽）。
fn minimal_env() -> Vec<(OsString, OsString)> {
    let keys = [
        "PATH",
        "HOME",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "SystemRoot",
        "TEMP",
        "TMP",
        "LANG",
        "LC_ALL",
    ];
    keys.iter()
        .filter_map(|key| std::env::var_os(key).map(|value| (OsString::from(key), value)))
        .collect()
}

// === Node pnpm 管理 ===

/// 探测 Node 插件是否需要 pnpm install（首次慢，node_modules 已在则 ensure 秒过）。
/// 用于 start_plugin 发「安装依赖」阶段事件。与 ensure_node_dependencies 的「已装跳过」逻辑对齐：
/// 有 package.json + 非空依赖 且 node_modules 缺失 → 需要安装。
fn needs_node_install(plugin_dir: &std::path::Path) -> bool {
    let pkg_json = plugin_dir.join("package.json");
    if !pkg_json.is_file() {
        return false;
    }
    if plugin_dir.join("node_modules").is_dir() {
        return false;
    }
    // 仅当声明了非空依赖才真正需要 install（与 ensure_node_dependencies 的 has_deps 判定一致）。
    let Ok(raw) = std::fs::read_to_string(&pkg_json) else {
        return false;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return false;
    };
    ["dependencies", "devDependencies"].iter().any(|k| {
        v.get(k)
            .and_then(|x| x.as_object())
            .map(|m| !m.is_empty())
            .unwrap_or(false)
    })
}

/// 确保 Node 插件依赖已安装（PRD 需求 7 / AC8）。
/// 流程：
/// 1. 有 package.json + 非空 dependencies/devDependencies → pnpm install（幂等）。
/// 2. 无 pnpm → 回退 npm install（pnpm 未装时不阻断，降级）。
/// 3. 无 package.json → 返回 Ok（Node 脚本可能裸 index.js 无依赖声明）。
///
/// 失败处理：pnpm/npm install 失败返回友好错误（不崩）。
fn ensure_node_dependencies(plugin_dir: &std::path::Path) -> Result<(), String> {
    let pkg_json = plugin_dir.join("package.json");
    if !pkg_json.is_file() {
        // 无 package.json 视为裸脚本，跳过安装（pnpm start 无意义，但 start_node_process 会据此报错）。
        return Ok(());
    }
    // 解析是否有依赖声明（空 dependencies 不触发 install）。
    let raw =
        std::fs::read_to_string(&pkg_json).map_err(|e| format!("读取 package.json 失败：{e}"))?;
    let v: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("package.json 解析失败：{e}"))?;
    let has_deps = ["dependencies", "devDependencies"].iter().any(|k| {
        v.get(k)
            .and_then(|x| x.as_object())
            .map(|m| !m.is_empty())
            .unwrap_or(false)
    });
    if !has_deps {
        return Ok(());
    }
    // node_modules 存在视为已装（幂等跳过，避免每次 start 重复 install 拖慢）。
    if plugin_dir.join("node_modules").is_dir() {
        return Ok(());
    }
    // 优先 pnpm，回退 npm。
    let (bin, install_args) = if let Some(pnpm) = find_binary("pnpm") {
        (pnpm, vec!["install".to_string()])
    } else if let Some(npm) = find_binary("npm") {
        (npm, vec!["install".to_string()])
    } else {
        return Err("未检测到 pnpm 或 npm（需安装 pnpm：npm i -g pnpm）".to_string());
    };
    // install 可能下载大依赖，给 600s 超时。
    let captured = run_capture_with_env(
        &bin,
        install_args,
        Some(&plugin_dir.to_string_lossy()),
        600_000,
        minimal_env(),
    )
    .map_err(|e| format!("依赖安装失败：{e}"))?;
    if captured.exit_code != Some(0) {
        return Err(format!(
            "依赖安装失败（exit={:?}）：{}",
            captured.exit_code,
            captured.stderr.trim()
        ));
    }
    Ok(())
}

// === 进程表（内存态，供 kill 句柄回收） ===

/// 内存进程表条目：plugin_id → Child 句柄（Arc<Mutex<Option<Child>>> 支持多线程 take/kill）。
/// 复用 code_assistant.rs::processes 的同款结构（Arc<Mutex<HashMap<...>>>）。
///
/// 设计（PRD 需求 2「状态不存 DB」）：运行态仅存内存，不落盘。
/// - 持有 Child 句柄，stop_plugin 经此 kill（必须有句柄才能发信号）。
/// - scan_plugin_status（组A）调 is_running 叠加 running；重启后内存表清空 → 所有插件从文件系统重判 ready。
/// - get_plugin_status 命令直接查本表（try_wait 实时判定，比 scan 更准）。
#[derive(Default)]
pub struct PluginProcessTable {
    /// plugin_id → (Child 句柄, started_at ISO 字符串)。
    inner: Arc<Mutex<HashMap<String, (Arc<Mutex<Option<Child>>>, String)>>>,
}

impl PluginProcessTable {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// 注册新启动的插件进程（若同 plugin_id 已有旧进程，先杀旧再覆盖，避免泄漏）。
    fn register(&self, plugin_id: &str, child: Child, started_at: String) -> u32 {
        let arc = Arc::new(Mutex::new(Some(child)));
        let pid = {
            let guard = arc.lock().unwrap_or_else(|p| p.into_inner());
            guard.as_ref().map(|c| c.id()).unwrap_or(0)
        };
        let mut map = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if let Some((old, _)) = map.insert(plugin_id.to_string(), (arc.clone(), started_at)) {
            // 旧进程残留：take + kill_child_tree 回收（防泄漏）。
            if let Some(mut old_child) = old.lock().unwrap_or_else(|p| p.into_inner()).take() {
                kill_child_tree(&old_child);
                let _ = old_child.wait();
            }
        }
        pid
    }

    /// take 出插件进程（停止时用），返回 (Child, started_at) 或 None。
    fn take(&self, plugin_id: &str) -> Option<(Child, String)> {
        let map = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let (arc, started_at) = map.get(plugin_id).cloned()?;
        let mut guard = arc.lock().unwrap_or_else(|p| p.into_inner());
        guard.take().map(|c| (c, started_at))
    }

    /// 查询插件进程是否仍在运行（不 take，仅 try_wait）。
    /// 进程已自然退出时自动清理表条目（保持表收缩，不堆积死亡记录）。
    ///
    /// pub 供组A scan_plugin_status 合并运行态（组A 扫文件系统判 ready/incomplete/error，
    /// 调本方法叠加 running；跨组集成，见 plugin_store.rs scan_plugin_status 命令）。
    pub fn is_running(&self, plugin_id: &str) -> Option<(u32, String)> {
        let arc_started = {
            let map = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            map.get(plugin_id).cloned()
        };
        let (arc, started_at) = arc_started?;
        let mut guard = arc.lock().unwrap_or_else(|p| p.into_inner());
        match guard.as_mut() {
            Some(child) => match child.try_wait() {
                Ok(None) => Some((child.id(), started_at)),
                Ok(Some(_)) | Err(_) => {
                    // 已退出：take Child 回收 + 清表条目。
                    let _ = guard.take();
                    let mut map = self.inner.lock().unwrap_or_else(|p| p.into_inner());
                    map.remove(plugin_id);
                    None
                }
            },
            None => None,
        }
    }
}

// === Tauri 命令 ===

/// start_plugin 返回值（前端 plugin-status.ts::startPlugin 契约）。
#[derive(Clone, Debug, Serialize)]
pub struct StartPluginResult {
    pub pid: u32,
    pub started_at: String,
}

/// 启动阶段进度事件 payload（emit 到 `plugin:start-progress`，前端渲染分阶段动画）。
/// stage 取值：checking / deps_installing / starting（最终结果由命令返回值交付，不在此事件）。
#[derive(Clone, Debug, Serialize)]
pub struct PluginStartProgress {
    pub plugin_id: String,
    pub stage: String,
    pub message: String,
}

/// get_plugin_status 返回值（扩展契约，供前端判定 running/stopped 刷新）。
#[derive(Clone, Debug, Serialize)]
pub struct PluginProcessStatus {
    pub running: bool,
    pub pid: Option<u32>,
    pub started_at: Option<String>,
}

/// 命令：启动插件作为独立进程（PRD 需求 5/7/9 / AC5）。
///
/// 入参 pluginId：插件目录名（plugins_root/<pluginId>/）。
/// runtime 由 manifest.runtime_type 决定（前端 plugin-status.ts 已据此分流，仅 nodejs/python 进本通道）。
///
/// 流程：
/// 1. resolve_plugin_dir（PluginStore.ensure_plugin_dir：白名单 + canonicalize 前缀断言）。
/// 2. parse_manifest（runtime_type 必须是 nodejs/python）。
/// 3. Python：ensure_python_venv（venv + pip install）；Node：ensure_node_dependencies（pnpm install）。
/// 4. spawn detached（Stdio::null，不捕获 stdout 进 UI；GUI 自己弹窗口）。
/// 5. 注册到内存进程表（供 scan_plugin_status / get_plugin_status 判定 running；不落 DB）。
/// 6. 返回 { pid, started_at }。
///
/// 启动阶段事件（前端据此渲染分阶段进度动画，PRD 体验完善需求）：
/// 每个阶段经 app.emit 发 `plugin:start-progress` 事件，payload = { pluginId, stage, message }：
/// - `checking`：正在检查依赖是否已就绪（venv/node_modules 是否存在）。
/// - `deps_installing`：依赖缺失，正在安装（pip install / pnpm install，可能几十秒）。
/// - `starting`：依赖就绪，正在拉起入口进程。
/// 最终结果仍由命令返回值（Ok=pid / Err=错误）交付，事件仅驱动 UI 进度。
#[tauri::command]
pub fn start_plugin(
    app: tauri::AppHandle,
    store: tauri::State<'_, PluginStore>,
    process_table: tauri::State<'_, PluginProcessTable>,
    plugin_id: String,
) -> Result<StartPluginResult, String> {
    use tauri::Emitter;
    // 阶段事件辅助：emit 失败不阻断启动（UI 无监听者或通道错误时静默降级为同步等待）。
    let emit_stage = |stage: &str, message: &str| {
        let _ = app.emit(
            "plugin:start-progress",
            PluginStartProgress {
                plugin_id: plugin_id.clone(),
                stage: stage.to_string(),
                message: message.to_string(),
            },
        );
    };

    emit_stage("checking", "正在检查插件运行环境…");
    let plugin_dir = resolve_plugin_dir(&store, &plugin_id)?;
    let manifest = parse_manifest(&plugin_dir)?;

    let (binary, args) = match manifest.runtime {
        PluginRuntimeKind::Python => {
            // Python：先探测是否需创建 venv / 装依赖（首次慢，已装则秒过），发对应阶段事件。
            if needs_python_venv(&plugin_dir) {
                emit_stage(
                    "deps_installing",
                    "正在创建 Python 虚拟环境并安装依赖（首次较慢）…",
                );
            }
            // ensure_python_venv：venv 不存在则建 + 有 requirements.txt 则 pip install（幂等）。
            let py = ensure_python_venv(&plugin_dir)?;
            let entry_abs = plugin_dir.join(&manifest.entry);
            if !entry_abs.is_file() {
                return Err(format!("Python 入口文件不存在：{}", entry_abs.display()));
            }
            (
                py,
                vec!["-u".to_string(), entry_abs.to_string_lossy().to_string()],
            )
        }
        PluginRuntimeKind::Nodejs => {
            // Node：先探测是否需 pnpm install（首次慢，node_modules 已在则秒过），发对应阶段事件。
            if needs_node_install(&plugin_dir) {
                emit_stage(
                    "deps_installing",
                    "正在安装 Node 依赖（pnpm install，首次较慢）…",
                );
            }
            // ensure_node_dependencies：有 package.json + 非空依赖且 node_modules 缺失 → pnpm/npm install（幂等）。
            ensure_node_dependencies(&plugin_dir)?;
            let entry_abs = plugin_dir.join(&manifest.entry);
            if !entry_abs.is_file() {
                return Err(format!("Node 入口文件不存在：{}", entry_abs.display()));
            }
            // 有 package.json + scripts.start → pnpm start（或 npm start）；否则裸 node entry。
            if plugin_dir.join("package.json").is_file() {
                if let Some(runner) = find_binary("pnpm").or_else(|| find_binary("npm")) {
                    (runner, vec!["start".to_string()])
                } else {
                    // 无 pnpm/npm：回退 node entry（package.json 可能仅声明元信息无 start）。
                    let node =
                        find_binary("node").ok_or_else(|| "未检测到 Node.js 运行时".to_string())?;
                    (node, vec![entry_abs.to_string_lossy().to_string()])
                }
            } else {
                let node =
                    find_binary("node").ok_or_else(|| "未检测到 Node.js 运行时".to_string())?;
                (node, vec![entry_abs.to_string_lossy().to_string()])
            }
        }
    };

    // 依赖就绪，即将 spawn 入口进程 → 发 starting 阶段（前端切换到「启动中」动画）。
    emit_stage("starting", "正在启动插件进程…");
    // detached spawn：stdout null（GUI 输出不进 UI，PRD 需求 9），stderr piped（捕获崩溃异常）。
    // 子进程 cwd = 插件目录（让插件能读写自身 data/ 子目录等相对路径）。
    let mut command = std::process::Command::new(&binary);
    command
        .current_dir(&plugin_dir)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    // env_clear + 白名单：避免泄漏宿主 token/密钥到插件进程（与 plugin_script.rs 同语义）。
    command.env_clear().envs(minimal_env());
    // Unix：setsid 建独立进程组（detached，stop_plugin 杀整组）。
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            command.pre_exec(|| {
                libc_setsid();
                Ok(())
            });
        }
    }
    // Windows：CREATE_NEW_PROCESS_GROUP（detached + stop_plugin 的 taskkill /T 波及整组）。
    // 注意：**不**叠加 CREATE_NO_WINDOW —— GUI 插件（PySide6/Tkinter）需要能弹窗口，
    // CREATE_NO_WINDOW 会抑制控制台窗口但不影响 GUI 窗口；但为安全起见对 Python/Node 这种
    // 可能含 GUI 的进程保留控制台弹出能力（用户可见插件输出，符合「外部窗口」语义）。
    // 仅设 CREATE_NEW_PROCESS_GROUP 让进程组隔离（kill 整组）。
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        command.creation_flags(CREATE_NEW_PROCESS_GROUP);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("启动插件进程失败：{e}"))?;
    // 秒退判定：spawn 后短等待（800ms），若进程立即退出 = 崩溃，读 stderr 返回 plugin_crashed 错误。
    // 正常 GUI 插件会一直运行（超时即放行）。捕获 stderr 让用户看到 Python/Node 异常而非「无法启动」。
    if let Some(crash_err) = wait_for_crash(&mut child, Duration::from_millis(800)) {
        // 崩溃：进程已退出，child drop 回收。返回 plugin_crashed: 前缀（前端 catch 显示 stderr + 一键修复）。
        return Err(crash_err);
    }
    // 存活 = 正常运行：stderr pipe 交后台线程排空（防 pipe 满阻塞进程），读后丢弃不进 UI。
    if let Some(mut stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            use std::io::Read;
            let mut buf = [0u8; 1024];
            loop {
                match stderr.read(&mut buf) {
                    Ok(0) | Err(_) => break, // 进程退出或 pipe 关闭
                    _ => { /* 丢弃，不进 UI */ }
                }
            }
        });
    }
    let started_at = now_iso();
    let pid = process_table.register(&plugin_id, child, started_at.clone());
    // 运行态仅存内存进程表（组A scan_plugin_status 经 process_table.is_running 合并判定 running，
    // 不落 DB——PRD 需求 2「状态不存 DB」，重启后所有插件从文件系统重判 ready）。
    Ok(StartPluginResult { pid, started_at })
}

/// spawn 后短等待判定进程是否秒退（崩溃）。
/// - 退出 = 崩溃：读 stderr 全部内容，返回 `plugin_crashed:<status>\n<stderr 摘要>` 前缀错误。
/// - 存活（超时未退）= 正常运行：返回 None（调用方继续注册进程表）。
///
/// 抽成纯函数便于单测（不依赖 tauri::State）。try_wait 轮询（非 wait 阻塞）避免阻塞 start_plugin 命令。
pub(crate) fn wait_for_crash(child: &mut std::process::Child, timeout: Duration) -> Option<String> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                // 进程已退出 = 崩溃，读 stderr。
                let stderr_text = child
                    .stderr
                    .take()
                    .and_then(|mut s| {
                        use std::io::Read;
                        let mut buf = String::new();
                        s.read_to_string(&mut buf).ok().map(|_| buf)
                    })
                    .unwrap_or_default();
                let truncated = truncate_stderr(&stderr_text, 2000);
                return Some(format!(
                    "plugin_crashed:插件启动后立即退出（{status}）\n{truncated}"
                ));
            }
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    return None; // 存活超时 = 正常运行
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return None, // try_wait 异常，保守当正常运行（不误报崩溃）
        }
    }
}

/// 截断 stderr 到 max_chars 字符（超长加尾标），避免错误信息过长。
fn truncate_stderr(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        return s.to_string();
    }
    let truncated: String = s.chars().take(max_chars).collect();
    format!(
        "{truncated}\n…(stderr 已截断，共 {} 字符)",
        s.chars().count()
    )
}

/// 命令：停止插件独立进程（PRD AC5：可强制关闭）。
/// 从内存进程表 take Child → kill_child_tree（进程组/树 kill）→ wait 回收句柄。
/// 进程表内存态：take 后条目即清，scan_plugin_status 不再判 running。
/// 进程不存在（已退出/未启动）幂等返回，不报错（与 code_assistant::stop_session 同语义）。
#[tauri::command]
pub fn stop_plugin(
    process_table: tauri::State<'_, PluginProcessTable>,
    plugin_id: String,
) -> Result<(), String> {
    if let Some((mut child, _started_at)) = process_table.take(&plugin_id) {
        // kill_child_tree 发进程组/树 kill 信号（不 wait），这里补 wait 回收 Child 句柄。
        kill_child_tree(&child);
        let _ = child.kill();
        let _ = child.wait();
    }
    // 幂等：进程不存在直接 Ok（用户「停止一个已结束的插件」应成功）。
    Ok(())
}

/// 命令：删除本地持久化插件目录（temp 草稿 / 正式本地插件）。
///
/// 流程：sanitize_plugin_id 防穿越 → 若进程表在运行先 stop（take + kill_child_tree + wait，
/// 防文件占用删不掉）→ remove_dir_all(plugin_dir)。
///
/// 仅删 `plugins_root/<plugin_id>/`。builtin 内置插件在 builtin-plugins/（resources 打包），
/// 不在 plugins_root，sanitize + plugin_dir 不会定位到——天然不删。
/// 不删云端记录（后端独立 DELETE 端点）；目录不存在幂等 Ok（与 stop_plugin 同语义）。
#[tauri::command]
pub fn delete_plugin(
    store: tauri::State<'_, PluginStore>,
    process_table: tauri::State<'_, PluginProcessTable>,
    plugin_id: String,
) -> Result<(), String> {
    delete_plugin_dir(&store, &process_table, &plugin_id)
}

/// delete_plugin 的纯逻辑（无 tauri::State，便于单测）。
/// sanitize → take+kill 进程 → remove_dir_all 目录。
pub(crate) fn delete_plugin_dir(
    store: &PluginStore,
    process_table: &PluginProcessTable,
    plugin_id: &str,
) -> Result<(), String> {
    let id = sanitize_plugin_id(plugin_id)?;
    // 先停进程（防 venv / node_modules 文件占用删不掉）。
    if let Some((mut child, _)) = process_table.take(&id) {
        kill_child_tree(&child);
        let _ = child.kill();
        let _ = child.wait();
    }
    let dir = store.plugin_dir(&id)?;
    if !dir.exists() {
        return Ok(()); // 目录不存在幂等成功（云端已删 / 手动清过）。
    }
    // 删目录：venv / node_modules 含大量 exe/pyd/dll，Windows 上 remove_dir_all 常因
    // 杀软实时扫描锁 / 文件句柄短暂残留 / 只读属性失败（os error 5 拒绝访问）。
    // 重试 3 次（间隔 300ms 等句柄释放 / AV 扫完），仍失败则 Windows 降级 rmdir /s /q（强制删）。
    remove_dir_all_with_retry(&dir)
}

/// 带重试 + Windows rmdir 降级的目录删除（venv/node_modules 在 Windows 删除不可靠）。
fn remove_dir_all_with_retry(dir: &std::path::Path) -> Result<(), String> {
    // 先尝试 std::fs::remove_dir_all，重试 3 次（间隔 300ms）。
    let mut last_err = None;
    for attempt in 0..3 {
        match std::fs::remove_dir_all(dir) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last_err = Some(e);
                if attempt < 2 {
                    std::thread::sleep(Duration::from_millis(300));
                }
            }
        }
    }
    // Windows 降级：cmd /c rmdir /s /q（强制删，对 AV 锁/只读更鲁棒）。
    #[cfg(windows)]
    {
        let status = std::process::Command::new("cmd")
            .args(["/c", "rmdir", "/s", "/q"])
            .arg(dir)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        if let Ok(s) = status {
            if s.success() {
                return Ok(());
            }
        }
    }
    Err(format!(
        "删除插件目录失败：{}（可能是杀软锁定或文件占用，请关闭杀软实时保护或手动删除：{}）",
        last_err.map(|e| e.to_string()).unwrap_or_default(),
        dir.display()
    ))
}

/// 命令：查询插件进程运行状态（PRD 需求 2 / AC2：running/stopped 动态判定）。
/// 查内存进程表（try_wait 实时判定，比 scan 读磁盘表更准），进程已退出时自动清表。
#[tauri::command]
pub fn get_plugin_status(
    process_table: tauri::State<'_, PluginProcessTable>,
    plugin_id: String,
) -> Result<PluginProcessStatus, String> {
    match process_table.is_running(&plugin_id) {
        Some((pid, started_at)) => Ok(PluginProcessStatus {
            running: true,
            pid: Some(pid),
            started_at: Some(started_at),
        }),
        None => Ok(PluginProcessStatus {
            running: false,
            pid: None,
            started_at: None,
        }),
    }
}

// === 辅助 ===

/// Unix setsid（建独立进程组，detached）。
/// 与 code_assistant.rs::libc_setsid 同语义，独立实现保持模块自洽。
#[cfg(unix)]
fn libc_setsid() {
    extern "C" {
        fn setsid() -> i32;
    }
    unsafe {
        let _ = setsid();
    }
}

/// ISO 时间戳（与 code_assistant::store::now_string 同格式：epoch 秒.毫秒Z）。
/// 供进程表 started_at 记录 + 前端展示，scan_plugin_status 合并 running 态时透传。
fn now_iso() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}.{:03}Z", now.as_secs(), now.subsec_millis())
}

// === 单元测试 ===
// 覆盖：venv/pip 路径平台正确性、manifest 解析、minimal_env 安全、进程表 register/take/is_running。
// 不测实际 venv/pnpm 执行（依赖宿主环境，CI 不可控；start_plugin 集成测试手动验证）。
// 不测 resolve_plugin_dir（走 PluginStore，组A 已覆盖 ensure_plugin_dir 单测）。
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn venv_python_path_is_platform_correct() {
        let venv = PathBuf::from("/tmp/.venv");
        let py = venv_python(&venv);
        #[cfg(windows)]
        assert!(py.to_string_lossy().contains("Scripts"));
        #[cfg(not(windows))]
        assert!(py.ends_with("bin/python"));
    }

    #[test]
    fn venv_pip_path_is_platform_correct() {
        let venv = PathBuf::from("/tmp/.venv");
        let pip = venv_pip(&venv);
        #[cfg(windows)]
        assert!(pip.to_string_lossy().contains("Scripts"));
        #[cfg(not(windows))]
        assert!(pip.ends_with("bin/pip"));
    }

    #[test]
    fn parse_manifest_python_defaults_entry() {
        // manifest 缺 entry 时，python 默认 main.py，nodejs 默认 index.js。
        let tmp = temp_dir_unique("manifest-py");
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(
            tmp.join("manifest.json"),
            r#"{"runtime_type":"python","name":"x"}"#,
        )
        .unwrap();
        let m = parse_manifest(&tmp).expect("解析应成功");
        assert_eq!(m.runtime, PluginRuntimeKind::Python);
        assert_eq!(m.entry, "main.py");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn parse_manifest_nodejs_explicit_entry() {
        let tmp = temp_dir_unique("manifest-node");
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(
            tmp.join("manifest.json"),
            r#"{"runtime_type":"nodejs","entry":"src/index.js"}"#,
        )
        .unwrap();
        let m = parse_manifest(&tmp).expect("解析应成功");
        assert_eq!(m.runtime, PluginRuntimeKind::Nodejs);
        assert_eq!(m.entry, "src/index.js");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn parse_manifest_rejects_client_runtime() {
        // client（HTML）不支持独立进程运行（前端 iframe 分流）。
        let tmp = temp_dir_unique("manifest-client");
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("manifest.json"), r#"{"runtime_type":"client"}"#).unwrap();
        assert!(parse_manifest(&tmp).is_err());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn parse_manifest_rejects_missing_file() {
        let tmp = temp_dir_unique("manifest-missing");
        std::fs::create_dir_all(&tmp).unwrap();
        // 文件不存在返回 manifest_missing: 前缀（前端据此引导重新生成，而非裸 os error 2）。
        let err = parse_manifest(&tmp).unwrap_err();
        assert!(
            err.starts_with("manifest_missing:"),
            "缺 manifest 应返回 manifest_missing 前缀，实际：{err}"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn parse_manifest_rejects_invalid_json() {
        let tmp = temp_dir_unique("manifest-badjson");
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("manifest.json"), "{not valid json").unwrap();
        assert!(parse_manifest(&tmp).is_err());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn minimal_env_excludes_sensitive_keys() {
        // 白名单不应含 TOKEN/KEY/SECRET/LINGFANG_ 前缀（防泄漏）。
        let env = minimal_env();
        let keys: Vec<_> = env
            .iter()
            .map(|(k, _)| k.to_string_lossy().to_string())
            .collect();
        for k in &keys {
            let upper = k.to_uppercase();
            assert!(!upper.contains("TOKEN"), "minimal_env 不应含 TOKEN：{k}");
            assert!(!upper.contains("SECRET"), "minimal_env 不应含 SECRET：{k}");
            assert!(
                !upper.contains("LINGFANG"),
                "minimal_env 不应含 LINGFANG_：{k}"
            );
        }
    }

    #[test]
    fn process_table_register_and_is_running() {
        // 注册一个会立即退出的进程（true/exit 0），验证 is_running 在退出后返回 None 且自动清表。
        let table = PluginProcessTable::new();
        #[cfg(unix)]
        let mut cmd = {
            use std::os::unix::process::CommandExt;
            let mut c = std::process::Command::new("sh");
            c.arg("-c").arg("true");
            unsafe {
                c.pre_exec(|| {
                    libc_setsid();
                    Ok(())
                });
            }
            c
        };
        #[cfg(windows)]
        let mut cmd = {
            use std::os::windows::process::CommandExt;
            let mut c = std::process::Command::new("cmd");
            c.arg("/C").arg("exit 0");
            const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
            c.creation_flags(CREATE_NEW_PROCESS_GROUP);
            c
        };
        cmd.stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let child = cmd.spawn().expect("测试进程应能 spawn");
        let pid = table.register("test-plugin", child, "1000Z".to_string());
        assert!(pid > 0, "注册应返回有效 pid");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while table.is_running("test-plugin").is_some() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(
            table.is_running("test-plugin").is_none(),
            "进程退出后 is_running 应返回 None 并清表"
        );
    }

    #[test]
    fn process_table_stop_plugin_kills_running_process() {
        let _guard = crate::code_assistant::process_tree_test_lock();
        // take + kill_child_tree 应能杀掉一个运行中的长进程。
        let table = PluginProcessTable::new();
        #[cfg(unix)]
        let mut cmd = {
            use std::os::unix::process::CommandExt;
            let mut c = std::process::Command::new("sh");
            c.arg("-c").arg("sleep 30");
            unsafe {
                c.pre_exec(|| {
                    libc_setsid();
                    Ok(())
                });
            }
            c
        };
        #[cfg(windows)]
        let mut cmd = {
            use std::os::windows::process::CommandExt;
            let mut c = std::process::Command::new("cmd");
            c.arg("/C").arg("ping -n 30 127.0.0.1 > nul");
            const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
            c.creation_flags(CREATE_NEW_PROCESS_GROUP);
            c
        };
        cmd.stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let child = cmd.spawn().expect("测试长进程应能 spawn");
        let _pid = table.register("long-plugin", child, "2000Z".to_string());
        // 取出并杀。
        let (mut killed_child, _) = table.take("long-plugin").expect("应能取出注册的进程");
        let started = std::time::Instant::now();
        kill_child_tree(&killed_child);
        let _ = killed_child.kill();
        let _status = killed_child.wait().expect("wait 应能回收");
        const STOP_TEST_TIMEOUT_MS: u128 = 3_000;
        let elapsed = started.elapsed().as_millis();
        assert!(
            elapsed < STOP_TEST_TIMEOUT_MS,
            "停止长进程耗时异常：{elapsed}ms"
        );
        // 二次 take 应 None（已取出）。
        assert!(
            table.take("long-plugin").is_none(),
            "已 take 的进程不应再可取"
        );
    }

    #[test]
    fn process_table_take_nonexistent_returns_none() {
        let table = PluginProcessTable::new();
        assert!(table.take("ghost").is_none());
        assert!(!table.is_running("ghost").is_some());
    }

    /// 生成唯一临时目录名（避免并发测试冲突）。
    fn temp_dir_unique(prefix: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "lf-runner-{prefix}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    // === delete_plugin_dir 测试 ===

    /// 构造临时 PluginStore（anchor_root 在 temp_dir 下，隔离测试）。
    fn temp_store_for_delete(name: &str) -> PluginStore {
        let root = std::env::temp_dir().join(format!(
            "lf-runner-delete-{name}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&root);
        PluginStore::new(&root).expect("PluginStore 构造应成功")
    }

    #[test]
    fn delete_plugin_dir_removes_existing_directory() {
        let store = temp_store_for_delete("existing");
        let id = "my-plugin";
        let dir = store.ensure_plugin_dir(id).unwrap();
        std::fs::write(dir.join("manifest.json"), r#"{"id":"x","name":"x"}"#).unwrap();
        let table = PluginProcessTable::new();

        delete_plugin_dir(&store, &table, id).unwrap();

        assert!(!dir.exists(), "插件目录应被删除");
    }

    #[test]
    fn delete_plugin_dir_nonexistent_is_idempotent() {
        let store = temp_store_for_delete("missing");
        let table = PluginProcessTable::new();
        // 不存在的 plugin_id 删除应幂等成功（不报错）。
        delete_plugin_dir(&store, &table, "never-existed").unwrap();
    }

    #[test]
    fn delete_plugin_dir_rejects_traversal_id() {
        let store = temp_store_for_delete("traversal");
        let table = PluginProcessTable::new();
        // 穿越 plugin_id 被 sanitize_plugin_id 拒绝（防 ../ 越出 plugins_root）。
        let err = delete_plugin_dir(&store, &table, "../escape").unwrap_err();
        assert!(err.contains("plugin_id") || err.contains("非法") || err.contains("不合法"));
    }

    // === wait_for_crash 测试 ===

    #[test]
    fn wait_for_crash_detects_immediate_exit() {
        // 秒退进程：cmd /c exit 1（Windows）/ sh -c "exit 1"（Unix），立即退出。
        let mut cmd = if cfg!(windows) {
            let mut c = std::process::Command::new("cmd");
            c.args(["/c", "exit 1"]).stderr(Stdio::piped());
            c
        } else {
            let mut c = std::process::Command::new("sh");
            c.args(["-c", "exit 1"]).stderr(Stdio::piped());
            c
        };
        let mut child = cmd.spawn().expect("spawn 测试进程应成功");
        let result = wait_for_crash(&mut child, Duration::from_millis(500));
        assert!(result.is_some(), "秒退进程应被检测为崩溃");
        let err = result.unwrap();
        assert!(
            err.starts_with("plugin_crashed:"),
            "崩溃错误应含 plugin_crashed: 前缀"
        );
    }

    #[test]
    fn wait_for_crash_returns_none_for_long_running() {
        let _guard = crate::code_assistant::process_tree_test_lock();
        // 存活进程：sleep 10（不会在 500ms 内退出）。
        let mut cmd = if cfg!(windows) {
            let mut c = std::process::Command::new("cmd");
            c.args(["/c", "ping -n 10 127.0.0.1 > nul"])
                .stderr(Stdio::piped());
            c
        } else {
            let mut c = std::process::Command::new("sh");
            c.args(["-c", "sleep 10"]).stderr(Stdio::piped());
            c
        };
        let mut child = cmd.spawn().expect("spawn 测试进程应成功");
        let result = wait_for_crash(&mut child, Duration::from_millis(300));
        assert!(result.is_none(), "存活进程不应判为崩溃");
        // 清理测试进程。
        let _ = child.kill();
        let _ = child.wait();
    }

    #[test]
    fn truncate_stderr_long_text_is_cut() {
        let long = "x".repeat(3000);
        let t = truncate_stderr(&long, 100);
        assert!(t.contains("已截断"), "超长 stderr 应截断并标注");
        assert!(t.chars().count() < long.chars().count());
    }
}
