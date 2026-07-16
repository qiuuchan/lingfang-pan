# Design: 跨插件 Action 调用

## 1. Architecture And Boundaries

```text
plugin/workflow caller
  -> host-bound caller identity
  -> ActionInvocationService.create
  -> declared dependency alias + exact action surface resolution（non-authorization）
  -> GovernanceActionAdapter.authorize（唯一授权调用）
       -> exact action contract/surface binding
       -> PluginGovernanceEvaluator（一次 fact load/evaluation）
  -> input schema + ArtifactRef + call-chain checks
  -> runtime adapter (client | nodejs | python | cloud | workflow)
  -> output schema + ArtifactRef validation
  -> terminal invocation + audit
```

- `packages/contract` owns action, restricted schema, ArtifactRef, `ActionInvocationKind = STANDARD | PREVIEW` and invocation envelopes.
- `apps/collab-api` 的 action 模块 owns release action discovery、contract/surface canonicalization、schema/artifact/call-chain validation、invocation state and audit；governance 模块独占 entitlement/release/policy/grant authorization 和 action governance adapter。
- desktop/Tauri owns installed-release lookup and local adapters; it does not decide tenant authorization.
- Cloud and workflow tasks register adapters behind the same interface. They may not define alternate envelopes.
- Existing manifest `capabilities` remains the handler-to-host permission list. `actions` is the release-to-caller export list.

联合依赖顺序固定为 `governance core evaluator -> action contract/surface digest -> governance action adapter -> invocation runtime`。action contract 层不依赖治理数据，governance core 不导入 action runtime，`ActionInvocationService` 也不直接调用 core evaluator。

## 2. Manifest Contract

Add optional fields to `PluginManifest`; omission preserves all existing manifests.

```json
{
  "actions": [{
    "action_id": "generate_image",
    "name": "生成图片",
    "description": "",
    "action_contract_version": "1.0.0",
    "input_schema": { "type": "object", "properties": {}, "required": [], "additionalProperties": false },
    "output_schema": { "type": "object", "properties": {}, "required": [], "additionalProperties": false },
    "execution_semantics": "idempotent",
    "timeout_seconds": 900,
    "cloud_capable": false,
    "handler": { "entry": "actions/generate.mjs", "export": "run" }
  }],
  "action_dependencies": [{
    "dependency_id": "video_generator",
    "package_id": "uuid",
    "release_version_range": "^1.0.0",
    "action_id": "generate_video",
    "action_contract_version_range": "^1.0.0"
  }]
}
```

Limits: 32 actions and 64 dependencies per release; IDs match `^[a-z][a-z0-9._-]{0,63}$`; `default` is the reserved conventional action, not an implicit null ID. Action decoding is discriminated by release runtime:

- `client|nodejs|python` require `handler` with an existing safe artifact-relative entry and the runtime-appropriate export/callable; client handlers are self-contained browser modules in MVP.
- `workflow` forbids a per-action handler path; only its `default` action is bound to the manifest workflow entry and canonical `definition_sha256` owned by the workflow task.
- `cloud` forbids a package handler path; its binding is the Cloud adapter marker, and a verified exact-target deployment is required only when creating an invocation/plan.

`cloud_capable` remains orthogonal: a local or workflow action may also have a registered Cloud deployment without changing its package handler identity. Validators reject missing local handlers and dummy/extra workflow or cloud handlers.

At publish, canonical JSON hashing creates `input_schema_sha256`, `output_schema_sha256` and `action_surface_sha256` over action identity, schemas, execution semantics, timeout, cloud flag and runtime-discriminated execution identity: local handler entry/callable, workflow entry + definition digest, or the cloud deployment-adapter marker. The selected deployment ID is not part of release surface and is frozen separately per plan/invocation. If the same action ID changes surface without increasing its strict SemVer contract version, publish fails. Removed actions remain available only through the immutable old release.

Dependencies use ranges only for discovery. Every invocation records an exact target; released workflows additionally freeze exact targets in their definition.

## 3. Restricted JSON Schema

Use a documented Draft 2020-12 subset:

- root input/output must be `type: object`;
- supported: `type`, `properties`, `required`, `additionalProperties: false`, `items`, `enum`, `const`, numeric/string/array bounds, and formats `date-time`/`uuid`;
- nullable values use a type array containing `null`;
- the only `$ref` is `lingfang://schemas/artifact-ref/v1`;
- reject remote/local arbitrary `$ref`, recursion, `$dynamicRef`, `allOf/anyOf/oneOf/not`, conditionals, unevaluated keywords, `pattern`/all regex keywords, custom executable formats and unknown keywords.

