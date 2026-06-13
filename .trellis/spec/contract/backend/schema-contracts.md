# Schema Contracts

## Export Pattern

Each contract module exports a zod schema and its inferred TypeScript type with the same name:

```ts
export const PluginDraft = z.object({ ... });
export type PluginDraft = z.infer<typeof PluginDraft>;
```

Reference files:
- `packages/contract/src/identity.ts`
- `packages/contract/src/plugin.ts`
- `packages/contract/src/draft.ts`
- `packages/contract/src/llm.ts`

Keep `packages/contract/src/index.ts` as a barrel export only.

## Naming And Fields

Contract fields use snake_case because the backend JSON and SQLite schema use snake_case. Do not introduce camelCase in shared contracts just because frontend local types can be camelCase.

Examples:
- `display_name`
- `tenant_id`
- `source_prompt`
- `api_key_masked`
- `review_status`

## Defaults And Validation

Defaults belong in zod where the API contract allows omission, such as:

- `User.status`
- `Tenant.status`
- `PluginManifest.runtime_type`
- `PluginManifest.capabilities`
- `PluginDraft.status`

Use `.min(1)`, `.email()`, `.datetime()`, and enum values to make invalid payloads fail explicitly.

## Core Domain Objects

Treat `PluginDraft` as the product core object. Changes to `PluginDraftFile`, `PluginDraftTurn`, `PluginDraftDiagnostic`, or `PluginDraftStatus` affect:

- generation persistence in `apps/collab-api/src/modules/plugin.service.ts`
- streaming display in `apps/desktop/src/pages/Generator.tsx`
- published plugin editing in `apps/desktop/src/pages/Plugins.tsx`

