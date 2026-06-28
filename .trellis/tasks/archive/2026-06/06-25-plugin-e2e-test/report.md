# 插件全链路测试报告

## 测试范围

- 前端：`apps/desktop` Vite 网页模式，`http://localhost:1420/`。
- 后端：`http://106.12.131.38:19006`。
- 账号：使用用户提供的测试账号登录，未在任务文档或源码中记录密码。
- 约束：登录、创建、上传、运行、提交市场审核均通过客户端网页 UI 完成；只有“审核通过”尝试使用 API。

## 测试插件

- 展示名：`E2E Smoke 20260625 2155`
- Manifest ID：`e2e-smoke-20260625-2155`
- 后端插件 ID：`d2a63bc4-5121-4f9f-8703-c016082faff8`
- 类型：`client`
- 入口：`ui/index.html`
- 能力：`ui.view`

## 结果

- [x] 前端 dev server 启动成功。
- [x] 登录成功，进入团队 `铂觅`，角色为 `TEAM_ADMIN`。
- [x] 通过网页 AI 创建器生成草稿。
- [x] 初次草稿缺少 `manifest.json`，通过创建器后续对话修复后通过结构检查。
- [x] 新增网页按钮后，通过客户端网页点击“提交到团队空间”，上传成功。
- [x] 插件出现在“团队插件”列表，状态先为“草稿”。
- [x] 通过客户端网页点击团队插件，成功进入插件运行器，并加载 `E2E Smoke 20260625 2155` iframe。
- [x] 通过客户端网页点击“提交市场审核”，插件状态变为“审核中”。
- [ ] “审核通过”尝试使用 API，但当前测试账号不是平台管理员，后端返回 `403`，插件保持“审核中”。

## 本次修复

1. `apps/desktop/src/components/creator/CreatorDraftPanel.tsx`
   - 增加“提交到团队空间”按钮，复用已有 `submitStagedPlugin()` 上传逻辑。
   - 保留“保存草稿到本地”，并明确该动作需要桌面环境。
   - 原因：Vite 网页模式没有 Tauri `invoke`，只能保存本地草稿会阻断网页端全链路。

2. `apps/desktop/src/pages/plugins/use-plugin-center.ts`
   - 在纯网页模式下跳过团队插件打开前的本地持久化步骤，直接使用后端返回的内联文件进入运行器。
   - 桌面 Tauri 环境仍保留原有写入本地插件目录行为。
   - 原因：Vite 网页模式没有 Tauri 文件系统能力，原运行路径会被 `ensurePluginPackagePersisted()` 阻断。

## 发现的问题

- “我的草稿”仍依赖 Tauri 草稿文件系统能力，网页模式会记录 `Cannot read properties of undefined (reading 'invoke')`，当前主链路已绕过本地草稿。
- “团队插件”页会显示“内置插件加载失败：需在 灵坊 桌面环境中运行”，这是内置插件列表依赖 Tauri 的网页模式降级问题，不影响团队插件云端列表。
- 插件审核通过需要平台管理员权限；当前账号为团队管理员，API 审核通过返回 `403`。

## 验证

- `pnpm -C apps/desktop typecheck` 通过。
- 编辑文件无 IDE 诊断。
