import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
  SetMetadata,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export interface AuthUser {
  id: string;
  email: string;
  platformRole: 'NONE' | 'PLATFORM_ADMIN';
  /** token 版本号，与 user.tokenVersion 比对以实现吊销（见 JwtAuthGuard）。 */
  tokenVersion: number;
  /** JWT 签名绑定的当前团队；null 表示签发时没有 ACTIVE membership。 */
  teamId: string | null;
  /** 当前团队上下文版本，与 User.teamContextVersion 比对以吊销旧团队会话。 */
  teamContextVersion: number;
  /** RBAC：用户挂的平台级角色 id（scope=PLATFORM），由 JwtAuthGuard 回查时填充。null 表示无平台角色。 */
  platformRoleId?: string | null;
}

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'bad_request', message, details);
export const unauthorized = (message = '请先登录') => new AppError(401, 'unauthorized', message);
export const forbidden = (message = '权限不足') => new AppError(403, 'forbidden', message);
export const notFound = (message = '资源不存在') => new AppError(404, 'not_found', message);
export const conflict = (message: string, details?: unknown) =>
  new AppError(409, 'conflict', message, details);
export const insufficientBalance = () => new AppError(402, 'insufficient_balance', '钱包余额不足');
export const clientUpgradeRequired = () =>
  new AppError(410, 'legacy_plugin_api_retired', '旧插件协议已永久停用，请升级桌面客户端后重试');

/**
 * 取或生成请求级 requestId 并回写到 req.headers，确保 service 日志、异常响应、
 * pino HTTP 日志三处使用同一个值。客户端未传 x-request-id 时由首个调用方生成。
 */
export function ensureRequestId(req: Request): string {
  const existing = req.header('x-request-id');
  if (existing) return existing;
  const generated = randomUUID();
  req.headers['x-request-id'] = generated;
  return generated;
}

export function slugify(input: string) {
  const base = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || `team-${Date.now()}`;
}

export const publicUser = (user: {
  id: string;
  email: string;
  displayName: string;
  status: string;
  platformRole?: string;
}) => ({
  id: user.id,
  email: user.email,
  displayName: user.displayName,
  status: user.status,
  platformRole: user.platformRole,
});

export function requireUser(req: Request): AuthUser {
  const user = (req as Request & { user?: AuthUser }).user;
  if (!user) throw unauthorized();
  return user;
}

@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('AppExceptionFilter');

  catch(error: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();
    const requestId = ensureRequestId(request);

    if (error instanceof AppError) {
      response.status(error.status).json({
        code: error.code,
        message: error.message,
        requestId,
        details: error.details,
      });
      return;
    }

    if (error instanceof HttpException) {
      const status = error.getStatus();
      const body = error.getResponse();
      const message =
        typeof body === 'object' && body && 'message' in body
          ? (body as { message?: string | string[] }).message
          : error.message;
      response.status(status).json({
        code: status === HttpStatus.UNAUTHORIZED ? 'unauthorized' : 'http_error',
        message: Array.isArray(message) ? message.join('；') : message || error.message,
        requestId,
      });
      return;
    }

    // 根因修复（XERR-01 及其衍生十余条缺陷）：
    // 把 Prisma 错误翻译为语义化状态码，避免业务冲突被吞成 500，
    // 且不回显 Prisma 原始 message（含表名/字段名/约束名，信息泄漏）。
    if (error instanceof Prisma.PrismaClientValidationError) {
      response.status(400).json({ code: 'bad_request', message: '请求参数校验失败', requestId });
      return;
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      const mapped = mapPrismaKnownError(error);
      response
        .status(mapped.status)
        .json({ code: mapped.code, message: mapped.message, requestId });
      return;
    }

    this.logger.error(
      {
        requestId,
        method: request.method,
        url: request.path,
        errorMessage: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : undefined,
      },
      '未处理异常：已返回 500'
    );
    response.status(500).json({
      code: 'internal_error',
      message: '服务内部错误',
      requestId,
    });
  }
}

/** 把 PrismaClientKnownRequestError 的错误码映射为语义化 HTTP 响应（不泄漏 schema 信息）。 */
function mapPrismaKnownError(error: Prisma.PrismaClientKnownRequestError): {
  status: number;
  code: string;
  message: string;
} {
  switch (error.code) {
    case 'P2002': // 唯一约束冲突
      return { status: 409, code: 'conflict', message: '资源已存在或与现有记录冲突' };
    case 'P2025': // 记录不存在
      return { status: 404, code: 'not_found', message: '资源不存在' };
    case 'P2003': // 外键约束冲突
      return { status: 409, code: 'conflict', message: '存在关联资源，无法完成操作' };
    default:
      return { status: 500, code: 'internal_error', message: '服务内部错误' };
  }
}
