# 市场质量与推荐实施计划

## Preconditions

- 本任务保持 `planning`，只有用户统一评审并明确要求实施后才运行 `task.py start`。
- 开工前执行 `trellis-before-dev`，重新读取 contract、collab-api、desktop、collab-admin 与 cross-layer spec；若其他平台子任务已改变运行/结算契约，先更新本设计再编码。
- 不复活 legacy `MarketplaceService`/`EconomyService` 路由，不把本机安装 ledger 变成远端事实。

## Phase 0. Baseline And Contract Map

- [ ] 记录基线 git status，确认并保留用户已有改动。
- [ ] 跑相关基线：contract、collab-api、desktop、collab-admin 类型检查及已有 registry tests。
- [ ] 画出 package/release/listing -> metric event -> snapshot -> catalog -> desktop/Web/admin 的字段表，确认每个 payload 只有一个 owner。
- [ ] 与工作流/cloud 子任务核对正式 run/step terminal ID 与失败分类；要求结算 Phase 2A dark schema/MarketplaceCommerceFactsPort 先部署，质量代码不直接 import `settlementVersion/refundableUntil/status` ORM 字段；明确无激活事实、mode LEGACY/DRAINING、legacy、REFUND_REQUESTED 均不可用，activated PAUSED 继续读既有 cohort，事实读取故障抛错而非 DATA_UNAVAILABLE。

Review gate: 无任何 consumer 需要解析 `AuditLog.metadata` 或中文 ledger reason 才能计算质量。

## Phase 1. Shared Contract And Category Owner

- [ ] 在 `packages/contract/src/` 增加 marketplace discovery/quality schema、枚举、reason code、policy projection和分页响应。
- [ ] 扩展 `PluginCatalogItem` 时保留现有字段；新增 category/tier/quality summary 均由 shared schema 定义。
- [ ] 把当前 desktop 分类枚举/确定性 helper 收敛到共享 owner，desktop helper 改为薄适配或删除重复实现。
- [ ] 增加 contract runtime tests：合法/非法 enum、严格响应、百分率整数、旧 catalog payload 兼容。

Validation:

```bash
pnpm -C packages/contract typecheck
pnpm -C packages/contract test
pnpm -C apps/desktop typecheck
```

Rollback point Q1: 纯 contract/category 变更，可独立回退且不动数据。

## Phase 2. Additive Schema And Migration

- [ ] 扩展 `MarketplaceListing` 当前 category/quality/featured/block 投影，并增加 currentReleaseActivatedAt/pointerRevision、listingEligibleSince/releaseEligibleSince/eligibilityRevision/eligibilityGateDigest。
- [ ] 新增 append-only current-release activation 与 listing/release eligibility epoch history；收敛 pointer/listing/review/security/release hard-gate writers，使 gate projection 可见状态与 epoch/since/revision/digest 在同一事务 CAS 提交，不回写旧 history row。跨服务 outbox consumer 也必须原子更新二者，目录 digest 不对齐时 fail-close 为隐藏/LISTED并触发 repair。
- [ ] 新增 metric event、usage session、v4 package rating + append-only RatingRevision、quality snapshot、quality computation 模型及必要 enum/index/unique；snapshot identity 使用 eligibility scope + factWatermark/computationRevision，jobKey 仅在 computation 上 unique。
- [ ] 扩展 Ticket 的 MARKETPLACE category 与 related target 字段。
- [ ] 生成 PostgreSQL canonical migration，并验证 MySQL schema renderer 不破坏 enum/JSON/index。
- [ ] 编写幂等 backfill：现有 listing 分类确定性推导或 OTHER，tier=LISTED，current pointer activation 与 eligibility epochs 从 migration instant 保守起算并写 BACKFILL history；绝不猜旧激活时间或把 legacy 聚合/评分写成 metric event/revision。
- [ ] migration dry-run/fixture 验证行数、默认值和重复运行。

Validation:

```bash
pnpm -C apps/collab-api prisma:validate
pnpm -C apps/collab-api typecheck
pnpm -C apps/collab-api test -- prisma-schema
```

Review gate: migration 只加表/列/索引，不改变 listing status/current pointer、权益和团队余额。

Rollback point Q2: 保留 additive schema，关闭 feature flag；不需要反向破坏性迁移。

## Phase 3. Metric Writers And Ratings

