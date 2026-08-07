# 工作流插件平台技术设计

## 1. Architecture And Ownership

工作流只负责编排，不拥有 action 业务实现。端到端边界如下：

```text
Creator/workspace
  -> manifest.json + workflow.json
  -> deterministic .lfplugin v4
  -> PluginRelease + WorkflowRelease snapshot
  -> install entitlement/policy preflight
  -> frozen ExecutionPlan
  -> desktop or cloud WorkflowExecutor
  -> shared ActionInvocationGateway
  -> WorkflowRun / WorkflowStepAttempt ledger
```

- `packages/contract`：跨端 schema、枚举、状态、错误码与限制常量的单一事实源，字段保持 snake_case。
- 新增纯 TypeScript 包 `packages/workflow-engine`：定义解析、DAG 校验、拓扑计划、JSON Pointer 映射、ready-node 计算和纯状态转换；不得依赖 Nest、React、Prisma 或 Tauri。
- `apps/collab-api`：发布时校验、精确依赖解析、不可变快照、策略/权益预检、run/step 账本、租约与升级建议。
- `apps/desktop`：workflow 草稿/只读图预览、输入配置、手动执行协调和运行详情。
- `apps/desktop/src-tauri`：继续拥有本机精确安装项与本地 action adapter；不保存团队运行事实或复制服务端策略。
- `07-15-cross-plugin-action-runtime` 是 action、schema、`ArtifactRef` 和 invocation envelope/gateway 的 owner；本任务只消费其公共接口。
- `07-15-cloud-plugin-automation` 实现同一 `WorkflowExecutorPort` 的 Cloud adapter，并复用本任务状态机和 Prisma 账本。

核心 DAG 使用 `@dagrejs/graphlib` 4.x 的 directed graph、`isAcyclic`、`topsort` 和 predecessor 查询。它同时支持 Node 20 与浏览器构建，避免服务端和桌面各写一套拓扑算法。界面使用 `@xyflow/react` 加 `@dagrejs/dagre` 做只读布局；不把画布节点坐标写入执行定义。JSON Schema 编译和赋值兼容继续复用 action 子任务的 Ajv 2020 validator，字段读取/写入使用受限 RFC 6901 JSON Pointer helper。

BullMQ `FlowProducer` 不用于工作流状态机：其依赖模型是父子树，不能无损表达共享 fan-in/fan-out DAG，且 Redis job 不能替代可查询、可审计的 Prisma run ledger。

## 2. Artifact And Contract

### 2.1 Manifest Compatibility

向 `RuntimeType` 加入 `workflow`，对应 entry 必须是包内安全相对路径且固定推荐为 `workflow.json`。现有四个 runtime schema、默认值和制品格式不变。

workflow manifest 必须包含 action 子任务定义的一个导出 action：

```json
{
  "runtime_type": "workflow",
  "entry": "workflow.json",
  "actions": [
    {
      "action_id": "default",
      "action_contract_version": "1.0.0",
      "execution_semantics": "side_effect",
      "cloud_capable": false,
      "input_schema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false
      },
      "output_schema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false
      }
    }
  ]
}
```

该 workflow `default` action 按 action owner 的 runtime-discriminated contract 不声明包内 handler；其 execution identity 由 manifest `entry=workflow.json` 与 canonical definition SHA-256 派生并进入 action surface digest，实际执行统一进入 WorkflowExecutorPort。示例的空对象 schema 是合法最小模板，必须作为 action/workflow contract golden fixture，Creator 不得输出裸 `{}` schema。

`execution_semantics` 与 `cloud_capable` 都由发布器根据完整叶子依赖闭包生成，并由服务端复算校验：任一叶子为 `side_effect` 时整体为 `side_effect`，否则任一叶子为 `idempotent` 时整体为 `idempotent`，全部叶子为 `read_only` 时整体才是 `read_only`；全部叶子 action 可 Cloud 执行时 `cloud_capable` 才为真。上例仅表示包含副作用且含本地节点的工作流，不能作为固定默认值。

