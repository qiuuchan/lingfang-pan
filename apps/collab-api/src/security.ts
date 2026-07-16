import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import jwt from 'jsonwebtoken';
import { timingSafeEqual } from 'node:crypto';
import { PrismaService } from './prisma.service';
import { AppError, IS_PUBLIC_KEY, unauthorized, type AuthUser } from './common';

export const WEB_SESSION_COOKIE = 'lingfang_web_session';
export const WEB_CSRF_COOKIE = 'lingfang_web_csrf';

function cookieValue(request: Request, name: string): string {
  const header = request.header('cookie') || '';
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(separator + 1).trim()); } catch { return ''; }
  }
  return '';
}

export function webSessionToken(request: Request): string {
  const path = request.path || request.originalUrl || '';
  return path.startsWith('/web/') || path.startsWith('/api/web/') ? cookieValue(request, WEB_SESSION_COOKIE) : '';
}

export function requireWebCsrf(request: Request): void {
  const expected = cookieValue(request, WEB_CSRF_COOKIE);
  const supplied = request.header('x-csrf-token') || '';
  const valid = expected && supplied && expected.length === supplied.length
    && timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
  if (!valid) {
    throw new AppError(403, 'csrf_invalid', 'CSRF 校验失败，请刷新页面后重试');
  }
}

/**
 * 全局 JWT 守卫。
 *
 * 修复 ADMIN-02 / AUTH-01 / XERR-02：此前仅校验 JWT 签名，被禁用用户的旧 token 在 7 天有效期内仍可用，
 * 且 /auth/refresh 会主动续命。现回查 user.status 与 user.tokenVersion：
 * - status !== 'ACTIVE' 直接拒绝（覆盖禁用、软删除）；
 * - tokenVersion 与 payload 不一致则拒绝（adminDeleteUser/adminUpdateUser 自增 tokenVersion 即吊销旧 token）。
 *
 * 为避免每个受保护请求都查库，采用「签名校验 + payload 完整性」前置 + 「关键端点查库」分层；
 * 此处在守卫层统一回查 status/tokenVersion，因为本平台并发量低（团队内部），正确性优先于性能。
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const header = request.header('authorization') || '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
    const cookieToken = bearer ? '' : webSessionToken(request);
    const token = bearer || cookieToken;
    if (!token) throw unauthorized();

    if (cookieToken && !['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase())) requireWebCsrf(request);

    let payload: jwt.JwtPayload;
    try {
      // 修复 XSEC-04：显式限定 algorithms 白名单，防御算法混淆。
      // 修复 XSEC-04：JWT_SECRET 缺失直接抛错而非回退弱默认值（与 main.ts 启动断言配合）。
      const secret = process.env.JWT_SECRET;
      if (!secret) throw unauthorized('服务端未配置密钥');
      payload = jwt.verify(token, secret, { algorithms: ['HS256'] }) as jwt.JwtPayload;
      if (!payload.sub || !payload.email) throw unauthorized();
      if (payload.teamId !== null && typeof payload.teamId !== 'string') throw unauthorized();
      if (!Number.isInteger(payload.teamContextVersion)) throw unauthorized();
    } catch {
      throw unauthorized('登录已过期，请重新登录');
    }

    // 回查库校验吊销：status 与 tokenVersion 任一不符即拒绝。
    // RBAC：顺带 select platformRoleId 供 PermissionsGuard 解析平台角色权限（避免二次查库）。
    const user = await this.prisma.user.findUnique({
      where: { id: String(payload.sub) },
      select: { status: true, tokenVersion: true, teamContextVersion: true, platformRole: true, platformRoleId: true },
    });
    if (!user || user.status !== 'ACTIVE') throw unauthorized('账号已被禁用，请联系管理员');
    if (payload.tokenVersion !== undefined && Number(payload.tokenVersion) !== user.tokenVersion) {
      throw unauthorized('登录已过期，请重新登录');
    }
    if (Number(payload.teamContextVersion) !== user.teamContextVersion) {
      throw unauthorized('团队会话已变更，请重新登录');
    }

    request.user = {
      id: String(payload.sub),
      email: String(payload.email),
      platformRole: user.platformRole === 'PLATFORM_ADMIN' ? 'PLATFORM_ADMIN' : 'NONE',
      tokenVersion: user.tokenVersion,
      teamId: payload.teamId,
      teamContextVersion: user.teamContextVersion,
      platformRoleId: user.platformRoleId,
    };
    return true;
  }
}
