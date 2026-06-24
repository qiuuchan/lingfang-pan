# 计费钱包重构 · 执行计划（implement.md）

> 配套 design.md。顺序：**R1（轻量、零风险）→ R3（计费正确性核心）→ R2（删页面+建团队钱包前端 → 后端余额改团队共享）**。
> 全部迁移/账户决策已由用户拍板收口（见 design §7 与文末决策表），无悬挂待确认项。R2 后端涉及资金扣款，按「先加测后改码 + `pg_dump` 备份可回滚」执行。
> 全程只动 `apps/collab-api` 与 `apps/desktop`；不提交 git（由用户决定）。

---

## 验证命令速查

```bash
# 后端类型检查 + 构建
cd P:/lingfang-platform/apps/collab-api && pnpm typecheck
cd P:/lingfang-platform/apps/collab-api && pnpm build
# 后端单测（计费）
cd P:/lingfang-platform/apps/collab-api && pnpm test
cd P:/lingfang-platform/apps/collab-api && pnpm vitest run src/modules/credit.service.spec.ts
cd P:/lingfang-platform/apps/collab-api && pnpm vitest run src/modules/relay
# Prisma 校验（仅当动 schema 时）
cd P:/lingfang-platform/apps/collab-api && pnpm prisma:validate
# 桌面端构建
cd P:/lingfang-platform/apps/desktop && pnpm build
```

---

## 阶段 0 · 基线（开工前）

- [ ] 0.1 跑基线绿：`collab-api` `pnpm typecheck && pnpm test`、`desktop` `pnpm build`，记录当前通过状态。
- [ ] 0.2 确认工作区 clean（`git status`），便于回滚。
- **Rollback point R0**：当前 commit（`edc08b6`）。

---

## 阶段 1 · R1 版本下放渠道（轻量，零迁移）

> 核实结论：BillingTab 已只读，ModelTierConfig 已删（仅剩注释）。本阶段不动 schema。

- [ ] 1.1 复核 `schema.prisma:749-753` 确无 `ModelTierConfig` model（仅注释），如注释陈旧可精简，**不产生迁移**。
- [ ] 1.2 `tier:*` scope（已定：**不启用强校验**）：保留为展示性标签、relay 不据其限版。在 `relay.service.ts` `assertScope` 上方补注释说明「`tier:*` 当前不参与鉴权」。不改逻辑。
- [ ] 1.3 验证：
  ```bash
  cd P:/lingfang-platform/apps/collab-api && pnpm typecheck && pnpm test
  ```
- **Review gate G1**：确认 BillingTab 无版本「配置/写入」入口（只读展示 + API Key scope 勾选），relay `fast`/`premium` 哨兵仍可用。
- **Rollback point R1**：阶段 1 完成 commit（建议）。

---

## 阶段 2 · R3 修复未成功对话仍扣费（核心）

> 先加测固化现状，再做幂等加固，避免改坏计费。

- [ ] 2.1 **先补测（红/绿基线）**：新建 `apps/collab-api/src/modules/relay/relay.service.spec.ts`，Mock `CreditService`/`ChannelRouterService`/`PricingService`/`forwarders`/Prisma，覆盖 design §3 表的 8 个场景，断言：
  - 失败路径 `reconcile` **未被调用**；
  - `refund` 调用次数（cap>0 失败=1；cap=0 任意=0）；
  - 成功路径 `reconcile` 恰 1 次、`charged==min(real,cap)`；
  - 「团队余额净变化」语义（用 mock 累加断言）。
  - 先跑，确认现状哪些通过/失败：
    ```bash
    cd P:/lingfang-platform/apps/collab-api && pnpm vitest run src/modules/relay/relay.service.spec.ts
    ```
- [ ] 2.2 **R3-1 refund 真正幂等**（`credit.service.ts:170-184`）：退款前加「已终结流水」检查——
  - 有 `source:'reserve'` 流水 **且** 无 `source∈{refund, llm_consume}` 流水时才退；否则 no-op。
  - 扩充 `credit.service.spec.ts`：新增「reconcile 后再调 refund 不重复退」「refund 调两次只退一次」两条用例。