### 2.2 WorkflowDefinition V1

共享契约采用 discriminated schema，发布态的核心形状为：

```ts
type WorkflowDefinitionV1 = {
  definition_version: '1';
  input_schema: RestrictedJsonSchema;
  output_schema: RestrictedJsonSchema;
  nodes: Array<{
    node_id: string;
    declared_version_range: string;
    target: {
      package_id: string;
      release_id: string;
      sha256: string;
      action_id: string;
      action_contract_version: string;
      action_surface_sha256: string;
    };
    depends_on: string[];
    input_bindings: Array<{
      target_pointer: string;
      source:
        | { kind: 'workflow_input'; source_pointer: string }
        | { kind: 'node_output'; node_id: string; source_pointer: string }
        | { kind: 'literal'; value: JsonValue };
    }>;
    retry_limit: 0 | 1 | 2;
  }>;
  output_bindings: Array<{
    target_pointer: string;
    source:
      | { kind: 'workflow_input'; source_pointer: string }
      | { kind: 'node_output'; node_id: string; source_pointer: string }
      | { kind: 'literal'; value: JsonValue };
  }>;
};
```

草稿态使用 `target_selector` 声明 package/action 与 SemVer range。`resolve` API 返回完整候选、拒绝原因和精确 target；发布 artifact 必须同时携带规范化 `declared_version_range` 和上述精确 target。该 range 只用于升级建议与审计，运行时忽略它并且禁止用范围或 `latest` 代替精确 target。

定义约束：

- `node_id` 使用稳定 ASCII identifier，在同一定义内唯一；显示名来自 target 元数据，不进入执行身份。
- `depends_on` 去重且只引用本定义节点；node output source 必须同时出现在 `depends_on`，避免隐藏依赖。
- 一个 target pointer 只能写一次；父子 pointer 重叠同样冲突，避免写入顺序影响结果。
- `literal` 必须通过目标 action input schema；不支持模板字符串、JSONPath、JavaScript 或 JQ 表达式。
- `literal` validator 递归匹配 contract 保留的可判定 tagged objects，并拒绝 `type=artifact_ref|platform_credential_ref|runtime_artifact_grant|runtime_artifact_hold` 及其版本化后继；未知 `type` 仍按目标 schema/unknown-field 规则处理。普通 string（包括 URL/path 形状）不做 credential 启发式识别，只按 schema 校验；平台 credential/signed URL issuer 永不把短期凭证返回给 definition API。固定发布资产只能经显式 release-asset/import action 在运行时产生引用。
- 映射兼容检查使用源 pointer 对应的 schema 子树与目标 schema 子树；无法证明兼容即拒绝，要求转换 action。
- `retry_limit` 只是请求上限。`side_effect` 强制归零；`idempotent` 必须由 invocation gateway 提供稳定幂等键；`read_only` 可在上限内重试。
- 节点、边、并行、嵌套和展开上限从 contract 常量读取，服务端可以通过平台/团队策略进一步收窄。

定义按规范化 JSON 计算 `definition_sha256`。该 hash 不是插件 artifact SHA 的替代品；两者分别证明 workflow 语义和完整 ZIP 字节。

## 3. Persistence Model

所有表均为 additive migration，并同时通过 PostgreSQL canonical schema 与 MySQL renderer。

### WorkflowRelease

- `pluginReleaseId`：主键并一对一关联 `PluginRelease`，只允许 runtime `workflow`。
- `definitionVersion`, `definitionSha256`, `definitionJson`。
- `inputSchema`, `outputSchema`, `cloudEligible`。
- `expandedNodeCount`, `maxParallelism`, timestamps。

### WorkflowReleaseNode

- `id`, `workflowReleaseId`, `nodeId`。
- `declaredVersionRange`：从草稿声明规范化并冻结的 SemVer range，只供升级建议和审计使用。
- 精确 `packageId`, `releaseId`, `sha256`, `actionId`, `actionContractVersion`, `actionSurfaceSha256`。
- `executionSemantics`, `cloudCapable`, `retryLimit`, `dependsOn`, `inputBindings`。
- unique `(workflowReleaseId, nodeId)`；按 `releaseId` 建索引，供撤回影响分析和升级建议查询。

