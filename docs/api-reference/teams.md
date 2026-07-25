# TeamsController

源码：`apps/collab-api/src/modules/teams.controller.ts`

控制器基路径：`/api/teams/current`

除登录、安装向导、公开目录等明确公开接口外，请携带 `Authorization: Bearer <token>`。平台或团队权限以控制器上的守卫和 `@RequirePermission` 为准。

## 端点

| 方法 | 路径 | 处理器 |
|---|---|---|
| `GET` | `/api/teams/current` | `current()` |
| `GET` | `/api/teams/current/profile` | `profile()` |
| `PATCH` | `/api/teams/current/profile` | `updateProfile()` |
| `GET` | `/api/teams/current/members` | `members()` |
| `DELETE` | `/api/teams/current/members/:userId` | `removeMember()` |
| `POST` | `/api/teams/current/invitations` | `createInvitation()` |
| `GET` | `/api/teams/current/invitations` | `invitations()` |
| `PATCH` | `/api/teams/current/invitations/:id/disable` | `disableInvitation()` |
| `GET` | `/api/teams/current/balance` | `balance()` |
| `GET` | `/api/teams/current/balance-ledger` | `ledger()` |
| `POST` | `/api/teams/current/consume` | `consume()` |
| `PATCH` | `/api/teams/current/default-pool` | `updateDefaultPool()` |

## 请求与响应

请求体、查询参数和响应字段以同目录 DTO、服务方法及开发环境 Swagger 为准。失败响应统一包含稳定 `code`、可读 `message` 和 `requestId`；不要根据中文消息分支业务逻辑。

