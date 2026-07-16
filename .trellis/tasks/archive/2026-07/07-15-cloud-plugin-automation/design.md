# Cloud 插件与定时自动化技术设计

## 1. Architecture And Process Boundary

Cloud 自动化建立在工作流冻结计划之上，不建立第二套 action 或 run 协议：

```text
Desktop/Web/API
  -> CloudActionDeployment / AutomationSchedule control plane
  -> WorkflowRun preflight + frozen ExecutionPlan (Prisma truth)
  -> AutomationOutbox
  -> BullMQ control queue / Job Scheduler (persistent Redis transport)
  -> coordinator worker
  -> BullMQ action queue
  -> CloudActionAdapter -> signed HTTPS endpoint
  -> WorkflowStepAttempt CAS + usage/audit/notification
```

- API 进程拥有鉴权、DTO、控制面、preflight、schedule CRUD、run 查询和 outbox 写入。
- scheduler-sync 进程把 Prisma schedule/outbox 幂等投影到 BullMQ Job Scheduler，并定期对账。
- coordinator worker 读取 run ID，根据共享 workflow reducer 计算 ready nodes、创建/派发 attempts 和归并终态。
- action worker 领取单个 attempt，执行 Cloud adapter，验证结果并 CAS 更新 ledger；job payload 只携带不可猜测 ID 和 generation，不携带完整输入或 secret。
- 单 action Cloud preview 从共享 `ActionInvocationService` 进入 `ActionInvocation(kind=PREVIEW)`，直接复用 Cloud adapter 与 PREVIEW routing；它不经过 coordinator，也不创建合成的 `WorkflowRun` / `WorkflowStepAttempt`。多节点 workflow preview 才进入 workflow ledger。
- Prisma 是 schedule/run/attempt/deployment/usage 的业务事实源；Redis 是持久 transport、延迟任务和 worker lock。Redis job 状态不能把 Prisma 终态回退。

生产可以通过 `AUTOMATION_PROCESS_ROLE=api|scheduler|worker|all` 拆分。开发环境允许 `all`，但测试和部署脚本必须覆盖多进程重启。

## 2. Queue And Scheduler Choice

采用 `@nestjs/bullmq` 11.x + BullMQ 5.x：与当前 NestJS 11 和 Node 20 兼容，提供持久 delayed jobs、Job Schedulers、worker lock/stalled recovery、幂等 job ID 和结构化事件。BullMQ 内部使用 ioredis；现有 `CacheService` 的简化 RESP client 只支持 GET/SET/DEL，不能执行 BullMQ Lua/stream/lock 协议，因此不得复用。

配置：

- `AUTOMATION_ENABLED=false` 默认关闭新 Cloud/schedule 能力。
- `AUTOMATION_REDIS_URL` 必填且独立于 `CACHE_DRIVER`；生产推荐独立 Redis instance，至少使用独立 `lf:automation` prefix。
- Redis 必须启用 AOF 或等效持久化、`maxmemory-policy=noeviction`、TLS/ACL（远端部署）和备份监控。readiness 检查连接、写/读探针、server policy 与 worker heartbeat，失败时 Cloud fail closed。
- 队列分为 `automation-control`（schedule fire、run coordinate、reconcile）和 `cloud-action`（attempt invoke），便于分别设置并发与积压告警。

不使用 BullMQ `FlowProducer` 表达 DAG；它面向树形 parent/child。coordinator 每次从 Prisma ledger 和纯 reducer计算 ready set，BullMQ 只投递 ID，因而支持任意 fan-in/fan-out、数据库审计和桌面/Cloud 同状态机。

## 3. Persistence Model

模型为 additive migration，并复用工作流任务的 `WorkflowRun` / `WorkflowStepAttempt`。

### CloudActionDeployment

