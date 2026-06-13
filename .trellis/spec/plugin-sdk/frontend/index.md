# @lingfang/plugin-sdk 前端规范

## Scope

适用于 `packages/plugin-sdk/src/`。这是插件作者和 AI 生成插件使用的类型化能力客户端。

## Pre-Development Checklist

- 改 SDK API、能力名或桥接参数时，先读 [sdk-runtime.md](./sdk-runtime.md)。
- 同步读 `.trellis/spec/contract/backend/schema-contracts.md`，因为能力类型来自 `@lingfang/contract`。
- 若改运行时能力，检查 `apps/desktop/src/pages/Plugins.tsx`、`apps/desktop/src-tauri/src/capability.rs` 和 `apps/collab-api/src/modules/plugins.controller.ts`（LLM 代理）。

## Quality Check

- SDK typecheck: `pnpm -C packages/plugin-sdk typecheck`
