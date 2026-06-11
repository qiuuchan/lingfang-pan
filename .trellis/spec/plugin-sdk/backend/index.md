# @lingfang/plugin-sdk 后端规范

## Scope

`packages/plugin-sdk` has no backend runtime, database, logging, or HTTP server. It is a TypeScript client library consumed by plugin UI code.

## Pre-Development Checklist

- Read [../frontend/sdk-runtime.md](../frontend/sdk-runtime.md) for the actual implementation contract.
- If adding a capability, update `packages/contract/src/plugin.ts` first, then Tauri/server runtime support as needed.

## Backend Boundary

Do not add persistence, secrets, LLM routing, or tenant authorization to this package. Those belong to:

- `apps/server` for tenant LLM binding, authorization, audit, marketplace, wallet
- `apps/desktop/src-tauri` for local OS capabilities

The SDK should stay a thin typed bridge.

## Quality Check

- SDK typecheck: `pnpm -C packages/plugin-sdk typecheck`
- If runtime capability behavior changed, also run the affected desktop/server checks.
