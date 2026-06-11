# @lingfang/contract 前端规范

## Scope

适用于前端消费 `packages/contract` 的场景。该包没有 React 组件、hooks 或 UI 状态；它提供 zod schema 和 TS 类型。

## Pre-Development Checklist

- 先读 [../backend/schema-contracts.md](../backend/schema-contracts.md)。
- 若变更会影响服务端或桌面前端，读 [../backend/cross-runtime-alignment.md](../backend/cross-runtime-alignment.md)。
- 同步检查使用同名字段的 `apps/desktop/src/lib/types.ts` 和页面代码。

## Frontend Usage

Do not add frontend-only UI helpers to this package. Keep UI formatting in `apps/desktop/src/lib/` or page components.

Good package contents:
- zod schemas
- inferred TS types
- pure contract helpers like `resolveGrant()`

Avoid:
- React components
- HTTP clients
- localStorage/session helpers
- display labels for one UI screen

## Quality Check

- Contract typecheck: `pnpm -C packages/contract typecheck`
- If desktop local payload types changed, also run `pnpm -C apps/desktop typecheck`
