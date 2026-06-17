# 插件创建前端组织规范

## Scope

适用于 `apps/desktop/src/pages/PluginCreatorHome.tsx`、`apps/desktop/src/lib/plugin-draft.ts` 和 `apps/desktop/src/components/creator/**`。

## Large File Split Boundaries

`PluginCreatorHome.tsx` 只保留页面装配和少量路由级状态。以下职责必须外移：

- CLI/provider/model readiness -> hook 或 `lib/plugin-creator/**`
- session start/stop/send -> hook
- upload/review actions -> API helper
- draft merge/conversation helpers -> `lib/plugin-draft/**`
- UI panel -> `components/creator/**`

`plugin-draft.ts` 需要按纯函数职责拆分：

- providers/model labels
- transcript parsing
- tool-card parsing
- structured package parsing
- draft builders and merge
- manifest parsing
- preview document generation
- recent plugins storage
- diagnostics

## Contracts

拆分时保持现有 import surface 稳定。推荐保留 `src/lib/plugin-draft.ts` 作为 barrel/re-export，逐步把实现移到 `src/lib/plugin-draft/*.ts`。

## Tests Required

- `pnpm -C apps/desktop typecheck`
- `pnpm -C apps/desktop test`
- 改 UI 装配时补跑 `pnpm -C apps/desktop vite:build`

## Test Organization

When `plugin-draft.ts` is split into `src/lib/plugin-draft/*.ts`, split its tests by the same behavior groups instead of keeping one large `plugin-draft.spec.ts`:

- `manifest.spec.ts` for path safety, capabilities, fallback entry files and structure validation.
- `structured-package.spec.ts` for fenced block parsing and package status.
- `draft-builders.spec.ts` for local/sandbox draft construction and follow-up merge behavior.
- `conversation.spec.ts` for chat-only turns and structured-block gate behavior.
- `transcript-title.spec.ts` for transcript slicing and title helpers.

Shared fixtures such as `probeWith()` belong in `plugin-draft/test-helpers.ts`. Tests may import production APIs through `@/lib/plugin-draft` to preserve the public barrel contract.

## Wrong vs Correct

Wrong:

```ts
// plugin-draft.ts 同时处理 transcript、manifest、preview、recent storage
```

Correct:

```ts
export * from './plugin-draft/transcript';
export * from './plugin-draft/manifest';
export * from './plugin-draft/preview';
```
