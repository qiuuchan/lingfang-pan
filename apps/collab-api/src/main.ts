import 'reflect-metadata';
import { resolve } from 'node:path';
import { json, urlencoded } from 'express';
import { NestFactory, Reflector } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ValidationPipe, ClassSerializerInterceptor } from '@nestjs/common';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AppExceptionFilter } from './common';

/** 读取 package.json 版本号（与 /api/health 保持单一来源，修复 XCONTRACT-01）。 */
function readPackageVersion(): string {
  // tsx 运行时 __dirname 指向 src/，package.json 在上级。
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pkg = require(resolve(__dirname, '..', 'package.json')) as { version?: string };
  return pkg.version || '0.0.0';
}

async function bootstrap() {
  // 根因修复（AUTH-04 / XSEC-04）：JWT_SECRET 缺失或过短时启动期 fail-fast，
  // 杜绝回退到公开默认值 'dev-collab-change-me' 导致任意 token 可伪造。
  // 凭证伪造会使全平台失守，属数据完整性防线而非附加安全控制，不可妥协。
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 16) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('启动失败：必须设置 JWT_SECRET 环境变量（不少于 16 字符）');
    }
    console.warn('[安全警告] JWT_SECRET 未设置或过短，开发环境继续运行，生产环境将拒绝启动。');
  }

  // 修复 PPK-04：默认 body parser limit 仅 100KB，使 plugin-package 的 2MiB 上传约束不可达
  // （上传超 100KB 直接 413，到不了 normalizePluginPackage 的字节校验）。
  // 提到 2MiB 与插件包总上限对齐。
  const app = await NestFactory.create(AppModule);
  app.use(json({ limit: '2mb' }));
  app.use(urlencoded({ limit: '2mb', extended: true }));
  app.use(helmet());
  app.setGlobalPrefix('api');

  // 根因修复（XSEC-01）：全局 ValidationPipe —— 此前所有 @Body 的 TS 类型注解运行时被擦除，
  // Express 原样接收客户端 JSON，是越权字段透传、浮点进 Int 列、非法枚举值等十余条缺陷的共同根因。
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // 剥离未声明字段（防越权字段透传）
      forbidNonWhitelisted: true, // 出现未声明字段直接 400（而非静默剥离）
      transform: true, // 字符串参数自动转型（query/param 的 number 等）
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalFilters(new AppExceptionFilter());
  app.useGlobalInterceptors(new ClassSerializerInterceptor(app.get(Reflector)));

  // 根因修复（XSEC-02）：CORS 未配置时 fail-close（拒绝跨域），而非 reflect 任意 Origin。
  const origins = (process.env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (origins.length === 0) {
    console.warn('[安全警告] CORS_ALLOWED_ORIGINS 未配置，CORS 将拒绝所有跨域请求（fail-close）。');
  }
  app.enableCors({
    origin: origins.length ? origins : false,
    credentials: true,
  });

  const version = readPackageVersion();
  const config = new DocumentBuilder()
    .setTitle('LingFang Collab API')
    .setDescription('三平台多租户协作系统统一 API')
    .setVersion(version) // 修复 XCONTRACT-01：与 package.json 统一
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  // 修复 XSEC-03：生产环境关闭 Swagger 文档面（含 admin/* 全套接口契约，不应公开）。
  if (process.env.NODE_ENV !== 'production') {
    SwaggerModule.setup('api/docs', app, document, { jsonDocumentUrl: '/api/docs-json' });
  }

  const port = Number(process.env.PORT || 3000);
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
