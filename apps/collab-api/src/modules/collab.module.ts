import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AuthService } from './auth.service';
import { MailService } from './mail.service';
import { MeController } from './me.controller';
import { TeamsController, InvitationsController, PublicTeamsController } from './teams.controller';
import { ApplicationsController } from './applications.controller';
import { PluginsController } from './plugins.controller';
import { AdminController } from './admin.controller';
import { LlmController } from './llm.controller';
import { WalletController } from './wallet.controller';
import { MarketplaceController } from './marketplace.controller';
import { ReleaseController } from './release.controller';
import { TeamService } from './team.service';
import { PluginService } from './plugin.service';
import { AdminService } from './admin.service';
import { LlmService } from './llm.service';
import { EconomyService } from './economy.service';
import { MarketplaceService } from './marketplace.service';
import { ReleaseService } from './release.service';

@Module({
  controllers: [MeController, PublicTeamsController, TeamsController, InvitationsController, ApplicationsController, PluginsController, AdminController, LlmController, WalletController, MarketplaceController, ReleaseController],
  // CollabModule 直接声明 AuthService（与 AuthModule 重复声明，历史架构；TeamService 等注入之），
  // 故 MailService（AuthService 依赖）也需在此提供，否则 DI 在 CollabModule 实例化 AuthService 时找不到 MailService。
  providers: [PrismaService, AuthService, MailService, TeamService, PluginService, AdminService, LlmService, EconomyService, MarketplaceService, ReleaseService],
})
export class CollabModule {}