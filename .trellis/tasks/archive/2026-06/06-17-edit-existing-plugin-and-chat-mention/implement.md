# 执行计划：修改已有插件 + 聊天引用插件

## 步骤 1：A — Rust write_plugin_files 命令

- `plugin_store.rs`：加 `write_files` 方法（ensure_plugin_dir → 逐文件 path 白名单 + fs::write + 建子目录）+ `write_plugin_files` 命令。
- `main.rs`：注册 write_plugin_files。
- 单测：write_files 写多文件 + 子目录 + path 穿越（`../`）拒绝 + 幂等覆盖。
- `plugin-status.ts`：加 `writePluginFiles(pluginId, files)` 封装。

## 步骤 2：A — editInGenerator 落盘

- `Plugins.tsx` editInGenerator：先 `writePluginFiles(plugin.id, plugin.files)` 落盘，再 setCurrentDraft + setView('home')。
- 落盘失败 toast 提示（不阻断跳转？还是阻断？——阻断，落盘失败 AI 看不到现有代码）。

## 步骤 3：B — Composer @触发 + 引用

- `Composer.tsx`：
  - 接 `availablePlugins` + `attachedPlugins` + `onAttach` + `onDetach` props。
  - Textarea onChange 检测 @触发 → Popover 列插件（filter by name）。
  - 选中 → onAttach(plugin) + input 插入 `@<name>`。
  - Textarea 上方引用 chip 列表（onDetach 移除）。
- `PluginCreatorHome.tsx`：
  - `attachedPlugins` state。
  - `availablePlugins`：合并 team 插件（loadPlugins）+ 本地插件（scanPluginStatus）。
  - send 时 attachedPlugins 非空 → prompt 前拼 manifest 摘要。

## 步骤 4：B — manifest 摘要拼接

- `PluginCreatorHome.tsx` send：attachedPlugins 每个取 manifest 摘要（team 从 files parseManifest，本地从 scan manifest）→ 拼 `[引用插件参考]...[/引用插件参考]\n用户消息：<prompt>`。
- 限制最多 5 个引用。

## 验证命令

- Rust：`cargo test -p lingfang-desktop`（write_files 测试）
- 前端：`pnpm -C apps/desktop typecheck` + `pnpm -C apps/desktop test`
- 手动：A 改已有插件 AI 能读现有代码；B @引用插入摘要 AI 收到。

## 实现顺序

1. 步骤 1（Rust write_plugin_files）+ 单测 → cargo test
2. 步骤 2（editInGenerator 落盘）→ typecheck
3. 步骤 3（Composer @触发）→ typecheck
4. 步骤 4（manifest 摘要拼接）→ typecheck
5. 手动验证 A + B

## 风险与回滚点

- write_files path 白名单防穿越 → 严格校验。回滚 = 删命令。
- @触发不影响正常输入 → 仅 @ 字符触发。回滚 = 还原 Composer。
- 引用摘要 token → 限 5 个。回滚 = 删拼接。
