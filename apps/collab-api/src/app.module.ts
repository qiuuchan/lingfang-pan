import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { PrismaService } from './prisma.service';
import { AuthModule } from './modules/auth.module';
import { CollabModule } from './modules/collab.module';
import { JwtAuthGuard } from './security';
import { DualAuthGuard } from './dual-auth.guard';
import { PermissionsGuard } from './permissions.guard';
import { HealthController, ReadinessService } from './health.controller';
import { AppCacheService, CacheService } from './cache.service';

/**
 * 结构化日志（nestjs-pino）配置。
 *
 * - 格式：dev（NODE_ENV !== 'production'）用 pino-pretty 美化输出便于人工排查；
 *   prod 输出纯 JSON 行，便于日志采集系统（ELK/Loki）结构化检索。
 * - 自动请求日志：pino-http 中间件记录 method/url/status/duration/ip，
 *   trust proxy 已在 main.ts 设为 1 跳，故 ip 为真实客户端 IP。
 * - redact：遮蔽敏感字段（apiKey/password/token/secret/authorization 等），
 *   覆盖 req.body 与 req.headers 两类常见泄漏路径；遮蔽值不落日志。
 *   fast-redact 通配 * 仅匹配单层，故对 body 同时列「顶层 + 一层嵌套」两套路径，
 *   覆盖如 req.body.gateway.apiKey（LLM 网关绑定）这类嵌套敏感字段。
 */
const isProd = process.env.NODE_ENV === 'production';

/**
 * 敏感字段名（按业务实际命名补充，含常见变体）。
 * - authorization：标准 Bearer token 头。
 * - token / refreshToken / accessToken：登录、刷新令牌。
 * - password / newPassword：登录、改密。
 * - apiKey / secret：LLM 网关密钥、第三方凭证。
 */
const sensitiveKeys = [
  'authorization',
  'token',
  'refreshToken',
  'accessToken',
  'password',
  'newPassword',
  'apiKey',
  'secret',
];

/**
 * 构造 redact 路径：对每个敏感键生成「req.body.<key>」（顶层）与「req.body.*.<key>」（一层嵌套），
 * 以及「req.headers.<lower>」（HTTP 头名恒小写）。
 */
function buildRedactPaths(): string[] {
  const paths: string[] = [];
  for (const key of sensitiveKeys) {
    paths.push(`req.body.${key}`); // 顶层请求体字段（如登录 DTO.password）
    paths.push(`req.body.*.${key}`); // 一层嵌套（如 llm 网关绑定 gateway.apiKey）
    paths.push(`req.headers.${key.toLowerCase()}`); // 请求头（Express 已统一小写）
  }
  return paths;
}

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: isProd ? 'info' : 'debug',
        transport: isProd
          ? undefined
          : {
              target: 'pino-pretty',
              options: {
                colorize: true,
                singleLine: true,
                translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
              },
            },
        // 遮蔽敏感字段：请求体（顶层+一层嵌套）与请求头中的 apiKey/password/token/secret/authorization 等。
        redact: {
          paths: buildRedactPaths(),
          censor: '[REDACTED]',
        },
      },
    }),
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
    { provide: AppCacheService, useClass: CacheService },
    ReadinessService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // DualAuthGuard 必须在 JwtAuthGuard 之前：它对非 /api/relay 路径直接放行，
    // 对 /api/relay 路径完成「平台 API Key 或 JWT」双鉴权（relay 端点用 @Public() 跳过 JwtAuthGuard）。
    { provide: APP_GUARD, useClass: DualAuthGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // RBAC 权限守卫：在 JwtAuthGuard 之后（user 已解析），按 @RequirePermission 校验。
    // 未声明权限要求的路由放行（向后兼容），由 service 内部 ensureXxx 兜底。
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
