# 计费钱包重构 · 技术设计（design.md）

> 子任务 A（后端扣费 + 数据口径）。配套 implement.md。
> 本设计基于对真实代码的核实，已纠正 prd「探查结论」中的若干不准确处（见 §0）。

---

## 0. 核实代码后对原探查的关键修正

逐一 Read 了探查列出的文件，纠正如下（重要，影响改动范围）：

1. **R1「BillingTab 承担版本选择」不准确（基本已完成）。**
   `BillingTab.tsx` 当前已是「只读」形态：
   - 28-39 行的 `SCOPE_OPTIONS` 里 `tier:fast`/`tier:premium` 是**新建 API Key 的能力范围（scope）勾选项**，不是「计费配置的版本选择」。
   - 148-162 行的「模型版本」卡片已是**只读展示**（`GET /api/relay/v1/models` 返回 fast/premium + 资源池），并标注「底层模型由平台统一配置与管理」。
   - 结论：R1 在 BillingTab 上**没有需要拆除的「版本选择 UI」**。R1 主要剩两件事：①确认 schema/seed 里 `ModelTierConfig` 死代码已清；②审视 API Key 创建默认勾了 `tier:fast`（`useState(['chat','tier:fast'])`），决定 scope 体系里 `tier:*` 是否保留。

2. **`ModelTierConfig` 已经移除，不是「待清理的 model」。**
   `schema.prisma:749-753` 只是**注释**（解释 ModelTierConfig 为何被删），没有 model 定义。`relay.service.ts:3`、`channel.service.ts:8`、`pricing.service.ts:3`、`billing.controller.ts:4`、`seed-credits-channels.ts:5,21,44` 均为「已移除」说明性注释。R1 的「清理死代码」其实是**清理陈旧注释**，不涉及 schema 迁移。

3. **R3 的退款幂等其实已经做了，但「无预扣 cap=0」场景仍有真实缺口（探查③成立）。**
   - `credit.service.ts:170-184` 的 `refund` 已用 `findFirst({source:'reserve'})` 做幂等，**且 `cap<=0` 直接 return**（171 行）。所以「refund 找不到 reserve 流水无法回退」不会抛错——它是静默不退。
   - 真正的缺口：**cap=0（未预扣）模式下，`reconcile` 在 `relay.service.ts:275` 成功路径才被调用**；失败路径只调 `refund`，而 `refund` 在 cap=0 时 no-op。这是对的（cap=0 失败本就没扣过钱，无需退）。**但流式 + cap=0 时若已 `reconcile`（极少，reconcile 只在成功后调）不存在**——成功才 reconcile，失败不 reconcile。故 cap=0 下「失败仍扣费」理论上不成立。
   - **cap>0 才是风险区**（见 §3 详述）：流式 `headersSent` 后的退款时机、reconcile 与 refund 的互斥、以及「成功 reconcile 后 finalize 抛错被外层 catch 再 refund」的**双重退款/记错状态**风险。