`definitionJson` 是同时包含 declared range 与精确 target 的不可变重放快照，节点表是可索引投影。服务层在同一事务写入并校验二者 hash；读取执行计划只消费 snapshot 的精确 target，升级建议读取 declared range，治理查询以节点投影为准。

### DesktopExecutorSession

- `id`, `teamId`, `principalUserId`, `deviceId`，绑定已认证桌面安装，不接受页面自报身份。
- `inventoryJson`, `inventoryHash`：只含规范化 installation/package/release/SHA/action contract/surface digest 可用性，不含本机路径；hash 由共享 canonicalizer 生成。
- `tokenHash`, `expiresAt`, `lastHeartbeatAt`, `revokedAt`, timestamps；token 短期有效且只在创建/刷新时返回原文。
- session 过期、撤销或桌面检测到 inventory hash 变化后停止新 attempt claim；已发出的 attempt 仍按执行语义与租约规则收口。

### WorkflowRun

- `id`, `teamId`, `workflowReleaseId`, `principalUserId`。
- `parentRunId`, `parentStepAttemptId`，用于子工作流链路。
- `triggerKind=MANUAL|SCHEDULE`, `executionTarget=DESKTOP|CLOUD`, `executionScope=PREVIEW|PRODUCTION`。
- `status=QUEUED|RUNNING|FAILING|CANCEL_REQUESTED|SUCCEEDED|FAILED|CANCELLED`；`FAILING` 是停止派发并等待在途 attempt 收口的关闭态。
- `desktopExecutorSessionId?`, `desktopInventoryHash?`；只在 DESKTOP run 上存在并在冻结计划中回显。
- `inputJson`, `inputDigest`, `requestDigest`, `outputJson`, `planJson`, `planSha256`, `artifactGrantScope`, `resultRetainUntil`, `errorCode`, `errorMessage`；root run 是 Artifact grant holder，插件节点不能直接使用该 scope。resultRetainUntil 是 FINAL_OUTPUT grant/hold 的共同上限。
- `rootPolicyDecisionId`；绑定精确 workflow release/plan digest 与本次 root compound operations。
- `requestScopeSha256`, `idempotencyKey`, `leaseOwner`, `leaseExpiresAt`, timestamps。scope 由宿主对 team + principal subject + trusted caller + trigger kind + exact workflow release + execution target + execution scope 做 canonical hash；客户端不能提供 scope。
- unique `(requestScopeSha256, idempotencyKey)`；同 key 复用前必须比较 canonical request/input digest，差异返回 `workflow_run_conflict`。Cloud 子任务另加 schedule fire 唯一键，schedule 不使用客户端 root key。

### WorkflowStepAttempt

- `id`, `runId`, `nodePath`, `attemptNo`。
- `rootLogicalExecutionId`, `fullNodePath`, `attemptLineage`；nested run 不以 childRunId 改变逻辑路径。
- 精确 action target 快照及可选 `childRunId`。
- `status=PENDING|READY|RUNNING|SUCCEEDED|FAILED|SKIPPED|CANCELLED`。
- `invocationId`, `requestIdempotencyKey`, `effectIdempotencyKey?`, `inputJson`, `outputJson`, `artifactRefs`, error fields；invocation kind 严格由 run executionScope 派生，executor 通过 ActionInvocationService 创建/claim 并以其终态归并 attempt。
- `leaseTokenHash`, `leaseExpiresAt`, `startedAt`, `finishedAt`, duration/usage metadata。
- unique `(runId, nodePath, attemptNo)` 与 unique `invocationId`。

普通日志只记录 ID、状态、耗时、大小和错误码。输入输出 JSON 受 action contract 上限约束；密钥、Bearer token、本机路径、data URI、Artifact 二进制正文不落表。

## 4. Publish And Upgrade Flow

