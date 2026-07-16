# 市场结算与营销技术设计

## 1. Design Summary

本设计不引入第二套团队钱包。`Team.balanceCents` 继续是团队可用余额，`BalanceLedger` 扩展为同时记录团队与两个受限平台 CNY 账户的守恒 journal；`Purchase` 扩展为订单与待结算事实，`PluginEntitlement` 扩展为当前许可状态。

```text
购买：买家 Team.balanceCents - gross / BUYER_PURCHASE_DEBIT
      + 平台清算账户 + gross / PLATFORM_PURCHASE_CLEARING_CREDIT
      + Purchase(PENDING_SETTLEMENT, split snapshot)
      + PluginEntitlement(ACTIVE)

T+7：平台清算账户 - gross / PLATFORM_SETTLEMENT_CLEARING_DEBIT
      + 卖家 Team.balanceCents + sellerShare / SELLER_SETTLEMENT_CREDIT
      + 平台收入账户 + platformShare / PLATFORM_SETTLEMENT_CREDIT
      + Purchase(SETTLED)

退款：平台清算账户 - gross / PLATFORM_REFUND_CLEARING_DEBIT
      + 买家 Team.balanceCents + gross / BUYER_REFUND_CREDIT
      + PluginEntitlement(REVOKED)
      + Purchase(REFUNDED)
```

每个箭头以 CREDIT 为正、DEBIT 为负求和：购买、退款和结算动作各自净额为 0。平台账户不是 Team、没有 membership，也不暴露通用余额调整入口。卖家待结算仍是订单状态聚合，卖家已结算才进入 `Team.balanceCents`。

## 2. Current Path And Service Boundary

当前 `PluginRegistryService.purchase()` 已完成 v4 listing/release gate、order-first 并发 claim、买家原子扣款、卖家即时全额入账、双 BalanceLedger、审计和 entitlement 单事务。实现时：

- 抽取 `MarketplaceCommerceService` 承担 price resolution、purchase、refund、settlement 和 statement，避免继续扩大已超过 1000 行的 registry service。
- `PluginRegistryController` 保留现有 purchase URL 并委托 commerce service，旧客户端路径不变。
- `MarketplaceService`/`EconomyService` 和 legacy wallet controller 不参与新流程，仍保持 upgrade response。
- listing/release access 复用 registry 的共享 gate helper，不复制一套“是否可购买”条件。

## 3. Money Contract

### 3.1 Units and split

- 所有许可金额为 CNY cents，Prisma `Int`，请求 DTO 只接受安全整数范围内非负数。
- 分成使用 `feeBps`，范围 `0..10000`，默认 `2000`。
- `platformAmountCents = floor(grossCents * feeBps / 10000)`。
- `sellerAmountCents = grossCents - platformAmountCents`。
- multiplication 在 JavaScript 中先验证不会超过 `Number.MAX_SAFE_INTEGER`；业务价格另设合理上限，数据库与 DTO 一致。

平台费率保存在现有 `PlatformSetting` 的 `marketplace.platform_fee_bps`，读取 helper 在缺失时返回 2000、非法值 fail closed 并告警。修改使用 `platform.setting.manage`，校验后写设置与 AuditLog。订单只依赖冻结的 `platformFeeBps/platformAmountCents/sellerAmountCents`，不在报表阶段重新读设置。

### 3.2 Balance ledger linkage

新增 `MarketplacePlatformAccount`，只允许两个由 migration 以稳定 key 初始化的 CNY singleton：

- `MARKETPLACE_CLEARING`：持有 settlement-v2 未终态订单的 gross；购买 CREDIT，退款/结算 DEBIT。
- `MARKETPLACE_REVENUE`：只在订单结算时按冻结 platform share CREDIT。
- 字段为 `id`, `kind @unique`, `currencyCode='CNY'`, `balanceCents`, timestamps；没有 team/membership relation，commerce service 之外没有 mutation API。

