# 插件能力与 SDK 实施计划

## Steps

1. Read specs:
   - `.trellis/spec/plugin-sdk/frontend/index.md`
   - `.trellis/spec/plugin-sdk/frontend/sdk-runtime.md`
   - `.trellis/spec/contract/backend/schema-contracts.md`
   - `.trellis/spec/desktop/frontend/api-streaming-and-runtime.md`

2. Contract
   - Extend `CapabilityKind` in `packages/contract/src/plugin.ts`.
   - Add/adjust tests if contract package has relevant coverage.

3. SDK
   - Add typed inputs/outputs for code assistant and plugin cloud operations.
   - Keep `invoke<T>` as single bridge boundary.
   - Avoid `any` in exported API.

4. Desktop runtime bridge
   - Extend `RuntimeMessage` args typing.
   - Allow builtin/local trusted plugin calls to new capabilities.
   - Block platform/db plugin calls except `llm.chat`.
   - Return explicit errors.

5. Checks
   - Typecheck contract.
   - Typecheck plugin-sdk.
   - Typecheck desktop.

## Validation Commands

```bash
pnpm -C packages/contract typecheck
pnpm -C packages/plugin-sdk typecheck
pnpm -C apps/desktop typecheck
```

## Manual Checks

- Builtin trusted plugin can call allowed new capability.
- Platform/db plugin receives explicit denial.
- Existing summarizer `llm.chat` still works.

## Risky Files

- `packages/contract/src/plugin.ts`
- `packages/plugin-sdk/src/index.ts`
- `apps/desktop/src/pages/plugins-runtime.ts`

## Done When

- New capabilities are typed.
- Runtime policy is enforced.
- Existing plugin runtime remains compatible.
