# 恢复 Claude 模型可选项

## Goal

让对话/代码助手在自定义模型（custom provider）场景下同时提供 ClaudeCode 与 Codex 两个可选项，恢复用户选择 Claude 的能力。

## 根因

`apps/desktop/src/lib/plugin-draft/providers.ts` 的 `compatibleProviderIds`（第 36-41 行）：

```ts
const OPENAI_COMPATIBLE_PROVIDER_IDS = new Set([
  'openai',
  'azure',
  'deepseek',
  'minimax',
  'moonshot',
  'qwen',
  'custom',
]);
function compatibleProviderIds(provider) {
  const normalized = (provider || '').trim().toLowerCase();
  if (normalized === 'anthropic') return ['claude'];
  if (OPENAI_COMPATIBLE_PROVIDER_IDS.has(normalized) || !normalized) return ['codex'];
  return ['codex'];
}
```

`custom` 落在 `OPENAI_COMPATIBLE_PROVIDER_IDS` 内 → 只返回 `['codex']` → 下拉里只有 Codex。

提交 0aa2fd8「恢复自定义模型的 Claude Code 可选项」意图为 `custom → ['claude', 'opencode']`，但在 b7d9c32「重构为内置 SDK Runtime」中 opencode CLI 下线、整段路由表被重写，该意图丢失。

## 协议背景（约束修复方式）

SDK Runtime（`code_assistant/engine/runtime.rs`）按 provider 决定调用协议：

- `claude` → Anthropic Messages API `/v1/messages`
- `codex` → OpenAI Chat Completions `/v1/chat/completions`

`anthropic` / `openai` 等官方 provider 协议确定，单选无歧义。`custom` 是用户自配端点，协议不确定，可能是 Anthropic 兼容也可能是 OpenAI 兼容，因此应**同时提供 claude 与 codex 两项**，由用户按自己端点的协议选择（与 0aa2fd8 的「custom 给两项」精神一致，只是把已下线的 opencode 换成 codex）。

## 方案

1. 从 `OPENAI_COMPATIBLE_PROVIDER_IDS` 移除 `'custom'`。
2. 在 `compatibleProviderIds` 增加显式分支：`if (normalized === 'custom') return ['claude', 'codex'];`
3. 其余 OpenAI 兼容 provider 与空 provider 维持只给 `['codex']`；`anthropic` 维持只给 `['claude']`。

## Requirements

- custom provider 的 catalog 同时含 `claude` 与 `codex`，模型列表沿用上游 `defaultModels` / `modelOverride`。
- anthropic / openai / minimax 等既有路由行为不变。
- 同步更新 `providers.spec.ts` 中「custom 只给 codex」的断言为「custom 给 claude + codex」。

## Acceptance Criteria

- [ ] `buildAssistantProviderCatalog({ activeProvider: { provider: 'custom', ... } })` 返回的 providers 含 `claude` 与 `codex` 两项。
- [ ] anthropic → 仅 claude；openai/minimax/azure 等 → 仅 codex（回归不破）。
- [ ] `providers.spec.ts` 全绿。
- [ ] desktop 前端类型检查通过。

## Notes

- 前端单文件 + 测试更新，PRD-only 轻量任务。
- 不涉及 Rust 改动；Runtime 已支持 claude/codex 双协议，本任务只恢复 UI 可选项。