新增 `MarketplaceCommerceState(id='singleton', writerMode, writerGeneration, settlementV2ActivatedAt?, timestamps)`。mode 为 `LEGACY|DRAINING|SETTLEMENT_V2|PAUSED`，generation 单调。M2 dark foundation 初始化 LEGACY；所有兼容 legacy/v2 purchase writer 必须在同一事务锁定该行并校验 mode/generation。cutover 先停入口并 CAS LEGACY -> DRAINING、下线旧二进制/等待 in-flight 事务，再以 DRAINING -> SETTLEMENT_V2 + generation++ + `settlementV2ActivatedAt=databaseNow()` 单事务切换。激活时间只写一次；PAUSED 仅 fail-close 新付费购买，不回到 LEGACY，也不停止既有 settlement/refund reader/writer。质量 port 以 activatedAt 是否存在区分“从未启用”和“V2 已启用但暂停入口”：LEGACY/DRAINING 或无 activatedAt 为 DATA_UNAVAILABLE，activated PAUSED 继续还原既有 cohort，真实读取故障抛错而不伪装 unavailable。

扩展 `BalanceLedger` 作为共同 journal：

- 可选 `purchaseId` relation。
- `teamId` 对新平台分录可空，新增可选 `platformAccountId`；settlement-v2 分录必须恰好绑定其中一个账户，应用校验和 provider-specific migration constraint/trigger fixture 均验证 XOR。
- 可选 `marketplaceEntryKind`: `BUYER_PURCHASE_DEBIT | PLATFORM_PURCHASE_CLEARING_CREDIT | BUYER_REFUND_CREDIT | PLATFORM_REFUND_CLEARING_DEBIT | PLATFORM_SETTLEMENT_CLEARING_DEBIT | SELLER_SETTLEMENT_CREDIT | PLATFORM_SETTLEMENT_CREDIT`。
- unique `(purchaseId, marketplaceEntryKind)`；新市场分录两列均非空，legacy/admin/consume 分录保持 null。

`reason` 保留用户显示兼容值。业务幂等、守恒和对账使用结构化 kind/unique，不解析 reason 字符串。journal 以 `direction=CREDIT` 为正、`DEBIT` 为负；每次状态事务先验证期望分录集合和净额 0，再原子更新对应 Team/platform account balance 与全部分录。清算账户借记使用条件更新防止负数。`PLATFORM_SETTLEMENT_CREDIT` 即使冻结平台金额为 0 也保留结构化零额行，确保结算分录集合可完整验证。

`TeamCredit/CreditLedger` 不加入任何 relation、事务或 reconciliation；它们的 Float 灵石金额不能参与 CNY cents 守恒。

## 4. Data Model

### 4.1 Purchase as marketplace order

在现有 Purchase 上 additive 增加：

- `releaseId?`, `sellerTeamId?`，新 v4 订单必填，legacy 可空。
- `currencyCode='CNY'`。
- `listPriceCents`, 现有 `priceCents` 继续表示实付 gross，`discountAmountCents`。
- `platformFeeBps`, `platformAmountCents`, `sellerAmountCents`。
- `settlementVersion: LEGACY_V1 | SETTLEMENT_V2`；新 writer 固定写 V2，backfill 固定写 legacy，质量层不得从 nullable 字段或 ledger reason 推断版本。
- `priceRevision Int`, `priceVersion String`, `discountId?`, `discountRevision?`, `campaignId?`, `attributionKind`。`priceRevision` 是下单时内部 listing revision；`priceVersion` 是客户端看到并回传的 opaque API token，两者不得互换。
- `status`: `PENDING_SETTLEMENT | REFUND_REQUESTED | SETTLED | REFUNDED`。
- `settleAt`, `refundableUntil`, `settledAt`, `refundedAt`, `refundedByUserId`, `refundReason`。
- `idempotencyKey?` 仅作订单关联投影；业务唯一与早返回结果由独立 MarketplacePurchaseIdempotency 拥有。

移除现有 unique `(packageId,buyerTeamId)`，改由 ACTIVE entitlement 做业务 claim，使退款后可以新建订单。`pluginId` legacy purchase 继续保留；所有新订单只写 `packageId`。

`releaseId` 是下单时 listing 的精确 current release。后续 approve 新版本、下架或撤回不修改历史订单。

### 4.1.1 Purchase idempotency

