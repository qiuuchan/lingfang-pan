# Phase1 研究：legacy Plugin 依赖面 + v4 替代映射

> 任务：`07-18-phase1-marketplace-on-v4`。勘察日期 2026-07-18。

## 1. legacy `Plugin` 模型（schema.prisma）

核心字段：`name/description/version/entry/runtimeType/status/visibility/teamId/authorUserId`、市场 `marketplace(bool)/priceCents/installCount/ratingCount/ratingSum`、审核 `reviewStatus/reviewReason/reviewedById/At`、政策 `aiPolicyVersion/Status/Reason`、内容 `files/manifest/capabilities(contentHash)`。

**关联（FK）**：
- `PluginInstallation[]`（强 FK `pluginId`，onDelete Cascade）
- `PluginReview[]`（legacy 审核记录）
- `Purchase[]`（**双写**：`pluginId?` + `packageId?` + `releaseId?`）
- `PluginRating[]`（强 FK `pluginId`）
- `PluginGrant[]`（**双写**：`pluginId?` + `packageId?`）

## 2. legacy `Plugin` 消费点全量（collab-api，排除 spec）

| 文件 | 用途 | 关键行 |
|---|---|---|
| `plugin.service.ts` | legacy CRUD/上传/上下架：create/update/delete/findMany/findUnique | 39,45,57,67,95,104,136,167,178,191,198,208,219,229,240,253,280,346,374,391 |
| `marketplace.service.ts` | **货架列表/详情/安装计数** | 32(list),52(detail),91,123(installCount++),134 |
| `economy.service.ts` | **购买计费**：resolve plugin | 25 |
| `admin.service.ts` | 后台 plugin 管理：审核/编辑/下架/删除/列表/计数 | 151,850,887,894,993,1001,1011,1070,1116,1133,1144,1187,1190,1199 |
| `me.service.ts` | 「我的插件」by authorUserId | 33 |
| `audit-plugin-ai-policy.ts` | 存量政策审计脚本（findMany+update） | 57,76 |

## 3. v4 模型替代映射

### `MarketplaceListing`（v4 市场实体，**字段比 legacy Plugin 更全**）
含：`packageId(unique)`、`currentReleaseId`、`priceCents`、`priceRevision`、`status(DRAFT/ACTIVE/DELISTED)`、`installCount`、`ratingCount`、`ratingSum`、`category`、`qualityTier`、delist 元数据、eligibility/quality 快照等。
→ **货架列表/详情/安装计数/评分聚合全部可从此读取**，无需补字段。

### `PluginPackage`（v4 包）
`id/ownerTeamId/authorUserId/manifestId/name/description/governanceStatus`。
→ 替代 `Plugin` 的身份与归属（name/description/team/author）。

### `PluginRelease`（v4 发行版，不可变）
`id/packageId/version/manifest/fileManifest/sha256/sizeBytes/status/marketReviewStatus/sourceKind/targetPlatform/aiPolicy*`。
→ 替代 `Plugin` 的 version/manifest/files/capabilities/policy；readmeMarkdown 在 detail 路由。

### `Purchase`（已双写）
`pluginId?/packageId?/releaseId?` 三者皆可选 + `settlementVersion(LEGACY_V1)` + 完整结算字段。
→ **phase1 购买单可直接写 `packageId`+`releaseId`，不动 schema**。遗留 `pluginId` 留给存量。

### `PluginGrant`（已双写）
`pluginId?/packageId?` + 唯一约束 `[teamId,pluginId,...]` 与 `[teamId,packageId,...]` 并存。
→ 授权可迁 packageId。

### 仍是 legacy 强 FK（phase2 处理）
- `PluginInstallation.pluginId`（required，Cascade）—— v4 安装可能由桌面端本地跟踪，需确认服务端是否有 v4 安装模型。
- `PluginRating.pluginId`（required）—— 每用户评分记录，聚合已在 MarketplaceListing；phase2 迁移或废弃。
- `PluginReview`（legacy 审核记录，v4 有 `PluginReleaseReview` 替代）。

## 4. 关键结论

**Phase1（货架 + 购买迁 v4）无需任何 Prisma schema 变更**：
- 货架读：`MarketplaceListing`(ACTIVE) join `PluginPackage` join current `PluginRelease`。
- 购买写：`Purchase.packageId`+`releaseId`（字段已存在）。
- 安装计数：写 `MarketplaceListing.installCount++`（已存在）。
- `approveRelease` 已设 `MarketplaceListing.currentReleaseId`（phase0 勘察确认）→ 审批即上架的闭环只需让 storefront 读 listing 而非 Plugin。

