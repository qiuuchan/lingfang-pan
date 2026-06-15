import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { PrismaService } from './prisma.service';
import { AuthModule } from './modules/auth.module';
import { CollabModule } from './modules/collab.module';
import { JwtAuthGuard } from './security';
import { HealthController } from './health.controller';

/**
 * 全局限流（Top9 解法）：
 * - ThrottlerModule 默认 60 次/分钟/IP（default 命名空间）。
 * - ThrottlerGuard 作为全局守卫启用；敏感端点（login/register/forgot-password/purchase/upload）
 *   用 @Throttle({ default: { limit: 10, ttl: 60000 } }) 收紧到 10 次/分钟。
 * - tracker 默认用 req.ip（Express 的 trust proxy 下取真实客户端 IP）。
 *
 * 与 JwtAuthGuard 的关系：两个守卫均为 APP_GUARD，NestJS 按注册顺序执行。
 * ThrottlerGuard 放前面（先限流再鉴权），降低无效请求的 DB 回查压力。
 */
@Module({
  imports: [
    ThrottlerModule.forRoot([
      {
        ttl: 60_000, // 60 秒窗口
        limit: 60, // 默认 60 次/分钟/IP
      },
    ]),
    AuthModule,
    CollabModule,
  ],
  controllers: [HealthController],
  providers: [
    PrismaService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}