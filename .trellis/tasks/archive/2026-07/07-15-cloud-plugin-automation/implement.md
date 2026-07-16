# Cloud 插件与定时自动化实施计划

按依赖和风险顺序执行。队列、远程网络和 side-effect review gate 未通过前，不开放生产 Cloud 或 schedule。

## Step 0 - Shared Contract And Operations Gate

- [ ] 与 action 子任务冻结含 `actionSurfaceSha256` 的精确 target、`ActionInvocationEnvelope`、`ActionInvocation(kind=PREVIEW)`、Cloud adapter、execution semantics、Artifact credential 和错误矩阵；单 action preview 继续由 action invocation ledger 拥有。
- [ ] 与 workflow 子任务冻结唯一 ExecutionPlan、含 `FAILING` closing 的 run/attempt reducer、幂等键和 Cloud eligibility；本任务只扩展 schedule/deployment/transport 字段。
- [ ] 与 policy 子任务冻结 cloud/schedule preflight、策略 generation 和默认拒绝语义。
- [ ] 确认生产 `AUTOMATION_REDIS_URL`、TLS/ACL、AOF/备份、`noeviction`、worker process 与 secret-store 方案。
- [ ] 将相关 specs、设计和 Redis/BullMQ 运维契约加入 implement/check context manifests。

### Review Gate 0

- action、workflow、Cloud 没有重复 payload owner 或重复 run 状态机；单 action preview 不创建合成 WorkflowRun。
- 自动化 Redis 是持久生产依赖，不复用 memory cache 或简化 RESP client。
- 运维和安全负责人确认同步 HTTPS 首版边界后再添加依赖。

## Step 1 - Contract, Schema And Automation Module

- [ ] 在 contract 增加绑定 action surface digest 的 deployment/routing、schedule union、严格分离的 lifecycle status 与 syncState、discriminated fire payload（repeat 仅 scheduleId/generation/schedulerKey；once 含 scheduledFor/occurrenceKey）、Cloud run extensions、以 ACTION_INVOCATION/WORKFLOW_ATTEMPT 为来源的 usage event 和稳定错误码。
- [ ] 添加 Prisma models/indexes，以及 `(scheduleId, generation, occurrenceKey)` unique fire key；更新 PostgreSQL canonical schema、MySQL renderer和迁移回归。
- [ ] 在 ActionInvocation 增加可索引 Cloud binding 字段，并新增 `(runId,nodePath)` 唯一的 WorkflowRunCloudBinding + deploymentId 索引；run plan/binding 同事务写入，retire 不扫描 JSON。
- [ ] 接入 `@nestjs/bullmq`/BullMQ 5，新增独立 automation config/module与 `AUTOMATION_PROCESS_ROLE`；保持普通 API 在 feature off 时不连接自动化 Redis。
- [ ] 实现 automation Redis readiness：连接、读写、持久化/淘汰策略和 worker heartbeat；所有失败 fail closed。
- [ ] 实现事务 outbox repository、claim lease、backoff/dead-letter和幂等 dispatcher。

### Validation 1

```bash
pnpm -C packages/contract typecheck
pnpm -C packages/contract test
pnpm -C apps/collab-api prisma:generate
pnpm -C apps/collab-api prisma:validate
pnpm -C apps/collab-api typecheck
pnpm -C apps/collab-api test -- --testTimeout=60000 automation-config automation-outbox
```

### Review Gate 1

- migration additive，feature off 时现有 cache/registry/relay 启动路径不变。
- job payload 仅含 IDs/generation/hash并经过 zod decode，不含 input、secret 或 token。
- DB 成功/Redis 失败和 Redis 重复/DB stale 两方向均有恢复测试。

## Step 2 - Endpoint Control Plane And Safe HTTPS Adapter