- [ ] 新建集中 `MarketplaceMetricRecorder`，实现同事务写入和 idempotency conflict 读取。
- [ ] 在 v4 purchase/commerce 事务写 PURCHASED；为结算任务提供 REFUNDED internal writer，不解析 BalanceLedger。
- [ ] 质量模块只调用 MarketplaceCommerceFactsPort，不 import Purchase refund/status ORM 字段。M2 dark adapter 在 activatedAt 缺失或 mode=LEGACY|DRAINING 时返回 DATA_UNAVAILABLE；M3 adapter 读取完整 V2 order/refund 历史，activated PAUSED 继续计算，缺失事件不解释为 0，查询/一致性故障抛出 job error。
- [ ] 扩展 artifact download/install receipt：只有 Tauri ledger 成功提交后写一次 INSTALL_SUCCEEDED。
- [ ] 扩展 `runtimeAccess` 签发 marketplace usage session；新增受限 terminal endpoint 和失败分类 pure function。
- [ ] cloud/workflow runtime 通过内部 recorder 写终态，禁止公共任意 event endpoint。
- [ ] 实现 package/team 唯一评分、资格校验、更新与分页公开投影。
- [ ] 每次评分 create/update 同事务追加 MarketplaceRatingRevision(score/revision/source/recordedAt) 和含值 RATING_CHANGED；当前 MarketplaceRating 只做 latest projection。
- [ ] 添加限流、DTO 长度、跨租户 not-found/forbidden 和审计。

Focused tests:

- [ ] 同 idempotency key 重放只一条事件。
- [ ] usage session exact release/SHA/team/user/expiry/单终态矩阵。
- [ ] 用户取消、平台故障与插件归因失败分类。
- [ ] 一团队一评分、作者团队拒绝、付费权益/免费成功运行资格；watermark 前最后 revision 可重放，watermark 后修改不改变旧计算。
- [ ] 退款后评分保留但质量聚合排除。

Review gate: 任意客户端 payload 不能直接增加 count；所有事件都能追溯到 server-issued/business source ID。

Rollback point Q3: 关闭 event issue/report routes；已写 append-only 事件保留。

## Phase 4. Snapshot Evaluator And Discovery Queries

- [ ] 实现 `MARKETPLACE_QUALITY_POLICY_V1` 与纯函数 evaluator，使用 basis points/十分位整数。
- [ ] 实现 30/90 天批量聚合查询，避免逐 listing N+1；记录 query count/EXPLAIN 所需索引。
- [ ] 实现每日 job、启动补跑、单 package admin 重算：固定 factWatermark，daily jobKey 包含 pointerRevision + eligibilityRevision 并独立持久化，成功事务在当前 eligibility epoch 分配单调 computationRevision。
- [ ] listing CAS 同时比较 currentReleaseId/currentReleaseActivatedAt/pointerRevision/eligibilityRevision，并只接受比当前 epoch 更新的成功 `(factWatermark,computationRevision)`；旧/迟到 job 不能回退投影。
- [ ] 实现 featured/block 的 CAS mutation、非空理由、过期回落及审计。
- [ ] 实现 market home 和 paged section queries；所有 query 复用 v4 current release gate。
- [ ] 接入团队策略/兼容过滤 hook；过滤不改变剩余结果的全局相对顺序。
- [ ] 记录 job summary、失败 package 与 stale snapshot 指标，不先清空旧投影。

Focused tests:

- [ ] 每个阈值 `-1/exact/+1` 与样本不足。
- [ ] current release pointer activation 7 天（首次、升级、切回旧 release）、listing 14 天、下架/重上架与 review/security hard-gate 中断/恢复 eligibility epoch、gate visibility/epoch transaction atomicity、digest mismatch fail-close/repair、30/90 天 UTC 边界。
- [ ] settlementV2ActivatedAt 缺失、legacy/null version、factWatermark 时仍为 REFUND_REQUESTED -> DATA_UNAVAILABLE；纯 v2 成熟 cohort 的 0/10 笔与 5% 边界。
- [ ] settlementV2ActivatedAt 存在且 mode=PAUSED 时仍还原既有 cohort；port error 不提交 DATA_UNAVAILABLE snapshot，目录保留上一成功结果并显示 stale。
- [ ] DATA_UNAVAILABLE/INSUFFICIENT_SAMPLE snapshot 成功提交后自动 QUALITY 回落 LISTED；失败 job 才保留上一成功投影。
- [ ] 同一天 current release 切换产生独立 snapshot，新 release 不读取旧 release 的运行/故障样本或 qualifiedAt。
- [ ] 精选到期、质量暂停、安全 hard gate、release 更换观察期。
- [ ] category popular/recent quality/featured 稳定排序与并列。
- [ ] 相同 jobKey 多实例幂等、不同 jobKey 同 watermark revision 单调分配、并发 listing/release activation 更新和 latest-success snapshot CAS。
- [ ] 查询分页、固定 section limit、无重字段/N+1。

Review gate: 相同固定 clock + facts + policy version 得到 byte-equivalent 业务结果；收入字段不进入排序。

Rollback point Q4: `MARKETPLACE_DISCOVERY_V2_ENABLED=false` 回旧 active listing 目录，job 停止但快照保留。

## Phase 5. Transparency, Appeals And Admin

