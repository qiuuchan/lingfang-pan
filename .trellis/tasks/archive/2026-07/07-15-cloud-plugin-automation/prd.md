# Cloud 插件与定时自动化

## Goal

交付生产可用的 Cloud action 执行和持久定时自动化：平台在桌面离线时仍能按精确工作流版本运行全部 Cloud-capable 节点，并提供手动、单次、每日、每周触发、运行历史、取消、告警和安全回滚。

## User Value

- 用户可以立即运行 Cloud 工作流，或按自己的时区设置一次、每天、每周自动运行，不需要保持桌面客户端在线。
- 插件作者可以把自有 HTTPS action endpoint 接入平台，无需把任意 Node.js/Python 源码上传给平台托管执行。
- 团队管理员能够控制哪些 package、action 或工作流可 Cloud/定时运行，并查看精确版本、配额、失败和审计。
- 平台运维可以独立扩缩 worker、恢复队列、逐步切换 endpoint deployment，并在故障时暂停自动化而不破坏插件发行和历史记录。

## Confirmed Baseline

- 现有 `runtime_type=cloud` 主要是契约与界面保留位，没有生产级远程执行、持久队列、worker、schedule 或 run ledger。
- collab-api 是 NestJS 11 + Prisma，支持 PostgreSQL/MySQL；现有 Redis 仅是可选缓存且使用简化 RESP client，不能承担持久队列。
- 工作流子任务提供唯一 `ExecutionPlan`、`WorkflowRun` / `WorkflowStepAttempt` 状态机和 executor port。
- action 子任务提供 `cloud_capable`、含 `action_surface_sha256` 的精确 target、执行语义、schema、`ArtifactRef` 和 invocation gateway adapter interface；本任务实现 Cloud adapter 与 endpoint deployment。
- 团队策略、权益、发行状态和 action 授权在每次启动时重新检查；新增 Cloud 与 schedule 能力默认拒绝。

## Requirements

### R1. Cloud Action Endpoint

- 首版只执行平台管理或作者托管的 HTTPS action endpoint；平台不构建运行任意上传 Node.js/Python 代码的容器服务。
- `runtime_type=cloud` 的 action 不声明虚假包内 handler；release surface 使用 action owner 定义的 Cloud adapter marker，实际 deployment 在 invocation/ExecutionPlan 创建时另行冻结。本地/workflow action 标记 cloud-capable 时仍保留其真实本地/workflow execution identity。
- action descriptor 只有明确声明 `cloud_capable=true`，且精确 release/action 已绑定有效生产 endpoint deployment 时，才能进入 Cloud 执行计划。
- endpoint deployment 必须绑定精确 `package_id + release_id + sha256 + action_id + action_contract_version + action_surface_sha256`，区分 PREVIEW 与 PRODUCTION，并具有不可变 deployment ID。
- 平台负责请求签名、短期凭证、超时、幂等、取消、输入输出 schema、`ArtifactRef` 授权、响应大小和结构化错误校验。
- endpoint URL 必须为公网 HTTPS，禁止内网、回环、链路本地、云元数据地址、凭证内嵌 URL 和任何重定向；DNS 变化不得绕过检查。health 与 action POST 都使用 redirect=manual，任何 3xx 返回稳定失败。
- endpoint secret 只在创建 deployment 时向作者显示一次，服务端加密保存，普通 API、日志、运行记录和插件制品均不得返回明文。轮换不覆盖 READY deployment 的 secret，而是创建带 supersedes 关系的新 DRAFT deployment，verify 后再原子切换 routing。
- 创建 deployment 只完成静态门禁并写入 `DRAFT`，在响应中一次性返回 secret；作者把 secret 配置到 endpoint 后必须显式调用 verify。只有 verify 完成实时 HTTPS challenge、签名和 target 校验后才能进入 `READY` 并参与路由，创建接口不得自动健康检查或直接置为 READY。
- 首版 endpoint 调用是同步 HTTPS request/response。长任务必须在 action 超时上限内完成；异步回调、Webhook 和平台托管容器不在首版范围。

### R2. Cloud 工作流执行

