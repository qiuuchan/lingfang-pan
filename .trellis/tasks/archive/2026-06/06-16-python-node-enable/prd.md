# Python/Node 插件进入后触发启用

## Goal

已安装插件列表（`Plugins.tsx` → `Runner`）目前只支持 `client` runtime（iframe 加载 HTML）。`nodejs`/`python` runtime 插件进入后无运行入口（只能回创建器预览）。本任务让 nodejs/python 插件在已安装列表"进入/使用"后，复用现有脚本运行能力（probe → run → 回显），缺失运行时时引导安装。

## Context

- 现状 Runner（Plugins.tsx:21-82）仅渲染 iframe（client runtime）；nodejs/python 无对应分支。
- 创建器已有完整的脚本运行组件 `ScriptPreviewPanel`（probe 解释器 → `run_plugin_script` → 终端回显 + 缺失引导），逻辑成熟可复用。
- 脚本运行封装：`runPluginScript`（plugin-script.ts:65-118）、`probeScriptRuntime`（plugin-script.ts），Rust 命令 `run_plugin_script` / `probe_script_runtime` / `install_runtime`（main.rs）。
- manifest 字段 `runtime_type`（client/cloud/nodejs/python）、`entry`、`capabilities`。

## Requirements

- R3.1 Runner 据 `plugin.runtime_type` 分派：`client` 维持 iframe；`nodejs`/`python` 走脚本运行视图（复用 ScriptPreviewPanel 或抽取共享组件）。
- R3.2 进入 nodejs/python 插件时先 probe 本地 node/python：缺失则展示安装引导（指向设置页 cli tab 的 `install_runtime`，或现有 ErrorBubble 的 interpreter_missing 引导），不报错白屏。
- R3.3 就绪后提供"运行/启用"按钮，一次性执行 entry 脚本，终端回显 stdout/stderr/退出码/耗时（与创建器预览一致体验）。
- R3.4 "启用"语义对齐：脚本型插件本期为"按需运行"（无常驻进程），按钮文案可用"运行"或"启用"；治理层 ENABLED/DISABLED（PluginList 的 PluginStatusToggle）保持不变。
- R3.5 cloud runtime 维持现状（不在桌面壳本地运行范围），进入时给说明而非空 iframe。

## Acceptance Criteria

- [ ] 已安装的 nodejs 插件进入后显示脚本运行视图，probe node → 可运行 → 回显输出
- [ ] 已安装的 python 插件同理
- [ ] 本地无 node/python 时显示安装引导（可跳设置 cli tab）
- [ ] client runtime 插件行为回归不变（iframe）
- [ ] cloud runtime 进入有友好说明
- [ ] lint/type-check 通过

## Design

- **组件抽取**：将 ScriptPreviewPanel 的核心（probe + run + 终端回显 + 缺失引导）从"创建器预览"语境抽为可复用的 `ScriptRunner` 组件（或直接让 Runner 内联渲染 ScriptPreviewPanel，传 `files`/`runtime`）。优先复用，避免重复造轮子。
- **Runner 分派**：Plugins.tsx Runner 内据 `plugin.runtime_type`：
  - `client` → 现有 iframe（不变）
  - `nodejs`/`python` → `<ScriptPreviewPanel files={plugin.files} runtime={...} />`（或抽取版）
  - `cloud` → 说明卡片
- **files 来源**：LoadedPlugin.files 已内联（loadPluginDocument），无需额外拉取。
- **拖动**：RunnerHeader 顶部条若需可拖动，归并到 R7 统一处理（本任务不加 drag-region，留给 R7）。

## Files

- `apps/desktop/src/pages/Plugins.tsx`（Runner 分派）
- 可能新增 `apps/desktop/src/components/ScriptRunner.tsx`（若抽取）
- 复用 `apps/desktop/src/components/creator/panels/ScriptPreviewPanel.tsx`、`apps/desktop/src/lib/plugin-script.ts`

## Notes

- 中等复杂度，design 已给出。
- 与 R2（改名）协同：进入插件的入口文案若涉及"预览"可一并改"使用"。
- 依赖现有 Rust 命令，无需后端改动。
