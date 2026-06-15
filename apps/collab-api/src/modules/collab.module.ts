import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
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
import { NotificationService } from './notification.service';
import { MeService } from './me.service';

@Module({
  controllers: [MeController, PublicTeamsController, TeamsController, InvitationsController, ApplicationsController, PluginsController, AdminController, LlmController, WalletController, MarketplaceController, ReleaseController, PlatformInfoController, NotificationController, SetupController],
  // CollabModule 直接声明 AuthService（与 AuthModule 重复声明，历史架构；TeamService 等注入之），
  // 故 MailService / GeetestService（AuthService 依赖）也需在此提供，否则 DI 在 CollabModule 实例化 AuthService 时找不到它们。
  // NotificationService 无外部依赖（仅 PrismaService），被 AdminService/EconomyService 注入以在审核/购买成功后埋点触发通知。
  providers: [PrismaService, AuthService, MailService, GeetestService, TeamService, PluginService, AdminService, LlmService, EconomyService, MarketplaceService, ReleaseService, SettingsService, NotificationService, MeService],
})
export class CollabModule {}