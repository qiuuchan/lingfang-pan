# 创建器与 AskQuestion：空响应修复 + 提问 UI + 历史管理

## Goal

修复并增强桌面端「AI 创建插件」创建器：①修复对话后无内容的 bug（线上调试）；②接入 AskQuestion 工具，让所有提问默认走该工具并配 Claude 风格提问 UI；③历史记录加删除与分页；④两项 UI 微调（移除团队名、按钮换位）。

## Requirements

### R1 修复对话后无内容（需求 #2）

- 现象：创建插件页对话后气泡显示无内容。
- 线上调试：http://106.12.131.38:19006，账号 1503255237@qq.com（密码见任务下发，勿写入仓库）。
- 探查初判根因：多步 agent 流程中工具调用步无伴随文本，或 `fullStream` 提前中止，导致 `content` 为空且 `streaming:false`，命中"无内容"渲染分支（`FloatingCreator.tsx:436-447`）。需线上复现确认真实根因后修复。

### R2 适配 AskQuestion 工具（需求 #6）

- 复用现有 Agent 框架（Vercel AI SDK `ai` v5，`tool()` + `zodSchema()`）。
- 新增 `ask_question` 工具，内置提示词配置：信息不足/有疑问时默认调用该工具提问，而非纯文本回复。
- 制作 Claude 风格提问 UI（提问卡片 + 选项/输入，回答后继续流程）。

### R3 历史记录删除 + 分页（需求 #3）

- 现状：localStorage 持久化，最多 30 条，无删除、无分页（`FloatingCreator.tsx:35-62,542-569`）。
- 加单条删除（按钮/菜单）+ 列表分页展示。

### R4 UI 微调（需求 #4、#5）

- 移除标题栏「铂觅」团队名 Badge（`FloatingCreator.tsx:330-333`）。
- 「新建对话」按钮移到「历史记录」按钮左侧（当前历史在左、新建在右，需对调，见 `342-345` 与 `407-411`）。

## Acceptance Criteria

- [ ] 线上复现并修复空响应：对话后正常显示内容
- [ ] AskQuestion 工具生效：默认提问走该工具，UI 为 Claude 风格提问卡片，可回答并继续
- [ ] 历史记录支持删除单条 + 分页
- [ ] 标题栏无团队名显示
- [ ] 新建对话按钮在历史记录按钮左侧
- [ ] 桌面端构建通过

## 关键代码位置（探查结论）

- 空响应：`FloatingCreator.tsx:213-314`（send/fullStream）、`436-447`（渲染条件）；`lib/relay-provider.ts:9-16`；`lib/relay-chat-stream.ts:62-122`
- 工具：`lib/plugin-creator/creator-tools.ts:1-57`；`FloatingCreator.tsx:253-259`（streamText/tools）、`279-287`（tool-call 渲染）
- 提示词/Skill：`lib/skills.ts:1-102`；`FloatingCreator.tsx:69-82,228-236`
- 历史：`FloatingCreator.tsx:35-62,89-175,342-345,542-569`
- UI 微调：`FloatingCreator.tsx:330-333`（团队名）、`342-345`（历史按钮）、`407-411`（新建按钮）

## Notes

- 复杂任务：需 design.md + implement.md（尤其 AskQuestion 工具协议与 UI 交互）。
- 调试账号密码只在会话中使用，不写入任何仓库文件。
- 与子任务 A 交叉：A 改后端扣费，本任务改前端渲染；空响应若涉及 relay 流式响应不完整，需与 A 协调。
