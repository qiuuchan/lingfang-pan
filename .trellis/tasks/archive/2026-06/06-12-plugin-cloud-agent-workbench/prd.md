# 云端插件创建分享与本地代码助手

## Goal

构建用户端插件创建工作台：用户进入本地客户端后，首页直接通过对话描述“今天想创建什么插件”，选择 Claude Code、Codex、OpenCode 等真实本机 CLI 与模型生成插件；插件创建成功后上传到云端成为团队共享插件，并可提交公共市场审核，审核通过后所有团队可搜索、安装、使用。

## Confirmed Facts

- 当前没有 active Trellis task，上一轮 `06-11-collab-platform` 已归档。
- 当前工作区 clean，可安全创建新任务树。
- 当前 `apps/collab-api` 已存在用户、团队、邀请、余额、插件基础管理；`plugins.controller.ts` 目前只有 `GET /plugins/available`。
- 当前 `apps/collab-api/prisma/schema.prisma` 的 `Plugin` 只包含 `id/name/description/status/createdAt/updatedAt`，不足以保存源码、manifest、团队归属、审核状态和市场状态。
- 当前 `apps/desktop` 已有 `Generator.tsx` 插件生成页、`Plugins.tsx` 插件运行页、`plugins-runtime.ts` iframe capability 桥、`Settings.tsx` 模型选择 UI 模式。
- 当前 `apps/desktop/src-tauri` 只有插件加载与本地 capability 网关，尚无 Claude Code / Codex / OpenCode 本地进程运行时。
- 用户明确要求真实手测：Claude Code、Codex、OpenCode 必须直接调用真实 CLI，不能使用 mock 或假输出。

## Requirements

### Product Flow

- 登录并完成 onboarding 后，用户默认进入插件创建首页。
- 首页主标题为“今天想创建什么插件？”，下方直接提供对话输入框。
- 首页展示快捷模板、当前工具与模型选择、生成过程、插件预览、源码诊断、云端分享状态、最近使用插件。
- 插件创建成功后，用户可以上传到云端成为团队共享插件。
- 团队共享插件对同团队成员可见、可运行、可继续修改。
- 作者可将团队共享插件提交公共市场审核。
- 平台管理员审核通过后，插件进入公共市场，其他团队可搜索、安装、使用。
- 审核驳回后，作者可看到驳回原因并继续修改后重新提交。

### Local CLI Runtime

- 支持 Claude Code、Codex、OpenCode 三种工具。
- 每种工具都必须有真实二进制发现、版本检查、可用性诊断、模型选择、最小响应探测、会话运行、停止和清理。
- 本地运行时需要记录 session、transcript、stdout/stderr、exit code、诊断信息和进程注册表。
- 任一 CLI 未安装、未登录、模型不可用或响应失败时，UI 必须给出真实错误，不得伪造通过。

### Cloud Sharing

- 云端插件记录必须保存 manifest、files、entry、capabilities、作者、团队、版本、可见性、审核状态、市场状态。
- 上传必须校验 manifest、entry、文件路径、文件大小、capability 合法性和团队归属。
- 团队成员只能访问所属团队共享插件和已授权公共插件。
- 公共市场分享必须经过平台审核。

### Plugin Framework Integration

- 新增能力必须进入 `@lingfang/contract` 的 capability 契约。
- `@lingfang/plugin-sdk` 需要提供受控的代码助手与插件上传/提交入口。
- `plugins-runtime.ts` 默认只允许本地/内置受信任插件调用本机代码助手；平台/数据库插件默认继续只开放 `llm.chat`。

### UI And Component Strategy

- 基础 UI 继续使用当前 shadcn/base-ui 组件。
- 聊天输入、消息列表、自动滚动、流式消息可引入轻量开源 primitives，例如 assistant-ui 或 shadcn AI blocks。
- 不引入 Arco Design 或第二套大型 UI 框架。

## Acceptance Criteria

- [ ] 新 Trellis 父任务和 5 个子任务均有 PRD、design、implement。
- [ ] 登录后默认进入插件创建首页。
- [ ] 首页能直接输入需求并启动插件创建。
- [ ] 用户能选择 Claude Code、Codex、OpenCode 和模型。
- [ ] 未安装或不可用的 CLI 展示真实诊断。
- [ ] Claude Code、Codex、OpenCode 三种 CLI 均完成真实最小响应探测。
- [ ] 三种 CLI 均通过真实调用生成插件草稿，产生 transcript。
- [ ] 插件生成后可预览、查看源码、查看校验诊断。
- [ ] 插件校验通过后可上传云端团队共享。
- [ ] 团队成员能在插件列表看到并运行团队共享插件。
- [ ] 作者能提交公共市场审核。
- [ ] 平台管理员能审核通过/驳回公共市场提交。
- [ ] 审核通过后其他团队能搜索、安装、使用插件。
- [ ] 审核驳回后作者能看到原因并继续修改。
- [ ] 最近插件列表显示最近运行、创建、上传、继续修改记录。
- [ ] 非团队成员不能读取或上传到该团队插件空间。
- [ ] 非作者/非团队管理员不能提交他人插件到市场。
- [ ] 平台/数据库插件默认不能调用本地代码助手能力。
- [ ] 上传文件路径不能包含绝对路径、`..` 或路径绕过。
- [ ] 上传文件大小受限，超过上限有明确错误。
- [ ] 本地进程异常退出后能清理进程注册表。
- [ ] 真实 CLI 手测报告记录命令、版本、模型、session id、plugin id、审核状态、失败日志或截图路径。

## Out Of Scope

- 不做多 Agent 协作编排。
- 不做云端运行 Claude/Codex/OpenCode。
- 不开放远程平台插件直接控制本机代码助手。
- 不做复杂付费结算、提现或真实支付网关。
- 不做跨团队共同编辑同一个插件。
