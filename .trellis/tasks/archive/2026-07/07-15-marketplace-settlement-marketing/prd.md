# 市场结算与营销

## Goal

在现有 v4 市场购买、团队余额、权益和双边流水基础上，交付可对账的平台分成、T+7 卖家待结算、7 天退款审核、卖家日对账单，以及限时折扣和平台精选活动；首版形成完整的内部余额商业闭环，不接真实支付或提现。

## User Value

- 买家团队在下单前可以看到基础价、折扣价和退款边界，重复请求不会重复扣款。
- 卖家可以区分待结算、退款审核中、已结算和已退款，不再把刚售出的金额误认为立即可用收入。
- 平台可以按订单创建时冻结的比例获得分成，并在不改历史订单的情况下调整未来分成。
- 平台管理员可以处理 7 天内退款申请，且退款、权益撤销、余额和流水保持一致。
- 作者可以设置简单的限时折扣；平台可以创建精选活动并看到活动归因订单，不需要复杂营销系统。

## Confirmed Baseline

- v4 购买入口是 `POST /api/plugin-packages/:id/purchase`；legacy `/api/wallet/purchase` 已返回 `client_upgrade_required`，不得重新启用旧购买路径。
- 当前 v4 购买在一个 Prisma transaction 中创建 `Purchase`、原子扣减买家 `Team.balanceCents`、把全额立即加到卖家团队、写两条 `BalanceLedger`、写审计并创建 `PluginEntitlement`。
- `Purchase` 已记录 package、买家用户/团队、卖家用户、成交价和时间，但没有精确 release、卖家团队、价格来源、分成快照、结算状态或退款状态。
- `PluginEntitlement` 按 `(teamId, packageId)` 唯一且当前没有 ACTIVE/REVOKED 状态；`Purchase(packageId,buyerTeamId)` 唯一使退款后无法生成第二笔历史订单。
- `MarketplaceListing.priceCents` 是当前基础价；市场目录和旧桌面只识别 `priceCents`，新增价格字段必须保持该兼容投影。
- `Team.balanceCents` 与 `BalanceLedger` 是插件市场人民币分账户；`TeamCredit/CreditLedger` 是 cloud/模型调用的灵石账户，两者用途独立且不得互相退款或换算。
- 当前 `BalanceLedger` 只记录团队侧变化，没有平台清算/收入账户，现有双边流水不能证明每笔新订单借贷净额为 0；settlement v2 必须补齐最小守恒账本。
- 当前无持久化结算 job、退款申请、卖家对账单、折扣或 campaign 模型。
- `PlatformSetting`、RBAC、AuditLog、Notification、collab-admin 分页/详情模式和 TeamWallet 可复用。

## Requirements

### R1. 内部余额订单与价格快照

- 首版只使用团队内部余额，金额单位为非负整数分，币种固定为 CNY；不读取或写入已退役个人 Wallet。
- 只有活动 listing 的精确 current release 仍为 PUBLISHED、APPROVED 且通过当前安全政策时才能购买。
- 每笔付费购买必须冻结：package、精确 release、买卖双方团队与下单用户、基础价、折扣金额、实付价、内部 price revision、opaque priceVersion、折扣 ID/revision、精选活动 ID、平台分成比例、平台金额、卖家金额、币种和 `settlementVersion=SETTLEMENT_V2`；legacy backfill 明确标为 `LEGACY_V1`。
- 当前平台默认分成为平台 20%、卖家 80%。比例使用 basis points 配置，平台金额向下取整到分，卖家获得剩余分，始终满足 `平台金额 + 卖家金额 = 实付价`。
- 分成配置变更只影响变更后创建的订单；历史订单和已生成的卖家对账单使用订单快照，不回算。
- 免费 listing 保持无需财务订单即可下载；付费 listing 的有效折扣价最低为 1 分，避免把付费授权临时变成无订单的免费授权。
- 旧客户端继续读取 `priceCents`，该字段在市场目录中投影当前有效成交价；新客户端同时读取基础价、折扣和有效期。
- M2 dark foundation 为 listing 增加内部单调 `priceRevision: Int`，公开 API 从第一版起只返回稳定类型的 opaque `priceVersion: string`；M3 折扣启用后仍用同一版本化 token 算法组合 revision、discount revision 与 window phase，不改变字段类型。新客户端提交 `expectedPriceVersion: string`，LEGACY/V2 购买事务都在任何业务写之前重算，不匹配时返回 `marketplace_price_changed`；旧客户端可省略并按当前服务端价格兼容执行。订单同时冻结内部 revision 与公开 token。

### R2. 购买幂等与权益

