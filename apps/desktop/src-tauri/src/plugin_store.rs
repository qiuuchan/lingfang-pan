//! 插件持久化目录管理（task 06-16-plugin-system-rebuild 组A）。
//!
//! 新架构下插件文件不再写入临时 sandbox，而是持久化在可配置的插件根目录下：
//! `<plugins_root>/<plugin_id>/`，每个插件独立文件夹，重启软件后仍在。
//!
//! 本模块职责（组A 范围）：
//! - `PluginStore`：插件根目录配置读写（app_data/plugins/.lingfang/config.json，原子写）+ 目录定位。
//! - `get_plugins_root` / `set_plugins_root` / `read_local_plugin_file` 命令。
//! - `scan_plugin_status` 命令：扫描 plugins_root 下全部子目录，解析 manifest.json 判定
//!   动态状态（ready/incomplete/error），并合并组B 的 PluginProcessTable 判定 running/stopped 态。
//!   状态不落 DB，每次实时扫描文件系统 + 查询内存进程表（PRD 需求 2 / AC2）。
//!
//! 与组B（plugin_runner.rs）的协作（跨组集成）：
//! - 组B 的 PluginProcessTable 是内存态进程表（plugin_id → Child 句柄），start_plugin/stop_plugin 维护。
//! - 组A 的 scan_plugin_status 查询该内存表判定 running（不存 DB，重启后从文件系统重判 ready）。
//! - 组B 的 start_plugin 复用组A 的 PluginStore.plugins_root() 解析插件目录（组B 注释明确邀请替换其占位实现）。
//!
//! 目录布局（PRD 需求 6）：
//! ```text
//! app_data/plugins/                      ← plugins_root（默认；设置页可配置）
//! ├── .lingfang/                         ← PluginStore 配置（隐藏，扫描跳过）
//! │   └── config.json                    ← pluginsRootPath 用户自定义路径
//! ├── <plugin_id>/                       ← 各插件独立文件夹
//! │   ├── manifest.json
//! │   ├── main.py / index.js / ui/index.html
//! │   ├── .venv/                         ← Python venv（组B 创建）
//! │   ├── data/                          ← 运行数据持久化（PRD 需求 4）
//! │   └── node_modules/                  ← Node 依赖（组B pnpm install）
//! └── ...
//! ```
//!
//! 安全：plugin_id 走段级白名单（[A-Za-z0-9_-]，与 plugin_script/plugin_runner 同款），
//! canonicalize 前缀断言防路径穿越，扫描跳过隐藏目录（.lingfang 等）与非白名单目录名。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;

// 容忍 std::sync::Mutex poison（与 code_assistant::lock_or_recover 同款策略）：
// poison 后 unwrap 二次 panic 会令整个插件目录子系统永久不可用。into_inner 拿到的数据仍有效。
fn lock_or_recover<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

/// 隐藏的 PluginStore 元数据子目录名（相对 plugins_root）。
///
/// 存放 config.json（用户自定义路径）+ runtime/（预留）。以 `.` 开头确保 scan 时被
/// sanitize_plugin_id 拒绝（隐藏段）从而跳过，不误判为插件目录。
const META_DIR: &str = ".lingfang";

/// 插件根目录配置（plugins_root 路径，None = 用默认 app_data/plugins/）。
///
/// 落盘到 plugins_root/.lingfang/config.json。default 保证旧配置缺失时不报错。
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct PluginStoreConfig {
    /// 用户自定义的插件根目录绝对路径。None 表示使用默认 app_data/plugins/（首次启动）。
    /// trim 后空串视同 None（防止脏值）。
    #[serde(default, alias = "pluginsRootPath", rename = "pluginsRootPath")]
    pub plugins_root_path: Option<String>,
}

/// 插件动态状态（PRD 需求 2 / AC2）。
///
/// serde lowercase 对齐前端 PluginStatus 联合类型字面量（ready/incomplete/error/running/stopped）。
/// - ready/incomplete/error：由文件系统扫描判定（manifest + 入口文件）。
/// - running/stopped：由组B PluginProcessTable 内存进程表判定。
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PluginStatus {
    /// 有完整入口文件 + manifest（可运行/可打开）。
    Ready,
    /// 缺入口文件或 manifest（AI 生成中断或部分产出）。
    #[default]
    Incomplete,
    /// manifest 解析失败（JSON 非法 / 缺 id|name）。
    Error,
    /// 插件正作为独立进程运行（仅 Python/Node；HTML 无进程概念，永不为此态）。
    Running,
    /// 插件进程已停止（仅 Python/Node 历史；重启软件后从 ready 起算）。
    Stopped,
}

