// draft_plugin.rs —— 本地草稿插件管理（Tauri 命令）。
//
// 本地草稿存储在 {appDataDir}/plugins-draft/{plugin-id}/：
//   - manifest.json：插件元信息（含 draft: true）
//   - .meta.json：草稿元数据（创建时间、来源）
//   - *.ts：源文件
//
// 提供命令：save_draft_plugin, list_draft_plugins, load_draft_plugin, delete_draft_plugin
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// 草稿元数据（.meta.json）
#[derive(Debug, Serialize, Deserialize)]
struct DraftMeta {
    created_at: String,
    updated_at: String,
    source: String, // "ai-creator" | "import" | "manual"
    #[serde(skip_serializing_if = "Option::is_none")]
    published_to_team: Option<bool>,
    // task 06-25 增强：保存对话上下文供编辑时恢复。
    #[serde(skip_serializing_if = "Option::is_none")]
    conversation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    turns: Option<serde_json::Value>, // 对话轮次数组（JSON）
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedDraftFile {
    pub path: String,
    pub bytes: u64,
    pub exists: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveDraftPluginResult {
    pub id: String,
    pub path: String,
    pub manifest_path: String,
    pub meta_path: String,
    pub saved_at: String,
    pub file_count: usize,
    pub manifest_written: bool,
    pub meta_written: bool,
    pub files: Vec<SavedDraftFile>,
}

#[derive(Debug)]
struct DraftFileToWrite {
    path: String,
    rel_path: PathBuf,
    content: String,
}

/// 获取草稿根目录：{appDataDir}/plugins-draft/
fn get_draft_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取 appDataDir: {}", e))?;
    Ok(app_data.join("plugins-draft"))
}

/// 保存草稿插件到本地文件系统（支持版本管理、对话上下文保存）。
/// - id: 插件 ID（目录名）
/// - manifest: manifest.json 的 JSON 对象
/// - files: 源文件列表 [(path, content), ...]
/// - conversation_id: 对话 ID（可选，供编辑时恢复）
/// - turns: 对话轮次（可选，JSON 字符串）
/// - save_version: 是否保存为新版本（false=覆盖当前，true=追加新版本）
#[tauri::command]
pub async fn save_draft_plugin(
    app: AppHandle,
    id: String,
    manifest: serde_json::Value,
    files: Vec<(String, String)>,
    conversation_id: Option<String>,
    turns: Option<String>, // JSON 字符串
    save_version: Option<bool>,
) -> Result<SaveDraftPluginResult, String> {
    let safe_id = sanitize_draft_id(&id)?;
    let entry = manifest
        .get("entry")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "manifest 缺少 entry 字段，无法保存草稿".to_string())?
        .to_string();
    let files = prepare_draft_files(files, &entry)?;

    let draft_dir = get_draft_dir(&app)?;
    let plugin_dir = draft_dir.join(&safe_id);

    // 创建插件目录
    fs::create_dir_all(&plugin_dir).map_err(|e| format!("创建目录失败: {}", e))?;

    let meta_path = plugin_dir.join(".meta.json");
    let now = chrono::Utc::now().to_rfc3339();

    // 读取或创建 meta
    let mut meta = if meta_path.exists() {
        let old_text = fs::read_to_string(&meta_path).unwrap_or_default();
        serde_json::from_str::<DraftMeta>(&old_text).unwrap_or_else(|_| DraftMeta {
            created_at: now.clone(),
            updated_at: now.clone(),
            source: "ai-creator".to_string(),
            published_to_team: None,
            conversation_id: None,
            turns: None,
        })
    } else {
        DraftMeta {
            created_at: now.clone(),
            updated_at: now.clone(),
            source: "ai-creator".to_string(),
            published_to_team: None,
            conversation_id: None,
            turns: None,
        }
    };

    // 如果 save_version=true，先备份当前版本到 .versions/vN/
    if save_version.unwrap_or(false) && plugin_dir.join("manifest.json").exists() {
        let versions_dir = plugin_dir.join(".versions");
        fs::create_dir_all(&versions_dir).map_err(|e| format!("创建版本目录失败: {}", e))?;

        // 找到下一个版本号
        let mut next_ver = 1;
        while versions_dir.join(format!("v{}", next_ver)).exists() {
            next_ver += 1;
        }

        let ver_dir = versions_dir.join(format!("v{}", next_ver));
        fs::create_dir_all(&ver_dir).map_err(|e| format!("创建版本子目录失败: {}", e))?;

        copy_plugin_files(&plugin_dir, &ver_dir)?;
    }