- [ ] 实现 quality policy public endpoint、owner exact snapshot endpoint和 reason projection。
- [ ] 质量申诉调用 TicketService 创建 MARKETPLACE 工单，关联当前 snapshot，并对活动申诉幂等。
- [ ] collab-admin governance Sheet 新增 lazy Quality tab；首屏 package list 不增加事件/快照重字段。
- [ ] 管理动作实现 feature/unfeature、block/unblock、recompute；409 局部刷新并保留原因输入。
- [ ] Tickets view 增加 MARKETPLACE 筛选与关联 package/snapshot 显示，复用原回复/状态流。
- [ ] 权限沿用 `platform.plugin.list_all/edit`，确认后端守卫与 service 校验均存在。

Validation:

```bash
pnpm -C apps/collab-api test -- --testTimeout=60000
pnpm -C apps/collab-api typecheck
pnpm -C apps/collab-api build
pnpm -C apps/collab-admin typecheck
pnpm -C apps/collab-admin build
pnpm -C apps/collab-admin test:e2e
```

Review gate: admin 不能直接写 snapshot/强制 QUALITY；申诉不自动修改 tier。

## Phase 6. Desktop And Web-ready Discovery UI

- [ ] `PluginCenterBody` Market tab 增加搜索、分类、精选、分类热门、近期优质区块，保持 Installed 独立加载。
- [ ] catalog helper 集中 decode discovery response；组件不计算 tier/category/rank。
- [ ] 详情展示 badge、指标摘要、评分与公开规则入口；作者 Published package detail 展示精确缺口和申诉。
- [ ] 处理 loading/empty/error/stale、旧 server 不含新字段、旧 desktop 只读现有 items 的兼容路径。
- [ ] 按现有 UI spec 使用密集列表、稳定高度和语义 token；390px/1440px 无文本/按钮重叠。
- [ ] 向 Web plugin center 子任务提供 contract fixture 和 mock server cases，不在本任务复制 Web 页面。

Validation:

```bash
pnpm -C apps/desktop test
pnpm -C apps/desktop typecheck
pnpm -C apps/desktop vite:build
```

Review gate: 远端 discovery 失败不清空 Installed；不同测试用户的同一 section 顺序一致。

## Phase 7. Cross-layer And End-to-end Verification

- [ ] 跑完整质量门禁。
- [ ] 端到端：上架 -> 合格事件 -> 优质 -> 精选 -> 到期回落 -> block -> 申诉 -> clear/recompute。
- [ ] 反刷：重复 download/install/run/rating、跨团队 session、作者自评、退款权益和 burst block。
- [ ] 并发：双 terminal、双 feature、job 双实例、release 切换、下架与 home query。
- [ ] 性能：市场首页固定 query count，quality batch 无逐 package N+1，必要索引在 PostgreSQL/MySQL fixture 验证。
- [ ] 隐私：consumer payload 不含 team/user/event metadata；日志不含运行输入/输出。
- [ ] 确认 legacy marketplace controllers 仍为 `client_upgrade_required`。

Full gate:

```bash
pnpm -C packages/contract typecheck
pnpm -C packages/contract test
pnpm -C apps/collab-api typecheck
pnpm -C apps/collab-api test -- --testTimeout=60000
pnpm -C apps/collab-api build
pnpm -C apps/desktop test
pnpm -C apps/desktop typecheck
pnpm -C apps/desktop vite:build
pnpm -C apps/collab-admin typecheck
pnpm -C apps/collab-admin build
pnpm -C apps/collab-admin test:e2e
```

## Risky Files And Boundaries

- `apps/collab-api/prisma/schema.prisma` 与 migration：跨 provider enum/index/unique、不可把 legacy count 转成事实。
- `apps/collab-api/src/modules/plugin-registry.service.ts`：文件已超过 1000 行；实现必须抽取 quality/discovery service，不继续堆叠。
- `packages/contract/src/plugin-registry.ts`：保持旧 v4 payload 兼容，新发现契约优先独立模块。
- `apps/desktop/src/pages/plugins/PluginCenterBody.tsx`：Installed 与 remote error 状态不能重新耦合。
- `apps/collab-admin/src/components/governance/plugin-package-sheet.tsx`：新增 lazy tab，避免继续放大单文件和首屏请求。
- Ticket schema/service：只补关联与分类，不改变现有工单状态机。

## Rollback And Operations

- 发布顺序：schema/reader -> event writers -> evaluator shadow mode -> admin/author -> consumer discovery flag。
- shadow mode 至少完成一次全量计算并核对样本与排序后才打开 badge/recommendation。
- 关闭 discovery flag 时回现有目录；关闭 evaluator 不影响事件写入、下载、权益或运行。
- 不删除 snapshot/event 作为回滚手段；修正规则时发布 policy v2 并重算。
- job 监控至少包含 last success、duration、packages evaluated/failed、oldest stale snapshot、jobKey conflicts、latest fact watermark、refund data-unavailable counts 和 blocked anomaly 数。

## Completion Gate

- [ ] PRD 所有 acceptance criteria 有自动化测试或明确的端到端证据。
- [ ] 无开放问题、无 `TBD`、无未审查的 legacy 聚合依赖。
- [ ] 通过 `trellis-check` 后交父任务执行跨子任务 contract/策略/市场集成验收。
