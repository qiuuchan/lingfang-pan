import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AppCacheService, CacheService } from '../cache.service';
import { AuthService } from './auth.service';
import { MailService } from './mail.service';
import { GeetestService } from './geetest.service';
import { MeController } from './me.controller';
import { TeamsController, InvitationsController, PublicTeamsController } from './teams.controller';
import { ApplicationsController } from './applications.controller';
import { PluginsController } from './plugins.controller';
import { AdminController } from './admin.controller';
import { WalletController } from './wallet.controller';
import { MarketplaceController } from './marketplace.controller';
import { ReleaseController } from './release.controller';
import { PlatformInfoController } from './platform-info.controller';
import { ChangelogController } from './changelog.controller';
import { SetupController } from './setup.controller';
import { NotificationController } from './notification.controller';
import { TeamService } from './team.service';
import { AdminService } from './admin.service';
import { AdminTeamsService } from './admin-teams.service';
import { AdminUsersService } from './admin-users.service';
import { AdminApplicationsService } from './admin-applications.service';
import { AdminDashboardService } from './admin-dashboard.service';
import { AdminAuditService } from './admin-audit.service';
import { ReleaseService } from './release.service';
import { SettingsService } from './settings.service';
import { GiteeChangelogService } from './gitee-changelog.service';
import { NotificationService } from './notification.service';
import { MeService } from './me.service';
import { RoleService } from './role.service';
import { PluginGrantService } from './plugin-grant.service';
import { PluginGovernancePolicyService } from './plugin-governance-policy.service';
import { PluginGovernanceService } from './plugin-governance.service';
import { PermissionGroupService } from './permission-group.service';
import { RolesController, AdminRolesController } from './roles.controller';
import { AdminTeamRolesController } from './admin-team-roles.controller';
import { PluginGrantsController } from './plugin-grants.controller';
import {
  AdminPermissionGroupsController,
  PermissionGroupsController,
} from './permission-groups.controller';
import { PricingService } from './pricing.service';
import { CreditService } from './credit.service';
import { ChannelService, ChannelRouterService, PoolService } from './channel.service';
import { RelayController } from './relay/relay.controller';
import { RelayService } from './relay/relay.service';
import { BillingController } from './billing.controller';
import { UserCreditsController } from './user-billing.controller';
import { RelayTeamGuard } from '../relay-team.guard';
import { SearchController } from './search/search.controller';
import { SearchService } from './search/search.service';
import { TicketController, AdminTicketController } from './ticket.controller';
import { TicketService } from './ticket.service';
import { PoolsController } from './pools.controller';
import { TeamPoolService } from './pools.service';
import { ARTIFACT_STORE, createArtifactStore } from './artifact-store';
import {
  AdminPluginPackageController,
  AdminPluginRegistryController,
  PluginRegistryController,
} from './plugin-registry.controller';
import { PluginRegistryService } from './plugin-registry.service';
import { PluginArtifactCleanupService } from './plugin-artifact-cleanup.service';
import { PluginAiPolicyController } from './plugin-ai-policy.controller';
import { PluginGovernanceController } from './plugin-governance.controller';
import { PluginActionRegistryController } from './plugin-action-registry.controller';
import { PluginActionRegistryService } from './plugin-action-registry.service';
import { GovernanceActionAdapter } from './governance-action-adapter';
import { ActionInvocationController } from './action-invocation.controller';
import { ActionInvocationService } from './action-invocation.service';
import { RuntimeArtifactService } from './runtime-artifact.service';
import { RuntimeArtifactController } from './runtime-artifact.controller';
import { WorkflowExecutorController, WorkflowRunController } from './workflow-run.controller';
import { WorkflowRunService } from './workflow-run.service';
import { DesktopExecutorSessionController } from './desktop-executor-session.controller';
import { DesktopExecutorSessionService } from './desktop-executor-session.service';
import { PluginSharedStateController } from './plugin-shared-state.controller';
import { PluginSharedStateAdminController } from './plugin-shared-state-admin.controller';
import { PluginSharedStateService } from './plugin-shared-state.service';
import { CloudActionDeploymentController } from './cloud-action-deployment.controller';
import { CloudActionDeploymentService } from './cloud-action-deployment.service';
import { CloudEndpointSecretCipher } from './cloud-endpoint-secret-cipher';
import { SafeOutboundHttpClient } from './cloud-safe-http';
import { CloudActionRoutingService } from './cloud-action-routing.service';
import { CloudActionGatewayService } from './cloud-action-gateway.service';
import { CloudActionWorkerProcessor } from './cloud-action-worker.processor';
import { CloudPreviewWorkerProcessor } from './cloud-preview-worker.processor';
import { MarketplaceCommerceService } from './marketplace-commerce.service';
import { MarketplaceCommerceQueryService } from './marketplace-commerce-query.service';
import { MarketplaceCommerceController } from './marketplace-commerce.controller';
import { MarketplaceSettlementCutoverService } from './marketplace-settlement-cutover.service';
import { AutomationScheduleController } from './automation-schedule.controller';
import { AutomationScheduleService } from './automation-schedule.service';
import { AutomationScheduleFireProcessor } from './automation-schedule-fire.processor';
import {
  MARKETPLACE_METRIC_REPOSITORY,
  MarketplaceMetricRecorder,
  PrismaMarketplaceMetricRepository,
} from './marketplace-metric-recorder';
import {
  MARKETPLACE_QUALITY_COMPUTATION_REPOSITORY,
  MarketplaceQualityComputationService,
  PrismaMarketplaceQualityComputationRepository,
} from './marketplace-quality-computation.service';
import { resolveAutomationConfig } from '../automation/automation-config';
import { AUTOMATION_CONFIG } from '../automation/automation.tokens';
import { CloudExecutionQuotaService } from './cloud-execution-quota.service';
import { MarketplaceDiscoveryService } from './marketplace-discovery.service';
import { MarketplaceQualityController } from './marketplace-quality.controller';
import { MarketplaceQualityService } from './marketplace-quality.service';
import { MarketplaceQualityDailyScheduler } from './marketplace-quality-daily.scheduler';
import {
  MARKETPLACE_COMMERCE_FACTS_PORT,
  MarketplaceQualityFactsService,
  PrismaMarketplaceCommerceFactsAdapter,
} from './marketplace-quality-facts.service';

