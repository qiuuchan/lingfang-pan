# 插件平台二阶段集成设计

## Purpose

本设计定义八个子任务之间的边界、共享契约、依赖顺序和跨域验收。父任务不承载业务实现；每个子任务独立启动、检查和归档，父任务最后负责集成评审。

## Architecture Principles

1. 服务端事实优先：策略、权益、listing、价格、workflow version、run、共享数据和结算均由 collab-api 持久化，UI 不本地推导。
2. 精确版本执行：已发布工作流和每次运行绑定 packageId、releaseId、sha256、actionId、actionContractVersion 和 actionSurfaceSha256。
3. 显式能力边界：宿主 capability、插件导出 action、团队共享数据和 ArtifactRef 是四类不同契约，不复用任意 scope 或裸 JSON 字段。
4. 默认最小权限：跨插件、cloud、schedule 和团队共享状态默认拒绝；工作流不能放大用户、团队或被调用插件权限。
5. 确定性优先：AI 只在创建阶段生成 DAG 和字段映射，运行时不静默推断版本、类型或转换。
6. 渐进兼容：现有 v4、本地安装账本、桌面市场和本机 shared data 保持兼容，新能力通过可选 manifest 字段与 feature flag 增量开启。
7. 成熟基础设施：DAG 校验、持久队列、调度、实时连接和 schema 校验使用成熟库，不自研底层协议。

## System Map

    Plugin manifest and workflow artifact
      -> contract validation and release governance
      -> entitlement and team policy decision
      -> exact action dependency resolution
      -> desktop runtime or cloud queue/worker
      -> ArtifactRef and team shared JSON state
      -> run, usage, quality and settlement events
      -> desktop catalog, Web catalog and admin control plane

## Shared Contract Ownership

| Contract | Owning child task | Consumers |
|---|---|---|
| PolicyAction、PolicySubject、PolicyDecision、PolicyVersion、PackagePolicySurfaceV1 | 团队插件策略与治理 | registry、action、workflow、cloud、shared、Web |
| PluginAction、ActionDependency、ActionSurfaceDigest、InvocationPrincipal、InvocationEnvelope、ActionInvocation | 跨插件 Action 调用 | governance adapter、workflow、cloud、SDK、desktop、Web preview |
| Restricted JSON Schema、ArtifactRef、RuntimeArtifactGrant/Hold/HANDOFF_PENDING | 跨插件 Action 调用 | workflow、cloud、shared、Web |
| WorkflowDefinition、WorkflowVersion、WorkflowNode、field mapping | 工作流插件平台 | cloud、desktop、Web |
| WorkflowRun/StepRun 状态契约 | 工作流插件平台 | cloud worker、Web、desktop、quality |
| Durable queue、schedule、deployment、transport delivery/lease transition | Cloud 插件与定时自动化 | workflow-owned run reducer、preview、operations |
| SharedNamespace、SharedValue、SharedChangeEvent | 插件共享数据与协作状态 | action、workflow、cloud、desktop |
| QualityTier、QualitySnapshot、RecommendationSection | 市场质量与推荐 | desktop、Web、admin |
| EffectivePrice、internal priceRevision、opaque string priceVersion/expectedPriceVersion、MarketplaceCommerceFactsPort、Settlement、Refund、Promotion | 市场结算与营销 | quality、purchase、desktop、Web、admin |
| PublicPluginCard、PluginDetail、PreviewSession、CloudTrialProjection | Web 插件中心与预览 | apps/web、collab-api；projection 导入 action-owned invocation 状态 |

同名字段只在 owning child 的 contract 模块定义。消费者导入 decoder 与投影，不复制枚举或在 UI 中重建状态机。

## Data And Identity Model

