# 插件能力与 SDK

## Goal

扩展插件契约、SDK 和 iframe runtime，使受信任本地/内置插件可以受控调用代码助手与云端插件上传/提交能力，同时保持平台/数据库插件默认安全边界。

## Confirmed Facts

- `packages/contract/src/plugin.ts` 当前 capability enum 不包含 `code-assistant.*` 或 `plugin.upload`。
- `packages/plugin-sdk/src/index.ts` 当前暴露 fs/net/clipboard/storage/system/llm/ui 能力。
- `apps/desktop/src/pages/plugins-runtime.ts` 当前 builtin 插件走 Tauri capability；数据库/平台插件默认只支持 `llm.chat`。

## Requirements

- 在 contract 中新增代码助手和云端插件能力。
- 在 SDK 中新增 `sdk.codeAssistant.*` 和 `sdk.plugin.*`。
- 在 desktop runtime 中明确限制能力调用来源。
- builtin/local trusted 插件可通过 Tauri capability 调用本机代码助手。
- platform/db 插件默认不能调用本机代码助手和云端上传能力。
- 所有新增能力必须有类型定义、输入输出 shape 和错误行为。

## Acceptance Criteria

- [ ] `CapabilityKind` 包含新增能力。
- [ ] SDK 暴露 `sdk.codeAssistant.check/run/stop`。
- [ ] SDK 暴露 `sdk.plugin.upload/submitMarketplace`。
- [ ] builtin/local trusted 插件能通过 runtime 调用允许能力。
- [ ] platform/db 插件调用新增本机能力会被拒绝。
- [ ] 现有 `llm.chat` 行为不回退。
- [ ] contract 和 SDK typecheck 通过。

## Out Of Scope

- 不为远程平台插件开放本机代码助手。
- 不做细粒度授权 UI；如需开放给远程插件，后续单独设计。
