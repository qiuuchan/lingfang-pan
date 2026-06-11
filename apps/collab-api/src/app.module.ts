import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PrismaService } from './prisma.service';
import { AuthModule } from './modules/auth.module';
import { CollabModule } from './modules/collab.module';
import { JwtAuthGuard } from './security';
import { HealthController } from './health.controller';

@Module({
  imports: [AuthModule, CollabModule],
  controllers: [HealthController],
  providers: [
    PrismaService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}