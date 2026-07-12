# 桌面端本地插件导入与目标发布

## Goal

让用户在桌面端从 `.lfplugin` 或其他编程软件产出的源码目录进入统一发布流程，安全保留二进制文件，选择团队或市场目标，并在“已发布”工作台管理 package/release/listing 状态和来源。

## Requirements

- 使用 Tauri 原生文件选择器选择 `.lfplugin`，不再要求用户手填路径；开发/测试环境保留路径输入回退。
- 复用现有源码目录导入，文件上限与 v4 对齐为 1500，保留真实 `dist/build` 文件。
- 修复二进制 `DraftFile.binary` 在 workspace 写入、再次读取、Creator 刷新和重新保存过程中的丢失。
- DraftWorkspace 持久化 source kind/source label；Creator、外部目录、本地 artifact、installation copy 使用不同默认来源。
- Tauri 抽取共享流式 artifact uploader，新增 direct local artifact publish command，保留进度与本地 inspect。
- 共享发布 Dialog 展示 manifest 摘要、来源、目标和市场价格；Creator 与草稿页使用相同目标语义。
- 市场流程先发布团队 release 再提审；提审失败显示部分成功并允许从发布管理只重试提审。
- DraftPlugins 增加“本地草稿 / 已发布”视图；已发布按 package 展示来源和四轴状态，详情按需加载 releases。
- 提供 package archive/restore、release yank/restore、submit/withdraw、owner delist/relist 操作，按钮严格按状态和权限显示。
- Plugin Center Team/Market 与版本历史展示发布来源；Installed 继续展示安装来源，文案不能混淆。
- Plugin Center 和草稿导入入口都使用文件选择 helper。

## Acceptance Criteria

- [x] 用户无需手输路径即可选择 `.lfplugin`，并在上传前看到名称、版本、runtime 和来源。
- [x] 外部源码目录与 `.lfplugin` 都能发布团队或提交市场。
- [x] 市场提审失败不会重复上传同版本，已发布列表可单独重试。
- [x] PNG/字体等非 UTF-8 文件经过导入、保存、重新打开、再次保存和 pack 后字节一致。
- [x] `dist/build` 中的入口文件不再被目录导入器丢弃，最多支持 1500 文件。
- [x] Workspace ledger 旧数据可读取，新数据保留来源；任何云端 payload 不含本机绝对路径。
- [x] Creator、草稿页和 direct upload 产生正确 sourceKind/sourceLabel。
- [x] 已发布列表可恢复已归档 package 和已撤回 release，不会因 catalog 隐藏而失去管理入口。
- [x] 所有状态动作失败时保持当前 UI 状态并显示后端错误；提交期间防重复操作。
- [x] desktop tests/typecheck/build、cargo tests 和关键 Playwright 流程通过。

## Out Of Scope

- 在插件 iframe/SDK 内开放发布 capability。
- 本机 installation enable/disable。
- 改变插件运行时或依赖准备策略。

## Planning Status

- 依赖 `07-12-plugin-registry-provenance-lifecycle` 的 contract/API 完成后实施。
