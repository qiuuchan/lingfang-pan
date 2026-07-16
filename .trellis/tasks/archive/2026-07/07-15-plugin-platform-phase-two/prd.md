# 插件平台二阶段

## Goal

在现有“桌面插件运行时 + 团队发行治理 + 账内付费市场”基础上，把插件系统升级为可治理、可组合、可云端执行、可商业化并支持团队协作的平台。

本任务是产品路线父任务，负责保存原始需求、子任务映射、跨域约束和最终集成验收；实际交付由可独立规划、实现、验证和归档的子任务承担。

## User Value

- 团队管理员能够统一控制插件来源、能力、版本、审批与运行边界。
- 插件作者能够复用其他插件能力、创建可发布的工作流插件，并选择桌面或云端执行。
- 用户能够在桌面端和 Web 端发现、评估、预览、购买和使用插件。
- 插件作者与平台能够完成可信的交易结算、营销推广和效果归因。
- 同一团队内的插件能够在明确授权下共享数据与协作状态。

## Source Requirements

1. 支持团队级插件治理策略。
2. 支持跨插件调用。
3. 支持创建工作流插件。
4. 支持市场推荐与质量分层。
5. 支持付费市场的结算与营销。
6. 支持 Web 版插件中心与在线预览。
7. 支持 cloud 插件与定时自动化。
8. 支持插件共享数据与协作状态。

## Confirmed Baseline

- 当前已有 v4 package/release/review/listing 生命周期、团队 RBAC、按用户或角色的插件授权、来源与制品校验、撤回/归档及审计能力。
- 当前市场已有团队余额原子扣款、卖家团队即时入账、购买记录、权益和双边流水，但尚不等同于真实支付结算体系。
- 当前桌面端已有已安装、团队库、插件市场三个消费入口；Web 端仅有平台管理后台，没有面向终端用户的插件中心。
- 当前插件运行类型为 client、nodejs、python、cloud；cloud 主要是契约与分发保留位，尚无生产级云执行器、调度器和运行历史。
- 当前桌面运行时存在按源插件 ID 读取的本机共享 KV，但数据位于本机存储，且正式 contract/SDK 尚未声明对应能力。
- 当前没有跨插件 RPC、插件导出与依赖契约、可发布的 workflow 类型、DAG/步骤编排、Web 在线执行沙箱或实时协作状态模型。
- 当前 manifest 的 capabilities 表示插件请求宿主权限，不表示插件对外导出的动作；manifest 也没有 action、dependency 或输入输出 schema。
- 当前图片结果使用裸 URL 或 data URI 字符串，插件发行制品的 artifactKey 只标识 .lfplugin 包，不能充当图片、视频和音频等运行时中间制品。
- 当前服务端没有持久化队列、worker、schedule、workflow run 或 step run 模型；现有进程内定时清理不能作为用户自动化调度器。
- 可复用的底座包括 package/release/sha 精确身份与运行门禁、RBAC 与权益校验、Prisma 事务和计量对账模式，以及可泛化的本地/S3 对象存储适配层。
- 现有 07-13-plugin-dev-sdk 任务明确聚焦 packages/plugin-sdk，不修改 runtime、API、contract，也不承担 cloud、市场或协作平台建设；本任务不得扩大其既定边界。

## Requirements

### R1. 团队级插件治理策略

- 团队管理员可以定义并发布适用于团队成员与运行环境的插件策略。
- 策略至少能够约束插件来源、能力、版本、安装、更新、运行和审批。
- 跨插件 action、cloud 执行、定时触发和团队共享数据默认拒绝；团队管理员可以按 package、action 或工作流显式启用。
- 现有 v4 本地插件的安装与运行保持兼容默认，新增策略不得在没有迁移提示和管理员确认的情况下使既有本地流程突然失效。
- 插件更新不得自动继承更新前未声明的高风险能力；新增 action、cloud、schedule 或共享数据范围必须重新进入策略评估。
- 策略解析顺序为：平台硬门禁、权益与发行状态 > 团队策略上限 > 用户显式授权 > 角色授权 > 工作流节点请求。
- 平台与团队层定义不可突破的授权上限；用户规则可以覆盖角色规则，同一层级与同一具体度内 deny 优先，工作流节点只能在最终授权交集中运行。
- Owner 与 Admin 可以管理其权限范围内的策略，但运行时没有隐式绕过；其插件调用与普通成员一样经过最终策略决策。
- 首版不提供 break-glass、临时豁免申请、二次审批、限时授权或自动过期机制；Owner/Admin 在其管理权限内直接修改团队允许项，系统记录变更审计。
- 策略决策必须可解释、可审计，并支持安全的灰度生效与回退。
- 现有 package grant 与平台审核继续作为底层权限和发行治理能力，避免形成互相矛盾的第二套授权事实源。

