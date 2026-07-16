# Implement: 团队插件策略与治理

## Preconditions

- Keep this task in `planning` until the user reviews `prd.md`, `design.md`, and this file.
- Confirm the active implementation branch is based on `betav2` and preserve unrelated worktree changes.
- Re-read the contract, collab-api registry/RBAC and desktop TeamAdmin specs before editing.
- 按固定联合顺序交付：governance core evaluator -> `07-15-cross-plugin-action-runtime` 的 action contract/surface digest -> governance action adapter -> invocation runtime；不要让 core import action runtime，或让 invocation 自行读取授权事实。

## Ordered Implementation Plan

### 1. Shared Policy Contract

- Add `PluginPolicyOperation`, nonempty normalized requiredOperations, resource target unions, versioned `PackagePolicySurfaceV1` canonicalizer/digest, policy document v1, publish/preview/rollback requests and compound `PluginPolicyDecision` to `packages/contract`.
- Add bounded validation for rule count, target/operation combinations, high-risk TEAM-wide ALLOW rejection, SemVer/release predicates and exact package/action/workflow digests；package high-risk ALLOW 缺 surface digest 直接拒绝。
- Add stable reason-code types and golden fixtures for virtual revision 0 and the precedence matrix.
- Export through the contract barrel; do not redefine payloads in desktop or server DTOs.

Rollback point: contract additions are optional/additive; remove exports before any persisted revision exists if review fails.

### 2. Additive Persistence

- Add `TeamPluginPolicy` and immutable `TeamPluginPolicyRevision` models, relations and indexes to the canonical Prisma schema.
- Add a timestamped migration and verify both PostgreSQL and MySQL rendered schemas.
- Implement canonical document hashing and a repository/service for active revision, history, optimistic publish and copy-forward rollback.
- Keep absent teams on virtual revision 0; do not mass-create rows.
- Test concurrent `expected_revision` publish, immutable history and monotonic rollback revision.

Rollback point: leave additive tables unused; no existing registry/grant/entitlement row is migrated.

### 3. Pure Decision Engine

- Implement a side-effect-free core evaluator for source/capability checks, rule specificity, same-specificity DENY and operation defaults, with one fact-loader input contract covering membership, exact release/listing, AI/safety, entitlement, team policy and USER/ROLE grant；一次装载后对 requiredOperations 原子求交并返回逐项原因。
- Build/persist PackagePolicySurfaceV1 during release publication from validated action/workflow/shared projections; add stable-order fixtures and one-field mutation tests for every high-risk surface component.
- Implement AUDIT behavior only for existing local operations; assert high-risk remains fail-closed in every mode and feature-flag state.
- Return structured matched layers and stable reasons, with a separate redacted public projection.
- Add exhaustive table tests for platform/team/user/role/request ordering and target specificity.

Review gate: a reviewer must approve the precedence table and prove every parent-task conflict scenario with tests before call-site integration.

### 4. Converge Existing RBAC And V4 Gates

- Refactor `PluginGrantService` to resolve package grants once and reuse it from legacy available filtering, v4 package access and the new evaluator.
- Remove system team-admin and legacy enum runtime bypasses; preserve USER-before-ROLE and no-grant default allow.
- Build the evaluator-owned fact loader from exact package/release/sha, membership, AI policy, listing/review, entitlement and USER/ROLE grant facts; consumers submit identity only and may not submit precomputed authorization booleans.
- Integrate policy evaluation into v4 install/download/update/runtime-access paths without changing installation-ledger ownership.
- Add regressions for explicit admin DENY, marketplace entitlement, team-source online access and exact release mismatch.

Rollback point: keep the old runtime-access route shape compatible until new clients are released; feature flag can disable legacy-operation enforcement but not high-risk defaults.

### 5. Management API, Audit And Cache

- Add thin DTO/controller routes for get/history/preview/publish/rollback/explain, guarded by `team.plugin.grant.manage` at controller and service layers.
- Write audit rows in the same transaction as publish/rollback; add correlated decision audit for all denies and high-risk allows.
- Implement bounded per-team/revision caching keyed by sorted requiredOperations digest + resource/package surface digest, with explicit invalidation on policy, grant, role/membership, release/listing and entitlement changes.
- Ensure public explanations redact other principals, unrelated rules and internal storage details.
- Add auth, cross-team, invalid-reference, stale revision, audit atomicity and cache invalidation tests；cached operation subset must never satisfy a superset and audit preserves all operation_results.

### 6. Desktop Team Control Plane