- [ ] 2.3 **R3-2 成功路径 finalizeLog 容错**（`relay.service.ts:277`）：把成功后的 `finalizeLog` 包 try/catch，失败记 warn（含 `callLogId`、`charged`），不影响已返回的成功响应；保证至少落 `success` 终态（可重试一次 update）。
- [ ] 2.4 **R3-3 流式中断语义注释**（`relay.service.ts:281-285`）：补注释「流式发头后失败一律全额退预扣、不计费（产品取舍，利于用户）」。逻辑不变。
- [ ] 2.5 跑全部计费测试：
  ```bash
  cd P:/lingfang-platform/apps/collab-api && pnpm vitest run src/modules/credit.service.spec.ts src/modules/relay
  cd P:/lingfang-platform/apps/collab-api && pnpm typecheck && pnpm test && pnpm build
  ```
- **Review gate G2（安全关键）**：
  - 8 场景全绿；
  - 人工复核 `executeRelay` 每条出口：失败必 `refund(cap>0)`/no-op(cap=0) 且不 `reconcile`；成功必 `reconcile` 且不 `refund`；
  - 确认未削弱 `requireAuth`/`assertScope`/限流（`@Throttle 30/min`）。
- **Rollback point R3**：阶段 2 完成 commit。

---

## 阶段 3 · R2 删团队空间 + 删个人钱包 + 整合「团队钱包」（决策已收口）

> 最终决策（用户已拍板，见 design §7）：市场购买余额改**团队共享**（复用 `Team.balanceCents`），**废弃个人钱包**（存量余额清零、不搬运）；卖家收益进卖家当前/主团队；取消 ¥10 注册赠送；`GET /api/wallet` 下线、`POST /api/wallet/purchase` 路径保留改语义。
> **拆分执行**：前端删页/建页（3-A）与后端改逻辑+清零（3-B）均按最终决策实施，无需再确认。前端可先做、先交付。

### 阶段 3-A · 前端：删 TeamHome + 删个人 Wallet + 建「团队钱包」页（可先做，零资金风险）

- [ ] 3A.1 删 `apps/desktop/src/pages/TeamHome.tsx` + `apps/desktop/src/pages/Wallet.tsx`。
- [ ] 3A.2 清理 desktop 引用（grep 已定位）：
  - `App.tsx`：删 TeamHome 相关 `lazy(TeamHome)`（35）、`teamOpen`/`setTeamOpen`（245/317）、`'team'` 分支（293/311-312）、`PanelDialog`（714-715）；删 Wallet 相关 `lazy(Wallet)`（34）、`walletOpen`/`setWalletOpen`（244/316）、`'wallet'` 分支（292/307-308）、`PanelDialog`（711-712）。
  - `view-preload.ts`：移除 `team`（6）+ `wallet`（9）预加载。
  - `AvatarMenu.tsx`：「团队空间」（110）+「钱包」（108）两菜单项统一指向「团队钱包」。
  - `CommandPalette.tsx:89`：`go('wallet',...)` 改指团队钱包或移除。
  - `lib/types.ts:163,165`：`AccountSettingsTab`/`View` 中 `'team'`/`'wallet'` 按新页面调整。
- [ ] 3A.3 **新建「团队钱包」页**（`apps/desktop/src/pages/TeamWallet.tsx`）：
  - 卡片 1：**团队余额**（人民币，`/api/teams/current/balance` + `/balance-ledger`，`centsToYuan`），标注「插件市场购买」。
  - 卡片 2：**团队灵石**（`/api/teams/current/credits` + `/credits/ledger`），标注「AI 对话计费」（可复用 BillingTab 现有灵石卡片，两处择一避免重复）。
  - 两类账户**明确区分用途**，各自独立流水，**不混显、不换算**。
  - 入口：「团队空间」「钱包」菜单项统一打开「团队钱包」PanelDialog/路由。
