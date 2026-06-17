# 修改已有插件 + 聊天引用插件

## Goal

两个子需求：
- **A. 修改已有插件**：从插件页「继续修改」进创建器时，先把云端 files 落盘到本地目录，让 AI 看到现有代码能改（而非重新生成）。新会话（不 resume 原创建会话）。
- **B. 聊天引用插件**：创建器 Composer 输入框支持 @触发选插件（自己的 team + 本地），选中后把该插件 manifest 摘要插入 prompt，让 AI 参考。

## 已确认事实（来自代码查证）

### A 修改已有插件
- **editInGenerator 已存在**（`Plugins.tsx:65`）：从 `plugin.files` 构造 draft（`turns:[]`）+ `setView('home')` 跳创建器。但**不落盘 files 到本地**——AI 进创建器看到空目录，会重新生成而非改。
- **后端 edit-draft 端点已存在**（`POST /api/plugins/:id/edit-draft`，`plugin.service.editPluginDraft`）：接收完整 manifest+files 更新，重置 reviewStatus=DRAFT。ensurePluginManager 作者校验 + PENDING 拒绝。
- **plugin.id 是 UUID**（schema `@default(uuid())`），含 `-`，`sanitize_plugin_id` 接受 `[A-Za-z0-9_-]`——可作本地目录名。
- **创建器 send**：`start_session` 时 `ensure_plugin_dir(plugin_id)` 建本地目录作 workspace，AI（claude）用 Read/Write 工具读写该目录。若目录已有文件，AI 能读到现有代码。
- **草稿恢复**：editInGenerator 设 `plugin_id=plugin.id`，创建器据此建本地目录。

### B 聊天引用插件
- **Composer**（`Composer.tsx`）：纯 Textarea + 选择器，无 @机制。`onInputChange` 写 input state，`onSend` 发送。
- **send(prompt)**（`PluginCreatorHome.tsx:700`）：input 作 prompt 传 start_session/send_input。
- **插件来源**：team 插件（`loadPlugins` 拉云端 `/api/plugins/mine`）+ 本地插件（`scanPluginStatus` 扫文件系统）。

## Requirements

### A 修改已有插件
- R1 editInGenerator 跳创建器前，先把云端 `plugin.files` 落盘到 `plugins_root/<plugin.id>/`（调 Rust 写文件命令或复用 ensure_plugin_dir + 逐文件写）。
- R2 落盘后跳创建器，AI 进 start_session 时 workspace=该目录，能 Read 现有文件并改。
- R3 落盘幂等：目录已有同名文件覆盖（保证是云端最新版本）。
- R4 不 resume 原会话（新会话），prompt 可带「这是现有插件，在此基础上修改」上下文（可选，AI 看 files 即知）。
- R5 改完上传走已有 edit-draft 端点（不新建，覆盖原插件）。

### B 聊天引用插件
- R6 Composer Textarea 输入 `@` 时弹 Popover 列插件（自己的 team + 本地插件），按名称筛选。
- R7 选中插件后在 input 插入 `@<plugin-name>` 标记，并记录引用的 pluginId 列表（attachedPlugins state）。
- R8 发送时把引用插件的 manifest 摘要（id/name/runtime_type/entry/capabilities）拼进 prompt 前面，让 AI 参考。
- R9 引用标记可视化：input 上方显示已引用插件 chip（可移除）。
- R10 @触发不影响正常输入（仅 @ 字符触发，选完继续输入）。

## Acceptance Criteria

- [ ] 插件页「继续修改」→ 云端 files 落盘本地 → 创建器 AI 能读到现有代码并改（而非重新生成）。
- [ ] 改完上传 → edit-draft 覆盖原插件。
- [ ] Composer 输入 @ → 弹插件选择（team + 本地）→ 选中插入标记。
- [ ] 已引用插件 chip 显示 + 可移除。
- [ ] 发送时 prompt 含引用插件 manifest 摘要。
- [ ] AI 收到引用信息能据此参考（如「做个类似的 @xxx」AI 知道 xxx 的结构）。
- [ ] cargo test（若 Rust 改）+ 前端 typecheck 通过。
- [ ] 不破坏现有创建/上传/对话流程。

## Out of Scope

- resume 原创建会话（需 plugin 记录存 session_id，改动大，本期不做）。
- @引用市场第三方插件（无源码，仅 team + 本地）。
- @引用插入完整源码（仅 manifest 摘要，省 token）。
- 修改已上架市场插件（治理约束，需先下架）。

## Notes

- 复杂任务，需 design.md + implement.md。
- A 改 Plugins.tsx editInGenerator + 可能加 Rust 批量写文件命令（或复用 read_local_plugin_file 的逆操作）。
- B 改 Composer.tsx（@触发 + Popover）+ PluginCreatorHome（attachedPlugins state + prompt 拼接）。