- 新客户端为购买发送幂等键；同一买家团队和幂等键重放必须返回同一订单结果，键被用于另一个 package 时返回冲突。
- 独立不可变 PurchaseIdempotency 记录必须在任何 ACTIVE entitlement 早返回之前 claim，并把 key 绑定 package、request digest 和稳定结果（已有权益或新订单）。后续退款/撤权不能删除该记录，迟到重放不得变成新扣款；新购买必须使用新 key。
- 旧客户端没有幂等键时仍由团队/package 活动权益保证业务幂等；响应丢失后重复请求不能重复扣款。
- 同一团队/package 同时只能有一个 ACTIVE 权益，但退款后的 REVOKED 权益允许团队重新购买并生成新订单历史。
- 创建订单、原子扣款、买家扣款分录、平台清算入账分录、权益激活、分成快照和审计必须在同一事务提交；任一步失败时均不产生部分订单、部分扣款、失衡 journal 或孤立权益。
- 并发购买只能有一个请求取得权益并扣款；其他请求返回已购结果或稳定冲突，不以补偿事务修复重复扣款。

### R3. T+7 待结算

- 购买成功后卖家份额进入订单的待结算状态，不立即增加卖家团队可用余额；平台份额同样保留在订单结算投影中。
- 默认结算时间为订单创建后精确 7x24 小时；所有时间以 UTC instant 保存，前端按用户时区显示。
- 到期且没有退款审核的订单由持久化结算 job 转为已结算：从平台清算账户借记实付价，向卖家团队贷记冻结的卖家金额，并以 `PLATFORM_SETTLEMENT_CREDIT` 向平台收入账户贷记冻结的平台金额。
- 结算、清算补偿分录、卖家/平台入账、流水和审计必须在同一事务，且该动作借贷净额为 0；多实例、重试、进程崩溃或人工补跑不会重复入账。
- 结算 job 停止时订单保持待结算，恢复后补跑；不得因 job 延迟把待结算金额视为已结算或丢弃订单。
- 平台可以查看待结算数量、最老逾期时间和最近 job 结果；卖家可以看到“待结算”而不是虚假的可用余额。

### R4. 7 天退款申请与管理员处理

- 买家团队可在订单创建后 7x24 小时内提交一次退款申请，填写原因；申请必须属于当前团队的订单。
- 提交成功后订单进入“退款审核中”并暂停结算。只要申请在期限内成功占用订单，管理员可以在期限后完成审核。
- 平台管理员可以批准或拒绝活动申请。拒绝后订单回到待结算，到期时由 job 结算；批准后订单进入已退款终态。
- 批准退款必须在同一事务中：把订单冻结的实付价退回买家团队余额、从平台清算账户写等额补偿借记、撤销对应 ACTIVE 权益、标记申请/订单、冲正该订单的平台与卖家结算投影、写质量指标事件和审计；退款动作借贷净额为 0。
- 首版只做全额退回该插件许可的实付价，不做部分退款。卖家尚未入账，因此退款不扣卖家可用余额。
- 已结算订单不能退款；退款与结算在边界时刻并发时只有一个状态转换成功，另一方返回冲突并刷新。
- cloud、模型、工作流运行产生的灵石消耗属于独立 `CreditLedger`，无论插件许可是否退款都不退还、不修改。
- 退款批准后新运行与新下载按 REVOKED 权益拒绝；本机已缓存代码的清理和离线边界沿用插件授权/安装策略，不由资金服务直接删除设备文件。

### R5. 卖家对账

- 卖家团队可按 package、订单状态和日期查看订单明细：订单号、购买时间、基础价、折扣、实付、平台比例/金额、卖家金额、预计结算时间、实际结算时间、退款状态和活动来源。
- 对账摘要至少包含成交总额、折扣金额、平台分成、待结算、退款审核中、已结算和已退款。
- 提供按自然日的成交、退款和结算笔数/金额汇总；日期按请求时区展示，但聚合边界由服务端明确转换为 UTC。
- 列表必须服务端分页，默认 30 天、单次查询最长 90 天；卖家只能读取 ownerTeamId 为当前团队的 package 订单。
- 团队可用余额继续以 `Team.balanceCents` 为真相；待结算金额从订单状态聚合，不另建可漂移的第二个可写余额。

### R6. 限时折扣

