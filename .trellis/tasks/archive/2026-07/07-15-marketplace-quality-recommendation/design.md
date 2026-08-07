# 市场质量与推荐技术设计

## 1. Design Summary

本任务在现有 v4 registry 上增加一条独立但不分叉事实源的发现链路：

```text
v4 listing/release gate
  + 购买/退款事实
  + 服务端签发的运行会话终态
  + 团队去重评分
  + 安全/异常处置
        -> MarketplaceMetricEvent（不可变、幂等）
        -> 每日 MarketplaceQualitySnapshot（规则版本化）
        -> listing 当前质量投影
        -> 精选 / 分类热门 / 近期优质查询
        -> desktop、Web、作者与 admin 视图
```

`PluginPackage`、`PluginRelease`、`MarketplaceListing`、`PluginEntitlement` 继续分别拥有身份、版本、上架和权益真相。质量层只保存指标事件、计算快照与当前投影，不能创建第二套上架状态或授权状态。

## 2. Existing Evidence And Reuse

- `PluginRegistryService.marketplaceCatalog()` 已按 listing current pointer、release 状态、审核与 AI policy 过滤，可作为所有推荐查询的硬门禁入口。
- `runtimeAccess()` 已校验用户当前团队、package、精确 release 和 SHA；它是签发本机运行指标会话的正确位置。
- `PluginEntitlement(teamId, packageId)` 与 `Purchase(packageId, buyerTeamId)` 是团队消费事实，不能退回按用户购买的 legacy 口径。
- `AuditLog` 适合记录人工精选、暂停、恢复和复算动作，但不适合承载高频可聚合运行指标。
- `Ticket` 已有用户/管理员对话、状态、附件、权限和通知；申诉应复用它，只补关联目标，不新增对话表。
- `apps/desktop/src/lib/marketplace-categories.ts` 提供现有分类词表。实现时把分类枚举与确定性分类 helper 收敛到共享 owner，desktop 不再维护独立版本。

## 3. Domain Contracts

### 3.1 Shared enums

在 `packages/contract` 新增市场发现契约并从 barrel 导出：

- `MarketplaceCategory`: `AI | PRODUCTIVITY | DEV | DATA | MEDIA | FILES | NETWORK | SYSTEM | OTHER`。
- `MarketplaceQualityTier`: `LISTED | QUALITY | FEATURED`。
- `MarketplaceMetricKind`: `INSTALL_SUCCEEDED | RUN_SUCCEEDED | RUN_FAILED | RATING_CHANGED | PURCHASED | REFUNDED | SECURITY_BLOCKED | SECURITY_CLEARED`。
- `MarketplaceMetricSource`: `DESKTOP_HOST | CLOUD_RUNTIME | WORKFLOW_RUNTIME | REGISTRY | COMMERCE | SECURITY`。
- `MarketplaceQualityReason`: 稳定的机器码，例如 `insufficient_active_teams`、`failure_rate_high`、`refund_data_unavailable`、`quality_blocked`；UI 使用共享映射显示中文，不能按后端 message 分支。

现有 `PluginCatalogItem` 只做向后兼容扩展，不重命名当前 camelCase 字段。新增独立的发现/质量 payload 使用统一 schema，后端和两个前端均从 contract 导入，不在组件内读取 `unknown`。

### 3.2 Quality policy v1

规则以代码常量 `MARKETPLACE_QUALITY_POLICY_V1` 作为单一事实源，公开接口直接投影同一常量：

```ts
{
  version: 1,
  listingAgeDays: 14,
  currentReleaseActivationAgeDays: 7,
  activeTeams30d: 20,
  observedRuns30d: 50,
  maxFailureRateBps: 200,
  ratingTeams: 10,
  minAverageRatingTenths: 43,
  maturedPaidOrders90d: 10,
  maxRefundRateBps: 500,
  securityLookbackDays: 90,
}
```

百分率统一使用 basis points 整数，平均分使用十分位整数，避免浮点边界在 PostgreSQL、MySQL 和 TypeScript 间漂移。修改阈值必须新增 policy version 并全量重算，不能原地改变历史快照语义。

