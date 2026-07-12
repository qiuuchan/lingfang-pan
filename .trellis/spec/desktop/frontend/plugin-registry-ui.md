# Plugin Registry UI

## Scenario: Installed, Remote Catalogs, And Drafts

### 1. Scope / Trigger

- 修改 `run-plugins`、`draft-plugins`、creator 往返、固定/最近或下载进度时适用。

### 2. Signatures

- `PluginCenterTab = installed | team | market`，不得恢复 draft/local 第四 Tab。
- `View` 独立包含 `draft-plugins`；creator 编辑 view 为 `develop-plugins`。
- 前端边界集中在 `src/lib/plugin-registry.ts`，Tauri/HTTP payload 不在组件内重复定义。

### 3. Contracts

- Installed 只读本机 ledger，必须能在远端目录失败时独立显示和运行。
- Team/Marketplace 只显示可下载 release，不返回/持久化本机状态；UI 通过 packageId 与 ledger 本地 join。
- 远端未下载项没有运行按钮；安装项可运行、回滚、复制为草稿、卸载，builtin 不可卸载。
- 本地导入在 Installed 页生成 installation；草稿导入在 Draft 页生成 workspace。
- Draft 页提供搜索/状态筛选/创建/继续编辑/预览/发布/导入/导出/删除；恢复 `conversationId`，删除时清关联 localStorage conversation。
- pin/recent 只持久化 installationId，并在 ledger 变化时清理失效项。
- 所有运行入口必须汇入 `AppContext.setRunningPlugin`：先按 installationId 重新读取 ledger，team origin 在线调用 runtime-access，再决定 active/pending payload，禁止 pinned/recent/standalone 绕过。
- pending client/cloud 只能先预览；client 在 iframe `onLoad`、cloud 在 Runner 成功挂载后调用显式 activate。加载或激活失败时 discard pending 并恢复 active；Node/Python 由 Rust 成功 spawn 后激活。

### 4. Validation & Error Matrix

- team catalog 网络错误 -> Installed 仍显示，远端错误单独提示。
- 下载/SHA/解压失败 -> 保留旧安装并展示阶段错误。
- pending client/cloud 的入口加载或激活失败 -> 丢弃 pending、恢复 active，并显示可恢复错误。
- 付费未购 -> “购买并下载”；已 entitlement -> “下载/更新”。
- installed 编辑 -> 先 copy workspace，禁止直接写发行目录。

### 5. Good/Base/Bad Cases

- Good：离线打开 Installed 可运行已购市场插件；Team 插件运行仍先在线授权。
- Base：release 已是 active 或 pending 时显示“已下载”，catalog row 没有运行入口。
- Bad：把 conversation 当草稿行，或让“发布成功”删除 workspace。

### 6. Tests Required

- 三 Tab 边界、未下载不可运行、本地/团队/市场来源 badge、购买/更新/进度错误。
- draft route、搜索筛选、workspace/creator 往返、conversation 恢复/删除、发布后保留。
- 远端失败时 installed 独立加载；pin/recent 清理卸载 installationId。
- pinned/recent/Home/CommandPalette/standalone 均走统一 runtime-access；pending runtime helper 覆盖 client/cloud，脚本 runtime 不在前端提前激活。

### 7. Wrong vs Correct

Wrong：`Promise.all(local, team, market)` 任一远端失败就清空整个插件中心。

Correct：先独立加载 local ledger，远端 catalog 使用单独 loading/error 状态。