### R2. 跨插件调用

- 插件可以声明稳定、具名、可版本化的导出 action，以及对其他插件的依赖。
- 一个插件可以暴露多个具名 action；工作流节点一次只调用一个 action，单功能插件可以只提供一个默认 action。
- 每个 action 必须声明稳定 action ID、契约版本，以及受限 JSON Schema 表达的输入和输出；宿主 capability 的 scope 字段不得复用为 action 契约。
- 小型 JSON 与文本可以作为内联值传递；图片、视频、音频和其他大型或二进制输出统一使用平台托管的 ArtifactRef。
- ArtifactRef 必须包含不可伪造的制品身份、媒体类型、大小、完整性与授权信息；本机路径、任意外部 URL 和 data URI 不得作为持久工作流边界。
- RuntimeArtifact 父行及 grant/hold 必须数据库级绑定同一 STANDARD/PREVIEW execution kind；PREVIEW output 不得靠换 grant 直接进入生产，copy 必须生成新 artifact ID。grant/hold 使用 canonical subject/holder key + DB unique 和 live-window/no-reopen 规则；workflow producer 成功与 step 映射之间由事务性 HANDOFF_PENDING hold 覆盖，shared value 使用独立的 value-revision-scoped SHARED_VALUE grant/hold，WORKFLOW_RUN grant 随 run/result retention 撤销，任何路径都不能退化为 team-wide 或因其他 holder 存在而复活。
- 调用前必须完成插件发现、版本兼容与授权检查；调用过程必须有超时、取消、错误和审计语义。
- 插件依赖可以在草稿阶段声明兼容版本范围，但任何已发布工作流及其运行计划必须绑定精确 package、release、sha256、action、action contract version 与 canonical action surface SHA-256。
- action 必须声明 read-only、idempotent 或 side-effect 执行语义；只有 read-only 或提供平台幂等键保证的 idempotent action 可以自动重试。
- 调用方身份与用户/团队授权不得因跨插件调用而被放大。
- action invocation 只调用治理子任务提供的统一 evaluator；发行状态、权益、团队策略与 USER/ROLE grant 不得在 action runtime 中形成第二套校验链。
- 平台必须限制循环调用、递归深度、并发与资源消耗，并允许团队策略禁用或收窄调用。

### R3. 工作流插件

- 工作流的核心语义是多插件调用编排：每个插件暴露一个或多个可调用能力或子工作流，工作流将这些能力组合为有依赖关系的执行图。
- 工作流作为可创建、预览、版本化、发布、安装和运行的正式制品存在，而不是创建器内部流程的别名，也不重复实现各插件的业务能力。
- 首版由开发者或 AI 创建器生成声明式、受限 DAG；普通用户负责安装、配置输入与触发器并运行，暂不提供自由拖拽的无代码编辑器。
- 工作流具有明确的整体输入输出、节点输入输出、依赖、步骤状态和失败处理。
- 工作流定义保存节点之间的显式字段映射；AI 可以在创建阶段生成和解释映射，但运行时不得静默推断、改写或转换数据。
- action 类型不兼容时，工作流必须加入显式转换节点或适配插件，并对转换结果执行同样的 schema 校验。
- 首版控制流只支持按依赖顺序执行、无依赖节点并行执行，以及可安全重试节点失败后的最多两次自动重试；重试仍失败时停止工作流。
- 首版不支持循环、复杂条件分支或人工审批节点。
- 工作流运行具有可追踪的实例、步骤结果和审计记录。
- 已发布工作流版本不可变；插件兼容更新只生成升级建议与兼容检查结果，通过检查和审核后发布新的工作流版本。
- 工作流发布版本同时保留作者声明的 SemVer range 与解析后的精确执行目标；range 只用于生成升级建议，运行只使用被冻结的精确目标。
- 工作流运行启动时冻结完整节点执行计划。节点 release 被撤回、封禁或不再满足策略时阻止新运行，不得静默改用其他版本或回退到 latest。
- root workflow request 的幂等域必须绑定 principal、可信 caller、精确 workflow release、execution target/scope 和 trigger，并以 canonical request/input digest 检测同 key 冲突；不能使用 team-wide key 复用其他用户、工作流或 PREVIEW/PRODUCTION 结果。
- 本地工作流运行必须绑定短期 DesktopExecutorSession 与设备能力清单摘要；服务端不得把本地节点派发给未声明对应 release/action 的任意桌面实例。
- 工作流节点引用经授权的插件导出能力，实际调用统一走跨插件调用契约，不允许通过私有运行时接口绕过授权和审计。
- 参考场景：A 插件生成图片，B 插件接收图片并生成视频，C 插件根据工作流上下文生成配乐；工作流负责把三个插件的能力和制品传递关系组合起来。

