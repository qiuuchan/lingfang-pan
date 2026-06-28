# 插件 LLM 与 beta 更新

## Goal

让插件在所有运行时（HTML/client、Node.js、Python）都能通过灵坊平台 Relay 调用 LLM，并把 AI 插件开发器升级为内置工作流。同时将正式版与 beta 版更新链路隔离：默认只接收正式版，用户在设置中手动开启 beta 后才检查/下载 beta。

## Requirements

1. 插件直接调用平台 LLM
   - HTML/client 插件继续通过宿主注入的 `sdk.llm.chat` 调用平台 Relay。
   - Node.js/Python 插件也要支持调用平台 LLM，但不能把用户 JWT、平台 API Key 或上游密钥直接暴露给脚本进程。
   - 插件能力声明、SDK 文档/模板、创建器生成策略都必须引导使用平台 LLM，禁止生成直连第三方模型接口或硬编码 key 的插件。
   - 内置插件中已有直连第三方 LLM 或自带 API Key 配置的实现需要迁移到平台能力。
   - 用真实后端 `http://106.12.131.38:19006/` 与测试账号验证端到端调用。

2. AI 插件开发工作流
   - 创建器流程明确覆盖：询问、搜索补充、检查、编写/修补、review、草稿预览/提交。
   - 检查阶段至少覆盖 manifest、入口文件、必需文件、路径安全、能力声明、平台 LLM 使用方式。
   - review 阶段至少覆盖硬编码密钥、第三方 AI 地址、运行时兼容、权限风险和可修复建议。
   - UI 需要把工具调用、检查结果、review 结果以用户能理解的方式展示。

3. Beta 版本渠道和下载管理
   - `STABLE` 与 `BETA` 独立维护 latest，beta 发布不得影响正式版 latest。
   - 桌面端默认只检查正式版。
   - 设置页增加“启用 beta 更新”开关；开启后手动检查和启动静默检查都走 beta。
   - 下载页默认展示正式版，提供手动查看 beta 版本入口。
   - 发布后台强化通道隔离提示，避免 beta/正式版误发布。

## Confirmed Decisions

- beta 默认关闭，用户主动开启后才接收 beta 更新。
- 插件 LLM 调用范围覆盖 HTML、Node.js、Python 全部运行时。
- 脚本型插件必须通过受控宿主桥调用平台 LLM，不直接接触登录态或平台密钥。

## Acceptance Criteria

- [ ] HTML/client 插件可调用 `sdk.llm.chat` 并返回平台 Relay 的结果。
- [ ] Node.js 插件可调用平台 LLM，脚本环境中不出现用户 JWT/API Key。
- [ ] Python 插件可调用平台 LLM，脚本环境中不出现用户 JWT/API Key。
- [ ] 未声明 LLM 能力或未登录时返回明确错误，不假成功。
- [ ] 内置 notes 插件不再要求用户填写第三方 LLM 地址/API Key。
- [ ] 创建器可展示“询问 → 搜索补充 → 检查 → 编写/修补 → review”的过程与结果。
- [ ] `check_plugin` 能拦截缺入口、缺必需文件、非法路径、LLM 能力未声明、直连第三方 AI 等问题。
- [ ] `review_plugin` 能发现硬编码 key、第三方 AI endpoint、危险权限和运行时不匹配。
- [ ] 设置页 beta 开关默认关闭，并持久化用户偏好。
- [ ] 启动静默检查和手动检查更新都遵守 beta 开关。
- [ ] 后端 release 单测覆盖 STABLE/BETA latest 互不影响。
- [ ] 下载页默认展示 STABLE，并能手动查看 BETA。
- [ ] 真实后端联调记录 HTML、Node.js、Python 三类插件调用平台 LLM 的结果。

## Out of Scope

- 不重构 Relay 计费模型、渠道路由或平台灵石体系。
- 不做 beta 用户灰度分组、强制升级策略或自动回滚。
- 不引入外部 CLI 作为插件 LLM 调用通道。

## Notes

- 任务涉及 desktop frontend、lingfang-desktop Rust backend、plugin-sdk、contract、collab-api、collab-admin 多层，需要以共享契约和边界函数减少重复逻辑。