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
import { LlmController } from './llm.controller';
import { WalletController } from './wallet.controller';
import { MarketplaceController } from './marketplace.controller';
import { ReleaseController } from './release.controller';
import { PlatformInfoController } from './platform-info.controller';
import { ChangelogController } from './changelog.controller';
import { SetupController } from './setup.controller';
import { NotificationController } from './notification.controller';
import { TeamService } from './team.service';
import { PluginService } from './plugin.service';
import { AdminService } from './admin.service';
import { LlmService } from './llm.service';
import { EconomyService } from './economy.service';
import { MarketplaceService } from './marketplace.service';
import { ReleaseService } from './release.service';
import { SettingsService } from './settings.service';
import { GiteeChangelogService } from './gitee-changelog.service';
import { NotificationService } from './notification.service';
import { MeService } from './me.service';
import { RoleService } from './role.service';
import { PluginGrantService } from './plugin-grant.service';
import { PermissionGroupService } from './permission-group.service';
import { RolesController, AdminRolesController } from './roles.controller';
import { AdminTeamRolesController } from './admin-team-roles.controller';
import { PluginGrantsController } from './plugin-grants.controller';
import { AdminPermissionGroupsController, PermissionGroupsController } from './permission-groups.controller';

@Module({
  controllers: [MeController, PublicTeamsController, TeamsController, InvitationsController, ApplicationsController, PluginsController, AdminController, AdminRolesController, AdminTeamRolesController, AdminPermissionGroupsController, LlmController, WalletController, MarketplaceController, ReleaseController, PlatformInfoController, ChangelogController, NotificationController, SetupController, RolesController, PluginGrantsController, PermissionGroupsController],
  // CollabModule 直接声明 AuthService（与 AuthModule 重复声明，历史架构；TeamService 等注入之），
  // 故 MailService / GeetestService（AuthService 依赖）也需在此提供，否则 DI 在 CollabModule 实例化 AuthService 时找不到它们。
  // NotificationService 无外部依赖（仅 PrismaService），被 AdminService/EconomyService 注入以在审核/购买成功后埋点触发通知。
  // GiteeChangelogService 被 SettingsService（缓存失效钩子）与 ChangelogController 注入，需在此提供。
  // RBAC：RoleService/PluginGrantService/PermissionGroupService 依赖 PrismaService + AuthService；PluginService 注入 PluginGrantService 做 availablePlugins 授权过滤。
  providers: [PrismaService, { provide: AppCacheService, useClass: CacheService }, AuthService, MailService, GeetestService, TeamService, PluginService, AdminService, LlmService, EconomyService, MarketplaceService, ReleaseService, SettingsService, GiteeChangelogService, NotificationService, MeService, RoleService, PluginGrantService, PermissionGroupService],
})
export class CollabModule {}