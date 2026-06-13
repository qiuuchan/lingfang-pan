import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AuthService } from './auth.service';
import { MeController } from './me.controller';
import { TeamsController, InvitationsController } from './teams.controller';
import { ApplicationsController } from './applications.controller';
import { PluginsController } from './plugins.controller';
import { AdminController } from './admin.controller';
import { WalletController } from './wallet.controller';
import { MarketplaceController } from './marketplace.controller';
import { TeamService } from './team.service';
import { PluginService } from './plugin.service';
import { AdminService } from './admin.service';
import { EconomyService } from './economy.service';
import { MarketplaceService } from './marketplace.service';

@Module({
  controllers: [MeController, TeamsController, InvitationsController, ApplicationsController, PluginsController, AdminController, WalletController, MarketplaceController],
  providers: [PrismaService, AuthService, TeamService, PluginService, AdminService, EconomyService, MarketplaceService],
})
export class CollabModule {}