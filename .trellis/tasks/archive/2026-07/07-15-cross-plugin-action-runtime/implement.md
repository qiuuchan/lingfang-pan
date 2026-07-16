# Implement: 跨插件 Action 调用

## Preconditions

- Keep the task in `planning` until the six planning artifacts are reviewed.
- Use the fixed cross-task landing order: governance core evaluator -> this task's action contract/resolver/surface digest -> governance action adapter -> invocation runtime.
- Coordinate exact target fields with workflow/Cloud: `{package_id, release_id, sha256, action_id, action_contract_version, action_surface_sha256}`.
- Do not fold this work into `07-13-plugin-dev-sdk`; apply SDK additions only after its current changes are stable.

## Ordered Implementation Plan

### 1. Contract, Schema Subset And Golden Fixtures

- Add optional action/dependency declarations with runtime-discriminated execution binding, ActionTarget, `ActionInvocationKind(STANDARD|PREVIEW)`, restricted schema AST/decoder, ArtifactRef and invocation/error schemas to `packages/contract`.
- Implement canonical hashing and bounded validation; reject unsupported/unknown schema keywords including every regex/pattern keyword before any runtime compiles it.
- Implement conservative input/output compatibility analysis.
- Add golden good/base/bad fixtures consumed by server, desktop and Rust adapter tests.

Review gate: action field names, default action semantics, JSON subset and ArtifactRef must pass cross-child contract review before persistence work.

### 2. Release Publication And Discovery

- Extend v4 artifact manifest normalization and contract serialization without changing `.lfplugin` format version.
- Validate runtime-discriminated execution identity, action/dependency limits, ranges and surface-version bump rules during upload before artifact promotion/DB release creation: client/node/python require safe existing handler callable, workflow derives identity from entry/definition digest, and cloud uses an adapter marker with no dummy handler.
- Add lightweight exact-release action discovery/resolution; never expose artifactKey or choose latest for an existing invocation.
- Add release tests for old manifests, multi-action/default action, duplicate/invalid definitions, surface drift and immutable old releases.

Rollback point: optional manifest fields can be ignored by older consumers; disable action discovery while keeping releases valid.

### 3. Runtime Artifact Foundation

- Generalize the existing filesystem/S3 store adapter behind a runtime-artifact namespace.
- Add additive RuntimeArtifact persistence with immutable executionKind + unique `(id,executionKind)`, plus execution-kind-bound `INVOCATION|LOGICAL_EFFECT|PRINCIPAL_IMPORT|WORKFLOW_RUN|SHARED_VALUE` RuntimeArtifactGrant and bounded host-only RuntimeArtifactHold. Add composite child FKs so PREVIEW artifact cannot receive STANDARD rows; trusted PREVIEW -> STANDARD import/copy creates a new artifact ID/object audit chain.
- Implement canonical subjectKey/holderKey helpers, database unique `(artifactId,executionKind,key)`, grant expiresAt/revokedAt and hold retainUntil/releasedAt. Acquire uses insert-or-read/CAS monotonic extension only while live; expired/revoked/released rows never reopen. Cleanup uses database time and only counts active holds.
- Implement `authorizeForRunInput`, run-result ACL/download exchange and SharedStateService-only SHARED_VALUE create/read-exchange/revoke helpers. Every derivation must preserve STANDARD/PREVIEW and require a live source grant. RUN_INPUT grants revoke at run terminal; FINAL_OUTPUT grants expire/revoke with result retention even if another holder keeps the artifact alive.
- In workflow-linked invocation completion, acquire canonical run/attempt-scoped `HANDOFF_PENDING` holds for output refs in the same transaction as `SUCCEEDED`; coordinator conversion upserts EDGE/FINAL holders before CAS-releasing pending in one transaction, with a reconciler for crashes between invocation terminal and step projection.
- Implement action-scoped materialization/create helpers with cleanup on success, failure, timeout and cancel.
- Test metadata tampering, SHA mismatch, missing object, cross-team access, oversized object and failed promotion zero-change behavior；lost first response same-effect grant, bounded hold through queue delay/release cleanup, root input/result ACL and expiry, PREVIEW/PRODUCTION composite-FK mismatch, copy-new-ID, shared value update/delete cleanup, and frozen-edge consumer transfer succeed only for exact invocation while neighboring scope/team-wide access fail. Race duplicate grant/hold acquire/conversion/reconcile and verify one canonical row, no reopen and no permanent cleanup blocker；inject a crash after invocation terminal commit and verify HANDOFF_PENDING preserves the artifact until conversion.

### 4. Invocation Service And Governance