新增不可变 `MarketplacePurchaseIdempotency`：`id`, `buyerTeamId`, `key`, `packageId`, `requestDigest`, `resultKind=ENTITLED_EXISTING|ORDER_CREATED`, `purchaseId?`, `entitlementId`, `responseJson`, timestamps；unique `(buyerTeamId,key)`，记录随订单/权益历史保留，不因退款删除。

每个带 key 的请求在 Serializable transaction 内、任何 ACTIVE entitlement 早返回之前创建/claim 该记录。同 key + 同 request digest 返回冻结 response；package/body 不同返回 `marketplace_idempotency_conflict`。ACTIVE entitlement 分支也提交 `ENTITLED_EXISTING` 结果，因此未来退款后迟到重放仍返回原结果且不进入扣款；真正重新购买必须使用新 key。旧客户端无 key 继续只享有当前 ACTIVE entitlement 幂等，不承诺退款后的迟到重放。

### 4.2 PluginEntitlement lifecycle

增加：

- `status: ACTIVE | REVOKED`，默认 ACTIVE。
- `activatedAt`, `revokedAt`, `revokedByPurchaseId?`, `revokedReason`。
- `(teamId,packageId)` 唯一保持不变。

`purchaseId` 表示当前/最近一次授予该权益的订单。退款时 entitlement 保留但标记 REVOKED；重新购买时 CAS 更新同一行到 ACTIVE 并指向新订单。所有 download/runtime access 查询显式要求 ACTIVE；不得继续用 `count()` 忽略状态。

### 4.3 Refund request

新增 `MarketplaceRefundRequest`：

- unique `purchaseId`，一订单最多一个首版申请。
- `requesterUserId`, `buyerTeamId`, `reason`, `requestedAt`。
- `status: PENDING | APPROVED | REJECTED`。
- `reviewedByUserId`, `reviewedAt`, `reviewReason`。

申请内容限制长度并作为业务数据保存；结构化日志和普通 AuditLog metadata 只保存 request/order ID 与状态，不复制完整文本。

### 4.4 Discount

新增 `MarketplaceDiscount`：

- `id`, `packageId`, `revision Int default 1`, `priceCents`, `startsAt`, `endsAt`；开始前每次成功更新原子递增 revision，取消保留最后 revision并通过 listing priceRevision 使公开 token 变化。
- `createdByUserId`, `createdAt`, `canceledAt`, `canceledByUserId`。
- 可选 `updatedAt`；开始前允许更新，开始后只允许取消。
- 索引 `(packageId, startsAt, endsAt)`。

跨 PostgreSQL/MySQL 不依赖 exclusion constraint。创建/更新在 Serializable transaction 中查询所有未取消且相交时间段，并在 listing `priceRevision` 上 CAS；并发写冲突重试耗尽映射为 409。

### 4.5 Featured campaign

新增：

- `MarketplaceCampaign(id, slug unique, name, description, startsAt, endsAt, status=DRAFT|PUBLISHED|CANCELED, createdBy, publishedBy, timestamps)`。
- `MarketplaceCampaignItem(campaignId, packageId, rank)`，unique `(campaignId,packageId)` 与 `(campaignId,rank)`。

活动发布后清单/时间冻结，只能取消；需要调整时复制为新活动。它与 listing `featured*` 质量字段无 relation，不改变 `MarketplaceQualityTier`。

### 4.6 Listing pricing projection

`MarketplaceListing` 在 M2 dark foundation 增加仅供服务端并发控制的 `priceRevision Int default 1`，基础价和任何 pricing mutation 原子递增。公开 contract 从 M2 第一版开始始终使用 `priceVersion: string`，不得先返回 number 再在 M3 改型。`priceCents` 继续是基础价数据库事实；API projection：

- `listPriceCents = listing.priceCents`。
- `effectivePriceCents = 当前有效 discount.priceCents ?? listPrice`。
- 兼容 `priceCents = effectivePriceCents`。
- `priceVersion = "pv1." + base64url(sha256(canonical({ priceRevision, activeDiscountId, activeDiscountRevision, windowPhase })))`；它是 opaque string，不暴露或接受客户端构造的数据库 revision。M2 没有 discount 时 canonical 值仍包含显式 `activeDiscountId=null, activeDiscountRevision=null, windowPhase=BASE`，因此与 M3 保持同一类型/算法版本；M3 在开始/结束边界即使无写事务也因 phase 改变而得到新 token。
- 可选 discount 摘要、campaign attribution token。