Limits: 64 KiB canonical schema, depth 12, 512 schema nodes, 128 properties per object and 256 KiB canonical inline invocation payload. Objects never accept undeclared fields. MVP deliberately has no user-supplied regex execution path.

The contract package owns schema decoding, canonicalization and compatibility analysis. Server is authoritative at invocation time. Runtime adapters share golden fixtures and must not reinterpret unknown keywords. Compatibility for an existing caller requires the new input to accept old valid inputs and the new output to remain assignable to the old output; indeterminate analysis is incompatible.

## 4. ArtifactRef And Runtime Artifacts

```ts
type ArtifactRefV1 = {
  type: 'artifact_ref';
  artifact_id: string;
  media_type: string;
  size_bytes: number;
  sha256: string;
  authorization: {
    scope: 'TEAM';
    team_id: string;
    handle: string;
  };
};
```

`handle` is a versioned server MAC over artifact ID, team, media type, size and SHA. It detects tampering but does not bypass authenticated team/membership/policy checks.

Add `RuntimeArtifact`: ID, team, creator invocation, immutable `executionKind=STANDARD|PREVIEW`, private object key, media type, size, SHA, status, retention timestamps and audit fields；数据库增加 unique `(id,executionKind)` 供子表复合关系引用。`RuntimeArtifactGrant` 保存 artifactId/executionKind、targetKind=`INVOCATION|LOGICAL_EFFECT|PRINCIPAL_IMPORT|WORKFLOW_RUN|SHARED_VALUE`、targetId、scopeDigest、canonical subjectKey、expiresAt、revokedAt 和 audit fields；`RuntimeArtifactHold` 保存 artifactId/executionKind、holderKind/holderId/purpose/scopeDigest、canonical holderKey、retainUntil、releasedAt。两张子表都以 `(artifactId,executionKind)` 复合外键引用父行，因此数据库层拒绝跨 kind 行。PRINCIPAL_IMPORT 绑定 team + principal subject + trusted import session且只能由 upload/import service 创建。

Grant owner 按共享 canonical JSON 计算 `subjectKey=sha256(targetKind,targetId,scopeDigest,executionKind)`，数据库 unique `(artifactId,executionKind,subjectKey)`。scopeDigest 是 owner/version discriminated contract：WORKFLOW_RUN 至少包含 `purpose=RUN_INPUT|FINAL_OUTPUT` + run/plan/result pointer，SHARED_VALUE 包含 namespace generation/key/value revision，LOGICAL_EFFECT 包含完整 effect scope；不同生命周期不能共用 subject row。Grant 仅在 `revokedAt IS NULL AND expiresAt > databaseNow()` 时 live；并发 acquire 使用 insert-or-read，已存在 live row 只能由同 owner 以 expected expiry CAS 单调延长到 owner cap，expired/revoked row 永不重开。Hold 同理计算 `holderKey=sha256(holderKind,holderId,purpose,scopeDigest,executionKind)` 并 unique `(artifactId,executionKind,holderKey)`；scopeDigest 区分 pending/edge/final/input 与 holder generation。只有 `releasedAt IS NULL AND retainUntil > databaseNow()` 才 active。并发 acquire 返回同一 row或 CAS 单调延长，released/expired row 不重开；新的逻辑 holder 必须包含新 generation/scope。

Reuse the existing filesystem/S3 `ArtifactStore` adapter behind a runtime-artifact namespace; never expose object keys. Upload is staged, hashed, quota-checked, promoted, then committed. Download rechecks signed metadata, DB row, team, parent/grant execution kind and a live concrete grant. PREVIEW -> STANDARD import/copy 即使底层对象可做 server-side copy，也必须创建新 RuntimeArtifact ID、重新记录 SHA/审计并只建立 STANDARD grants；禁止在原 artifact 上追加不同 kind。

For idempotent actions, artifact creation stores both the current invocation grant and its canonical effect-scope digest. A later ActionInvocation with the same verified principal/caller/kind/exact target/effect key may atomically attach its invocation grant before validating a replayed ArtifactRef; different scope cannot probe or reuse it. Artifact expiry is `max(normalTTL, effectReplayUntil)` and cleanup waits for both, while PREVIEW remains bounded by its configured replay window. No effect path creates a team-wide artifact permission.