### 4.1 Publish

1. Creator/workspace 解析草稿，调用 resolve API 把 declared range 解析为当前用户可见且可调用的精确 action target，同时保留规范化原始 range。
2. `workflow-engine` 构建 graph，执行结构、循环、上限、mapping 和 schema 兼容检查。
3. 服务端递归读取 workflow target 的不可变定义，构建依赖闭包，拒绝直接/间接递归、深度或展开节点超限。
4. 客户端把同时含 declared range 溯源与精确可执行 target 的 `workflow.json` 打入确定性 v4 artifact 并按现有 registry 上传。
5. registry 在完整 ZIP 校验和 action/策略校验后，于创建 `PluginRelease` 的同一事务写 `WorkflowRelease` 与节点投影；任一步失败均不产生可运行 release，artifact 按既有 orphan 机制清理。
6. 工作流自身 `default` action 的 schema 必须与 definition 整体 schema 完全一致；cloud eligibility 由服务端派生。

发布只验证作者当时有权引用 target，不代表未来永久允许。每次运行仍执行完整门禁。

### 4.2 Upgrade Suggestions

新 action release 发布后，后台只对 `WorkflowReleaseNode.declaredVersionRange` 覆盖、contract compatibility 检查通过且调用者可见的节点创建 `WorkflowUpgradeSuggestion` 投影或按需查询结果。采纳建议执行：克隆新 workflow 草稿 -> 按原 declared range 替换精确 target -> 重新验证完整闭包与 mappings -> 预览/试跑 -> 发布新 workflow release。旧 release、安装和 schedule 不自动变化。

## 5. Execution Plan And State Machine

### 5.1 Preflight And Freeze

`POST /api/workflow-runs` 接收 `workflow_release_id`, `input`, `execution_target`, `execution_scope`, `idempotency_key`。`execution_scope` 只能由受信 Web preview caller 请求 PREVIEW，普通客户端不得提升或覆盖。服务端先为 team + principal + trusted caller + MANUAL + exact workflow release + target + scope 生成 `requestScopeSha256`，并计算包含 canonical input、ArtifactRef source grant identity 和所有选择参数的 `requestDigest`；相同 scope/key/digest 返回已有 run，scope/key 相同但 digest 不同零写并返回 `workflow_run_conflict`。schedule/nested child 分别使用 occurrence identity/parent attempt identity，不接受该客户端 key。随后：

1. 校验输入 schema 和 JSON/ArtifactRef 边界；对每个引用先由 ArtifactService 验证当前 principal 对 source invocation/prior run/upload 的具体 grant及其 execution kind 与目标 scope 一致，再为 root run 原子创建同 kind WORKFLOW_RUN grant + 有界 RUN_INPUT hold。仅 team 匹配不通过，PREVIEW -> PRODUCTION 也不通过；retainUntil 不超过 run deadline/平台上限，PREVIEW 使用更短上限。
2. 递归加载 workflow release 依赖闭包。
3. 对精确 root workflow release + plan digest 调用 governance evaluator 一次：requiredOperations 以 `run_workflow` 为基线，CLOUD 增加 `execute_cloud`，PREVIEW 增加 `web_preview`；整体 deny 时不创建 run。
4. 对每个叶子 target 预检 package/release/SHA、发行/审核状态、entitlement、AI policy、团队策略和 action eligibility；实际节点执行仍创建 ActionInvocation 并走单一 compound action adapter。
5. DESKTOP 目标必须提交未过期 `DesktopExecutorSession`；服务端校验 principal/team/device、所需安装清单和当前 inventory hash。CLOUD 目标要求全部叶子 `cloud_capable`，实际排队由 Cloud 子任务接管。
6. 生成含全部精确 workflow/action refs、执行语义、root decision ID 和叶子预检 decision IDs 的不可变 `ExecutionPlan`；DESKTOP plan 另冻结 session ID 与 inventory hash。计算 hash 后创建 run/首次 step attempts。

