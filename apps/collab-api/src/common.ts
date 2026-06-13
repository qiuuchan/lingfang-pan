import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, SetMetadata } from '@nestjs/common';
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
}

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, 'bad_request', message, details);
export const unauthorized = (message = '请先登录') => new AppError(401, 'unauthorized', message);
export const forbidden = (message = '权限不足') => new AppError(403, 'forbidden', message);
export const notFound = (message = '资源不存在') => new AppError(404, 'not_found', message);
export const conflict = (message: string, details?: unknown) => new AppError(409, 'conflict', message, details);
export const insufficientBalance = () => new AppError(402, 'insufficient_balance', '钱包余额不足');

export function slugify(input: string) {
  const base = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || `team-${Date.now()}`;
}

export const publicUser = (user: { id: string; email: string; displayName: string; status: string; platformRole?: string }) => ({
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
  catch(error: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();
    const requestId = request.header('x-request-id') || randomUUID();

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
      const message = typeof body === 'object' && body && 'message' in body ? (body as { message?: string | string[] }).message : error.message;
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
      response.status(mapped.status).json({ code: mapped.code, message: mapped.message, requestId });
      return;
    }

    response.status(500).json({
      code: 'internal_error',
      message: '服务内部错误',
      requestId,
    });
  }
}

/** 把 PrismaClientKnownRequestError 的错误码映射为语义化 HTTP 响应（不泄漏 schema 信息）。 */
function mapPrismaKnownError(error: Prisma.PrismaClientKnownRequestError): { status: number; code: string; message: string } {
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