4. **R3 真实 bug 定位（核实 `executeRelay` 201-315 + `forwarders.ts`）：**
   - **Bug A（双重退款窗口）**：成功路径 275-278 先 `reconcile`（已把预扣转成实扣），然后 `finalized=true`，再 `finalizeLog`。若 `finalizeLog`（277 行）抛错，控制流进入外层 `catch`（301）。此时 `finalized===true`，外层 `if(!finalized)` 不执行 → 不会重复退款。**安全**。但 `reconcile`（275）自身若抛错，`finalized` 仍为 false，外层 catch 会 `refund`——而 reconcile 可能已部分写库（它在一个 `$transaction` 内，要么全成要么全回滚，所以不会半提交）。**reconcile 事务保证下安全，但需测试覆盖确认。**
   - **Bug B（流式中断计费缺口，真实）**：`pipeSseAndExtractUsage`（forwarders 220-264）在 `for(;;) reader.read()` 循环中若上游中途断流/超时 abort，会抛错冒泡到 `executeRelay` 的候选 `catch`（279）。此时 `res.headersSent===true`（226-230 已 flushHeaders）→ 走 281-285：`refund(cap)` + finalize `upstream_error` + `return`。**这是对的**（全额退预扣，不计费）。**但**：若**部分 chunk 已透传且上游发了 usage 后才断**，按现逻辑仍全额退款、计 `upstream_error`、credits=0——**用户白嫖了已消费的 token**。反向风险（用户被扣未完成对话）不存在。**业务取舍**：流式中断「不计费」对用户有利、对平台有损，可接受为 MVP；但需明确写入验收。
   - **Bug C（cap=0 + reconcile 透支保护已做，但无预扣下「失败仍扣」不成立）**：见 §3。
   - **Bug D（候选全失败但已 headersSent 不可能）**：故障转移（287 注释「非流式继续下一候选」）只在 `!res.headersSent` 时进行；流式一旦发头就在 281 终止。逻辑自洽。
   - **真正要修的**：①把「退款/冲销」语义收敛为**单一终态机**，消除 `finalized` 布尔散落带来的状态混淆；②给 cap>0 成功后 `finalizeLog` 失败补「已扣费但日志未终态」的可观测告警；③补**集成级**单测：上游 500（非流式故障转移耗尽）、流式发头后断流、无渠道、余额不足、cap=0 路径，各断言「团队余额净变化 == 预期」。

5. **R2「删团队空间」的真实边界（核实账户体系 + 协调澄清后重大修正）：**

   ⚠️ **澄清（推翻先前「显示重复 bug」的判断）**：#10 **不是**「两个金额显示重复 bug」。系统本就有**两类用途不同的账户，都要保留、不可合并**：
   - **「余额」（人民币分）= 插件市场买卖**用。当前散落在**两处**：
     - **个人 `Wallet.balanceCents`**（`schema.prisma:417-424`，`userId @unique`）——**实际驱动市场买卖**：`EconomyService.purchase`（economy.service.ts:60-134）从**买家个人钱包**条件扣款、给**卖家个人钱包** upsert 加款，并写两条 `WalletTransaction`（purchase/sale）；注册赠送 ¥10 也进个人钱包（`ensureWallet`）。前台 `Wallet.tsx` 走 `/api/wallet`。**市场买卖只认个人 Wallet，不碰 Team.balanceCents。**
     - **团队 `Team.balanceCents` + `BalanceLedger`**（215-246, 301-313）——**admin 治理的团队级余额**：建团队初始余额（`admin.service.ts:388-397`）、admin 调额（461-490）、财务统计（601-607）、collab-admin 详情展示（`teams-view.tsx`/`users-view.tsx` 多处 `money(team.balanceCents)`）。前台仅 `TeamHome.tsx` 通过 `/api/teams/current/balance(-ledger)` 只读展示；`consume` 端点无前台调用方。
   - **「灵石」（`TeamCredit.balance`，Float）= AI 调用计费**用（relay reserve/reconcile/refund）。已是团队级共享，本任务不改其归属。

   - **目标形态（#10）**：整合为「团队钱包」——**团队共享一份「余额」+ 一份「灵石」**，同页展示+管理两类账户及各自流水。
     - 删 `TeamHome.tsx`（团队空间页）。
     - **个人 `Wallet` 功能并入「团队钱包」**：余额账户**从个人级改为团队级共享**——这是**账户归属变更，要动后端数据模型/归属逻辑 + 数据迁移**。
   - 因此 **先前「R2 无需动 schema」的结论作废**。R2 现在是**真实的账户归属变更**（详见重写后的 §4），属本任务最高风险项；相关决策已由用户全部拍板（见 §7），按最终结论实施。「余额」与「灵石」两类账户**都保留、互不合并**。

---

## 1. 技术边界

| 维度         | 子任务 A（本设计）                                                                          | 子任务 B（前端 relay 渲染）        |
| ------------ | ------------------------------------------------------------------------------------------- | ---------------------------------- |
| 范围         | 后端扣费正确性、计费口径、R1/R2/R3 后端 + 桌面端「团队钱包/团队空间」页面、余额账户归属迁移 | desktop 端 relay 流式渲染、对话 UI |
| relay 调用链 | 管 reserve/reconcile/refund/日志 + `/api/relay/*` 服务端                                    | 管前端如何发起/渲染 SSE            |
| 交叉点       | `relay.service.executeRelay` 的计费时机；流式中断时服务端「退款 vs 计费」语义               | 流式中断时前端如何提示用户         |
| 不碰         | 前端 SSE 解析与渲染                                                                         | 服务端扣费逻辑、schema、账户归属   |

