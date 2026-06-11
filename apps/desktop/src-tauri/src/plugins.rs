//! 内置插件加载器：扫描 builtin-plugins 目录，解析 manifest，注册能力。

use std::path::PathBuf;

use serde::Serialize;
use serde_json::Value;

use crate::capability::{expand_path, CapabilityRegistry, DeclaredCapability};

#[derive(Clone, Debug, Serialize)]
pub struct LoadedPlugin {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub entry: String,
    /// 插件资源目录的绝对路径（用于壳加载 entry HTML）。
    pub dir: String,
    pub builtin: bool,
}

/// 解析单个插件目录的 manifest.json。
fn parse_manifest(dir: &PathBuf) -> Option<(LoadedPlugin, Vec<DeclaredCapability>)> {
    let manifest_path = dir.join("manifest.json");
    let raw = std::fs::read_to_string(&manifest_path).ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;

    let id = v.get("id")?.as_str()?.to_string();
    let name = v.get("name")?.as_str()?.to_string();
    let version = v
        .get("version")
        .and_then(|x| x.as_str())
        .unwrap_or("0.0.0")
        .to_string();
    let description = v
        .get("description")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let entry = v
        .get("entry")
        .and_then(|x| x.as_str())
        .unwrap_or("index.html")
        .to_string();

    // 解析 capabilities，并展开 fs.* 的路径模板。
    let mut caps = Vec::new();
    if let Some(arr) = v.get("capabilities").and_then(|x| x.as_array()) {
        for c in arr {
            let kind = match c.get("kind").and_then(|x| x.as_str()) {
                Some(k) => k.to_string(),
                None => continue,
            };
            let paths = c
                .get("paths")
                .and_then(|x| x.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|p| p.as_str())
                        .map(expand_path)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            caps.push(DeclaredCapability { kind, paths });
        }
    }

    let plugin = LoadedPlugin {
        id,
        name,
        version,
        description,
        entry,
        dir: dir.to_string_lossy().to_string(),
        builtin: true,
    };
    Some((plugin, caps))
}

/// 扫描内置插件目录，注册能力，返回已加载插件列表。
pub fn load_builtin_plugins(
    base_dir: &PathBuf,
    registry: &CapabilityRegistry,
) -> Vec<LoadedPlugin> {
    let mut result = Vec::new();
    let read = match std::fs::read_dir(base_dir) {
        Ok(r) => r,
        Err(_) => return result,
    };
    for entry in read.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if let Some((plugin, caps)) = parse_manifest(&path) {
            registry.register(&plugin.id, caps);
            result.push(plugin);
        }
    }
    result
}
