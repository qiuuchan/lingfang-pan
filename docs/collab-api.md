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
| POST | `/api/plugins/upload` | 团队成员，上传插件到团队云端共享空间 |
| GET | `/api/plugins/mine` | 团队成员，当前用户创建的插件 |
| GET | `/api/plugins/available` | 团队成员，当前团队可用插件 |
| POST | `/api/plugins/:id/submit-marketplace` | 作者或团队管理员，提交公共市场审核 |
| POST | `/api/plugins/:id/edit-draft` | 作者或团队管理员，编辑未审核中的插件草稿 |
| POST | `/api/plugins/:id/install` | 团队成员，安装已审核通过的公共市场插件 |

## 管理端 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/dashboard` | 管理端指标 |
| GET/POST/PATCH | `/api/admin/users` | 用户管理 |
| GET/POST/PATCH | `/api/admin/teams` | 团队管理 |
| DELETE | `/api/admin/teams/:id` | 停用团队（软删除，置 status=SUSPENDED） |
| POST/DELETE | `/api/admin/teams/:id/admins` | 指定/撤销团队管理员 |
| POST | `/api/admin/teams/:id/balance-adjustments` | 调整团队共享余额 |
| GET/POST/PATCH | `/api/admin/plugins` | 平台插件管理，POST 仍禁止绕过客户端创建插件 |
| GET | `/api/admin/plugins/review-pending` | 待审核市场插件 |
| POST | `/api/admin/plugins/:id/approve` | 审核通过市场插件 |
| POST | `/api/admin/plugins/:id/reject` | 驳回市场插件 |
| GET | `/api/admin/team-admin-applications` | 审批列表 |
| POST | `/api/admin/team-admin-applications/:id/approve` | 审批通过 |
| POST | `/api/admin/team-admin-applications/:id/reject` | 审批驳回 |
| GET | `/api/admin/audit-logs` | 审计日志 |

## 计费与中转（Relay + 灵石 Credit）

> 权威设计：[docs/billing-and-relay-design.md](billing-and-relay-design.md)

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/relay/v1/chat/completions` | OpenAI 兼容聊天转发（`@Public`，DualAuthGuard 鉴权：平台 API Key 或 JWT；SSE 流式；扣团队灵石） |
| POST | `/api/relay/v1/messages` | Anthropic 兼容消息转发 |
| POST | `/api/relay/v1/images/generations` | AI 生图（按张计费） |
| POST | `/api/relay/v1/images/edits` | 生图编辑（multipart 透传，按张计费） |
| GET  | `/api/relay/v1/models` | 仅返回 `fast`/`premium` 两个版本 |
| GET/POST/PATCH/DELETE | `/api/admin/billing/channels[/:id]` | 渠道 CRUD + 绑定 + 健康测试 |
| GET/POST/DELETE | `/api/admin/billing/pricing[/:id]` | 模型定价 |
| GET/PUT | `/api/admin/billing/tiers[/:tier]` | 模型版本配置 |
| GET | `/api/admin/billing/credits/teams/:teamId[/ledger]` | 团队灵石余额/流水 |
| POST | `/api/admin/billing/credits/teams/:teamId/adjustments` | 调整团队灵石 |
| GET | `/api/admin/billing/call-logs[?teamId&capability&status&...]` | 调用日志多维度查询 |
| GET/DELETE | `/api/admin/billing/api-keys[/:id]` | API Key 总览/吊销 |
| GET | `/api/admin/relay-docs` | Relay 接入文档（markdown） |
| GET/POST/DELETE | `/api/teams/current/api-keys[/:id]` | 当前团队共享 API Key 列表/轮换/吊销（需 `team.api_key.manage`） |
| GET | `/api/teams/current/credits[/ledger]` | 当前团队灵石 |

## 插件云端分享 API

`POST /api/plugins/upload` 请求体：

```json
{
  "manifest": {
    "id": "timer",
    "name": "番茄钟",
    "version": "0.1.0",
    "description": "可配置时长的计时器",
    "runtime_type": "client",
    "entry": "ui/index.html",
    "visibility": "tenant",
    "capabilities": [{ "kind": "ui.view", "reason": "展示插件界面", "risk": "low" }]
  },
  "files": [
    { "path": "manifest.json", "content": "{...}" },
    { "path": "ui/index.html", "content": "<div>...</div>" }
  ],
  "priceCents": 0
}
```

上传约束：

- `manifest.entry` 必须存在于 `files`。
- 文件路径只能是相对路径，不能包含绝对路径、空段、`.`、`..` 或隐藏系统路径段。
- 单文件上限 256 KiB，总包上限 2 MiB，最多 80 个文件。
- 团队内相同 `contentHash` 自动去重并返回已有插件。
- 市场提交流程为 `DRAFT/REJECTED -> PENDING -> APPROVED/PUBLIC` 或 `REJECTED/TEAM`。

## 示例

```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"ChangeMe123!"}'
```