**安全红线**：本任务核心是「计费正确性 + 鉴权 + 资金账户归属正确」。任何改动必须保证：①失败不净扣费；②成功只扣一次；③扣费金额 = `min(realCredits, cap)`（cap>0）或实算（cap=0，且不透支）；④`/api/relay/*` 双鉴权与 scope 校验不被削弱；⑤所有余额变动有流水（`CreditLedger`/`WalletTransaction`/`BalanceLedger`）+（admin 路径）审计；⑥**余额账户改团队共享后，扣款/加款的原子条件扣款语义（防透支、防并发重复）不被削弱**。

---

## 2. R1 · 版本选择下放渠道

### 现状（核实结论）

版本已由渠道决定：`relay.service.wireToTier`（34-38）把 `model` 哨兵 `fast`/`premium` 映射成 tier；`ChannelRouterService.selectCandidates`（channel.service）按 `kind+tier` 选「渠道×模型」候选轮询。BillingTab 已只读。

### 改动方案（轻量）

- **R1-a 清理陈旧注释 / 死代码确认**：确认 `schema.prisma:749-753` 仅注释、无 model；保留或精简注释（不删表，因为本就没有表）。不产生迁移。
- **R1-b API Key scope 中的 `tier:*` 决策（已定：不启用强校验）**：当前 `SCOPE_OPTIONS` 含 `tier:fast`/`tier:premium`，但 `relay.service.assertScope`（181-184）只校验 `chat`/`image`/`action`，**从不校验 `tier:*`**。即 `tier:*` scope 当前是**展示性标签**（前端可勾、后端不据其限版）。
  - **最终结论**：保留 UI、**不新增 `assertScope` 的 tier 维度强校验**（启用会使未勾选对应 tier 的存量 key 被 403，属鉴权收紧的破坏性变更）。在 `assertScope` 上方补注释说明「`tier:*` 不参与鉴权」。
- **R1-c 前端默认勾选**：`BillingTab` 创建 key 默认 `['chat','tier:fast']`，与 R1-b 决策一致即可，无需改。

### API 兼容性

relay 仍接受 `fast`/`premium` 哨兵（`wireToTier`、`listModels`）。无端点签名变化。**前端无感。**

---

## 3. R3 · 修复「未成功对话仍扣费」（核心）

### 计费状态机现状（核实 `executeRelay` 201-315）

```
建 pendingLog(status=reserve)
 └ reserve(cap)            # cap>0: 原子 DEBIT；cap=0: no-op
    ├ 失败(余额不足) → finalize(insufficient_balance) + throw 402   ✅
    └ 成功
       selectCandidates
        ├ 空 → refund(cap) + finalize(no_channel) + throw 503        ✅
        └ 逐候选:
           lookupPrice 无 → skip（计 skippedForNoPricing）
           forward()
            ├ 成功 → reconcile(cap, realCredits) → finalized=true
            │         → finalizeLog(success, credits=charged) → return
            └ 失败:
               headersSent(流式已发头) → refund(cap) + finalize(upstream_error) + return
               否则(非流式) → 记 lastError，continue 下一候选
        全候选耗尽:
           refund(cap)
           全无定价 → finalize(no_pricing) + throw 503
           否则 → finalize(upstream_error) + throw 502
 外层 catch(未预期错误):
   if(!finalized): refund(cap) + finalize(client_error) + throw
```

### 确认的不变量（已正确，加测试锁定）

