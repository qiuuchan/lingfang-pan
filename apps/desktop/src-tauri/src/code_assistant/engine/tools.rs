use std::path::{Path, PathBuf};

use serde_json::{json, Value};

pub struct LocalToolExecutor {
    workspace: PathBuf,
}

impl LocalToolExecutor {
    pub fn new(workspace: PathBuf) -> Self {
        Self {
            workspace,
        }
    }

    pub fn list_directory(&self, path: &str) -> Result<Value, String> {
        let target = self.resolve_read_path(path)?;
        let mut entries = Vec::new();
        for entry in std::fs::read_dir(&target).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || name == "node_modules" {
                continue;
            }
            let metadata = entry.metadata().map_err(|error| error.to_string())?;
            entries.push(json!({
                "name": name,
                "kind": if metadata.is_dir() { "directory" } else { "file" },
                "bytes": if metadata.is_file() { metadata.len() } else { 0 },
            }));
        }
        Ok(json!({ "entries": entries }))
    }

    pub fn read_file(&self, path: &str) -> Result<Value, String> {
        let target = self.resolve_read_path(path)?;
        let content = std::fs::read_to_string(&target).map_err(|error| error.to_string())?;
        Ok(json!({ "path": normalize_path(path), "content": content }))
    }

    pub fn write_file(&self, path: &str, content: &str) -> Result<(), String> {
        let target = self.resolve_write_path(path)?;
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        std::fs::write(target, content).map_err(|error| error.to_string())
    }

    pub fn scan_workspace(&self) -> Result<Value, String> {
        let mut files = Vec::new();
        collect_files(&self.workspace, &self.workspace, &mut files, 0)?;
        Ok(json!({ "files": files }))
    }

    pub fn execute(&self, name: &str, arguments: &Value) -> Value {
        match self.try_execute(name, arguments) {
            Ok(value) => json!({ "ok": true, "result": value }),
            Err(error) => json!({ "ok": false, "error": error }),
        }
    }

    fn try_execute(&self, name: &str, arguments: &Value) -> Result<Value, String> {
        match name {
            "list_directory" => self.list_directory(string_arg(arguments, "path")?),
            "read_file" => self.read_file(string_arg(arguments, "path")?),
            "write_file" => {
                self.write_file(
                    string_arg(arguments, "path")?,
                    string_arg(arguments, "content")?,
                )?;
                Ok(json!({ "written": true }))
            }
            "scan_workspace" => self.scan_workspace(),
            other => Err(format!("未知本地工具：{other}")),
        }
    }

    fn resolve_read_path(&self, path: &str) -> Result<PathBuf, String> {
        let rel = sanitize_rel_path(path)?;
        let target = self.workspace.join(rel);
        let canon = target.canonicalize().map_err(|error| error.to_string())?;
        let root = self
            .workspace
            .canonicalize()
            .map_err(|error| error.to_string())?;
        if !canon.starts_with(root) {
            return Err("路径逃逸 workspace".to_string());
        }
        Ok(canon)
    }

    fn resolve_write_path(&self, path: &str) -> Result<PathBuf, String> {
        let rel = sanitize_rel_path(path)?;
        let root = self
            .workspace
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let target = root.join(rel);
        let parent = target
            .parent()
            .ok_or_else(|| "目标路径无父目录".to_string())?;
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let parent_canon = parent.canonicalize().map_err(|error| error.to_string())?;
        if !parent_canon.starts_with(&root) {
            return Err("路径逃逸 workspace".to_string());
        }
        Ok(target)
    }
}

const MAX_SCAN_DEPTH: usize = 24;
const MAX_READ_BYTES: u64 = 256 * 1024;

fn collect_files(root: &Path, current: &Path, out: &mut Vec<Value>, depth: usize) -> Result<(), String> {
    if depth > MAX_SCAN_DEPTH {
        return Ok(());
    }
    for entry in std::fs::read_dir(current).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        let path = entry.path();
        let metadata = entry.metadata().map_err(|error| error.to_string())?;
        if metadata.is_dir() {
            collect_files(root, &path, out, depth + 1)?;
            continue;
        }
        if !metadata.is_file() || metadata.len() > MAX_READ_BYTES {
            continue;
        }
        if let Ok(content) = std::fs::read_to_string(&path) {
            let rel = path
                .strip_prefix(root)
                .map(|value| value.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            out.push(json!({ "path": rel, "content": content }));
        }
    }
    Ok(())
}

