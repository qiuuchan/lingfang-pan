# PluginsController

源码：`apps/collab-api/src/modules/plugins.controller.ts`

控制器基路径：`/api/plugins`

除登录、安装向导、公开目录等明确公开接口外，请携带 `Authorization: Bearer <token>`。平台或团队权限以控制器上的守卫和 `@RequirePermission` 为准。

## 端点

| 方法 | 路径 | 处理器 |
|---|---|---|
| `POST` | `/api/plugins/upload` | `upload()` |
| `GET` | `/api/plugins/mine` | `mine()` |
| `GET` | `/api/plugins/available` | `available()` |
| `POST` | `/api/plugins/:id/submit-marketplace` | `submitMarketplace()` |
| `POST` | `/api/plugins/:id/edit-draft` | `editDraft()` |
| `POST` | `/api/plugins/:id/edit-meta` | `editMeta()` |
| `POST` | `/api/plugins/:id/set-price` | `setPrice()` |
| `POST` | `/api/plugins/:id/set-status` | `setStatus()` |
| `POST` | `/api/plugins/:id/install` | `install()` |
| `DELETE` | `/api/plugins/:id` | `deletePlugin()` |

## 请求与响应

请求体、查询参数和响应字段以同目录 DTO、服务方法及开发环境 Swagger 为准。失败响应统一包含稳定 `code`、可读 `message` 和 `requestId`；不要根据中文消息分支业务逻辑。