- [ ] 3A.4 **市场购买引导改向**：`MarketplacePluginsSection.tsx:153` 的 `openWallet`、`use-marketplace-detail.ts` 的 `showPurchaseError`「去钱包」均改指向「团队钱包」。
  - `use-marketplace-detail.ts:52` 的 `POST /api/wallet/purchase` 调用**路径不变**（后端改语义为团队余额扣款，前端 URL 无需改）。
- [ ] 3A.5 验证前端：
  ```bash
  cd P:/lingfang-platform/apps/desktop && pnpm build
  ```
- **Review gate G3A**：desktop 构建通过；TeamHome + Wallet 删除无死引用；新「团队钱包」页展示两类账户（此时后端未改，余额来自 `Team.balanceCents`、购买仍走 `/api/wallet/purchase` 旧语义，前端已统一入口）。
- **Rollback point R3A**：前端阶段完成 commit。

### 阶段 3-B · 后端：余额改团队共享 + 废弃个人钱包（按最终决策实施）

> 决策已收口（design §7），无需再确认。本阶段涉及资金扣款逻辑，**安全关键**：保持原子条件扣款防透支，先加测后改码。

- [ ] 3B.1 **市场买卖改打团队余额**（`EconomyService.purchase`，economy.service.ts:60-134）：
  - 买家扣款：`tx.wallet.updateMany({userId, balanceCents:{gte:price}})` → `tx.team.updateMany({where:{id:buyerTeamId, balanceCents:{gte:price}}, data:{balanceCents:{decrement:price}}})`；`count===0` 抛 `insufficientBalance`。保持原子条件扣款防透支。
  - 买家流水：写 `BalanceLedger(teamId=buyerTeamId, DEBIT, reason:'plugin_purchase', actorUserId=买家)`（含 pluginId 入 reason/审计）。
  - **卖家加款**：进**卖家所属团队**（`ensureCurrentTeam(sellerId)` 取当前/主团队）的 `Team.balanceCents`（`update increment`）+ 写 `BalanceLedger(CREDIT, reason:'plugin_sale', actorUserId=卖家)`。
  - 幂等分支（77-80 已购买）：`return balance` 改读买家团队 `Team.balanceCents`。
  - 审计 `wallet.purchase` 保留，metadata 含 `buyerTeamId` + 卖家收益团队。卖家通知（121-132）保留。
- [ ] 3B.2 **取消注册赠送**：删 `EconomyService.ensureWallet` 的 ¥10 `signup_bonus`（`SIGNUP_BONUS_CENTS` + 流水写入）。`ensureWallet` 随个人 Wallet 退役——其调用点改为不再 ensure 个人钱包（团队灵石 `signup_bonus` 已覆盖新用户赠送）。
- [ ] 3B.3 **端点处置**：
  - `GET /api/wallet`（`WalletController.get` + `EconomyService.getWallet`）：**下线**（删该路由 + service 方法）。
  - `POST /api/wallet/purchase`：**路径保留**，`WalletController` 仅留 `purchase`；service 内部已改打团队余额（最小改动，前端调用点不变）。
- [ ] 3B.4 **单测**：扩充 `economy.service.spec.ts`——团队余额不足（mock `team.updateMany.count=0`）抛 402、并发购买不重复扣、买家 DEBIT(plugin_purchase) + 卖家 CREDIT(plugin_sale) 流水断言、卖家收益进其当前团队。先加测后改码。
- [ ] 3B.5 验证后端：
  ```bash
  cd P:/lingfang-platform/apps/collab-api && pnpm typecheck && pnpm test && pnpm build
  ```
- [ ] 3B.6 **个人余额清零脚本**（`apps/collab-api/src/clear-personal-wallet.ts`，一次性、幂等，**纯清零不搬运**）：
  - 备份（清零前必做，唯一还原依据）：`pg_dump -t wallet -t wallet_transaction > backup-wallet-clear-$(date +%s).sql`（记录路径）。
  - 清零：`UPDATE wallet SET balanceCents = 0 WHERE balanceCents <> 0`（**保留行 + 历史 `WalletTransaction`，不删表、不写团队流水**）。团队余额从 0 起，靠 collab-admin 充值。
  - 无总额守恒校验（不搬运）。
  - 运行：`tsx src/clear-personal-wallet.ts`（生产前先 staging 试跑）。
