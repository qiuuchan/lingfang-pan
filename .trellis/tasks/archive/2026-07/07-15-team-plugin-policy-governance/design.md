# Design: 团队插件策略与治理

## 1. Architecture And Ownership

本任务在既有事实源之上增加“团队上限”，不复制现有身份、发行、权益或 grant 数据。

```text
调用入口
  -> PluginGovernanceEvaluator.evaluate（唯一授权调用）
       -> membership + exact release/listing + AI/safety + entitlement facts
       -> TeamPluginPolicyService（team upper bound）
       -> PluginGrantService（USER, then ROLE）
       -> requested scope intersection
  -> PolicyDecision + AuditLog
```

- `packages/contract` 拥有 operation、resource、policy document 和 decision schema。
- `apps/collab-api` 的 governance 模块拥有策略修订、事实装载、统一 evaluator、审计、HTTP 控制面及各领域 governance adapter，是授权权威实现。
- `PluginPackage`、`PluginRelease`、`MarketplaceListing`、`PluginEntitlement`、`Role`、`PluginGrant` 和 membership 保持各自的单一事实源。
- 桌面 `TeamAdmin` 复用现有插件授权管理入口，增加策略编辑、影响预检、历史和回滚；平台 `collab-admin` 继续负责 v4 发行治理，不承载团队策略真相。
- 后续 workflow、Cloud、schedule、Web preview 和 shared data 模块只调用统一 evaluator 或其治理 adapter。action invocation 只调用 `GovernanceActionAdapter.authorize` 一次，不在 invocation service 内串联 release/entitlement/grant/policy gate。

action 的跨任务依赖与落地顺序不可形成循环：

```text
PluginGovernanceEvaluator core
  -> action contract + canonical surface digest（action task owns）
  -> GovernanceActionAdapter（governance module owns）
  -> ActionInvocationService/runtime（action task owns）
```

core evaluator 不导入 action runtime；action contract 层不读取授权数据；adapter 只把 action registry 解析出的可信精确 target/surface 绑定到通用 resource 后调用 core evaluator。invocation runtime 不直接调用 core evaluator。

## 2. Shared Contracts

新跨 runtime 契约使用 snake_case；现有 RBAC HTTP 行保持原 camelCase，不做无关迁移。

### 2.1 Operations

```text
install
update
run_local
invoke_action
run_workflow
execute_cloud
manage_schedule
trigger_schedule
shared_data_read
shared_data_write
web_preview
```

`invoke_action`、`run_workflow`、`execute_cloud`、两种 schedule、两种 shared data 为 high-risk。`web_preview` 是否 high-risk 由预览模式决定：静态/client 沙箱可按普通规则，Cloud 试运行同时请求 `execute_cloud`。

### 2.2 Resource Identity

```ts
type PluginPolicyResource = {
  team_id: string;
  package_id: string;
  release_id: string;
  sha256: string;
  source_kind: PluginReleaseSourceKind;
  runtime_type: RuntimeType | 'workflow';
  package_policy_surface_sha256: string;
  declared_capabilities: CapabilityKind[];
  action?: {
    action_id: string;
    action_contract_version: string;
    action_surface_sha256: string;
  };
  workflow?: {
    workflow_release_id: string;
    workflow_plan_sha256: string;
  };
};
```

身份由 registry、runtime session 或 workflow executor 组装；插件 payload 不得自报 team/principal/caller。action 字段由 action task 的精确 release contract resolver 和 canonical surface digest 提供给 governance adapter，不能由 invocation JSON 自报。不存在 release/sha 的 legacy/local draft 只能走兼容的 `run_local`，不能成为高风险调用目标。

#### PackagePolicySurfaceV1

治理 contract 拥有 aggregate schema、排序和 canonical hash 算法；registry 发布事务只消费各 owner 已验证的投影并持久化 `packagePolicySurfaceSha256`，不接受 manifest 自报 digest：

