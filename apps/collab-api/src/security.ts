import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import jwt from 'jsonwebtoken';
import { IS_PUBLIC_KEY, unauthorized, type AuthUser } from './common';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const header = request.header('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) throw unauthorized();

    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET || 'dev-collab-change-me') as jwt.JwtPayload;
      if (!payload.sub || !payload.email) throw unauthorized();
      request.user = {
        id: String(payload.sub),
        email: String(payload.email),
        platformRole: payload.platformRole === 'PLATFORM_ADMIN' ? 'PLATFORM_ADMIN' : 'NONE',
      };
      return true;
    } catch {
      throw unauthorized('登录已过期，请重新登录');
    }
  }
}