- Package 是跨版本插件身份；Release 是不可变执行制品；Installation 是本机事实。
- Action 由 package + stable actionId 标识，action contract 独立版本化；精确 ActionTarget 额外冻结 canonical actionSurfaceSha256，防止相同 contract version 下发生 surface 替换。
- Workflow 是可上架 package 类型；WorkflowVersion 保存不可变 DAG、作者声明的 SemVer range 和解析后的精确节点依赖，range 不参与运行时解析。
- WorkflowRun 在开始时冻结完整执行计划；root request scope 绑定 principal/caller/trigger/精确 workflow release/target/scope，并以 canonical request digest 检查同 key 冲突。StepRun 记录 attempt、输入/输出引用、费用、错误和终态。本地 run 还绑定短期 DesktopExecutorSession 与 device inventory hash。
- 单 action cloud 预览使用 ActionInvocation(kind=PREVIEW) 账本；它与 WorkflowRun 共享调用 envelope、策略、配额和审计组件，但不伪造工作流与步骤状态。
- ArtifactRef 标识运行输出，不与 .lfplugin release artifactKey 混用。RuntimeArtifact 父行不可变保存 STANDARD/PREVIEW，grant/hold 通过复合 FK 匹配；canonical subject/holder key + DB unique 使并发 acquire/convert/reconcile 收敛，released/revoked row 不 reopen。workflow-linked producer 在 SUCCEEDED 事务先 acquire HANDOFF_PENDING，再由 coordinator转换为 edge/final hold；PREVIEW copy 生成新 STANDARD artifact ID，不能直接派生生产 grant。WORKFLOW_RUN input/final grant 分别随 run终态/结果 retention 撤销。
- Shared namespace 使用 team + package/workflow owner + namespace，release 更新不迁移身份；每个 SharedValue 保存自己的 schemaVersion。嵌套 ArtifactRef 另有 namespace generation/key/value revision 绑定的 SHARED_VALUE edge/canonical grant/hold，读取只为已授权当前 STANDARD invocation 兑换 live 权限，旧 revision 更新/删除时 revoke/release且不 reopen。namespace `nextValueRevision` 为 create/update/delete 分配不复用的 value revision 以服务 CAS/ABA 防护，独立 change cursor 服务断线续传；namespace 删除只清值并保留 allocator，同名重建递增 generation。全量 relist 在第一页 value 查询前捕获 snapshot cursor，再以 changes-after 补齐分页并发变更。
- Listing 原子保存 currentReleaseActivatedAt；hard-gate 可见 projection 与 eligibility epoch/revision/gate digest 同事务切换，目录 digest 不一致时 fail-close。QualitySnapshot 身份包含 factWatermark/computationRevision，调度 job 幂等键与快照身份分离。
- Listing 内部 priceRevision 是 Int CAS 事实，公开 priceVersion/expectedPriceVersion 从 M2 起始终是 opaque string。Order 保存原价、活动价、分成比例、内部 revision 和公开 token 快照，后续设置变化不改历史订单；marketplace subledger 为买家可用、平台 clearing、卖家可用与平台收入账户保存不可变平衡分录，订单 pending 投影始终由 clearing 中的实付价覆盖。

## Cross-Child Data Flow

### Publish

1. SDK/Creator 生成普通插件或 workflow artifact。
2. Contract 校验 action、dependency、schema、runtime target 和 workflow DAG。
3. Registry 解析并保存 release manifest 投影与 sha256。
4. Governance/AI policy 审核 release；marketplace listing 只指向已批准 release。
5. Workflow 发布时解析兼容范围并冻结精确 release/action contract。

### Run

1. 用户或 schedule 请求工作流运行时创建 WorkflowRun；Web 单 action cloud preview 创建 ActionInvocation(kind=PREVIEW)。
2. 服务端构造 InvocationPrincipal 与可信 requiredOperations，并只调用 governance evaluator 一次；evaluator 统一读取发行状态、权益、团队策略、USER/ROLE grant 和节点请求，在同一 revision 原子求交全部 operations，返回可审计的单一决定。
3. Desktop 只从已绑定且 inventory hash 匹配的短期 DesktopExecutorSession 执行本地 action；cloud queue 只接收全 cloud-capable execution plan 或受限 preview invocation。
4. Worker 按 DAG 依赖派发节点，read-only/idempotent 节点最多重试两次。
5. 小 JSON 内联流转，大输出经 execution-kind-bound ArtifactRef grant/hold；producer terminal 到 step mapping 由 HANDOFF_PENDING 覆盖，共享状态经 sdk.shared、`shared_data_read|write` policy 与 SHARED_VALUE revision scope。
6. Run/StepRun、usage、error、artifact grant/hold 和审计在终态对账，生成质量指标事件。

