// draft_plugin.rs —— 本地草稿插件管理（Tauri 命令）。
//
// 本地草稿存储在 {appDataDir}/plugins-draft/{plugin-id}/：
//   - manifest.json：插件元信息（含 draft: true）
//   - .meta.json：草稿元数据（创建时间、来源）
//   - *.ts：源文件
//
// 提供命令：save_draft_plugin, list_draft_plugins, load_draft_plugin, delete_draft_plugin
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
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
) -> Result<(), String> {
    let draft_dir = get_draft_dir(&app)?;
    let plugin_dir = draft_dir.join(&id);

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

        // 复制当前文件到版本目录
        let current_manifest = plugin_dir.join("manifest.json");
        if current_manifest.exists() {
            fs::copy(&current_manifest, ver_dir.join("manifest.json"))
                .map_err(|e| format!("备份 manifest 失败: {}", e))?;
        }

        for entry in fs::read_dir(&plugin_dir).unwrap_or_else(|_| fs::read_dir(".").unwrap()) {
            let entry = entry.map_err(|e| format!("读取条目失败: {}", e))?;
            let path = entry.path();
            let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");

            if path.is_file() && !file_name.starts_with('.') && file_name != "manifest.json" {
                fs::copy(&path, ver_dir.join(file_name))
                    .map_err(|e| format!("备份文件 {} 失败: {}", file_name, e))?;
            }
        }
    }

    // 写入当前版本文件
    let manifest_path = plugin_dir.join("manifest.json");
    let manifest_text = serde_json::to_string_pretty(&manifest)
        .map_err(|e| format!("序列化 manifest 失败: {}", e))?;
    fs::write(&manifest_path, manifest_text).map_err(|e| format!("写入 manifest 失败: {}", e))?;

    for (path, content) in files {
        let file_path = plugin_dir.join(&path);
        if let Some(parent) = file_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建子目录失败: {}", e))?;
        }
        fs::write(&file_path, content).map_err(|e| format!("写入文件 {} 失败: {}", path, e))?;
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

    Ok(())
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
                    .map(|entries| entries.filter(|e| e.as_ref().map(|e| e.path().is_dir()).unwrap_or(false)).count())
                    .unwrap_or(0)
            } else {
                0
            };
            obj.insert("versionCount".to_string(), serde_json::Value::from(version_count));
        }

        drafts.push(manifest);
    }

    Ok(drafts)
}

/// 加载指定草稿插件（返回 manifest + files 完整对象）。
#[tauri::command]
pub async fn load_draft_plugin(app: AppHandle, id: String) -> Result<serde_json::Value, String> {
    let draft_dir = get_draft_dir(&app)?;
    let plugin_dir = draft_dir.join(&id);

    if !plugin_dir.exists() {
        return Err(format!("草稿插件 {} 不存在", id));
    }

    let manifest_path = plugin_dir.join("manifest.json");
    let manifest_text =
        fs::read_to_string(&manifest_path).map_err(|e| format!("读取 manifest 失败: {}", e))?;
    let mut manifest: serde_json::Value = serde_json::from_str(&manifest_text)
        .map_err(|e| format!("解析 manifest 失败: {}", e))?;

    // 读取所有源文件（排除 . 开头和 manifest.json）
    let mut files = Vec::new();
    let entries = fs::read_dir(&plugin_dir).map_err(|e| format!("读取目录失败: {}", e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("读取条目失败: {}", e))?;
        let path = entry.path();
        let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");

        if file_name.starts_with('.') || file_name == "manifest.json" {
            continue;
        }

        if path.is_file() {
            let content = fs::read_to_string(&path)
                .map_err(|e| format!("读取文件 {} 失败: {}", file_name, e))?;
            files.push(serde_json::json!({
                "path": file_name,
                "content": content,
            }));
        }
    }

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
    let plugin_dir = draft_dir.join(&id);

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
    let versions_dir = draft_dir.join(&id).join(".versions");

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
    let plugin_dir = draft_dir.join(&id);
    let ver_dir = plugin_dir.join(".versions").join(&version);

    if !ver_dir.exists() {
        return Err(format!("版本 {} 不存在", version));
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

    // 删除当前版本的源文件（保留 .meta.json 和 .versions）。
    let entries = fs::read_dir(&plugin_dir).map_err(|e| format!("读取目录失败: {}", e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("读取条目失败: {}", e))?;
        let path = entry.path();
        let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if path.is_file() && (file_name == "manifest.json" || !file_name.starts_with('.')) {
            fs::remove_file(&path).map_err(|e| format!("清理当前文件失败: {}", e))?;
        }
    }

    // 用目标版本覆盖当前。
    copy_plugin_files(&ver_dir, &plugin_dir)?;

    Ok(())
}

/// 复制插件源文件（manifest.json + 非隐藏文件）从 src 到 dst。
fn copy_plugin_files(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    let entries = fs::read_dir(src).map_err(|e| format!("读取源目录失败: {}", e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("读取条目失败: {}", e))?;
        let path = entry.path();
        let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if path.is_file() && (file_name == "manifest.json" || !file_name.starts_with('.')) {
            fs::copy(&path, dst.join(file_name))
                .map_err(|e| format!("复制文件 {} 失败: {}", file_name, e))?;
        }
    }
    Ok(())
}