```ts
type PackagePolicySurfaceV1 = {
  schema_version: 1;
  runtime_type: RuntimeType | 'workflow';
  declared_capabilities: CapabilityKind[];
  actions: Array<{
    action_id: string;
    action_contract_version: string;
    action_surface_sha256: string;
    cloud_capable: boolean;
    previewable: boolean;
  }>;
  workflow?: { workflow_release_id: string; workflow_plan_sha256: string; cloud_eligible: boolean };
  shared_namespaces: Array<{
    name: string;
    active_schema_version: string;
    read: boolean;
    write: boolean;
  }>;
  schedule_eligible: boolean;
};
```

arrays 按稳定 identity 排序并去重，unknown field 拒绝。action、workflow、shared owners 分别提供自己的 canonical projection；治理只拥有 aggregate。package 级任一高风险 ALLOW 在发布 policy 时必须保存当前精确 release 的 digest，运行时 resource digest 不同即 `package_surface_changed`。这覆盖 action 增删/变更、cloud/preview flag、workflow plan、shared schema/scope 和 schedule eligibility，不能用旧 package allow 静默扩权。

### 2.3 Policy Document

每个 revision 保存一个完整、受 schema 约束的 JSON document：

```ts
type TeamPluginPolicyDocumentV1 = {
  schema_version: 1;
  enforcement_mode: 'AUDIT' | 'ENFORCE';
  allowed_source_kinds: PluginReleaseSourceKind[];
  denied_capability_kinds: CapabilityKind[];
  rules: Array<{
    rule_id: string;
    effect: 'ALLOW' | 'DENY';
    operations: PluginPolicyOperation[];
    target:
      | { kind: 'TEAM' }
      | { kind: 'PACKAGE'; package_id: string; approved_surface_sha256?: string }
      | {
          kind: 'ACTION';
          package_id: string;
          action_id: string;
          action_contract_version: string;
          action_surface_sha256: string;
        }
      | { kind: 'WORKFLOW'; workflow_release_id: string; workflow_plan_sha256: string };
    version_range?: string;
    release_ids?: string[];
  }>;
};
```

Rules are a bounded allow/deny list, not a general expression language. Limits: at most 500 rules per revision, 100 release IDs per rule, normalized unique operations, valid strict SemVer ranges, and referenced package/release/action/workflow ownership checks at publish time.

High-risk `ALLOW` with `target.kind=TEAM` is invalid. Package-level high-risk ALLOW records `approved_surface_sha256`; action and workflow targets always bind their exact surface/plan digest. This makes later capability/action/plan additions fail closed until a new revision is published.

### 2.4 Decision

```ts
type PluginPolicyDecision = {
  allowed: boolean;
  required_operations: [PluginPolicyOperation, ...PluginPolicyOperation[]];
  team_id: string;
  policy_revision: number;
  enforcement_mode: 'AUDIT' | 'ENFORCE';
  reason_code: string;
  reason: string;
  operation_results: Array<{
    operation: PluginPolicyOperation;
    allowed: boolean;
    reason_code: string;
    matched: Array<{
      layer: 'PLATFORM' | 'TEAM' | 'USER_GRANT' | 'ROLE_GRANT' | 'REQUEST';
      effect: 'ALLOW' | 'DENY';
      rule_id?: string;
    }>;
  }>;
};
```

`required_operations` is normalized, unique and nonempty. The evaluator loads facts once, evaluates every operation against the same resource and active revision, and sets top-level allowed only when every operation result allows; top-level reason summarizes the first stable deny without discarding per-operation reasons. The public explanation omits other subjects' IDs and unrelated policy rules. Internal audit metadata may record exact matching row IDs.

## 3. Persistence And Revision State

Additive Prisma models:

```text
TeamPluginPolicy
  id, teamId(unique), activeRevisionId, createdAt, updatedAt

TeamPluginPolicyRevision
  id, teamId, revision, schemaVersion, enforcementMode,
  document(Json), documentSha256, createdById, sourceRevisionId?,
  changeReason, createdAt
  unique(teamId, revision)
```

Revisions are immutable. Publish runs in a Serializable transaction:

1. validate `expected_revision` against the active row;
2. validate and canonicalize the complete document;
3. create `revision = active + 1` and its audit row;
4. atomically move `activeRevisionId` to the new revision.

Rollback never points the head backward. It copies a historical document into a new monotonic revision with `sourceRevisionId`, so caches, audit ordering and concurrent clients remain unambiguous.