订单事务重新读取 listing/discount并用共享 resolver 重算 opaque priceVersion，不信任目录缓存、客户端提交的金额或数据库 revision。新客户端 `expectedPriceVersion: string` 不匹配时返回 `marketplace_price_changed` 且在 entitlement/idempotency/资金/订单写入前零业务写；旧客户端省略时按当前服务端价格兼容执行。Purchase 冻结本次内部 `priceRevision` 与公开 `priceVersion` token，用于审计而不在后续重新计算。

该 resolver、公开 priceVersion contract、purchase DTO 校验和 LEGACY writer 的事务内重算属于 M2 dark foundation：LEGACY 下已接受请求仍执行原资金路径，只有携带 stale expectedPriceVersion 的新客户端请求在任何业务写之前被拒绝。M3 复用同一 resolver并只增量加入 discount/window facts，不迁移字段类型。

## 5. Purchase Transaction

### 5.1 Request contract

现有 route 扩展为：

```text
POST /api/plugin-packages/:id/purchase
Idempotency-Key: optional for legacy, required by new clients
body: { expectedPriceVersion?: string, attributionToken?: string }
```

响应保留 `{ entitled, entitlementId, purchaseId }`，新增 order summary。免费 listing 继续返回无财务订单的 entitled result。

### 5.2 Serializable flow

1. 解析当前用户/团队；规范化幂等键并计算包含 package/body 的 request digest。已有 MarketplacePurchaseIdempotency 时按 digest 返回冻结结果或 conflict。
2. 开启 Serializable transaction，锁定 MarketplaceCommerceState；只有 SETTLEMENT_V2 接受新付费购买，DRAINING/PAUSED fail-close，generation 在提交前复核。
3. 重新读取 listing、current release、package、ACTIVE/REVOKED entitlement、有效 discount 和 fee setting，重算 effective price、内部 priceRevision 与 opaque priceVersion。
4. 验证 package 非本团队、listing/release/current pointer/安全政策、基础价和折扣仍有效；新客户端 expectedPriceVersion 不匹配时抛 `marketplace_price_changed` 并零写。
5. 带 key 请求先 claim MarketplacePurchaseIdempotency。ACTIVE entitlement 已存在时写 `ENTITLED_EXISTING` 冻结 response 后提交，不移动资金；unique 冲突读取已提交记录。
6. 计算 list/discount/gross/split；校验归因 token，只冻结仍活动且含该 package 的 campaign。
7. 创建 `settlementVersion=SETTLEMENT_V2` 的 PENDING_SETTLEMENT Purchase，冻结内部 priceRevision 与 opaque priceVersion，`settleAt=refundableUntil=createdAt+7d`。
8. 创建 entitlement，或 `updateMany(status=REVOKED)` 抢占并激活；claim 失败抛 conflict，让事务回滚。
9. `Team.updateMany(id=buyerTeamId,balanceCents>=gross)` 原子扣款，count=0 抛 insufficient balance。
10. 原子增加平台清算账户 gross，并创建 BUYER_PURCHASE_DEBIT + PLATFORM_PURCHASE_CLEARING_CREDIT 两条 ledger；写 `ORDER_CREATED` idempotency result、PURCHASED metric event和 AuditLog。两条分录净额非 0 或任一写入失败则事务回滚。
11. 提交前复核 writer generation 未变；提交后发卖家“新订单待结算”通知，通知失败不回滚订单。

并发无 entitlement 时由 `(teamId,packageId)` unique 决胜；REVOKED entitlement 由 expected-status updateMany 决胜。P2002/P2034 只在确认另一事务已提交 ACTIVE entitlement/同幂等订单后转换为幂等成功，否则返回 409，不吞未知数据库错误。

## 6. Refund State Machine

### 6.1 Request