@Module({
  controllers: [
    RuntimeArtifactController,
    MarketplaceQualityController,
    MarketplaceCommerceController,
    AutomationScheduleController,
    CloudActionDeploymentController,
    PluginSharedStateAdminController,
    PluginSharedStateController,
    DesktopExecutorSessionController,
    WorkflowExecutorController,
    WorkflowRunController,
    ActionInvocationController,
    PluginActionRegistryController,
    PluginGovernanceController,
    MeController,
    PublicTeamsController,
    TeamsController,
    InvitationsController,
    ApplicationsController,
    PluginsController,
    PluginAiPolicyController,
    PluginRegistryController,
    AdminPluginRegistryController,
    AdminPluginPackageController,
    AdminController,
    AdminRolesController,
    AdminTeamRolesController,
    AdminPermissionGroupsController,
    WalletController,
    MarketplaceController,
    ReleaseController,
    PlatformInfoController,
    ChangelogController,
    NotificationController,
    SetupController,
    RolesController,
    PluginGrantsController,
    PermissionGroupsController,
    RelayController,
    BillingController,
    UserCreditsController,
    SearchController,
    TicketController,
    AdminTicketController,
    PoolsController,
  ],
  // CollabModule 直接声明 AuthService（与 AuthModule 重复声明，历史架构；TeamService 等注入之），
  // 故 MailService / GeetestService（AuthService 依赖）也需在此提供，否则 DI 在 CollabModule 实例化 AuthService 时找不到它们。
  // NotificationService 无外部依赖（仅 PrismaService），被 AdminService 等服务注入以发送业务通知。
  // GiteeChangelogService 被 SettingsService（缓存失效钩子）与 ChangelogController 注入，需在此提供。
  // RBAC：RoleService/PluginGrantService/PermissionGroupService 依赖 PrismaService + AuthService。
  // 计费/中转：PricingService/CreditService/ChannelService(+Router)/RelayService 构成中转计费闭环；
  // RelayController 使用全局 JWT + RelayTeamGuard；BillingController(admin) + UserCreditsController(前台)。
  // TeamPoolService：团队端获取可用资源池（PoolsController，区别于 PoolService 管理端 CRUD）。
  providers: [
    PrismaService,
    { provide: AUTOMATION_CONFIG, useFactory: () => resolveAutomationConfig(process.env) },
    { provide: AppCacheService, useClass: CacheService },
    { provide: ARTIFACT_STORE, useFactory: () => createArtifactStore(process.env) },
    { provide: MARKETPLACE_METRIC_REPOSITORY, useClass: PrismaMarketplaceMetricRepository },
    {
      provide: MARKETPLACE_QUALITY_COMPUTATION_REPOSITORY,
      useClass: PrismaMarketplaceQualityComputationRepository,
    },
    { provide: MARKETPLACE_COMMERCE_FACTS_PORT, useClass: PrismaMarketplaceCommerceFactsAdapter },
    MarketplaceMetricRecorder,
    MarketplaceQualityComputationService,
    MarketplaceQualityFactsService,
    MarketplaceQualityDailyScheduler,
    MarketplaceDiscoveryService,
    MarketplaceQualityService,
    AuthService,
    MailService,
    GeetestService,
    TeamService,
    PluginRegistryService,
    PluginArtifactCleanupService,
    AdminService,
    AdminTeamsService,
    AdminUsersService,
    AdminApplicationsService,
    AdminDashboardService,
    AdminAuditService,
    MarketplaceCommerceService,
    MarketplaceCommerceQueryService,
    MarketplaceSettlementCutoverService,
    ReleaseService,
    SettingsService,
    GiteeChangelogService,
    NotificationService,
    MeService,
    RoleService,
    PluginGrantService,
    PluginGovernancePolicyService,
    PluginGovernanceService,
    PluginActionRegistryService,
    CloudEndpointSecretCipher,
    SafeOutboundHttpClient,
    CloudExecutionQuotaService,
    CloudActionDeploymentService,
    CloudActionRoutingService,
    CloudActionGatewayService,
    GovernanceActionAdapter,
    ActionInvocationService,
    CloudActionWorkerProcessor,
    CloudPreviewWorkerProcessor,
    AutomationScheduleService,
    AutomationScheduleFireProcessor,
    RuntimeArtifactService,
    WorkflowRunService,
    DesktopExecutorSessionService,
    PluginSharedStateService,
    PermissionGroupService,
    PricingService,
    CreditService,
    ChannelService,
    ChannelRouterService,
    PoolService,
    RelayService,
    RelayTeamGuard,
    SearchService,
    TicketService,
    TeamPoolService,
  ],
  exports: [
    PrismaService,
    PluginGovernanceService,
    MarketplaceSettlementCutoverService,
    CloudActionWorkerProcessor,
    CloudPreviewWorkerProcessor,
    AutomationScheduleFireProcessor,
    WorkflowRunService,
  ],
})
export class CollabModule {}
