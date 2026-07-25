# PluginSharedStateAdminController

源码：`apps/collab-api/src/modules/plugin-shared-state-admin.controller.ts`

控制器基路径：`/api/api/teams/current/plugin-shared/namespaces`

除登录、安装向导、公开目录等明确公开接口外，请携带 `Authorization: Bearer <token>`。平台或团队权限以控制器上的守卫和 `@RequirePermission` 为准。

## 端点

| 方法 | 路径 | 处理器 |
|---|---|---|
| `GET` | `/api/api/teams/current/plugin-shared/namespaces` | `list()` |
| `GET` | `/api/api/teams/current/plugin-shared/namespaces/:id/export` | `export()` |
| `DELETE` | `/api/api/teams/current/plugin-shared/namespaces/:id` | `delete()` |
| `PUT` | `/api/api/teams/current/plugin-shared/namespaces/:id/reactivate` | `reactivate()` |
| `PUT` | `/api/api/teams/current/plugin-shared/namespaces/:id/values/:key/migrate` | `migrate()` |

## 请求与响应

请求体、查询参数和响应字段以同目录 DTO、服务方法及开发环境 Swagger 为准。失败响应统一包含稳定 `code`、可读 `message` 和 `requestId`；不要根据中文消息分支业务逻辑。

