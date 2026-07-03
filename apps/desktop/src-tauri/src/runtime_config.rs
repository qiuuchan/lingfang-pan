//! 运行时配置持久化（runtime-config.json）。
//!
//! 真相源在 Rust 侧（前端只读镜像）：记录镜像源选择（mirrors），仅此而已。
//! 内置运行时不需配置（Legacy 兜底自动命中）。
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

/// 运行时配置（整体序列化到 runtime-config.json，camelCase 对齐前端）。
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct RuntimeConfig {
    #[serde(default)]
    pub mirrors: MirrorConfig,
}

/// 配置存储句柄（封装文件路径 + 读写操作）。
pub(crate) struct RuntimeConfigStore {
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

    /// 写入配置（原子替换）。
    pub fn write(&self, config: &RuntimeConfig) -> Result<(), String> {
        write_json(&self.config_path, config)
    }
}

/// 运行时数据根目录（仅镜像源配置需持久化）。
fn runtime_data_root<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> PathBuf {
    if let Some(dir) = std::env::var_os("LINGFANG_RUNTIME_DIR") {
        return PathBuf::from(dir);
    }
    if cfg!(debug_assertions) {
        let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(|p| p.join(".local-runtimes"))
            .unwrap_or_else(|| PathBuf::from(".local-runtimes"));
        return dev;
    }
    let base = dirs::data_local_dir()
        .or_else(|| app.path().app_local_data_dir().ok())
        .unwrap_or_else(std::env::temp_dir);
    base.join("LingFang").join("runtimes")
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(cfg.mirrors.pip_id, "tsinghua");
        assert_eq!(cfg.mirrors.npm_id, "npmmirror");
    }

    #[test]
    fn write_then_read_roundtrip() {
        let path = temp_config_path("roundtrip");
        let store = RuntimeConfigStore::from_path(path.clone());
        let mut cfg = RuntimeConfig::default();
        cfg.mirrors.pip_id = "aliyun".to_string();
        store.write(&cfg).unwrap();
        let read_back = store.read();
        assert_eq!(read_back.mirrors.pip_id, "aliyun");
    }
}