- Add invocation persistence with host-minted `requestIdempotencyScopeSha256 = hash(team + principal + trusted caller + kind + exact six-field target)`, database unique `(requestIdempotencyScopeSha256, requestIdempotencyKey)`, a non-unique effectIdempotencyKey/effect-scope digest, input digest conflict checks and expected-state transitions.
- Persist kind on the same ActionInvocation row and include it in idempotency/audit; PREVIEW uses the same transition service and only applies stricter routing/quota/Artifact TTL policy.
- Derive kind from trusted execution scope, inherit it through nested calls, and add PREVIEW workflow-node fixtures; plugin payload cannot choose kind or promote PREVIEW.
- Add a typed adapter execution-binding extension point; Cloud persists environment/deployment/routing generation on ActionInvocation before claim, while workflow plans may provide an already frozen binding. Claims/retries never resolve routing again.
- Allow `AUTHORIZED -> CANCELED|TIMED_OUT`; adapter start claims only `AUTHORIZED -> RUNNING` with deadline/cancel CAS so a committed pre-start terminal prevents handler execution.
- Extend exact runtime-access with a short-lived host-only runtime session bound to principal/team/caller release.
- Implement create/complete/fail/cancel/get service methods, authoritative input/output validation and stable errors.
- Derive trusted requiredOperations from execution context and call `GovernanceActionAdapter.authorize` exactly once before RUNNING; do not loop per operation, call the core evaluator directly, accept plugin-supplied operations, or query release/listing authorization, AI policy, entitlement, PluginGrant or TeamPluginPolicy from invocation code.
- Keep only dependency declaration, schema, ArtifactRef and nested call-chain/cycle/depth/concurrency/deadline/payload checks in the action layer, with correlated audit.
- Add call-count and dependency-boundary tests proving one adapter call -> one core evaluator call and no duplicated authorization fact reads.

Review gate: security review must show that user JSON cannot select principal/caller/team and that Owner/Admin has no bypass.

### 5. Desktop Client Adapter

- Extend installed plugin hydration to expose exact action metadata while retaining package/release/sha from the ledger.
- Add a dedicated action runtime module; do not grow `plugins-runtime.ts` into a second orchestration service.
- Load exact client handler modules into hidden opaque-origin frames and bind responses to origin=null + current contentWindow + runtime session/invocation ID + one-time nonce；navigation and first response invalidate old/replayed messages.
- Route nested calls/artifacts through host APIs, validate output server-side, and tear down every listener/frame/token.
- Add tests for spoofed postMessage, stale response, cancel/timeout, missing installation and no latest substitution.

### 6. Tauri Node/Python Adapter And Bridge

- Create focused `action_runtime/` Rust modules for manifest handler parsing, one-shot host protocol, process lifecycle and bridge session state; avoid adding more responsibilities to oversized `plugin_runner.rs`/`plugin_package_manager.rs`.
- Resolve exact installation/release paths through existing canonical ledger helpers.
- Implement bundled Node and Python action hosts, separated protocol output, bounded IO, dependency reuse, cancellation/process-tree kill and token revocation.
- Extend the localhost bridge with action/artifact routes whose session binds principal/caller/call-chain; do not expose backend JWT to plugin code.
- Run the shared conformance fixtures against Node and Python handlers.

Rollback point: adapter registration is feature-gated; ordinary script plugin start/stop and existing AI bridge routes remain unchanged.

### 7. SDK Increment

- Add typed action handler/context, `sdk.actions.call` and ArtifactRef helpers after the SDK task baseline is merged.
- Keep the public `sdk.actions.call(..., { idempotencyKey? })` option only as an opaque logical-effect hint for idempotent nested calls. Derive the actual effect key inside the trusted host from root call/principal/caller/kind/exact target/dependency alias/hint; never use or expose it as request key. Without a hint, nested domain retry remains disabled.
- Keep all existing `sdk.*` capability signatures and localhost AI routes backward compatible.
- Update create/validate/build behavior only as needed to preserve action handler files and validate declarations; do not reopen unrelated CLI scope.
- Add TypeScript and generated Python handler examples/tests without introducing a second wire format.

### 8. Cloud/Workflow Adapter Interfaces

- Add adapter registry interfaces and deterministic test fakes for cloud and workflow runtimes.
- Return `action_runtime_unavailable` while production adapters are absent.
- Hand exact envelope/conformance fixtures to `07-15-cloud-plugin-automation` and `07-15-workflow-plugin-platform`; endpoint signing/scheduler/DAG stay in those tasks.
- Hand Cloud/Web the `kind=PREVIEW` fixture and assert single-action preview creates a normal ActionInvocation, never a preview-specific state row or fake WorkflowRun.
- Assert PREVIEW WorkflowRun nodes/nested calls create PREVIEW invocations, PRODUCTION nodes create STANDARD, and standalone Cloud binding remains unchanged across routing updates/retries.

