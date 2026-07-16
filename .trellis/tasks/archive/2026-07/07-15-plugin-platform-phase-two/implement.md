# 插件平台二阶段集成实施计划

## Planning Gate

- [ ] 用户评审父 PRD、集成 design 和八个子任务规划。
- [ ] 不启动父任务；按依赖只启动拥有下一独立交付的子任务。
- [ ] 每个子任务启动前完成 implement.jsonl/check.jsonl、相关 spec 阅读与 task.py start review gate。
- [ ] 共享 contract owner、字段命名、错误码和 feature flag 记录到集成矩阵。

## 0. Contract Charter

- [ ] 冻结 PolicyDecision、InvocationPrincipal、PluginAction、ArtifactRef、WorkflowVersion/Run、SharedNamespace、QualityTier、EffectivePrice 和 PreviewSession 的 owner。
- [ ] 为所有跨层 payload 建立 zod decoder、schemaVersion 和稳定错误码。
- [ ] 搜索并删除/迁移重复 enum、raw payload cast 和 capability 白名单副本。
- [ ] 定义 event envelope、outbox 幂等、requestId/traceId 传播和审计脱敏。
- [ ] Gate 0：contract typecheck/test 与 desktop/collab-api compile 通过后才开始持久化迁移。

## 1. Milestone 1: Platform Kernel

### 1.1 Governance And Action Foundation

- [ ] 启动 07-15-team-plugin-policy-governance，先交付不依赖 action surface 的 core evaluator，统一读取发行状态、权益、团队上限、USER/ROLE grant 和请求范围。
- [ ] 启动 07-15-cross-plugin-action-runtime，定义 PluginAction、含 actionSurfaceSha256 的精确 ActionTarget、ActionSurfaceDigest、InvocationPrincipal、Restricted JSON Schema 与 ArtifactRef。
- [ ] 联合 Gate 1A：冻结 ActionSurfaceDigest 与 governance action adapter 的请求、决定、错误码；governance 不定义 action schema，action runtime 不重复读取授权事实。
- [ ] 先完成 governance action adapter，再完成 invocation runtime，并分别完成两个子任务的质量检查与归档。
- [ ] 集成验证默认拒绝、精确 release/action、schema、immutable artifact parent kind/composite FK、canonical grant/hold uniqueness+live window/no-reopen、WORKFLOW_RUN/SHARED_VALUE/HANDOFF_PENDING lifecycle、request/effect idempotency 分离与各 runtime bridge。
- [ ] Gate 1B：内置 A/B/C action 可在桌面独立调用，越权、循环、类型错和重放全部被拒绝，且每次调用只有一个 evaluator 决定与审计链。

### 1.2 Workflow Core And Desktop Product

- [ ] 启动并完成 07-15-workflow-plugin-platform。
- [ ] Creator/SDK 生成显式受限 DAG，发布冻结精确 action 版本，运行显示 step 状态和输出。
- [ ] 验证 declared SemVer range 被保留但执行只用包含 actionSurfaceSha256 的精确 target；本地运行绑定 DesktopExecutorSession/device inventory hash。
- [ ] 验证串行、并行、最多两次安全重试、FAILING/closing 收口后 FAILED，以及不支持循环/条件/人工审批。
- [ ] Gate 2：A/B/C 参考工作流可在桌面手动运行；root request scope/digest 幂等、ArtifactRef 同 kind 传递、producer terminal-to-step canonical handoff、run result grant retention/revocation、运行账本和失败恢复通过。

### 1.3 Cloud And Shared State

- [ ] 启动 07-15-cloud-plugin-automation，复用 workflow 状态机和 run/step ledger，交付 queue/worker、手动 Cloud 和 schedules。
- [ ] 启动 07-15-plugin-shared-collaboration-state 的 Milestone 1，只交付团队 JSON KV。
- [ ] 验证 endpoint DRAFT -> secret -> verify -> READY、preview ActionInvocation、queue at-least-once 幂等、lease recovery、schedule occurrenceKey 和 DST 行为。
- [ ] 验证 ArtifactRef WORKFLOW_RUN/SHARED_VALUE canonical grant/hold lifecycle、concurrent reconciler single-row/no-reopen、shared schemaVersion、nextValueRevision/generation 防 key 与 namespace delete/recreate ABA、capture-before-list relist、quota/CAS 和跨团队隔离。
- [ ] Gate 3：参考工作流从发现 A/B/C 到 cloud 定时运行、ArtifactRef 传递和 shared summary 全链通过。

## 2. Milestone 2: Distribution

### 2.0 Dark Commerce Foundation

- [ ] 启动 07-15-marketplace-settlement-marketing 只完成 Phase 2A：additive commerce state/compatibility fields、internal priceRevision、稳定 string priceVersion resolver/expectedPriceVersion LEGACY 事务校验与 facts adapter；writerMode 保持 LEGACY，匹配 token/旧客户端的资金与购买行为零变化。
- [ ] Gate 3A：质量/Web 在 foundation schema 上 typecheck，退款事实为 DATA_UNAVAILABLE，catalog/token/DTO/legacy writer 已端到端校验 expectedPriceVersion；stale token 零业务写，不创建 V2 order/ledger。

### 2.1 Quality And Recommendations