- 有 `team.plugin.edit_price` 权限的作者团队可以为自己的活动付费 listing 创建或取消限时折扣。
- 折扣使用绝对成交价，必须至少 1 分且小于创建时基础价；开始/结束时间明确，最长持续 90 天。
- 同一 listing 在任意时间最多有一个未取消且时间重叠的折扣；首版不叠加折扣、优惠券或其他促销。
- 折扣开始前可以修改；开始后价格和时间冻结，只能取消。已创建订单不随折扣取消或基础价变化而改变。
- 修改基础价若会使活动/已排期折扣无效，必须先取消折扣，不能静默改变折扣语义。
- 下架、归档或 current release 失效时折扣停止对新订单生效，但历史折扣和订单快照保留。

### R7. 平台精选活动与归因

- 有权平台管理员可以创建名称、说明、开始/结束时间和有序 package 清单组成的精选活动，并发布或取消。
- 只有活动 listing 可以加入发布中的精选活动；活动不绕过市场、安全、团队策略、权益或兼容性门禁。
- 精选活动只控制一个可分享的市场集合和排序，本身不修改价格；若 package 同时有有效限时折扣，展示并使用该折扣价。
- 活动 membership 不自动授予市场质量任务中的“精选”等级；编辑精选等级与营销精选活动是两个独立且有审计的事实。
- 购买可以携带服务端签发且绑定 campaign/package/有效期的归因 token；有效 token 的订单冻结 campaign ID。无 token 或无效 token 按自然流量处理，不影响成交价或权益。
- 首版营销报表只统计活动归因订单、成交额、退款和净订单数，不采集跨站画像，不建设曝光/点击漏斗。

### R8. 守恒、审计、兼容与回滚

- 对每个新订单始终满足：`基础价 - 折扣 = 实付价`、`平台金额 + 卖家金额 = 实付价`。
- 新增两个仅由 commerce service 操作的 CNY 平台账户：`MARKETPLACE_CLEARING` 与 `MARKETPLACE_REVENUE`。它们不是 Team、不可加入成员、不可通过通用余额调整接口操作，也不成为第二套卖家钱包。
- `BalanceLedger` 对 settlement-v2 订单形成最小双向 journal：购买为买家借记 + 清算贷记；退款为买家贷记 + 清算借记；结算为清算借记 + 卖家贷记 + `PLATFORM_SETTLEMENT_CREDIT`。每个业务动作及每笔订单全生命周期的借贷净额都必须为 0。
- 团队与平台账户余额变化都必须能由关联订单的结构化 BalanceLedger 重放；同一订单/entry kind 最多一条分录，退款/结算补偿分录与状态转换在同一事务。
- 许可 CNY journal 永远不得读取或写入 `TeamCredit/CreditLedger`，也不得用灵石账户补齐、冲正或对账 CNY 差额。
- 订单不能同时处于已结算和已退款；ACTIVE 权益不能指向已退款订单。
- 购买、退款申请/审批、结算、分成配置、折扣和活动发布/取消均记录 actor、订单/package、前后状态和必要快照，不把密钥或用户输入正文写入日志。
- 现有订单不追溯抽成、不调整历史团队余额：迁移后标记为 legacy 已结算，平台比例 0%、卖家 100%，保留原即时全额入账事实。
- 发布采用 additive schema 和功能开关。启用新结算后若需回退，必须关闭新购买、折扣和活动写入，同时继续运行已有待结算/退款处理；不得回退到对新订单即时全额入账。
- 首次开启 settlement-v2 writer 必须持久化不可变 `settlementV2ActivatedAt`；关闭入口或运维 drain 不删除/改写该事实。市场质量任务用它区分“尚未启用”与可验证 v2 cohort。
- Milestone 2 先暗部署不切换资金行为的 commerce compatibility schema/adapter：Purchase settlementVersion/refundableUntil/priceRevision/priceVersion、MarketplaceCommerceState、listing priceRevision 等字段与 string priceVersion resolver 已存在但 writerMode 保持 LEGACY；携带 stale expectedPriceVersion 的新请求在原购买事务任何业务写前拒绝，其他接受请求保持旧资金行为。质量读取缺少 v2 激活事实时返回 DATA_UNAVAILABLE。
- writer cutover 使用数据库事实 `writerMode=LEGACY|DRAINING|SETTLEMENT_V2|PAUSED` 与单调 writerGeneration。所有新旧兼容 writer 在同一购买事务锁定并校验 mode/generation；切换前必须完成旧二进制下线与 in-flight drain，LEGACY -> DRAINING 时入口 fail-close，随后 CAS 到 SETTLEMENT_V2 并写不可变 activatedAt。切换后绝不回 LEGACY。
- 首次 backfill 后产生的 legacy 增量订单必须在 DRAINING 且全部 legacy transaction 收口后由同一幂等 backfill 再处理；只有 pre-cutover Purchase 的 settlementVersion/status 零 null、对账数量/金额/权益一致且余额/ledger 零变化时才允许切到 SETTLEMENT_V2。
- `PAUSED` 只表示 V2 激活后暂停新付费购买，不抹除 settlementV2ActivatedAt 或既有 cohort；质量 facts port 在 PAUSED 下继续还原已激活 V2 订单，读取故障应令计算 job 失败并保留上一成功快照，不能伪装成 DATA_UNAVAILABLE。
- discount/campaign schema 与代码可在切换前暗部署，但 mutation、活动价 catalog projection 和 attribution consumer 只有在 DRAINING final gate 成功且 writerMode=SETTLEMENT_V2 后才能启用；LEGACY/DRAINING/PAUSED 只暴露基础价并 fail-close 营销写入。

