# 流式分类渲染与思考调节与 AskQuestion

## Goal

让 CLI 流式输出像 AionUi 那样**分类美化渲染**（思考/文本/工具调用分别展示），支持**思考强度调节**（max/high/medium/low），支持 **AskUserQuestion 工具**（AI 主动向用户提问），并完善若干 UI 细节（模型名大写、stage 文案、用户设置居中弹窗）。

## 需求

### R1 模型名首字母大写
- UI 显示层：sonnet→Sonnet、opus→Opus、haiku→Haiku、fable→Fable（小写 id → 首字母大写展示）。

### R2 思考调节（--effort）
- Composer 加思考强度选择器（max/high/medium/low/none）。
- claude 传 `--effort <level>`；codex/opencode 按各自参数（无则忽略，仅 claude 生效）。
- 选定的 effort 随每轮 send 传（start_session + send_input 都带，可会话中途调）。

### R3 流式输出分类美化（核心）
- 解析 claude stream-json 的 stream_event，按 content_block.type 分类：
  - **思考**（thinking/thinking_delta）：单独折叠区展示，流式增量。
  - **文本**（text/text_delta）：像对话气泡走 Markdown 增量渲染（持续输出）。
  - **工具调用**（tool_use）：显示工具卡片（name + input 摘要）。
- **关键约束**：思考/工具内容**不进 stdout**（stdout 是协议解析输入，被污染会导致结构化解析错乱），走独立 stream（thought/tool）。
- codex/opencode（Plain）保持现有行为（无分类，纯文本）。

### R4 AskUserQuestion 工具
- 检测 tool_use name=AskUserQuestion，前端渲染问题卡片（questions: 1-4 问，每问 2-4 选项）。
- 用户选择后，回答作为下一轮 send_input 传入（先按 --resume 续接，答案当普通文本；tool_use_id 关联正确需后续升级 stream-json input 模式，本轮标注为已知限制）。

### R5 stage 文案
- 「本地代码助手正在生成…」→「正在思考中…」（思考阶段）/「正在生成…」（文本阶段）。
- 根据 stream 事件类型动态切换 stage。

### R6 用户设置居中弹窗
- 侧边栏底部账户信息点击 → 居中悬浮弹窗（当前是其他形式）。
- 支持：修改用户名、重置密码、修改邮箱、重新设置（登出/退出登录）。
- 调后端 /api/auth/me（PATCH）或对应接口更新。

## Constraints

- 简体中文。复用优先（Markdown 组件、Bubble、ErrorBubble）。
- stdout 不被思考/工具污染（协议解析依赖）。
- Rust stream-json 解析扩展（extract_stream_json_text 升级为分类）。
- 不破坏现有：上传契约、多会话、--resume、.cmd shim、capabilities。

## Acceptance Criteria

- [ ] AC1 模型名显示首字母大写（Sonnet/Opus）。
- [ ] AC2 思考强度选择器，claude 传 --effort，生效。
- [ ] AC3 流式输出分类：思考折叠区 + 文本 Markdown 持续输出 + 工具卡片。
- [ ] AC4 stdout 不含思考/工具内容（协议解析仍正确）。
- [ ] AC5 AskUserQuestion 渲染问题卡片，用户选后回答传入下一轮。
- [ ] AC6 stage 文案「正在思考中」/「正在生成」动态切换。
- [ ] AC7 用户设置居中弹窗，改用户名/密码/邮箱/登出可用。
- [ ] AC8 本地验证全绿（cargo test + typecheck + test）。

## 分阶段

- 阶段1 Rust：extract_stream_json 升级分类返回（thought/text/tool_use），spawn_reader 按类别 emit 独立 stream（thought/tool 不进 stdout）。
- 阶段2 思考调节：claude --effort 参数，前端选择器，随 send 传。
- 阶段3 前端分类渲染：LiveProcess 重构（思考折叠/文本 Markdown/工具卡片），stage 动态。
- 阶段4 AskQuestion：检测 + 问题卡片 + 回答回传。
- 阶段5 模型名大写 + 用户设置弹窗。

## Notes

- stream-json 真实结构已实测（stream_event.event.type: message_start/content_block_*/message_delta）。
- AskUserQuestion 本轮按 --resume 续接（答案当文本），tool_use_id 正确关联留后续 stream-json input 升级。
