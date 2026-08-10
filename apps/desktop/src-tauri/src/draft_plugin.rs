// draft_plugin.rs —— 旧草稿体系的迁移桥（Tauri 命令）。
//
// 历史：旧版草稿存储在 {appDataDir}/plugins-draft/{plugin-id}/，CRUD 命令由本模块提供。
// 新体系（plugin_package_manager::commands 的 draft workspace 系列）接管草稿全生命周期后，
// 旧 CRUD 已整体删除。本模块仅保留「一次性迁移」：把旧 plugins-draft/* 搬到
// plugins_root/{id}/（manifest 标 draft:true），以及迁移实现的纯函数与其测试。
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

#[derive(Debug)]
struct DraftFileToWrite {
    path: String,
    rel_path: PathBuf,
}

/// 获取旧草稿根目录：{appDataDir}/plugins-draft/
fn get_draft_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取 appDataDir: {}", e))?;
    Ok(app_data.join("plugins-draft"))
}

/// 校验源文件相对路径，禁止绝对路径、空段、隐藏段和 ..。
fn clean_source_path(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("文件路径不能为空".to_string());
    }
    if trimmed.contains('\\') || trimmed.starts_with('/') || trimmed.contains(':') {
        return Err(format!("文件路径非法：{trimmed}"));
    }
    let path = Path::new(trimmed);
    if path.is_absolute() {
        return Err(format!("文件路径不能是绝对路径：{trimmed}"));
    }
    let mut cleaned = PathBuf::new();
    for component in path.components() {
        let std::path::Component::Normal(segment) = component else {
            return Err(format!("文件路径非法：{trimmed}"));
        };
        let Some(segment) = segment.to_str() else {
            return Err(format!("文件路径包含非法字符：{trimmed}"));
        };
        if segment.is_empty() || segment == "." || segment == ".." || segment.starts_with('.') {
            return Err(format!("文件路径非法：{trimmed}"));
        }
        cleaned.push(segment);
    }
    if cleaned.as_os_str().is_empty() {
        return Err("文件路径不能为空".to_string());
    }
    Ok(cleaned)
}

fn prepare_draft_files(
    files: Vec<(String, String)>,
    entry: &str,
) -> Result<Vec<DraftFileToWrite>, String> {
    if files.is_empty() {
        return Err("草稿至少要包含一个源文件".to_string());
    }
    let entry_path = clean_source_path(entry)?;
    let entry_norm = normalize_rel_path(&entry_path);
    let mut seen = HashSet::new();
    let mut prepared = Vec::with_capacity(files.len());
    for (raw_path, _content) in files {
        let rel_path = clean_source_path(&raw_path)?;
        let path = normalize_rel_path(&rel_path);
        if path == "manifest.json" {
            return Err("源文件列表不能包含 manifest.json，请通过 manifest 参数保存".to_string());
        }
        if !seen.insert(path.clone()) {
            return Err(format!("源文件重复：{path}"));
        }
        prepared.push(DraftFileToWrite { path, rel_path });
    }
    if !seen.contains(&entry_norm) {
        return Err(format!(
            "入口文件 {entry_norm} 不在源文件列表中，未创建插件文件"
        ));
    }
    Ok(prepared)
}

fn normalize_rel_path(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            std::path::Component::Normal(segment) => segment.to_str().map(ToString::to_string),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn is_hidden_name(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|name| name.starts_with('.'))
        .unwrap_or(false)
}

fn is_manifest(path: &Path) -> bool {
    path.file_name().and_then(|n| n.to_str()) == Some("manifest.json")
}

/// 递归收集源文件，返回前端 DraftFile 形状；隐藏文件/目录与 manifest.json 跳过。
fn collect_source_files(
    base: &Path,
    dir: &Path,
    files: &mut Vec<serde_json::Value>,
) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|e| format!("读取目录失败: {}", e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("读取条目失败: {}", e))?;
        let path = entry.path();
        if is_hidden_name(&path) || is_manifest(&path) {
            continue;
        }
        if path.is_dir() {
            collect_source_files(base, &path, files)?;
        } else if path.is_file() {
            let rel = path
                .strip_prefix(base)
                .map_err(|e| format!("计算相对路径失败: {}", e))?;
            let rel_path = normalize_rel_path(rel);
            let content = fs::read_to_string(&path)
                .map_err(|e| format!("读取文件 {} 失败: {}", rel_path, e))?;
            files.push(serde_json::json!({
                "path": rel_path,
                "content": content,
            }));
        }
    }
    Ok(())
}

/// 复制插件源文件（manifest.json + 非隐藏文件/目录）从 src 到 dst，保留嵌套目录结构。
fn copy_plugin_files(src: &Path, dst: &Path) -> Result<(), String> {
    let entries = fs::read_dir(src).map_err(|e| format!("读取源目录失败: {}", e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("读取条目失败: {}", e))?;
        let path = entry.path();
        let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if file_name.starts_with('.') {
            continue;
        }
        let target = dst.join(file_name);
        if path.is_dir() {
            fs::create_dir_all(&target).map_err(|e| format!("创建备份目录失败: {}", e))?;
            copy_plugin_files(&path, &target)?;
        } else if path.is_file() && (file_name == "manifest.json" || !file_name.starts_with('.')) {
            fs::copy(&path, &target).map_err(|e| format!("复制文件 {} 失败: {}", file_name, e))?;
        }
    }
    Ok(())
}

