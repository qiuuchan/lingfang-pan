# 技术设计：修改已有插件 + 聊天引用插件

## 架构与边界

两个子需求独立，改动：

### A 修改已有插件
- `apps/desktop/src-tauri/src/plugin_store.rs` — 新增 `write_plugin_files` 命令（批量写 files 到 plugin 目录）。
- `apps/desktop/src-tauri/src/main.rs` — 注册 write_plugin_files。
- `apps/desktop/src/lib/plugin-status.ts` — 新增 `writePluginFiles(pluginId, files)` 封装。
- `apps/desktop/src/pages/Plugins.tsx` — editInGenerator 先 writePluginFiles 落盘再跳创建器。

### B 聊天引用插件
- `apps/desktop/src/components/creator/Composer.tsx` — Textarea 加 @触发 + Popover 插件选择 + 引用 chip。
- `apps/desktop/src/pages/PluginCreatorHome.tsx` — attachedPlugins state + send 时拼 manifest 摘要进 prompt。

## A：修改已有插件

### Rust write_plugin_files 命令

plugin_store.rs 加（与 read_local_plugin_file 对称的写操作）：

```rust
/// 命令：批量写插件文件到 plugins_root/<plugin_id>/（修改已有插件时落盘云端 files）。
/// 流程：sanitize_plugin_id → ensure_plugin_dir → 逐文件写（路径白名单防穿越，只允许 plugin_dir 内）。
/// 幂等：覆盖同名文件（保证云端最新版本）。
#[tauri::command]
pub fn write_plugin_files(
    state: tauri::State<'_, PluginStore>,
    plugin_id: String,
    files: Vec<{ path: String, content: String }>,
) -> Result<(), String> {
    state.write_files(&plugin_id, &files)
}
```

`write_files` 方法：ensure_plugin_dir → 逐文件：`path` 经白名单（不含 `..` / 绝对路径，仅相对 plugin_dir）→ `fs::write(plugin_dir.join(path), content)`。创建子目录（如 `ui/`）。

**安全**：path 白名单防穿越（与 read_plugin_file 的 file 参数校验同款，但批量）。只写 plugin_dir 内。

### editInGenerator 改造

```ts
async function editInGenerator() {
  if (!plugin.files?.length) { toast.error('插件缺少安装文件'); return; }
  // 先落盘云端 files 到本地目录，让 AI 进创建器能读到现有代码。
  await writePluginFiles(plugin.id, plugin.files);
  setCurrentDraft({ id: plugin.id, status: plugin.status, files: plugin.files, turns: [], diagnostics: [], plugin_id: plugin.id });
  setView('home');
}
```

创建器 start_session 时 workspace=plugins_root/<plugin.id>/（已落盘 files），AI Read 工具看到现有代码，能改。改完上传走 edit-draft。

## B：聊天引用插件

### Composer @触发

Textarea `onChange` 检测：光标前最后一个 `@` 后无空格 → 弹 Popover（插件列表，按名称筛选）。
- 插件来源：PluginCreatorHome 传入 `availablePlugins`（team + 本地合并）。
- 选中：input 插入 `@<name>` + attachedPlugins 加该 pluginId。
- Popover 复用 shadcn Popover + Command（若有）或简单列表 + filter。

### 引用 chip 展示

Textarea 上方：已引用插件 chip 列表（`@ai-image-studio ×`），点 × 移除（从 attachedPlugins + input 去标记）。

### send 拼接 manifest 摘要

PluginCreatorHome send(prompt)：
- 若 attachedPlugins 非空，prompt 前拼：
  ```
  [引用插件参考]
  - ai-image-studio（python, entry=main.py, capabilities: code-assistant.run/net.fetch/...）
  [/引用插件参考]
  用户消息：<原 prompt>
  ```
- 摘要来自 plugin 的 manifest（team 从 files 解析 manifest，本地从 scan 的 manifest 字段）。

### attachedPlugins 数据

PluginCreatorHome 维护 `attachedPlugins: { id, name, summary }[]`。Composer 接收 + onAttach/onDetach 回调。send 时读 attachedPlugins 拼摘要。

## 兼容性与回滚

- A：write_plugin_files 新增命令，editInGenerator 加落盘步骤。回滚 = 删命令 + 还原 editInGenerator。
- B：Composer 加 @触发 + attachedPlugins state。无 @时行为不变。回滚 = 还原 Composer + 删 attachedPlugins。
- 不破坏现有创建/上传/对话。

## 风险点

- A 落盘 files 路径穿越：write_files 的 path 白名单严格校验（仅相对 plugin_dir，拒 `..`/绝对）。
- B @触发性能：每次 onChange 检测 @，轻量（正则 + Popover 开关），可忽略。
- B 引用摘要 token：每个插件摘要 ~100 token，引用多个时 prompt 增长。限制最多引用 5 个。
- B 插件列表获取：team + 本地合并，team 需 loadPlugins 已加载（PluginCreatorHome 已有）。
