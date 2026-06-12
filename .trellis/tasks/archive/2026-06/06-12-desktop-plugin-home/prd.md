# 插件创建首页

## Goal

将用户端默认首页重构为 AionUi 风格的插件创建工作台：用户进入后直接描述想创建的插件，选择真实本地 CLI 工具和模型，看到生成过程、预览、云端上传状态、市场提交状态和最近插件。

## Confirmed Facts

- `apps/desktop/src/App.tsx` 当前默认进入团队空间。
- `apps/desktop/src/pages/Generator.tsx` 已有对话式插件生成、预览、发布到旧服务端的能力。
- `apps/desktop/src/pages/Plugins.tsx` 和 `PluginList.tsx` 已有插件运行和列表展示。
- `apps/desktop/src/pages/Settings.tsx` 已有模型选择 UI 模式可复用。
- 当前基础 UI 使用 shadcn/base-ui 风格组件。

## Requirements

- 登录后默认进入插件创建首页。
- 首页展示“今天想创建什么插件？”Hero、大输入框、快捷模板、工具选择、模型选择。
- 首页对话区展示用户输入、真实 CLI 输出、阶段、错误和生成结果。
- 预览区展示 iframe 预览、manifest 摘要、capability badge、源码和校验诊断。
- 云端分享区展示未生成、可上传、已团队共享、待审核、已公开、已驳回等状态。
- 最近插件区展示最近运行、创建、上传、继续修改记录。
- 创建/预览/上传/提交市场必须在一条主流程里完成。
- 使用现有 UI primitives，必要时只引入轻量开源聊天 primitives。

## Acceptance Criteria

- [ ] 登录并完成 onboarding 后默认进入插件创建首页。
- [ ] 首页能直接输入插件需求并开始生成。
- [ ] 用户能选择 Claude Code、Codex、OpenCode 和模型。
- [ ] 真实 CLI 输出能在对话区显示。
- [ ] 生成结果能预览、查看源码和校验诊断。
- [ ] 校验通过后能上传云端团队共享。
- [ ] 上传成功后能显示云端 plugin id 和团队共享状态。
- [ ] 能从首页提交公共市场审核。
- [ ] 审核状态和驳回原因能回显到首页。
- [ ] 最近插件列表能按租户隔离展示。
- [ ] 前端 typecheck 和 build 通过。

## Out Of Scope

- 不新增普通用户 Web 前台。
- 不引入第二套大型 UI 框架。
- 不实现复杂多 Agent 编排页面。