## Acceptance Criteria

- [ ] 新付费订单冻结精确 release、买卖团队、基础价/折扣/实付、分成比例和金额；listing 或分成配置随后变化不影响订单。
- [ ] M2 compatibility schema 可在 writerMode=LEGACY 下独立部署；公开 priceVersion 从首版即为 opaque string，LEGACY writer 对 expectedPriceVersion 事务内重算并在 stale 时零业务写，其他接受请求的资金/余额/旧响应保持兼容；质量 adapter 可编译并稳定返回 DATA_UNAVAILABLE，M3 才切换资金 writer。
- [ ] catalog 返回 string priceVersion 而不暴露内部 Int priceRevision；新 Web/desktop 购买提交 string expectedPriceVersion，基础价、折扣活动或 window phase 变化时事务返回 marketplace_price_changed 且零扣款，旧客户端省略字段仍兼容；订单冻结 token/revision 后不随 listing 变化。
- [ ] 默认 20% 平台分成按 basis points 向下取整，卖家取余；覆盖 1 分、不能整除和大额边界时始终守恒。
- [ ] 购买成功只扣买家实付价，卖家余额在创建订单时不变，订单显示 T+7 待结算。
- [ ] 每个 settlement-v2 购买事务同时写 `BUYER_PURCHASE_DEBIT` 与等额平台清算贷记；按 direction 取符号后净额为 0，任一分录失败整笔回滚。
- [ ] 同一幂等键重放返回同一订单；不同幂等键并发购买同一团队/package 只有一次扣款和一个 ACTIVE 权益。
- [ ] ACTIVE entitlement 早返回也持久化 PurchaseIdempotency；随后退款后以同 key 重放仍返回原“已有权益”结果且零扣款，新 key 才能重新购买。
- [ ] 余额不足、listing/release 状态变化、权益抢占失败或任一 ledger/audit 写入失败时整笔事务回滚。
- [ ] 到期 job 只把 sellerAmountCents 入账一次；双实例、重复补跑和“状态已提交但进程退出”场景不会重复结算。
- [ ] 每个 SETTLED 新订单都有清算账户实付价借记、`SELLER_SETTLEMENT_CREDIT` 和 `PLATFORM_SETTLEMENT_CREDIT`，三者净额为 0；平台收入账户只增加冻结的 platformAmountCents。
- [ ] job 停止后到期订单保持待结算；恢复后可补齐并暴露最老逾期时间。
- [ ] 买家在 7 天边界前可提交一次申请，订单转为退款审核中并停止结算；边界后新申请被拒绝。
- [ ] 管理员批准后买家收到精确实付价、权益 REVOKED、订单 REFUNDED，且没有卖家入账；重复批准幂等返回同一结果。
- [ ] 每个 REFUNDED 新订单都有买家退款贷记与等额清算补偿借记，退款动作净额为 0，平台收入和卖家余额均不变化。
- [ ] 管理员拒绝后订单回待结算；若已到期，下一次 job 能正常结算。
- [ ] 退款与结算并发只有一个终态成功，不会出现已退款又给卖家入账。
- [ ] 退款不会写 TeamCredit/CreditLedger，也不会退回 cloud、模型或工作流运行费用。
- [ ] 退款后的团队可以重新购买并生成新 Purchase；旧退款订单和审计历史不被覆盖。
- [ ] writer cutover 先进入 DRAINING 并等待旧实例/事务收口，再以 DB generation 原子切到 SETTLEMENT_V2；滚动部署迟到 legacy writer 被拒绝，切换后 PAUSED/fail-close 也不会重新启用即时卖家入账。
- [ ] DRAINING drain 后重跑幂等增量 backfill；任何 pre-cutover Purchase settlementVersion/status null、订单/权益/金额对账差异或余额/ledger mutation 都阻止 SETTLEMENT_V2 CAS。
- [ ] cutover 前 discount/campaign mutation、营销投影和 attribution 零调用；SETTLEMENT_V2 CAS 后才可逐步启用，PAUSED/营销 flag关闭时回到基础价投影且不会走 legacy writer。
- [ ] 卖家对账展示订单、分成、待结算、退款审核、已结算、退款和按日汇总，且跨团队访问返回 not-found/forbidden。
- [ ] 对账 summary 与订单/BalanceLedger 重放结果一致，分页、筛选和时区边界有测试。
- [ ] 一个 listing 无法创建重叠折扣；有效折扣价用于目录和订单快照，取消/过期后新订单恢复基础价。
- [ ] 付费 listing 的折扣价不能为 0，基础价调整不能静默破坏活动折扣。
- [ ] 平台可以发布/取消精选活动及有序清单；失效 listing 被过滤，活动不会改变质量等级或绕过门禁。
- [ ] 有效 campaign attribution token 冻结到订单并进入活动报表；伪造/过期 token 不改变价格、分成或权益。
- [ ] 旧 desktop 仍能读取 `priceCents`、无 body 调 purchase 并获得原有 entitled/purchaseId 字段；不会因缺少幂等 header 破坏业务幂等。
- [ ] 旧订单迁移不产生任何 Team.balanceCents/BalanceLedger 变动，历史订单按 0%/100% legacy 已结算展示。
- [ ] 首次启用 writer 只写一次不可变 settlementV2ActivatedAt；重复开启、关闭购买入口和运维 drain 均不清除或后移，所有新单为 SETTLEMENT_V2、所有 backfill 订单为 LEGACY_V1。
- [ ] V2 激活后切到 PAUSED 时既有订单的退款 cohort 仍可按 watermark 读取，不会把所有付费 listing 批量标记 DATA_UNAVAILABLE；真实 facts 读取错误保留上一成功质量快照。
- [ ] 资金属性测试证明购买/退款/结算每个动作和每种订单终态的借贷净额为 0；数据库约束和并发测试证明每订单/entry kind 至多一条关联流水。
- [ ] settlement-v2 的所有 CNY 场景对 `TeamCredit/CreditLedger` 保持 0 调用，平台清算/收入账户不能被团队或通用 admin balance API 读取为可用团队余额或修改。
- [ ] contract、collab-api、desktop、collab-admin 的类型检查、单元测试、构建和购买/退款/结算端到端场景通过。