/// 插件运行时类型（与契约 RuntimeType 子集对齐：客户端 HTML / Node.js / Python）。
///
/// serde lowercase 对齐前端 PluginRuntime。未知/缺失值兜底为 client（HTML iframe）。
/// cloud 不在桌面本地运行范围，扫描时归一为 client（前端不会对本地 cloud 插件展示运行按钮）。
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PluginRuntime {
    #[default]
    Client,
    Nodejs,
    Python,
}

/// 单个插件的状态扫描结果（scan_plugin_status 返回项，snake_case 对齐前端 LocalPluginStatus）。
///
/// id = 插件目录名（持久化 plugin_id），name = 用户命名（manifest.title，缺失回退 manifest.name，再缺失回退 id）。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct PluginMeta {
    /// 插件目录名（plugin_id，与持久化目录 plugins_root/<id>/ 对应）。
    pub id: String,
    /// 插件展示名（用户命名，来源 manifest.title，缺失回退 manifest.name，再缺失回退 id）。
    pub name: String,
    /// 动态状态（文件系统扫描 + 组B 进程表合并判定，见 PluginStatus）。
    pub status: PluginStatus,
    /// 运行时类型（从 manifest.runtime_type 解析，缺失/未知视为 client）。
    pub runtime: PluginRuntime,
    /// manifest 的 entry 字段（client=ui/index.html / nodejs=index.js / python=main.py）。
    pub entry: String,
    /// 插件描述（manifest.description，缺失为空串）。
    pub description: String,
    /// 插件版本（manifest.version，缺失为 '0.0.0'）。
    pub version: String,
    /// 运行进程 pid（仅 status==='running' 时有意义；其余为 None）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    /// 启动时间 ISO 字符串（仅 running/stopped 态有值）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    /// 状态诊断说明（缺文件/解析失败的具体原因，便于 UI 展示 incomplete/error 的修复引导）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// 插件目录存储：负责配置读写 + 目录定位 + 状态扫描。
///
/// 与 code_assistant::AssistantStore 同款：内嵌 Mutex 串行化所有读-改-写（config.json），
/// Arc 共享支持 Clone 进 tauri::State。原子写用 tmp+rename（同 code_assistant::store）。
#[derive(Clone, Debug)]
pub struct PluginStore {
    /// app_data_dir/plugins（默认 plugins_root + 元数据目录均在此）。
    ///
    /// 注意：用户可在设置页把 pluginsRootPath 改为任意路径，此时插件落在自定义路径下，
    /// 但 PluginStore 的元数据（config.json）始终落在 app_data_dir/plugins/.lingfang/（固定锚点），
    /// 否则改了 plugins_root 后就找不到 config.json 自身（鸡生蛋问题）。
    anchor_root: PathBuf,
    file_lock: Arc<Mutex<()>>,
}

impl PluginStore {
    /// 构造存储：创建 anchor_root（app_data_dir/plugins）+ 默认 plugins_root（app_data/plugins）。
    /// 失败返回字符串错误（启动期调用）。
    pub fn new(app_data_dir: &Path) -> Result<Self, String> {
        let anchor_root = app_data_dir.join("plugins");
        fs::create_dir_all(&anchor_root).map_err(|e| format!("创建插件目录失败：{e}"))?;
        // 元数据目录（.lingfang/config.json）固定锚点：不随 plugins_root 自定义路径变，
        // 否则改了 plugins_root 后找不到 config 自身。plugins_root 默认即 anchor_root。
        fs::create_dir_all(anchor_root.join(META_DIR))
            .map_err(|e| format!("创建插件元数据目录失败：{e}"))?;
        Ok(Self {
            anchor_root,
            file_lock: Arc::new(Mutex::new(())),
        })
    }

    /// 配置文件路径（固定锚点：app_data/plugins/.lingfang/config.json）。
    ///
    /// 不随 plugins_root 自定义路径变（否则改了 plugins_root 后找不到 config 自身）。
    fn config_path(&self) -> PathBuf {
        self.anchor_root.join(META_DIR).join("config.json")
    }

    /// 读取配置（文件缺失或解析失败返回 default，不报错）。
    pub fn read_config(&self) -> PluginStoreConfig {
        read_json(&self.config_path()).unwrap_or_default()
    }

    /// 写入配置（原子替换，锁内串行化）。
    pub fn write_config(&self, config: &PluginStoreConfig) -> Result<(), String> {
        let _guard = lock_or_recover(&self.file_lock);
        write_json(&self.config_path(), config)
    }

