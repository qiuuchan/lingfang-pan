# 技术设计：本地草稿插件存储

## 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                    前端（React/TypeScript）                    │
│                                                               │
│  FloatingCreator          PluginCenter          Sidebar       │
│       │                        │                    │         │
│       ├─ save draft            ├─ list drafts      ├─ show   │
│       └─ publish               ├─ publish draft    │  badges │
│                                └─ delete draft     │         │
└───────────────────┬───────────────────────────────┬──────────┘
                    │                               │
                    │ Tauri invoke                  │
                    ▼                               ▼
┌─────────────────────────────────────────────────────────────┐
│               Tauri 后端（Rust）                              │
│                                                               │
│  draft_plugin.rs (新建模块)                                   │
│    ├─ save_draft_plugin                                      │
│    ├─ list_draft_plugins                                     │
│    ├─ load_draft_plugin                                      │
│    └─ delete_draft_plugin                                    │
└───────────────────┬───────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────────┐
│          本地文件系统（AppData）                              │
│                                                               │
│  {appDataDir}/plugins-draft/                                 │
│    └─ {plugin-id}/                                           │
│         ├─ manifest.json                                     │
│         ├─ .meta.json                                        │
│         └─ *.ts (源文件)                                     │
└─────────────────────────────────────────────────────────────┘
```

## 1. Rust 后端模块：`draft_plugin.rs`

### 1.1 目录结构

```
apps/desktop/src-tauri/src/
  ├─ lib.rs                     # 主入口，注册命令
  ├─ draft_plugin.rs            # 新建：草稿插件管理模块
  └─ ...
```

### 1.2 数据结构

```rust
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Serialize, Deserialize)]
pub struct DraftManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub entry: String,
    pub description: String,
    pub capabilities: Vec<Capability>,
    pub visibility: String,
    pub draft: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DraftMeta {
    pub created_at: String,
    pub updated_at: String,
    pub source: String,  // "ai-creator" | "import" | "manual"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published_to_team: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PluginFile {
    pub path: String,
    pub content: String,
}
```

### 1.3 核心命令实现

```rust
use tauri::AppHandle;
use std::fs;
use std::path::PathBuf;

fn get_draft_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data = app.path().app_data_dir()
        .map_err(|e| format!("无法获取 appDataDir: {}", e))?;
    Ok(app_data.join("plugins-draft"))
}

#[tauri::command]
pub async fn save_draft_plugin(
    app: AppHandle,
    id: String,
    manifest: serde_json::Value,
    files: Vec<(String, String)>,  // (path, content)
) -> Result<(), String> {
    let draft_dir = get_draft_dir(&app)?;
    let plugin_dir = draft_dir.join(&id);
    
    // 创建插件目录
    fs::create_dir_all(&plugin_dir)
        .map_err(|e| format!("创建目录失败: {}", e))?;
    
    // 写入 manifest.json
    let manifest_path = plugin_dir.join("manifest.json");
    fs::write(&manifest_path, serde_json::to_string_pretty(&manifest).unwrap())
        .map_err(|e| format!("写入 manifest 失败: {}", e))?;
    
    // 写入 .meta.json
    let meta = DraftMeta {
        created_at: chrono::Utc::now().to_rfc3339(),
        updated_at: chrono::Utc::now().to_rfc3339(),
        source: "ai-creator".to_string(),
        published_to_team: None,
    };
    let meta_path = plugin_dir.join(".meta.json");
    fs::write(&meta_path, serde_json::to_string_pretty(&meta).unwrap())
        .map_err(|e| format!("写入 meta 失败: {}", e))?;
    
    // 写入源文件
    for (path, content) in files {
        let file_path = plugin_dir.join(&path);
        if let Some(parent) = file_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("创建子目录失败: {}", e))?;
        }
        fs::write(&file_path, content)
            .map_err(|e| format!("写入文件 {} 失败: {}", path, e))?;
    }
    
    Ok(())
}

