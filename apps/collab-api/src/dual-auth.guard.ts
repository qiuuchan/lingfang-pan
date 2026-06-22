// DualAuthGuard —— relay 端点（/api/relay/**）双鉴权守卫。
//
// 设计（见 docs/billing-and-relay-design.md §4.2）：
//  - relay 端点用 @Public() 跳过全局 JwtAuthGuard，改由本守卫接管（顺序：Throttler → DualAuth → ...）。
//  - 解析 Authorization: Bearer <token>：
//    * token 形如 lf_…（平台 API Key 前缀）→ sha256 → 查 PlatformApiKey.keyHash → 校验 status/expiresAt
//      → 附 request.apiKeyAuth = { teamId, apiKeyId, scopes, userId: null }。
//    * 否则视为 JWT：复用与 JwtAuthGuard 同样的 verify + 回查 user 流程 → 附 request.user（AuthUser）
//      + request.apiKeyAuth = { teamId: 由当前 membership 解析, apiKeyId: null, scopes: ['*'], userId }。
//  - 鉴权结果以 relayAuth 形式附在 request 上（不污染 request.user 的 JWT 语义，供 RelayService 统一消费）。
//  - 安全：API Key 明文永不入库（只存 sha256）；keyHash 查询走 @@index；失败统一 401（不泄漏 key 是否存在）。
import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import jwt from 'jsonwebtoken';
import { createHash } from 'node:crypto';
import { PrismaService } from './prisma.service';
import { AppError, unauthorized } from './common';

/** 平台 API Key 明文前缀（lf_ + 32 hex）。 */
export const PLATFORM_KEY_PREFIX = 'lf_';

/** relay 鉴权结果：挂在 request.apiKeyAuth 上，RelayService 统一消费。 */
export interface RelayAuth {
  /** 消费归属团队（计费扣这里）。 */
  teamId: string;
  /** 发起者用户 id（JWT 调用时为登录用户；平台 API Key 调用时为 null）。 */
  userId: string | null;
  /** 命中的平台 API Key id（平台 Key 调用时非空；JWT 调用时为 null）。 */
  apiKeyId: string | null;
  /** 能力白名单（平台 Key 的 scopes；JWT 调用时为 ['*'] 全放行）。 */
  scopes: string[];
}

declare module 'express' {
  interface Request {
    relayAuth?: RelayAuth;
  }
}

/** 判断 token 是否为平台 API Key（lf_ 前缀）。 */
export function isPlatformKeyToken(token: string): boolean {
  return token.startsWith(PLATFORM_KEY_PREFIX);
}

/** sha256(token) 十六进制 —— 与 PlatformApiKey.keyHash 比对（与创建时同算法）。 */
export function hashPlatformKey(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * relay 端点双鉴权守卫。
 *
 * 挂载方式（app.module.ts）：在 JwtAuthGuard 之前注册为 APP_GUARD，canActivate 内先判断是否 relay 路径；
 * 非 relay 路径直接放行（交给后续 JwtAuthGuard/PermissionsGuard）。
 * relay 路径已用 @Public() 跳过 JwtAuthGuard，由本守卫完成鉴权。
 */
@Injectable()
export class DualAuthGuard implements CanActivate {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    // 仅接管 /api/relay/**；其余路径放行（由 JwtAuthGuard/PermissionsGuard 处理）。
    if (!request.url.startsWith('/api/relay') && !request.url.startsWith('/relay')) {
      return true;
    }

    const header = request.header('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) throw unauthorized('缺少鉴权凭据');

    request.relayAuth = isPlatformKeyToken(token)
      ? await this.authByPlatformKey(token)
      : await this.authByJwt(token);

    // 平台 API Key 命中后异步刷新 lastUsedAt（不阻塞请求；失败忽略）。
    if (request.relayAuth.apiKeyId) {
      void this.prisma.platformApiKey
        .update({ where: { id: request.relayAuth.apiKeyId }, data: { lastUsedAt: new Date() } })
        .catch(() => undefined);
    }
    return true;
  }

  /** 平台 API Key 鉴权：sha256 比对 + 校验状态/过期 + 解析团队。 */
  private async authByPlatformKey(token: string): Promise<RelayAuth> {
    const keyHash = hashPlatformKey(token);
    const apiKey = await this.prisma.platformApiKey.findUnique({
      where: { keyHash },
      select: { id: true, teamId: true, scopes: true, status: true, expiresAt: true },
    });
    // 不区分「不存在」与「已吊销」：统一 401，避免探测 key 是否存在。
    if (!apiKey) throw new AppError(401, 'api_key_invalid', 'API Key 无效');
    if (apiKey.status !== 'ACTIVE') throw new AppError(403, 'api_key_disabled', 'API Key 已被吊销');
    if (apiKey.expiresAt && apiKey.expiresAt.getTime() < Date.now()) {
      throw new AppError(401, 'api_key_invalid', 'API Key 已过期');
    }
    return {
      teamId: apiKey.teamId,
      userId: null,
      apiKeyId: apiKey.id,
      scopes: apiKey.scopes ?? [],
    };
  }

  /** JWT 鉴权：复用 JwtAuthGuard 的 verify + 回查流程，并解析当前团队。 */
  private async authByJwt(token: string): Promise<RelayAuth> {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw unauthorized('服务端未配置密钥');
    let payload: jwt.JwtPayload;
    try {
      payload = jwt.verify(token, secret, { algorithms: ['HS256'] }) as jwt.JwtPayload;
      if (!payload.sub) throw unauthorized();
    } catch {
      throw unauthorized('登录已过期，请重新登录');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: String(payload.sub) },
      select: { id: true, status: true, tokenVersion: true },
    });
    if (!user || user.status !== 'ACTIVE') throw unauthorized('账号不可用');
    if (payload.tokenVersion !== undefined && Number(payload.tokenVersion) !== user.tokenVersion) {
      throw unauthorized('登录已过期，请重新登录');
    }
    // JWT 调用 relay 时，消费归属「当前团队」（取一条 ACTIVE membership；多团队取最近加入）。
    const membership = await this.prisma.teamMembership.findFirst({
      where: { userId: user.id, status: 'ACTIVE' },
      orderBy: { joinedAt: 'desc' },
      select: { teamId: true },
    });
    if (!membership) throw new AppError(403, 'forbidden', '当前用户未归属任何团队');
    return { teamId: membership.teamId, userId: user.id, apiKeyId: null, scopes: ['*'] };
  }
}