## 4. Data Model

### 4.1 MarketplaceListing additions

在当前 listing 上增加轻量查询投影：

- `category`，默认 `OTHER`。
- `currentReleaseActivatedAt`：精确 current release pointer 本次开始生效的 UTC instant；任何 pointer 变化（包括切回曾用 release）都在同一事务重置。
- `listingEligibleSince`, `releaseEligibleSince`, `eligibilityRevision`, `eligibilityGateDigest`：只表示所有公开 hard gate 连续成立的当前 epoch；digest 是同事务读取的 listing/release/review/AI/safety/hard-block revision 集合的 canonical hash。任一 gate 失败即清空对应 since 并关闭历史 epoch，恢复时从 databaseNow 新建 epoch。pointer 改变只重置 releaseEligibleSince，真实下架/安全/审核阻断同时重置两者。
- `qualityTier`，默认 `LISTED`。
- `qualitySnapshotId` 与 `qualityQualifiedAt`。
- `qualityBlockedAt/ByUserId/Reason`，表示人工复核暂停；它只阻止自动 `QUALITY`，不改变原始指标。
- `featuredAt/Until/ByUserId/Reason/Rank`，表示当前人工精选。

listing 的 `status/currentReleaseId` 仍是展示硬门禁。`qualityTier` 是缓存投影，目录查询必须先验证 listing/release gate，并确认当前 hard-gate revision 的 canonical digest 等于 `eligibilityGateDigest` 后才读取等级；不一致时 fail-close 为隐藏或 LISTED 并排队修复，不能反过来用等级推断可见性。

新增 append-only `MarketplaceListingReleaseActivation`：`id`, `listingId`, `releaseId`, `activatedAt`, `changedByUserId?`, `source`, `pointerRevision`，unique `(listingId,pointerRevision)`。所有 current pointer writer 通过同一 service，在一个事务追加新 history row 并更新 `currentReleaseId/currentReleaseActivatedAt/pointerRevision`；上一段的结束时间由下一 revision 的 activatedAt 推导，不回写历史行。首轮 migration 无法重建历史，故以 migration instant 为当前 pointer 写 `BACKFILL` activation，保守地重新开始 7 天观察，而不猜测旧发布时间。

新增 append-only `MarketplaceListingEligibilityEpoch(id,listingId,releaseId,kind=LISTING|RELEASE,generation,startedAt,endedAt?,startReason,endReason?,gateSnapshotDigest)`，unique `(listingId,kind,generation)`。listing/status、release current pointer、review/AI/safety/hard-block 的所有写入必须经过同一 eligibility transition service，并在使新 hard-gate 状态对目录可见的同一数据库事务中按 CAS 更新 current since/revision/digest、关闭或创建 epoch；跨服务 outbox 只传递信号，consumer 仍须在单一事务同时提交 gate projection 与 epoch，禁止先恢复可见性后异步修 epoch。质量 job 只读这些事实，不以 listing.updatedAt 或当前 status 猜历史连续性。

### 4.2 MarketplaceMetricEvent

新增 append-only 事件表：

- `id`, `idempotencyKey @unique`。
- `packageId`, 可选 `releaseId`, 可选 `teamId`。
- `kind`, `source`, `occurredAt`, `recordedAt`。
- 受限 `metadata`，只保存错误类别、运行类型等聚合所需字段，不保存输入/输出正文。
- 索引 `(packageId, kind, occurredAt)`、`(teamId, occurredAt)`。

所有 writer 通过一个 `MarketplaceMetricRecorder` 写入。业务事务内已有 Prisma transaction 时复用同一 transaction；重复 idempotency key 返回已存在事件。controller 不提供“提交任意 kind”的公共端点。

### 4.3 MarketplaceUsageSession

本机运行需要一张短生命周期会话表：

- `id`, `packageId`, `releaseId`, `sha256`, `teamId`, `userId`。
- `issuedAt`, `expiresAt`, `completedAt`, `outcome`, `failureClass`。
- 会话绑定 `runtime-access` 已通过的精确 release，默认 24 小时过期。
- `updateMany({ id, completedAt: null, expiresAt: { gt: now } })` 抢占唯一终态；重复或错绑终态返回 409。

