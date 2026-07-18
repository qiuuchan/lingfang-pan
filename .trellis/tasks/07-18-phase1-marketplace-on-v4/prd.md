# 阶段1：市场货架与购买改读 v4

> 父任务：[`07-18-unify-plugin-system-v4`](../07-18-unify-plugin-system-v4/prd.md)
> 依赖：阶段0 完成（v4 审核闭环可用）。

## Goal

把市场货架与购买计费的读路径从 legacy `Plugin` 迁到 v4（`PluginPackage` + `PluginRelease` + `MarketplaceListing`）。让「v4 审批通过 → 市场可搜到、详情可看、可下单购买、计费正确」成为闭环，消除 phase0 发现的「审通过上不了货架」断链。

## 范围（目标级，详细设计待 phase0 完成后补 design.md）

预期改动面（需在详规阶段全量核查）：
- `apps/collab-api/src/modules/marketplace.service.ts` — 货架列表、详情、安装计数（现查 `prisma.plugin`）改读 v4 listing/release。
- `apps/collab-api/src/modules/economy.service.ts` — 购买/计费（现查 `prisma.plugin`）改读 v4，保证灵石扣费等价。
- `apps/collab-api/src/modules/marketplace-commerce.service.ts` — 退款等 commerce 流（核查 legacy 依赖）。
- v4 审批落 `MarketplaceListing`：确认 `approveRelease` 已设 `currentReleaseId`（phase0 勘察已见），补充上架所需字段（价格、可见性、安装包来源）。
- 桌面端市场/购买页：核查是否直接消费 `marketplace.service` 响应，字段适配。

## 关键问题（详规时解决）

- Q1 ID 映射：legacy `Plugin.id` ↔ v4 `PluginPackage.id`/`manifestId`。存量已购记录按哪个键对齐到 v4？
- Q2 安装计数：legacy `Plugin.installCount` 如何并入 v4 `MarketplaceListing`/`PluginPackage`（v4 是否有等价计数字段？需否加字段）。
- Q3 价格：`MarketplaceListing.priceCents` 已存在；确认购买流读这个而非 legacy `Plugin` 价格。
- Q4 计费等价性：灵石扣费、团队计费、fast/premium 哨兵（[[billing-relay-over-byok]]）逻辑必须与 legacy 行为一致，需写对账用例。
- Q5 双写过渡期：是否需要 v4 审批时同步回写一份 legacy `Plugin`（兼容期），还是直接切流？倾向直接切流 + 存量迁移（phase2），避免双写复杂度。

## 验收（目标级）

- [ ] v4 审批通过的插件，在市场货架能搜到、详情正确。
- [ ] 购买流程端到端跑通，灵石扣费与既有规则一致（对账用例通过）。
- [ ] legacy `Plugin` 不再被 marketplace/economy 读路径依赖（grep 验证）。
- [ ] 存量 legacy 已购插件仍可用（过渡兼容）。

## Out of Scope

- 删 legacy `Plugin` 表 / 下线旧上传接口（phase2）。
- 改 v4 AI 政策/制品格式。

## Notes

- 本 PRD 为目标级；**design.md / implement.md 待 phase0 完成后、进入本阶段时再写**（届时 marketplace/economy 读路径需全量核查 + 对账用例设计）。