### Discover And Buy

1. Quality job 从审核、运行、评分、退款和故障事实生成 QualitySnapshot。
2. Marketplace projection 合并 listing、quality、effective price 与 compatibility。
3. Desktop/Web 只消费统一投影。
4. Purchase 用服务端 resolver 重新校验 opaque string priceVersion、权益和余额；M2 LEGACY 在 stale token 时零业务写，M3 V2 再在同一事务创建订单、权益和守恒 marketplace subledger 分录：买家可用余额 debit 与平台 clearing credit 合计为 0；T+7 settlement 再以 clearing debit、卖家 credit 和平台收入 credit 完成冻结比例拆账。

## Reference Scenario

A 插件导出 generate_image，B 插件导出 generate_video，C 插件导出 generate_music。Creator 依据三个 action schema 生成受限 DAG：

- A 先生成 image ArtifactRef。
- B 消费 image ArtifactRef 生成 video ArtifactRef。
- C 可与 B 并行，消费用户 prompt、image metadata 或显式映射字段生成 audio ArtifactRef。
- 可选的后续合成 action 将 video/audio 合并；平台不会把“合成”隐式塞入 B 或 C。
- workflow 发布冻结 A/B/C 的精确 release 和 action contract。
- 全部 action 为 cloud-capable 时可每日定时运行；否则只在桌面手动运行。
- 最终结果和 run summary 可写入 workflow 自有团队 shared namespace。

## Infrastructure

### Database

Prisma schema 继续同时支持 PostgreSQL 与 MySQL。新增模型采用显式唯一键、状态索引、CAS version/revision 和可分页游标。迁移先扩展、后启用，不删除旧列或旧路由。

### Queue And Scheduler

Cloud 子任务引入成熟的 Redis-backed queue/worker 和 job scheduler。数据库 run ledger 是业务真相，队列 job 只是可重投交付机制；worker 必须先按 run/step revision claim 再执行，避免 at-least-once 投递产生重复副作用。WorkflowRun 节点最终失败后先进入 FAILING/closing 并等待在途 attempt 收口，才写 FAILED 终态。Schedule 业务状态只含 ACTIVE/PAUSED/COMPLETED/MISSED/DELETED，队列同步故障写独立 syncState；每次本地时区 occurrence 保存 occurrenceKey，并以 scheduleId + generation + occurrenceKey 唯一去重。

### Object Storage

现有插件制品 ArtifactStore 泛化为 Blob/Object Store，分别使用 release、run-output、preview-media 等命名空间。ArtifactRef 记录 team、owner、sha256、mime、size、expiry；下载使用短期授权，不持久化签名 URL。

### Realtime

共享状态 Milestone 3 使用成熟 Socket.IO 与 Redis adapter。持久 JSON 仍由 REST/CAS 提供，realtime 只广播 presence 和 key revision invalidation。每个 namespace 的变更 outbox 分配单调持久 cursor，并提供有明确保留期的 changes-after API；游标过期返回显式错误，客户端全量 relist 后再订阅。

### Web

新增 apps/web 用户端与独立 preview origin。collab-admin 继续只服务平台管理员，desktop 继续拥有本机安装与运行能力。

## Security Model

- 平台门禁/权益/发行状态 > 团队上限 > 用户授权 > 角色授权 > workflow node request。
- InvocationPrincipal 只能由宿主构造，插件不能自报 team、user、package 或 release。
- Cloud endpoint 请求使用短期签名、audience、deadline、nonce 和 idempotency key；重放被拒绝。
- Cloud endpoint 先以 DRAFT 创建并只返回一次配置 secret，作者完成配置后显式 verify；只有 READY endpoint 可接收 preview 或正式 invocation。
- client preview 运行在独立 origin opaque sandbox，不持有主站 token/cookie。
- ArtifactRef、shared namespace、run 和 preview 都重新校验 team 与当前策略。
- 日志和审计不记录 secret、完整输入输出、共享值或签名 URL。
- 钱包账本、settlement 和 refund 采用不可变分录与守恒断言。

## Events And Observability

