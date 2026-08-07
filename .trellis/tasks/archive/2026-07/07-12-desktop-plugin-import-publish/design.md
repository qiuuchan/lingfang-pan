# Design: Desktop Import And Target Publishing

## Local File Selection

添加 `@tauri-apps/plugin-dialog` / `tauri-plugin-dialog`，初始化 plugin 并授予最小 `dialog:allow-open` capability。`selectPluginArtifact()` 在 Tauri 中打开只允许 `.lfplugin` 的文件选择器；非 Tauri 环境返回 null，由 Dialog 中的路径 input 继续支持测试。

源码目录仍使用 `<input webkitdirectory>`，因为浏览器 File API 能直接读取选择结果并沿用现有 creator 逻辑。

## Binary File Payload

Rust 新增 tagged payload command：

```ts
type LocalPluginFilePayload = {
  path: string;
  content: string;
  binary: boolean;
};
```

Rust 对 UTF-8 文件返回原文，对非 UTF-8 返回标准 base64。前端 `readWorkspaceFiles()` 成为唯一读取 helper；`persistDraftWorkspace()` 将文本批量写入，binary 文件走 `write_plugin_file_bytes`。

Creator 的 workspace refresh、Draft workspace load 和 copy/edit 都复用这两个 helper，避免占位文本覆盖真实资产。

## Workspace Provenance

`DraftWorkspace` ledger 增加 serde-defaulted `sourceKind/sourceLabel`：

- AI 创建：`LINGFANG_CREATOR / 灵枋创建器`
- 外部目录：`EXTERNAL_TOOL / 用户填写或 外部开发工具`
- `.lfplugin` 导入 workspace：`LOCAL_ARTIFACT`
- installation copy：`COPIED_INSTALLATION`
- 旧 ledger：`UNKNOWN`

`StagedPlugin` 增加不写入 manifest 的 provenance 字段；conversation localStorage 可直接序列化。发布 Dialog 允许修正 label，但不上传本机路径。

## Tauri Upload

`network.rs` 抽取：

```rust
upload_artifact_file(path, connection, package_id, provenance, on_event)
```

- `publish_draft_workspace`：pack + ensure publishable + upload + mark workspace published。
- `publish_local_artifact`：inspect existing file + upload，不创建 workspace/installation。
- source label 用 base64url header，kind/channel 用 ASCII header。

## Publish Orchestration

前端 `publishPluginRelease()` 返回 team publish 结果；`submitReleaseToMarketplace()` 独立。共享 Dialog 维护：

```text
idle -> inspecting -> uploading -> team_published -> submitting_market -> done
                                           \-> market_failed(retryable)
```

市场失败时保留 release ID，重试按钮只调用 submit endpoint。关闭 Dialog 后也可从 PublishedPluginList 对 DRAFT/REJECTED release 提审。

## UI Layout

- DraftPlugins 顶部使用 Tabs：本地草稿 / 已发布。
- “上传本地插件”打开共享 Dialog；“导入为草稿”保留独立命令但复用 file picker。
- Published list 每 package 一行，显示 package status、latest release/source、pending count、listing status。
- Detail Dialog/Sheet 展示 versions；动作位于选中 release/package 上下文。
- CreatorDraftPanel 的主发布按钮打开同一目标 Dialog，不在面板常驻多个发布按钮。
- PluginCenter catalog 只补来源 badge/文字，仍保持消费入口职责。

## Permissions

UI 用 `session.permissions` 门控：

- upload target：`team.plugin.upload`
- market target/submit/withdraw/listing：`team.plugin.submit_marketplace`
- package status：`team.plugin.edit_metadata`
- release status：`team.plugin.edit_draft`
- price：`team.plugin.edit_price`

后端错误仍完整显示，前端门控不替代授权。

## Tests

- Rust binary tagged payload、publish headers、direct artifact upload helper。
- Frontend publish state reducer/partial failure、permission matrix、source labels、binary helper calls。
- Import-local 1500 files and dist/build retention。
- Playwright: direct artifact dialog, team target, market target partial failure, published management actions。