- 用户可以手动立即启动全部叶子节点均 Cloud-capable 的已发布工作流；桌面关闭后 worker 继续完成。
- 包含任一本地-only action、缺少生产 deployment 或预检失败节点的工作流不得选择 Cloud 或创建 schedule，并列出全部不兼容节点。
- 每次运行冻结工作流、子工作流、action release、SHA、contract version、action surface SHA-256、endpoint deployment 和策略决策；运行中不跟随 active endpoint 或插件更新。
- 每个 workflow Cloud step attempt 先通过 `ActionInvocationService.create` 创建并关联 action-owned invocation，再由 gateway claim/调用已注册 Cloud adapter；worker 不得直接调用 adapter/endpoint、解释插件 entry，也不获得用户 Bearer token、插件作者密钥或未授权团队数据。invocation 终态再归并 step attempt，取消/超时同步收口两者。
- 单 action Cloud 预览复用 action 子任务的 `ActionInvocation(kind=PREVIEW)` 与同一 Cloud adapter，不创建伪造的单节点 `WorkflowRun` 或平行预览状态机；只有实际多节点工作流预览才使用 `WorkflowRun(executionScope=PREVIEW)`。
- Cloud action invocation 的单次治理请求必须原子包含 `invoke_action + execute_cloud`；Web 单 action Cloud PREVIEW 再包含 `web_preview`。任一 operation 被拒绝则不选 deployment、不入队、不调用 endpoint，Cloud 层不得补做第二次 evaluator。
- 运输层采用至少一次投递，业务 run/attempt 通过数据库幂等键、状态 CAS 和 action 幂等键防止重复终态与重复安全调用。
- Cloud queue/worker 复用 workflow run 的有界 RuntimeArtifactHold；排队不使输入/中间制品提前清理，worker 只在 frozen mapping 为当前 invocation 附加的同 execution kind 最小 grant 下读取。workflow-linked invocation 在 `SUCCEEDED` 事务内先建立 `HANDOFF_PENDING` hold，coordinator 再转换为 edge/final hold，避免终态提交后映射前崩溃导致普通 TTL 清理。Cloud 不创建 team-wide artifact grant，终态/取消按 workflow retention 释放 hold。
- `read_only` 和带平台幂等键的 `idempotent` action 最多自动重试两次；`side_effect` action 不自动重试，发送后结果未知即失败并告警。

### R3. 触发器与时区

- 首版触发方式只有手动立即、指定 UTC 时刻运行一次、按 IANA 时区每天固定本地时间运行、按 IANA 时区每周指定星期和本地时间运行。
- API 和 UI 只接受结构化 trigger 字段，不接受用户提供的 cron 表达式、Webhook URL 或业务事件类型。
- 重复计划保持本地墙钟时间语义；时区规则变化和夏令时边界行为必须确定、可预览并有自动测试。
- 每个 schedule 绑定精确 workflow release 和已验证输入；更新版本、输入、时区或时间均创建新 generation，旧 generation 的迟到任务不得启动新 run。
- schedule 持久输入只允许通过 workflow input schema 的内联 JSON，递归拒绝 typed ArtifactRef；长期 artifact lease 不属于首版，媒体应由运行中的 action 生成。普通 string 不按 URL/path/data URI 形状猜测或拒绝，仍完全按声明 schema 校验。
- schedule 可以创建、暂停、恢复、更新和删除；暂停、恢复、任意更新和删除都递增 generation 并重建/移除调度投影，旧 generation job 永远 no-op。暂停/删除不取消已开始 run；是否取消由用户单独操作。
- schedule create/update/pause/resume/delete 每个命令都对精确 workflow/schedule resource 单次请求 `manage_schedule`。每次 fire 重新装载创建者当前 membership/principal，并以一个 root compound decision 原子请求 `trigger_schedule + run_workflow + execute_cloud`；任一 deny 均零 run/queue/endpoint 调用并审计。
- schedule 业务 lifecycle 只使用 `ACTIVE|PAUSED|COMPLETED|MISSED|DELETED`；队列投影状态单独使用 `syncState=PENDING|SYNCED|ERROR`，同步失败不得把业务 lifecycle 改成 pending/error。
- 每次触发持久化由 IANA 时区墙钟 occurrence 生成的 `occurrenceKey`；同一 `scheduleId + generation + occurrenceKey` 最多创建一个 run。worker/Redis/API 重启、DST fold 或重复投递不得产生重复运行。
- DAILY/WEEKLY 的 BullMQ template payload 只保存静态 scheduleId/generation/schedulerKey；worker 只信库生成 job 的 `opts.prevMillis` 和 `opts.repeatJobKey` 推导 scheduledFor/occurrenceKey，不使用 job.timestamp、处理时刻 now 或静态 template 中伪造的 occurrence。
- 调度基础设施停机后最多合并补跑一个已到期触发，不积压洪峰；单次计划恢复后执行一次或在超出平台补跑窗口时标记 MISSED 并告警。