### 9. End-To-End And Spec Update

- Exercise A image -> B video -> C music with inline JSON + ArtifactRef, exact identities, nested call chain and policy decisions.
- Exercise release yank, contract mismatch, entitlement/grant deny, policy deny, invalid output, artifact tamper, timeout/cancel, idempotent replay and side-effect no-retry.
- Exercise STANDARD/PREVIEW parity for governance/state/idempotency/audit and PREVIEW-only stricter routing/quota/Artifact TTL；request key 跨 kind/principal/caller 不复用，同 request scope 相同输入复用、不同输入 conflict；新 domain attempt 可共享 effect key 但创建新 invocation。
- Exercise SDK logical-effect hints versus host-minted request keys, same-hint isolation across principal/caller/kind/target, PREVIEW -> PRODUCTION grant denial, workflow terminal-to-handoff crash recovery, root run result ACL and SHARED_VALUE grant/hold release.
- Exercise cancel/timeout versus adapter-start races from AUTHORIZED; exactly one CAS wins and a pre-start terminal produces zero handler calls.
- Regress v4 publish/install/update/rollback/run and all existing capability APIs.
- Update contract, collab-api, desktop/Tauri and SDK specs with final signatures/error matrices after implementation.

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
cargo fmt --all -- --check
cargo test -p lingfang-desktop
pnpm -C apps/desktop test
pnpm -C apps/desktop typecheck
pnpm -C apps/desktop vite:build
pnpm -C packages/plugin-sdk test
pnpm -C packages/plugin-sdk typecheck
pnpm -r typecheck
git diff --check
```

Required focused coverage:

- shared schema conformance and compatibility fixtures across implemented adapters;
- manifest action/dependency validation and contract-version surface rules;
- ArtifactRef tamper, ACL, integrity, quota, immutable parent kind/composite FK, canonical grant/hold uniqueness, live-window revocation, STANDARD/PREVIEW isolation, WORKFLOW_RUN/SHARED_VALUE exchange, HANDOFF_PENDING crash recovery and cleanup;
- exact caller/target/runtime session and governance/entitlement/grant denial;
- single compound authorization path and forbidden invocation-side entitlement/release/policy/grant dependencies；local/workflow-target/Cloud/Web PREVIEW operation-set fixtures each produce one evaluator call;
- invocation CAS, timeout/cancel/late completion and stable error codes;
- STANDARD/PREVIEW same-table/state-machine parity, kind-scoped idempotency and no preview/WorkflowRun surrogate;
- read-only retry, idempotent replay/conflict and side-effect no retry;
- client message spoofing and Node/Python process/token cleanup;
- recursion/depth/concurrency/payload limits and exact release yank behavior.

## Review Gates

- [ ] Cross-child contract review accepts ActionTarget, ArtifactRef, execution semantics, the fixed non-cyclic landing order and governance/action adapter ownership.
- [ ] JSON Schema review confirms the supported subset is bounded, portable and sufficient for workflow mapping.
- [ ] Security review confirms host-bound caller identity, ArtifactRef ACL, no privilege amplification and no private bridge bypass.
- [ ] Data review confirms additive PostgreSQL/MySQL models, `(artifactId,executionKind)` relations, grant/hold canonical uniqueness, no-reopen/live-window semantics, idempotency uniqueness and retention behavior.
- [ ] Runtime review confirms client/Node/Python share the envelope and Cloud/workflow do not invent alternatives.
- [ ] Parent integration review passes the A/B/C media scenario with exact release traceability.

## Risks And Rollback Points

- Cross-runtime validator drift can corrupt workflows. Shared fixtures are a release gate; unknown/indeterminate schemas fail closed.
- Local handlers are untrusted and Node/Python are not OS-sandboxed. Keep credentials host-only, bound tokens short-lived, and document the residual risk.
- Artifact handles can leak. They never bypass authenticated team ACL, are redacted from logs and rotate by versioned signing keys.
- Idempotency bugs can duplicate side effects. Enforce DB uniqueness + input digest and prohibit automatic side-effect retries.
- Extending existing large runtime files increases regression risk. New action modules/adapters remain separate and feature-gated.
- API/UI/runtime rollback disables adapter registration and invocation routes while leaving additive schema and immutable releases intact; never fall back to latest or undocumented routes.