RuntimeArtifactHold can be created/extended only by registered trusted services while the artifact and existing holder row are live, with platform maximum `retainUntil`; PREVIEW uses a shorter cap. Cleanup requires both artifact retention/effect replay elapsed and zero active holds under the database-time predicate above. Holds carry no read authorization. Hold conversion first upserts every destination holder, then in the same transaction CAS-releases the source holder；unique holderKey makes concurrent coordinator/reconciler calls converge, and a released HANDOFF_PENDING row cannot be recreated by a late completion. A workflow/nested host resolving a frozen mapping edge verifies team, execution kind, source attempt/output pointer, run hold and exact destination invocation, then atomically adds only that invocation grant；runtime code cannot request an arbitrary transfer. Signed download/upload credentials are re-issued from live DB grants and never frozen into workflow data.

All grant derivation is same-kind: PREVIEW grants/holds can only produce PREVIEW grants/holds, and STANDARD can only produce STANDARD. `authorizeForRunInput` first proves the authenticated principal has a live source invocation, prior workflow run result or explicit upload/import grant and that its kind equals the destination run scope, then atomically creates the destination WORKFLOW_RUN grant + hold；matching team alone is insufficient. A PREVIEW artifact enters production only through a trusted import/copy action that creates a new STANDARD artifact. RUN_INPUT grant expires no later than run deadline and is revoked at terminal. Final mapped outputs receive a FINAL_OUTPUT grant to their root run whose expiresAt equals the bounded result-retention deadline. Retention worker writes revokedAt when the deadline passes；run result/download and future `authorizeForRunInput` both require current membership/initiator-or-admin ACL plus a live grant. Artifact existence or another run/shared hold never revives an expired run grant. Plugin adapters never receive the run grant directly.

For a workflow-linked invocation, `complete` validates output and, in the same database transaction that commits `SUCCEEDED`, acquires canonical short bounded `HANDOFF_PENDING` holds for every output ArtifactRef, scoped to execution kind + run + step attempt. The workflow coordinator transaction upserts the required `EDGE|FINAL_OUTPUT` holders before CAS-releasing pending；unique holderKey makes duplicate coordinator/reconciler calls converge. A reconciler can repeat that conversion from the persisted invocation/attempt relation, so a process crash after invocation success cannot expose an unpinned artifact to normal-TTL cleanup or leave duplicate active holds.

SHARED_VALUE grants are also host-only and STANDARD-only. SharedStateService proves the writing invocation's live source grant, then binds each nested ArtifactRef to namespace ID + generation + key + value revision and acquires canonical renewable bounded SHARED_VALUE grant/hold rows. An authorized read atomically exchanges that exact live value grant for the current STANDARD invocation grant. Replacing/deleting the value or clearing/reactivating the namespace writes grant.revokedAt and hold.releasedAt in the value transaction；reconciliation compares live value-artifact edges with canonical subject/holder keys and never grants by team alone.

Action context provides `artifacts.read(ref)` and `artifacts.create(...)`. Local adapters may materialize an action-scoped temp file; only ArtifactRef crosses the handler boundary and temp files are removed on every terminal path. External URLs must first be ingested through a controlled artifact operation.

## 5. Invocation Identity And API

Exact target:

```ts
type ActionTarget = {
  package_id: string;
  release_id: string;
  sha256: string;
  action_id: string;
  action_contract_version: string;
  action_surface_sha256: string;
};
```

Invocation context also carries `kind: STANDARD | PREVIEW`, `invocation_id`, `root_invocation_id`, optional `parent_invocation_id`, `principal {team_id,user_id,team_role_id}`, trusted caller identity, workflow identity when applicable, `call_chain`, `policy_revision`, deadline, attempt, `request_idempotency_key`, optional `effect_idempotency_key` and optional trusted adapter execution binding.

`ActionInvocation.kind` 是本任务持久化契约的必填列，由宿主执行 scope 派生：单 action preview 及 `WorkflowRun.executionScope=PREVIEW` 的所有节点/子工作流写 PREVIEW，普通调用和 PRODUCTION workflow 写 STANDARD；nested call 继承 root kind，PREVIEW 不可提升。不存在由调用 payload 推断 kind 的路径。

ActionInvocation 允许持久化 discriminated `execution_binding`，但不拥有各 adapter 的选路算法。Cloud binding 由 Cloud resolver 产生 `{ environment, deployment_id, routing_generation }`：standalone invocation 先生成 invocation ID，再按该 ID 选路，并在 AUTHORIZED row 创建事务中原子写 binding；workflow node 从 root frozen plan 复制 binding。adapter claim、retry 和 usage 只读该 binding，不重新查询 active routing。Cloud task可以增加 relation/index，但不能增加第二套 invocation 状态。

