# 统一插件系统为 v4 单一系统（退役 legacy Plugin）

## Goal

把并行的两套插件系统收敛为 **v4 单一系统**：后台审核、市场货架、购买计费全部基于 v4（`PluginPackage` + `PluginRelease` + `MarketplaceListing`），legacy `Plugin` 表连同旧上传/旧审核/旧市场接口一起退役。用户从任一入口（桌面发布、后台审核、市场购买）看到的都是同一条数据链路，不再出现「提交了后台看不到」「审通过了上不了货架」这类断链。

## Background — 现状断链（2026-07-18 勘察确认）

平台当前有**两套并行、互不相通**的插件系统：

| 能力                 | legacy `Plugin` 表                                                                              | v4 `PluginPackage`+`PluginRelease`                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 上传发布             | `plugin.service.ts:uploadPlugin` → `POST /api/plugins/upload`（旧 v3，桌面端**已不走**）        | `POST /api/plugin-registry/releases` + `submit-marketplace`（桌面端发布走这条）                                                |
| 后台审核列表         | `admin.service.ts:1001` `prisma.plugin.findMany({reviewStatus:'PENDING'})` → 后台「插件审核」页 | `GET /api/admin/plugin-releases/review-pending`（后端有，**前端没调**）+ `plugin-packages?reviewStatus=PENDING` 间接筛         |
| 审批动作             | `POST /api/admin/plugins/:id/approve`（写 `Plugin.reviewStatus`）                               | `POST /api/admin/plugin-releases/:id/approve`（写 `PluginRelease.marketReviewStatus` + `MarketplaceListing.currentReleaseId`） |
| 市场货架/详情/安装数 | ✅ `marketplace.service.ts` 全查 `prisma.plugin`                                                | ❌                                                                                                                             |
| 购买计费             | ✅ `economy.service.ts` 查 `prisma.plugin`                                                      | ❌                                                                                                                             |

**两个已确认的断链**：

1. **审核断链**：v4 提交写 `PluginRelease.marketReviewStatus='PENDING'`，但后台审核列表查 legacy `Plugin.reviewStatus` → v4 提交在后台审核页**永远空**（用户本次踩到的坑）。
2. **上架断链**：v4 `approveRelease` 只更新 `PluginRelease` + `MarketplaceListing`，**不回写 legacy `Plugin`**；而市场货架 `marketplace.service.ts` 读 legacy `Plugin` → **v4 审通过的插件上不了市场货架、不能买**。

桌面端发布已全面走 v4，legacy `Plugin` 仅由旧 `uploadPlugin` 接口（已不被桌面调用）和存量数据维持。结论：**v4 是事实上的发布主路径，但市场/购买层仍卡在 legacy，审核层后台入口走错**——必须把后两层迁到 v4，再退役 legacy。

## Task Map（三阶段，独立可验收）

| 子任务                                                                       | 目标                                                                | 风险                     | 状态                         |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------ | ---------------------------- |
| [`phase0-admin-review-v4`](../07-18-phase0-admin-review-v4/prd.md)           | 后台审核入口统一到 v4：v4 待审核直列页 + 废弃旧审核页               | 低（纯 UI/路由）         | 规划中                       |
| [`phase1-marketplace-on-v4`](../07-18-phase1-marketplace-on-v4/prd.md)       | `marketplace.service`/`economy.service` 改读 v4，v4 审批→可上架可购 | 中高（动购买/计费）      | 目标级 PRD，阶段0 完成后详规 |
| [`phase2-retire-legacy-plugin`](../07-18-phase2-retire-legacy-plugin/prd.md) | 存量 `Plugin` 迁进 v4，下线旧接口/前端，删 legacy 代码              | 高（数据迁移、购买记录） | 目标级 PRD，阶段1 完成后详规 |

顺序约束：phase1 依赖 phase0 的 v4 审核闭环可用；phase2 依赖 phase1 让所有读路径离开 `Plugin` 后才能安全删表。

## Requirements（父级，跨阶段）

- **R1 单一数据源**：发布/审核/上架/购买/安装全链路以 v4 `PluginRelease` 为准，legacy `Plugin` 不再被任何读路径依赖（phase2 终态）。
- **R2 审核可见**：v4 提交的市场审核申请在后台有**唯一、显式**的审核入口可见可操作（phase0）。
- **R3 审批即上架**：v4 审批通过 → 市场货架可搜到、详情可看、可购买计费（phase1）。
- **R4 数据不丢**：legacy `Plugin` 的存量记录（含购买/安装历史）在退役前完成向 v4 的映射或归档（phase2）。
- **R5 桌面端无感**：桌面端发布/更新流程不变（已走 v4），不要求用户重装。

## Constraints

- **C1 计费正确性**：阶段1 改购买读路径时，灵石扣费/团队计费逻辑必须与现状等价，不能漏扣/重扣（关联 [[billing-relay-over-byok]] 的团队计费）。
- **C2 AI 政策不回退**：v4 审核仍走 `checkPluginAiPolicy`，legacy 退役不放开政策。
- **C3 存量兼容**：已购买的 legacy 插件不能因退役失效；phase2 需保证迁移后老购买记录仍能定位到对应 v4 发行版。
- **C4 渐进**：三阶段顺序推进，每阶段独立上线/可回滚；不做一次性 big-bang 迁移。

## Cross-Phase Acceptance Criteria

- [ ] 桌面端发布一个新插件到市场 → 后台 v4 审核页能看到、能 approve（phase0）
- [ ] approve 后 → 市场货架能搜到、详情正常、能下单购买、计费正确（phase1）
- [ ] legacy `Plugin` 表无新写入；旧 `/api/plugins/*` 上传/审核/市场接口下线或 410；前端无入口（phase2）
- [ ] 存量 legacy 插件的购买/安装记录在 v4 体系下仍可追溯（phase2）

## Out of Scope

- 不改桌面端发布协议（已 v4）。
- 不改 v4 的 AI 政策/制品格式/运行时。
- 不重构与 plugin 系统无关的市场营销/优惠券等。
- 不在本 epic 内做 plugin 之外的内容（应用市场等）。

## Open Questions（阶段1 详规时解决）

- legacy `Plugin` 与 v4 `PluginPackage` 的 ID 映射：是按 `manifestId` 对齐，还是建迁移表？
- 存量 legacy `Plugin` 的 `installCount`、购买记录如何归并到 v4 `MarketplaceListing`/`PluginRelease`？
- 旧 `uploadPlugin` 接口是否还有非桌面客户端在调（需留兼容期还是直接 410）？
