# 市场结算与营销实施计划

## Preconditions

- 本任务保持 `planning`，用户统一评审并明确实施前不运行 `task.py start`。
- 开工前重新运行 `trellis-before-dev`，读取 contract/collab-api/collab-admin/desktop spec 和市场质量任务最终契约。
- 资金改动执行“先不变量测试、再 schema/reader、再 shadow/backfill、最后打开 writer”；禁止直接修改生产余额验证代码。

## Phase 0. Baseline And Reconciliation Fixture

- [ ] 记录工作区、当前 migration、Purchase/Entitlement/Team/BalanceLedger 基线数量和关联关系。
- [ ] 跑现有 registry purchase、economy legacy、team balance、contract、desktop、admin 基线。
- [ ] 建立固定 money clock/Prisma mock fixture，复现当前“买家扣全额、卖家立即加全额”行为，作为 migration 与行为切换对照。
- [ ] 写订单守恒 pure tests（先于业务改动）：split rounding、每个动作的完整借贷集合/净额 0、状态允许分录、非法终态组合。

Validation:

```bash
pnpm -C packages/contract typecheck
pnpm -C packages/contract test
pnpm -C apps/collab-api typecheck
pnpm -C apps/collab-api test -- --testTimeout=60000
pnpm -C apps/desktop typecheck
pnpm -C apps/collab-admin typecheck
```

Review gate: 已确认唯一生产购买入口为 v4 package route，legacy route 继续禁用。

## Phase 1. Contract And Money Primitives

- [ ] 在 `packages/contract` 新增 commerce 模块：money/bps、内部 `priceRevision: Int` 与公开 opaque `priceVersion/expectedPriceVersion: string`、price projection、order/refund/statement/discount/campaign schemas与 stable codes；禁止 API 暴露 revision 或后续 number -> string 改型。
- [ ] 定义平台清算/收入 account kind、完整 marketplace entry kind（含 `PLATFORM_SETTLEMENT_CREDIT`）和 CREDIT/DEBIT signed-delta 守恒 helper；CNY cents 类型不得接受灵石 amount。
- [ ] 实现纯函数 `splitMarketplacePrice`、effective price/window helpers，全部整数运算并验证 safe range。
- [ ] 保留 `PluginCatalogItem.priceCents` 与 purchase response 老字段；新增字段 additive。
- [ ] controller DTO 对齐 contract 的金额、datetime、timezone、分页和原因上限。
- [ ] permission registry 增加 `platform.marketplace.refund`，seed/migration 测试自定义角色不获得隐式新权限。

Validation:

```bash
pnpm -C packages/contract typecheck
pnpm -C packages/contract test
pnpm -C apps/collab-api typecheck
```

Rollback point C1: 纯 contract/permission reader，可独立回退。

## Phase 2A. Milestone 2 Dark Commerce Foundation

- [ ] 先 additive 增加 Purchase.settlementVersion/refundableUntil/priceRevision/priceVersion、MarketplaceListing.priceRevision、MarketplaceCommerceState(writerMode=LEGACY, writerGeneration, settlementV2ActivatedAt) 和只读 MarketplaceCommerceFactsAdapter；不得新增或切换资金分录行为。
- [ ] 在 M2 完成版本化 opaque string priceVersion resolver、catalog projection、expectedPriceVersion DTO 和 LEGACY purchase 事务内重算。新客户端 stale token 在 entitlement/idempotency/资金/订单写入前返回 marketplace_price_changed且零业务写；接受请求与省略字段的旧客户端继续原资金路径，并在新 Purchase 冻结 revision/token。
- [ ] 兼容 legacy writer/reader 在购买事务锁定 commerce state，并在 LEGACY mode 保持现有资金行为；质量/Web 只能通过 adapter/price projection 读取，不直接假设 V2 已激活。
- [ ] 生成 PostgreSQL migration，验证 MySQL renderer/Prisma client；质量任务在该 schema 上 typecheck，M2 adapter 对 activatedAt 缺失或 LEGACY/DRAINING 返回 DATA_UNAVAILABLE且不 import M3-only order fields。
- [ ] Gate 2A：旧客户端及 token 匹配的新客户端在 Team.balanceCents、BalanceLedger、Purchase 数量/金额和旧购买响应上 byte-equivalent；stale expectedPriceVersion 零业务写。公开 token 从首版即为 string且 contract/legacy purchase tests 通过；此 gate 后允许开始 M2 质量/Web，结算任务停留 in_progress，不启动 V2 writer。

