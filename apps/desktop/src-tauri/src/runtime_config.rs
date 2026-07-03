//! 运行时配置持久化（runtime-config.json）。
//!
//! 真相源在 Rust 侧（前端只读镜像）：记录
//! - 应用下载的便携版运行时登记（app_managed_python / app_managed_node）
//! - 用户手动指定的系统已装运行时路径（user_specified_python / user_specified_node）
//! - 镜像源选择（mirrors）
//! - python-build-standalone 下载加速源（download_mirror_base）
//!
//! 落盘到 `{runtime_data_root}/.lingfang/runtime-config.json`，原子写复用 plugin_store 的 write_json。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::mirror_presets::MirrorConfig;
use crate::plugin_store::{read_json, write_json};

/// 隐藏的运行时元数据子目录名（相对 runtime_data_root）。
const META_DIR: &str = ".lingfang";
const CONFIG_FILE: &str = "runtime-config.json";

/// 应用下载并管理的便携版运行时登记条目。
///
/// `dir` = 直接含主 exe 的目录绝对路径（python.exe / node.exe 在该目录下）。
/// 下载激活时（runtime_download）写入，resolver 解析时校验 exe 仍存在。
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct ManagedEntry {
    pub version: String,
    pub dir: String,
    #[serde(rename = "installedAt")]
    pub installed_at: String,
}

/// 运行时配置（整体序列化到 runtime-config.json，camelCase 对齐前端）。
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct RuntimeConfig {
    #[serde(default, rename = "userSpecifiedPython", alias = "userSpecifiedPython")]
    pub user_specified_python: Option<String>,
    #[serde(default, rename = "userSpecifiedNode", alias = "userSpecifiedNode")]
    pub user_specified_node: Option<String>,
    #[serde(default, rename = "appManagedPython", alias = "appManagedPython")]
    pub app_managed_python: Option<ManagedEntry>,
    #[serde(default, rename = "appManagedNode", alias = "appManagedNode")]
    pub app_managed_node: Option<ManagedEntry>,
    #[serde(default)]
    pub mirrors: MirrorConfig,
    /// python-build-standalone 下载加速源 base（默认 GitHub，国内可配 gh-proxy 类）。
    #[serde(default, rename = "downloadMirrorBase", alias = "downloadMirrorBase")]
    pub download_mirror_base: Option<String>,
}

/// 运行时配置存储：负责 config.json 路径定位 + 读/写。
pub struct RuntimeConfigStore {
    config_path: PathBuf,
}

impl RuntimeConfigStore {
    /// 从 AppHandle 定位 config 路径（确保 META_DIR 存在）。
    pub fn from_app<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<Self, String> {
        let root = runtime_data_root(app);
        std::fs::create_dir_all(root.join(META_DIR))
            .map_err(|e| format!("创建运行时配置目录失败：{e}"))?;
        Ok(Self {
            config_path: root.join(META_DIR).join(CONFIG_FILE),
        })
    }

    /// 测试构造：直接指定 config 路径。
    #[cfg(test)]
    pub fn from_path(config_path: PathBuf) -> Self {
        Self { config_path }
    }

    /// 读取配置（文件缺失/解析失败返回 default，不报错）。
    pub fn read(&self) -> RuntimeConfig {
        read_json(&self.config_path).unwrap_or_default()
    }

    /// 写入配置（原子替换）。Step 3 暴露 set_mirror_config / set_user_specified 命令时使用。
    #[allow(dead_code)]
    pub fn write(&self, config: &RuntimeConfig) -> Result<(), String> {
        write_json(&self.config_path, config)
    }

    /// config 文件路径（供测试 / UI 展示）。
    #[allow(dead_code)]
    pub fn config_path(&self) -> &std::path::Path {
        &self.config_path
    }
}

/// 运行时数据根目录（存放 config + 下载的 portable 运行时）。
///
/// 优先级：
/// 1. `LINGFANG_RUNTIME_DIR` 环境变量（dev / 测试覆盖）。
/// 2. dev 构建（`cfg(debug_assertions)`）：源码同级的 `apps/desktop/.local-runtimes/`
///    （CARGO_MANIFEST_DIR 的上一级），该目录 gitignore，开发者首次跑 dev 时由下载管线填充。
/// 3. 生产构建：`%LOCALAPPDATA%/LingFang/runtimes/`（currentUser，无 UAC）。
pub(crate) fn runtime_data_root<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> PathBuf {
    if let Some(dir) = std::env::var_os("LINGFANG_RUNTIME_DIR") {
        return PathBuf::from(dir);
    }
    if cfg!(debug_assertions) {
        // CARGO_MANIFEST_DIR = apps/desktop/src-tauri，parent = apps/desktop。
        let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(|p| p.join(".local-runtimes"))
            .unwrap_or_else(|| PathBuf::from(".local-runtimes"));
        return dev;
    }
    // 生产：%LOCALAPPDATA%/LingFang/runtimes
    let base = dirs::data_local_dir()
        .or_else(|| app.path().app_local_data_dir().ok())
        .unwrap_or_else(std::env::temp_dir);
    base.join("LingFang").join("runtimes")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn temp_config_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "lf-runtime-config-{name}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("runtime-config.json")
    }

    #[test]
    fn read_returns_default_when_missing() {
        let store = RuntimeConfigStore::from_path(temp_config_path("missing"));
        let cfg = store.read();
        assert!(cfg.user_specified_python.is_none());
        assert!(cfg.app_managed_node.is_none());
        // 默认镜像 = 清华 / npmmirror
        assert_eq!(cfg.mirrors.pip_id, "tsinghua");
        assert_eq!(cfg.mirrors.npm_id, "npmmirror");
    }

    #[test]
    fn write_then_read_roundtrip() {
        let path = temp_config_path("roundtrip");
        let store = RuntimeConfigStore::from_path(path.clone());
        let mut cfg = RuntimeConfig::default();
        cfg.app_managed_python = Some(ManagedEntry {
            version: "3.12.13".to_string(),
            dir: "/runtimes/python-3.12".to_string(),
            installed_at: "2026-07-03T00:00:00Z".to_string(),
        });
        store.write(&cfg).unwrap();
        assert!(Path::new(&path).is_file());
        let read_back = store.read();
        let py = read_back.app_managed_python.expect("应读到 python 登记");
        assert_eq!(py.version, "3.12.13");
        assert_eq!(py.dir, "/runtimes/python-3.12");
    }

    #[test]
    fn read_tolerates_partial_json() {
        let path = temp_config_path("partial");
        std::fs::write(&path, r#"{"userSpecifiedPython":"/usr/local/bin/python"}"#).unwrap();
        let cfg = RuntimeConfigStore::from_path(path).read();
        assert_eq!(
            cfg.user_specified_python.as_deref(),
            Some("/usr/local/bin/python")
        );
        // 缺失字段走 default
        assert!(cfg.app_managed_python.is_none());
        assert_eq!(cfg.mirrors.pip_id, "tsinghua");
    }
}
