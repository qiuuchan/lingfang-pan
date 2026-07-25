# AdminController

源码：`apps/collab-api/src/modules/admin.controller.ts`

控制器基路径：`/api/admin`

除登录、安装向导、公开目录等明确公开接口外，请携带 `Authorization: Bearer <token>`。平台或团队权限以控制器上的守卫和 `@RequirePermission` 为准。

## 端点

| 方法 | 路径 | 处理器 |
|---|---|---|
| `GET` | `/api/admin/dashboard` | `dashboard()` |
| `GET` | `/api/admin/stats/generation` | `generationStats()` |
| `GET` | `/api/admin/stats/finance` | `financeStats()` |
| `GET` | `/api/admin/users` | `users()` |
| `GET` | `/api/admin/users/options` | `userOptions()` |
| `POST` | `/api/admin/users` | `createUser()` |
| `PATCH` | `/api/admin/users/:id` | `updateUser()` |
| `DELETE` | `/api/admin/users/:id` | `deleteUser()` |
| `GET` | `/api/admin/users/:id/detail` | `userDetail()` |
| `GET` | `/api/admin/users/:id/logins` | `userLogins()` |
| `GET` | `/api/admin/users/:id/teams` | `userTeams()` |
| `GET` | `/api/admin/users/:id/wallet` | `userWallet()` |
| `POST` | `/api/admin/users/:id/reset-password` | `resetUserPassword()` |
| `PATCH` | `/api/admin/users/:id/platform-role` | `updateUserPlatformRole()` |
| `GET` | `/api/admin/teams` | `teams()` |
| `POST` | `/api/admin/teams` | `createTeam()` |
| `PATCH` | `/api/admin/teams/:id` | `updateTeam()` |
| `DELETE` | `/api/admin/teams/:id` | `deleteTeam()` |
| `POST` | `/api/admin/teams/:id/admins` | `setTeamAdmin()` |
| `DELETE` | `/api/admin/teams/:teamId/admins/:userId` | `revokeTeamAdmin()` |
| `POST` | `/api/admin/teams/:teamId/balance-adjustments` | `adjustBalance()` |
| `GET` | `/api/admin/teams/:id/members` | `teamMembers()` |
| `PATCH` | `/api/admin/teams/:id/members/:userId/role` | `updateMemberRole()` |
| `PATCH` | `/api/admin/teams/:id/status` | `updateTeamStatus()` |
| `GET` | `/api/admin/teams/:id/detail` | `teamDetail()` |
| `GET` | `/api/admin/teams/:id/plugins` | `teamPlugins()` |
| `GET` | `/api/admin/teams/:id/purchases` | `teamPurchases()` |
| `GET` | `/api/admin/teams/:id/ledger` | `teamLedger()` |
| `GET` | `/api/admin/plugins` | `plugins()` |
| `GET` | `/api/admin/plugins/review-pending` | `reviewPendingPlugins()` |
| `POST` | `/api/admin/plugins` | `createPlugin()` |
| `POST` | `/api/admin/plugins/:id/approve` | `approvePlugin()` |
| `POST` | `/api/admin/plugins/:id/reject` | `rejectPlugin()` |
| `PATCH` | `/api/admin/plugins/:id` | `updatePlugin()` |
| `POST` | `/api/admin/plugins/:id/delist` | `delistPlugin()` |
| `DELETE` | `/api/admin/plugins/:id` | `deletePlugin()` |
| `GET` | `/api/admin/plugins/:id/audit-history` | `pluginAuditHistory()` |
| `GET` | `/api/admin/team-admin-applications` | `applications()` |
| `GET` | `/api/admin/team-admin-applications/:id` | `application()` |
| `POST` | `/api/admin/team-admin-applications/:id/approve` | `approve()` |
| `POST` | `/api/admin/team-admin-applications/:id/reject` | `reject()` |
| `GET` | `/api/admin/audit-logs` | `auditLogs()` |
| `GET` | `/api/admin/audit-logs/:id` | `auditLog()` |
| `GET` | `/api/admin/audit-categories` | `auditCategories()` |
| `GET` | `/api/admin/admins/:id/activity` | `adminActivity()` |
| `GET` | `/api/admin/releases` | `listReleases()` |
| `GET` | `/api/admin/releases/:id` | `getRelease()` |
| `POST` | `/api/admin/releases` | `createRelease()` |
| `PATCH` | `/api/admin/releases/:id` | `updateRelease()` |
| `POST` | `/api/admin/releases/:id/publish` | `publishRelease()` |
| `POST` | `/api/admin/releases/:id/archive` | `archiveRelease()` |
| `DELETE` | `/api/admin/releases/:id` | `deleteRelease()` |
| `POST` | `/api/admin/releases/:id/assets` | `addReleaseAsset()` |
| `POST` | `/api/admin/releases/:id/assets/upload` | `uploadReleaseAsset()` |
| `DELETE` | `/api/admin/releases/:id/assets/:assetId` | `deleteReleaseAsset()` |
| `GET` | `/api/admin/settings` | `listSettings()` |
| `PATCH` | `/api/admin/settings` | `updateSettings()` |
| `GET` | `/api/admin/settings/smtp` | `smtpSettings()` |
| `POST` | `/api/admin/settings/test-email` | `testEmail()` |
| `GET` | `/api/admin/settings/geetest` | `geetestSettings()` |
| `POST` | `/api/admin/settings/test-captcha` | `testCaptcha()` |
| `GET` | `/api/admin/settings/gitee` | `giteeSettings()` |
| `GET` | `/api/admin/settings/search` | `searchSettings()` |
| `GET` | `/api/admin/settings/rbflow` | `rbflowSettings()` |
| `POST` | `/api/admin/settings/test-rbflow` | `testRbflow()` |
| `POST` | `/api/admin/settings/test-gitee` | `testGitee()` |
| `POST` | `/api/admin/settings/reveal-secret` | `revealSecret()` |

## 请求与响应

请求体、查询参数和响应字段以同目录 DTO、服务方法及开发环境 Swagger 为准。失败响应统一包含稳定 `code`、可读 `message` 和 `requestId`；不要根据中文消息分支业务逻辑。

