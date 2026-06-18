# 大模型生成聊天标题

## Goal

将聊天 / 插件创建会话的标题生成从「本地启发式截断」升级为「大模型真实总结」，让会话标题更贴合对话内容。复用桌面壳已有的本地代码助手 SDK 短任务能力（`generateTitle()`），LLM 失败时降级回现有 `summarizeTitleLocally()` 本地启发式，保证永远有标题。

## 现状（已调研确认）

- 标题生成入口在 `apps/desktop/src/pages/PluginCreatorHome.tsx` 的 `finalizeSession()`（[第 465-476 行](../../apps/desktop/src/pages/PluginCreatorHome.tsx)）：首轮且当前会话无 title 时，调用 `summarizeTitleLocally(promptText, finalSession.stdout)` 生成标题并经 `renameConversation` 持久化。
- `generateTitle()` 已实现于 `apps/desktop/src/lib/conversations.ts`（[第 63-98 行](../../apps/desktop/src/lib/conversations.ts)）：用本地 SDK 起独立短任务（不污染当前会话），系统提示严格约束「只输出 ≤10 字标题、无标点」，返回值已 trim + 截断 16 字，**失败返回空串**。该函数现成但当前**未被调用**。
- `finalizeSession` 上下文已有 `finalSession.tool`（provider id）与 `finalSession.model` 可用于驱动 `generateTitle`。
- 会话标题数据流：`generateTitle` 产出 → `setMetas` 更新内存 → `renameConversation`（Tauri `code_assistant_rename_session`）持久化到 Rust `sessions.json`。

## 决策

采用「复用本地 SDK generateTitle」方案（用户确认）：

- 不新增 collab-api 后端端点，零后端改动、零新依赖。
- 复用既有 `generateTitle()` 与 `summarizeTitleLocally()`，仅改动 `finalizeSession` 的标题生成段落。

## Requirements

- 首轮会话完成、且当前会话尚无 title 时，**优先调用 `generateTitle()`** 用大模型总结生成标题。
- `generateTitle()` 返回空串（LLM 调用失败 / 无可用工具 / 超时）时，**降级**调用 `summarizeTitleLocally()`，保证有标题。
- 标题生成为异步，**不得阻塞** `finalizeSession` 主流程与后续 toast / 草稿落盘。
- tool / model 取自当前会话（`finalSession.tool` / `finalSession.model`），并正确映射为 `generateTitle` 所需的 `'claude' | 'codex'`；非这两类工具时直接降级本地启发式（不调 SDK）。
- 生成的标题经 `setMetas` 更新内存并经 `renameConversation` 持久化，与现有逻辑一致。
- 仅在首轮触发（沿用现有 `!isFollowup && !currentMeta?.title && promptText` 守卫），避免重复生成与额外开销。
- 不改变 `generateTitle` / `summarizeTitleLocally` 的函数签名与既有调用方行为。

## 范围之外

- 不做用户手动「重新生成标题」按钮（可作后续）。
- 不新增后端云 LLM 代理端点。
- 不改动 Rust 会话存储 schema。

## Acceptance Criteria

- [ ] 首轮对话完成后，会话标题由大模型总结生成，明显比启发式截断更贴合内容。
- [ ] 断网 / LLM 不可用 / 工具非 claude|codex 时，自动降级为本地启发式标题，流程不报错、不卡住。
- [ ] 标题生成全程异步，不阻塞 toast、草稿落盘等后续步骤。
- [ ] 标题正确持久化（重开应用后标题仍在）。
- [ ] 追问（非首轮）不会触发标题重新生成。
- [ ] `apps/desktop` 类型检查 / 构建通过。

## Notes

- 复杂度判定：复杂任务（含异步降级编排与 provider→tool 映射），配 `design.md` + `implement.md`。
- 验证方式：本地起桌面壳走一轮对话观察标题；断网模拟降级路径。
