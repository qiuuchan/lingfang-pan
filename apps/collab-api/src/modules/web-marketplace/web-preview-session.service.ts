import { Inject, Injectable } from '@nestjs/common';
import { randomBytes, createHash } from 'node:crypto';
import { AppError, conflict, notFound } from '../../common';
import { PrismaService } from '../../prisma.service';
import { AuthService } from '../auth.service';
import { WebMarketplaceService } from './web-marketplace.service';

@Injectable()
export class WebPreviewSessionService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(WebMarketplaceService) private readonly marketplace: WebMarketplaceService,
  ) {}

  async create(userId: string, packageId: string) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const detail = await this.marketplace.detail(packageId);
    if (detail.preview_mode === 'STATIC_DESKTOP') throw new AppError(409, 'web_preview_unavailable', '该插件仅支持桌面运行');
    const nonce = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    const session = await this.prisma.webPreviewSession.create({ data: {
      userId,
      teamId: membership.teamId,
      packageId,
      releaseId: detail.release_id,
      releaseSha256: detail.release_sha256,
      mode: detail.preview_mode,
      nonceSha256: digest(nonce),
      expiresAt,
    } });
    return {
      session_id: session.id,
      release_id: session.releaseId,
      release_sha256: session.releaseSha256,
      mode: session.mode,
      expires_at: session.expiresAt.toISOString(),
      channel_nonce: nonce,
    };
  }

  async consume(userId: string, sessionId: string, nonce: string) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const session = await this.prisma.webPreviewSession.findFirst({ where: { id: sessionId, userId, teamId: membership.teamId } });
    if (!session) throw notFound('预览会话不存在');
    if (session.expiresAt <= new Date()) throw new AppError(410, 'web_preview_session_expired', '预览会话已过期');
    if (digest(nonce) !== session.nonceSha256) throw new AppError(403, 'web_preview_nonce_invalid', '预览握手 nonce 无效');
    const consumed = await this.prisma.webPreviewSession.updateMany({
      where: { id: session.id, userId, teamId: membership.teamId, consumedAt: null, expiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() },
    });
    if (consumed.count !== 1) throw conflict('预览握手 nonce 已使用');
    return { ok: true, session_id: session.id, mode: session.mode };
  }
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