- `refund`（170-184）幂等：仅当存在该 `callLogId` 的 `reserve` 流水才退；cap=0 直接 return。**双重退款不会发生**（reserve 流水只 1 条；退一次后再退仍会写第二条 refund CREDIT——**注意：refund 本身不检查"是否已 refund 过"，只检查"是否 reserve 过"**）。
  - ⚠️ **潜在 Bug E（新发现，需修）**：`refund` 的幂等条件是「有 reserve 流水」，**不是「未退过」**。当前调用点保证 refund 每条调用链至多走一次（各分支 `return`/`throw` 后不再触达另一 refund），所以现状安全。但这是**靠调用方纪律维持的脆弱不变量**。加固方案：`refund` 改为「有 reserve 流水 **且** 无 refund/llm_consume 终结流水」才退，使其对重复调用真正幂等。**推荐纳入修复**，并加单测。
- `reconcile`（125-167）：cap>0 时「全额退预扣 + 实扣 min(real,cap)」，cap=0 时「条件扣款防透支，余额不足扣到 0」。数学自洽（spec 已覆盖 real<cap、real>cap）。

### R3 改动方案

**R3-1（核心，必做）：refund 真正幂等。**
`credit.service.refund` 增加终结流水检查：

```
reserved = findFirst(source:'reserve', callLogId)
if (!reserved) return
settled = findFirst({ callLogId, source: { in: ['refund','llm_consume'] } })  // 已退或已实扣
if (settled) return   // 已终结，幂等
... 退款
```

这样即使未来调用链出现「reconcile 后又 refund」或「refund 被调两次」，余额也不会被错误加回。**这是防"失败仍扣费"反面（防"成功却被退款 → 平台漏计费"）的关键加固。**

**R3-2（核心，必做）：成功路径 `finalizeLog` 失败的可观测性。**
275 `reconcile` 成功（钱已扣）后，277 `finalizeLog` 若抛错，外层 catch 因 `finalized===true` 跳过，错误被重新 throw 给客户端——但**钱已扣、日志仍显示非 success**。改动：把 277 的 `finalizeLog` 包 try/catch，失败时记录 warn 级日志（含 callLogId、charged），**不影响已成功的响应**，并保证日志至少落 `success`。避免「扣了费但日志 pending/错态」的对账黑洞。

**R3-3（建议）：流式中断的计费语义显式化。**
281-285 流式发头后失败统一 `refund + upstream_error + credits=0`。明确接受「流式中断一律不计费（利于用户）」为产品取舍，**写入验收**。不改逻辑，但加注释 + 单测固化。

**R3-4（必做）：补集成级单测**（`relay.service.spec.ts`，新建或扩充）。Mock `forwarders` + `CreditService` + `ChannelRouterService` + Prisma，断言**每种失败路径下 `reconcile` 未被调用、`refund` 恰调一次（cap>0）/零次（cap=0）、最终团队余额净变化 == 0**：

| 场景             | cap | 期望                                             |
| ---------------- | --- | ------------------------------------------------ |
| 余额不足         | >0  | reserve 抛 402；无 refund（钱没扣）；余额不变    |
| 无渠道           | >0  | refund 1 次；余额回滚到调用前                    |
| 全候选无定价     | >0  | refund 1 次；no_pricing 503                      |
| 非流式上游全失败 | >0  | 故障转移耗尽 → refund 1 次；upstream_error 502   |
| 流式发头后断流   | >0  | refund 1 次；upstream_error；credits=0           |
| 成功             | >0  | reconcile 1 次；charged=min(real,cap)；无 refund |
| 成功             | =0  | reconcile 条件扣款；无 refund                    |
| cap=0 上游失败   | =0  | refund no-op；余额不变（本就没扣）               |

### API 兼容性

端点签名不变；错误码语义不变（`insufficient_balance`/`no_channel_available`/`pricing_not_configured`/`upstream_llm_error`）。客户端无感。

---

## 4. R2 · 删团队空间 + 整合「团队钱包」（余额账户改团队共享，废弃个人钱包）

> **最终决策（用户拍板）**：插件市场购买的「余额」也改为**团队级共享**，**不再保留个人钱包**——个人 `Wallet` 账户取消。
>
> - 余额（市场购买）→ 团队级共享，**废弃个人 `Wallet`/`/api/wallet`/前台钱包页**。
> - 灵石（AI 计费）→ 团队级共享（已是）。
> - 「团队钱包」页同页管理这两类**团队**账户，团队成员共用。
> - 删 `TeamHome.tsx`（团队空间页）+ 删个人 `Wallet.tsx`（钱包页）。
>
> 这是**账户归属变更 + 个人账户废弃**，需动后端逻辑 + 个人余额清零。**决策已全部拍板（见 §7），按最终结论实施。**

