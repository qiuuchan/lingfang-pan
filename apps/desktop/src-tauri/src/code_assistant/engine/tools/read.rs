use std::path::Path;

use serde_json::{json, Value};

use super::paths::{normalize_path, relative_display_path, resolve_absolute_existing_path};

const MAX_SCAN_DEPTH: usize = 24;
const MAX_READ_BYTES: u64 = 256 * 1024;
const MAX_LOCAL_READ_BYTES: u64 = 1024 * 1024;
const MAX_SEARCH_MATCHES: usize = 200;

pub(crate) fn list_directory(target: &Path, original_path: &str) -> Result<Value, String> {
    Ok(json!({
        "path": normalize_path(original_path),
        "entries": directory_entries(target)?,
    }))
}

pub(crate) fn list_local_directory(path: &str) -> Result<Value, String> {
    let target = resolve_absolute_existing_path(path)?;
    if !target.is_dir() {
        return Err(format!("路径不是目录：{}", target.to_string_lossy()));
    }
    Ok(json!({
        "path": target.to_string_lossy().replace('\\', "/"),
        "entries": directory_entries(&target)?,
    }))
}

pub(crate) fn read_file(target: &Path, original_path: &str) -> Result<Value, String> {
    let content = std::fs::read_to_string(target).map_err(|error| error.to_string())?;
    Ok(json!({ "path": normalize_path(original_path), "content": content }))
}

pub(crate) fn read_local_file(path: &str, max_bytes: Option<u64>) -> Result<Value, String> {
    let target = resolve_absolute_existing_path(path)?;
    let limit = max_bytes.unwrap_or(MAX_LOCAL_READ_BYTES);
    let metadata = target.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err(format!("路径不是文件：{}", target.to_string_lossy()));
    }
    if metadata.len() > limit {
        return Err(format!("文件超过读取上限：{} > {}", metadata.len(), limit));
    }
    let content = std::fs::read_to_string(&target).map_err(|error| error.to_string())?;
    Ok(json!({
        "path": target.to_string_lossy().replace('\\', "/"),
        "content": content,
        "bytes": metadata.len(),
        "truncated": false,
    }))
}

pub(crate) fn scan_workspace(root: &Path) -> Result<Value, String> {
    let mut files = Vec::new();
    collect_files(root, root, &mut files, 0)?;
    Ok(json!({ "files": files }))
}

pub(crate) fn search_local_files(path: &str, query: &str) -> Result<Value, String> {
    let root = resolve_absolute_existing_path(path)?;
    if !root.is_dir() {
        return Err(format!("搜索路径不是目录：{}", root.to_string_lossy()));
    }
    let mut matches = Vec::new();
    search_dir(&root, &root, query, &mut matches, 0)?;
    Ok(json!({
        "path": root.to_string_lossy().replace('\\', "/"),
        "query": query,
        "matches": matches,
        "truncated": matches.len() >= MAX_SEARCH_MATCHES,
    }))
}

fn directory_entries(target: &Path) -> Result<Vec<Value>, String> {
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(target).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if should_skip_name(&name) {
            continue;
        }
        let metadata = entry.metadata().map_err(|error| error.to_string())?;
        entries.push(json!({
            "name": name,
            "kind": if metadata.is_dir() { "directory" } else { "file" },
            "bytes": if metadata.is_file() { metadata.len() } else { 0 },
        }));
    }
    entries.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    Ok(entries)
}

fn collect_files(
    root: &Path,
    current: &Path,
    out: &mut Vec<Value>,
    depth: usize,
) -> Result<(), String> {
    if depth > MAX_SCAN_DEPTH {
        return Ok(());
    }
    for entry in std::fs::read_dir(current).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if should_skip_name(&name) {
            continue;
        }
        let path = entry.path();
        let metadata = entry.metadata().map_err(|error| error.to_string())?;
        if metadata.is_dir() {
            collect_files(root, &path, out, depth + 1)?;
        } else if metadata.is_file() && metadata.len() <= MAX_READ_BYTES {
            push_text_file(root, &path, out);
        }
    }
    Ok(())
}

fn search_dir(
    root: &Path,
    current: &Path,
    query: &str,
    matches: &mut Vec<Value>,
    depth: usize,
) -> Result<(), String> {
    if depth > MAX_SCAN_DEPTH || matches.len() >= MAX_SEARCH_MATCHES {
        return Ok(());
    }
    for entry in std::fs::read_dir(current).map_err(|error| error.to_string())? {
        if matches.len() >= MAX_SEARCH_MATCHES {
            return Ok(());
        }
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if should_skip_name(&name) {
            continue;
        }
        let path = entry.path();
        let metadata = entry.metadata().map_err(|error| error.to_string())?;
        if metadata.is_dir() {
            search_dir(root, &path, query, matches, depth + 1)?;
        } else if metadata.is_file() && metadata.len() <= MAX_LOCAL_READ_BYTES {
            push_file_matches(root, &path, query, matches);
        }
    }
    Ok(())
}

fn push_text_file(root: &Path, path: &Path, out: &mut Vec<Value>) {
    if let Ok(content) = std::fs::read_to_string(path) {
        out.push(json!({ "path": relative_display_path(root, path), "content": content }));
    }
}

fn push_file_matches(root: &Path, path: &Path, query: &str, matches: &mut Vec<Value>) {
    let Ok(content) = std::fs::read_to_string(path) else {
        return;
    };
    for (index, line) in content.lines().enumerate() {
        if !line.contains(query) {
            continue;
        }
        matches.push(json!({
            "path": relative_display_path(root, path),
            "line": index + 1,
            "text": line,
        }));
        if matches.len() >= MAX_SEARCH_MATCHES {
            return;
        }
    }
}

pub(crate) fn should_skip_name(name: &str) -> bool {
    matches!(
        name,
        "node_modules" | ".venv" | "__pycache__" | "dist" | "build" | ".git"
    ) || name.starts_with('.')
}
