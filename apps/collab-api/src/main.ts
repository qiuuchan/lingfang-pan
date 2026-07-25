import 'reflect-metadata';
import 'dotenv/config';
import { resolve } from 'node:path';
import { json, urlencoded } from 'express';
import { NestFactory, Reflector } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ValidationPipe, ClassSerializerInterceptor } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AppExceptionFilter } from './common';
import { requireKeyEncryptionKey } from './crypto/credential-cipher';

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

  // LLM apiKey 加密密钥 fail-fast（复刻 JWT_SECRET 模式，design.md §3）。
  // apiKey 属用户凭据保护（非平台安全控制）：AES-256-GCM 密文存库为单一真源，密钥不入库不入 git。
  // 密钥缺失：生产 throw，dev warn 但不生成兜底密钥（首次加解密时 LlmService 调 getLlmKey 抛 llm_key_not_configured）。
  // 密钥格式错（非 64 位 hex）：同样 fail-fast，避免静默用错误密钥加密后无法解密。
  if (!requireKeyEncryptionKey()) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('启动失败：必须设置 LLM_KEY_ENCRYPTION_KEY（64 位 hex，openssl rand -hex 32 生成）');
    }
    console.warn('[安全警告] LLM_KEY_ENCRYPTION_KEY 未设置或格式非法，开发环境继续，生产将拒绝启动。');
  }
  // 本阶段只做启动断言。阶段 2 LlmService 通过 Nest provider token 注入（useFactory: () => getLlmKey()）。

  // SMTP 邮件服务缺失告警：未配 SMTP_URL 时找回密码 / 邮箱验证邮件降级为 console.log（流程不中断）。
  // 与 JWT_SECRET / LLM_KEY 的 fail-fast 不同：邮件是可降级能力（占位兜底），不阻塞启动；
  // 但需醒目告警提醒运维配置，否则生产环境邮件全静默（用户收不到重置 / 验证链接）。
  if (!process.env.SMTP_URL) {
    console.warn('[邮件警告] SMTP_URL 未配置：找回密码 / 邮箱验证邮件将降级输出到 console.log（不实际发送）。生产环境请配置 SMTP_URL="smtps://user:pass@host:465" 后重启。');
  }

  // JSON body 仍需覆盖管理配置、工作流和兼容请求；v4 插件制品上传使用 raw stream，
  // 不经过此 JSON parser。
  // 提到 50MB：插件源码（含 vendor/ 内嵌上游）经 JSON 明文传输，3-5MB 常见，
  // huobao-drama 等含前端构建产物的插件可达 4MB+。50MB 覆盖绝大多数插件，
  // 插件制品字节/文件数上限由 plugin-artifact 检查器兜底。
  // bufferLogs: true 让 NestJS 在 useLogger 注入 pino 前缓冲启动日志，
  // 避免 bootstrap 早期消息走默认 ConsoleLogger 与 pino 输出双轨不一致。
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  // 用 pino Logger 替代 NestJS 默认 ConsoleLogger：框架级日志（路由解析、启动横幅等）
  // 与业务日志（services 内 this.logger.*）统一走 pino，格式/请求上下文/redact 一致。
  app.useLogger(app.get(Logger));
  app.use(json({ limit: '300mb' }));
  app.use(urlencoded({ limit: '300mb', extended: true }));

  // 静态托管 downloads/ 目录（admin 上传的安装包）：
  // /downloads/LingFang_1.0.0_x64-setup.exe → downloads/LingFang_1.0.0_x64-setup.exe。
  const downloadsDir = resolve(process.cwd(), 'downloads');
  const httpAdapter = app.getHttpAdapter();
  const expressInstance = httpAdapter.getInstance();
  if (typeof (expressInstance as { use?: (path: string, handler: unknown) => void }).use === 'function') {
    const express = await import('express');
    (expressInstance as { use: (path: string, handler: unknown) => void }).use('/downloads', express.static(downloadsDir));
  }
  app.use(helmet());
  app.setGlobalPrefix('api');

  // 修复 B3：生产部署在 nginx/Tauri 反代后，未设 trust proxy 时 Express req.ip 取反代 socket IP，
  // 所有请求共享一个 IP 池 → 全局限流 60/min/IP 实际变成「全站每分钟 60 个请求」，
  // 敏感端点 10/min/IP 的防爆破设计失效。生产环境信任最后一跳（自己的反代），req.ip 取真实客户端 IP。
  // 仅信任 1 跳：客户端无法伪造 X-Forwarded-For 绕过限流（trust proxy=true 才会被伪造）。
  // 开发环境无反代，req.ip 直接是 socket IP，保持默认（不设 trust proxy）。
  if (process.env.NODE_ENV === 'production') {
    // NestApplication 不直接暴露 Express 的 .set，通过 HTTP adapter 拿底层 Express instance。
    const httpAdapter = app.getHttpAdapter();
    const expressInstance = httpAdapter.getInstance();
    if (typeof (expressInstance as { set?: (k: string, v: unknown) => void }).set === 'function') {
      (expressInstance as { set: (k: string, v: unknown) => void }).set('trust proxy', 1);
    }
  }

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

  // 大制品上传超时修复：.lfplugin 制品可达 300MB（如 moneyprinter-turbo 内嵌字体/音乐资源），
  // 经慢链路上传总耗时易超过 Node 22 默认 server.requestTimeout（5min），Node 会在请求途中返回
  // 408 Request Timeout（非 JSON body，桌面端报「解析发布响应失败：error decoding response body」），
  // 导致插件发布失败。放宽到可配置值（默认 30min，覆盖 300MB 慢上传）；collab-api 部署在反代后、
  // 真实超时由反代统一管控，body 上限 300MB（json limit）仍兜底最大体积。
  app.getHttpServer().requestTimeout = Number(process.env.HTTP_REQUEST_TIMEOUT_MS ?? 30 * 60 * 1000);

  await app.listen(port, '0.0.0.0');
}

void bootstrap();