- `id`, `teamId`, `packageId`, `releaseId`, `sha256`, `actionId`, `actionContractVersion`, `actionSurfaceSha256`。
- `supersedesDeploymentId?`；secret 轮换创建新 deployment，不覆盖原行。
- `environment=PREVIEW|PRODUCTION`, `deploymentKey`, 规范化 `url`, `secretCiphertext`, `secretVersion`。
- `status=DRAFT|VERIFYING|READY|DISABLED|RETIRED`。
- `timeoutMs`, `maxConcurrency`, `rateLimitPerMinute`, `responseLimitBytes`。
- `lastHealthAt`, `lastHealthOk`, `lastHealthErrorCode`, timestamps。
- unique `(releaseId, actionId, actionContractVersion, actionSurfaceSha256, environment, deploymentKey)`。

URL 不包含 secret，通常不必加密，但 API 投影仅向 owner 管理权限返回脱敏 host；secret 使用独立 `CLOUD_ENDPOINT_SECRET_ENCRYPTION_KEY` 和既有 credential-cipher 模式加密，生产缺失即拒绝启动 worker/control plane。

### CloudActionRouting

- unique `(releaseId, actionId, actionContractVersion, actionSurfaceSha256, environment)`。
- `stableDeploymentId`, `candidateDeploymentId?`, `candidatePercent` (0-100), `generation`。
- 更新使用 expected generation CAS。只有 READY deployment 可成为 stable/candidate；PREVIEW 与 PRODUCTION 路由完全独立。

### Cloud Execution Bindings

- ActionInvocation 增加可索引 `cloudDeploymentId?`, `cloudRoutingGeneration?`, `cloudEnvironment?`，只作为 action-owned invocation 的 adapter binding，不增加状态机。
- 新增 `WorkflowRunCloudBinding(runId,nodePath,deploymentId,routingGeneration,environment)`，unique `(runId,nodePath)` 并索引 deploymentId；它是冻结 plan JSON 的关系投影，在 run 创建事务中写入，Cloud worker 只读。
- retire gate 以 routing 表、非终态 ActionInvocation binding 和非终态 WorkflowRunCloudBinding 做查询/CAS；JSON 不能作为唯一引用事实。

### AutomationSchedule

- `id`, `teamId`, `createdByUserId`, `workflowReleaseId`。
- `kind=ONCE|DAILY|WEEKLY`, `timeZone`, `runAt?`, `localTime?`, `dayOfWeek?`。
- `inputJson`, `inputSchemaHash`, `status=ACTIVE|PAUSED|COMPLETED|MISSED|DELETED`；该字段只表达业务 lifecycle。inputJson 仅允许受 schema 校验的内联 JSON并递归拒绝 typed ArtifactRef；string 不做 URL/path/data URI 启发式解释。
- `generation`, `schedulerKey`, `nextRunAt`, `lastScheduledFor`, `lastRunId`, `consecutiveFailures`。
- `syncState=PENDING|SYNCED|ERROR`, `syncErrorCode`, timestamps；Redis/outbox 同步失败只更新这些字段，不改变 lifecycle status。

删除采用逻辑状态，便于迟到 job 校验 generation/status 和审计；保留策略到期后再清理非业务 payload。

### AutomationOutbox

- `id`, `kind=UPSERT_SCHEDULE|REMOVE_SCHEDULE|ENQUEUE_RUN|CANCEL_RUN`, `aggregateId`, `generation`, `payload`。
- `status=PENDING|PROCESSING|DONE|FAILED`, `availableAt`, `attempts`, `lockedBy`, `lockedUntil`, `lastErrorCode`, timestamps。
- unique `(kind, aggregateId, generation)`，数据库事务与 schedule/run 变更同时写入。

### WorkflowRun / WorkflowStepAttempt Extensions

- run 增加 `scheduleId?`, `scheduleGeneration?`, `scheduledFor?`, `occurrenceKey?`；unique `(scheduleId, scheduleGeneration, occurrenceKey)`，null 场景不影响手动 run。`scheduledFor` 用于时间展示，不能替代 DST 幂等身份。
- plan 中每个 Cloud node 冻结 `cloudDeploymentId`、routing generation、endpoint environment、policy decision ID。
- attempt 增加 `transportJobId`, `deliveryState`, `requestSha256`, `responseSha256`, `endpointHttpStatus`, byte counts。