`POST /api/plugin-purchases/:id/refund-request` 复用 `team.plugin.install` 权限：

1. 校验订单 buyerTeamId 为当前团队、status=PENDING_SETTLEMENT、`now < refundableUntil`。
2. 在同一事务 create refund request 并 CAS order `PENDING_SETTLEMENT -> REFUND_REQUESTED`。
3. unique purchaseId 使响应丢失后的重复申请返回原 request。

申请在期限内成功后不因管理员稍后处理而失效。`REFUND_REQUESTED` 不进入 settlement job。

### 6.2 Admin approve

`POST /api/admin/marketplace/refund-requests/:id/approve` 需要新权限 `platform.marketplace.refund`：

1. Serializable transaction 读取 PENDING request 与 REFUND_REQUESTED order。
2. CAS request PENDING->APPROVED 和 order REFUND_REQUESTED->REFUNDED；只有全部 expected state 命中才继续。
3. 买家 Team.balanceCents increment gross，同时条件扣减平台清算账户 gross。
4. 创建 BUYER_REFUND_CREDIT + PLATFORM_REFUND_CLEARING_DEBIT；两条补偿分录净额必须为 0。
5. CAS entitlement `ACTIVE + purchaseId=order.id -> REVOKED`；不匹配视为不变量破坏并回滚。
6. 写包含 order ID、SETTLEMENT_V2 和审核时间的 REFUNDED metric 与 AuditLog。
7. 提交后通知买卖双方。

平台/卖家份额从订单状态聚合中冲正，不需要扣卖家余额或平台收入，因为两者尚未入账；清算账户补偿借记关闭购买时的清算贷记。

### 6.3 Admin reject

在同一事务 CAS request PENDING->REJECTED、order REFUND_REQUESTED->PENDING_SETTLEMENT 并写审计。若 `settleAt` 已到，下一次 job 立即处理。拒绝不修改余额、ledger 或 entitlement。

## 7. Settlement Job

`MarketplaceSettlementService` 使用持久化订单状态而不是内存任务：

- 服务启动后立即补跑，并每 60 秒轮询最多 100 个 `PENDING_SETTLEMENT AND settleAt<=now` 订单 ID。
- 每个订单独立 Serializable transaction：先 `updateMany(expected status/due)` CAS 到 SETTLED，再条件扣减平台清算账户 gross、给冻结 sellerTeamId increment sellerAmount、给平台收入账户 increment platformAmount，并创建 PLATFORM_SETTLEMENT_CLEARING_DEBIT + SELLER_SETTLEMENT_CREDIT + PLATFORM_SETTLEMENT_CREDIT。三条分录净额必须为 0；任一步失败整笔回滚。
- 多实例会读到相同候选，但只有一个 CAS count=1；其他实例跳过，不把 expected conflict 当错误。
- `REFUND_REQUESTED`、REFUNDED、SETTLED 永不入队。
- 提供使用同一 service 的受保护 admin trigger 和 CLI `settle-marketplace-orders`，用于恢复/运维，不复制业务逻辑。
- 结构化 job summary 记录 scanned/settled/skipped/failed/duration/oldestOverdue；管理端只读查询 status，不从日志文本解析。

不需要长事务锁整批订单，也不依赖进程内 timer 保证持久性；timer 只是触发器，订单表是队列事实。进程停机不会丢任务。

## 8. Seller Statements

`MarketplaceStatementService` 只读 Purchase 与关联 package：

- seller scope 固定 `sellerTeamId=currentTeamId`，后端不接受任意 seller team query。
- summary 使用同一 where 聚合 gross/discount/platform/seller，并按 status 划分 pending、refundReview、settled、refunded。
- daily 输出 orderCreated/refundApproved/settled 三种日期维度的 counts/amounts，避免把销售日和到账日混为一个字段。
- request 传 IANA timezone；服务端把自然日边界转换为 UTC，默认当前团队用户时区或 UTC，最大 90 天。
- items 服务端分页并使用 whitelist select，不返回买家成员身份或内部退款备注。

接口：

