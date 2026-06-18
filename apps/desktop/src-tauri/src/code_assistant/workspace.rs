use std::path::{Path, PathBuf};

use super::store::AssistantStore;
use super::{CodeAssistantState, CodeAssistantTool, DraftFileJson, ScanWorkspaceInput};

pub fn scan_workspace_files(
    state: &CodeAssistantState,
    input: ScanWorkspaceInput,
) -> Result<Vec<DraftFileJson>, String> {
    let session = state
        .store
        .list_sessions()
        .into_iter()
        .find(|record| record.session_id == input.session_id)
        .ok_or_else(|| format!("session 不存在：{}", input.session_id))?;
    let root = PathBuf::from(&session.workspace_dir);
    if !root.exists() {
        return Ok(Vec::new());
    }
    let root_canon = root
        .canonicalize()
        .map_err(|error| format!("sandbox 目录无法访问：{error}"))?;
    let mut files = Vec::new();
    collect_workspace_files(&root_canon, &root_canon, &mut files)?;
    files.sort_by_key(|file| if file.path == "manifest.json" { 0 } else { 1 });
    Ok(files)
}

fn collect_workspace_files(
    current: &Path,
    root_canon: &Path,
    out: &mut Vec<DraftFileJson>,
) -> Result<(), String> {
    collect_workspace_files_inner(current, root_canon, out, 0)
}

const MAX_SCAN_DEPTH: usize = 32;
const MAX_FILE_BYTES: u64 = 256 * 1024;

fn collect_workspace_files_inner(
    current: &Path,
    root_canon: &Path,
    out: &mut Vec<DraftFileJson>,
    depth: usize,
) -> Result<(), String> {
    if depth > MAX_SCAN_DEPTH {
        return Ok(());
    }
    let entries = std::fs::read_dir(current).map_err(|error| error.to_string())?;
    for entry in entries.flatten() {
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy();
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        let path = entry.path();
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if metadata.is_dir() {
            collect_workspace_files_inner(&path, root_canon, out, depth + 1)?;
            continue;
        }
        if !metadata.is_file() || metadata.len() > MAX_FILE_BYTES {
            continue;
        }
        collect_file(path.as_path(), root_canon, out);
    }
    Ok(())
}

fn collect_file(path: &Path, root_canon: &Path, out: &mut Vec<DraftFileJson>) {
    let Ok(canon) = path.canonicalize() else {
        return;
    };
    if !canon.starts_with(root_canon) {
        return;
    }
    let Ok(content) = std::fs::read_to_string(&canon) else {
        return;
    };
    let rel = canon
        .strip_prefix(root_canon)
        .map(|path| path.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    if rel.is_empty() {
        return;
    }
    out.push(DraftFileJson { path: rel, content });
}

pub(crate) fn resolve_workspace(
    workspace_dir: Option<String>,
    default_root: Option<&Path>,
    _plugin_id: Option<&str>,
) -> Result<String, String> {
    let path = workspace_dir
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| default_root.map(|root| root.join("claude-sandbox")))
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    if !path.exists() {
        std::fs::create_dir_all(&path)
            .map_err(|error| format!("创建 sandbox 目录失败：{error}"))?;
    }
    if !path.is_dir() {
        return Err(format!("workspace 不是目录：{}", path.to_string_lossy()));
    }
    path.canonicalize()
        .map(|path| path.to_string_lossy().to_string())
        .map_err(|error| error.to_string())
}

pub(crate) fn new_session_id(tool: CodeAssistantTool) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}-{}-{}", tool.as_str(), now.as_secs(), now.subsec_nanos())
}

#[allow(dead_code)]
fn _assert_store_boundary(_: &AssistantStore) {}