撤回发生在计划冻结后时：尚未开始的新 run 一律拒绝；已开始 run 不静默换版。平台硬封禁可以通过 kill switch 阻止未开始节点，运行以明确错误终止并审计。

### 5.2 Ready-Node Scheduling

纯 reducer 根据 step attempts 计算 ready set：所有 `depends_on` 最新尝试成功才 READY；同一 run 的 RUNNING 数不得超过计划并行度。fan-out 可并行，fan-in 等待全部前置成功。每次状态更新使用 expected-state CAS，重复或乱序回报返回当前投影而非覆盖终态。

每个节点调用前由 mapping engine 从工作流输入和已完成前置输出构造新对象，再次执行 action input schema。调用结果先验证 action output schema和 ArtifactRef 授权，再提交成功并解锁下游。

mapping engine 遇到 ArtifactRef 时不直接复制权限：它必须证明 frozen plan 中存在从 root input 或 source attempt output pointer 到当前 destination pointer 的 edge，artifact ID 等于已验证 source 值，并且 artifact/grant/hold/invocation execution kind 全部一致；随后在创建 destination ActionInvocation 的事务中，从活动 RUN hold 原子追加该 invocation grant。ActionInvocationService 在 workflow-linked producer 的 `SUCCEEDED` 事务内先 acquire 绑定 run/attempt 的 canonical `HANDOFF_PENDING` hold；coordinator 映射 step 时在同一事务先按 canonical holderKey upsert/extend 仍有未完成消费者或 final output mapping 的 `EDGE|FINAL_OUTPUT` holds，再 CAS release pending。消费者全部完成后 CAS release EDGE hold。nested child 使用相同 root hold、kind 与 full node path 规则。cleanup、取消和 lease recovery 不能绕过 hold/grant 检查；reconciler 可由已提交 invocation/attempt/output 关系幂等补做 pending -> edge/final 转换，数据库 unique 使并发调用只得到一条 active holder且 released row不重开。

最终 output mapping 还会为 artifact 添加 root WORKFLOW_RUN FINAL_OUTPUT grant，`expiresAt=resultRetainUntil`。`GET /workflow-runs/:id` 与 artifact download/materialize 先校验当前 team membership、run initiator或管理权限，再要求该 grant `revokedAt=null && expiresAt>databaseNow()`；不会把 final artifact 改成 team-wide。新 run 只能在旧 result retention 内重新执行 authorizeForRunInput 并建立自己的 run grant/hold。到期 worker 写 revokedAt；其他 run/shared holder 继续保留对象时，旧 run grant 仍不可用。

### 5.3 Retry, Failure And Cancel

- request key 由稳定 root logical execution + 完整 node path + attempt lineage/attemptNo 生成并持久化；同一个 WorkflowStepAttempt 的 queue/API 重投复用该 key，不同 domain retry 创建新 attempt、新 request key 和新 invocation。
- 只有 `idempotent` action 生成 effect key：`wf-effect:{root_logical_execution_id}:{full_node_path}`。它不含 attemptNo、childRunId 或 transport job ID，所有 domain retries 和 nested child run 重建均复用；read_only 不需要 effect key，side_effect 不进入自动 retry。
- 基础设施重复投递不增加 domain attempt；同一个 attempt 通过 request-key unique + invocation/CAS 去重。首个 FAILED invocation 不得因 effect key 阻止 reducer 创建下一 attempt。
- read-only/idempotent 的可重试错误在 `retry_limit` 内创建下一 attempt；schema、policy、entitlement 和业务拒绝不可重试。
- side-effect 请求一旦可能发出却结果未知，标记 `side_effect_result_unknown` 并终止，不再次调用。
- 节点最终失败后以 CAS 将 run 从 `RUNNING` 转为 `FAILING`，冻结首个根失败，停止新派发，将未开始节点标记 `SKIPPED`，并向运行节点发送 AbortSignal/adapter cancel；不撤销已成功节点。
- `FAILING` reducer 只接受在途 attempt 的终态回报或租约收口；全部 attempt 进入 `SUCCEEDED|FAILED|SKIPPED|CANCELLED` 后才 CAS 为 `FAILED`。迟到成功可以保留结果，但不能清除根失败或恢复调度。
- cancel 使用 `CANCEL_REQUESTED` 中间态，停止派发后等待在途 attempt 终结，再归并为 CANCELLED。成功/失败终态不可被取消覆盖。
- run 进入任一终态时停止新增 input/edge handoff，CAS release INPUT/EDGE/HANDOFF_PENDING holds并 revoke RUN_INPUT grants；成功 run 的 FINAL_OUTPUT hold/grant 保留到 resultRetainUntil，失败/取消 run立即释放/撤销，retention 到期再原子 release final hold + revoke final grant。崩溃 reconciler 可按 run/plan/attempt 与 canonical holder/subject key 补齐缺失转换或释放/撤销孤立行，不允许无限延长 retainUntil/expiresAt，也不 reopen released/revoked row。

