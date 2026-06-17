# 修复重启后未完成草稿插件丢失（temp 目录空 manifest）

## Goal

修复用户反馈：「重启应用后，之前创建但还没上传的插件就没了，预览执行报『预览执行无法启动 / 读取 manifest.json 失败 os error 2』」。

实际根因：创建期 AI 会话失败/中断/无产出时，留下空的 `temp-<id>/` 目录（无 manifest.json），但草稿（按 sessionId 持久化）记了 `pluginId=temp-xxx`。重启后草稿恢复，pluginId 指向空目录，用户点「运行」→ Rust `start_plugin` 读 manifest → os error 2 → 刺眼的「预览执行无法启动」。

目标：让未完成的草稿插件重启后有清晰的可恢复路径，而非报错丢失感。

## 已确认事实（来自代码 + 文件系统查证）

- **创建期 temp 目录**：`main.rs:221` 无 plugin_id 时用 `temp-<secs>-<nanos>` 作 plugin_id，`ensure_plugin_dir` 落到 `plugins_root/temp-xxx/`。AI 会话在此目录写文件。
- **无 temp 清理逻辑**：Rust 侧 ensure_plugin_dir 只创建不清理，失败会话的空 temp 目录残留。
- **草稿持久化**：`conversations.ts` saveDraft/readDraft 按 sessionId 持久化，草稿含 pluginId。重启后恢复 pluginId=temp-xxx。
- **报错点**：`plugin_runner.rs:68` `parse_manifest` 读 `plugin_dir/manifest.json`，失败返回「读取 manifest.json 失败(...)」→ `start_plugin`(line 466) → 前端 `ScriptPreviewPanel.handleStart`(line 144) catch → `run_spawn_failed`「预览执行无法启动」。
- **文件系统实证**：plugins_root 下 3 个 temp-xxx 目录全部 manifest=False，其中 `temp-1781668389-893107900` files=0（完全空，报错的就是它），另两个 files=1 无 manifest。正式插件 ai-image、bc4f8e19-... 正常。
- **两条运行通道**：`startPlugin`（持久化，传 pluginId，读磁盘 manifest，报错点）vs `runPluginScript`（sandbox，传 files 草稿内容，不读磁盘）。错误发生在持久化通道。
- **scan_one_plugin**（plugin_store.rs）已有 incomplete 状态判定（缺 manifest/入口），但创建期草稿恢复不走扫描，直接用草稿 pluginId。

## Requirements

- R1（层1 Rust 友好错误）：`parse_manifest` 读 manifest 失败时，区分「文件不存在」与「JSON 非法」，文件不存在返回结构化错误（如 `manifest_missing` 前缀），前端 `handleStart` catch 到时显示「该插件未生成完成，请重新创建或继续对话让 AI 补全」而非「预览执行无法启动」。
- R2（层2 前端预防）：草稿恢复时，校验 pluginId 指向的目录是否含 manifest（调 scan_one_plugin 或 read_plugin_file 探测）。无效目录的草稿标记「未完成」，UI 显示引导（重新生成 / 继续对话），禁用「运行」按钮。
- R3（层3 清理残留）：应用启动时扫描 `plugins_root/temp-*` 目录，清理 files=0 的纯空目录（失败残留无价值）。files≥1 但无 manifest 的保留（可能有用户产出，由层2 引导处理）。
- R4 不破坏正常插件（已上传的正式插件、完整 temp 草稿不受影响）。
- R5 单测覆盖：parse_manifest 文件不存在分支、启动清理空 temp 目录、草稿恢复校验。

## Acceptance Criteria

- [ ] 创建一个插件会话但让 AI 不产出（或中断）→ 重启 → 该草稿不报 os error 2，而是显示「未生成完成，重新创建/继续对话」引导。
- [ ] 空的 `temp-xxx` 目录（files=0）在应用启动后被清理。
- [ ] files≥1 无 manifest 的 temp 目录不被清理，但草稿恢复标记未完成 + 禁用运行。
- [ ] 正常插件（已上传 / 完整草稿）运行不受影响。
- [ ] cargo test -p lingfang-desktop 通过（新增 Rust 测试）。
- [ ] pnpm -C apps/desktop typecheck + vitest 通过（新增前端测试）。

## Out of Scope

- 草稿恢复后自动重新触发 AI 生成（用对话历史 resume 重建）——复杂且 AI 不可复现，不做。改为引导用户手动继续对话。
- 清理 files≥1 无 manifest 的 temp 目录（可能有产出，保守保留）。
- macOS/Linux 路径差异（temp 目录逻辑跨平台一致）。

## Notes

- 复杂任务，需 design.md + implement.md。
- 跨 Rust（plugin_runner/plugin_store）+ 前端（PluginCreatorHome/ScriptPreviewPanel）。
- 修复前可先手动清理用户系统里现有的 3 个空 temp 目录（验证用）。