    /// 插件根目录（plugins_root）：用户自定义优先，否则默认 app_data/plugins/（与组B + 前端契约一致）。
    ///
    /// 返回未规范化的路径（调用方按需 canonicalize）。配置脏值（空串）归一为默认。
    pub fn plugins_root(&self) -> PathBuf {
        let cfg = self.read_config();
        match cfg
            .plugins_root_path
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            Some(custom) => PathBuf::from(custom),
            None => self.anchor_root.clone(),
        }
    }

    /// 单个插件目录：plugins_root/<plugin_id>/。plugin_id 走段级白名单校验防路径穿越。
    pub fn plugin_dir(&self, plugin_id: &str) -> Result<PathBuf, String> {
        let safe_id = sanitize_plugin_id(plugin_id)?;
        Ok(self.plugins_root().join(safe_id))
    }

    /// 确保插件目录存在（不存在则 create_dir_all）。返回规范化的插件目录绝对路径。
    pub fn ensure_plugin_dir(&self, plugin_id: &str) -> Result<PathBuf, String> {
        let dir = self.plugin_dir(plugin_id)?;
        fs::create_dir_all(&dir).map_err(|e| format!("创建插件目录失败：{e}"))?;
        dir.canonicalize()
            .map_err(|e| format!("插件目录无法访问：{e}"))
    }

    /// 扫描 plugins_root 下全部子目录，产出每个插件的 PluginMeta（PRD 需求 2 / AC2）。
    ///
    /// 仅判定文件系统状态（ready/incomplete/error）；running/stopped 由 scan_plugin_status
    /// 命令层合并组B PluginProcessTable（本方法不查进程表，保持纯文件系统逻辑便于单测）。
    ///
    /// 流程：
    /// 1. plugins_root 不存在或读取失败 → 返回空 Vec（前端降级为空状态引导，不报错）。
    /// 2. 每个子目录：目录名通过 sanitize_plugin_id（跳过 .lingfang 等隐藏目录 + 非白名单目录名）。
    /// 3. 解析 manifest.json 判定 ready/incomplete/error（scan_one_plugin）。
    /// 4. 按 name（缺失按 id）字典序排序（前端列表稳定）。
    pub fn list_plugins(&self) -> Vec<PluginMeta> {
        let root = self.plugins_root();
        let entries = match fs::read_dir(&root) {
            Ok(r) => r,
            Err(_) => return Vec::new(),
        };
        let mut metas: Vec<PluginMeta> = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            // 目录名作为 plugin_id（仅处理通过 sanitize 的合法目录名，跳过 .lingfang 等隐藏目录）。
            let dir_name = match path.file_name().and_then(|n| n.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            if sanitize_plugin_id(&dir_name).is_err() {
                // 隐藏目录（.lingfang）/含非法字符目录名：跳过，避免误解析。
                continue;
            }
            metas.push(scan_one_plugin(&path, &dir_name));
        }
        // 排序：name 优先，缺失按 id，稳定字典序。
        metas.sort_by_key(sort_key);
        metas
    }

    /// 读取插件目录下指定文件内容（read_local_plugin_file 命令底层）。
    ///
    /// 防路径穿越：canonicalize 目标后断言以插件目录为前缀（与 main.rs read_plugin_file 同款）。
    /// 二进制文件（非 UTF-8）读失败返回错误（前端按需处理）。
    pub fn read_plugin_file(&self, plugin_id: &str, file: &str) -> Result<String, String> {
        let dir = self.plugin_dir(plugin_id)?;
        let base = dir
            .canonicalize()
            .map_err(|e| format!("插件目录不存在：{e}"))?;
        let target = base.join(file).canonicalize().map_err(|e| format!("文件不存在：{e}"))?;
        if !target.starts_with(&base) {
            return Err("非法文件路径".to_string());
        }
        fs::read_to_string(&target).map_err(|e| format!("读取文件失败：{e}"))
    }
}