- `GET /api/teams/current/marketplace-statement?from&to&timezone&packageId&status&page&pageSize`，需要 `team.balance.view`。
- `GET /api/teams/current/marketplace-statement/daily?...`，同权限。
- buyer 订单/退款状态使用 `GET /api/teams/current/plugin-purchases`，只返回当前团队。

待结算不另存 aggregate balance；所有 summary 可从订单重建。高流量后再考虑可校验 projection，不在首版双写余额。

## 9. Discounts And Price Concurrency

### 9.1 Author APIs

Discount/campaign schema and readers may dark deploy before cutover, but mutation routes, effective-price marketing projection and attribution consumption all lock MarketplaceCommerceState and require `writerMode=SETTLEMENT_V2` plus their feature flag. LEGACY/DRAINING/PAUSED fail-close and expose only the M2 base-price projection, so no discounted order can use legacy immediate seller credit.

- `PATCH /api/plugin-packages/:id/marketplace-price`：更新基础价，`team.plugin.edit_price`。
- `POST /api/plugin-packages/:id/discounts`：创建折扣。
- `PATCH /api/plugin-discounts/:id`：仅开始前更新。
- `DELETE /api/plugin-discounts/:id`：取消。

所有 mutation 验证 ownerTeam、active paid listing、时间/金额、重叠，并 increment listing.priceRevision。基础价更新遇到会失效的 active/scheduled discount 返回 409，提示先取消。

### 9.2 Effective price

目录读取当前时刻满足 `startsAt<=now<endsAt && canceledAt=null` 的唯一折扣。购买事务重新解析；即便客户端显示折扣但下单时已过期，也按当时基础价创建订单并在响应返回实际快照。新客户端提交前显示价格确认；服务端绝不接受客户端 price。

## 10. Featured Campaign And Attribution

### 10.1 Admin lifecycle

- draft 可编辑名称、说明、UTC 时间和最多 100 个有序 package。
- publish 在事务内复核所有 listing 活动并冻结版本；后续 listing 失效时查询过滤，不修改 campaign 历史。
- published 只能 cancel；取消后不再签发 attribution token，历史订单保留 campaignId。
- 使用 `platform.plugin.edit`；所有 publish/cancel 审计。

### 10.2 Attribution

活动页/section 为每个 package 签发短期 HMAC token，包含 `campaignId, packageId, exp, nonce/version`，不包含用户画像。购买 service 验签并重新校验 campaign 时间/status/membership：

- 有效则冻结 campaignId/`CAMPAIGN`。
- 缺失、过期、篡改或活动失效则按 ORGANIC；不改变 effective price、split 或 entitlement。
- 同一订单只有一个 campaign attribution；折扣 ID 独立冻结。

首版 campaign 报表从订单按 campaignId 聚合 created/refunded/net counts 与 gross，不做 impression/click 表。

## 11. API And Contract Ownership

在 `packages/contract` 新建 commerce schemas，包含：

- price projection、order/refund/status、statement summary/daily/page。
- discount/campaign request/response。
- money bounds、basis points、UTC datetime 和 stable error codes。

新 controller DTO 在 entry point 验证；service 使用 contract-aligned domain types。desktop/admin helpers集中解码，JSX 不读取 Prisma shape。

Stable errors 至少包括：

- `marketplace_price_changed`
- `marketplace_discount_conflict`
- `marketplace_idempotency_conflict`
- `marketplace_refund_window_closed`
- `marketplace_order_state_changed`
- `marketplace_settlement_pending`

现有 `insufficient_balance/payment_required/conflict/not_found` 语义保持。

## 12. UI Boundaries

### Desktop consumer

- Market list/detail 显示基础价、有效折扣价和结束时间；旧 `priceCents` fallback 可用。
- “购买并下载”继续一次命令，但客户端生成/持久化本次 idempotency key，响应丢失时用同一 key 对账后再下载。
- 订单页显示退款期限、申请状态和许可费用/灵石费用分离说明。

### Desktop seller

- `PublishedPluginList` package detail 增加基础价/折扣管理，开始后的折扣只有取消命令。
- `TeamWallet` 增加待结算/退款审核/已结算摘要和“查看对账单”，不把 pending 加到可用余额大数字。
- 页面继续使用服务端分页和独立错误状态。