### R4. 持久队列、Worker 与运行账本

- Cloud 自动化必须使用持久 Redis 队列和独立 worker；进程内 timer、可选 memory cache 或 API 请求生命周期不能充当调度器。
- Prisma 中的 workflow run/step、schedule lifecycle 和独立 syncState 是事实源；Redis 只负责可靠传输、延迟触发和 worker lease，队列状态不能覆盖业务终态或 lifecycle。
- API 写库与队列写入之间必须可恢复；队列不可用、worker 崩溃、锁过期和重复任务由 outbox/reconciler 幂等修复。
- worker 支持并发上限、按团队/工作流/action 的策略配额、端点级并发与速率限制，以及优雅停机。
- workflow run/step 记录排队、开始、重试、成功、失败、取消、超时、endpoint deployment、耗时和传输大小；可计量 usage 显式关联 workflow attempt 或单 action `ActionInvocation`，不要求为预览伪造 run，也不记录 secret 或二进制正文。
- 队列、worker heartbeat、积压、失败率、超时率和 schedule 同步状态具备 readiness/metrics/结构化日志。

### R5. 取消、告警与用户体验

- 用户可以查看当前团队 schedule 列表、下一次运行时间、最近结果、同步/暂停状态和对应工作流精确版本。
- 用户可以查看手动与定时 run 的 DAG、节点尝试、结构化错误和 ArtifactRef 结果，并请求取消非终态 run。
- 取消后不再派发新节点，worker 通过 AbortSignal 终止 HTTPS 请求；endpoint 已接收的副作用无法保证撤销，界面和审计必须明确结果。
- 自动重试耗尽、side-effect 结果未知、schedule MISSED、连续计划失败和 endpoint 被停用时向计划所有者发送站内通知，并保留可定位审计。
- 错误信息可以包含 endpoint deployment ID、HTTP 状态族和平台 request ID，但不得暴露 URL 中凭证、签名、原始响应正文或内部网络信息。

### R6. 环境隔离、发布与回滚

- PREVIEW 与 PRODUCTION 使用独立 endpoint deployment、凭证、配额和 Artifact scope；schedule 只能调用 PRODUCTION。
- 一个精确 action release/environment 可以设置 stable deployment 和一个 candidate deployment，以明确百分比渐进放量；每次 run 冻结实际选中的 deployment。
- candidate 失败时可以把流量立即归零并回到 stable；已开始 run 不切换 deployment，历史记录保持可追溯。
- secret 轮换沿用 deployment 发布流程：旧 READY deployment 在新 DRAFT 配置/verify/routing CAS 前继续服务，切换后只影响新 invocation/plan；旧 deployment 待所有冻结引用结束后再 RETIRED。
- endpoint 在轮换 overlap 期间必须按 deploymentId 同时接受 old/new secret；平台为 standalone ActionInvocation 和每个 workflow plan node 保存可索引的 deployment binding。旧 deployment 仍被 active routing 或任一非终态 binding 引用时不得 RETIRED/移除 secret。
- endpoint deployment 被停用、release 被撤回/封禁或团队策略收紧后，阻止新 run/新节点并审计；不得静默选择其他 endpoint 或 action 版本。
- 平台提供 Cloud/schedule kill switch，可停止新触发和新节点，同时保留历史查询、普通 v4 插件和桌面本地运行能力。

## Acceptance Criteria