- Extend the existing TeamAdmin plugin authorization area rather than creating a second admin application.
- Add effective-default display, source/capability constraints, package/action/workflow allowance rows, impact preview, direct publish, history and rollback.
- Reuse existing permission/session helpers; do not gate by legacy role enum or Owner/Admin display name.
- Keep the interaction simple: no break-glass, request, approval, expiry or exception states.
- Add loading/error/409 refresh behavior and responsive tests for the existing TeamAdmin layouts.

### 7. High-Risk Consumer Integration

- Provide one exported evaluator/service interface for action, workflow, Cloud, scheduler, Web preview and shared-data tasks.
- After the action task publishes its contract resolver/canonical surface digest, implement `GovernanceActionAdapter.authorize` in the governance module and assert exact action surface plus trusted requiredOperations binding before one core evaluator call.
- Make `ActionInvocationService` call only this adapter once. Add architecture/dependency tests that forbid direct invocation imports or queries for entitlement, PluginGrant, TeamPluginPolicy, listing/release authorization and forbid a second core evaluator call.
- Require workflow callers to present exact workflow release + plan digest and validate node membership before using workflow-scoped ALLOW.
- Require Cloud trial/scheduled/shared-data consumers to submit their complete trusted operation set in one request; reject generic `run_local` reuse, missing execute_cloud/web_preview, plugin-supplied operations and evaluator-per-operation loops.
- Add contract tests/fakes so future child tasks cannot bypass the evaluator even if their production implementation lands later.

Review gate: parent-task integration review must trace every high-risk entry point to this evaluator before Milestone 1 is accepted.

### 8. Rollout And Documentation

- Add `off|audit|on` configuration for existing local operations and document that high-risk defaults are invariant.
- Run shadow evaluation against representative existing-team fixtures; inspect would-deny reasons before enabling enforcement.
- Update the relevant contract, collab-api and desktop specs after implementation with the final signatures and error matrix.
- Document rollback as feature-flag change or copy-forward policy revision, never direct DB edits.

## Validation Commands

```bash
pnpm -C packages/contract typecheck
pnpm -C packages/contract test
pnpm -C apps/collab-api prisma:generate
DATABASE_PROVIDER=postgresql DATABASE_URL=postgresql://user:pass@localhost:5432/lingfang pnpm -C apps/collab-api prisma:validate
DATABASE_PROVIDER=mysql DATABASE_URL=mysql://user:pass@localhost:3306/lingfang pnpm -C apps/collab-api prisma:validate
pnpm -C apps/collab-api typecheck
pnpm -C apps/collab-api test -- --testTimeout=60000
pnpm -C apps/collab-api build
pnpm -C apps/desktop test
pnpm -C apps/desktop typecheck
pnpm -C apps/desktop vite:build
pnpm -r typecheck
git diff --check
```

Focused tests must include:

- virtual revision 0 for old local versus every high-risk operation;
- platform > team > user > role > request precedence;
- action adapter one-call path: one fact load, one core evaluation, no invocation-side entitlement/release/policy/grant checks;
- user ALLOW overriding role DENY, same-scope DENY, and Owner/Admin no bypass;
- source/capability/version/release constraints and action/workflow surface invalidation;
- publish CAS, immutable history, rollback copy-forward and audit atomicity;
- cache invalidation for policy, grant, membership, release and entitlement changes;
- v4 publish/install/update/purchase/download/run regressions.

## Review Gates

- [ ] Product review confirms the fixed defaults and no break-glass/approval state machine.
- [ ] Contract review confirms the non-cyclic landing order and operation/resource fields align with action, workflow, Cloud and shared-data tasks.
- [ ] Security review confirms no principal/team can be selected by plugin input and no Owner/Admin bypass remains.
- [ ] Data review confirms additive PostgreSQL/MySQL migrations and immutable revision semantics.
- [ ] UI review confirms direct publish/history/rollback only, with no duplicate role or grant truth source.
- [ ] Integration review traces every current and planned high-risk entry point to the evaluator，并证明 action invocation 只经一个 governance action adapter。

## Risks And Rollback Points

- Grant convergence can change explicit DENY behavior for system admins. Land it with focused fixtures, audit output and the legacy-operation feature flag.
- A stale cache could over-authorize after deny/revocation. Cache keys include revision and mutable authorization versions; uncertainty must fail to DB, not reuse stale ALLOW.
- Package-level ALLOW can silently widen on release updates unless surface digests are mandatory. Reject missing/mismatched digests for high-risk operations.
- AUDIT mode can be misread as globally permissive. Tests and configuration validation must enforce high-risk DENY regardless of mode.
- UI/API rollback may leave additive tables and revisions in place safely. Do not down-migrate or delete policy history during an operational rollback.