Desktop calls use a short-lived runtime session issued by exact `runtime-access`; the session binds principal and caller release. Script plugins receive only a localhost token bound to that host session. Client frame identity comes from the actual `contentWindow`, never the posted `pluginId`. Workflow/Cloud workers use internal service identities bound to a frozen workflow or target release.

Suggested routes:

```text
GET  /api/plugin-releases/:releaseId/actions
POST /api/plugin-actions/resolve
POST /api/plugin-actions/invocations
POST /api/plugin-actions/invocations/:id/complete
POST /api/plugin-actions/invocations/:id/fail
POST /api/plugin-actions/invocations/:id/cancel
GET  /api/plugin-actions/invocations/:id
```

Create 调用一次 governance action adapter，再执行 action-owned dependency/schema/ArtifactRef/call-chain checks，全部通过后才返回 invocation ID/deadline。Complete validates output and uses compare-and-set. Plugins never call complete directly; the host or trusted worker does.

## 6. State And Idempotency

```text
AUTHORIZED -> RUNNING -> SUCCEEDED
                      -> FAILED
                      -> CANCELED
                      -> TIMED_OUT
AUTHORIZED ---------> CANCELED
           ---------> TIMED_OUT
```

Every transition matches the expected prior state. Adapter claim uses `AUTHORIZED -> RUNNING` CAS only while the deadline is future and no cancel/timeout terminal has committed. Cancel/timeout may CAS directly from AUTHORIZED, or from RUNNING while signaling the adapter; whichever transition wins prevents the competing start/terminal overwrite. Late start/complete/fail is ignored and audited.

`STANDARD` 与 `PREVIEW` 共用本表、状态机、transition service、idempotency uniqueness、terminal audit 和 retention worker。PREVIEW 由受信 Web/Cloud preview caller 指定，不能由插件 payload 自选；它只应用更小的 adapter routing allowlist、quota 与 Artifact TTL，并记录这些收窄值。PREVIEW 不跳过治理/schema/ArtifactRef 校验，不创建 `PreviewRun`，也不伪造 `WorkflowRun`。idempotency scope 包含 kind，STANDARD 与 PREVIEW 不能互相复用结果。

- `read_only`: platform may retry within the workflow limit.
- request dedupe: the host computes `request_idempotency_scope_sha256` from canonical team + principal subject + trusted caller identity + kind + exact six-field ActionTarget; plugin payload cannot set it. Database unique is `(request_idempotency_scope_sha256, request_idempotency_key)`. Within that scope, same key/input returns the same invocation and same key/different input returns `action_idempotency_conflict`; every new domain retry has a different request key.
- `idempotent`: automatic retry additionally requires `effect_idempotency_key`, scoped by the same principal/caller/kind/target plus root logical effect identity. All retries of that logical effect pass the same key to the handler/endpoint, but it is not unique on ActionInvocation rows; a retryable FAILED invocation therefore cannot block creation of the next request attempt. The handler contract must return the same committed effect/result for replays or safely continue reconciliation.
- `side_effect`: adapter never retries automatically; transport ambiguity is returned to the caller for explicit reconciliation.

Invocation rows retain canonical input/output needed for idempotent replay within bounded retention, plus digests and ArtifactRef IDs for audit. Secrets and temporary paths are excluded.

## 7. Authorization And Call Chains

Before RUNNING, authorization and action-owned validation are deliberately separated:

1. action contract resolver verifies the caller's declared dependency alias (unless trusted workflow executor) and resolves its range to the requested exact action descriptor/surface；这是非授权 preflight，不读取 entitlement/grant/team policy，错误对外统一收敛以免探测其他 package。
2. `ActionInvocationService` derives a trusted nonempty requiredOperations set from target/adapter/runtime/preview context, then submits it with host-bound caller identity and that exact action surface to `GovernanceActionAdapter.authorize` exactly once. The base is invoke_action; target runtime=workflow adds run_workflow, Cloud execution adds execute_cloud, and Web preview adds web_preview.
3. The adapter verifies exact action contract/surface and requiredOperations/context binding and invokes `PluginGovernanceEvaluator` exactly once; that evaluator alone loads active principal/team, exact release/listing/AI/safety facts, marketplace/team entitlement, package USER/ROLE grants and team policies, then atomically intersects every required operation under one revision.
4. After ALLOW, action runtime verifies only input schema, every ArtifactRef ACL/integrity constraint, call-chain and resource limits.