A missing `TeamPluginPolicy` resolves to a virtual revision `0` and is not eagerly backfilled.

## 4. Default Policy And Matching

Virtual revision 0 is fixed:

| Operation class                                       | Default                                               |
| ----------------------------------------------------- | ----------------------------------------------------- |
| Existing v4 install/update/run_local                  | ALLOW, subject to existing platform/grant gates       |
| invoke_action/run_workflow/Cloud/schedule/shared data | DENY                                                  |
| Web static/client sandbox preview                     | ALLOW only after existing listing/compatibility gates |
| Web Cloud trial                                       | DENY through execute_cloud                            |

`allowed_source_kinds` initially contains all current honest provenance kinds. `denied_capability_kinds` is empty. Teams may narrow either without changing registry rows.

Rule matching is deterministic:

1. discard rules whose operation/version/release predicate does not match;
2. choose the highest target specificity: WORKFLOW/ACTION > PACKAGE > TEAM;
3. at the same specificity, any DENY wins; otherwise an ALLOW wins;
4. if no rule matches, use the fixed operation default.

A workflow-scoped ALLOW applies only when a trusted workflow executor presents the exact workflow release + plan digest and the requested node exists in that plan. A direct plugin call cannot borrow workflow authorization.

## 5. Full Decision Algorithm

### 5.1 Evaluator-owned Platform Gate

`PluginGovernanceEvaluator` 在一次事实装载中读取下列数据，并在 team rules 前 fail closed；调用方不得先行查询后把布尔结果传入，也不得在 evaluator 返回后重复判断：

- active team and membership;
- exact package/release/sha match;
- package ACTIVE, release PUBLISHED, current AI policy PASSED;
- marketplace review/listing/entitlement requirements for the operation;
- platform suspension, artifact integrity or global safety gate;
- caller runtime/workflow session is authentic and not expired.

These failures are not overridable by any team rule or admin identity.

action 是否存在、contract version 与 canonical surface digest 是否匹配由 action contract owner 解析；`GovernanceActionAdapter` 将该可信解析结果绑定到资源并调用 core evaluator。该 adapter 返回的单个 decision 同时代表 action surface 绑定和上述治理事实，不允许 invocation runtime 再查询 release、entitlement、grant 或 policy。

### 5.2 Team Upper Bound

Evaluate provenance and denied capabilities first, then the operation rules. A team DENY is final. In AUDIT mode, a would-be denial for existing `install/update/run_local` is returned as an audit finding while execution remains compatible; high-risk operations ignore this relaxation and remain denied.

### 5.3 USER And ROLE PluginGrant

Refactor package grant resolution into one helper used by legacy/v4 registry and the policy evaluator:

1. USER DENY -> deny;
2. USER ALLOW -> allow at grant layer, even if role denies;
3. otherwise ROLE DENY -> deny;
4. otherwise ROLE ALLOW -> allow;
5. otherwise default allow.

Remove both `SYSTEM_TEAM_ADMIN_ROLE_CODE` and legacy `membership.role === TEAM_ADMIN` runtime bypasses. Management authorization remains enforced by `team.plugin.grant.manage`.

### 5.4 Requested Scope

The final request may only narrow the approved resource, operation, fields, timeout and quota. A workflow node, desktop host or Cloud worker cannot substitute another release, action or capability after the decision.

### 5.5 Action Governance Adapter

`GovernanceActionAdapter.authorize(context, resolvedActionSurface, requiredOperations)` 是 action invocation 的唯一授权接口：

1. 接受 host-bound principal/caller 和 action registry 产出的精确 package/release/sha/action/contract/surface；
2. 拒绝 descriptor 与 canonical surface digest 不一致、缺失或不属于精确 release 的目标；
3. 按受信 target/runtime/preview context 校验 requiredOperations：基线为 `invoke_action`，target runtime=workflow 增加 `run_workflow`，Cloud execution 增加 `execute_cloud`，Web preview 再增加 `web_preview`；插件输入不能增删该集合；
4. 将可信 action resource 与规范化 operations 交给 `PluginGovernanceEvaluator.evaluate`，由 core 一次读取 release/listing、AI/safety、entitlement、team policy 和 USER/ROLE grant，并在同一 revision 原子求交；
5. 返回一个包含 policy revision、surface digest、整体结果与逐 operation 稳定 reason code 的 decision。