Rollback point C2A: schema 保留，writerMode=LEGACY；回滚代码仍必须识别/锁定 state row。

## Phase 2B. Milestone 3 Full Schema, Backfill And Cutover Prep

- [ ] 扩展 Purchase 其余订单字段、PluginEntitlement、BalanceLedger；BalanceLedger 支持 team/platform account XOR owner 和 `(purchaseId, marketplaceEntryKind)` unique。
- [ ] 新增/初始化 `MarketplacePlatformAccount` 的 `MARKETPLACE_CLEARING`、`MARKETPLACE_REVENUE` CNY singleton，以及不可变 `MarketplacePurchaseIdempotency`，禁止平台账户通用 mutation API。
- [ ] 新增 refund request、带单调 revision 的 discount、campaign/item 模型和索引；discount update 与 listing.priceRevision CAS 同事务递增，公开 token 不依赖 updatedAt 字符串。
- [ ] 编写幂等 backfill CLI：v4 旧订单按 legacy 0%/100% SETTLED，entitlement ACTIVE；legacy plugin order 保留 nullable link。
- [ ] backfill dry-run 输出 rows、gross totals、unresolved seller/release、entitlement mismatch，不打印用户敏感数据。
- [ ] 在 fixture 数据库运行两次，断言第二次 0 mutation，Team.balanceCents、两个平台账户与 BalanceLedger row/count/hash 均不变。
- [ ] 分阶段移除旧 `(packageId,buyerTeamId)` unique；在新 writer 开启前验证 entitlement claim 与 idempotency record 已部署。

Validation:

```bash
pnpm -C apps/collab-api prisma:validate
pnpm -C apps/collab-api typecheck
pnpm -C apps/collab-api test -- --testTimeout=60000
```

Review gate: 迁移不产生资金分录、不追溯平台分成，所有新旧订单可被兼容 reader 解码；commerce state 仍为 LEGACY。

Rollback point C2B: schema 保留、writerMode=LEGACY；writer 尚未打开。

## Phase 3. Commerce Service And Purchase Cutover

- [ ] 从 `PluginRegistryService` 抽出共享 listing purchase gate 与 `MarketplaceCommerceService`，保持 controller URL。
- [ ] 实现 fee setting helper/default/validation/audit，不在 purchase 外重新计算历史 split。
- [ ] 扩展 M2 effective price resolver以组合 discount revision/window phase，并复用 listing.priceRevision CAS；catalog/请求仍使用同一 string priceVersion/expectedPriceVersion contract，不另建 M3 算法或改型。
- [ ] 实现 optional legacy / explicit new Idempotency-Key 与不可变 MarketplacePurchaseIdempotency；任何 ACTIVE entitlement 早返回前 claim key 并冻结 ENTITLED_EXISTING/ORDER_CREATED response，退款后同 key 不得新扣款。
- [ ] 将 MarketplaceCommerceFactsAdapter 升级为完整 V2 cohort reader；SETTLEMENT_V2 与 activated PAUSED 都按 factWatermark 读取既有订单，事实查询/一致性错误抛出 job error，不能返回 DATA_UNAVAILABLE。
- [ ] 部署所有 mode-aware writer并下线旧二进制；入口 CAS LEGACY->DRAINING、等待实例/事务 drain，在 DRAINING 重跑幂等增量 backfill并要求 pre-cutover settlementVersion/status 零 null及订单/权益/金额 reconciliation 通过且余额/ledger 零变化，之后才 CAS 到 SETTLEMENT_V2 + generation++ + immutable activatedAt。事故只 PAUSED，禁止回 LEGACY。
- [ ] 实现 Serializable purchase transaction：order/entitlement claim -> buyer conditional debit + clearing credit -> balanced ledger pair/metric/audit；移除 seller即时 credit。
- [ ] 处理 P2002/P2034：只有查到已提交同 key order/ACTIVE entitlement才返回幂等成功。
- [ ] 通知在 commit 后发送，失败只告警。
- [ ] 更新所有 runtime/download entitlement query 为 `status=ACTIVE`。

