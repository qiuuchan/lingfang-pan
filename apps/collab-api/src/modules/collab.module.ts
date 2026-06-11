import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AuthService } from './auth.service';
import { MeController } from './me.controller';
import { TeamsController, InvitationsController } from './teams.controller';
import { ApplicationsController } from './applications.controller';
import { PluginsController } from './plugins.controller';
import { AdminController } from './admin.controller';
import { CollabService } from './collab.service';

@Module({
  controllers: [MeController, TeamsController, InvitationsController, ApplicationsController, PluginsController, AdminController],
  providers: [PrismaService, AuthService, CollabService],
})
export class CollabModule {}