调用计数测试必须证明每个 create invocation 至多一次 adapter 调用、adapter 至多一次 core evaluator 调用，即使 requiredOperations 有多个也不循环调用 evaluator。dependency declaration、input/output schema、ArtifactRef ACL/完整性与 call-chain 限制属于 action runtime 的非授权校验，不在 core evaluator 重复实现。

## 6. Control Plane And Data Flow

Suggested team routes:

```text
GET  /api/teams/current/plugin-policy
GET  /api/teams/current/plugin-policy/history
POST /api/teams/current/plugin-policy/preview
POST /api/teams/current/plugin-policy/publish
POST /api/teams/current/plugin-policy/rollback
POST /api/teams/current/plugin-policy/explain
```

All management mutations require the existing `team.plugin.grant.manage` permission at controller and service boundaries. Read/explain is available to managers; runtime consumers call the service internally rather than exposing a client-selected principal.

The desktop control plane shows effective defaults, source/capability restrictions and package/action/workflow rows. “Save and apply” publishes directly. Preview returns validation errors and an impact list for currently installed/selected resources. There is no approval queue or exception UI.

## 7. Audit And Explainability

Audit actions include:

```text
plugin.policy.published
plugin.policy.rolled_back
plugin.policy.decision_denied
plugin.policy.high_risk_allowed
plugin.policy.audit_would_deny
```

Each decision correlation record includes request/invocation ID, actor, team, normalized requiredOperations, every operation_result, exact resource identity, policy revision, matched rule IDs and final reason code. Inputs, secrets and ArtifactRef handles are not copied into AuditLog.

Stable reason codes include `platform_gate_denied`, `team_source_denied`, `team_capability_denied`, `team_rule_denied`, `high_risk_not_enabled`, `action_surface_changed`, `workflow_plan_changed`, `user_grant_denied`, `role_grant_denied`, `request_scope_exceeded`, and `allowed`.

## 8. Compatibility And Migration

- Prisma changes are additive; no existing row is rewritten.
- Missing policy uses virtual revision 0, preserving existing v4 local behavior while closing high-risk operations.
- Existing PluginGrant rows remain authoritative. The only intentional compatibility change is that explicit DENY now also applies to system team admins.
- Existing desktop clients that do not know policy continue through current endpoints; server integration points enforce decisions. New high-risk endpoints do not exist for old clients.
- Policy documents refer to registry IDs and digests, never installation IDs or display names. Local installation state remains in the Rust ledger.
- MySQL rendering must preserve JSON policy documents and new relations; PostgreSQL remains the canonical Prisma schema.

## 9. Rollout And Rollback

1. Ship contract, persistence and evaluator behind `PLUGIN_TEAM_POLICY_ENFORCEMENT=off|audit|on`.
2. Run table-driven evaluator tests and shadow evaluation for existing local operations.
3. Expose the team control plane and publish revision support.
4. Enable enforcement for existing local operations after audit review.
5. High-risk consumers always require explicit ALLOW regardless of the flag.

Operational rollback sets legacy operations to `off` or republishes a prior document as a new revision. Neither path enables high-risk defaults. Schema can remain deployed if API/UI code is rolled back.

## 10. Security Boundaries

- The authenticated request or trusted runtime session supplies principal/team; request JSON cannot select another user or team.
- Policy references are checked for team visibility and registry identity at publish and evaluate time.
- Exact release/sha and action/workflow digests prevent latest-version substitution and silent capability inheritance.
- Decision caches are keyed by team, principal, sorted requiredOperations digest, resource/package surface digest, active policy revision, grant timestamp/version and release state；subset ALLOW 不能命中 operation superset。所有 cache miss/失效仍通过同一次 evaluator 事实装载，不允许 consumer 用旧 ALLOW 拼接新 entitlement/release 结果。
- Cross-tenant policy reads and explanations return not-found/forbidden without exposing whether another team's rule exists.
- The task does not claim to sandbox existing local Node/Python code; it governs platform operations available through official gateways.
