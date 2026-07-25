# BillingController

源码：`apps/collab-api/src/modules/billing.controller.ts`

控制器基路径：`/api/admin/billing`

除登录、安装向导、公开目录等明确公开接口外，请携带 `Authorization: Bearer <token>`。平台或团队权限以控制器上的守卫和 `@RequirePermission` 为准。

## 端点

| 方法 | 路径 | 处理器 |
|---|---|---|
| `GET` | `/api/admin/billing/pools` | `listPools()` |
| `POST` | `/api/admin/billing/pools` | `createPool()` |
| `PATCH` | `/api/admin/billing/pools/:id` | `updatePool()` |
| `DELETE` | `/api/admin/billing/pools/:id` | `deletePool()` |
| `GET` | `/api/admin/billing/channels` | `listChannels()` |
| `GET` | `/api/admin/billing/channels/:id` | `channelDetail()` |
| `POST` | `/api/admin/billing/channels` | `createChannel()` |
| `PATCH` | `/api/admin/billing/channels/:id` | `updateChannel()` |
| `DELETE` | `/api/admin/billing/channels/:id` | `deleteChannel()` |
| `POST` | `/api/admin/billing/channels/:id/test` | `testChannel()` |
| `POST` | `/api/admin/billing/channels/:id/test-chat` | `testChannelChat()` |
| `POST` | `/api/admin/billing/channels/:id/test-image` | `testChannelImage()` |
| `GET` | `/api/admin/billing/pricing` | `listPricing()` |
| `POST` | `/api/admin/billing/pricing` | `upsertPricing()` |
| `PATCH` | `/api/admin/billing/pricing/:id` | `updatePricing()` |
| `DELETE` | `/api/admin/billing/pricing/:id` | `deletePricing()` |
| `GET` | `/api/admin/billing/credits/teams` | `creditTeams()` |
| `GET` | `/api/admin/billing/credits/teams/:teamId` | `teamCredits()` |
| `GET` | `/api/admin/billing/credits/teams/:teamId/ledger` | `teamLedger()` |
| `POST` | `/api/admin/billing/credits/teams/:teamId/adjustments` | `adjustCredits()` |
| `GET` | `/api/admin/billing/call-logs` | `callLogs()` |
| `GET` | `/api/admin/billing/call-logs/:id` | `callLogDetail()` |

## 请求与响应

请求体、查询参数和响应字段以同目录 DTO、服务方法及开发环境 Swagger 为准。失败响应统一包含稳定 `code`、可读 `message` 和 `requestId`；不要根据中文消息分支业务逻辑。