- [ ] 实现 `CloudActionDeployment` CRUD/verify/disable/secret rotation和 owner/permission isolation；create 只写 DRAFT 并返回一次 secret，作者配置后显式 verify，challenge 成功才 READY，失败回 DRAFT。
- [ ] 使用独立 master key加密 endpoint secret；一次性返回、显式 verify、pino redact补回归。轮换必须创建 superseding DRAFT deployment，endpoint old/new secret overlap，新 deployment verify + 旧 stable precondition 后 routing CAS；旧 binding 收口前 retire conflict。
- [ ] 实现 `SafeOutboundHttpClient`：HTTPS-only、DNS/IP分类、固定解析、Host/SNI、`redirect: manual`、3xx 稳定拒绝、超时和字节上限；action POST 不跟随 Location。
- [ ] 实现 health challenge与 HMAC canonical request/response fixture；加入 nonce/timestamp/deployment/完整六元 target 校验，surface digest 进入签名 header/canonical string/响应回显。
- [ ] 实现 Cloud adapter：invocation envelope、Artifact scoped credential、AbortSignal、响应 envelope/schema/ArtifactRef校验和稳定错误映射。
- [ ] 把单 action Cloud preview 接到既有 `ActionInvocation(kind=PREVIEW)`；复用 PREVIEW routing/adapter，并以 invocation ID 写 usage，不创建 WorkflowRun、WorkflowStepAttempt 或第二套预览状态机。
- [ ] Cloud STANDARD/PREVIEW 分别提交 `[invoke_action,execute_cloud]` 与 `[invoke_action,execute_cloud,web_preview]` 的可信 compound operations；任一项 deny 时零 deployment claim/queue/HTTP 调用，调用计数仍为一次 evaluator。
- [ ] 实现 stable/candidate routing generation、确定性百分比选择、冻结 deployment和回滚 API。

### Validation 2

```bash
pnpm -C apps/collab-api test -- --testTimeout=60000 cloud-endpoint cloud-signature cloud-ssrf cloud-routing cloud-preview
pnpm -C apps/collab-api typecheck
pnpm -C apps/collab-api build
```

### Review Gate 2 - Security

- SSRF 测试覆盖 IPv4/IPv6、userinfo、redirect、DNS rebinding、metadata、私网和危险端口。
- secret 在 API/DB fixture/log/job/run/artifact 中无明文泄漏，生产缺 master key拒绝启动相关 role。
- DRAFT 在作者配置和显式 verify 前不可路由；create 不依赖尚未配置 secret 的 endpoint 在线，verify 才执行完整 challenge 并原子进入 READY。
- endpoint 响应按不可信输入处理；超限或 schema/target/deployment不符不能提交 attempt。
- 单 action preview 断言只有 ActionInvocation 记录且 usage source 指向 invocation；workflow preview 才有 WorkflowRun/attempt，跨团队或 kind/ID 不匹配的 usage source 被拒绝。
- old/new deployment overlap、长在途 run/standalone invocation 与 retire gate 使用关系 binding 验证；routing 切换不改变既有 binding，旧 secret 仅在全部非终态引用收口后停用。

## Step 3 - Durable Cloud Worker And Recovery

- [ ] 建立 control/action queues、确定 job IDs、QueueEvents和 scheduler/worker独立入口。
- [ ] 实现 Cloud run create -> outbox -> coordinate；coordinator复用 workflow reducer派发 ready attempts，为每个 attempt 以 request/effect key 调 ActionInvocationService.create 并 CAS 关联 invocation，在节点终败时进入 `FAILING`、停止派发、等待并行 invocation/attempt 收口后再 `FAILED`。
- [ ] action worker 只通过 ActionInvocationService.claim/gateway 领取 invocation，复核 attempt relation 与冻结 deployment/plan hash后由 gateway 调 Cloud adapter；成功终态/usage/audit 与绑定 artifact parent kind/run/attempt 的 canonical `HANDOFF_PENDING` output holds 同事务提交，再由 coordinator 在同一事务 upsert canonical EDGE/FINAL holds后 CAS release pending、归并 attempt并唤醒 reducer。重复 worker/reconciler 只产生一行且不 reopen。禁止 worker 直接 fetch/调用 endpoint adapter。
- [ ] worker 读取 ArtifactRef 前验证 workflow hold + exact frozen transfer grant + matching execution kind；覆盖 queue delay 超普通 TTL、PREVIEW -> PRODUCTION、跨节点/跨团队伪造、terminal-to-step crash recovery 和 run 终态 hold release/cleanup。
- [ ] 分离 BullMQ stalled重投与 domain retry；AUTHORIZED 可重投同一 job，过期 RUNNING 必须先 CAS 旧 invocation/attempt 终态，再由 reducer为 read-only/idempotent 新建 request attempt（仅 idempotent 复用 effect key），side-effect unknown fail closed。
- [ ] 实现 endpoint/team/workflow/action并发与速率/配额 gate、TTL lease和优雅停机。
- [ ] 实现 cancel/kill switch、lease expiry reconciler、orphan/stale job no-op和 QUEUED run补投。

### Validation 3