### R4. 市场推荐与质量分层

- 首版质量层级为“已上架 / 优质 / 精选”：已上架表示通过基础审核，优质表示满足稳定性、评分、使用量、低退款和低故障标准，精选由平台人工推荐。
- 首版推荐区只包含人工精选、分类热门和近期优质，不做个性化推荐算法。
- 主要质量规则和指标对插件作者公开，并向用户解释等级含义。
- 安装、活跃、评分、退款、故障、安全与审核信号必须防止简单刷量，并保留申诉和人工干预入口。
- 退款率只统计支持 7 天退款语义的 settlement-v2 订单 cohort；旧订单、结算能力未启用或退款仍在处理中均标记为 data_unavailable，不得按 0% 退款率帮助插件晋级。
- 推荐和质量结果不得绕过上架、团队策略、权益或兼容性检查。

### R5. 付费市场结算与营销

- 在现有购买与权益基础上，形成平台、卖家和买家的可对账资金生命周期。
- 首版继续使用 Team.balanceCents/BalanceLedger 的 CNY 团队内部余额，不接入银行卡、第三方收单、真实提现、税务或发票。
- TeamCredit/CreditLedger 的灵石仅用于 cloud、模型和工作流运行费用，与插件许可购买、分成和退款保持独立，禁止互相退款或换算。
- 每笔购买按平台配置的分成比例拆账，默认平台 20%、卖家团队 80%；比例变更只影响后续订单。
- 买家可用余额、平台清算账户、卖家可用余额和平台收入账户使用同一不可变 marketplace subledger 记账；购买先以买家 debit + 清算 credit 托管实付价，T+7 再以清算 debit + 卖家/platform credit 拆账，退款以清算 debit + 买家 credit 冲正，每个动作净额为 0。卖家 pending 是由清算资金覆盖的订单投影，不是无落点余额。
- 卖家收入进入 7 天待结算余额，期满后转为团队可用余额；结算前退款撤销权益并冲正原始账本分录。
- 首版退款仅支持购买后 7 天内申请并由平台管理员处理，不退还已经消耗的 cloud/模型调用费用。
- 卖家可以查看订单、平台分成、待结算、已结算、退款和按日汇总对账单。
- 首版营销只支持上架项限时折扣价与平台精选活动，记录活动来源和转化；不支持优惠券、联盟返利、订阅或复杂促销叠加。
- 金额、币种、舍入、幂等和账本一致性必须有明确契约，任何营销优惠不得破坏账本守恒。

### R6. Web 版插件中心与在线预览

- 普通用户能够在 Web 端浏览、搜索、筛选、查看详情、判断兼容性并完成授权范围内的市场操作。
- client 插件在浏览器沙箱中直接预览，不获得桌面专属能力。
- cloud-capable action 在用户登录后提供限额试运行，并与正式工作流运行区分。
- 仅本地运行的 Node.js/Python 插件在 Web 端展示截图、示例输出与兼容说明，并引导用户到桌面端运行，不在浏览器中执行。
- Web 与桌面端共享 package/release/listing/entitlement 事实源，状态和展示语义保持一致。
- 无法安全在线运行的插件必须提供清晰的兼容说明与桌面端承接路径。

### R7. Cloud 插件与定时自动化

