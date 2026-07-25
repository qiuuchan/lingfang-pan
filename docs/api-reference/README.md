# HTTP API 参考

本目录从 `apps/collab-api/src/modules/**/*.controller.ts` 的控制器装饰器核对生成，覆盖当前全部控制器类。应用在 `main.ts` 设置全局 `/api` 前缀，因此表格中的路径是实际 HTTP 路径；控制器自身已带 `api/` 的历史路径会显示为 `/api/api/...`，文档不做隐式修正。

## 通用约定

- 开发环境 Swagger：`http://localhost:<PORT>/api/docs`；JSON：`/api/docs-json`。
- 认证：`Authorization: Bearer <JWT>`；Web 市场会话另使用 Cookie + CSRF。
- 错误：`{ code, message, requestId, details? }`。
- 分页：优先使用端点 DTO 中声明的 `page/pageSize` 或 `cursor/limit`，不要混用。
- 时间：ISO 8601 UTC 字符串；金额以端点命名的 `Cents` 或灵石字段为准。

## 控制器索引（50 个控制器类）

| 控制器 | 端点数 | 源码 |
|---|---:|---|
| [ActionInvocationController](./action-invocation.md) | 6 | `apps/collab-api/src/modules/action-invocation.controller.ts` |
| [AdminTeamRolesController](./admin-team-roles.md) | 6 | `apps/collab-api/src/modules/admin-team-roles.controller.ts` |
| [AdminController](./admin.md) | 67 | `apps/collab-api/src/modules/admin.controller.ts` |
| [ApplicationsController](./applications.md) | 2 | `apps/collab-api/src/modules/applications.controller.ts` |
| [AuthController](./auth.md) | 11 | `apps/collab-api/src/modules/auth.controller.ts` |
| [AutomationScheduleController](./automation-schedule.md) | 6 | `apps/collab-api/src/modules/automation-schedule.controller.ts` |
| [BillingController](./billing.md) | 22 | `apps/collab-api/src/modules/billing.controller.ts` |
| [ChangelogController](./changelog.md) | 1 | `apps/collab-api/src/modules/changelog.controller.ts` |
| [CloudActionDeploymentController](./cloud-action-deployment.md) | 8 | `apps/collab-api/src/modules/cloud-action-deployment.controller.ts` |
| [DesktopExecutorSessionController](./desktop-executor-session.md) | 3 | `apps/collab-api/src/modules/desktop-executor-session.controller.ts` |
| [MarketplaceCommerceController](./marketplace-commerce.md) | 25 | `apps/collab-api/src/modules/marketplace-commerce.controller.ts` |
| [MarketplaceQualityController](./marketplace-quality.md) | 10 | `apps/collab-api/src/modules/marketplace-quality.controller.ts` |
| [MarketplaceController](./marketplace.md) | 4 | `apps/collab-api/src/modules/marketplace.controller.ts` |
| [MeController](./me.md) | 3 | `apps/collab-api/src/modules/me.controller.ts` |
| [NotificationController](./notification.md) | 3 | `apps/collab-api/src/modules/notification.controller.ts` |
| [AdminPermissionGroupsController](./admin-permission-groups.md) | 3 | `apps/collab-api/src/modules/permission-groups.controller.ts` |
| [PermissionGroupsController](./permission-groups.md) | 3 | `apps/collab-api/src/modules/permission-groups.controller.ts` |
| [PlatformInfoController](./platform-info.md) | 1 | `apps/collab-api/src/modules/platform-info.controller.ts` |
| [PluginActionRegistryController](./plugin-action-registry.md) | 2 | `apps/collab-api/src/modules/plugin-action-registry.controller.ts` |
| [PluginAiPolicyController](./plugin-ai-policy.md) | 1 | `apps/collab-api/src/modules/plugin-ai-policy.controller.ts` |
| [PluginGovernanceController](./plugin-governance.md) | 6 | `apps/collab-api/src/modules/plugin-governance.controller.ts` |
| [PluginGrantsController](./plugin-grants.md) | 3 | `apps/collab-api/src/modules/plugin-grants.controller.ts` |
| [PluginRegistryController](./plugin-registry.md) | 16 | `apps/collab-api/src/modules/plugin-registry.controller.ts` |
| [AdminPluginRegistryController](./admin-plugin-registry.md) | 10 | `apps/collab-api/src/modules/plugin-registry.controller.ts` |
| [AdminPluginPackageController](./admin-plugin-package.md) | 5 | `apps/collab-api/src/modules/plugin-registry.controller.ts` |
| [PluginSharedStateAdminController](./plugin-shared-state-admin.md) | 5 | `apps/collab-api/src/modules/plugin-shared-state-admin.controller.ts` |
| [PluginSharedStateController](./plugin-shared-state.md) | 9 | `apps/collab-api/src/modules/plugin-shared-state.controller.ts` |
| [PluginsController](./plugins.md) | 10 | `apps/collab-api/src/modules/plugins.controller.ts` |
| [PoolsController](./pools.md) | 1 | `apps/collab-api/src/modules/pools.controller.ts` |
| [RelayController](./relay.md) | 8 | `apps/collab-api/src/modules/relay/relay.controller.ts` |
| [ReleaseController](./release.md) | 3 | `apps/collab-api/src/modules/release.controller.ts` |
| [AdminRolesController](./admin-roles.md) | 7 | `apps/collab-api/src/modules/roles.controller.ts` |
| [RolesController](./roles.md) | 6 | `apps/collab-api/src/modules/roles.controller.ts` |
| [RuntimeArtifactController](./runtime-artifact.md) | 3 | `apps/collab-api/src/modules/runtime-artifact.controller.ts` |
| [SearchController](./search.md) | 2 | `apps/collab-api/src/modules/search/search.controller.ts` |
| [SetupController](./setup.md) | 2 | `apps/collab-api/src/modules/setup.controller.ts` |
| [PublicTeamsController](./public-teams.md) | 2 | `apps/collab-api/src/modules/teams.controller.ts` |
| [TeamsController](./teams.md) | 12 | `apps/collab-api/src/modules/teams.controller.ts` |
| [InvitationsController](./invitations.md) | 1 | `apps/collab-api/src/modules/teams.controller.ts` |
| [TicketController](./ticket.md) | 5 | `apps/collab-api/src/modules/ticket.controller.ts` |
| [AdminTicketController](./admin-ticket.md) | 5 | `apps/collab-api/src/modules/ticket.controller.ts` |
| [UserCreditsController](./user-credits.md) | 2 | `apps/collab-api/src/modules/user-billing.controller.ts` |
| [WalletController](./wallet.md) | 1 | `apps/collab-api/src/modules/wallet.controller.ts` |
| [WebCloudTrialController](./web-cloud-trial.md) | 3 | `apps/collab-api/src/modules/web-marketplace/web-cloud-trial.controller.ts` |
| [WebMarketplaceController](./web-marketplace.md) | 5 | `apps/collab-api/src/modules/web-marketplace/web-marketplace.controller.ts` |
| [WebPreviewAssetController](./web-preview-asset.md) | 1 | `apps/collab-api/src/modules/web-marketplace/web-preview-asset.controller.ts` |
| [WebPreviewSessionController](./web-preview-session.md) | 2 | `apps/collab-api/src/modules/web-marketplace/web-preview-session.controller.ts` |
| [WebSessionController](./web-session.md) | 6 | `apps/collab-api/src/modules/web-marketplace/web-session.controller.ts` |
| [WorkflowRunController](./workflow-run.md) | 7 | `apps/collab-api/src/modules/workflow-run.controller.ts` |
| [WorkflowExecutorController](./workflow-executor.md) | 4 | `apps/collab-api/src/modules/workflow-run.controller.ts` |

## 快速检查

```powershell
Invoke-RestMethod http://localhost:19006/api/health
Invoke-RestMethod http://localhost:19006/api/docs-json
```