### collab-admin

- 新建独立“市场财务”view，按需加载订单/退款申请/job status；不继续扩大 dashboard 或治理 package 首屏。
- 退款详情使用 Sheet，批准/拒绝用原因 Dialog；mutation 409 保留输入并刷新订单/request。
- campaign 管理使用同一 view 的独立 tab，未激活 tab 不请求。
- 导航/View/API helper 遵守 collab-admin app shell 与 async resource spec。

后续 Web plugin center 复用 consumer/order API；本任务不复制结算逻辑到 Web。

## 13. Migration And Compatibility

### 13.1 Staged migration

1. Milestone 2 dark foundation additive 增加 Purchase settlementVersion/refundableUntil/priceRevision/priceVersion、MarketplaceCommerceState(LEGACY,generation)、MarketplaceListing.priceRevision、稳定 string `priceVersion` resolver/DTO 校验及兼容 adapter；字段先允许 legacy null，不切换资金 writer。LEGACY purchase 对携带 expectedPriceVersion 的新客户端先事务内重算，stale 请求零业务写；接受请求与旧客户端保持原资金行为。质量/Web 编译和读取只依赖该已部署 schema/contract。
2. 在 LEGACY mode 部署所有兼容 reader、legacy/v2-aware writer 和 PurchaseIdempotency claim 逻辑；每个 writer 事务都锁定 state mode/generation。确认所有旧二进制实例已下线，writer 尚未开启 V2。
3. 幂等 backfill：
   - v4 package purchase 标记 SETTLED，sellerTeamId=package.ownerTeamId，list/gross/seller=原 price，platformFee=0，platform=0，settledAt=createdAt，settlementVersion=LEGACY_V1。
   - legacy pluginId purchase 保留 SETTLED；无法可靠补 release/sellerTeam 的字段保持 null并只出现在 legacy 管理视图。
   - 不更新 Team.balanceCents/平台账户，不新增/修改 BalanceLedger；legacy 订单不伪造 settlement-v2 守恒分录。
4. 部署兼容 reader 和 backfill 校验后，移除 `(packageId,buyerTeamId)` unique，启用 entitlement status claim；购买入口仍由 DB mode 控制。
5. cutover 前核对订单行数、gross 总额、ACTIVE entitlement 与 purchase 引用、团队余额零变更；入口进入维护并 CAS LEGACY -> DRAINING，等待旧实例心跳消失和最长事务窗口，确认无 in-flight legacy transaction。
6. 在 DRAINING 内再次运行同一幂等 backfill，覆盖首次 backfill 后提交的增量 legacy 订单；随后要求全部 pre-cutover Purchase 的 settlementVersion/status 非 null且为合法 LEGACY_V1/SETTLED 组合，并重新核对 row count、gross、entitlement 引用、Team/platform balance 与 BalanceLedger 零变化。任何 unresolved/null/reconciliation mismatch 都阻止切换。
7. 只有 final backfill/reconciliation gate 成功后才 CAS DRAINING -> SETTLEMENT_V2、writerGeneration++ 并首次写 settlementV2ActivatedAt，然后恢复入口。迟到 legacy/v1 generation writer 事务在 mode/generation gate 失败；后续事故只 SETTLEMENT_V2 -> PAUSED，不清除或后移激活 instant。

### 13.2 Client compatibility

- 现有 market catalog `priceCents` 继续存在并代表 effective price；新字段是 additive。
- 现有 purchase response 字段保留；旧 client 无 Idempotency-Key 时由 ACTIVE entitlement 保证业务幂等。
- 历史 ledger reason 保留；新 seller settlement reason 老客户端即使无中文映射也能显示原始字符串。
- legacy wallet/marketplace controllers 继续 upgrade required。

### 13.3 Rollback

