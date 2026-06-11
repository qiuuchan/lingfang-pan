# Collab API 文档

运行后端后访问：

- Swagger UI：`http://localhost:3000/api/docs`
- OpenAPI JSON：`http://localhost:3000/api/docs-json`

## 认证

所有受保护接口使用 Bearer Token：

```http
Authorization: Bearer <token>
```

错误格式：

```json
{
  "code": "forbidden",
  "message": "权限不足",
  "requestId": "req-id",
  "details": {}
}
```

## 公共认证 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/register` | 本地客户端注册普通用户或提交团队管理员申请 |
| POST | `/api/auth/login` | 本地客户端和管理端共用登录 |
| GET | `/api/auth/me` | 当前用户、团队关系、onboarding 状态 |
| POST | `/api/auth/refresh` | 刷新会话 |
| POST | `/api/auth/logout` | 退出登录 |

## Onboarding 状态

| 状态 | 客户端行为 |
| --- | --- |
| `NEEDS_INVITATION` | 输入团队邀请码 |
| `PENDING_APPROVAL` | 显示团队管理员申请待审批 |
| `APPLICATION_REJECTED` | 展示驳回原因，可重新申请或邀请码加入 |
| `TEAM_SPACE` | 进入团队空间 |
| `TEAM_ADMIN_SPACE` | 进入团队管理入口 |
| `PLATFORM_ADMIN_WEB_ONLY` | 阻断本地客户端，提示使用网页管理端 |

## 前台客户端 API

| 方法 | 路径 | 角色 |
| --- | --- | --- |
| GET | `/api/me/onboarding` | 已登录 |
| POST | `/api/team-admin-applications` | 已登录 |
| GET | `/api/team-admin-applications/me` | 已登录 |
| POST | `/api/invitations/redeem` | 已登录 |
| GET | `/api/teams/current` | 团队成员 |
| GET | `/api/teams/current/members` | 团队成员 |
| DELETE | `/api/teams/current/members/:userId` | 团队管理员 |
| POST | `/api/teams/current/invitations` | 团队管理员 |
| GET | `/api/teams/current/invitations` | 团队管理员 |
| PATCH | `/api/teams/current/invitations/:id/disable` | 团队管理员 |
| GET | `/api/teams/current/balance` | 团队成员 |
| GET | `/api/teams/current/balance-ledger` | 团队成员 |
| POST | `/api/teams/current/consume` | 团队成员 |
| GET | `/api/plugins/available` | 已登录 |

## 管理端 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/dashboard` | 管理端指标 |
| GET/POST/PATCH | `/api/admin/users` | 用户管理 |
| GET/POST/PATCH | `/api/admin/teams` | 团队管理 |
| POST/DELETE | `/api/admin/teams/:id/admins` | 指定/撤销团队管理员 |
| POST | `/api/admin/teams/:id/balance-adjustments` | 调整团队共享余额 |
| GET/POST/PATCH | `/api/admin/plugins` | 平台插件管理 |
| GET | `/api/admin/team-admin-applications` | 审批列表 |
| POST | `/api/admin/team-admin-applications/:id/approve` | 审批通过 |
| POST | `/api/admin/team-admin-applications/:id/reject` | 审批驳回 |
| GET | `/api/admin/audit-logs` | 审计日志 |

## 示例

```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"ChangeMe123!"}'
```