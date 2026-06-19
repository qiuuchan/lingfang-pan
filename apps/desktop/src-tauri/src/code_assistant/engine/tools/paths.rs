use std::path::{Path, PathBuf};

pub(crate) fn resolve_workspace_read_path(root: &Path, path: &str) -> Result<PathBuf, String> {
    let rel = sanitize_rel_path(path)?;
    let target = root.join(rel);
    let canon = target.canonicalize().map_err(|error| error.to_string())?;
    let root = canonical_root(root)?;
    if !canon.starts_with(root) {
        return Err("路径逃逸 workspace".to_string());
    }
    Ok(canon)
}

pub(crate) fn resolve_workspace_write_path(root: &Path, path: &str) -> Result<PathBuf, String> {
    let rel = sanitize_rel_path(path)?;
    let root = canonical_root(root)?;
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

pub(crate) fn resolve_absolute_existing_path(path: &str) -> Result<PathBuf, String> {
    let target = PathBuf::from(path.trim());
    if path.trim().is_empty() {
        return Err("路径不能为空".to_string());
    }
    if !target.is_absolute() {
        return Err(format!("路径必须是绝对路径：{}", normalize_path(path)));
    }
    target.canonicalize().map_err(|error| error.to_string())
}

pub(crate) fn normalize_path(path: &str) -> String {
    path.trim().replace('\\', "/")
}

pub(crate) fn relative_display_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .map(|value| value.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.to_string_lossy().replace('\\', "/"))
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

fn canonical_root(root: &Path) -> Result<PathBuf, String> {
    root.canonicalize().map_err(|error| error.to_string())
}

fn is_windows_drive(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/'
}