- DB mode=LEGACY 且 cutover 前可回滚 code，additive dark schema 保留；回滚版本也必须理解/锁定 commerce state。
- 进入 DRAINING 后不允许重新部署不识别 generation 的旧 writer；已有 PENDING/REFUND_REQUESTED 后绝不回到即时全额入账。
- 事故时 CAS SETTLEMENT_V2 -> PAUSED 并关闭新购买、discount、campaign mutation；继续运行 settlement/refund reader/writer或使用 CLI drain。
- 修复后以 generation CAS 恢复 SETTLEMENT_V2。不得删除 pending orders、手工把 pending 计入卖家余额或用反向 SQL“补偿”。
- cutover 前即使 discount/campaign 代码已部署也保持 mutation/projection/attribution flags关闭；只有 DRAINING final gate 与 SETTLEMENT_V2 CAS 成功后才逐步开启，关闭营销 flag 只回到基础价投影，不切换资金 writer。

## 14. Invariants And Tests

### 14.1 Per-order invariants

```text
list - discount = gross
platform + seller = gross

PENDING_SETTLEMENT:
  buyer debit = -gross
  clearing credit = +gross
  action net = 0
  seller/revenue ledger = 0
  entitlement = ACTIVE

REFUND_REQUESTED:
  same money state as pending
  settlement ineligible

SETTLED:
  purchase: buyer debit -gross + clearing credit +gross = 0
  settlement: clearing debit -gross + seller credit +seller + platform settlement credit +platform = 0
  clearing lifetime net = 0
  entitlement = ACTIVE

REFUNDED:
  purchase: buyer debit -gross + clearing credit +gross = 0
  refund: buyer credit +gross + clearing debit -gross = 0
  buyer lifetime net = 0; clearing lifetime net = 0
  seller/revenue ledger = 0
  entitlement = REVOKED
```

平台收入账户及 net revenue projection只统计 SETTLED 的 platform amount；PENDING/REFUND_REQUESTED 的 gross 保留在清算账户，REFUNDED 清算归零。对全部 settlement-v2 订单，清算账户余额应等于 PENDING_SETTLEMENT + REFUND_REQUESTED gross 汇总。

### 14.2 Required tests

- 纯函数 property/table tests：金额边界、所有 fee bps、rounding、discount、守恒。
- transaction tests：每个 failpoint rollback，无孤立 order/ledger/entitlement。
- concurrency tests：同/不同 idempotency key purchase、ACTIVE early-result key 在 refund 后迟到重放、REVOKED 新 key repurchase、expectedPriceVersion drift、legacy writer vs DRAINING generation、refund vs settlement、双 job、双 discount。
- migration tests：首次 backfill 后继续写 legacy 增量、DRAINING final backfill、pre-cutover version/status 零 null gate、重复 backfill、零余额/ledger 变化、unique 切换。
- statement reconciliation：按订单算 summary/daily 与 BalanceLedger 重放一致，逐动作借贷净额为 0，清算/收入账户余额等于订单汇总。
- campaign token：合法/过期/篡改/错 package/canceled；任何结果都不影响 server price。
- cross-layer contract、permissions、pagination、timezone/DST tests。
- end-to-end：购买 -> pending -> refund reject -> settle，以及购买 -> pending -> refund approve -> repurchase -> settle。

## 15. Operational Observability

- metrics：purchase success/idempotent/conflict/insufficient、pending amount/count、refund pending age、settlement latency/failures、oldest overdue、ledger invariant violations。
- structured log 使用 order/request IDs，不记录 attribution secret、完整退款原因或 token。
- admin 提供只读 reconciliation 状态与手动 trigger；平台清算/收入账户没有手工 adjustment 路径，现有 team adjust 也不得作为结算补偿工具。
- 定期 reconciliation job 只读比对 order status、完整借贷分录集合、逐动作净额、entitlement、team balance 增量及两个平台账户余额，发现差异告警，不自动造分录。

## 16. Trade-offs

- 待结算从订单聚合而不是单独 balance，首版查询成本略高，但避免双写余额漂移。
- pending refund request 会暂停结算直到管理员处理，保护买家申请时点；代价是平台必须监控最老申请并建立运营 SLA。
- campaign 只做订单归因，不做曝光/点击漏斗，无法计算完整转化率，但数据边界更小且不引入画像。
- 历史订单按原 100% 即时入账保留，平台不会获得追溯分成；这是兼容与账务正确性的必要取舍。