fn string_arg<'a>(arguments: &'a Value, key: &str) -> Result<&'a str, String> {
    arguments
        .get(key)
        .and_then(|value| value.as_str())
        .ok_or_else(|| format!("工具参数缺少 {key}"))
}

fn sanitize_rel_path(path: &str) -> Result<PathBuf, String> {
    let normalized = normalize_path(path);
    if normalized.is_empty() {
        return Err("路径不能为空".to_string());
    }
    if normalized.starts_with('/') || normalized.starts_with('~') || is_windows_drive(&normalized) {
        return Err(format!("路径不能是绝对路径：{normalized}"));
    }
    let segments = normalized.split('/').collect::<Vec<_>>();
    if segments
        .iter()
        .any(|segment| segment.is_empty() || *segment == "." || *segment == "..")
    {
        return Err(format!("路径不能包含空段或 ..：{normalized}"));
    }
    if segments.iter().any(|segment| segment.starts_with('.')) {
        return Err(format!("路径不能包含隐藏段：{normalized}"));
    }
    Ok(PathBuf::from(normalized))
}

fn normalize_path(path: &str) -> String {
    path.trim().replace('\\', "/")
}

fn is_windows_drive(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && bytes[2] == b'/'
}

pub fn anthropic_tool_definitions() -> Value {
    json!([
        {
            "name": "list_directory",
            "description": "List files under the plugin workspace.",
            "input_schema": {
                "type": "object",
                "properties": { "path": { "type": "string" } },
                "required": ["path"]
            }
        },
        {
            "name": "read_file",
            "description": "Read a UTF-8 file from the plugin workspace.",
            "input_schema": {
                "type": "object",
                "properties": { "path": { "type": "string" } },
                "required": ["path"]
            }
        },
        {
            "name": "write_file",
            "description": "Write a UTF-8 file inside the plugin workspace.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "content": { "type": "string" }
                },
                "required": ["path", "content"]
            }
        },
        {
            "name": "scan_workspace",
            "description": "Return all small UTF-8 files in the plugin workspace.",
            "input_schema": { "type": "object", "properties": {} }
        }
    ])
}

pub fn openai_tool_definitions() -> Value {
    let tools = anthropic_tool_definitions();
    let Some(items) = tools.as_array() else {
        return json!([]);
    };
    Value::Array(
        items
            .iter()
            .map(|tool| {
                json!({
                    "type": "function",
                    "function": {
                        "name": tool["name"],
                        "description": tool["description"],
                        "parameters": tool["input_schema"],
                    }
                })
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "lingfang-sdk-tools-{}-{name}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn write_file_accepts_relative_workspace_path() {
        let root = workspace("valid-write");
        let tools = LocalToolExecutor::new(root.clone());

        tools.write_file("ui/index.html", "<html></html>").unwrap();

        assert_eq!(
            std::fs::read_to_string(root.join("ui").join("index.html")).unwrap(),
            "<html></html>"
        );
    }

    #[test]
    fn write_file_rejects_absolute_path() {
        let root = workspace("absolute");
        let tools = LocalToolExecutor::new(root);

        let error = tools.write_file("C:/Users/test/secret.txt", "x").unwrap_err();

        assert!(error.contains("绝对路径"));
    }

    #[test]
    fn write_file_rejects_parent_traversal() {
        let root = workspace("parent");
        let tools = LocalToolExecutor::new(root);

        let error = tools.write_file("../secret.txt", "x").unwrap_err();

        assert!(error.contains(".."));
    }

    #[test]
    fn write_file_rejects_hidden_segments() {
        let root = workspace("hidden");
        let tools = LocalToolExecutor::new(root);

        let error = tools.write_file(".env", "TOKEN=x").unwrap_err();

        assert!(error.contains("隐藏"));
    }
}
