# @lingfang/contract 后端规范

## Scope

适用于 `packages/contract/src/`。这个包是 TS + zod 的契约单一事实来源；后端（NestJS `apps/collab-api`）按相同字段实现。

## Pre-Development Checklist

- 改 schema、枚举、默认值或请求/响应类型时，先读 [schema-contracts.md](./schema-contracts.md)。
- 改服务端或前端依赖这些字段的行为时，先读 [cross-runtime-alignment.md](./cross-runtime-alignment.md)。
- 同步检查 `apps/collab-api/src/modules/`、`apps/desktop/src/lib/types.ts` 和相关页面。

## Quality Check

- Contract typecheck: `pnpm -C packages/contract typecheck`
- Contract tests if added: `pnpm -C packages/contract test`