### CloudUsageEvent

- append-only `id`, `teamId`, `sourceKind=ACTION_INVOCATION|WORKFLOW_ATTEMPT`, `sourceId`, exact action/deployment, scope, duration, request/response/artifact bytes, outcome, pricing dimensions, occurredAt。
- `ACTION_INVOCATION` 的 source ID 指向 action 子任务既有 invocation；`WORKFLOW_ATTEMPT` 指向本任务复用的 step attempt，并可由其追溯 run。服务层拒绝 source kind/ID 不匹配或跨团队引用。
- unique `(sourceKind, sourceId, eventKind)`，供配额、质量和结算子任务重放；单 action preview 不需要伪造 run/attempt，本任务也不直接更改钱包。

## 4. Endpoint Registration And Routing

### 4.1 Registration

作者必须拥有精确 package/release/action 的管理权限。控制面确认 release/SHA/action contract、`cloud_capable=true`、发行状态和 environment 后：

1. 创建请求解析 HTTPS URL，拒绝 userinfo、fragment、非标准危险端口和超长 URL，并确认 release/action 管理权限与精确绑定。
2. 生成 32-byte endpoint secret，将 deployment 与密文写为 `DRAFT`；创建响应只返回一次 secret，不在请求内发送 health challenge，也不自动进入 READY。
3. 作者把 secret 配置到 endpoint 后显式调用 `POST /api/cloud-action-deployments/:id/verify`。verify 以 CAS/短锁把 DRAFT 标记为 VERIFYING，防止并发验证。
4. verify 重新解析全部 A/AAAA，拒绝 loopback、RFC1918、link-local、carrier-grade NAT、multicast、unspecified 和云元数据网段；通过 outbound client 连接固定的已校验地址并保持原 Host/SNI。client 使用 `redirect: manual`，任何 3xx 直接失败且不向 Location 发起第二次请求。
5. verify 发送带 challenge 的 health request，验证 TLS、签名响应、deployment ID、action target 和超时；成功 CAS 为 READY，失败回到 DRAFT 并只保存脱敏 health error。
6. 只有 READY deployment 才允许路由激活。secret 轮换克隆相同 target/environment/url 为带 `supersedesDeploymentId` 的新 DRAFT，生成新 secret；endpoint 必须在 overlap 期间按 deploymentId 同时接受 old/new secret，旧 READY/active secret 不变。新 deployment 显式 verify 成功且旧 stable 仍通过 READY/health precondition 后，通过 routing generation CAS 切换 stable/candidate；旧 deployment 只有在无 active routing、无非终态 invocation/run binding 后才可 CAS 为 RETIRED 并停止接受旧 secret。

网络访问封装为单一 `SafeOutboundHttpClient`，业务 worker 不直接调用全局 `fetch`。注册、verify 与运行复用同一 DNS/IP 检查并固定 `redirect: manual`；任何 3xx 都是 `cloud_endpoint_redirect_denied`，绝不重发 action POST。测试通过可注入 resolver/transport，不在生产放宽 localhost。

### 4.2 Stable/Candidate Selection

创建 run 时使用 `hash(run_id + node_path + routing_generation) % 100` 确定 stable/candidate，并把结果写入冻结计划。相同 run 重试始终命中同一 deployment。candidatePercent 或 routing 变更只影响后续新 plan；回滚把 candidatePercent 设为 0 或用上一 READY deployment 恢复 stable。

deployment 被 DISABLED/RETIRED 后不接受新 plan。平台紧急硬门禁可以阻止其未开始 attempt；已发出的同步请求只能请求取消，不能改投其他 deployment。

## 5. Signed HTTPS Invocation Protocol

Cloud adapter 消费 action 子任务的 `ActionInvocationEnvelope`，生成确定 JSON bytes。请求：

