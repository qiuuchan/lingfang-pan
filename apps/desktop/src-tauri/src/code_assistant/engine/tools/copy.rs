use std::path::Path;

use serde_json::{json, Value};

use super::paths::{
    relative_display_path, resolve_absolute_existing_path, resolve_workspace_write_path,
};
use super::read::should_skip_name;

#[derive(Default)]
struct CopyStats {
    copied_files: u64,
    copied_bytes: u64,
    skipped_entries: u64,
}

pub(crate) fn import_local_project(
    workspace: &Path,
    source_path: &str,
    destination: Option<&str>,
) -> Result<Value, String> {
    let source = resolve_absolute_existing_path(source_path)?;
    let destination = destination.unwrap_or("").trim();
    let target = resolve_import_target(workspace, destination)?;
    let mut stats = CopyStats::default();
    if source.is_file() {
        let file_target = target.join(
            source
                .file_name()
                .ok_or_else(|| "源文件缺少文件名".to_string())?,
        );
        copy_one_file(&source, &file_target, &mut stats)?;
    } else if source.is_dir() {
        copy_dir(&source, &source, &target, &mut stats)?;
    } else {
        return Err(format!(
            "源路径不是普通文件或目录：{}",
            source.to_string_lossy()
        ));
    }
    Ok(json!({
        "sourcePath": source.to_string_lossy().replace('\\', "/"),
        "destination": destination,
        "copiedFiles": stats.copied_files,
        "copiedBytes": stats.copied_bytes,
        "skippedEntries": stats.skipped_entries,
    }))
}

fn resolve_import_target(
    workspace: &Path,
    destination: &str,
) -> Result<std::path::PathBuf, String> {
    if destination.is_empty() {
        return workspace.canonicalize().map_err(|error| error.to_string());
    }
    resolve_workspace_write_path(workspace, destination)
}

fn copy_dir(
    root: &Path,
    current: &Path,
    target_root: &Path,
    stats: &mut CopyStats,
) -> Result<(), String> {
    for entry in std::fs::read_dir(current).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if should_skip_name(&name) {
            stats.skipped_entries += 1;
            continue;
        }
        let path = entry.path();
        let target = target_root.join(relative_display_path(root, &path));
        if path.is_dir() {
            copy_dir(root, &path, target_root, stats)?;
        } else if path.is_file() {
            copy_one_file(&path, &target, stats)?;
        } else {
            stats.skipped_entries += 1;
        }
    }
    Ok(())
}

fn copy_one_file(source: &Path, target: &Path, stats: &mut CopyStats) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let bytes = std::fs::copy(source, target).map_err(|error| error.to_string())?;
    stats.copied_files += 1;
    stats.copied_bytes += bytes;
    Ok(())
}