- cloud 插件能够在桌面端离线时由平台执行，并遵循与本地运行一致的身份、权益、团队策略和能力边界。
- 每个 action 明确声明是否 cloud-capable；只有所有节点均为 cloud-capable 的工作流才能在桌面离线时运行或启用定时任务。
- 包含本地 action 的工作流仍可在桌面手动运行，但发布与启用定时任务前必须明确提示不兼容节点，且不得自动把本地代码上传到云端执行。
- 首版 cloud-capable action 通过平台管理或作者托管的 HTTPS action endpoint 执行；平台负责签名、授权、超时、幂等和结果校验，不托管任意上传的 Node.js/Python 代码。
- 首版支持手动立即运行、指定时间运行一次，以及按用户所选时区每日或每周重复运行。
- 首版不支持 webhook、业务事件触发或用户自定义 cron 表达式。
- 每次执行必须有幂等、超时、重试、并发、配额、取消、密钥、日志、结果和告警语义。
- cloud endpoint 必须经过 DRAFT 注册、一次性 secret 配置和显式验证后才能进入 READY；未验证 endpoint 不得接收预览或正式执行流量。
- 发布、预览和正式执行环境必须隔离，且支持版本固定、逐步发布和回滚。

### R8. 插件共享数据与协作状态

- 首版共享数据是团队级、按插件命名空间隔离的 JSON KV；插件与工作流在明确授权后可以读写。
- 图片、视频、音频和其他大文件不得写入共享 KV，统一通过 ArtifactRef 引用。
- ArtifactRef 写入必须从当前 STANDARD invocation 的具体 grant 原子转为 namespace generation + key + value revision 绑定的 SHARED_VALUE grant/hold；读取只为已通过 `shared_data_read` 的当前精确 invocation 兑换权限，更新、删除和 namespace 重建释放旧 scope。
- 插件可以声明共享数据空间、访问范围、数据契约和版本兼容规则。
- 每个共享值持久化 schemaVersion；读取、条件更新和变更订阅都返回该版本，未知或不兼容版本不得被客户端静默解释。
- 共享数据必须具备租户隔离、最小权限、审计、配额、删除和导出能力。
- 首版不支持 presence、实时共同编辑、CRDT、锁或租约；这些实时协作能力进入 Milestone 3。
- Milestone 3 只新增在线成员 presence、共享 JSON 变更订阅和基于 revision 的条件更新；冲突由客户端刷新后重试，不建设通用 CRDT 文档编辑器。
- 本机共享 KV 的兼容与迁移必须有明确策略，不得静默暴露或合并现有本地数据。

## Cross-Cutting Requirements

- package、release、installation、listing、entitlement、workflow、run、principal 和 team 标识在各端含义一致。
- action、action contract version、JSON Schema 与 ArtifactRef 是跨 runtime 的统一调用边界，TypeScript、Python、桌面和 cloud 不得各自维护不兼容的私有格式。
- 所有新增能力默认遵循租户隔离、最小权限、显式授权、审计和可撤销原则。
- contract、服务端、桌面运行时、Web、管理端和 SDK 的新增字段及状态机必须端到端可追踪，禁止依赖 UI 本地推导业务真相。
- 新能力必须保持现有 v4 插件与已安装插件兼容；不兼容变更必须有版本协商、迁移、灰度和回滚方案。
- 计量、推荐、质量、结算和营销使用可解释、可重放的事件来源，避免各域维护互相冲突的统计口径。

## Planned Child Tasks

1. 团队插件策略引擎与治理控制面。
2. 跨插件调用契约与运行时。
3. 工作流插件模型、编辑器与执行器。
4. 市场推荐、质量分层与反作弊。
5. 付费市场结算、分成与营销。
6. Web 插件中心与沙箱预览。
7. Cloud 插件执行与定时自动化。
8. 插件共享数据与协作状态。

## Delivery Roadmap

### Milestone 1: 平台内核

- 团队插件策略。
- 跨插件调用。
- 工作流插件 MVP。
- Cloud 手动与定时执行。
- 团队共享 KV。
- 目标是形成“受团队策略约束的工作流可组合插件能力，在云端定时运行并读写团队共享状态”的最小闭环。

### Milestone 2: 分发体验

- Web 插件中心。
- 受限沙箱在线预览。
- 市场质量分层与推荐。
- 在质量/Web 之前只暗部署 commerce compatibility schema、内部 priceRevision、从首版稳定为 string 的公开 priceVersion/expectedPriceVersion 校验和 facts adapter，writerMode 保持 LEGACY；token 匹配/旧客户端的资金行为不变，stale token 在业务写前拒绝。完整 settlement-v2 仍属于 Milestone 3。
- Web 购买沿用现有基础标价、余额购买与权益链路；活动价、T+7、退款和卖家对账到 Milestone 3 接入。
- settlement-v2 上线前，付费插件的退款质量项为 data_unavailable，不能凭结构性的“零退款”自动晋级优质。
- 依赖 Milestone 1 的授权、执行、计量与审计契约稳定。