### 4.1 现状账户拓扑（核实结论）

| 账户       | 表                                    | 归属             | 用途              | 流水                        | 谁在用                                                                                | 最终去向                                 |
| ---------- | ------------------------------------- | ---------------- | ----------------- | --------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------- |
| 余额(个人) | `Wallet`                              | `userId @unique` | 市场买卖/注册赠送 | `WalletTransaction(userId)` | `EconomyService.purchase/getWallet`、前台 `Wallet.tsx`(`/api/wallet`)                 | **废弃**（余额迁团队、页面删、端点下线） |
| 余额(团队) | `Team.balanceCents` + `BalanceLedger` | `teamId`         | admin 治理余额    | `BalanceLedger(teamId)`     | `admin.service`(建团/调额/统计)、`team.service`(balance/ledger/consume)、collab-admin | **承接市场购买余额**（团队共享购买账户） |
| 灵石       | `TeamCredit` + `CreditLedger`         | `teamId`         | AI 计费           | `CreditLedger(teamId)`      | relay、`UserCreditsController`(`/api/teams/current/credits`)、BillingTab              | 不变（已团队级）                         |

**关键观察**：市场买卖当前**只走个人 `Wallet`**；团队已有现成的团队级余额账户（`Team.balanceCents`+`BalanceLedger`），但没接市场。最终形态 = **市场购买改打团队余额账户 + 彻底废弃个人 Wallet**。

### 4.2 方案抉择：复用 Team.balanceCents（已定 W2）

- **方案 W2（复用现有 `Team.balanceCents`+`BalanceLedger` 作团队购买余额）** ✅ **已定采纳**：
  - 团队级余额表**已存在且 admin 已在充值/调额/统计**，无需新建表。
  - 买家扣款从「个人 Wallet」改为「买家所属团队的 `Team.balanceCents`」（原子条件扣款 + 写 `BalanceLedger`）。
  - **collab-admin 零改动即兼容**（它读写的就是 `Team.balanceCents`/`BalanceLedger`）。
  - 「市场购买余额」与「admin 治理余额」共用一个团队余额池——符合「团队共享一份余额」的目标，无需隔离。
- **方案 W3（新建独立 `TeamWallet` 表）**：与 `Team.balanceCents` 并存两套团队余额，徒增第三套账户与对账复杂度，且 collab-admin 仍读 `Team.balanceCents`，会出现「页面显示的团队余额≠购买能用的余额」割裂。**否决。**
- ~~方案 W1（改 Wallet 归属 user→team）~~：既已废弃个人 Wallet，W1 不再适用。

> **已定 W2**：复用既有团队余额账户、最小破坏、collab-admin 兼容、不新增表；个人 Wallet 整体退役。

### 4.3 W2 的后端改动

- **R2-BE-1 市场买卖改打团队余额**（`EconomyService.purchase`，economy.service.ts:60-134）：
  - 买家扣款：`tx.wallet.updateMany({userId, balanceCents:{gte:price}})` → `tx.team.updateMany({ where:{ id: buyerTeamId, balanceCents:{ gte: price } }, data:{ balanceCents:{ decrement: price } } })`，`count===0` 抛 `insufficientBalance`。保持**原子条件扣款防透支**。
  - 写 `BalanceLedger(teamId=buyerTeamId, DEBIT, reason:'plugin_purchase', actorUserId=买家)` 替代买家 `WalletTransaction`。
  - **卖家加款（已定）**：个人 Wallet 废弃后，卖家收益进**卖家所属团队**的 `Team.balanceCents`，写 `BalanceLedger(CREDIT, reason:'plugin_sale', actorUserId=卖家)`；卖家多团队时归其**当前/主团队**（`ensureCurrentTeam(sellerId)`）。
  - 幂等分支（已购买，economy.service.ts:77-80）：`return balance` 改读买家团队 `Team.balanceCents`。
  - `Purchase` 表已有 `buyerTeamId`；`sellerUserId` 保留（记录哪位作者售出，收益归其团队）。无需加列。
  - 审计：`wallet.purchase` 保留，metadata 记 `buyerTeamId` + 卖家收益团队。
  - 通知卖家逻辑（121-132）保留（通知个人作者）。