Focused tests:

- [ ] 1 分与不可整除金额 20/80 split。
- [ ] 同 key重放、key错 package/body、ACTIVE 早返回 key 在退款后迟到重放、无 key旧 client重放。
- [ ] expectedPriceVersion 同值成功，基础价/discount/window phase 变化冲突且零扣款。
- [ ] 滚动部署旧 writer/in-flight transaction 在 DRAINING/V2 generation gate 被拒绝，PAUSED fail-close且不走 legacy。
- [ ] 首次 backfill 后新增 legacy order 被 DRAINING final backfill 补齐；任一 null/unresolved/reconciliation mismatch 阻止 V2 CAS，重复 final backfill 0 mutation。
- [ ] 不同 key并发无 entitlement/REVOKED entitlement。
- [ ] listing/current release/discount/fee 并发变化冻结真实事务快照。
- [ ] 每个 failpoint rollback；卖家余额在 purchase 后不变。
- [ ] BUYER_PURCHASE_DEBIT + PLATFORM_PURCHASE_CLEARING_CREDIT 金额相等、方向相反、净额 0；TeamCredit/CreditLedger 0 调用。
- [ ] 免费 listing 无 financial order。

Review gate: 新订单创建时只有 BUYER_PURCHASE_DEBIT，没有 `plugin_sale`/seller balance increment。

Rollback point C3: 打开 writer 前 shadow compare price/split；打开后如异常关闭新购买，不能恢复旧即时入账处理 pending 新订单。

## Phase 4. Refund Request And Admin Review

- [ ] 实现 buyer refund request route、team scope、7x24h fixed clock 与 unique request幂等。
- [ ] 申请事务 CAS `PENDING_SETTLEMENT -> REFUND_REQUESTED`。
- [ ] 实现 admin list/detail 分页与 `platform.marketplace.refund` 守卫。
- [ ] 实现 approve transaction：request/order CAS、buyer increment + clearing conditional debit、balanced refund ledger pair、entitlement revoke、metric/audit。
- [ ] 实现 reject transaction：request CAS、order 回 PENDING；到期可被下一 job拾取。
- [ ] 通知买卖双方，失败不回滚。
- [ ] 所有 consumer/runtime-access 在退款后拒绝 REVOKED entitlement。

Focused tests:

- [ ] deadline 前/正好/后，固定 UTC instant。
- [ ] 重复申请、批准、拒绝与状态变化。
- [ ] approve 任一余额/ledger/entitlement failpoint 全回滚。
- [ ] 退款 exact gross，TeamCredit/CreditLedger 0 调用。
- [ ] BUYER_REFUND_CREDIT + PLATFORM_REFUND_CLEARING_DEBIT 净额 0，卖家和平台收入账户均不变化。
- [ ] refund 后 repurchase 新 Purchase + entitlement reactivation。

Review gate: 没有 partial refund、settled refund 或卖家余额反向扣款路径。

Rollback point C4: 关闭新 refund request，保留 admin处理已存在 REFUND_REQUESTED 的能力。

## Phase 5. Settlement Job And Reconciliation

- [ ] 实现 batch candidate query、per-order Serializable CAS settlement、clearing conditional debit、seller credit、platform revenue credit 和三种 unique ledger entry。
- [ ] 加入 startup catch-up + 60s unref trigger；多实例安全，业务状态不依赖 timer memory。
- [ ] 实现 admin trigger/CLI 复用同一 service，限制 batch/time 并输出 summary。
- [ ] 实现只读 job status：last run、oldest overdue、due/refund-review counts。
- [ ] 实现 reconciliation checker，比较 order/ledger/entitlement 不变量，只告警不自动补账。
- [ ] commit 后卖家结算通知。

Focused tests:

- [ ] 未到期、到期、REFUND_REQUESTED、SETTLED、REFUNDED筛选。
- [ ] 双实例同时读候选只有一次 seller credit。
- [ ] PLATFORM_SETTLEMENT_CLEARING_DEBIT + SELLER_SETTLEMENT_CREDIT + PLATFORM_SETTLEMENT_CREDIT 净额 0；1 分/平台份额 0 时仍有可验证完整分录。
- [ ] CAS 后任一操作失败 transaction rollback，重试可成功。
- [ ] process crash由 transaction fixture模拟，无“status已结算但无流水/余额”。
- [ ] job停机后补跑与 oldest overdue。

Review gate: 每个 SETTLED 新订单恰有一条 clearing debit、SELLER_SETTLEMENT_CREDIT 和 PLATFORM_SETTLEMENT_CREDIT，使用 frozen split 且净额为 0。

Rollback point C5: 关闭 timer但保留 CLI/manual drain；不能删除 due orders。

## Phase 6. Seller Statements

- [ ] 实现 seller-scoped summary、daily、paged item queries，共享 where builder/whitelist select。
- [ ] 明确 created/refunded/settled 三日期维度和 IANA timezone -> UTC 边界。
- [ ] 实现 buyer current-team order/refund status list。
- [ ] 添加 max 90d、分页、package/status filters和 cancelable frontend requests。
- [ ] reconciliation tests把 summary与 Purchase/BalanceLedger fixture逐订单对齐，并核对 clearing=pending+refund-review gross、revenue=settled platform share。

Validation:

```bash
pnpm -C apps/collab-api test -- --testTimeout=60000
pnpm -C apps/collab-api typecheck
pnpm -C apps/collab-api build
```

Review gate: pending只来自订单，不加到 Team.balanceCents；跨团队 package/order不可探测。

## Phase 7. Discounts And Featured Campaigns

- [ ] discount/campaign schema与代码可在 cutover 前 dark deploy，但所有 mutation、effective-price 营销投影和 attribution consumer 默认关闭；每个入口锁定 commerce state，只在 writerMode=SETTLEMENT_V2 时启用，LEGACY/DRAINING/PAUSED fail-close。
- [ ] 实现 author base price/discount create-update-before-start/cancel，owner/permission/overlap/90d校验；每次成功 discount update 递增自身 revision 与 listing.priceRevision。
- [ ] Serializable overlap check + internal priceRevision CAS；并发冲突稳定映射 409，公开 priceVersion 仍只由共享 resolver 生成。
- [ ] catalog projection同时返回 list/effective/discount，兼容 priceCents=effective。
- [ ] 实现 campaign draft/edit/publish/cancel与有序 items，上限100。
- [ ] 实现短期 attribution token签发/验签及 order snapshot；无效 token按 ORGANIC且不影响 price。
- [ ] 实现 campaign order/refund/net report，不新增 impression/click tracking。
- [ ] 确认 campaign membership不写 quality tier/featured fields。

Focused tests:

- [ ] 0/等于/高于基础价、重叠、边界相接、DST显示、开始后更新拒绝。
- [ ] 下架/归档/release失效时 discount/campaign query过滤。
- [ ] token合法/错package/过期/篡改/canceled。
- [ ] campaign+discount同时存在时价格只解析一次，无叠加。

Review gate: 客户端永远不能提交成交价或分成；campaign不影响质量排序和门禁。

Rollback point C7: 停止签发 token并关闭 marketing mutations；历史discount/campaign/order attribution保留。

## Phase 8. Desktop And Admin UI

### Desktop

- [ ] `plugin-registry.ts` 集中解码 price/order/statement；购买生成并在重试周期保留 idempotency key。
- [ ] Market list/detail显示基础价、折扣价、结束时间和最终 order snapshot；旧 response fallback。
- [ ] buyer订单/退款申请显示7天期限、状态和“不退灵石调用费”。
- [ ] Published package detail加入价格/折扣管理，活动折扣只可取消。
- [ ] TeamWallet显示可用余额与 pending/refund review/settled摘要，pending不得混入主余额。
- [ ] 对账单按需加载、服务端分页、失败可重试。

### collab-admin

- [ ] 新建 Marketplace Finance lazy view和导航/type/API helper，不塞进 dashboard。
- [ ] Orders/Refunds/Settlement/Campaigns tabs按激活加载。
- [ ] refund detail Sheet与approve/reject Dialog保留焦点/原因；409局部刷新。
- [ ] campaign editor使用稳定表格/排序命令，发布后只读+取消。
- [ ] 390x844/1440x900无document横向溢出和文本重叠。