### 5.4 Desktop Lease Protocol

桌面先由 Tauri 枚举规范化安装清单并创建/刷新短期 `DesktopExecutorSession`，服务端返回 session token 和 canonical inventory hash；创建 DESKTOP run 时把二者绑定到冻结计划。随后桌面领取 run lease，再逐节点领取短期 attempt token。每次 claim/start/heartbeat 都校验 session token、principal/team/device、未过期状态和 inventory hash；任何变化都停止新 claim 并要求重新预检。Tauri/local adapter 仍必须按 plan 的 installation/release/SHA 启动 action，不能接受页面传入的其他 plugin ID。租约过期由 reconciler 按执行语义决定安全重试或明确失败。

本地手动 workflow 首版需要在线连接，因为 policy、entitlement、运行 ledger 和跨插件调用都是服务端事实；这不会改变普通 v4 本地插件的既有兼容默认。

## 6. Nested Workflows

workflow `default` action 仍通过统一 gateway。gateway 识别 target runtime 为 workflow 后，只能从父 attempt 内部创建 child `WorkflowRun`，并引用 root `planJson` 中已冻结的不可变子计划 slice；父 attempt 等待 child 终态并消费其整体 output。child 继承 parent 的 rootLogicalExecutionId/fullNodePath、principal、executionTarget、executionScope、deadline，以及 DESKTOP 的 executorSession/inventory hash 或 CLOUD 的逐节点 deployment/routing bindings；不接受客户端传入 target/session，不重新解析 range/active routing，也不对同一个 action invocation decision 再调用 evaluator。父节点 retry 可创建新的 child run/request attempts，但所有对应叶子仍按 root logical execution + full path 复用 effect key。根 run 冻结时递归保存完整依赖闭包、每层 definition hash 与 executor bindings，因此子工作流后来发布新版本或 routing 变化不会改变当前计划。

递归检测以精确 workflow release ID 路径为准，错误返回完整路径。父 cancel 向所有活动 child runs 及其 ActionInvocation 传播；child 失败按父节点普通失败处理。运行详情按 `node_path` 和 parent/child links 展示，不把嵌套节点扁平化成含义不明的 ID。

## 7. API And Error Contract

新增 API 使用共享 zod contract，Nest DTO 仍在边界执行 class-validator 白名单：

- `POST /api/workflows/resolve-targets`：草稿 range -> 候选与精确 targets。
- `POST /api/workflows/validate`：返回结构化 `path/node_id/code/message` diagnostics，不写库。
- `POST /api/workflow-executor-sessions`、`POST /api/workflow-executor-sessions/:id/heartbeat`、`DELETE /api/workflow-executor-sessions/:id`：创建/刷新、续租和撤销短期桌面执行会话。
- `POST /api/workflow-runs`：幂等创建并冻结计划。
- `GET /api/workflow-runs`、`GET /api/workflow-runs/:id`：团队隔离列表/详情。
- `POST /api/workflow-runs/:id/cancel`。
- 桌面内部：attempt claim/start/heartbeat/complete/fail，全部要求 run-scoped token。
- `GET /api/plugin-releases/:id/workflow-upgrades`：可审核建议。