Invocation code must not import/query entitlement, PluginGrant, TeamPluginPolicy or release/listing authorization services. It also must not loop over requiredOperations or accept them from plugin payload. A failure from the adapter is terminal before action-owned checks and handler start; a later schema/artifact/call-chain failure does not trigger a second governance evaluation.

Nested calls retain root principal/team and append the current exact target as caller. Workflow authorization can only be used for nodes in its frozen plan. Default limits are platform-configured and tested: reject repeated target cycles, depth above 8, root fan-out/concurrency above 16, expired deadlines and oversized payloads before handler start.

## 8. Runtime Adapters

All adapters implement `invoke(envelope, signal) -> output` and consume the same conformance suite.

### Client

- Host loads the exact installed release action module into a hidden opaque-origin sandbox without `allow-same-origin`.
- Input arrives with runtime session ID + invocation ID + one-time nonce; response requires `event.origin === "null"`, `event.source === currentFrame.contentWindow`, matching IDs and an unconsumed nonce. Navigation invalidates the frame/session binding; first valid response consumes nonce, and late/duplicate responses are rejected.
- Host capabilities/nested actions/artifacts are exposed through an invocation-scoped bridge; teardown removes frame, listeners and tokens.

### Node.js And Python

- Tauri resolves the exact installation/release path and launches a bundled one-shot action host, not the plugin's long-lived UI process.
- The host imports the declared module/callable and exchanges envelope/result through private length-bounded files or pipes; stdout/stderr remain logs and cannot masquerade as output.
- Existing venv/node_modules may be reused after dependency preparation. Cancellation kills the process tree and revokes invocation bridge tokens.
- Nested action and artifact calls use the localhost bridge session bound to principal/caller/call chain.

### Cloud And Workflow

- This task defines and tests adapter registration and the common envelope.
- Missing adapters fail `action_runtime_unavailable` without fallback.
- The Cloud task owns endpoint bindings, HTTPS signatures, secrets, worker retries and deployment; the workflow task owns DAG/run/step execution. Both call the same create/complete service and validators.
- Cloud/Web 单 action 在线试跑调用同一 create service 并设置 `kind=PREVIEW`；Cloud 只提供受限 routing/quota/TTL 参数，不拥有另一套 preview persistence/state machine。

## 9. SDK Surface

After the existing `07-13-plugin-dev-sdk` changes stabilize, add typed APIs without reopening its task:

```ts
sdk.actions.call(dependencyId, input, { idempotencyKey?, signal? })
context.artifacts.read(ref)
context.artifacts.create(input)
```

Plugins call dependency aliases, not arbitrary package/release IDs. `idempotencyKey` is only an opaque logical-effect hint for an `idempotent` nested action. The trusted host derives the final effect key from root logical call identity + principal + caller + kind + exact target + dependency alias + hint; the raw hint is never a platform scope or request key. Every request/domain-attempt key is minted by the host, and omitting the hint means the nested call is not eligible for automatic idempotent domain retry. Handler types expose validated input, artifact helpers, nested action calls, deadline and cancellation; they never expose JWT, runtime session token, object key, host-derived keys or policy internals.

## 10. Errors, Audit And Security

Stable errors include `action_not_found`, `action_contract_mismatch`, `action_input_invalid`, `action_output_invalid`, `action_dependency_denied`, `action_policy_denied`, `action_artifact_invalid`, `action_cycle_detected`, `action_depth_exceeded`, `action_timeout`, `action_cancelled`, `action_runtime_unavailable`, `action_execution_failed` and `action_idempotency_conflict`.

Audit records invocation kind, exact caller/target, principal/team, policy revision, root/parent invocation, state, duration, retry/idempotency metadata and artifact IDs, but not raw binary, secrets or local paths.

Threat boundaries:

- caller identity is host-bound; posted IDs are informational only;
- target resolution never uses latest after invocation creation;
- schema validation occurs before and after untrusted handler execution;
- ArtifactRef signature and ACL stop metadata tampering/cross-tenant access;
- URL/path/base64 media boundaries are rejected;
- recursion/concurrency/deadline limits stop unbounded call graphs;
- local Node/Python remains untrusted user-level code, so this task limits official platform operations but does not claim OS containment.

## 11. Compatibility And Rollback

- Manifest additions are optional; old release serialization stays valid.
- Prisma additions are additive; no existing artifactKey, release or installation row is rewritten.
- High-risk action endpoints remain default-deny until team policy and adapters are enabled.
- Feature flags can disable discovery/invocation adapters while keeping contract/schema columns deployed; no fallback to private bridge routes is allowed.
- Published workflows and active invocations keep exact release/sha/action versions; update/rollback never rewrites them.
