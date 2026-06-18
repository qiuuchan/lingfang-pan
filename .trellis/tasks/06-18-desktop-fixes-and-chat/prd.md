# 桌面端五项问题修复与对话增强（父任务）

## 背景

用户在桌面端（Tauri + collab-admin React 前端 + collab-api NestJS 后端）反馈五项问题，跨多模块，按可独立验证拆为 5 个子任务。本父任务持有需求全集、子任务映射、跨子任务验收口径与最终集成验证，自身不直接承载实现。

## 源需求（用户原话）

1. 检查更新失败
2. 使用邀请码显示"邀请码无效"，但一次没使用过
3. 点击商店的插件显示"应用遇到错误，页面渲染过程中出现问题"，React error #300
4. 对话应支持流式输出、显示思考内容、显示工具调用
5. 对话为什么没有 Claude，只有 Codex，Claude 也要

## 根因排查结论（规划期已定位）

| # | 子任务 | 根因 | 确定性 |
|---|--------|------|--------|
| 3 | fix-market-hooks | `apps/desktop/src/pages/Market.tsx` 第 80 行 `useEffect` 位于第 69 行 `if (detail) return <Detail.../>` 提前返回之后。点击插件置 `detail` → 重渲染在 return 处截断 → 本次少渲染一个 Hook → React #300「Rendered fewer hooks than expected」崩溃 | 确定 |
| 2 | fix-invite-case | 生成邀请码时 `code.toUpperCase()` 后做 SHA256；兑换入口 `Onboarding.tsx:56` 只 `code.trim()` 不归一大小写。用户输入大小写不符 → 哈希不匹配 → 查无记录 → 抛"邀请码无效"（与"没用过"现象吻合，非次数上限） | 高 |
| 5 | restore-claude-provider | `apps/desktop/src/lib/plugin-draft/providers.ts:36` `compatibleProviderIds`：仅 `anthropic` 返回 `['claude']`，custom/openai 兼容 provider 只返回 `['codex']`。按提交 0aa2fd8 意图 custom 应同时提供 claude | 高 |
| 1 | fix-update-check | 链路：Tauri updater → `/api/releases/tauri-update`。前端报通用兜底"检查更新失败，请重试"（`Settings.tsx`），说明 `check_update` 调用抛异常。具体失败点需实现阶段运行时诊断（URL 解析 / 网络 / 未发布 STABLE release / 平台 asset 缺失 / 签名验证） | 待诊断 |
| 4 | chat-streaming-thinking-tools | Rust SDK Runtime（`code_assistant/engine/`）+ `AssistantChat.tsx` 已有 ReasoningBlock/ToolBlock 代码骨架，但用户实测三者（流式/思考/工具）都不可见。需端到端排查事件透传链路缺口并补齐 | 待排查 |

## 子任务映射

- `06-18-fix-market-hooks` — 问题 3，前端单文件 Hooks 顺序修复
- `06-18-fix-invite-case` — 问题 2，后端邀请码归一 + 前端可选归一
- `06-18-restore-claude-provider` — 问题 5，provider 路由表恢复 claude
- `06-18-fix-update-check` — 问题 1，运行时诊断后修复
- `06-18-chat-streaming-thinking-tools` — 问题 4，对话流式/思考/工具端到端补齐

## 跨子任务验收口径

- 全部改动须能本地构建通过（前端 `pnpm build`/`tsc`、后端 `pnpm build`、Rust `cargo check`），并附可复现验证步骤。
- 每个子任务独立可验证：bug 类提供"修复前现象→修复后预期"的对照；增强类提供端到端可见的能力证明。
- 破坏性变更不做向后兼容包袱，但须保留迁移/回滚说明。
- 各子任务在自身 prd/design/implement 中闭环，本父任务仅引用不复制。

## 执行顺序

按痛感与确定性：fix-market-hooks（崩溃）→ fix-invite-case → restore-claude-provider → fix-update-check（需诊断）→ chat-streaming-thinking-tools（最复杂）。子任务间无强依赖，但 update-check 与 chat 都触及桌面壳，安排在后期统一验证桌面构建。

## 最终集成验证（父任务收口）

5 个子任务全部完成后，运行一次桌面端整体构建与冒烟，确认无回归，再统一提交。
