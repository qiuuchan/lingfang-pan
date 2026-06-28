# 插件全链路测试 - Design

## Scope And Boundaries

- 前端应用：`apps/desktop` 的 React + Vite 网页前端，开发端口 `1420`。
- 后端边界：全部业务请求通过 `apps/desktop/src/lib/api.ts` 的 `api()` 拼接 `apiBase()`，目标后端为 `http://106.12.131.38:19006`。
- 测试边界：以浏览器人工/自动化调试验证链路，不修改源码作为首要目标；登录、创建、上传、运行、提交审核均只通过客户端网页触发，不用脚本/curl/接口调用绕过 UI；只有发现明确前端缺陷且用户批准时才进入修复。
- 凭据边界：用户提供的测试账号密码只在登录操作中使用，不落盘、不写入任务文档。

## Confirmed Technical Flow

1. 应用启动时读取 `public/app.config.json`，`api_base` 默认指向目标后端。
2. 登录页 `Auth.tsx` 调用 `POST /api/auth/login`，成功后 `applyCollabSession()` 保存 session。
3. 创建器 `FloatingCreator` 通过 AI agent 生成插件草稿，`stage_plugin` 只暂存到前端状态。
4. 右侧草稿面板提交时由网页 UI 调用 `submitStagedPlugin()`，再请求 `POST /api/plugins/upload`；测试只点击 UI，不直接调用该接口。
5. 插件中心的团队插件列表用于确认上传结果，刷新/打开动作也通过 UI 完成。
6. 作者操作中的市场提交流程由网页 UI 调用 `POST /api/plugins/{pluginId}/submit-marketplace`；只有提交后的平台审核“通过”动作可按用户允许使用 API。

## Test Data Strategy

- 使用一次性、可识别插件 ID，例如 `e2e-smoke-<timestamp>`。
- 推荐插件类型为 `client`，入口 `ui/index.html`，仅包含静态 HTML/CSS/JS 和 `ui.view` 能力。
- 避免使用 `llm.chat`、`net.fetch`、文件系统等能力，降低权限、费用和运行环境变量。

## Risk And Compatibility Notes

- Vite 网页环境不是完整 Tauri 壳，`saveDraftPlugin()` 依赖 Tauri invoke，可能不能用于网页测试；本次主路径绕过本地草稿保存，验证上传/团队/市场链路。
- 真实后端上的上传和市场审核是有副作用操作，可能留下插件记录或审核记录。
- 如果账号没有团队或市场发布权限，发布验收以“明确记录权限阻塞”为通过条件。
- 如果 AI 创建器依赖后端模型配置且不可用，只能改走页面可用的导入/上传入口；不得用直接 API 伪造创建/上传结果，需在报告中标注阻塞点。

## Rollback / Cleanup Considerations

- 如 UI 或接口提供删除/下架能力，可在用户要求时清理测试插件。
- 若没有删除能力，本次测试插件应通过名称/ID 标识，避免与真实插件混淆。