- [ ] 启动并完成 07-15-marketplace-quality-recommendation；退款只通过 MarketplaceCommerceFactsPort 读取。
- [ ] 回放审核、运行、评分、故障及可用的 settlement-v2 退款事件生成已上架/优质/精选；legacy/处理中退款保持 data_unavailable。
- [ ] 验证 currentReleaseActivatedAt 观察期、hard-gate visibility + eligibility epoch/revision/digest 同事务、digest mismatch fail-close、fact watermark/revision 重算和 listing CAS 指向最新成功快照。
- [ ] 验证精选、分类热门、近期优质与作者解释/申诉，不启用个性化。

### 2.2 Web Center

- [ ] 启动 07-15-web-plugin-center-preview，先交付独立 apps/web 匿名目录。
- [ ] 依次开启登录 overlay、client sandbox、cloud trial、静态 desktop handoff 和现有基础标价/购买；不依赖活动价、T+7 或退款 API。
- [ ] opaque preview 只接受 origin=null、event.source/contentWindow 匹配、sessionId 与单次 nonce 同时通过的消息；cloud trial 写 ActionInvocation(kind=PREVIEW)。
- [ ] Gate 4：Web/desktop 对同一 listing 的 release、quality、price、entitlement、compatibility 一致。

## 3. Milestone 3: Commerce And Collaboration

### 3.1 Settlement And Marketing

- [ ] 恢复并完成 07-15-marketplace-settlement-marketing 的 Phase 2B+；先 DRAINING/fence 旧 writer，drain 后重跑增量 backfill并要求 pre-cutover version/status 零 null及 reconciliation 通过，再切换 settlement-v2。
- [ ] 迁移既有购买为历史已结算快照，新订单使用 20/80 分成、T+7、7 天退款。
- [ ] 启用限时折扣、精选活动和卖家对账，并将活动价/退款/结算投影接入 Web 与 desktop。
- [ ] Gate 5：并发购买、重复请求、退款、结算与设置变更下，每单 marketplace subledger 借贷净额始终为 0，TeamCredit/CreditLedger 不发生许可资金分录；activated PAUSED 继续提供既有 cohort facts且 quality port 故障不提交批量 DATA_UNAVAILABLE。

### 3.2 Realtime Collaboration

- [ ] 恢复 07-15-plugin-shared-collaboration-state，交付 presence、change subscription 与 revision CAS。
- [ ] 验证 Socket.IO/Redis 多实例、namespace 单调持久 cursor、保留期内 changes-after、游标过期全量 relist、outbox 重放、断线重连和 90 秒 presence 过期。
- [ ] Gate 6：两名团队成员看到一致 shared revision/presence，冲突可刷新重试且无跨团队事件。

## 4. Cross-Domain Verification

- [ ] 双数据库：渲染/迁移并运行 PostgreSQL 与 MySQL contract/service 核心测试。
- [ ] 全仓类型：pnpm -r typecheck
- [ ] 全仓测试：pnpm -r test
- [ ] API build：pnpm -C apps/collab-api build
- [ ] Desktop build/test：pnpm -C apps/desktop vite:build && pnpm -C apps/desktop test
- [ ] Rust：cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
- [ ] Admin：pnpm -C apps/collab-admin build
- [ ] Web：pnpm -C apps/web typecheck && pnpm -C apps/web test && pnpm -C apps/web build
- [ ] Playwright 桌面/移动覆盖 catalog、preview、purchase、workflow、schedule、governance、seller settlement。
- [ ] 安全负向覆盖跨租户、策略绕过、伪造 principal、release 撤回、schema 错误、ArtifactRef execution-kind/revision 越权、preview escape、endpoint 重放。
- [ ] 财务/状态属性测试覆盖账本守恒、run/step 终态、outbox 幂等、schedule 去重、shared revision 单调。
- [ ] 故障演练覆盖 Redis/worker/API 重启、invocation terminal 后 step 映射前崩溃、对象存储超时、cloud endpoint 超时、DB deadlock 和部分回调丢失。

## 5. Integration Review

- [ ] 对照父 PRD 的每条 acceptance criteria，链接到子任务测试证据。
- [ ] 复核 contract owner 矩阵，无重复 schema、枚举、状态机或 UI 本地推导。
- [ ] 复核所有 feature flag、迁移前向兼容、回滚路径和数据保留。
- [ ] 复核日志、审计、metrics 与告警不泄漏 secret/共享值/签名 URL。
- [ ] 对 A 图片 -> B 视频 + C 配乐参考工作流执行完整生产配置 smoke test。
- [ ] 最后一轮运行 git diff --check、secret scan、generated artifact scan 和 Trellis check。
- [ ] 八个子任务分别提交、归档后，父任务只提交集成文档/spec 与必要的最终回归修正。

## Rollback Rules

- Contract 与数据库迁移只前向扩展；回滚通过关闭 consumer/feature flag，不删除已写数据。
- 资金分录只使用补偿记录，不 update/delete 历史账本。
- settlement-v2 writer 切换后不重新启用 legacy 即时卖家入账；营销展示可以回退到基础标价，但 v2 核心不可用时新付费购买 fail-close。
- 已发布 workflow version 不修改；故障 release 通过 deny/revoke 阻止新运行。
- 队列可重放但 step claim/idempotency 防止重复副作用。
- Web、preview、realtime、marketing 可独立关闭，不影响桌面本地运行和已购权益。