    // 覆盖保存前先清理旧源码，避免旧文件残留导致「看起来保存成功但运行到旧内容」。
    remove_current_source_files(&plugin_dir)?;

    // 写入当前版本文件
    let manifest_path = plugin_dir.join("manifest.json");
    let manifest_text = serde_json::to_string_pretty(&manifest)
        .map_err(|e| format!("序列化 manifest 失败: {}", e))?;
    fs::write(&manifest_path, manifest_text).map_err(|e| format!("写入 manifest 失败: {}", e))?;

    let mut saved_files = Vec::with_capacity(files.len());
    for file in files {
        let file_path = plugin_dir.join(&file.rel_path);
        if let Some(parent) = file_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建子目录失败: {}", e))?;
        }
        fs::write(&file_path, file.content)
            .map_err(|e| format!("写入文件 {} 失败: {}", file.path, e))?;
        let metadata =
            fs::metadata(&file_path).map_err(|e| format!("核验文件 {} 失败: {}", file.path, e))?;
        if !metadata.is_file() {
            return Err(format!("核验文件 {} 失败：目标不是文件", file.path));
        }
        saved_files.push(SavedDraftFile {
            path: file.path,
            bytes: metadata.len(),
            exists: true,
        });
    }

    // 更新 meta
    meta.updated_at = now;
    if let Some(cid) = conversation_id {
        meta.conversation_id = Some(cid);
    }
    if let Some(turns_str) = turns {
        if let Ok(turns_json) = serde_json::from_str::<serde_json::Value>(&turns_str) {
            meta.turns = Some(turns_json);
        }
    }

    let meta_text =
        serde_json::to_string_pretty(&meta).map_err(|e| format!("序列化 meta 失败: {}", e))?;
    fs::write(&meta_path, meta_text).map_err(|e| format!("写入 meta 失败: {}", e))?;

    let manifest_written = manifest_path.is_file();
    let meta_written = meta_path.is_file();
    if !manifest_written || !meta_written || saved_files.is_empty() {
        return Err("草稿保存核验失败：manifest/meta 或源文件未完整写入".to_string());
    }

    Ok(SaveDraftPluginResult {
        id: safe_id,
        path: plugin_dir.to_string_lossy().to_string(),
        manifest_path: manifest_path.to_string_lossy().to_string(),
        meta_path: meta_path.to_string_lossy().to_string(),
        saved_at: meta.updated_at,
        file_count: saved_files.len(),
        manifest_written,
        meta_written,
        files: saved_files,
    })
}

/// 列出所有本地草稿插件（返回 manifest + meta 合并的 JSON）。
#[tauri::command]
pub async fn list_draft_plugins(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let draft_dir = get_draft_dir(&app)?;

    if !draft_dir.exists() {
        return Ok(vec![]);
    }

    let mut drafts = Vec::new();

    let entries = fs::read_dir(&draft_dir).map_err(|e| format!("读取草稿目录失败: {}", e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("读取条目失败: {}", e))?;
        let plugin_dir = entry.path();

        if !plugin_dir.is_dir() {
            continue;
        }

        let manifest_path = plugin_dir.join("manifest.json");
        if !manifest_path.exists() {
            continue; // 跳过损坏的草稿
        }

        let manifest_text = match fs::read_to_string(&manifest_path) {
            Ok(text) => text,
            Err(_) => continue, // 跳过读取失败的草稿
        };
        let mut manifest: serde_json::Value = match serde_json::from_str(&manifest_text) {
            Ok(v) => v,
            Err(_) => continue, // 跳过解析失败的草稿
        };

        // 附加 meta 信息
        let meta_path = plugin_dir.join(".meta.json");
        if meta_path.exists() {
            if let Ok(meta_text) = fs::read_to_string(&meta_path) {
                if let Ok(meta) = serde_json::from_str::<serde_json::Value>(&meta_text) {
                    if let Some(obj) = manifest.as_object_mut() {
                        obj.insert("_meta".to_string(), meta);
                    }
                }
            }
        }

        // 标记为本地草稿
        if let Some(obj) = manifest.as_object_mut() {
            obj.insert("local".to_string(), serde_json::Value::Bool(true));
            obj.insert("draft".to_string(), serde_json::Value::Bool(true));
            // 统计历史版本数（.versions/vN 目录数）。
            let versions_dir = plugin_dir.join(".versions");
            let version_count = if versions_dir.exists() {
                fs::read_dir(&versions_dir)
                    .map(|entries| {
                        entries
                            .filter(|e| e.as_ref().map(|e| e.path().is_dir()).unwrap_or(false))
                            .count()
                    })
                    .unwrap_or(0)
            } else {
                0
            };
            obj.insert(
                "versionCount".to_string(),
                serde_json::Value::from(version_count),
            );
        }

        drafts.push(manifest);
    }

    Ok(drafts)
}

