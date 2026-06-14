import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AuthService } from './auth.service';
import { MeController } from './me.controller';
import { TeamsController, InvitationsController } from './teams.controller';
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
  controllers: [MeController, TeamsController, InvitationsController, ApplicationsController, PluginsController, AdminController, LlmController, WalletController, MarketplaceController, ReleaseController],
  providers: [PrismaService, AuthService, TeamService, PluginService, AdminService, LlmService, EconomyService, MarketplaceService, ReleaseService],
})
export class CollabModule {}