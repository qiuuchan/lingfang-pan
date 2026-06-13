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
///
/// 修复 SCRIPT-05（low 错误处理）：此前 read_dir 失败静默返回空 Vec，
/// parse_manifest 失败（JSON 非法 / 缺 id / 缺 name）也静默跳过，
/// 启动期仅打印总数不报告哪些子目录失败，开发者难定位打包态损坏。
/// 修复：read_dir 失败与单个插件加载失败均打印 eprintln（含目录路径），便于定位。
pub fn load_builtin_plugins(
    base_dir: &PathBuf,
    registry: &CapabilityRegistry,
) -> Vec<LoadedPlugin> {
    let mut result = Vec::new();
    let read = match std::fs::read_dir(base_dir) {
        Ok(r) => r,
        Err(error) => {
            // 修复 SCRIPT-05：打印目录路径与 OS 错误，便于定位内置插件目录缺失/权限问题。
            eprintln!(
                "内置插件目录读取失败（目录 {:?}）：{error}",
                base_dir.to_string_lossy()
            );
            return result;
        }
    };
    for entry in read.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        match parse_manifest(&path) {
            Some((plugin, caps)) => {
                registry.register(&plugin.id, caps);
                result.push(plugin);
            }
            // 修复 SCRIPT-05：parse_manifest 返回 None 表示 manifest 损坏/缺字段，
            // 打印子目录路径便于开发/打包态定位。
            None => {
                eprintln!(
                    "内置插件加载失败（manifest 解析失败，目录 {:?}）",
                    path.to_string_lossy()
                );
            }
        }
    }
    result
}