`runtimeAccess()` 对 marketplace origin 返回可选 `usageSessionId`。桌面宿主在真实启动/运行终止后上报该 ID；插件 iframe 或脚本不能选择 package/release。cloud/workflow 服务不创建本表，直接以其持久化 run/step ID 作为 metric idempotency key。

### 4.4 MarketplaceRating

新增 v4 package 评分表，替代已停用 legacy `PluginRating` 路径：

- `packageId + teamId` 唯一，一团队一份当前评分。
- 保存 `score 1..5`、受限 comment、`createdById/updatedById`、timestamps。
- 作者团队不可评分；付费 listing 需活动 entitlement，免费 listing 需该团队至少一条成功运行事件。
- 用户修改评分是 update，不增加 rating team 数；每次修改写审计和幂等 `RATING_CHANGED` 事件。
- 退款后的评分记录保留用于历史/申诉；质量聚合按 factWatermark 时刻的 entitlement/refund facts 判断资格，不读取“当前是否 ACTIVE”去改写旧 watermark。

`MarketplaceRating` 只做当前投影。每次 create/update 在同一事务追加 `MarketplaceRatingRevision(id,ratingId,packageId,teamId,revision,score,recordedAt,sourceKind,sourceId,actorUserId)`，unique `(ratingId,revision)`；`RATING_CHANGED` metadata 必须含 revision/score/source，不只写“发生过变化”。evaluator 对每个 team 选择 `recordedAt<=factWatermark` 的最大 revision，再以 watermark 前 append-only entitlement/refund 或免费成功运行事实判断该评分是否合格；不得读取当前评分行还原过去。

### 4.5 MarketplaceQualitySnapshot

新增不可变快照：

- `packageId`, `releaseId`, `currentReleaseActivatedAt`, `listingEligibleSince`, `releaseEligibleSince`, `eligibilityRevision`, `policyVersion`, `factWatermark`, `computationRevision`, `windowStart`, `windowEnd`, `computedAt`；`windowEnd=factWatermark`，pointer/eligibility epoch 必须等于计算开始时 listing 的精确事实。
- 观察期、活跃团队、运行总数/失败数、评分团队/总分、成熟 settlement-v2 订单/退款、legacy/待审核计数、安全与异常标志等明确列。
- `refundMetricState: AVAILABLE | NOT_APPLICABLE | INSUFFICIENT_SAMPLE | DATA_UNAVAILABLE`；只有 AVAILABLE 才保存/判定退款率，其他状态带稳定 reason code。
- `autoQualified`, `reasons Json`；reasons 只含共享 reason code 和实际/阈值数值。
- `computationRevision` 在 `(packageId,releaseId,currentReleaseActivatedAt,eligibilityRevision,policyVersion)` 内单调；unique `(packageId, releaseId, currentReleaseActivatedAt, eligibilityRevision, policyVersion, factWatermark, computationRevision)`。同一 watermark 的独立人工重算可以保留新 revision，不覆盖历史。

listing 只指向与当前 `releaseId + currentReleaseActivatedAt + eligibilityRevision` 匹配、按 `(factWatermark,computationRevision)` 排序最新的成功快照。历史快照用于解释、申诉与规则升级对比，不被重算覆盖。

### 4.6 MarketplaceQualityComputation

调度幂等与 snapshot identity 分离。新增计算请求/结果记录：`jobKey @unique`, `kind=DAILY|MANUAL`, `packageId`, `releaseId`, `currentReleaseActivatedAt`, `pointerRevision`, `eligibilityRevision`, `requestedFactWatermark`, `status`, `snapshotId?`, timestamps/errorCode。每日 key 绑定 policy/date/package/pointerRevision/eligibilityRevision，故同一天切换 current release 或资格 epoch 会生成新计算；手工重算使用命令 request ID。相同 key 重试返回同一 running/terminal record，不分配第二个 computationRevision；不同 jobKey 即使 watermark 相同也可在成功时分配下一 revision。