- [ ] 3B.7 **上线前运营告知**：个人余额作废属用户可感知变更，上线前需公告/通知（非代码项，标注）。
- **Review gate G3B（安全关键）**：
  - 市场购买从团队余额原子条件扣款防透支；
  - 卖家收益进其当前/主团队（资金不丢/不错配）；
  - 单测覆盖余额不足/并发/买卖双方流水；
  - 个人 Wallet 已清零（备份在手、可还原）；
  - `GET /api/wallet` 已下线、`/api/wallet/purchase` 改语义后前端购买仍可用；
  - collab-admin 财务统计/调额仍正常（复用 `Team.balanceCents`，admin 路径零改动）。
- **Rollback point R3B**：后端改动完成 commit；回滚 = 还原 `pg_dump` 备份（恢复个人余额）+ 回退 `EconomyService`/`WalletController` 代码。

### 阶段 3-后续（本任务之外，仅标注）
- [ ] **collab-admin 适配**：`users-view.tsx:287` 个人钱包 `wallet.balanceCents` 清零后恒 0，需配套改 collab-admin（`admin.service.ts:236` + 展示）。**本任务不改 collab-admin，交后续单独处理。**
- [ ] **`DROP TABLE wallet/wallet_transaction`**：观察期（≥1 发布周期）后另议，本任务不做。

---

## 阶段 4 · 收尾

- [ ] 4.1 全量验证：
  ```bash
  cd P:/lingfang-platform/apps/collab-api && pnpm typecheck && pnpm test && pnpm build
  cd P:/lingfang-platform/apps/desktop && pnpm build
  ```
- [ ] 4.2 对照 prd 验收清单逐条核对（版本只读 / 团队钱包同页展示余额+灵石两类账户 / 失败不净扣费单测 / 余额改团队共享后市场购买正常且防透支 / 两端构建）。
- [ ] 4.3 清理临时文件（`pg_dump` 备份妥善归档，勿删）；汇总改动交用户。
- **最终 Review gate G4**：验收清单全绿；所有迁移/账户决策已按 design §7 最终结论落地（余额改团队共享 W2 / 个人余额清零 / 卖家收益进团队 / 取消赠送 / `GET /api/wallet` 下线 / tier 不强校验）。

---

## Rollback point 汇总

| 标记 | 位置 | 回退动作 |
|------|------|---------|
| R0 | 开工前 `edc08b6` | `git reset` / 丢弃工作区 |
| R1 | R1 完成 | 回退阶段 1 改动（仅注释） |
| R3 | R3 完成 | 回退 credit/relay 改动 + 删新增 spec |
| R3A | R2 前端完成 | 恢复 TeamHome + Wallet 页 + 引用；删新「团队钱包」页 |
| R3B | R2 后端完成 | 还原 `pg_dump` 备份（恢复个人余额）+ 回退 `EconomyService`/`WalletController` 代码 |

## 决策收口（用户已全部拍板，无悬挂待确认项）

| # | 决策 | 结论 |
|---|------|------|
| 1 | 余额账户载体 | W2：复用 `Team.balanceCents`，不新建表 |
| 2 | 存量个人余额 | 不搬运、直接清零（团队从 0 起，admin 充值）；`pg_dump` 备份可回滚 |
| 3 | 卖家收益 | 进卖家当前/主团队 `Team.balanceCents` + `BalanceLedger(plugin_sale)` |
| 4 | 注册赠送 ¥10 | 取消（团队灵石已有 signup_bonus） |
| 5 | `/api/wallet` | `GET` 下线；`POST /purchase` 路径保留、改打团队余额 |
| 6 | `DROP TABLE wallet/*` | 本任务不删，仅清零，观察期后另议 |
| 7 | collab-admin 个人钱包展示 | 本任务之后单独处理 |
| 8 | R1 `tier:*` scope 强校验 | 不启用 |
