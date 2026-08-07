# 云端插件分享实施计划

## Steps

1. Read relevant specs:
   - `.trellis/spec/server/backend/index.md`
   - `.trellis/spec/guides/cross-layer-thinking-guide.md`
   - `.trellis/spec/contract/backend/schema-contracts.md`

2. Schema and migration
   - Extend `apps/collab-api/prisma/schema.prisma`.
   - Add migration for plugin fields/enums/models.
   - Regenerate Prisma client if required by project scripts.

3. Validation helpers
   - Add manifest parser/normalizer.
   - Add file path validator.
   - Add file size limits.
   - Add capability validator.

4. Service methods in `collab.service.ts`
   - `uploadPlugin`
   - `myPlugins`
   - `availablePlugins(userId)` adjusted to team context
   - `submitPluginMarketplace`
   - `reviewPendingPlugins`
   - `approvePlugin`
   - `rejectPlugin`

5. Controller routes
   - Extend `plugins.controller.ts` for user APIs.
   - Extend `admin.controller.ts` for review APIs.

6. Tests
   - Upload success.
   - Missing team failure.
   - Invalid manifest failure.
   - Path traversal failure.
   - Submit permission failure.
   - Review approve/reject success.

## Validation Commands

```bash
pnpm -C apps/collab-api typecheck
pnpm -C apps/collab-api test
```

## Manual Checks

- Upload plugin as team member.
- Verify team member can list it.
- Submit marketplace as author.
- Approve as platform admin.
- Verify public visibility.

## Risky Files

- `apps/collab-api/prisma/schema.prisma`
- `apps/collab-api/src/modules/collab.service.ts`
- `apps/collab-api/src/modules/plugins.controller.ts`
- `apps/collab-api/src/modules/admin.controller.ts`

## Done When

- API shape is implemented.
- Permissions are enforced.
- Upload validation is covered.
- Typecheck and tests pass.