计算失败只终结 computation row，不创建“失败 snapshot”。因此 listing CAS 永远指向 snapshot success record，而不是 job attempt。

### 4.7 Ticket extension

复用 Ticket：

- `TicketCategory` 增加 `MARKETPLACE`。
- Ticket 增加可选 `relatedType/relatedId`；质量申诉关联 `MarketplaceQualitySnapshot`。
- 质量申诉 API 自动生成标题和上下文，不接受调用者伪造其他 package；通过 snapshot -> package -> ownerTeam 校验作者团队。
- 同一 snapshot 查找 `OPEN/IN_PROGRESS` 工单，存在时幂等返回，不创建第二条活动申诉。

## 5. Trusted Event Flow

### 5.1 Install and run

1. 下载仍走现有精确 release artifact endpoint。
2. Tauri 完成校验、解压和本机 ledger 提交后，使用下载请求产生的短期 receipt 报告 `INSTALL_SUCCEEDED`；失败或重复 receipt 不计数。
3. marketplace 插件运行前现有 `runtime-access` 校验通过并签发 usage session。
4. 宿主报告一个终态。服务端把明确的插件代码/契约/启动故障映射为 `RUN_FAILED`；取消、门禁拒绝、平台服务故障、余额不足等只关闭 session，不写插件失败事件。
5. workflow/cloud 运行用正式 run/step 记录直接写事件，idempotency key 为 `workflow-step:<id>:terminal` 或 `cloud-run:<id>:terminal`。

本机宿主上报不是不可破解的远程证明，但签发、绑定、单终态、团队去重和异常检查能阻止最简单的任意计数与重复提交。公开说明指标是“平台可观察运行”，不声称覆盖永久离线执行。

### 5.2 Purchase, refund and security

- 只有 `Purchase.settlementVersion=SETTLEMENT_V2` 的新购买在订单/权益事务中写可用于退款 cohort 的 `PURCHASED`；事件包含稳定 order ID/version/refundableUntil，不含金额或用户正文。
- 市场结算任务批准退款时在同一事务写对应 `REFUNDED`，质量层通过 order ID/version/status 关联，不解析中文 ledger reason。
- legacy/null version 订单不写成“未退款”事实。`settlementV2ActivatedAt` 缺失或窗口内出现 legacy/未知版本时，evaluator 将退款项标为 `DATA_UNAVAILABLE`。
- 安全服务以 release policy 或人工处置 ID 作为幂等键写 blocked/cleared 事件。
- 已有 legacy 聚合计数不转换为 metric event，避免无法去重的数据污染新等级。

### 5.3 Commerce facts port

质量模块只依赖 settlement owner 提供的 `MarketplaceCommerceFactsPort.getRefundCohort(packageId, factWatermark, window)`，返回 `AVAILABLE` 的规范化 mature/refunded/pending counts 或带 reason 的 `DATA_UNAVAILABLE`。M2 dark implementation 只读取已部署的 MarketplaceCommerceState mode/activatedAt；activatedAt 缺失或 mode=LEGACY|DRAINING 时 unavailable，不引用 Purchase 的 M3-only Prisma 字段。M3 settlement implementation 在完整 schema 上实现 V2 order/refund 历史还原；mode=PAUSED 且 activatedAt 存在仍读取既有 cohort，因为 PAUSED 不是退回未激活。数据源错误/不一致抛出可重试 job error，不返回 DATA_UNAVAILABLE。quality evaluator/controller 禁止 import Purchase refund/status ORM 字段，port contract fixture 保证两阶段可编译替换。

## 6. Evaluation And Ranking

### 6.1 Daily evaluator

`MarketplaceQualityJob` 在启动后和固定 UTC 日界后执行，也提供受权限保护的单 package 重算入口：

