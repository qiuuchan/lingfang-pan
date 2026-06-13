# 对话优先重构与多会话管理

## Goal（目标）

把桌面端「创建插件」从**「每次对话都是插件创建长任务」**重构为**「对话优先 + 按需结构化 + 多会话管理」**——参考 AionUi 的对话软件模式：默认是正常对话（"你好"就是聊天，不再 schema invalid），AI 检测到插件需求或用户手动触发时才解析结构化包生成草稿，预览独立为大窗，支持多会话管理。

## 背景（为什么改）

- 当前 `PluginCreatorHome` 把每轮 send 都当插件创建：硬编码 `PLUGIN_CREATOR_SYSTEM_PROMPT`（PluginCreatorHome.tsx:275）+ 无条件 `buildLocalDraft/mergeFollowupDraft` 解析 → "你好"无 manifest 块 → `parseStructuredPackage` 判 invalid → 右侧弹"含校验问题"。
- 单会话假设（前端只有一个 assistantSession + currentDraft），无法管理多个对话。
- 预览塞在右侧 tab（小、被动），源码显示局限（多文件放不下）。

## Scope（范围）

四块联动改造：

### R1 对话优先（解耦"对话"与"插件创建"）
- 默认通用对话，不注入插件协议 systemPrompt。
- `finalizeSession` 加 gate：产出含 manifest 块才解析为草稿（自动检测）；否则只累积对话 turn，不判 invalid、不弹详情。
- 保留多轮迭代（mergeFollowupDraft 仅在 draft!=null 会话触发）。

### R2 多会话管理（本机，参考 AionUi）
- Rust 侧 SessionRecord 加 title 字段 + draft 分文件存（drafts/{id}.json）+ CRUD 命令（rename/delete/save_draft/read_draft，list/create 已有）。
- 前端会话栏（新建/切换/删除/重命名），activeId 持久化到 localStorage（lf:active-conversation:{tenantId}）。
- 每会话绑 cli_session_id，切换靠现有 --resume/历史摘要（无状态续接，不保持常驻进程）。

### R3 预览大窗
- 删 DetailsPanel 的预览 tab 与 SourcePanel 固定展示。
- 顶部「新对话」旁加「预览」按钮（仅 hasDraft 时可用，否则 disabled+tooltip）。
- 点击 → 全屏 Sheet 大范围预览（复用 PreviewPanel，client→iframe，nodejs/python→ScriptPreviewPanel）；多文件在大窗内用文件选择器切换。

### R4 草稿生成双触发
- 自动检测：assistant 输出含 manifest 块或 ≥1 个 file 块时自动解析为草稿。
- 手动按钮：对话区/assistant 气泡下「✨ 转为插件草稿」按钮，显式解析当前轮产出。

## Constraints（约束）

- 简体中文（注释/commit）。文件操作用专用工具。前端 pnpm，Python 脚本 py launcher。
- 复用优先：parseStructuredPackage/previewSrcDoc/sheet.tsx/Bubble/LiveProcess/normalizeTurns 全部复用，不重写。
- Rust sessions.json 向后兼容（新字段全 Option + #[serde(default)]）。
- 现有 .cmd shim 解析、多轮 --resume、错误友好化（ErrorBubble）不回归。
- 不破坏既有上传契约（capabilities 修复、RuntimeType 四值保持）。

## Acceptance Criteria

- [ ] AC1 "你好"正常对话回复，不触发 schema 解析、不弹"含校验问题"、不弹详情面板。
- [ ] AC2 多会话：新建/切换/删除/重命名，切换后对话历史与草稿正确恢复；多会话 cli_session_id 独立。
- [ ] AC3 说"做个番茄钟插件"→ AI 产出 manifest 块 → 自动检测生成草稿 → 预览按钮点亮。
- [ ] AC4 顶部「预览」按钮 → 全屏大窗预览（client iframe / node-python 终端），多文件可切换；无草稿时 disabled。
- [ ] AC5 源码固定展示已移除（不在详情面板，多文件在大窗内切换）。
- [ ] AC6 手动「转为插件草稿」按钮：纯对话也能强制解析为草稿。
- [ ] AC7 现有能力不回归：上传契约、多轮 claude --resume、错误友好化、.cmd shim。
- [ ] AC8 本地验证全绿（cargo test + pnpm typecheck/test + 旧 sessions.json 可读）。

## 分阶段（渐进式）

- 阶段1 Rust：SessionRecord 加字段 + draft 存取 + CRUD 命令 + 单测。
- 阶段2 前端会话管理：会话栏 + activeId 切换 + draft 读写。
- 阶段3 对话优先：通用 systemPrompt + finalizeSession gate + 按需结构化（自动检测+手动按钮）。
- 阶段4 预览大窗：删 tab、加顶部按钮、全屏 Sheet。
- 每阶段 cargo test + pnpm build 验证。

## Notes

- 参考研究结论（AionUi 四机制 + 当前架构硬编码点 + 多会话设计方案）见会话上下文与 operations-log。
- design.md 写技术设计（数据模型/UI 布局/按需结构化 gate/预览大窗），implement.md 写四阶段有序 checklist。
