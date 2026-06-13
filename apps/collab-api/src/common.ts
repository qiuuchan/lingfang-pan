import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, SetMetadata } from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export interface AuthUser {
  id: string;
  email: string;
  platformRole: 'NONE' | 'PLATFORM_ADMIN';
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

    response.status(500).json({
      code: 'internal_error',
      message: error instanceof Error ? error.message : '服务内部错误',
      requestId,
    });
  }
}