1. 为本次 job 固定数据库 UTC `factWatermark`，创建/读取 unique jobKey computation；所有 append-only facts只读 `recordedAt<=factWatermark`，commerce/rating/eligibility 状态按各自 revisions 还原 watermark 时刻，不读取 watermark 之后的当前投影。
2. 读取活动 listings 的轻量 ID/current release/currentReleaseActivatedAt/pointerRevision/eligibilityRevision/eligibilityGateDigest 与两个 eligibleSince 列表；digest 不等于当前 gate revisions 时跳过投影更新并触发 repair。
3. 分页批处理，每个 package 在一个只读聚合阶段计算窗口指标；运行、安装和故障只聚合当前 release，评分、settlement-v2 订单和退款按 package 聚合。
4. 成功时在短事务分配下一 `computationRevision` 并写不可变 snapshot；jobKey 冲突读取原 computation/snapshot，而不是把 jobKey 当 snapshot unique。
5. 以 current release、currentReleaseActivatedAt、pointerRevision、eligibilityRevision/eligibleSince/eligibilityGateDigest、listing 状态为 gate，并只在 digest 与当前 gate revisions 对齐且 candidate `(factWatermark,revision)` 新于当前成功 snapshot 时 CAS 更新 listing pointer/tier。
6. 若当前人工精选有效且无硬门禁，tier=`FEATURED`；否则按 snapshot 得到 `QUALITY|LISTED`。

current release pointer 变化时通过统一 writer 在同一事务保存 activation history、重置 `currentReleaseActivatedAt/releaseEligibleSince/qualityQualifiedAt`、更新 gate digest并进入新的 7 天观察期；即使切回旧 release 也不复用旧 activation。listing 下架或 review/security/release hard gate 中断/恢复时，同一事务关闭/开启 eligibility epochs并更新可见 gate projection；旧快照仍保留，但 digest/revision 不匹配时不能驱动本次 epoch或在恢复窗口短暂展示。

连续时长只按 `listingEligibleSince` 计算 14 天，release 7 天从 `max(currentReleaseActivatedAt, releaseEligibleSince)` 计算；任一 since 为空即不合格。这样 pointer 没变但 hard gate 中断也不会沿用旧观察期。

单 package 失败只记录错误并继续下一项。job 不先清空现有等级，故全局失败时目录继续使用上一份成功快照。管理端显示 `computedAt` 和 oldest stale age。

### 6.2 Failure and refund denominators

- `observedRuns = RUN_SUCCEEDED + attributable RUN_FAILED`。
- `failureRateBps = floor(failed * 10000 / observedRuns)`；不足 50 次先返回数据不足，不计算为 0。
- MarketplaceCommerceFactsPort 的 M3 adapter 将 90 天窗口内 `settlementVersion=SETTLEMENT_V2 && refundableUntil<=factWatermark` 还原为规范化 cohort；`REFUNDED` 计入 numerator，已过申请期限且无活动申请的 PENDING/SETTLED 计入 non-refund denominator，质量 evaluator 不直接查询这些 ORM 字段。
- port 在尚无不可变 `settlementV2ActivatedAt`、writerMode=LEGACY|DRAINING、窗口内存在 legacy/null version paid order，或候选在 factWatermark 时仍为 `REFUND_REQUESTED` 时返回 `DATA_UNAVAILABLE`；evaluator 不计算 rate、不允许自动晋级。writerMode=PAUSED 且 activatedAt 存在仍计算既有 V2 cohort；读取/一致性故障使本次 package/job 失败并保留上一成功投影。
- 仅当数据可用且成熟 cohort 至少 10 笔时，`refundRateBps = floor(refunded * 10000 / maturedOrders)`；不足 10 笔为 `INSUFFICIENT_SAMPLE`。免费 listing 为 `NOT_APPLICABLE`。
- `DATA_UNAVAILABLE` 与 `INSUFFICIENT_SAMPLE` 都是成功、可解释的 snapshot 结果，`autoQualified=false`；其 latest-success CAS 会把原自动 QUALITY 回落到 LISTED（有效人工 FEATURED 仍按独立人工事实展示），而不是无限沿用旧 QUALITY。

### 6.3 Discovery projections

- `featured`: listing 精选有效，按 `featuredRank ASC, featuredAt DESC, packageId ASC`。
- `categoryPopular`: 同分类按 `activeTeams30d DESC, installTeams30d DESC, ratingAverage DESC, packageId ASC`。
- `recentQuality`: 当前自动结果为 QUALITY 或 FEATURED 且 `qualityQualifiedAt >= now-30d`，按 qualifiedAt 倒序。