### Milestone 3: 商业协作

- 内部余额结算、平台分成与营销。
- Presence 与实时协作状态。
- 在既有账内购买和团队共享 KV 上扩展，避免在平台内核未稳定前引入资金与实时冲突处理的复合风险。

## Acceptance Criteria

- [ ] 八个子任务均有独立、可测试的 PRD；复杂子任务具有 design.md 与 implement.md，并明确前置依赖和非目标。
- [ ] 父任务记录经确认的分期路线，每个里程碑都能形成用户可用的闭环，而不是仅交付孤立底层接口。
- [ ] 跨子任务共享的身份、授权、策略、运行、事件、计量和账本契约不存在冲突，并通过集成设计评审。
- [ ] 现有 v4 插件的发布、安装、更新、购买和桌面运行回归通过。
- [ ] 团队策略能同时约束安装、运行、跨插件调用、工作流、云执行、Web 预览和共享数据访问。
- [ ] 新团队或未配置团队无法默认执行跨插件 action、cloud、schedule 或访问团队共享数据；管理员授权后只开放选定 package、action 或工作流范围。
- [ ] 升级后现有 v4 本地插件仍可按兼容默认运行，但新增高风险能力保持关闭并触发明确的重新授权流程。
- [ ] 策略冲突测试覆盖平台、团队、用户、角色和工作流层级；下层 allow 无法突破上层 deny，用户规则可覆盖角色规则，同级 deny 优先。
- [ ] action invocation 只获得统一 evaluator 的单一授权决定；action runtime 不重复读取 entitlement、PluginGrant 或团队策略并产生旁路结果。
- [ ] Owner/Admin 直接运行工作流时仍受平台门禁、团队上限、权益和发行状态约束。
- [ ] Owner/Admin 可以直接修改团队允许项且变更留有审计；首版没有独立的临时豁免状态机或审批流。
- [ ] 工作流发布前可以验证所有 action 的输入输出 schema、字段映射与 ArtifactRef 类型，类型不兼容时拒绝发布并给出可定位错误。
- [ ] 同一插件可以发布多个具名 action，工作流节点能够稳定选择其中一个；只有默认 action 的单功能插件无需额外选择步骤。
- [ ] 首版工作流可以正确执行串行与并行 DAG；失败节点按有限次数重试，耗尽后工作流进入失败终态且不继续下游节点。
- [ ] 并行节点失败后 run 先进入 FAILING/closing，待所有已派发 attempt 终止或确认失联后才进入 FAILED；FAILED 后不再出现迟到的运行中节点。
- [ ] 只有 read-only 或具有幂等保证的 action 自动重试，最多两次；side-effect action 不会因基础设施重投产生重复副作用。
- [ ] action SDK 的公开 idempotencyKey 只作为宿主派生 logical effect identity 的 hint，request/domain-attempt key 始终由宿主生成；root WorkflowRun 幂等按 principal/caller/release/target/scope 隔离并以 canonical request digest 检测冲突。
- [ ] 首版拒绝包含循环、条件分支或人工审批节点的工作流定义，并返回清晰的兼容性错误。
- [ ] 已发布工作流及单次运行可以追溯到每个节点的精确 release、sha256、action contract version 和 actionSurfaceSha256；插件更新不会改变既有定义或运行中的执行计划。
- [ ] 已发布节点保留原始 declared SemVer range 供升级建议使用，同时任何执行只读取被冻结的精确 target；本地执行还可追溯到短期 DesktopExecutorSession 和设备清单摘要。
- [ ] 兼容插件更新生成可审核的升级建议；撤回或封禁的 release 阻止新运行且不会自动替换版本。
- [ ] 仅由 cloud-capable action 组成的工作流可以在桌面离线时运行和启用定时任务；包含本地 action 时系统在启用前拒绝并列出具体节点。
- [ ] 用户可以手动运行 cloud 工作流，或创建单次、每日、每周计划并选择时区；重复计划在桌面关闭时仍由平台触发。
- [ ] schedule 生命周期只使用 ACTIVE/PAUSED/COMPLETED/MISSED/DELETED，同步错误单独记录；DST 重复或跳过时段通过持久 occurrenceKey 与 generation 保证一次 occurrence 最多生成一个 run。
- [ ] 首版创建入口不接受 webhook、业务事件或自定义 cron 触发器。
- [ ] cloud endpoint 只有在 DRAFT 创建后配置一次性 secret 并显式 verify 成功才进入 READY；单 action cloud 试跑记录为 ActionInvocation(kind=PREVIEW)，不伪造 WorkflowRun。
- [ ] 团队共享 JSON KV 按插件命名空间隔离，只有明确授权的插件或工作流可以读写；跨团队访问被拒绝并记录审计。
- [ ] PREVIEW/PRODUCTION Artifact parent/grants 不互换且 copy 生成新 ID；canonical grant/hold uniqueness 使并发 HANDOFF_PENDING/shared reconciler 无重复 blocker，revoked/released row 不 reopen；WORKFLOW_RUN/SHARED_VALUE 权限分别在 retention 到期或 update/delete/namespace clear 后撤销。
- [ ] 每个 shared value 保存并返回 schemaVersion；realtime 使用 namespace 单调持久 cursor，游标在保留期内可续传，过期时明确要求全量 relist。
- [ ] shared value revision 与 namespace generation 均不因删除重建而复用；旧 CAS、relist/runtime token 或订阅不能命中新 generation，全量 relist 在第一页查询前捕获 snapshot cursor 并补齐分页并发变更。
- [ ] 共享 KV 拒绝大文件载荷并引导使用 ArtifactRef；Milestone 1 不暴露 presence、实时编辑、CRDT 或锁接口，Milestone 3 只增加 presence、change subscription 与 revision CAS，仍不提供实时编辑、CRDT 或锁。
- [ ] Web 插件中心可以浏览所有上架插件；client 插件可在沙箱预览，cloud action 可登录限额试运行，本地 Node.js/Python 插件只展示示例并跳转桌面端。
- [ ] Web 预览和试运行无法获得未声明能力，也不会被记录为正式工作流运行或绕过团队策略与权益。
- [ ] 市场插件只显示已上架、优质、精选三个层级；优质由公开指标计算，精选必须记录人工运营决策。
- [ ] listing/release 连续资格使用不可变 eligibility epochs；hard gate 可见状态与 epoch/revision/gate digest 同事务提交，目录在 digest 未对齐时 fail-close，因此下架、阻断与恢复不会短暂沿用旧 14/7 天或 QUALITY；评分按 factWatermark 前 append-only revision 重放。
- [ ] current release 的 7 天观察期从 current pointer 生效时间计算；同日人工重算通过 fact watermark/computation revision 生成新快照并由 listing CAS 指向最新成功结果。
- [ ] 市场首页提供精选、分类热门和近期优质推荐区，不基于隐式用户画像做个性化排序。
- [ ] 每笔内部余额购买按订单创建时的平台分成比例记账，卖家收入经过 7 天待结算；退款在结算前撤销权益并保持账本守恒。
- [ ] Web/desktop 从 M2 起只收发 opaque string priceVersion/expectedPriceVersion，内部 Int priceRevision 不出 API；LEGACY/V2 事务遇到版本变化都零业务写并刷新。所有已接受 idempotency key（包括 ACTIVE 权益早返回）绑定不可变结果，退款后迟到重放不会变成新订单。
- [ ] settlement-v2 cutover 使用 DB-backed DRAINING/mode/generation fence；旧实例与在途 legacy writer 收口后重跑增量 backfill并要求 pre-cutover version/status 零 null及对账一致，才允许激活。激活后故障 fail-close/PAUSED 而不回退即时卖家入账，PAUSED 仍可读取既有退款 cohort且不会批量降级质量。
- [ ] 每个新订单的购买、结算和退款都有不可变平衡分录：购买为买家 debit + 清算 credit，结算为清算 debit + 卖家/platform credit，退款为清算 debit + 买家 credit；任意已提交动作按 orderId/action 汇总借贷净额为 0。
- [ ] 卖家可以查看订单、分成、待结算、已结算、退款和日对账单；限时折扣与精选活动具有开始/结束时间和可追踪来源。
- [ ] 至少一个端到端参考场景覆盖：发现并获得 A 图片、B 视频、C 配乐插件的权益，按团队策略授权其导出能力，将它们组合为受限 DAG，在云端定时执行、传递中间制品并写入团队共享状态。
- [ ] 涉及资金、权限、跨租户数据和远程执行的失败路径均有审计、幂等、恢复与回滚验证。
- [ ] 所有子任务完成最终质量检查后，由父任务执行跨域集成验收并归档。