/// 扫描单个插件目录，判定 ready/incomplete/error（不含运行态，由命令层合并组B 进程表）。
///
/// 判定规则（PRD 需求 2）：
/// - manifest.json 不存在 → incomplete（detail 说明缺 manifest）。
/// - manifest.json 存在但 JSON 解析失败 → error（detail 说明解析错误）。
/// - manifest 解析成功但缺 id 或 name → error（detail 说明缺字段）。
/// - manifest 合法但入口文件不存在 → incomplete（detail 说明缺 entry）。
/// - manifest 合法且入口存在 → ready。
fn scan_one_plugin(dir: &Path, plugin_id: &str) -> PluginMeta {
    let manifest_path = dir.join("manifest.json");
    let raw = match fs::read_to_string(&manifest_path) {
        Ok(s) => s,
        Err(_) => {
            return PluginMeta {
                id: plugin_id.to_string(),
                name: plugin_id.to_string(),
                status: PluginStatus::Incomplete,
                runtime: PluginRuntime::Client,
                entry: String::new(),
                description: String::new(),
                version: "0.0.0".to_string(),
                pid: None,
                started_at: None,
                detail: Some("缺少 manifest.json（AI 生成未完成）".to_string()),
            };
        }
    };
    let v: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            return PluginMeta {
                id: plugin_id.to_string(),
                name: plugin_id.to_string(),
                status: PluginStatus::Error,
                runtime: PluginRuntime::Client,
                entry: String::new(),
                description: String::new(),
                version: "0.0.0".to_string(),
                pid: None,
                started_at: None,
                detail: Some(format!("manifest.json 解析失败：{e}")),
            };
        }
    };
    // 缺 id 或 name → error（与 plugins.rs parse_manifest 同款强约束）。
    let id = v.get("id").and_then(|x| x.as_str()).unwrap_or(plugin_id);
    let name_field = v.get("name").and_then(|x| x.as_str());
    if v.get("id").and_then(|x| x.as_str()).is_none() || name_field.is_none() {
        return PluginMeta {
            id: id.to_string(),
            name: name_field.unwrap_or(plugin_id).to_string(),
            status: PluginStatus::Error,
            runtime: parse_runtime(v.get("runtime_type")),
            entry: parse_entry(v.get("entry")),
            description: parse_description(v.get("description")),
            version: parse_version(v.get("version")),
            pid: None,
            started_at: None,
            detail: Some("manifest.json 缺少 id 或 name 字段".to_string()),
        };
    }
    // title（用户命名，PRD 需求 1）优先，缺失回退 name（程序标识符），再缺失回退 id（目录名）。
    let name = v
        .get("title")
        .and_then(|x| x.as_str())
        .filter(|s| !s.trim().is_empty())
        .or(name_field)
        .unwrap_or(plugin_id)
        .to_string();
    let entry = parse_entry(v.get("entry"));
    let runtime = parse_runtime(v.get("runtime_type"));
    // 入口文件存在性：manifest 合法但缺入口 → incomplete（与前端 parseStructuredPackage 同款语义）。
    let entry_exists = !entry.is_empty() && dir.join(&entry).exists();
    let (status, detail) = if entry_exists {
        (PluginStatus::Ready, None)
    } else {
        (
            PluginStatus::Incomplete,
            Some(format!("入口文件 {entry} 不存在")),
        )
    };
    PluginMeta {
        id: id.to_string(),
        name,
        status,
        runtime,
        entry,
        description: parse_description(v.get("description")),
        version: parse_version(v.get("version")),
        pid: None,
        started_at: None,
        detail,
    }
}

/// 从 manifest runtime_type 字段解析运行时类型（缺失/未知/cloud 归一为 client）。
fn parse_runtime(value: Option<&Value>) -> PluginRuntime {
    match value.and_then(|v| v.as_str()) {
        Some("nodejs") => PluginRuntime::Nodejs,
        Some("python") => PluginRuntime::Python,
        Some("client") => PluginRuntime::Client,
        // cloud / 未知值：本地无运行概念，归一为 client（前端对本地 cloud 插件不展示运行按钮）。
        _ => PluginRuntime::Client,
    }
}

/// 解析 manifest entry 字段（缺失回退 ui/index.html，与前端 LOCAL_DRAFT_ENTRY 一致）。
fn parse_entry(value: Option<&Value>) -> String {
    value
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "ui/index.html".to_string())
}

