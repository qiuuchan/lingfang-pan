# PluginRegistryController

源码：`apps/collab-api/src/modules/plugin-registry.controller.ts`

控制器基路径：`/api`

除登录、安装向导、公开目录等明确公开接口外，请携带 `Authorization: Bearer <token>`。平台或团队权限以控制器上的守卫和 `@RequirePermission` 为准。

## 端点

| 方法 | 路径 | 处理器 |
|---|---|---|
| `POST` | `/api/plugin-registry/releases` | `publish()` |
| `GET` | `/api/plugin-registry/team` | `team()` |
| `GET` | `/api/plugin-registry/manage` | `manage()` |
| `GET` | `/api/plugin-registry/marketplace` | `marketplace()` |
| `GET` | `/api/plugin-packages/:id` | `detail()` |
| `GET` | `/api/plugin-releases/:id` | `releaseDetail()` |
| `GET` | `/api/plugin-releases/:id/workflow-upgrades` | `workflowUpgrades()` |
| `GET` | `/api/plugin-releases/:id/artifact` | `artifact()` |
| `POST` | `/api/plugin-releases/:id/submit-marketplace` | `submit()` |
| `POST` | `/api/plugin-releases/:id/withdraw-marketplace` | `withdraw()` |
| `PATCH` | `/api/plugin-packages/:id/status` | `packageStatus()` |
| `PATCH` | `/api/plugin-releases/:id/status` | `releaseStatus()` |
| `PATCH` | `/api/plugin-packages/:id/marketplace-status` | `marketplaceStatus()` |
| `POST` | `/api/plugin-packages/:id/runtime-access` | `runtimeAccess()` |
| `POST` | `/api/plugin-releases/:id/report-integrity-failure` | `integrityFailure()` |
| `POST` | `/api/plugin-packages/:id/purchase` | `purchase()` |

## 请求与响应

请求体、查询参数和响应字段以同目录 DTO、服务方法及开发环境 Swagger 为准。失败响应统一包含稳定 `code`、可读 `message` 和 `requestId`；不要根据中文消息分支业务逻辑。

