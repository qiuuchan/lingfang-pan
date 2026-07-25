# MarketplaceCommerceController

源码：`apps/collab-api/src/modules/marketplace-commerce.controller.ts`

控制器基路径：`/api`

除登录、安装向导、公开目录等明确公开接口外，请携带 `Authorization: Bearer <token>`。平台或团队权限以控制器上的守卫和 `@RequirePermission` 为准。

## 端点

| 方法 | 路径 | 处理器 |
|---|---|---|
| `GET` | `/api/teams/current/plugin-purchases` | `buyerOrders()` |
| `GET` | `/api/teams/current/marketplace-statement` | `sellerStatement()` |
| `GET` | `/api/teams/current/marketplace-statement/daily` | `sellerStatementDaily()` |
| `GET` | `/api/admin/marketplace/refund-requests` | `refundRequests()` |
| `GET` | `/api/admin/marketplace/refund-requests/:id` | `refundRequestDetail()` |
| `POST` | `/api/plugin-purchases/:id/refund-request` | `requestRefund()` |
| `POST` | `/api/admin/marketplace/refund-requests/:id/approve` | `approveRefund()` |
| `POST` | `/api/admin/marketplace/refund-requests/:id/reject` | `rejectRefund()` |
| `POST` | `/api/admin/marketplace/settlement/trigger` | `triggerSettlement()` |
| `POST` | `/api/admin/marketplace/settlement/cutover/drain` | `beginSettlementCutover()` |
| `POST` | `/api/admin/marketplace/settlement/cutover/activate` | `activateSettlementCutover()` |
| `POST` | `/api/admin/marketplace/settlement/cutover/pause` | `pauseSettlementCutover()` |
| `POST` | `/api/admin/marketplace/settlement/cutover/resume` | `resumeSettlementCutover()` |
| `POST` | `/api/admin/marketplace/settlement/backfill` | `backfillSettlement()` |
| `POST` | `/api/admin/marketplace/settlement/reconcile` | `reconcileSettlement()` |
| `GET` | `/api/admin/marketplace/settlement/status` | `settlementStatus()` |
| `GET` | `/api/admin/marketplace/settlement/cutover/status` | `settlementCutoverStatus()` |
| `POST` | `/api/plugin-packages/:id/marketplace-price` | `updatePrice()` |
| `POST` | `/api/plugin-packages/:id/discounts` | `createDiscount()` |
| `POST` | `/api/marketplace-discounts/:id/cancel` | `cancelDiscount()` |
| `POST` | `/api/admin/marketplace/campaigns` | `createCampaign()` |
| `POST` | `/api/admin/marketplace/campaigns/:id/publish` | `publishCampaign()` |
| `POST` | `/api/admin/marketplace/campaigns/:id/cancel` | `cancelCampaign()` |
| `GET` | `/api/marketplace/campaigns/:id/items/:packageId/attribution-token` | `campaignAttributionToken()` |
| `GET` | `/api/admin/marketplace/campaigns/:id/report` | `campaignReport()` |

## 请求与响应

请求体、查询参数和响应字段以同目录 DTO、服务方法及开发环境 Swagger 为准。失败响应统一包含稳定 `code`、可读 `message` 和 `requestId`；不要根据中文消息分支业务逻辑。

