# 技术设计：修复重启后未完成草稿插件丢失

## 架构与边界

跨 Rust + 前端三层修复，改动范围：

- `apps/desktop/src-tauri/src/plugin_runner.rs` — 层1：`parse_manifest` 区分文件不存在 vs JSON 非法，返回结构化错误前缀。
- `apps/desktop/src-tauri/src/plugin_store.rs` — 层3：`PluginStore::new` 初始化时清理空 temp 目录；层2 复用 `scan_one_plugin` 探测目录有效性。
- `apps/desktop/src/components/creator/panels/ScriptPreviewPanel.tsx` — 层1 前端：`handleStart` catch `manifest_missing` 前缀显示引导。
- `apps/desktop/src/pages/PluginCreatorHome.tsx` — 层2：草稿恢复时校验 pluginId 目录有效性，标记未完成。
- `apps/desktop/src/lib/plugin-status.ts` — 层2：复用 `scanPluginStatus` 探测单插件状态（已有，可能需加 scanOne）。

## 层1：Rust 友好错误（parse_manifest）

当前 `plugin_runner.rs:68`：
```rust
let raw = std::fs::read_to_string(&manifest_path).map_err(|e| {
    format!("读取 manifest.json 失败（{}）：{e}", manifest_path.display())
})?;
```

改为区分错误类型，文件不存在返回 `manifest_missing:` 前缀（与 `interpreter_missing:` 同款前缀约定，前端可识别）：
```rust
let raw = std::fs::read_to_string(&manifest_path).map_err(|e| {
    if e.kind() == std::io::ErrorKind::NotFound {
        format!("manifest_missing:插件未生成完成（缺少 manifest.json），请重新创建或继续对话让 AI 补全")
    } else {
        format!("读取 manifest.json 失败（{}）：{e}", manifest_path.display())
    }
})?;
```

前端 `ScriptPreviewPanel.handleStart`(line 158) 已有 `interpreter_missing:` 前缀分支，加 `manifest_missing:` 分支：
```ts
} else if (message.startsWith('manifest_missing:')) {
  setPersistentRun({ status: 'error', error: { /* 引导文案 */ } });
}
```

## 层2：前端草稿恢复校验

`PluginCreatorHome` 草稿恢复时（读 activeId → readDraft → setCurrentDraft + setPluginId），加校验：
- 若恢复的草稿含 pluginId，调 `scanPluginStatus(pluginId)` 或 `read_plugin_file(pluginId, 'manifest.json')` 探测目录有效性。
- 无效（manifest 不存在）→ 标记草稿 `status: 'incomplete'` + 设 `pluginIncomplete: true` state。
- UI：`ScriptPreviewPanel` 接 `pluginIncomplete` prop，为 true 时禁用「运行」按钮 + 显示「该插件未生成完成，继续对话让 AI 补全」引导。

复用现有：`scan_one_plugin`（plugin_store.rs）已返回 incomplete/error 状态。前端 `scanPluginStatus`（plugin-status.ts）已有。层2 新增一个「探测单插件」调用（若 scanPluginStatus 只扫全部，加 scanOnePlugin）。

**注意**：草稿恢复校验是异步的（要调 Tauri 命令），不能阻塞渲染。用 useEffect 在恢复后探测，探测完再设 pluginIncomplete。

## 层3：启动清理空 temp 目录

`PluginStore::new`(plugin_store.rs:148) 初始化末尾加清理：
```rust
pub fn new(app_data_dir: &Path) -> Result<Self, String> {
    // ... 现有初始化 ...
    self.cleanup_empty_temp_dirs();
    Ok(self)
}

/// 清理 plugins_root 下 temp-* 空目录（创建期 AI 会话失败/中断的残留，无 manifest 无文件）。
/// files≥1 但无 manifest 的 temp 目录保留（可能有用户产出，由前端层2 引导处理）。
fn cleanup_empty_temp_dirs(&self) {
    let root = self.plugins_root();
    let Ok(entries) = std::fs::read_dir(&root) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name_str) = name.to_str() else { continue };
        if !name_str.starts_with("temp-") { continue; }
        let path = entry.path();
        // 仅清理完全空目录（无任何文件/子目录）。
        let Ok(inner) = std::fs::read_dir(&path) else { continue };
        if inner.count() == 0 {
            let _ = std::fs::remove_dir(&path);  // remove_dir（非 remove_dir_all），仅空目录
        }
    }
}
```

**安全**：`remove_dir`（非 `remove_dir_all`）只删空目录，非空目录报错忽略，绝不会误删有内容的目录。`temp-` 前缀白名单，不碰正式插件目录。

## 数据流

- 层3：启动 → PluginStore::new → cleanup_empty_temp_dirs → 空 temp-xxx 删除。
- 层2：恢复草稿 → useEffect 探测 pluginId 目录 → scanOnePlugin → 无效则 pluginIncomplete=true → UI 禁运行 + 引导。
- 层1：用户点运行（若层2 漏判，目录已空）→ start_plugin → parse_manifest → manifest_missing 前缀 → 前端引导（而非 os error 2）。

三层互为兜底：层3 清空残留、层2 预防点到运行、层1 兜底报友好错误。

## 兼容性与回滚

- 层3 只删空 temp 目录，正式插件/有内容 temp 不受影响。回滚 = 删 cleanup_empty_temp_dirs 调用。
- 层1 错误前缀是新增，前端旧逻辑（无 manifest_missing 分支）走默认 run_spawn_failed，不破坏。回滚 = 还原 parse_manifest。
- 层2 是新增校验，不影响正常草稿。回滚 = 删 useEffect 探测。

## 风险点

- 层2 异步探测期间，用户可能已点运行 → 层1 兜底。可接受（短暂窗口，层1 兜底）。
- 层3 `read_dir().count()` 在大目录可能慢，但 plugins_root 通常插件数有限（<100），可忽略。