- **R2-BE-2 余额查询/流水团队化**：
  - 「团队钱包」页需要：团队余额（`Team.balanceCents`）+ 余额流水（`BalanceLedger`）+ 团队灵石（`TeamCredit`）+ 灵石流水（`CreditLedger`）。
  - **复用现有团队端点**：`/api/teams/current/balance`、`/balance-ledger`、`/api/teams/current/credits`、`/credits/ledger`。**无需新端点**。
  - `GET /api/wallet`（个人余额，`WalletController.get`/`getWallet`）：**下线**（删 controller 路由 + service 方法）。
  - `POST /api/wallet/purchase`：**保留路径、改语义为团队余额扣款**（最小改动：购买动作仍是同一前端调用点，仅 service 内部从个人 Wallet 改打团队余额，避免改前端调用 URL + 路由表）。`WalletController` 仅留 `purchase` 一个方法。
- **R2-BE-3 注册赠送（已定：取消）**：删 `EconomyService.ensureWallet` 的 ¥10 `signup_bonus`（`SIGNUP_BONUS_CENTS` 及其流水）。团队已有灵石 `signup_bonus`（`CreditService.ensureAccount`），不再重复发人民币赠送。`ensureWallet` 整体随个人 Wallet 退役（其调用点改为团队余额账户的 ensure 或直接移除）。

### 4.4 数据迁移方案（已定：不搬运，存量清零）

> **最终决策**：存量个人余额**不迁移、直接清零作废**。团队余额从 0 起，靠 collab-admin 后台充值。无资金搬运脚本，迁移大幅简化为「schema/逻辑切换 + 个人 Wallet 清零」。

- **Schema 变更**：
  - W2 承接余额**不需要加表/加列**（`Team.balanceCents`、`Purchase.buyerTeamId` 已存在）。
  - 废弃个人 Wallet **分两步**：①本任务——停用读写（代码不再访问个人 `Wallet` 做扣款/赠送）+ 个人 `Wallet.balanceCents` 清零；②观察期后——`DROP TABLE Wallet/WalletTransaction`（独立迁移，本任务不做）。本任务**保留表结构**，便于回滚与历史审计。
  - `BalanceLedger.reason` 新增字符串取值 `plugin_purchase`/`plugin_sale`（字符串列，无需结构迁移）。**无 `wallet_migration`**（不搬运）。
- **存量清零脚本**（一次性，幂等，**纯清零、不搬运**）：
  1. 备份：`pg_dump` 备份 `Wallet`/`WalletTransaction`（清零前必做，唯一还原依据）。
  2. 清零：`UPDATE wallet SET balanceCents = 0 WHERE balanceCents <> 0`（保留行 + 历史 `WalletTransaction`，**不删表、不写团队流水**）。
  3. 无总额守恒校验需求（不搬运，团队余额从 0 起）。
- **回滚策略**：
  - 回滚 = 还原 `pg_dump` 备份（个人 `Wallet.balanceCents` 原值）+ 回退 `EconomyService`/`WalletController` 代码。
  - 因**未删表、未删列、未搬运资金**，回滚是「还原备份 + 代码回退」，风险可控、可逆。
  - `DROP TABLE` 留到观察期后独立评估（届时不可逆，需另确认）。

### 4.5 前端改动（删 TeamHome + 删个人钱包页 + 新「团队钱包」页）

