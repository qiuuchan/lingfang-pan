# 执行计划：修复重启后未完成草稿插件丢失

## 层3：启动清理空 temp 目录（先做，Rust 独立）

- `apps/desktop/src-tauri/src/plugin_store.rs`：
  - `PluginStore::new` 末尾调 `cleanup_empty_temp_dirs()`。
  - 新增 `fn cleanup_empty_temp_dirs(&self)`：扫 `plugins_root/temp-*`，`read_dir().count()==0` 的用 `remove_dir`（非 remove_dir_all，只删空目录）删，错误忽略。
- 单测：`plugin_store.spec`（或内联 #[cfg(test)]）加 `cleanup_empty_temp_dirs` 测试——造 temp-1(空)/temp-2(有文件)/正式目录，验证只删空 temp-1。

**验证**：`cargo test -p lingfang-desktop`（plugin_store 模块）。

## 层1：Rust parse_manifest 友好错误 + 前端 catch

- `apps/desktop/src-tauri/src/plugin_runner.rs:68` `parse_manifest`：
  - `read_to_string` 失败时，`e.kind() == NotFound` → 返回 `manifest_missing:<引导文案>` 前缀；其余错误保留原格式。
- `apps/desktop/src/components/creator/panels/ScriptPreviewPanel.tsx:158` `handleStart`：
  - 加 `manifest_missing:` 前缀分支，显示「插件未生成完成，请继续对话让 AI 补全」引导（与 interpreter_missing 同款 setPersistentRun error 态）。
- 单测：`plugin_runner.rs` 内联测试加 `parse_manifest` 文件不存在 → 错误含 `manifest_missing` 前缀。

**验证**：`cargo test -p lingfang-desktop`（plugin_runner 模块）。

## 层2：前端草稿恢复校验

- `apps/desktop/src/pages/PluginCreatorHome.tsx`：
  - 草稿恢复 useEffect（读 activeId → setCurrentDraft + setPluginId）后，加探测：若 pluginId 非空，调 `readLocalPluginFile(pluginId, 'manifest.json')`，失败（抛错）→ `setPluginIncomplete(true)`，成功 → `setPluginIncomplete(false)`。
  - 新增 `pluginIncomplete` state，传给 ScriptPreviewPanel。
- `apps/desktop/src/components/creator/panels/ScriptPreviewPanel.tsx`：
  - 接 `pluginIncomplete` prop，true 时禁用「运行」按钮 + 显示引导横幅「该插件未生成完成，继续对话让 AI 补全 manifest」。
- 复用：`readLocalPluginFile`（plugin-status.ts:193，已封装 read_plugin_file Tauri 命令）。

**验证**：`pnpm -C apps/desktop typecheck` + `pnpm -C apps/desktop test`（若加前端测试）。

## 实现顺序

1. 层3（Rust 清理）+ 单测 → cargo test
2. 层1（Rust 错误 + 前端 catch）+ 单测 → cargo test + typecheck
3. 层2（前端恢复校验）→ typecheck
4. 手动验证：造一个空 temp 目录 → 重启 → 确认被清理；草稿恢复指向无效目录 → 确认显示引导而非报错。

## 验证命令

- Rust：`cargo test -p lingfang-desktop`（plugin_store + plugin_runner 模块测试）
- 前端：`pnpm -C apps/desktop typecheck` + `pnpm -C apps/desktop test`
- 手动：删 manifest 造空 temp 目录 → 重启验证清理 + 草稿恢复引导

## 风险与回滚点

- 层3 `remove_dir` 只删空目录，非空报错忽略，安全。回滚 = 删 cleanup 调用。
- 层1 错误前缀新增，前端无对应分支时走默认（不破坏）。回滚 = 还原 parse_manifest。
- 层2 异步探测有短暂窗口（用户秒点运行），层1 兜底。回滚 = 删探测 useEffect。