```text
POST <registered endpoint>
Content-Type: application/json
X-LingFang-Signature-Version: 1
X-LingFang-Timestamp: <unix seconds>
X-LingFang-Nonce: <base64url random>
X-LingFang-Invocation-Id: <uuid>
X-LingFang-Effect-Idempotency-Key: <stable logical effect key; omitted for read-only>
X-LingFang-Release-Id: <uuid>
X-LingFang-Action-Id: <action id>
X-LingFang-Contract-Version: <version>
X-LingFang-Action-Surface-SHA256: <canonical surface digest>
X-LingFang-Deployment-Id: <uuid>
X-LingFang-Signature: v1=<base64url HMAC-SHA256>
```

签名 canonical string 固定包含 method、canonical path、timestamp、nonce、invocation ID、可选 effect idempotency key、精确 target、deployment ID 和 body SHA-256。request idempotency key 只用于平台内创建/transport 去重，不暴露为 effect key。query 在注册时固定并纳入 canonical path；禁止动态 query secret。endpoint 应拒绝超过 5 分钟偏差、重复 nonce/invocation 和签名不符；idempotent endpoint 按 effect key 去重逻辑副作用。

body 不含用户 Bearer token、endpoint secret、平台 master key 或任意外部 Artifact URL。Artifact 输入使用不可伪造 `ArtifactRef`；endpoint 通过 invocation-scoped、短期且仅限指定 Artifact 的平台 credential 下载，并通过预授权 upload session 写结果，再返回 ArtifactRef。临时访问 URL 不持久化到 workflow output。

响应固定为 action gateway 的 success/error envelope，并回显 `invocation_id`, `deployment_id`, `action_contract_version`, `action_surface_sha256`。worker 限制 header/body 字节，先验证 content type、完整 target 回显、schema、Artifact scope，再提交 attempt。原始 response body 不写普通日志；诊断只保留截断且脱敏的 error code/message。

首版同步调用。timeout 由 action/deployment 声明并受平台上下限裁剪，AbortController 负责取消。endpoint 可能在连接断开后继续副作用，因此 cancellation 和 transport failure 均按执行语义处理，不能宣称事务回滚。

## 6. Schedule Semantics

DTO 是显式 discriminated union：

```ts
type ScheduleTrigger =
  | { kind: 'once'; run_at: IsoDateTime }
  | { kind: 'daily'; time_zone: IanaZone; local_time: 'HH:mm' }
  | { kind: 'weekly'; time_zone: IanaZone; day_of_week: 1|2|3|4|5|6|7; local_time: 'HH:mm' };
```

- `luxon` 3.x 验证 IANA zone并生成用户预览；服务端生成内部 6-field cron pattern，客户端从不提交 cron。
- DAILY pattern 为 `0 <minute> <hour> * * *`；WEEKLY 转换 ISO weekday 到 BullMQ/cron weekday。BullMQ Job Scheduler 使用 `{ pattern, tz }`。
- ONCE 使用带 delay 的普通 job，job ID 包含 schedule/generation/runAt；时间必须在平台允许的未来窗口内。
- 夏令时采用墙钟语义：不存在的本地时刻不生成 occurrence；重复的本地时刻生成同一个规范化 `occurrenceKey`（由 local date/time + IANA zone 形成），并把它持久化到 run。数据库唯一 `(scheduleId, generation, occurrenceKey)` 保证 DST fold 只创建一次。实现前用 BullMQ/cron-parser 当前固定版本锁定 DST fixture，升级依赖必须重跑。
- Job Scheduler key 为 `schedule-{id}-g{generation}`。pause、resume、时间/时区/输入/workflow 版本更新和 delete 都先在 DB 递增 generation 并写 outbox，再 upsert/remove 对应 key；迟到 job 携带旧 generation，worker 即使看到当前状态已恢复 ACTIVE 也必须 ack/no-op。
- DAILY/WEEKLY Job Scheduler template data 只有静态 `{ schedule_id, generation, scheduler_key }`。repeat worker 校验 BullMQ 生成 job 的 `opts.repeatJobKey` 与 DB schedulerKey，并只使用 `opts.prevMillis` 作为该次不可变 planned instant；再按 schedule IANA zone 转换 canonical local occurrenceKey。禁止使用 template data 中的动态字段、`job.timestamp` 或处理时刻 `now`。worker 先以创建者当前 membership/principal 对精确 workflow resource 单次求交 `[trigger_schedule,run_workflow,execute_cloud]`；deny 时审计/no-op。ALLOW 后才在 Serializable/CAS 事务内持久化 decisionId 与 derived `scheduledFor/occurrenceKey`，按 `(scheduleId, generation, occurrenceKey)` 创建 `WorkflowRun` 和 ENQUEUE_RUN outbox。ONCE 使用自身固定 runAt/occurrenceKey delayed payload；重复 job 读取并返回同一 run。