/// 加载指定草稿插件（返回 manifest + files 完整对象）。
#[tauri::command]
pub async fn load_draft_plugin(app: AppHandle, id: String) -> Result<serde_json::Value, String> {
    let draft_dir = get_draft_dir(&app)?;
    let safe_id = sanitize_draft_id(&id)?;
    let plugin_dir = draft_dir.join(&safe_id);

    if !plugin_dir.exists() {
        return Err(format!("草稿插件 {} 不存在", id));
    }

    let manifest_path = plugin_dir.join("manifest.json");
    let manifest_text =
        fs::read_to_string(&manifest_path).map_err(|e| format!("读取 manifest 失败: {}", e))?;
    let mut manifest: serde_json::Value =
        serde_json::from_str(&manifest_text).map_err(|e| format!("解析 manifest 失败: {}", e))?;

    // 递归读取所有源文件（排除隐藏目录/文件和 manifest.json），保留 ui/index.html 等相对路径。
    let mut files = Vec::new();
    collect_source_files(&plugin_dir, &plugin_dir, &mut files)?;

    if let Some(obj) = manifest.as_object_mut() {
        obj.insert("files".to_string(), serde_json::Value::Array(files));
        obj.insert("local".to_string(), serde_json::Value::Bool(true));
        obj.insert("draft".to_string(), serde_json::Value::Bool(true));
    }

    Ok(manifest)
}

/// 删除指定草稿插件。
#[tauri::command]
pub async fn delete_draft_plugin(app: AppHandle, id: String) -> Result<(), String> {
    let draft_dir = get_draft_dir(&app)?;
    let safe_id = sanitize_draft_id(&id)?;
    let plugin_dir = draft_dir.join(&safe_id);

    if !plugin_dir.exists() {
        return Err(format!("草稿插件 {} 不存在", id));
    }

    fs::remove_dir_all(&plugin_dir).map_err(|e| format!("删除草稿失败: {}", e))?;

    Ok(())
}

/// 列出指定草稿的历史版本（返回 [{version, manifest}, ...]，按版本号降序）。
#[tauri::command]
pub async fn list_draft_versions(
    app: AppHandle,
    id: String,
) -> Result<Vec<serde_json::Value>, String> {
    let draft_dir = get_draft_dir(&app)?;
    let safe_id = sanitize_draft_id(&id)?;
    let versions_dir = draft_dir.join(&safe_id).join(".versions");

    if !versions_dir.exists() {
        return Ok(vec![]);
    }

    let mut versions = Vec::new();
    let entries = fs::read_dir(&versions_dir).map_err(|e| format!("读取版本目录失败: {}", e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("读取条目失败: {}", e))?;
        let ver_dir = entry.path();
        if !ver_dir.is_dir() {
            continue;
        }
        let ver_name = ver_dir
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        // 读取该版本的 manifest（取 name/version/description 供展示）。
        let manifest_path = ver_dir.join("manifest.json");
        let manifest = if manifest_path.exists() {
            fs::read_to_string(&manifest_path)
                .ok()
                .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
                .unwrap_or(serde_json::Value::Null)
        } else {
            serde_json::Value::Null
        };
        versions.push(serde_json::json!({
            "version": ver_name,
            "manifest": manifest,
        }));
    }

    // 按版本号降序（v10 > v2 > v1）：解析 vN 的数字部分排序。
    versions.sort_by(|a, b| {
        let na = parse_version_num(a.get("version").and_then(|v| v.as_str()).unwrap_or(""));
        let nb = parse_version_num(b.get("version").and_then(|v| v.as_str()).unwrap_or(""));
        nb.cmp(&na)
    });

    Ok(versions)
}