**Phase2（退役 Plugin）的硬阻塞**是 `PluginInstallation`/`PluginRating`/`PluginReview` 的强 FK + `plugin.service.ts` 的 legacy CRUD 仍在写。需先确认/建立 v4 安装与评分模型，或建 `Plugin↔PluginPackage` 映射表过渡。

## 5. 待详规确认的开放项

- **Q-A 货架响应契约**：`marketplace.service` 返回的 Plugin 形状被哪些前端/桌面端消费？字段映射到 v4 listing+release 后是否需要 contract 兼容层（同形状适配）还是可直接换形。（影响是否要改 `@lingfang/contract` 类型 + 桌面端）。
- **Q-B economy 购买链路**：`economy.service:25` resolve plugin 后做了什么（计费/扣灵石/分账）；迁到 resolve MarketplaceListing+release 后计费键如何对齐（团队灵石 [[billing-relay-over-byok]]）。
- **Q-C installCount 来源**：`marketplace.service:123` 在 Plugin.installCount++；迁到 MarketplaceListing.installCount++ 后，与桌面端安装激活流是否一致（桌面 activate 是否也调这里）。
- **Q-D v4 安装模型**：服务端是否有 v4 `PluginInstallation` 等价（按 release/package 维度），决定 phase2 能否删 legacy Installation。
- **Q-E legacy `plugin.service` 上传接口**：是否还有非桌面客户端在调（决定 phase2 是 410 还是留兼容期）。

## 6. 决定性发现（2026-07-18 补充）—— phase1 范围大幅收缩

进一步勘察发现 **v4 货架 + 购买 + 权益链路早已存在且桌面端在用**，原 PRD 设想的「大迁移」大部分已完成：

- **v4 货架** `MarketplaceDiscoveryService`（`marketplace-discovery.service.ts`）是完整货架：`catalogForTeam/catalog/home/page` + `findRows/countRows/attachSnapshots/attachPrices`，含分类/质量分级/快照/定价。桌面端市场浏览走 `GET /api/plugin-registry/marketplace`（`plugin-registry.ts:157`）→ `discovery.catalogForTeam`。**桌面已在用 v4 货架。**
- **v4 购买** `marketplace-commerce.service.ts:purchaseV2`：按 `packageId` 读 `MarketplaceListing`→`currentRelease`，写 `Purchase(packageId, releaseId)`（**无 pluginId**）+ `pluginEntitlement(teamId,packageId)`，带幂等键/折扣/活动/结算V2/退款。路由 `POST /api/plugin-packages/:id/purchase`（`plugin-registry.controller.ts:137`），桌面端 `plugin-registry.ts:507` 调用。**桌面已在用 v4 购买。**
- **审批→上架闭环**：`approveRelease` 设 `MarketplaceListing.currentReleaseId` + status ACTIVE（phase0 勘察确认）→ discovery 列出 → purchaseV2 可购。**链路全程已通**（phase0 修的是审核入口可见性，不是这条链）。
- **legacy `marketplace.service`（`@Controller('marketplace')`，search/detail/install/rate）+ `economy.service` 基本废弃**：collab-admin 与 desktop **都不调** `/api/marketplace/*`；`EconomyService` 无活跃调用方（仅 collab.module 注释提及）。疑为旧 web 货架残留或死代码。

### phase1 实际剩余工作（远小于原 PRD）

1. **端到端验证**（核心）：approve 一个 v4 release（如 detail-poster 0.2.4）→ discovery 能搜到 → 桌面能下单 → 权益/计费正确。大概率已通，需实测坐实。
2. **参与度指标缺口（唯一可能的实质改动）**：`MarketplaceListing.installCount/ratingCount/ratingSum` 是否被 v4 流填充？legacy 的自增在 `marketplace.service.install/rate`（废弃）；v4 的 `purchaseV2` 不自增 installCount，且未见 v4 评分端点。若 v4 货架显示 0 安装/0 评分，需补：v4 安装计数来源（桌面激活回执？）+ v4 评分接口（迁 `rate` 到 packageId）。**待实测确认是否真缺。**
3. **legacy 残留识别**：确认 `marketplace.service`/`economy.service`/`plugin.service` legacy CRUD/`admin` legacy-plugin 端点无任何外部消费（旧 web/第三方），归入 phase2 清理。

### 对 epic 的影响

- phase1 由「迁移 marketplace/economy 到 v4」降级为「验证 v4 闭环 + 补参与度指标（如缺）+ 圈定 legacy 残留」。
- phase2（退役 legacy）范围相对明确：删废弃服务（marketplace/economy/plugin.service legacy + admin legacy-plugin 端点）+ 迁 `PluginInstallation`/`PluginRating`（强 FK）+ 删 `Plugin` 表。
- **整体 epic 比初判小得多**：v4 已是事实主路径，legacy 多为废弃层。