## Constraints

- 本任务处于规划阶段；父任务本身不直接承载实现代码，也不得在规划未评审前启动子任务实现。
- 保留现有 v4 package/release/review/listing 及桌面安装账本作为兼容基线。
- 资金、远程执行、跨插件调用、Web 沙箱与团队共享数据属于高风险边界，必须先确定威胁模型和回滚边界。
- 产品需要分阶段交付；八项能力不应被视为一个不可拆分的大版本。

## Out of Scope

- 重写现有 07-13-plugin-dev-sdk 任务或将本任务直接并入该任务。
- 在产品边界、分期和验收尚未确认时直接实现八项能力。
- 完整 CRDT 编辑器、任意第三方支付渠道、真实提现与税务发票、任意上传代码的云端托管执行，以及黑盒个性化推荐。
- 首版团队策略的 break-glass、临时豁免申请、二次审批和自动过期流程。
- 首版优惠券、联盟返利、订阅、复杂促销叠加、webhook、业务事件触发和自定义 cron。

## Planning Status

- 产品范围已按推荐方案收敛，无阻塞性开放问题。
- 八个子任务的 PRD、design.md 与 implement.md 已完成，并经过两路跨任务一致性审查与修正。
- 所有规划产物统一提交用户评审；评审前不启动父任务或任何子任务实现。