- **R2-FE-1 删 `TeamHome.tsx`** + 入口（`App.tsx` 的 `lazy(TeamHome)`/`teamOpen`/`setTeamOpen`/`'team'` 路由/`PanelDialog`、`view-preload.ts:6`、`AvatarMenu.tsx:110`、`lib/types.ts` 的 `'team'`）。
- **R2-FE-2 删个人 `Wallet.tsx`** + 入口：
  - `App.tsx`：`lazy(Wallet)`（34）、`walletOpen`/`setWalletOpen`（244/316）、`'wallet'` 路由分支（292/307-308）、`<PanelDialog open={walletOpen}>`（711-712）。
  - `view-preload.ts:9` 的 `wallet` 预加载。
  - `AvatarMenu.tsx:108`「钱包」菜单项 → 改为指向「团队钱包」。
  - `CommandPalette.tsx:89` 的 `go('wallet',...)` → 指向团队钱包或移除。
  - `lib/types.ts:163,165` 的 `AccountSettingsTab`/`View` 中 `'wallet'` 按新页面调整。
  - `MarketplacePluginsSection.tsx:153` + `use-marketplace-detail.ts`：`openWallet`/「去钱包」引导改指向「团队钱包」；`/api/wallet/purchase` 调用**路径不变**（后端改语义为团队余额扣款，前端调用点无需改 URL）。
- **R2-FE-3 新「团队钱包」页**（`apps/desktop/src/pages/TeamWallet.tsx`，团队成员共享）：
  - 卡片 1「团队余额」（人民币，`/api/teams/current/balance` + `/balance-ledger`，`centsToYuan`），标注「插件市场购买」。
  - 卡片 2「团队灵石」（`/api/teams/current/credits` + `/credits/ledger`），标注「AI 对话计费」（可复用 BillingTab 灵石卡片，两处择一避免重复）。
  - 两类账户**明确区分用途**，各自独立流水，**不混显、不换算**。
  - 入口：原「团队空间」「钱包」两个菜单项统一指向「团队钱包」。

### 4.6 collab-admin 兼容性

- W2 复用 `Team.balanceCents`+`BalanceLedger`，**collab-admin 读写路径零改动**（建团初始余额、调额、财务统计、团队/用户详情均继续工作）。
- 市场购买改打团队余额后，admin 财务统计新增 `plugin_purchase`(DEBIT)/`plugin_sale`(CREDIT) 流水——属预期，统计口径自然包含。
- **`users-view.tsx:287` 的 `detail.wallet.balanceCents`**：个人 Wallet 废弃 + 清零后该字段恒为 0、含义消失。配套改 collab-admin（`admin.service.ts:236` 的 `wallet:{balanceCents}` 与 `users-view` 展示）**放本任务之后单独处理**（不在本任务两文件范围）。迁移期 admin 端个人钱包显示 0（历史在 `WalletTransaction`），属已知、可接受。

### API 兼容性

- 复用既有团队端点，新「团队钱包」页无需新端点。
- `GET /api/wallet`（个人余额）**下线**；`POST /api/wallet/purchase` **路径保留、语义改为团队余额扣款**（前端调用点不变，最小改动）。
- `/api/relay/*` 不受影响。

---

## 5. 风险点

| #    | 风险                                                                              | 等级  | 缓解                                                                                         |
| ---- | --------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------- |
| R-1  | R3 改 `refund` 幂等条件，若逻辑写错可能「该退不退」→ 失败仍扣费（恶化）           | 高    | 单测覆盖 8 场景；保持「有 reserve 且未终结才退」语义；先加测后改码                           |
| R-2  | R3 改 reconcile/refund 时机引入双重扣费                                           | 高    | 不改既有成功路径计费数学，仅加幂等护栏 + 可观测性；spec 锁定                                 |
| R-3  | R2 删 TeamHome 漏改引用导致 desktop 构建失败                                      | 中    | grep 全量引用（App/view-preload/AvatarMenu/types）；删后 `pnpm build`                        |
| R-4  | R1-b 若误开 `tier:*` 强校验，旧 API Key 被 403                                    | 高    | 已定**不启用**强校验                                                                         |
| R-5  | **R2 余额改团队共享：市场扣款从个人切团队，若条件扣款语义写错 → 透支/并发重复扣** | 极高  | 复用 `Team.updateMany(balanceCents:{gte})` 原子条件扣款；事务内写流水；单测覆盖余额不足/并发 |
| R-6  | 个人余额清零作废可能引用户不满（余额消失）                                        | 中    | 已定存量清零（团队从 0 起，admin 充值）；`pg_dump` 备份可还原；上线前运营告知/公告           |
| R-7  | **R2 卖家收益进卖家当前/主团队，多团队卖家归属可能非预期**                        | 中    | 已定归 `ensureCurrentTeam(sellerId)`；审计 metadata 记收益团队便于追溯                       |
| R-8  | 流式中断「不计费」被滥用（白嫖 token）                                            | 低-中 | 接受为 MVP 取舍，写入验收；后续可按已收 usage 部分计费                                       |
| R-9  | `finalizeLog` 失败导致对账黑洞                                                    | 中    | R3-2 加 warn 日志 + 保证至少落终态                                                           |
| R-10 | 废弃个人 Wallet 后 collab-admin `users-view.wallet.balanceCents` 恒 0             | 中    | 配套改 collab-admin（放本任务之后单独处理）；迁移期显示历史 0 可接受                         |