/// 一次性迁移：把旧 plugins-draft/* 搬到 plugins_root/{id}/（manifest 标 draft:true）。
///
/// 仅在旧目录存在且有内容时执行（幂等：第二次调用目录已空则跳过）。
/// 迁移后删除旧目录（remove_dir_all），后续写入全部走 plugins_root。
/// 用于 task 06-26-agent-framework-rewrite：废弃 plugins-draft 双轨。
/// 通过 app.handle() 获取 app_data_dir（不依赖 tauri::State，方便 setup 阶段调用）。
#[tauri::command]
pub fn migrate_drafts_to_root(
    app: AppHandle,
    plugin_store: tauri::State<'_, crate::plugin_store::PluginStore>,
) -> Result<String, String> {
    migrate_drafts_impl(&app, &plugin_store)
}

/// 实际迁移逻辑（不含 tauri::State 包装），供 setup 阶段直接调用。
pub fn migrate_drafts_impl(
    app: &AppHandle,
    plugin_store: &crate::plugin_store::PluginStore,
) -> Result<String, String> {
    let draft_dir = get_draft_dir(app)?;
    if !draft_dir.exists() {
        return Ok("无需迁移：旧草稿目录不存在。".to_string());
    }
    let entries = fs::read_dir(&draft_dir).map_err(|e| format!("读取旧草稿目录失败: {e}"))?;
    let mut migrated = 0u32;
    let mut skipped = 0u32;
    for entry in entries {
        let entry = entry.map_err(|e| format!("读取条目失败: {e}"))?;
        let src = entry.path();
        if !src.is_dir() {
            continue;
        }
        let id = match src.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        // 校验 id 合法性（复用 plugin_store 的 sanitize_plugin_id）。
        let safe_id = match crate::plugin_store::sanitize_plugin_id(&id) {
            Ok(id) => id,
            Err(_) => {
                skipped += 1;
                continue;
            }
        };
        // 确保目标 plugins_root/{id}/ 目录存在。
        let target = match plugin_store.ensure_plugin_dir(&safe_id) {
            Ok(dir) => dir,
            Err(_) => {
                skipped += 1;
                continue;
            }
        };
        // 复制 manifest.json 并写入 draft: true。
        let old_manifest = src.join("manifest.json");
        if old_manifest.exists() {
            if let Ok(raw) = fs::read_to_string(&old_manifest) {
                if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&raw) {
                    v["draft"] = serde_json::Value::Bool(true);
                    if let Ok(pretty) = serde_json::to_string_pretty(&v) {
                        let _ = fs::write(target.join("manifest.json"), pretty);
                    }
                }
            }
        }
        // 复制源文件（跳过隐藏文件/目录与 manifest，复用 copy_plugin_files）。
        if copy_plugin_files(&src, &target).is_err() {
            skipped += 1;
            continue;
        }
        // 删除旧目录（幂等：不存在也 Ok）。
        let _ = fs::remove_dir_all(&src);
        migrated += 1;
    }
    // 旧目录为空则删除。
    let _ = fs::remove_dir_all(&draft_dir);
    Ok(format!(
        "迁移完成：{migrated} 个草稿已迁移，跳过 {skipped} 个。"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "lingfang-draft-plugin-{}-{name}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn prepare_draft_files_requires_real_entry_file() {
        let err = prepare_draft_files(Vec::new(), "ui/index.html").unwrap_err();
        assert!(err.contains("至少要包含一个源文件"));

        let err = prepare_draft_files(
            vec![("ui/style.css".to_string(), "body{}".to_string())],
            "ui/index.html",
        )
        .unwrap_err();
        assert!(err.contains("入口文件 ui/index.html 不在源文件列表中"));
    }

    #[test]
    fn prepare_draft_files_accepts_nested_entry_and_rejects_unsafe_paths() {
        let files = prepare_draft_files(
            vec![("ui/index.html".to_string(), "<h1>ok</h1>".to_string())],
            "ui/index.html",
        )
        .unwrap();

        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "ui/index.html");
        assert_eq!(normalize_rel_path(&files[0].rel_path), "ui/index.html");

        for bad_path in [
            "../index.html",
            "/tmp/index.html",
            "C:/tmp/index.html",
            "ui/.env",
        ] {
            let err = prepare_draft_files(
                vec![(bad_path.to_string(), "x".to_string())],
                "ui/index.html",
            )
            .unwrap_err();
            assert!(
                err.contains("文件路径"),
                "unexpected error for {bad_path}: {err}"
            );
        }
    }

    #[test]
    fn collect_source_files_preserves_nested_paths_and_skips_metadata() {
        let root = temp_dir("collect-nested");
        fs::create_dir_all(root.join("ui")).unwrap();
        fs::create_dir_all(root.join(".versions").join("v1")).unwrap();
        fs::write(root.join("manifest.json"), "{}").unwrap();
        fs::write(root.join(".meta.json"), "{}").unwrap();
        fs::write(root.join("ui").join("index.html"), "<h1>ok</h1>").unwrap();
        fs::write(root.join("ui").join("style.css"), "body{}").unwrap();
        fs::write(root.join(".versions").join("v1").join("old.html"), "old").unwrap();

        let mut files = Vec::new();
        collect_source_files(&root, &root, &mut files).unwrap();

        let mut paths = files
            .iter()
            .filter_map(|file| file.get("path").and_then(|path| path.as_str()))
            .collect::<Vec<_>>();
        paths.sort_unstable();

        assert_eq!(paths, vec!["ui/index.html", "ui/style.css"]);
        let _ = fs::remove_dir_all(root);
    }
}