## Notes

- 2026-07-15：根据用户原始八项需求创建父任务并进入需求探索。
- 2026-07-15：用户接受三阶段路线：平台内核 → 分发体验 → 商业协作。
- 2026-07-15：用户确认工作流是多个插件能力或子工作流的组合；接受由开发者或 AI 创建器生成受限 DAG、普通用户配置和运行的首发体验。
- 2026-07-15：用户采用严格节点数据契约：具名 action、版本化 JSON Schema、平台 ArtifactRef、显式字段映射和显式转换节点。
- 2026-07-15：用户接受工作流发布时冻结精确插件 release/sha/action 契约，兼容更新通过建议与新工作流版本升级，不静默替换。
- 2026-07-15：用户接受新增高风险能力默认拒绝，由团队管理员显式开启；现有 v4 本地安装与运行保持兼容默认。
- 2026-07-15：用户采用分层策略优先级：平台与团队设上限，用户可覆盖角色，工作流只能收窄，同级 deny 优先，Owner/Admin 无隐式绕过。
- 2026-07-15：用户要求简化团队治理；首版取消独立临时豁免和审批机制，Owner/Admin 直接修改允许项并保留审计。
- 2026-07-15：用户确认一个插件可暴露多个具名 action，工作流节点一次调用一个 action，单功能插件使用默认 action。
- 2026-07-15：用户确认首版工作流仅支持顺序、并行和失败自动重试，重试失败后停止；循环、复杂条件与人工审批延后。
- 2026-07-15：用户确认只有全部节点均为 cloud-capable 的工作流才能离线或定时运行；含本地 action 的工作流仅限桌面手动执行。
- 2026-07-15：用户确认首版 cloud 触发器仅包含手动、单次、每日和每周计划并支持选择时区；webhook、业务事件与自定义 cron 延后。
- 2026-07-15：用户确认首版共享数据仅为团队级、按插件命名空间隔离的 JSON KV；大文件使用 ArtifactRef，实时协作能力延后到 Milestone 3。
- 2026-07-15：用户确认 Web 端按 runtime 分流：client 沙箱预览、cloud action 登录限额试跑、本地 Node.js/Python 展示示例并引导桌面端。
- 2026-07-15：用户确认市场首版采用已上架、优质、精选三层质量体系，以及人工精选、分类热门、近期优质三类非个性化推荐。
- 2026-07-15：用户授权后续全部采用推荐方案，不再逐项提问，完成规划后统一提交判断。
- 2026-07-15：推荐方案采用内部余额结算、默认 20% 平台分成、T+7 待结算、7 天退款、限时折扣与精选活动；不接真实支付提现。
- 2026-07-15：两路只读集成审查未发现 P0；已将授权单一事实源、资金守恒、质量 cohort、工作流/调度收口、Web 沙箱和 realtime 续传等 P1 纳入规划契约。
- 当前结论来自代码、文档、历史任务与本地会话记录的只读盘点；尚未开始实现。