---

## 6. 对子任务 B（前端 relay 渲染）的边界

- **A 不碰**：desktop 的 SSE 解析、对话气泡渲染、`relay-chat-stream.ts`。
- **契约交接点**：
  - A 保证服务端「流式中断 → 退款 + `upstream_error` + 不计费」。B 需在前端**对中断流给出明确「本次未计费」提示**（与 A 的退款语义一致），不要在前端自行假定已扣费。
  - A 的错误码（`no_channel_available`/`pricing_not_configured`/`insufficient_balance`/`upstream_llm_error`）是 B 渲染错误态的依据，A 保证不变更这些 code 字符串。
  - 团队**灵石**展示口径（来自 `/api/teams/current/credits`）与团队**余额**口径（`/api/teams/current/balance`）由 A 统一；B 若需在对话页显示，应复用同一端点，**不得**再引个人 Wallet。两类账户用途不同（灵石=AI、余额=市场），B 渲染时勿混淆。

---

## 7. 决策收口（用户已全部拍板，无悬挂待确认项）

> 用户已确认全部迁移/账户决策。以下为最终结论，本设计据此收口，**不再有「待确认」项**。

| #   | 决策项                                | 最终结论                                                                                                                                    |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 余额账户载体                          | **W2：复用现有 `Team.balanceCents`+`BalanceLedger`**，不新建 `TeamWallet` 表                                                                |
| 2   | 存量个人余额处理                      | **不迁移、直接清零作废**。无资金搬运脚本；团队余额从 0 起，靠 collab-admin 后台充值。仍 `pg_dump` 备份 + 清零可回滚                         |
| 3   | 卖家收益归属                          | 进**卖家所属团队** `Team.balanceCents` + `BalanceLedger(CREDIT, plugin_sale)`；多团队卖家归**当前/主团队**（`ensureCurrentTeam(sellerId)`） |
| 4   | 注册赠送 ¥10                          | **取消**（团队灵石已有 `signup_bonus`，避免重复）。删 `ensureWallet` 赠送逻辑                                                               |
| 5   | `/api/wallet` 端点                    | `GET /api/wallet` **下线**；`POST /api/wallet/purchase` **路径保留、语义改为团队余额扣款**（最小改动，前端调用点不变）                      |
| 6   | `DROP TABLE Wallet/WalletTransaction` | **本任务不删，仅清零**；观察期（≥1 发布周期）后另议                                                                                         |
| 7   | collab-admin 个人钱包展示适配         | **放本任务之后单独处理**（不在本任务两文件范围）                                                                                            |
| 8   | R1 API Key `tier:*` scope 强校验      | **不启用**（保持现状：`tier:*` 为展示性标签，relay 不据其限版）                                                                             |

R1（版本下放清理）、R3（扣费幂等 + finalizeLog 容错）维持原结论不变。

执行边界：**前端删页（TeamHome + 个人 Wallet）+ 新建团队钱包页**与**后端市场改打团队余额 + 卖家收益进团队 + 取消赠送 + 个人 Wallet 清零 + `GET /api/wallet` 下线**均按上述最终决策实施，无需再行确认。仍只动 `apps/collab-api` + `apps/desktop`；collab-admin 适配与 `DROP TABLE` 为本任务之外的后续项。
