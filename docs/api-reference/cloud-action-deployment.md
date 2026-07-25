# CloudActionDeploymentController

源码：`apps/collab-api/src/modules/cloud-action-deployment.controller.ts`

控制器基路径：`/api/api`

除登录、安装向导、公开目录等明确公开接口外，请携带 `Authorization: Bearer <token>`。平台或团队权限以控制器上的守卫和 `@RequirePermission` 为准。

## 端点

| 方法 | 路径 | 处理器 |
|---|---|---|
| `POST` | `/api/api/cloud-action-deployments` | `create()` |
| `GET` | `/api/api/cloud-actions/:releaseId/:actionId/deployments` | `list()` |
| `POST` | `/api/api/cloud-action-deployments/:id/verify` | `verify()` |
| `POST` | `/api/api/cloud-action-deployments/:id/disable` | `disable()` |
| `POST` | `/api/api/cloud-action-deployments/:id/retire` | `retire()` |
| `POST` | `/api/api/cloud-action-deployments/:id/rotate-secret` | `rotateSecret()` |
| `PUT` | `/api/api/cloud-actions/:releaseId/:actionId/routing` | `updateRouting()` |
| `GET` | `/api/api/cloud-actions/:releaseId/:actionId/routing` | `getRouting()` |

## 请求与响应

请求体、查询参数和响应字段以同目录 DTO、服务方法及开发环境 Swagger 为准。失败响应统一包含稳定 `code`、可读 `message` 和 `requestId`；不要根据中文消息分支业务逻辑。