/// 解析 "vN" → N（用于版本排序）。
fn parse_version_num(v: &str) -> u32 {
    v.trim_start_matches('v').parse().unwrap_or(0)
}

/// 回退草稿到指定历史版本（先把当前版本另存为新版本，再用目标版本覆盖当前）。
#[tauri::command]
pub async fn restore_draft_version(
    app: AppHandle,
    id: String,
    version: String,
) -> Result<(), String> {
    let draft_dir = get_draft_dir(&app)?;
    let safe_id = sanitize_draft_id(&id)?;
    let safe_version = sanitize_version_name(&version)?;
    let plugin_dir = draft_dir.join(&safe_id);
    let ver_dir = plugin_dir.join(".versions").join(&safe_version);

    if !ver_dir.exists() {
        return Err(format!("版本 {} 不存在", safe_version));
    }

    // 先备份当前版本（避免回退丢失当前内容）。
    let versions_dir = plugin_dir.join(".versions");
    let mut next_ver = 1;
    while versions_dir.join(format!("v{}", next_ver)).exists() {
        next_ver += 1;
    }
    let backup_dir = versions_dir.join(format!("v{}", next_ver));
    fs::create_dir_all(&backup_dir).map_err(|e| format!("创建备份目录失败: {}", e))?;
    copy_plugin_files(&plugin_dir, &backup_dir)?;

    // 删除当前版本的源文件（保留 .meta.json 和 .versions），包含 ui/index.html 等嵌套目录。
    remove_current_source_files(&plugin_dir)?;

    // 用目标版本覆盖当前。
    copy_plugin_files(&ver_dir, &plugin_dir)?;

    Ok(())
}

/// 校验草稿 id：只允许单个 ASCII 段，避免越出 plugins-draft 根目录。
fn sanitize_draft_id(id: &str) -> Result<String, String> {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return Err("草稿 id 不能为空".to_string());
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(format!(
            "草稿 id 含非法字符（仅允许字母数字下划线短横线）：{trimmed}"
        ));
    }
    Ok(trimmed.to_string())
}

fn sanitize_version_name(version: &str) -> Result<String, String> {
    let trimmed = version.trim();
    if trimmed.is_empty() {
        return Err("版本号不能为空".to_string());
    }
    let Some(num) = trimmed.strip_prefix('v') else {
        return Err(format!("非法版本号：{trimmed}"));
    };
    if num.is_empty() || !num.chars().all(|c| c.is_ascii_digit()) {
        return Err(format!("非法版本号：{trimmed}"));
    }
    Ok(trimmed.to_string())
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
    for (raw_path, content) in files {
        let rel_path = clean_source_path(&raw_path)?;
        let path = normalize_rel_path(&rel_path);
        if path == "manifest.json" {
            return Err("源文件列表不能包含 manifest.json，请通过 manifest 参数保存".to_string());
        }
        if !seen.insert(path.clone()) {
            return Err(format!("源文件重复：{path}"));
        }
        prepared.push(DraftFileToWrite {
            path,
            rel_path,
            content,
        });
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

/// 覆盖保存前清理当前源文件：移除 manifest + 非隐藏文件/目录，保留 .meta.json 与 .versions。
fn remove_current_source_files(plugin_dir: &Path) -> Result<(), String> {
    if !plugin_dir.exists() {
        return Ok(());
    }
    let entries = fs::read_dir(plugin_dir).map_err(|e| format!("读取目录失败: {}", e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("读取条目失败: {}", e))?;
        let path = entry.path();
        if is_hidden_name(&path) {
            continue;
        }
        if path.is_dir() {
            fs::remove_dir_all(&path).map_err(|e| format!("清理目录失败: {}", e))?;
        } else if path.is_file() || is_manifest(&path) {
            fs::remove_file(&path).map_err(|e| format!("清理文件失败: {}", e))?;
        }
    }
    Ok(())
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