硬门禁与团队策略过滤在分页前执行，避免返回空洞页。过滤后不计算用户专属 score，剩余结果保持全局相对顺序。收入、折扣、平台分成和营销 campaign 不参与质量或热门排序。

## 7. API Design

### 7.1 Consumer and author

- `GET /api/plugin-registry/marketplace/home?category=`：返回三个有上限区块及规则版本/计算时间。
- `GET /api/plugin-registry/marketplace?section=&category=&page=&pageSize=`：扩展现有目录；无 query 时保持旧客户端 `{ items }` 可消费的默认 all 列表。
- `GET /api/marketplace/quality-policy`：公开规则与等级解释。
- `PUT /api/plugin-packages/:id/marketplace-rating`：创建/更新团队评分。
- `GET /api/plugin-packages/:id/marketplace-ratings?page=`：分页公开评分，不返回 team/user 标识。
- `GET /api/plugin-packages/:id/quality`：owner team 获取精确快照、原因与申诉状态。
- `POST /api/plugin-packages/:id/quality-appeals`：为当前 snapshot 创建/返回活动工单。
- `POST /api/plugin-usage-sessions/:id/terminal`：宿主终态上报，DTO 只接受受限 outcome/failure code。

### 7.2 Admin

- `POST /api/admin/plugin-packages/:id/feature` 与 `DELETE .../feature`。
- `POST /api/admin/plugin-packages/:id/quality-block` 与 `DELETE .../quality-block`。
- `POST /api/admin/plugin-packages/:id/quality-recompute`。
- package governance detail 按需返回最新快照与精选/暂停信息，不把原始事件塞入 package 首屏列表。

精选/质量管理复用 `platform.plugin.edit`；查看复用 `platform.plugin.list_all`。接口仍在 service 内校验 platform admin/permission，不能只依赖按钮隐藏。

## 8. UI Boundaries

### Desktop market

- 在既有 Market tab 内增加搜索、分类和三个不嵌套的区块；Installed/Team 的独立加载语义不变。
- 等级使用 badge，价格/安装按钮仍由原 catalog item 和本机 packageId join 决定。
- 详情显示质量解释、评分与规则入口；加载失败保留 market error，不清空本机 Installed。
- 分类常量和 response 类型从 contract/registry helper 进入，组件不再自行关键词分类或计算 tier。

### Author

- `PublishedPluginList` 的 package detail 增加“质量”按需区块，展示最新快照、缺口、暂停和申诉入口。
- 只显示与当前 package 对应的数据；切换 package 时取消旧请求。

### collab-admin

- 在现有 governance package Sheet 增加延迟加载的 Quality tab，而非扩充 package 首屏重 payload。
- 精选与暂停为明确命令，带原因确认；409 时保留输入并局部刷新 snapshot/listing。
- 申诉继续在现有 Tickets view 处理，MARKETPLACE 分类可筛选并显示关联 package/snapshot。

后续 Web 插件中心直接消费 consumer API，不复制排序逻辑。

## 9. Anti-Abuse And Privacy Boundary

- 质量聚合只读取服务端 writer 产生的枚举事件，不接受自定义 metric kind/count/timestamp。
- `idempotencyKey`、usage session CAS、team/package 唯一评分和按团队聚合是第一层防刷。
- 异常检查只使用平台已有身份、团队成员关系、时间分布和消费/运行一致性；首版不采集设备指纹或跨站追踪。
- 自动异常只设置 `qualityBlocked` 并创建审计，不删除事实、不公开嫌疑身份、不自动封禁用户。
- 精选和手工暂停都必须有非空原因；平台管理员不能直接写 snapshot 数值。

## 10. Compatibility And Migration