/// 解析 manifest description（缺失为空串）。
fn parse_description(value: Option<&Value>) -> String {
    value
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

/// 解析 manifest version（缺失为 '0.0.0'）。
fn parse_version(value: Option<&Value>) -> String {
    value
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("0.0.0")
        .to_string()
}

/// 排序 key：name 优先，缺失按 id（保证稳定字典序，前端列表不抖动）。
fn sort_key(meta: &PluginMeta) -> String {
    let name = meta.name.trim();
    if name.is_empty() {
        meta.id.clone()
    } else {
        name.to_string()
    }
}

/// plugin_id 段级白名单校验（[A-Za-z0-9_-]，与 plugin_script/plugin_runner 同款）。
///
/// 防 plugin_id 含 '../'、'\\'、盘符、空串或隐藏段（. 开头）时越出 plugins_root。
pub fn sanitize_plugin_id(plugin_id: &str) -> Result<String, String> {
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

// === JSON 读写辅助（复用 code_assistant::store 同款原子写策略，避免跨模块依赖） ===

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

/// 原子写 JSON：写到同目录临时文件再 rename 替换（与 code_assistant::store::write_json_atomically 同款）。
///
/// 同目录保证 tmp 与目标在同文件系统（rename 原子语义的前提）。tmp 文件名带 pid + 纳秒时间戳避免并发覆盖。
fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| "目标路径无父目录".to_string())?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let raw = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    let tmp_name = format!(
        ".tmp-{}-{}-{}",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("file"),
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
    );
    let tmp_path = parent.join(&tmp_name);
    if let Err(e) = fs::write(&tmp_path, &raw) {
        let _ = fs::remove_file(&tmp_path);
        return Err(e.to_string());
    }
    if let Err(e) = persist_rename(&tmp_path, path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(e);
    }
    Ok(())
}