#[tauri::command]
pub async fn list_draft_plugins(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let draft_dir = get_draft_dir(&app)?;
    
    if !draft_dir.exists() {
        return Ok(vec![]);
    }
    
    let mut drafts = Vec::new();
    
    for entry in fs::read_dir(&draft_dir).map_err(|e| format!("读取目录失败: {}", e))? {
        let entry = entry.map_err(|e| format!("读取条目失败: {}", e))?;
        let plugin_dir = entry.path();
        
        if !plugin_dir.is_dir() {
            continue;
        }
        
        let manifest_path = plugin_dir.join("manifest.json");
        let meta_path = plugin_dir.join(".meta.json");
        
        if !manifest_path.exists() {
            continue;
        }
        
        let manifest_text = fs::read_to_string(&manifest_path)
            .map_err(|e| format!("读取 manifest 失败: {}", e))?;
        let mut manifest: serde_json::Value = serde_json::from_str(&manifest_text)
            .map_err(|e| format!("解析 manifest 失败: {}", e))?;
        
        // 附加 meta 信息
        if meta_path.exists() {
            let meta_text = fs::read_to_string(&meta_path).ok();
            if let Some(text) = meta_text {
                if let Ok(meta) = serde_json::from_str::<serde_json::Value>(&text) {
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
        }
        
        drafts.push(manifest);
    }
    
    Ok(drafts)
}

#[tauri::command]
pub async fn load_draft_plugin(
    app: AppHandle,
    id: String,
) -> Result<serde_json::Value, String> {
    let draft_dir = get_draft_dir(&app)?;
    let plugin_dir = draft_dir.join(&id);
    
    if !plugin_dir.exists() {
        return Err(format!("草稿插件 {} 不存在", id));
    }
    
    let manifest_path = plugin_dir.join("manifest.json");
    let manifest_text = fs::read_to_string(&manifest_path)
        .map_err(|e| format!("读取 manifest 失败: {}", e))?;
    let mut manifest: serde_json::Value = serde_json::from_str(&manifest_text)
        .map_err(|e| format!("解析 manifest 失败: {}", e))?;
    
    // 读取所有源文件
    let mut files = Vec::new();
    for entry in fs::read_dir(&plugin_dir).map_err(|e| format!("读取目录失败: {}", e))? {
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

#[tauri::command]
pub async fn delete_draft_plugin(app: AppHandle, id: String) -> Result<(), String> {
    let draft_dir = get_draft_dir(&app)?;
    let plugin_dir = draft_dir.join(&id);
    
    if !plugin_dir.exists() {
        return Err(format!("草稿插件 {} 不存在", id));
    }
    
    fs::remove_dir_all(&plugin_dir)
        .map_err(|e| format!("删除草稿失败: {}", e))?;
    
    Ok(())
}
```

### 1.4 注册命令到 `lib.rs`

```rust
mod draft_plugin;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            // ... 现有命令
            draft_plugin::save_draft_plugin,
            draft_plugin::list_draft_plugins,
            draft_plugin::load_draft_plugin,
            draft_plugin::delete_draft_plugin,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

## 2. 前端改造

### 2.1 类型定义扩展（`types.ts`）

```typescript
export interface LoadedPlugin {
  id: string;
  name: string;
  version: string;
  description: string;
  // ... 现有字段
  draft?: boolean;  // 是否草稿
  local?: boolean;  // 是否本地插件
  _meta?: {
    createdAt: string;
    updatedAt: string;
    source: string;
    publishedToTeam?: boolean;
  };
}
```

### 2.2 草稿管理 API（新建 `lib/draft-plugin.ts`）

```typescript
import { invoke } from '@tauri-apps/api/core';
import type { LoadedPlugin } from './types';

export interface SaveDraftArgs {
  id: string;
  manifest: Record<string, unknown>;
  files: [string, string][];  // [path, content][]
}

export async function saveDraftPlugin(args: SaveDraftArgs): Promise<void> {
  await invoke('save_draft_plugin', args);
}

export async function listDraftPlugins(): Promise<LoadedPlugin[]> {
  return await invoke('list_draft_plugins');
}

export async function loadDraftPlugin(id: string): Promise<LoadedPlugin> {
  return await invoke('load_draft_plugin', { id });
}

export async function deleteDraftPlugin(id: string): Promise<void> {
  await invoke('delete_draft_plugin', { id });
}
```

### 2.3 创建器改造（`FloatingCreator.tsx`）

**改动点 1**：`submitStagedPlugin` 改为 `saveDraftLocal`

```typescript
// 旧逻辑（直接上传团队）
async function handleSubmit() {
  const r = await submitStagedPlugin(draft);  // POST /api/plugins/upload
  if (r.ok) onSubmitted(r.name);
}

// 新逻辑（保存本地草稿）
async function handleSaveDraft() {
  setSubmitting(true);
  try {
    await saveDraftPlugin({
      id: draft.id,
      manifest: {
        id: draft.id,
        name: draft.name,
        version: draft.version,
        entry: draft.entry,
        description: draft.description,
        capabilities: draft.capabilities,
        visibility: draft.visibility,
        draft: true,
      },
      files: draft.files.map(f => [f.path, f.content]),
    });
    toast.success(`草稿「${draft.name}」已保存到本地`);
    setStagedDraft(null);
    setPublishedName(draft.name);
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
  } finally {
    setSubmitting(false);
  }
}
```

**改动点 2**：按钮文案改为"保存草稿到本地"

```tsx
<Button onClick={handleSaveDraft} disabled={submitting || busy}>
  {submitting ? '保存中…' : busy ? 'AI 生成中，请稍候…' : '保存草稿到本地'}
</Button>
```

### 2.4 插件加载改造（`App.tsx`）

```typescript
async function loadPlugins() {
  const [teamPlugins, localDrafts] = await Promise.all([
    api<LoadedPlugin[]>('/api/plugins'),
    listDraftPlugins(),
  ]);
  return [...teamPlugins, ...localDrafts];
}
```

### 2.5 插件中心改造（`PluginCenterDialog.tsx`）

**新增"我的草稿"Tab**：

```tsx
const tabs = ['全部', '已安装', '我的草稿', '市场'];

// 筛选逻辑
const filteredPlugins = plugins.filter(p => {
  if (activeTab === '我的草稿') return p.draft && p.local;
  if (activeTab === '已安装') return !p.draft;
  if (activeTab === '市场') return p.visibility === 'public';
  return true;
});
```

**草稿项的操作按钮**：

```tsx
{plugin.draft && plugin.local && (
  <>
    <Button onClick={() => publishDraftToTeam(plugin)}>发布到团队</Button>
    <Button variant="ghost" onClick={() => deleteDraft(plugin.id)}>删除草稿</Button>
  </>
)}
```

### 2.6 侧边栏草稿徽章（`Sidebar.tsx`）

```tsx
{plugin.draft && (
  <Badge variant="outline" className="text-xs">草稿</Badge>
)}
```

## 3. 数据流

### 3.1 创建流程

```
用户发起创建 → AI 调用 stage_plugin → 前端暂存草稿到内存
    ↓
用户点"保存草稿到本地"
    ↓
调用 saveDraftPlugin Tauri 命令
    ↓
Rust 写入 {appDataDir}/plugins-draft/{id}/
    ├─ manifest.json
    ├─ .meta.json
    └─ *.ts
    ↓
toast 提示保存成功
```

### 3.2 加载流程

```
App 启动 → loadPlugins()
    ├─ api('/api/plugins') → 团队/市场插件
    └─ listDraftPlugins() → 本地草稿
          ↓
    Rust 读取 {appDataDir}/plugins-draft/
          ↓
    返回草稿列表（带 draft: true, local: true）
          ↓
    合并到 plugins 数组
```

### 3.3 发布流程

```
用户点"发布到团队"
    ↓
调用现有 submitStagedPlugin（POST /api/plugins/upload）
    ↓
后端保存到团队空间
    ↓
更新本地草稿 .meta.json（publishedToTeam: true）
    ↓
刷新插件列表，草稿项显示"已发布"标签
```

## 4. 兼容性与回滚

### 4.1 向后兼容
- 旧版本用户升级后，草稿目录不存在 → `list_draft_plugins` 返回空数组 → 无影响
- 旧的 `submitStagedPlugin` 逻辑保留（供发布到团队时复用）

### 4.2 回滚方案
- 如果本地草稿功能出现问题，可以回退到"直接上传团队"逻辑
- 只需把创建器按钮改回调用 `submitStagedPlugin`，不影响其他功能

## 5. 测试要点

1. **Rust 命令测试**：
   - 保存草稿到不存在的目录（自动创建）
   - 保存草稿到权限受限的目录（错误处理）
   - 列出空草稿目录（返回空数组）
   - 删除不存在的草稿（错误处理）

2. **前端集成测试**：
   - AI 创建插件后点"保存草稿"→ 本地文件生成
   - 关闭创建器重新打开 → 草稿列表正确显示
   - 运行草稿插件 → 与正式插件行为一致
   - 发布草稿到团队 → 上传成功，草稿标记已发布

3. **边界情况**：
   - 草稿 ID 与团队插件 ID 冲突（发布时后端校验）
   - 草稿文件被外部修改/删除（列表时跳过损坏的草稿）
   - 跨平台路径兼容（Windows/macOS appDataDir 不同）