- [ ] 包含 actionSurfaceSha256 的精确 action target 创建 PREVIEW/PRODUCTION deployment 后状态为 DRAFT 并只返回一次 secret；作者配置 endpoint 后显式 verify 成功才进入 READY 并可被 Cloud adapter 路由。DRAFT、验证失败、未声明 cloud-capable 或任一 target 字段不匹配时拒绝调用。
- [ ] endpoint 注册/verify/调用拒绝 HTTP、userinfo、回环/私网/链路本地/云元数据 IP、DNS rebinding 和所有 3xx redirect，并记录安全审计；side-effect action 每个 invocation 最多向一个固定 URL 发送一次 POST。
- [ ] endpoint 可以验证平台签名、时间戳、nonce、invocation ID、含 actionSurfaceSha256 的精确 action target 和 deployment ID；篡改 body/header、重放过期请求或错误 secret 均失败。
- [ ] secret 创建后只返回一次，加密存储和轮换；创建响应不会等待 endpoint 就绪，verify 会重新执行网络安全与签名 challenge；API、日志、Prisma run/attempt、队列 job 和 `.lfplugin` 中搜索不到明文。
- [ ] secret 轮换创建新的 DRAFT deployment；旧 READY 在新 deployment verify 和 routing CAS 前持续可用，切换后既有 invocation/plan 仍使用旧 binding，无覆盖 active secret 或轮换停机窗口。
- [ ] 轮换 overlap 中 endpoint 可分别验证 old/new deploymentId+secret；长在途 workflow 和 standalone invocation 继续用旧 binding。旧 deployment 有 active routing/非终态 binding 时 retire 返回 conflict，全部收口后才允许 RETIRED。
- [ ] 输入在发送前、输出在提交前通过共享 schema 与 ArtifactRef scope 校验；超大 inline body、裸 URL/path/data URI 或跨团队 ArtifactRef 被拒绝。
- [ ] queue delay 超过 artifact 普通 TTL 时，活动 run hold 仍允许精确映射 consumer 执行；伪造 node/edge/invocation 无 grant，run 终态后 hold 释放并由 cleanup 回收。
- [ ] worker 在 invocation `SUCCEEDED` 提交后、step attempt 归并前崩溃且恢复超过普通 TTL 时，`HANDOFF_PENDING` 仍保留输出并可幂等转换；并发 coordinator/reconciler 由 canonical holderKey + DB unique 收敛为单行，released pending 不 reopen，孤立 hold 最终释放。
- [ ] 只有全 Cloud-capable 且全部生产 deployment 就绪的工作流可选择 Cloud；拒绝结果列出每个本地-only、缺 deployment、策略 deny 或 entitlement 缺失节点。
- [ ] 桌面关闭时，手动 Cloud 工作流仍能完成图片 -> 视频/配乐并行 -> 聚合输出，并追溯所有 action/deployment 精确版本。
- [ ] 创建 schedule 只接受 ONCE/DAILY/WEEKLY 结构化输入和合法 IANA 时区；cron、Webhook 和业务事件字段由 DTO 白名单拒绝。
- [ ] 用户可以预览下一次执行时刻；Asia/Shanghai 和含夏令时的 IANA 时区在日/周计划中保持文档化墙钟语义。
- [ ] ONCE 只创建一次 run；DAILY/WEEKLY 在桌面关闭时持续触发；暂停/删除后不产生新 run，已开始 run 保持原状态。
- [ ] schedule lifecycle 只出现 ACTIVE/PAUSED/COMPLETED/MISSED/DELETED；Redis 同步失败只更新 syncState/error code，恢复后可重试且不篡改 lifecycle。
- [ ] 更新 schedule 后 generation 增加，旧 generation 的迟到 job 被忽略；`occurrenceKey` 持久化，同一 schedule + generation + occurrenceKey 在 DST fold、并发 worker、重启和重复投递下只有一个 run。
- [ ] 重复计划延迟消费或 worker 重启时，scheduledFor 仍来自 `opts.prevMillis`；template data 静态、处理时刻变化不改变 occurrenceKey，`repeatJobKey` 与 DB schedulerKey 不匹配时 no-op。
- [ ] pause/resume 同样递增 generation；pause 前的 delayed job 在 resume 后送达也被旧 generation 拒绝，且不会误触发 run。
- [ ] schedule CRUD 每次只有一个 manage_schedule decision；撤回 trigger_schedule/run_workflow/execute_cloud 或创建者离开团队后，迟到/正常 fire 都 no-op + audit 且零 run/queue。
- [ ] schedule 输入接受受限内联 JSON并拒绝任意层级 typed ArtifactRef；合法 string 只按 schema 判断而不做 URL/path 启发式拦截，重复计划不会依赖过期 artifact，运行中 action 产生的 ArtifactRef 仍可正常流转。
- [ ] Redis 暂时不可用时 API/worker 不伪造成功；恢复后 outbox/reconciler 同步 schedule 与 QUEUED run，且不会重复执行。
- [ ] worker 在 action 执行中崩溃后，read-only/idempotent 使用同一业务幂等键且总重试不超过两次；side-effect 结果未知不会再次发送。
- [ ] BullMQ job 自身重投不增加 domain attempt；run/step 的重复/乱序状态写入不能覆盖数据库终态。
- [ ] 每个 Cloud WorkflowStepAttempt 唯一关联一个 ActionInvocation；worker 只 claim invocation/gateway，零直接 adapter/endpoint 调用。invocation 与 attempt 的成功/失败/取消/超时映射保持单一终态。
- [ ] 节点超时、HTTP 4xx/5xx、TLS/DNS/连接失败、响应截断、schema 错误和取消均映射稳定错误码，并按可重试矩阵处理。
- [ ] 用户取消后不再开始新节点，进行中请求收到 abort；无法撤销的副作用被标记为可能已发生而非显示已回滚。
- [ ] worker 并发、团队/工作流/action 配额和 endpoint 限速均可配置；超限时排队或明确拒绝，不绕过计量。
- [ ] run/schedule 列表严格按 team 隔离；Owner/Admin 同样受平台门禁、权益和团队策略约束。
- [ ] PREVIEW 与 PRODUCTION deployment、secret、Artifact grant/hold execution kind 和 usage 分离；单 action 预览记录为 `ActionInvocation(kind=PREVIEW)` 且 usage 关联该 invocation、没有对应 WorkflowRun，工作流预览才使用 PREVIEW WorkflowRun/attempt，二者都不能成为正式 schedule run；preview output 未经显式 import/copy 不能成为 PRODUCTION input。
- [ ] stable/candidate 按冻结计划确定 deployment；调整流量或回滚后只影响未创建的新 run，历史与在途运行不被改写。
- [ ] 最终失败、连续 schedule 失败、MISSED 和 endpoint 停用产生站内通知与审计，通知不会包含 secret 或原始敏感 payload。
- [ ] readiness 能区分数据库、自动化 Redis、队列和 worker heartbeat；持久 Redis 未配置或使用不安全淘汰策略时 Cloud 自动化 fail closed。
- [ ] 关闭 Cloud/schedule kill switch 后不再创建新触发或节点，普通插件 API、市场、桌面本地运行和历史查询仍正常。
- [ ] 旧 `runtime_type=cloud` 且没有 action contract 的发行版不会自动获得执行能力；作者发布新 action release 前保持现有提示行为。

