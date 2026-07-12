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

## Scenario: Local Artifact Publishing And Lifecycle Workbench

### 1. Scope / Trigger

- 修改本地 `.lfplugin` 选择、Creator/草稿发布、已发布治理、来源展示或市场提审重试时适用。

### 2. Signatures

- Native picker：`selectPluginArtifact() -> Promise<string | null>`，Tauri 使用 `@tauri-apps/plugin-dialog.open()`；浏览器返回 `null` 并保留路径输入测试回退。
- 发布编排：`publishPluginRelease({ target, publishTeam, priceCents, onState }) -> PluginPublishState`。
- 部分成功重试：`retryMarketplaceSubmission(failedState, priceCents?, onState?)`，只能接受带 `result.release.id` 的 `market_failed`。
- 管理 API：`listPluginManagement`、`getPluginPackageDetail`、`updatePluginPackageStatus`、`updatePluginReleaseStatus`、`submit/withdrawReleaseToMarketplace`、`updateOwnerMarketplaceStatus`。
- 发布来源：`sourceKind + sourceLabel + ingestChannel`；安装来源继续使用 installation origin，不得复用发布来源文案。

### 3. Contracts

- `.lfplugin` 上传前必须 inspect 并显示 name/version/runtime/entry/fileCount；路径变化或检查失败必须清空旧摘要，未 inspect 不可发布。
- 市场目标固定为“先生成不可覆盖的团队 release，再提交该 release 审核”。提审失败保留 release ID，关闭或重试都不得重新上传同版本。
- 提交响应丢失时按 package detail 对账；同一 release 已为 `PENDING/APPROVED` 视为提交成功。
- `DraftPlugins` 只含“本地草稿 / 已发布”两个工作台 Tab；已发布详情按需加载 releases，并独立呈现 package/release/review/listing 四轴状态。
- package 有待审 release 时不能归档；归档 package 内的 yanked release 不能恢复；owner relist 只在 package active 且存在 approved/current release 时开放。
- source kind 使用共享映射，source label 最长 80 字且不得携带本机绝对路径；发布来源 badge 同时显示 ingest channel。
- 小于等于 `767px` 时 App 初始及跨入断点会自动折叠侧栏到 56px；用户仍可从标题栏显式展开。

### 4. Validation & Error Matrix

- 非 Tauri -> picker 返回 `null`，不弹错误；原生取消 -> `null`。
- 路径为空或摘要为空 -> 发布按钮禁用；检查失败 -> 错误可见且旧摘要不可继续使用。
- 团队上传失败 -> `team_failed`，没有可重试 release；市场提审失败 -> `market_failed`，显示“只重试市场提审”。
- 状态 API 失败 -> 保留当前 UI 投影并展示后端 message；成功后同时刷新 manage list 与已打开 detail。
- `DELISTED + delistedBy=PLATFORM` -> owner 不可 relist；显示平台下架方和原因。

### 5. Good/Base/Bad Cases

- Good：外部 IDE 生成 `.lfplugin` -> 原生选择 -> inspect -> 团队发布 -> 市场提审失败 -> 只重试提审，Tauri upload 仅一次。
- Base：Creator 草稿发布到团队，workspace 保留，已发布列表立即刷新并显示“灵枋创建器 · 桌面端”。
- Bad：路径改变后继续显示上一个 artifact 摘要，或提审失败后再次调用 `publish_local_artifact`。

### 6. Tests Required

- Vitest：官方 picker/cancel/browser fallback、provenance 清理、publish reducer、丢失响应对账、tagged binary workspace round trip。
- Playwright：本地 artifact inspect、市场部分成功与仅重试、已发布详情、`1440x900` 与 `390x844` 的无溢出和主内容可读宽度。
- 门禁：`pnpm -C apps/desktop test`、`typecheck`、`vite:build`。

### 7. Wrong vs Correct

Wrong：组件各自拼 Tauri/API payload，市场失败时重新调用 workspace/artifact upload，并用本地路径充当 source label。

Correct：组件只调用 `plugin-registry.ts`；团队 release 是重试锚点，来源经 `normalizePluginProvenance` 清理，市场重试只调用 submit endpoint。