schedule create/update/pause/resume/delete 各自调用 evaluator 一次请求 `manage_schedule`，RBAC 管理权限与 policy decision 都通过才修改 generation/state。fire 不复用创建时旧 ALLOW，也不按 operation 分别调用 evaluator。

BullMQ 在 worker 停止期间保留到期 delayed job。恢复时按 coalesce 语义最多执行一次，并从下一未来 occurrence 继续。reconciler 对比 DB `nextRunAt`、scheduler keys 和 run unique keys，补齐丢失投影但不批量补造历史运行。ONCE 超过可配置 misfire window 后标记 MISSED并通知。

## 7. Queue Jobs And Recovery

### Control Queue

- `schedule.repeat_fire { schedule_id, generation, scheduler_key }`；scheduledFor/occurrenceKey 从受信 BullMQ job opts 派生
- `schedule.once_fire { schedule_id, generation, scheduled_for, occurrence_key }`
- `run.coordinate { run_id, plan_sha256 }`
- `automation.reconcile { shard }`

### Action Queue

- `action.invoke { run_id, attempt_id, invocation_id, plan_sha256 }`

平台自定义 jobId 可确定重建且不含 BullMQ 保留分隔符冒号；BullMQ Job Scheduler 生成的 `repeat:${jobSchedulerId}:${nextMillis}` occurrence job.id 是库内 opaque，平台不得自行构造或解析。payload 解析使用共享 zod schema，repeat occurrence 只读 `opts.prevMillis/repeatJobKey`。queue attempts 仅处理拿锁前的 transport 问题，不代表 action domain retry；`action.invoke` 由 ledger 决定是否新建 attempt。

处理流程：

1. coordinator 为 READY WorkflowStepAttempt 使用其 request/effect key、scope-derived kind/operations 和 frozen deployment binding 调用 `ActionInvocationService.create`，CAS 写唯一 invocationId 后才 enqueue action job；重复 coordinator 返回同一 invocation。
2. worker 读取 attempt/run/invocation，验证关联、plan hash、状态和 cancel/kill switch，再通过 `ActionInvocationService.claim` 竞争 `AUTHORIZED -> RUNNING`；CAS 失败安全 no-op。
3. gateway 按 invocation 的冻结 binding 获取团队/action quota 与 endpoint concurrency lease并调用注册 Cloud adapter；worker 代码不得直接 fetch endpoint。无法立即执行时有界 backoff 重排同一 invocation，不创建新 domain attempt。
4. adapter 成功结果由 ActionInvocationService 在同一事务写 invocation `SUCCEEDED`/output/usage/audit，并为每个 output ArtifactRef acquire 绑定 artifact parent kind + run + attempt 的 canonical `HANDOFF_PENDING` hold；失败终态不创建输出 hold。coordinator 随后幂等归并 linked WorkflowStepAttempt，并在同一事务按 holderKey upsert frozen mapping 所需的 EDGE/FINAL holds后 CAS release pending再唤醒 reducer；进程在两步之间崩溃时 reconciler 从持久 relation 重做转换，数据库 unique 使并发调用收敛为单行且 released row 不 reopen。取消/超时或任一侧迟到结果不能覆盖终态。
5. 可重试失败由 workflow reducer 创建下一 domain attempt、新 request key/new invocation（总共初次 + 最多两次 retry）；idempotent action 复用 effect key。不可重试/耗尽则把 run CAS 为 `FAILING`，停止新派发并取消其余 invocation/attempt，待全部收口后才写 `FAILED`。
6. worker 崩溃后 BullMQ stalled recovery 只可重投尚未 claim 的 AUTHORIZED invocation。RUNNING lease 过期时 reconciler 先按 execution semantics CAS 旧 invocation/attempt 为明确 TIMED_OUT 或 result-unknown 终态，绝不重 claim 同一 RUNNING invocation。read-only/idempotent 由 workflow reducer 新建 domain attempt、新 request key/new invocation，只有 idempotent 复用 effect key；side-effect result-unknown 终止且不再次发 HTTP。