/// 跨平台原子 rename（覆盖目标）。与 code_assistant::store::persist_rename 同款实现。
fn persist_rename(from: &Path, to: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        fs::rename(from, to).map_err(|e| e.to_string())
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        // MoveFileExW 带 MOVEFILE_REPLACE_EXISTING (0x1) + MOVEFILE_WRITE_THROUGH (0x8)。
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

// === Tauri 命令（组A 暴露给前端，命令名与 lib/plugin-status.ts 契约对齐） ===

/// 命令：读取插件根目录路径（PRD 需求 6 / AC7）。
///
/// 默认 app_data/plugins/（首次启动自动创建），用户在设置页改过后从 config.json 读取。
/// 返回字符串路径（前端展示 + 传给后续命令）。
#[tauri::command]
pub fn get_plugins_root(state: tauri::State<'_, PluginStore>) -> String {
    state.plugins_root().to_string_lossy().to_string()
}

/// 命令：配置插件根目录路径（PRD AC7）。
///
/// 流程：
/// 1. trim 空串 → 视为恢复默认（写 None 到 config）。
/// 2. 规范化（去尾部斜杠）+ 校验可创建（不存在则 mkdir -p）。
/// 3. 写入 config.json，返回最终生效路径（规范化后，可能与入参不同）。
/// 4. 已有插件迁移：Constraints 末条约定——原路径保留，提示用户手动迁移（此处不自动搬迁，
///    避免大目录移动的 IO 风险与失败回滚复杂度）。
#[tauri::command]
pub fn set_plugins_root(
    state: tauri::State<'_, PluginStore>,
    path: String,
) -> Result<String, String> {
    let trimmed = path.trim();
    // 空串/纯空白 → 恢复默认（config 写 None）。
    let effective = if trimmed.is_empty() {
        None
    } else {
        // 去尾部斜杠（Windows 下同时处理 / 与 \），规范化存储避免配置层路径歧义。
        let normalized = trimmed.trim_end_matches(['/', '\\']).to_string();
        // 校验可创建（不存在则 mkdir -p；存在但非目录则报错）。
        let target = PathBuf::from(&normalized);
        if target.exists() && !target.is_dir() {
            return Err(format!("路径不是目录：{normalized}"));
        }
        fs::create_dir_all(&target).map_err(|e| format!("创建插件根目录失败：{e}"))?;
        Some(normalized)
    };
    let config = PluginStoreConfig {
        plugins_root_path: effective.clone(),
    };
    state.write_config(&config)?;
    // 返回最终生效路径（自定义则规范化后原样，默认则 plugins_root() 计算的默认值）。
    Ok(match effective {
        Some(p) => p,
        None => state.plugins_root().to_string_lossy().to_string(),
    })
}

/// 命令：扫描插件根目录，返回每个插件的动态状态（PRD 需求 2 / AC2）。
///
/// 组A 实现：文件系统扫描判定 ready/incomplete/error，合并组B PluginProcessTable 判定 running。
/// 组B 的 start_plugin/stop_plugin 维护 PluginProcessTable（内存态，重启后清空 → 所有插件回到 ready）。
///
/// 合并逻辑：进程表 is_running 命中 → status=running + pid + started_at；否则保持文件系统状态。
#[tauri::command]
pub fn scan_plugin_status(
    store: tauri::State<'_, PluginStore>,
    process_table: tauri::State<'_, crate::plugin_runner::PluginProcessTable>,
) -> Vec<PluginMeta> {
    let mut metas = store.list_plugins();
    // 合并组B 进程表：内存态判定 running（不存 DB，重启后从文件系统重判 ready，符合 PRD）。
    for meta in metas.iter_mut() {
        if let Some((pid, started_at)) = process_table.is_running(&meta.id) {
            meta.status = PluginStatus::Running;
            meta.pid = Some(pid);
            meta.started_at = Some(started_at);
            // running 态清掉文件系统层的 detail（进程在跑，detail 无意义）。
            meta.detail = None;
        }
    }
    metas
}

/// 命令：读取本地插件 entry 文件内容（PRD 需求 8：HTML 在软件内 iframe 显示）。
///
/// 仅允许读取 plugins_root/<pluginId>/ 下的文件（canonicalize 前缀断言防路径穿越，
/// 与 main.rs read_plugin_file 同款）。返回 UTF-8 文本内容。
#[tauri::command]
pub fn read_local_plugin_file(
    state: tauri::State<'_, PluginStore>,
    plugin_id: String,
    file: String,
) -> Result<String, String> {
    state.read_plugin_file(&plugin_id, &file)
}

/// 流程重构：上传命名时 rename 临时插件目录为正式目录。
/// 安全：old_id 和 new_id 均走 sanitize_plugin_id 白名单 + canonicalize 前缀断言。
#[tauri::command]
pub fn rename_plugin_dir(
    state: tauri::State<'_, PluginStore>,
    old_id: String,
    new_id: String,
) -> Result<String, String> {
    let safe_new = sanitize_plugin_id(&new_id)?;
    let old_dir = state.plugin_dir(&old_id)?;
    let new_dir = state.plugin_dir(&safe_new)?;
    if !old_dir.exists() {
        return Err(format!("原插件目录不存在：{old_id}"));
    }
    if new_dir.exists() {
        return Err(format!("目标插件名已存在：{safe_new}"));
    }
    std::fs::rename(&old_dir, &new_dir).map_err(|e| format!("重命名插件目录失败：{e}"))?;
    Ok(safe_new)
}

// === 单元测试（覆盖 scan 状态判定 + sanitize_plugin_id 防穿越 + 配置读写） ===

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造临时 PluginStore（anchor_root 在 temp_dir 下，隔离测试）。
    fn temp_store(name: &str) -> PluginStore {
        let root = std::env::temp_dir().join(format!(
            "lingfang-plugin-store-{}-{name}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        PluginStore::new(&root).expect("PluginStore 构造应成功")
    }

    #[test]
    fn sanitize_plugin_id_rejects_traversal() {
        // 合法 id 通过。
        assert_eq!(sanitize_plugin_id("my-clock").unwrap(), "my-clock");
        assert_eq!(sanitize_plugin_id("plugin_001").unwrap(), "plugin_001");
        // 路径穿越字符被拒（防 ../ 越出 plugins_root）。
        assert!(sanitize_plugin_id("../escape").is_err());
        assert!(sanitize_plugin_id("a/b").is_err());
        assert!(sanitize_plugin_id("C:\\win").is_err());
        assert!(sanitize_plugin_id("").is_err());
        assert!(sanitize_plugin_id("   ").is_err());
        // 隐藏段（. 开头，如 .lingfang）被拒（scan 据此跳过元数据目录）。
        assert!(sanitize_plugin_id(".lingfang").is_err());
        assert!(sanitize_plugin_id(".env").is_err());
        // 中文目录名被拒（仅允许 ASCII 字母数字下划线短横线）。
        assert!(sanitize_plugin_id("我的插件").is_err());
    }

    #[test]
    fn scan_ready_plugin_has_manifest_and_entry() {
        let store = temp_store("scan-ready");
        let dir = store.plugins_root().join("my-clock");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("manifest.json"),
            r#"{"id":"my-clock","name":"我的时钟","runtime_type":"client","entry":"ui/index.html","version":"1.2.0","description":"一个时钟"}"#,
        ).unwrap();
        fs::create_dir_all(dir.join("ui")).unwrap();
        fs::write(dir.join("ui").join("index.html"), "<p>ok</p>").unwrap();

        let metas = store.list_plugins();
        assert_eq!(metas.len(), 1);
        let m = &metas[0];
        assert_eq!(m.id, "my-clock");
        // title 优先（此处无 title → 回退 name）。
        assert_eq!(m.name, "我的时钟");
        assert_eq!(m.status, PluginStatus::Ready);
        assert_eq!(m.runtime, PluginRuntime::Client);
        assert_eq!(m.entry, "ui/index.html");
        assert_eq!(m.version, "1.2.0");
        assert_eq!(m.description, "一个时钟");
        assert!(m.detail.is_none());
    }

    #[test]
    fn scan_title_takes_priority_over_name() {
        // PRD 需求 1：插件名用户命名，manifest.title 优先于 manifest.name 展示。
        let store = temp_store("scan-title");
        let dir = store.plugins_root().join("plugin-1");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("manifest.json"),
            r#"{"id":"plugin-1","name":"programmatic-id-name","title":"用户命名","entry":"ui/index.html"}"#,
        ).unwrap();
        fs::create_dir_all(dir.join("ui")).unwrap();
        fs::write(dir.join("ui").join("index.html"), "x").unwrap();

        let metas = store.list_plugins();
        assert_eq!(metas[0].name, "用户命名");
    }

    #[test]
    fn scan_incomplete_when_manifest_missing() {
        let store = temp_store("scan-no-manifest");
        let dir = store.plugins_root().join("half-baked");
        fs::create_dir_all(&dir).unwrap();
        // 仅写了 entry 文件，无 manifest.json。
        fs::create_dir_all(dir.join("ui")).unwrap();
        fs::write(dir.join("ui").join("index.html"), "x").unwrap();

        let metas = store.list_plugins();
        assert_eq!(metas.len(), 1);
        assert_eq!(metas[0].status, PluginStatus::Incomplete);
        assert!(metas[0].detail.as_deref().unwrap().contains("manifest"));
    }

    #[test]
    fn scan_incomplete_when_entry_missing() {
        let store = temp_store("scan-no-entry");
        let dir = store.plugins_root().join("no-entry");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("manifest.json"),
            r#"{"id":"no-entry","name":"无入口","entry":"main.py"}"#,
        ).unwrap();
        // 无 main.py。
        let metas = store.list_plugins();
        assert_eq!(metas[0].status, PluginStatus::Incomplete);
        assert!(metas[0].detail.as_deref().unwrap().contains("main.py"));
    }

    #[test]
    fn scan_error_when_manifest_invalid_json() {
        let store = temp_store("scan-bad-json");
        let dir = store.plugins_root().join("bad");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("manifest.json"), "{ not json").unwrap();

        let metas = store.list_plugins();
        assert_eq!(metas[0].status, PluginStatus::Error);
        assert!(metas[0].detail.as_deref().unwrap().contains("解析失败"));
    }

    #[test]
    fn scan_error_when_manifest_missing_id_or_name() {
        let store = temp_store("scan-no-id");
        let dir = store.plugins_root().join("no-id");
        fs::create_dir_all(&dir).unwrap();
        // 缺 name 字段。
        fs::write(dir.join("manifest.json"), r#"{"id":"no-id","entry":"ui/index.html"}"#).unwrap();
        let metas = store.list_plugins();
        assert_eq!(metas[0].status, PluginStatus::Error);
        assert!(metas[0].detail.as_deref().unwrap().contains("id 或 name"));
    }

    #[test]
    fn scan_parses_runtime_types() {
        let store = temp_store("scan-runtime");
        // python 插件。
        let py_dir = store.plugins_root().join("py-plugin");
        fs::create_dir_all(&py_dir).unwrap();
        fs::write(
            py_dir.join("manifest.json"),
            r#"{"id":"py-plugin","name":"Py","runtime_type":"python","entry":"main.py"}"#,
        ).unwrap();
        fs::write(py_dir.join("main.py"), "print(1)").unwrap();
        // nodejs 插件。
        let node_dir = store.plugins_root().join("node-plugin");
        fs::create_dir_all(&node_dir).unwrap();
        fs::write(
            node_dir.join("manifest.json"),
            r#"{"id":"node-plugin","name":"Node","runtime_type":"nodejs","entry":"index.js"}"#,
        ).unwrap();
        fs::write(node_dir.join("index.js"), "console.log(1)").unwrap();
        // cloud 插件（归一为 client）。
        let cloud_dir = store.plugins_root().join("cloud-plugin");
        fs::create_dir_all(&cloud_dir).unwrap();
        fs::write(
            cloud_dir.join("manifest.json"),
            r#"{"id":"cloud-plugin","name":"Cloud","runtime_type":"cloud","entry":"ui/index.html"}"#,
        ).unwrap();
        fs::create_dir_all(cloud_dir.join("ui")).unwrap();
        fs::write(cloud_dir.join("ui").join("index.html"), "x").unwrap();

        let metas = store.list_plugins();
        let by_id = |id: &str| metas.iter().find(|m| m.id == id).unwrap();
        assert_eq!(by_id("py-plugin").runtime, PluginRuntime::Python);
        assert_eq!(by_id("node-plugin").runtime, PluginRuntime::Nodejs);
        // cloud 归一为 client。
        assert_eq!(by_id("cloud-plugin").runtime, PluginRuntime::Client);
    }

    #[test]
    fn scan_skips_hidden_and_invalid_directory_names() {
        let store = temp_store("scan-skip-invalid");
        // .lingfang 元数据目录（PluginStore 构造时已创建）应被跳过。
        // 含空格的目录名应被跳过。
        let dir = store.plugins_root().join("has space");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("manifest.json"), r#"{"id":"x","name":"x"}"#).unwrap();
        let metas = store.list_plugins();
        // 仅 .lingfang 被跳过 + has space 被跳过 → 应为 0 个插件。
        assert!(metas.iter().all(|m| m.id != "has space"));
        assert!(metas.iter().all(|m| m.id != ".lingfang"));
    }

    #[test]
    fn config_roundtrip_custom_root() {
        let store = temp_store("config-roundtrip");
        // 默认 plugins_root = anchor_root（app_data/plugins）。
        assert_eq!(store.plugins_root(), store.anchor_root);
        // 设置自定义路径。
        let custom = std::env::temp_dir().join(format!(
            "lingfang-plugin-custom-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&custom);
        store
            .write_config(&PluginStoreConfig {
                plugins_root_path: Some(custom.to_string_lossy().to_string()),
            })
            .unwrap();
        assert_eq!(store.plugins_root(), custom);
        // 重置为默认（空串 → None）。
        store
            .write_config(&PluginStoreConfig {
                plugins_root_path: None,
            })
            .unwrap();
        assert_eq!(store.plugins_root(), store.anchor_root);
    }

    #[test]
    fn ensure_plugin_dir_creates_and_canonicalizes() {
        let store = temp_store("ensure-dir");
        let canon = store.ensure_plugin_dir("new-plugin").unwrap();
        assert!(canon.is_absolute());
        assert!(canon.exists());
        // 非法 plugin_id 被拒。
        assert!(store.ensure_plugin_dir("../escape").is_err());
    }

    #[test]
    fn read_plugin_file_blocks_traversal() {
        let store = temp_store("read-traversal");
        let canon = store.ensure_plugin_dir("p").unwrap();
        fs::write(canon.join("ui").join("index.html"), "hello").unwrap_or_else(|_| {
            fs::create_dir_all(canon.join("ui")).unwrap();
            fs::write(canon.join("ui").join("index.html"), "hello").unwrap();
        });
        // 合法相对路径读取。
        assert_eq!(
            store.read_plugin_file("p", "ui/index.html").unwrap(),
            "hello"
        );
        // 路径穿越被拒（../ 越出插件目录）。
        assert!(store.read_plugin_file("p", "../../etc/passwd").is_err());
        // 不存在文件报错。
        assert!(store.read_plugin_file("p", "nope.html").is_err());
    }

    #[test]
    fn plugin_status_serializes_lowercase() {
        // serde lowercase 对齐前端 PluginStatus 字面量。
        let ready = serde_json::to_string(&PluginStatus::Ready).unwrap();
        assert_eq!(ready, "\"ready\"");
        let running = serde_json::to_string(&PluginStatus::Running).unwrap();
        assert_eq!(running, "\"running\"");
        let stopped = serde_json::to_string(&PluginStatus::Stopped).unwrap();
        assert_eq!(stopped, "\"stopped\"");
    }

    #[test]
    fn plugin_meta_serializes_snake_case() {
        // 前端 LocalPluginStatus 期望 started_at（snake_case），不是 startedAt。
        let meta = PluginMeta {
            id: "x".into(),
            name: "X".into(),
            status: PluginStatus::Running,
            runtime: PluginRuntime::Python,
            entry: "main.py".into(),
            description: String::new(),
            version: "0.0.0".into(),
            pid: Some(42),
            started_at: Some("123Z".into()),
            detail: None,
        };
        let json = serde_json::to_string(&meta).unwrap();
        assert!(json.contains("\"started_at\""));
        assert!(json.contains("\"status\":\"running\""));
        assert!(json.contains("\"runtime\":\"python\""));
        // detail 为 None 时应跳过（skip_serializing_if）。
        assert!(!json.contains("\"detail\""));
    }
}
