# AdminRolesController

源码：`apps/collab-api/src/modules/roles.controller.ts`

控制器基路径：`/api/admin/roles`

除登录、安装向导、公开目录等明确公开接口外，请携带 `Authorization: Bearer <token>`。平台或团队权限以控制器上的守卫和 `@RequirePermission` 为准。

## 端点

| 方法 | 路径 | 处理器 |
|---|---|---|
| `GET` | `/api/admin/roles/permissions` | `listPermissions()` |
| `GET` | `/api/admin/roles` | `list()` |
| `GET` | `/api/admin/roles/:id` | `detail()` |
| `POST` | `/api/admin/roles` | `create()` |
| `PATCH` | `/api/admin/roles/:id` | `update()` |
| `DELETE` | `/api/admin/roles/:id` | `remove()` |
| `POST` | `/api/admin/roles/assign` | `assign()` |

## 请求与响应

请求体、查询参数和响应字段以同目录 DTO、服务方法及开发环境 Swagger 为准。失败响应统一包含稳定 `code`、可读 `message` 和 `requestId`；不要根据中文消息分支业务逻辑。