1. 在 settlement Phase 2A dark schema/commerce facts port 已部署后，以 additive migration 增加 enum、事件、session、rating revision、snapshot、computation、release/eligibility histories 和 listing 字段；质量模块不直接绑定 M3-only Purchase ORM。
2. 现有 listing category 运行共享确定性分类；无法判断的设为 OTHER。当前等级一律 backfill LISTED；current release 与当前连续 eligibility 都以 migration instant 写 BACKFILL histories，保守重新开始 14/7 天观察。
3. 不把 legacy `installCount/ratingCount/ratingSum` 伪造为可去重事件。上线后的真实窗口逐步积累，因此最初可以没有自动优质，人工精选仍可正常提供发现区。
4. 现有 marketplace response 保留 `package/latestRelease/priceCents/listingStatus/entitled`；新字段可选，旧 desktop 忽略。
5. 功能开关 `MARKETPLACE_DISCOVERY_V2_ENABLED` 关闭时回到现有 active listing 默认目录，忽略推荐投影；事件和快照保留以便恢复。
6. 回滚不删除新表、不把 tier 写回审核状态；禁用 job/新 UI 即可。质量故障不回滚 v4 registry 或权益。

## 11. Failure Matrix

| Failure                                                           | Result                                                                                                   |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| usage session 过期/错绑/重复终态                                  | 409/400，不写 metric，记录受限审计                                                                       |
| listing/current release/pointer 或 eligibility epoch 在计算中变化 | snapshot 可保留，listing CAS 不更新，下一轮重算                                                          |
| 日计算部分失败                                                    | 保留上一快照，继续其他 package，管理端显示 stale                                                         |
| 精选与下架并发                                                    | 目录硬门禁优先；精选记录保留但不展示                                                                     |
| 两个管理员并发精选                                                | listing CAS/updatedAt version 只接受一个，另一方 409 刷新                                                |
| rating 重复提交                                                   | 更新同一 team/package 行，不增加计数                                                                     |
| 申诉重复提交                                                      | 返回同 snapshot 的活动 Ticket                                                                            |
| settlement-v2 无持久化激活事实或窗口含 legacy                     | refundMetricState=DATA_UNAVAILABLE，不计算为 0、不晋级                                                   |
| settlement-v2 已激活且 writerMode=PAUSED                          | 继续还原既有 V2 cohort；事实读取失败则 job 失败并保留上一成功快照                                        |
| cohort 有 REFUND_REQUESTED                                        | 本次成功 snapshot 为 DATA_UNAVAILABLE/autoQualified=false，latest-success CAS 使自动 QUALITY 回落 LISTED |
| 同 jobKey 重试/旧 job 迟到                                        | 重试复用 computation；旧 snapshot 可保留但 listing CAS 不覆盖更新的 watermark/revision                   |

## 12. Validation Strategy

- 纯函数表驱动测试覆盖所有阈值的 `-1 / exact / +1`、分母为零、免费/付费、精选到期和硬门禁。
- 事件 writer 测试覆盖幂等键、跨团队/跨 release、usage session 过期和单终态 CAS。
- 聚合测试使用固定 clock，验证 pointer activation 7 天、30/90 天、settlement-v2/legacy/REFUND_REQUESTED 和失败分类排除项。
- 并发测试覆盖双终态、双精选、listing pointer/activation 更新与快照提交、相同 jobKey 幂等、不同 jobKey revision 分配及迟到快照 CAS。
- contract round-trip 测试确保 server/desktop/admin 不各自定义 tier/category/reason。
- Playwright 覆盖首页三段、分类、空/错/加载态、作者解释/申诉、admin 精选/暂停以及 1440x900、390x844 无横向溢出。
- 端到端覆盖：活动 listing -> 累积合格事件 -> 自动优质 -> 人工精选 -> 精选到期回落 -> 安全阻断停止展示 -> 解除并重算。

## 13. Trade-offs

- 首版用公开阈值和稳定排序，不做复杂权重；相关性不如个性化算法，但可解释、可审计且不引入画像。
- 本机终态是宿主见证而非远程硬件证明；通过服务端签发、单终态、团队去重和异常检查降低刷量，避免为首版引入设备指纹。
- 不导入 legacy 聚合意味着自动优质需要冷启动；这是保持指标可信度的代价，人工精选可承接初期发现体验。