稳定错误至少包括 `workflow_definition_invalid`, `workflow_cycle`, `workflow_mapping_invalid`, `workflow_contract_incompatible`, `workflow_limit_exceeded`, `workflow_recursion`, `workflow_target_unavailable`, `workflow_installation_mismatch`, `workflow_executor_session_invalid`, `workflow_inventory_changed`, `workflow_cloud_ineligible`, `workflow_run_conflict`, `workflow_lease_expired`。错误不得包含 endpoint secret、token、完整输入或本机路径。

## 8. Desktop Experience

- Draft 创建增加“工作流”类型，默认生成 manifest 与最小 `workflow.json`；Creator tools/prompt 可以读写并调用 validator。
- Artifact Inspector 使用只读 XYFlow 画布，稳定尺寸、自动布局、节点状态/类型标记和节点详情；`nodesDraggable=false`, `nodesConnectable=false`。
- 普通 WorkflowRunner 根据受限 schema 渲染输入控件，显示本地/Cloud eligibility、缺失安装项和唯一明确的运行命令。
- 运行详情用 DAG 状态和节点尝试列表展示进度、错误、ArtifactRef 下载/预览入口与取消操作。技术诊断放详情，不在主界面解释产品功能或快捷键。
- 所有入口最终调用统一 `createWorkflowRun`，不得从 pinned/recent/standalone 路径绕过 preflight。

## 9. Security And Tenant Isolation

- principal/team 从服务端 session 解析，不信任 workflow 文件、iframe message 或请求 body 提供的身份。
- policy decision、entitlement 和 release 状态在 root 与每个嵌套 target 上取交集；Owner/Admin 没有运行豁免。
- 定义与 mapping 只处理 JSON 数据，不解释代码、模板或 URI；validator 只拒绝 contract 保留的 runtime identity tagged objects，不按普通 string 的 URL/path 外形猜测凭证。ArtifactRef 必须由 action gateway 验证 team/run scope 与 execution kind。
- workflow 不能读取未声明节点输出，不能引用同团队外的私有 release，也不能把本机路径或临时签名 URL 持久化为输出。
- 审计 metadata 只保存 IDs、决策、状态和摘要；运行详情按团队和权限过滤。
- executor session 与租约 token 都只保存 hash，短期有效并绑定 principal/team/device 或 run/attempt；页面不能替换 inventory，session 撤销或终态后相关 token 立即失效。

## 10. Compatibility, Rollout And Rollback

- Prisma 与 contract 变更 additive；`runtime_type=workflow` 只对新 release 生效。旧客户端遇到 workflow catalog item 时显示最低版本/不兼容，不尝试当 client/cloud 运行。
- 旧 `cloud` release 没有 actions 时不自动推断为 workflow target；作者需发布含 action contract 的新版本。
- 以 `WORKFLOW_PLATFORM_ENABLED` 分别控制 publish 与 run。先部署读兼容 contract/schema，再部署后端校验与桌面 UI，最后开放创建。
- 回滚时先关闭新 run/publish，允许查询历史 ledger；不删除 workflow releases、runs 或 ArtifactRefs。普通 v4 插件路径保持可用。
- 进行中 run 按冻结计划完成或由管理员取消；不得通过回滚把其 target 替换成旧/新版本。

## 11. Key Trade-offs

- 选择 `runtime_type=workflow` 复用成熟 registry，而不是新建平行 marketplace；代价是 contract、Rust allowlist 和旧客户端兼容投影都要同步更新。
- 选择发布时精确 pin 与运行时重检，牺牲静默升级便利，换取可重放、可审计和可回滚。
- 选择 Prisma ledger + 纯 reducer，而不是把桌面或队列状态当真相；增加状态写入，但支持本地/Cloud 共用和故障恢复。
- 首版创建入口是 AI/开发者文件工作流加只读图预览，不建设普通用户拖拽编辑器，控制 schema/mapping 和执行风险。
