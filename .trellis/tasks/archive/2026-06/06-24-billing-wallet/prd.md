# 计费钱包重构：版本下放渠道 + 团队钱包整合 + 扣费修复

## Goal

重构桌面端计费/钱包体系：①把计费配置里的版本选择逻辑下放给渠道管理；②删除团队空间模块，整合为团队共享的「团队钱包」；③修复未成功对话仍扣费的问题。

## Requirements

### R1 移除计费配置中的版本选择逻辑（需求 #1）

- 计费配置界面（`BillingTab.tsx`）不再承担版本（fast/premium）的选择/配置职责。
- 版本控制完全由渠道管理（Channel，tier 标签 FAST/PREMIUM + models[]）决定。
- relay 仍接受 `fast`/`premium` 哨兵作为 model 字段（前端无感），但配置入口从计费页移除。
- 清理 schema 中遗留的 ModelTierConfig 注释/死代码（若确认无引用）。

### R2 删除团队空间，整合为团队钱包（需求 #10）

- 删除「团队空间」页面 `TeamHome.tsx`（存在两个金额显示混淆 bug）。
- 统一为「团队钱包」：团队共享一个余额。明确以 TeamCredit（灵石）为唯一团队账户口径。
- 前端余额展示口径统一（消除 Team.balanceCents 人民币 与 TeamCredit 灵石 双显示）。
- 后端旧端点（`/api/teams/current/balance`、`/balance-ledger`）保留向后兼容或下线，须在 design 中定。
- 数据迁移策略（BalanceLedger / Wallet 历史数据）须在 design 中定，动表前需用户确认。

### R3 修复未成功对话仍扣费（需求 #11）

- 对话失败（上游错误、流式中断、无渠道、余额不足）时不应净扣费。
- 重点修复 `relay.service.ts` executeRelay 的 reserve/reconcile/refund 时机，以及 `credit.service.ts` refund 在「无预扣 cap=0」与「reconcile 已转 DEBIT」场景下的幂等回退。

## Acceptance Criteria

- [ ] 计费配置页不再有版本选择 UI；版本由渠道决定，relay 哨兵仍可用
- [ ] 团队空间页删除；前端只存在一个统一的团队钱包余额口径
- [ ] 两个金额显示混淆问题消失
- [ ] 模拟对话失败（上游 500 / 流式中断 / 无渠道）后团队余额无净扣减（单测或手测验证）
- [ ] `apps/collab-api` 构建 + 相关测试通过；桌面端构建通过
- [ ] 数据迁移（若有）经用户确认，且可回滚

## 关键代码位置（探查结论）

- 版本选择：`apps/desktop/src/pages/settings/BillingTab.tsx:28-39,148-162`；`relay.controller.ts:22-26`；`relay.service.ts:34-38,49-75`；`channel.service.ts:1-27`；`schema.prisma:144-149,668-691,749-753`
- 团队空间/钱包：`apps/desktop/src/pages/TeamHome.tsx`、`pages/Wallet.tsx`；`teams.controller.ts:102-114`、`wallet.controller.ts`、`user-billing.controller.ts:49-72`；`team.service.ts:264-291`、`economy.service.ts:19-58`、`credit.service.ts`；`schema.prisma:215-246,301-313,417-438,696-723`
- 扣费：`relay.service.ts:201-333`、`credit.service.ts:98-184`

## Notes

- 复杂任务：动 schema 与数据迁移前必须有 design.md + implement.md 且用户确认。
- 与子任务 B 在 relay 调用链交叉：A 管后端扣费，B 管前端渲染。
