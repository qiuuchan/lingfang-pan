# PRD：本地草稿插件存储与管理

## Goal

重构 AI 创建器的草稿流程，从"直接上传团队"改为"本地草稿 → 调试 → 发布到团队"，支持用户在本地测试修复后再发布。

## 问题背景

当前 AI 创建器的流程存在严重缺陷：

- **现状**：AI 创建完成 → stage_plugin 暂存到内存 → 用户点"提交到团队空间" → 直接上传到后端团队空间
- **问题**：
  1. 跳过本地调试阶段，用户无法在本地测试修复后再发布
  2. 一旦提交就直接发布到团队，无法撤回
  3. 草稿只在内存中，关闭创建器窗口就丢失
  4. 与"本地插件 → 团队插件 → 市场插件"的分层架构不一致

## Requirements

### R1：本地草稿存储位置

- 本地插件根目录：使用 Tauri `appDataDir`（Windows: `%APPDATA%/com.lingfang.desktop/`，macOS: `~/Library/Application Support/com.lingfang.desktop/`）
- 草稿目录：`{appDataDir}/plugins-draft/{plugin-id}/`
- 正式本地插件：`{appDataDir}/plugins/{plugin-id}/`（已安装的团队/市场插件，暂不在本任务实现）

### R2：草稿插件数据结构

每个草稿插件目录包含：

```
plugins-draft/
  my-plugin/
    manifest.json      # 插件元信息（含 draft: true 标记）
    index.ts           # 入口文件
    other-file.ts      # 其他源文件
    .meta.json         # 草稿元数据（创建时间、最后修改时间、来源等）
```

`manifest.json` 结构（与团队插件兼容）：

```json
{
  "id": "my-plugin",
  "name": "我的插件",
  "version": "0.0.1",
  "entry": "index.ts",
  "description": "插件描述",
  "capabilities": [...],
  "visibility": "private",
  "draft": true
}
```

`.meta.json` 草稿元数据：

```json
{
  "createdAt": "2026-06-25T10:00:00Z",
  "updatedAt": "2026-06-25T10:30:00Z",
  "source": "ai-creator"
}
```

### R3：创建器保存流程改造

**当前**：`submitStagedPlugin` → POST `/api/plugins/upload`

**目标**：

1. AI 调用 `stage_plugin` 工具 → 暂存到前端内存
2. 用户点"保存为本地草稿" → 调用 Tauri 命令 `save_draft_plugin` → 写入本地文件系统
3. 按钮文案改为"保存草稿到本地"
4. 保存成功后提示"草稿已保存，可在插件中心查看"

### R4：插件加载逻辑改造

`loadPlugins()` 增加本地草稿加载：

```typescript
const teamPlugins = await api('/api/plugins'); // 团队/市场插件
const localDrafts = await invoke('list_draft_plugins'); // 本地草稿
return [...teamPlugins, ...localDrafts];
```

草稿插件的 `LoadedPlugin` 增加字段：

```typescript
interface LoadedPlugin {
  // ... 现有字段
  draft?: boolean; // 是否草稿
  local?: boolean; // 是否本地插件
}
```

### R5：插件管理 UI 改造

**插件中心**新增"我的草稿"Tab：

- 列表展示所有本地草稿
- 每个草稿项显示：名字、描述、创建时间、草稿徽章
- 操作按钮：
  - **运行**：加载草稿运行（与正式插件相同）
  - **发布到团队**：上传到团队空间（转为正式插件）
  - **删除草稿**：从本地删除

**侧边栏插件列表**：

- 草稿插件显示草稿徽章
- 可运行、可固定（与正式插件相同）

### R6：Tauri 命令实现

新增 Rust 命令（在 `apps/desktop/src-tauri/src/lib.rs` 或新模块）：

```rust
#[tauri::command]
async fn save_draft_plugin(id: String, manifest: serde_json::Value, files: Vec<(String, String)>) -> Result<(), String>

#[tauri::command]
async fn list_draft_plugins() -> Result<Vec<serde_json::Value>, String>

#[tauri::command]
async fn load_draft_plugin(id: String) -> Result<serde_json::Value, String>

#[tauri::command]
async fn delete_draft_plugin(id: String) -> Result<(), String>
```

### R7：草稿发布到团队

- 草稿项的"发布到团队"按钮 → 调用现有的 `/api/plugins/upload`
- 发布成功后：**保留本地草稿**，标记 `publishedToTeam: true`（在 `.meta.json`）
- 草稿列表显示"已发布"标签

## Acceptance Criteria

- [x] AI 创建插件后，点"保存草稿"成功写入本地文件系统 `{appDataDir}/plugins-draft/{id}/`
- [x] 关闭创建器后，草稿仍在本地保留
- [x] 插件中心"我的草稿"Tab 正确列出所有本地草稿
- [x] 草稿插件可以运行、测试（与正式插件行为一致）
- [x] 草稿插件可以"发布到团队"，上传后标记已发布
- [x] 草稿插件可以删除，本地文件被清理
- [x] 侧边栏草稿插件显示草稿徽章

## 非目标

- 本地草稿的版本管理（暂不支持草稿版本历史）
- 草稿的云同步（草稿仅存本地）
- 草稿的编辑功能（打开创建器继续修改，留待后续）

## 依赖与风险

**依赖**：

- Tauri 文件系统 API（`fs` 模块）
- `appDataDir` 路径解析

**风险**：

- 文件系统权限问题（部分企业环境可能限制 AppData 写入）
- 本地草稿与团队插件 ID 冲突（需要在发布时校验）