outbox dispatcher 使用 `lockedUntil` 抢占、指数退避和 dead-letter 告警。DB 成功但 Redis 失败时记录仍为 PENDING；恢复后继续，不回滚业务创建。Redis 有 job 但 DB 无对应有效 aggregate/generation 时 ack/no-op。

## 8. Concurrency, Quota And Cancellation

- BullMQ worker concurrency 是实例上限；run 的最大并行度由冻结计划和团队策略控制。
- endpoint max concurrency/rate limit 使用 Redis 原子 lease/counter，key 包含 deployment ID，TTL 防 worker 崩溃泄漏；数据库 deployment 配置是事实源。
- team/workflow/action 配额在创建 run、派发 attempt 和提交 usage 三处检查，避免长队列期间策略变化绕过。计量事件 append-only，配额拒绝使用稳定 `cloud_quota_exceeded`。
- graceful shutdown 先停止领取新 job，延长/释放当前 lease，在超时内等待同步请求；强停后走 stalled recovery 规则。
- run cancel 用 DB `CANCEL_REQUESTED` + outbox 唤醒 coordinator。coordinator 停止新派发，action worker轮询状态并 abort；`CANCEL_REQUESTED` 与 `FAILING` 通过 expected-state CAS 决定关闭原因，二者都必须等待在途 attempt 收口且只允许一个终态。

## 9. Preview, Production And Usage

- 单 action preview 必须复用 `ActionInvocation(kind=PREVIEW)`，以一次 compound decision 原子请求 `invoke_action + execute_cloud + web_preview`，只能选择 PREVIEW routing，使用 PREVIEW-bound Artifact grants/holds、低配额和短保留期；不创建 WorkflowRun、伪造 workflow release、新增预览状态机或逐 operation 重调 evaluator。
- 多节点 workflow preview 才创建显式 `executionScope=PREVIEW` 的 WorkflowRun，并复用同一 PREVIEW routing 和 workflow reducer；任何 preview 都不能由 schedule 触发。
- production manual/schedule run 只选择 PRODUCTION routing。ArtifactService 拒绝从 PREVIEW grant/hold 派生 STANDARD grant；preview output 必须经受信 import/copy action 生成新的 STANDARD artifact 或重新生成才能进入 production，不能复用临时 credential。
- CloudUsageEvent 同时记录 scope；市场计量/结算只消费符合其规则的 PRODUCTION 事件，预览单独限额。
- endpoint health probe 不创建 workflow run或计费 usage，但记录安全/可用性审计。

## 10. API And Error Contract

### Endpoint Control Plane

- `POST /api/cloud-action-deployments`：创建 DRAFT 并返回一次性 secret，不执行 verify 或激活 routing。
- `POST /api/cloud-action-deployments/:id/verify`、`rotate-secret`, `disable`。
- `PUT /api/cloud-actions/:release_id/:action_id/routing`：stable/candidate CAS。
- `GET /api/cloud-actions/:release_id/:action_id/deployments`：owner 管理投影。

### Runs And Schedules

- 单 action Cloud preview 复用 action 子任务的 invocation API/DTO，并固定 `kind=PREVIEW`；本任务只提供 Cloud adapter，不新增 preview-run endpoint。
- 复用 `POST /api/workflow-runs`，`execution_target=CLOUD` 时写 run/outbox。
- `GET/POST/PATCH/DELETE /api/automation-schedules` 的具体 DTO 只接受 once/daily/weekly union。
- 复用 workflow run list/detail/cancel；Cloud 字段只作为类型化扩展。