## Dependencies

- 依赖现有 v4 registry、精确 current release、安全门禁、团队余额、BalanceLedger、Purchase、PluginEntitlement、RBAC 与审计。
- 复用市场质量任务的 category/quality catalog projection，但折扣/campaign 不参与质量等级或热门排序。
- 向市场质量任务提供不可变 settlementV2ActivatedAt、显式 settlementVersion、refundableUntil 和退款审核时间；质量层不需要解析 ledger reason 或猜测 legacy 状态。
- cloud/模型费用继续由 CreditLedger 管理；本任务只处理插件许可的 CNY 团队余额订单。
- Web 插件中心后续复用本任务的价格、活动、订单与退款契约。

## Constraints

- 所有资金写入必须在数据库事务内完成，并对 PostgreSQL/MySQL 支持的隔离与唯一约束有明确测试。
- 金额只用整数分和 basis points；禁止浮点金额或依赖前端舍入。
- 先加 schema/reader 和迁移，后打开写功能；启用前必须完成旧订单 backfill 与守恒核对。
- 本任务处于规划阶段，用户统一评审前不启动实现。

## Out of Scope

- 银行卡、微信/支付宝等第三方收单、真实货币入金、提现、卖家打款、税务、发票、KYC/AML 和多币种。
- 优惠券、满减、复杂促销叠加、联盟返利、订阅、自动续费、按席位/用量授权、赠礼和零元限时抢购。
- 部分退款、已结算后追偿、拒付/chargeback、自动退款判定和买卖双方仲裁系统。
- 曝光/点击漏斗、用户画像、个性化营销、广告竞价或付费置顶。
- 把营销精选活动自动映射为质量“精选”等级。
- 重新启用 legacy wallet/marketplace 路由或删除历史 Wallet 表。

## Planning Status

- 产品与技术边界已按推荐方案收敛，无阻塞性开放问题。
- 规划产物包含 `prd.md`、`design.md` 与 `implement.md`；等待与其他子任务一起统一提交用户评审。

## Notes

- 2026-07-15：用户授权后续决策全部采用推荐方案并统一输出。
- 2026-07-15：规划采用内部团队余额、默认平台 20%/卖家 80%、T+7、7 天内申请并由管理员处理、退款审核暂停结算、卖家对账、限时折扣和精选活动的最小闭环。
