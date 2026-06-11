//! Capability 网关：插件越权能力的三重校验与执行（见 ADR-0004）。
//!
//! 校验链：
//!   1) 插件 manifest 是否声明该 capability（由已加载插件注册表提供）
//!   2) 作用域校验（如 fs.read 的 paths 白名单）
//!   3) 实际执行（fs / system 等真实 OS 操作）
//!
//! 注：M4 之前，插件授权（PluginGrant）由服务端在安装时校验；
//! 桌面壳这一层负责 manifest 声明 + 作用域 + 安全执行。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// 已加载插件的能力注册表：plugin_id -> 声明的 capability 列表。
#[derive(Default)]
pub struct CapabilityRegistry {
    plugins: Mutex<HashMap<String, Vec<DeclaredCapability>>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct DeclaredCapability {
    pub kind: String,
    /// fs.* 的路径白名单（已展开 $HOME 等）。
    #[serde(default)]
    pub paths: Vec<String>,
}

impl CapabilityRegistry {
    pub fn register(&self, plugin_id: &str, caps: Vec<DeclaredCapability>) {
        let mut map = self.plugins.lock().unwrap();
        map.insert(plugin_id.to_string(), caps);
    }

    fn find(&self, plugin_id: &str, kind: &str) -> Option<DeclaredCapability> {
        let map = self.plugins.lock().unwrap();
        map.get(plugin_id)?.iter().find(|c| c.kind == kind).cloned()
    }
}

#[derive(Debug)]
pub enum CapError {
    NotDeclared(String),
    OutOfScope(String),
    Exec(String),
}

impl std::fmt::Display for CapError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CapError::NotDeclared(k) => write!(f, "插件未声明能力: {k}"),
            CapError::OutOfScope(p) => write!(f, "路径超出授权范围: {p}"),
            CapError::Exec(e) => write!(f, "能力执行失败: {e}"),
        }
    }
}

/// 把 manifest 里的相对路径模板（$HOME/Documents 等）展开为绝对路径。
pub fn expand_path(template: &str) -> String {
    if let Some(rest) = template.strip_prefix("$HOME") {
        if let Some(home) = dirs::home_dir() {
            return format!("{}{}", home.to_string_lossy(), rest);
        }
    }
    template.to_string()
}

/// 核心入口：校验 + 执行一次 capability 调用。
pub fn invoke(
    registry: &CapabilityRegistry,
    plugin_id: &str,
    kind: &str,
    args: &Value,
) -> Result<Value, CapError> {
    // 1) manifest 声明校验
    let declared = registry
        .find(plugin_id, kind)
        .ok_or_else(|| CapError::NotDeclared(kind.to_string()))?;

    // 2+3) 按能力类型分派（含作用域校验 + 执行）
    match kind {
        "fs.read" => fs_read(&declared, args),
        "system.info" => Ok(system_info()),
        other => Err(CapError::NotDeclared(other.to_string())),
    }
}

/// fs.read：列目录或读文件，强制路径在 manifest 白名单内。
fn fs_read(declared: &DeclaredCapability, args: &Value) -> Result<Value, CapError> {
    let raw = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| CapError::Exec("缺少 path 参数".to_string()))?;
    let path = canonical_scoped_path(raw, &declared.paths)?;
    let meta = std::fs::metadata(&path).map_err(|e| CapError::Exec(e.to_string()))?;
    if meta.is_dir() {
        let mut entries = Vec::new();
        let read = std::fs::read_dir(&path).map_err(|e| CapError::Exec(e.to_string()))?;
        for entry in read.flatten() {
            let p = entry.path();
            let m = entry.metadata().ok();
            entries.push(json!({
                "name": entry.file_name().to_string_lossy(),
                "path": p.to_string_lossy(),
                "isDirectory": m.as_ref().map(|m| m.is_dir()).unwrap_or(false),
                "size": m.as_ref().map(|m| m.len()).unwrap_or(0),
            }));
        }
        Ok(json!({ "entries": entries }))
    } else {
        let content = std::fs::read_to_string(&path).map_err(|e| CapError::Exec(e.to_string()))?;
        Ok(json!({ "content": content }))
    }
}

fn canonical_scoped_path(raw: &str, prefixes: &[String]) -> Result<PathBuf, CapError> {
    let target = PathBuf::from(expand_path(raw))
        .canonicalize()
        .map_err(|e| CapError::Exec(e.to_string()))?;
    let allowed = prefixes.iter().any(|prefix| {
        PathBuf::from(expand_path(prefix))
            .canonicalize()
            .map(|p| target.starts_with(p))
            .unwrap_or(false)
    });
    if allowed {
        Ok(target)
    } else {
        Err(CapError::OutOfScope(target.to_string_lossy().to_string()))
    }
}

/// system.info：返回系统概况。
fn system_info() -> Value {
    use sysinfo::System;
    let mut sys = System::new_all();
    sys.refresh_all();
    json!({
        "os": System::long_os_version().unwrap_or_else(|| "Unknown".into()),
        "arch": System::cpu_arch().unwrap_or_else(|| std::env::consts::ARCH.into()),
        "hostname": System::host_name().unwrap_or_else(|| "Unknown".into()),
        "cpuCores": sys.cpus().len(),
        "totalMemory": sys.total_memory(),
        "freeMemory": sys.available_memory(),
        "uptime": System::uptime(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_root(name: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "lingfang-capability-test-{}-{name}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn fs_read_rejects_parent_traversal_outside_allowed_prefix() {
        let root = temp_root("parent");
        let allowed = root.join("Documents");
        let sibling = root.join("Secrets");
        fs::create_dir_all(&allowed).unwrap();
        fs::create_dir_all(&sibling).unwrap();
        fs::write(sibling.join("key.txt"), "secret").unwrap();
        let cap = DeclaredCapability {
            kind: "fs.read".to_string(),
            paths: vec![allowed.to_string_lossy().to_string()],
        };
        let request =
            json!({ "path": allowed.join("..").join("Secrets").join("key.txt").to_string_lossy() });

        let err = fs_read(&cap, &request).unwrap_err();

        assert!(matches!(err, CapError::OutOfScope(_)));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn fs_read_rejects_same_prefix_sibling_directory() {
        let root = temp_root("prefix");
        let allowed = root.join("Documents");
        let sibling = root.join("Documents2");
        fs::create_dir_all(&allowed).unwrap();
        fs::create_dir_all(&sibling).unwrap();
        fs::write(sibling.join("note.txt"), "secret").unwrap();
        let cap = DeclaredCapability {
            kind: "fs.read".to_string(),
            paths: vec![allowed.to_string_lossy().to_string()],
        };
        let request = json!({ "path": sibling.join("note.txt").to_string_lossy() });

        let err = fs_read(&cap, &request).unwrap_err();

        assert!(matches!(err, CapError::OutOfScope(_)));
        let _ = fs::remove_dir_all(root);
    }
}