```bash
pnpm -C apps/collab-api test -- --testTimeout=60000 cloud-worker cloud-retry cloud-cancel cloud-quota
AUTOMATION_TEST_REDIS_URL=redis://127.0.0.1:6379/15 pnpm -C apps/collab-api test:automation:integration
pnpm -C apps/collab-api typecheck
pnpm -C apps/collab-api build
```

### Review Gate 3 - Reliability

- 使用真实 Redis覆盖 API/dispatcher/worker重启、stalled lock、重复 job、Redis断连/恢复和 graceful shutdown。
- 同一 attempt/run保持单一终态，run 不在并行 attempt 收口前离开 `FAILING`，side-effect HTTP发送次数在崩溃窗口仍不超过一次；成功终态到 step 映射的崩溃窗口由 HANDOFF_PENDING 保留输出且不会泄漏孤立 hold。
- 积压、heartbeat、outbox lag和失败率 metrics/readiness可观察。

## Step 4 - Schedule Control Plane And Timezones

- [ ] 实现 once/daily/weekly DTO、IANA zone/local time校验和未来运行预览；拒绝 cron/webhook/event额外字段，schedule input 递归拒绝 typed ArtifactRef并只保存受 schema 校验的内联 JSON，不扫描普通 string 形状。
- [ ] 用 BullMQ Job Scheduler `{pattern,tz}`投影 daily/weekly；once使用 delayed job；scheduler key含 generation。
- [ ] 实现 schedule create/update/pause/resume/delete + outbox；每次 pause/resume/update/delete 都 bump generation，lifecycle 只写 ACTIVE/PAUSED/COMPLETED/MISSED/DELETED，成功响应另含 syncState/nextRunAt/精确 workflow release，投影错误只改 syncState/error code。
- [ ] CRUD 每个命令单次 evaluate(manage_schedule)；fire 单次 compound evaluate(trigger_schedule+run_workflow+execute_cloud)，保存 decisionId。撤权/成员离开后 stale fire 审计 no-op 且零 run/queue。
- [ ] repeat schedule template 只写 scheduleId/generation/schedulerKey；worker 校验 `opts.repeatJobKey`，从 `opts.prevMillis` + IANA zone 派生并持久化 scheduledFor/occurrenceKey。ONCE 使用固定 runAt；事务按 `(scheduleId, generation, occurrenceKey)` 创建 workflow run，stale generation、paused/deleted、DST fold 第二次和重复 fire 为 no-op。
- [ ] 覆盖延迟处理、worker 重启、处理 now 改变、错误 repeatJobKey、DST fold 和 BullMQ opaque colon job ID；断言不解析 job.id、不读 job.timestamp、occurrence 不漂移。
- [ ] 增加 pause -> 旧 delayed fire -> resume 竞态，断言 resume 新 generation 生效且旧 fire 永远 no-op；typed ArtifactRef 被 DTO 拒绝而 schema 允许的普通 URL/path-like string 不被误杀。
- [ ] 实现 scheduler reconciler、coalesced misfire、ONCE MISSED、consecutive failure和通知去重。
- [ ] 固定 BullMQ/cron版本的 DST fixtures，记录不存在/重复本地时刻语义。

### Validation 4

```bash
pnpm -C apps/collab-api test -- --testTimeout=60000 automation-schedule schedule-timezone schedule-reconcile
AUTOMATION_TEST_REDIS_URL=redis://127.0.0.1:6379/15 pnpm -C apps/collab-api test:automation:integration
```

### Review Gate 4

- Asia/Shanghai、America/New_York等 fixture覆盖日/周、DST gap/fold、更新 generation和停机恢复。
- 同一 schedule/generation/occurrenceKey 在 DST fold、并发和重启下只创建一个 run，且 key 可从数据库审计。
- syncState=ERROR 不改变 ACTIVE/PAUSED 等 lifecycle，恢复后 reconciler 可回到 SYNCED。
- 暂停/删除不取消既有 run，MISSED/coalesce行为与PRD一致。

## Step 5 - Desktop Control Surface And Observability

- [ ] WorkflowRunner只在全部节点生产 deployment就绪且 policy允许时开放“Cloud 运行”；否则列出具体节点。
- [ ] 增加 schedule列表/创建/编辑/暂停/恢复/删除、时区与下一次时间预览；控件只暴露三种结构化 trigger。
- [ ] run详情复用工作流 DAG，增加 queue/deployment/attempt/usage/取消投影，不显示 endpoint secret或敏感URL。
- [ ] 接入 NotificationService处理最终失败、delivery unknown、MISSED、连续失败和 endpoint disabled。
- [ ] 补充 worker/dashboard运维文档、alerts、kill switch和恢复 runbook。