统一事件至少包含 eventId、occurredAt、teamId、actor/principal、packageId、releaseId、actionId、workflow/run/step、requestId 和 schemaVersion。各域写本地事务 outbox，消费者按 eventId 幂等。

核心指标：

- policy allow/deny 与命中规则
- action/run 成功率、P50/P95 时长、重试和取消
- queue delay、lease recovery、schedule misfire
- ArtifactRef 字节、过期与下载失败
- shared KV quota/conflict 和 realtime connections
- preview quota/失败/转化
- listing 曝光、获取、购买、退款和质量层级变化
- settlement pending/available 守恒与异常

## Delivery Dependencies

### Milestone 1: Platform Kernel

1. Governance 先交付不依赖 action surface 的 core evaluator；Action 子任务随后定义 PluginAction、ActionSurfaceDigest、ArtifactRef 和 InvocationPrincipal。
2. 两个子任务在联合 gate 冻结 digest 与 evaluator adapter 的请求、决定和错误字段，再依次完成 governance action adapter 与 invocation runtime，任何一方不得复制另一方的事实读取。
3. 共享契约稳定后先交付 Workflow core、ExecutionPlan 和 run/step reducer/ledger；Cloud 不得在这些 contract 未落地时复制临时状态机。共享 KV 可与 Workflow core 并行。
4. Workflow ledger 稳定后，Cloud queue/schedule/deployment/transport 与共享 KV 可并行集成；Cloud 只调用 workflow-owned domain reducer。
5. 使用 A/B/C 内置参考插件完成桌面手动与 cloud 定时闭环。

### Milestone 2: Distribution

1. 先执行结算子任务的 M2 dark foundation，只 additive 部署 commerce mode/compatibility fields、internal priceRevision、稳定 string priceVersion resolver/expectedPriceVersion LEGACY 校验与 MarketplaceCommerceFactsPort；writerMode 保持 LEGACY，接受请求的资金行为 byte-equivalent。
2. 市场质量与推荐再生成统一 catalog projection；通过 facts port 得知 settlement-v2 不可用时，付费 listing 的退款项为 data_unavailable，不能自动晋级优质。
3. Web 先上线匿名只读目录，再接 client preview、cloud trial、权益与带 expectedPriceVersion 的基础标价/购买，不等待 V2 writer。
4. 桌面市场切换为同一质量和基础价格投影，避免两端排序漂移；活动价、T+7、退款与卖家对账留到 Milestone 3。

### Milestone 3: Commerce And Collaboration

1. 恢复市场结算与营销子任务，从已部署 dark foundation 进入 DRAINING fence，drain 后重跑增量 backfill并以 pre-cutover version/status 零 null + reconciliation 为切换门，再迁移既有即时卖家入账为订单快照、守恒 marketplace subledger 与 T+7，并把 settlement-v2 退款事实接入已部署的质量计算。激活后 PAUSED 仍提供既有 cohort facts。
2. Shared realtime 在 Redis 多实例与 outbox 验证后开启。
3. Web/desktop 增加卖家对账、活动价和 presence，但不改变基础运行 contract。

## Compatibility And Migration

- Plugin manifest 新字段全部 optional，普通 v4 release 缺省为无 exported action、无 cloud-capable、无 shared namespace。
- 未显式迁移的旧 marketplace/钱包路由继续返回既有兼容响应，不重新启用双写。
- Existing shared localStorage 保持本机 API，不自动上传。
- Existing cloud runtime 不自动获得执行 endpoint；需新 release 显式声明并审核。
- Existing purchase/entitlement 在新 settlement 上线前迁移为已结算历史快照，不重放资金。

## Rollout And Rollback

每个域拥有独立 feature flag；顺序为 contract dark launch、内置参考插件、内部团队、allowlist、一般可用。关闭新 flag 不删除数据库或对象，旧桌面本地运行、registry、entitlement 和余额仍可用。settlement-v2 writer 完成数据 gate 并切换后不可回到旧即时卖家入账路径；营销/投影可独立关闭，基础价新订单仍走 v2，结算核心故障时付费购买 fail-close。

父任务只有在八个子任务均归档且端到端场景通过后归档。任一子任务回滚由其 own design 执行，父任务不通过跨域 reset 回滚历史资金或用户数据。