稳定错误至少包括 `cloud_disabled`, `cloud_endpoint_unavailable`, `cloud_endpoint_unsafe`, `cloud_signature_failed`, `cloud_timeout`, `cloud_response_too_large`, `cloud_response_invalid`, `cloud_deployment_mismatch`, `cloud_quota_exceeded`, `cloud_delivery_unknown`, `automation_redis_unavailable`, `schedule_invalid_timezone`, `schedule_stale_generation`, `schedule_missed`。

## 11. Observability And Alerts

- 结构化日志统一包含 requestId/runId/attemptId/scheduleId/jobId/deploymentId/teamId、状态、耗时和错误码，pino redact 补充签名/secret/invocation credential 字段。
- metrics：queue waiting/delayed/active/stalled/failed、oldest age、outbox lag、worker heartbeat、endpoint success/latency/timeout、run success、schedule fire/missed/consecutive failures。
- readiness 分别报告 DB、automation Redis、scheduler sync 和 worker heartbeat，避免 API 健康掩盖自动化不可用。
- 最终失败、delivery unknown、MISSED、endpoint disabled 和连续失败阈值通过现有 `NotificationService` 发送站内通知；按 schedule/run 去重，恢复后可发送恢复事件。

## 12. Security And Threat Boundaries

- team/principal 从 session/run 解析，不信任 job payload、endpoint response 或 schedule body 携带身份。
- worker 运行在无用户 JWT 的最小权限服务身份下，只能按 invocation scope读取必要 run/action/Artifact。
- SafeOutboundHttpClient 对注册、health 和 invoke 统一执行 HTTPS/DNS/IP 防护；TLS 校验不可关闭，3xx 一律不跟随并返回稳定拒绝。
- secret encryption key、Redis credentials 和 Artifact signing credentials 使用部署 secret store，不进入 repo、Prisma明文或日志。
- endpoint 响应是不可信输入，必须完成长度、JSON、envelope、schema、ArtifactRef 和 target回显验证。
- policy/release/entitlement 在 run freeze 时必检，并在实际派发前检查平台硬门禁、deployment 和策略 generation；工作流节点不能扩权。

## 13. Compatibility, Deployment And Rollback

- 先部署 additive schema/contract（feature off），再部署 endpoint control plane，之后 Redis/scheduler/worker，最后开放 preview、manual production、schedule。
- 旧 cloud manifest 只有 URL entry 且没有 action contract 时不自动注册 endpoint、不自动授权，桌面既有提示保持。
- `AUTOMATION_ENABLED`、`CLOUD_MANUAL_ENABLED`、`SCHEDULES_ENABLED` 分级 kill switch；关闭时拒绝新建/派发，但保留查询、取消和历史 ledger。
- Redis 故障不回滚已提交 schedule/run；outbox/reconciler 恢复。若需要版本回滚，先暂停 scheduler和 worker，部署兼容旧 schema 的版本，再恢复，绝不清空 Redis 或运行表。
- endpoint rollout 回滚只调整 routing generation/percent；已冻结 run不切换。schema或 adapter缺陷通过关闭对应 deployment和新发布修复，不改历史 attempt。
- 普通 v4 registry、市场、桌面本地 runner和现有可选 cache driver不依赖 automation Redis，Cloud 故障不得拖垮这些路径。

## 14. Key Trade-offs

- 选择 BullMQ/Redis 而不是进程 timer，增加生产 Redis 运维成本，但获得跨进程持久调度、延迟任务和崩溃恢复，并兼容 PostgreSQL/MySQL 双数据库。
- 选择 Prisma ledger + outbox 而不是 Redis-only 真相，增加对账逻辑，但解决 DB/queue 双写、审计和历史查询。
- 首版采用同步 HTTPS endpoint，不建设容器或回调协议，交付更简单；代价是 action 必须在平台超时内完成，超长任务延后。
- stable/candidate 只支持一个候选与百分比，足以灰度和回滚，不引入完整服务网格或多版本流量编排。