### Validation 5

```bash
pnpm -C apps/desktop test
pnpm -C apps/desktop typecheck
pnpm -C apps/desktop vite:build
pnpm -C apps/desktop exec playwright test e2e/cloud-automation.spec.ts --project=chromium
pnpm -C apps/collab-api test -- --testTimeout=60000 cloud-notification cloud-projection
```

### Review Gate 5

- 390x844、1024x768、1440x900下 schedule/run界面无重叠/横向溢出，时间与状态文案明确。
- 预览、手动生产和 schedule在 UI/API/usage中可区分。
- endpoint host只在授权管理页脱敏显示，普通运行详情无网络/secret泄漏。

## Step 6 - End-To-End, Rollout And Legacy Regression

- [ ] 用 A 图片、B 视频、C 配乐 HTTPS fixtures完成手动、单次、每日/每周 Cloud闭环，桌面在启动后关闭。
- [ ] 覆盖 ArtifactRef下载/上传、schema失败、timeout、TLS/DNS/5xx、retry、cancel、quota和通知。
- [ ] 验证 stable/candidate确定选择、比例变化、candidate归零和stable回滚只影响新 plan。
- [ ] 关闭分级 feature flags，验证停止新 trigger/node但保留查询/取消，普通 v4本地/市场路径无回归。
- [ ] 验证旧 cloud manifest无 action contract时仍不可执行，不从 legacy entry自动注册 endpoint。
- [ ] 对 usage事件与市场/质量/Web preview子任务做字段和去重集成评审。

## Full Quality Gates

```bash
pnpm -C packages/contract typecheck
pnpm -C packages/contract test
pnpm -C packages/workflow-engine typecheck
pnpm -C packages/workflow-engine test
pnpm -C apps/collab-api prisma:validate
pnpm -C apps/collab-api typecheck
pnpm -C apps/collab-api test -- --testTimeout=60000
AUTOMATION_TEST_REDIS_URL=redis://127.0.0.1:6379/15 pnpm -C apps/collab-api test:automation:integration
pnpm -C apps/collab-api build
pnpm -C apps/desktop test
pnpm -C apps/desktop typecheck
pnpm -C apps/desktop vite:build
pnpm -C apps/desktop exec playwright test e2e/cloud-automation.spec.ts --project=chromium
pnpm -r typecheck
git diff --check
```

后续实现必须提供受版本控制的 Redis integration test启动方式；不得假定开发机已有可清空的 DB 0。测试只使用专用 URL/DB，结束后按唯一 prefix清理自身键。

## Risk And Rollback Points

- **Redis不可用/配置错误**：automation readiness fail closed，普通 API不依赖该连接；修复后由outbox/reconciler补投，禁止清库式恢复。
- **DB/queue双写**：所有业务事务先写outbox，dispatcher幂等投递；回滚保留PENDING记录，不伪造SYNCED。
- **Schedule状态漂移**：lifecycle 与 syncState 独立；Redis 错误只标记 syncState，`occurrenceKey` 唯一键阻止恢复或 DST fold 期间重复 run。
- **重复副作用**：transport重投不等于domain retry；side-effect unknown直接失败告警，idempotent重试保持同一业务键。
- **SSRF/secret泄漏**：SafeOutboundHttpClient和secret store是开放endpoint前硬门禁；发现缺陷立即停用deployment并关闭Cloud manual/schedule。
- **时区/依赖升级**：固定BullMQ/cron fixtures；升级前重跑DST和next-run快照，异常时保留旧版本并暂停scheduler变更。
- **candidate故障**：candidatePercent归零为首个回滚动作；在途run按冻结deployment结束或取消，不改投stable。
- **worker版本回滚**：先暂停scheduler/领取新job，等待或取消在途，再部署向后兼容schema版本；不删除run/attempt/usage。
- **旧插件回归**：Cloud和schedule均受独立feature flag控制；关闭后client/nodejs/python及legacy cloud提示路径继续工作。

## Ready-To-Start Checklist

- [ ] 用户已统一评审父任务与八个子任务规划。
- [ ] action/policy/workflow前置契约和实现顺序已批准。
- [ ] 生产持久Redis、worker部署、secret管理和告警责任已明确。
- [ ] `prd.md`、`design.md`、`implement.md`与context manifests通过`task.py validate`。
- [ ] 只有以上条件满足后才运行 `task.py start 07-15-cloud-plugin-automation`。