Validation:

```bash
pnpm -C apps/desktop test
pnpm -C apps/desktop typecheck
pnpm -C apps/desktop vite:build
pnpm -C apps/collab-admin typecheck
pnpm -C apps/collab-admin build
pnpm -C apps/collab-admin test:e2e
```

Review gate: UI不本地计算split/status，不把pending当可用余额，不按中文message判断资金分支。

## Phase 9. End-to-end, Concurrency And Rollout

- [ ] E2E A：购买 -> pending -> T+7 settle -> seller statement/ledger。
- [ ] E2E B：购买 -> refund request -> approve -> entitlement revoke -> repurchase -> settle。
- [ ] E2E C：购买 -> refund request -> reject -> overdue job settle。
- [ ] E2E D：折扣+campaign购买 -> order snapshot -> campaign report -> refund冲正。
- [ ] 并发：purchase x20、refund vs settlement、job x2、discount x2、price edit vs order。
- [ ] property test随机金额/bps/status sequence，验证逐动作/逐订单净额 0、平台账户汇总守恒与非法转移拒绝。
- [ ] migration staging dry-run/apply、两次重跑、旧订单/余额对账。
- [ ] 故障演练：settlement job停机/恢复、通知失败、admin响应丢失、数据库serializable retry耗尽。
- [ ] 先 shadow price/split与旧目录对比，再打开 catalog新价格，最后打开 purchase writer。

Full gate:

```bash
pnpm -C packages/contract typecheck
pnpm -C packages/contract test
pnpm -C apps/collab-api prisma:validate
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

- `apps/collab-api/prisma/schema.prisma` / migrations：Purchase unique切换、legacy nullable、跨provider enum/index。
- `apps/collab-api/src/modules/plugin-registry.service.ts`：抽service而非继续增长，保留v4 gate单一来源。
- `apps/collab-api/src/modules/marketplace.service.ts` / `economy.service.ts`：legacy only，不接回新流程。
- `BalanceLedger` / `MarketplacePlatformAccount`：新结构化关联不能破坏admin adjustment/consume/历史展示；平台账户不可被团队 API 或通用 admin adjustment 修改。
- `PluginEntitlement`：所有 access path必须显式ACTIVE；漏一个会使退款后仍可下载/运行。
- `apps/desktop/src/pages/TeamWallet.tsx`：余额与灵石继续分离，pending只作市场摘要。
- `apps/collab-admin/src/App.tsx/navigation.ts`：新view按shell规范注册并lazy加载。

## Rollback And Operations

- 上线顺序：additive schema + M2 string priceVersion/LEGACY validation -> compatible readers -> initial backfill/reconcile -> V2/refund/settlement/discount/campaign code dark deploy（营销 mutation/projection/attribution flags关闭）-> service shadow -> DRAINING + final incremental backfill/reconcile gate -> SETTLEMENT_V2 CAS/恢复购买 -> settlement/refund controls -> discount/campaign mutation、catalog营销投影与 attribution逐步启用。任何营销流量不得进入 LEGACY/DRAINING/PAUSED writer。
- flag开启后出现新 pending order时，回退动作只能是“停新单、继续处理旧单”，不能启用旧卖家即时全额credit。
- 保存 backfill报告与上线时 reconciliation快照；不使用 destructive reset/checkout/SQL删除订单。
- 监控阈值：oldest overdue、pending refund age、settlement failure、duplicate ledger conflict、invariant mismatch、purchase conflict spike。
- 紧急处理使用同一 settlement/refund service或CLI，不直接手改Team.balanceCents；确需人工调整走现有审计化admin balance路径并关联事故单。

## Completion Gate

- [ ] PRD每条 acceptance criterion有自动化测试或明确E2E证据。
- [ ] migration/backfill证明历史Team余额与ledger零变化。
- [ ] 随机借贷守恒、平台账户 reconciliation、CNY/TeamCredit 隔离、并发状态机、跨租户和旧client兼容测试全绿。
- [ ] 无开放问题、无`TBD`，通过`trellis-check`后交父任务执行跨市场质量/Web/cloud集成验收。