## Dependencies

- 前置：`07-15-cross-plugin-action-runtime` 的 action/invocation/ArtifactRef 契约与 Cloud adapter interface。
- 前置：`07-15-team-plugin-policy-governance` 的 cloud/schedule 默认拒绝与运行时策略决策。
- 前置：`07-15-workflow-plugin-platform` 的精确计划、DAG reducer、run/step ledger 和 Cloud eligibility。
- 集成：共享 KV、市场计量/结算和 Web preview 分别消费本任务的 invocation usage 与 PREVIEW scope，不改变 Cloud 核心状态机。

## Constraints

- 本任务处于规划阶段，统一评审前不得启动实现。
- 自动化 Redis 是生产依赖，必须持久化且禁止淘汰队列键；不能退化到现有 memory cache。
- 资金扣费与退款由市场结算子任务拥有；本任务只产生可重放 usage 事件和关联 run/attempt ID。
- endpoint 作者托管意味着平台只能保证调用契约、身份、网络边界和记录，不能证明 URL 背后的业务代码字节永久不变。

## Out of Scope

- 托管任意上传 Node.js/Python 代码、容器构建、用户自定义镜像和通用 FaaS。
- Webhook、业务事件触发、消息总线触发、自定义 cron、秒级高频计划和复杂日历规则。
- 异步 callback endpoint、长轮询 operation protocol和跨平台分布式事务补偿。
- 自动撤销已完成 side-effect、人工审批节点、schedule 级工作流自动升级。
- 银行卡支付、提现、税务、发票或在本任务中实现最终结算。

## Planning Status

- 产品和技术边界已按父任务推荐方案收敛，无阻塞性开放问题。
- 规划完成后与其余子任务统一提交用户评审；评审前不调用 `task.py start`。
