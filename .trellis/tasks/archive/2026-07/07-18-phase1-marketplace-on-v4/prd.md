# 阶段1：v4 市场/购买闭环验证（无代码迁移缺口）

> 父任务：[`07-18-unify-plugin-system-v4`](../07-18-unify-plugin-system-v4/prd.md)
> 依赖：阶段0 完成（v4 审核入口可用）。
> 研究依据：[`research/legacy-plugin-dependency-map.md`](./research/legacy-plugin-dependency-map.md)

## 结论先行

**原设想的「把 marketplace/economy 迁到 v4」是伪命题——v4 货架/购买/权益/评分链路早已存在且桌面端在用。** phase1 因此从「迁移实现」降级为「端到端验证 + 圈定 legacy 残留」，**无新增代码缺口**。本 PRD 据实重写。

## v4 闭环现状（已存在，phase0 勘察 + 本研究确认）

| 环节           | v4 实现                                                                                                                                                  | 桌面端入口                                                           |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 审批→上架      | `approveRelease` 设 `MarketplaceListing.currentReleaseId`+`status=ACTIVE`                                                                                | 后台「待审核发行版」直列页（phase0）                                 |
| 货架列表/详情  | `MarketplaceDiscoveryService`（catalog/home/page + snapshots/prices/quality）                                                                            | `GET /api/plugin-registry/marketplace`（`plugin-registry.ts:157`）   |
| 购买/计费/权益 | `marketplace-commerce.service:purchaseV2`（packageId→listing.currentRelease→`Purchase(packageId,releaseId)`+`pluginEntitlement`，幂等/折扣/活动/结算V2） | `POST /api/plugin-packages/:id/purchase`（`plugin-registry.ts:507`） |
| 评分/质量      | `marketplace-quality.service` + `MarketplaceQualitySnapshot`（ratingTeams/ratingSum/averageRatingTenths 喂 discovery）                                   | `POST .../rate`（`marketplace-quality.controller:30`）               |
| 参与度排序     | discovery popular 用快照；`MarketplaceListing.installCount` 等为 legacy 残留计数（v4 用快照为主）                                                        | —                                                                    |

`Purchase`/`PluginGrant` 已双写（`pluginId?`+`packageId?`/`releaseId?`）→ **v4 化无需 schema 变更**。`MarketplaceListing` 已含 `installCount/ratingCount/ratingSum/priceCents/currentReleaseId/qualityTier` 等全字段。

## Goal

**验证** v4「审批→上架→下单→权益→评分」闭环端到端可用，并圈定 legacy 残留供 phase2 清理。不写新功能（无缺口）。

## Requirements

### 验证性

- **R1 审批可见**：detail-poster 0.2.4（或任一 v4 release）经 phase0 直列页 approve 后，`marketReviewStatus=APPROVED` 且 `MarketplaceListing.currentReleaseId` 已设。
- **R2 货架上架**：approve 后 `GET /api/plugin-registry/marketplace` 能搜到该插件，详情字段正确。
- **R3 购买/权益**：桌面 `POST /api/plugin-packages/:id/purchase` 跑通（免费插件直接获权益；付费扣灵石正确，团队计费对齐 [[billing-relay-over-byok]]），`Purchase.packageId/releaseId`+`pluginEntitlement` 落库。
- **R4 评分**：`marketplace-quality.rate` 对该 package 写快照，discovery 评分位展示。

### 清理性（圈定，不改）

- **R5 legacy 残留清单**：确认 `marketplace.service`（`@Controller('marketplace')`）/`economy.service`/`plugin.service` legacy CRUD/`admin` legacy-plugin 端点**无活跃消费**（前端/外部），归入 phase2。仅产出清单，不删。

## Acceptance Criteria

- [ ] approve 一个 v4 release → discovery 搜得到、详情对。
- [ ] 桌面下单（免费/付费各一）→ Purchase+pluginEntitlement 落库、计费正确。
- [ ] 评分写入质量快照、discovery 展示。
- [ ] 产出 legacy 残留清单（文件 + 行 + 确认无消费）供 phase2。

## Out of Scope

- 删 legacy `Plugin` 表 / 下线废弃服务 / 迁 `PluginInstallation`/`PluginRating` 强 FK（全部 phase2）。
- 任何新功能开发（v4 已齐）。
- 双写 legacy（无需，直接用 v4）。

## Notes

- 本阶段**阻塞于运行时操作**：需先在 phase0 审核页 approve 一个真实 v4 release（detail-poster 0.2.4 即样本）才能验证 R1-R4。本会话无法独立完成验证。
- 若验证中发现真实缺口（如某指标未填充），再转实现并补 design.md；目前代码层无缺口。
- phase0 前端改动需重新构建 collab-admin 部署后后台才生效。
