// PlatformApiKeyService —— 平台 API Key 发放与管理。
//
// 设计（见 docs/billing-and-relay-design.md §6.2）：
//  - 明文格式 lf_<32hex>；库存只存 sha256(keyHash)，明文仅创建时返回一次。
//  - 归属团队（消费扣该团队灵石）；scopes 白名单限定能力。
//  - 用户自助：/api/me/api-keys（创建/列表/吊销）；管理员总览：/api/admin/api-keys（吊销）。
//  - keyPrefix = lf_ + 明文前 8 位（列表展示用，非敏感）。
import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma.service';
import { AppError, badRequest } from '../common';
import { PLATFORM_KEY_PREFIX } from '../dual-auth.guard';

/** 生成明文 key：lf_ + 32 hex（256 位熵）。 */
function generatePlaintextKey(): string {
  return PLATFORM_KEY_PREFIX + randomBytes(16).toString('hex');
}

/** sha256(明文)（与 DualAuthGuard.hashPlatformKey 同算法）。 */
function hashKey(plain: string): string {
  return createHash('sha256').update(plain, 'utf8').digest('hex');
}

@Injectable()
export class PlatformApiKeyService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** 当前用户当前团队的 key 列表（脱敏，无明文/keyHash）。 */
  async listForUser(userId: string, teamId: string) {
    const keys = await this.prisma.platformApiKey.findMany({
      where: { teamId },
      orderBy: { createdAt: 'desc' },
    });
    return { apiKeys: keys.map((k) => this.publicView(k)) };
  }

  /** 创建 key（归属当前团队，创建者=当前用户）。明文仅返回一次。 */
  async createForUser(userId: string, teamId: string, input: { name?: string; scopes?: string[]; noExpire?: boolean }) {
    const scopes = this.normalizeScopes(input.scopes);
    const plaintext = generatePlaintextKey();
    const keyHash = hashKey(plaintext);
    const created = await this.prisma.platformApiKey.create({
      data: {
        teamId,
        name: input.name?.trim() || '默认',
        keyPrefix: plaintext.slice(0, PLATFORM_KEY_PREFIX.length + 8),
        keyHash,
        scopes,
        status: 'ACTIVE',
        createdById: userId,
        expiresAt: input.noExpire ? null : new Date(Date.now() + 365 * 24 * 3600 * 1000),
      },
    });
    await this.audit(userId, 'apikey.created', created.id, { teamId, name: created.name, scopes });
    // plaintext 仅此一次返回；publicView 不含它。
    return { ...this.publicView(created), plaintextKey: plaintext };
  }

  /** 用户吊销自己的 key（限本团队）。 */
  async revokeForUser(userId: string, teamId: string, id: string) {
    const key = await this.prisma.platformApiKey.findFirst({ where: { id, teamId } });
    if (!key) throw new AppError(404, 'api_key_not_found', 'API Key 不存在');
    await this.prisma.platformApiKey.update({ where: { id }, data: { status: 'DISABLED' } });
    await this.audit(userId, 'apikey.revoked', id, { teamId, name: key.name });
    return { ok: true };
  }

  /** admin 总览（全部团队）。 */
  async adminList() {
    const keys = await this.prisma.platformApiKey.findMany({
      orderBy: { createdAt: 'desc' },
      include: { team: { select: { name: true } } },
    });
    return { apiKeys: keys.map((k) => ({ ...this.publicView(k), teamName: k.team.name })) };
  }

  /** admin 吊销任意 key。 */
  async adminRevoke(actorId: string, id: string) {
    const key = await this.prisma.platformApiKey.findUnique({ where: { id } });
    if (!key) throw new AppError(404, 'api_key_not_found', 'API Key 不存在');
    await this.prisma.platformApiKey.update({ where: { id }, data: { status: 'DISABLED' } });
    await this.audit(actorId, 'admin.apikey.revoked', id, { teamId: key.teamId, name: key.name });
    return { ok: true };
  }

  // === 内部 ===

  /** scopes 白名单：chat/image/tier:fast/tier:premium；空数组默认全放行（['*']）。 */
  private normalizeScopes(scopes?: string[]): string[] {
    const allowed = new Set(['chat', 'image', 'action', 'tier:fast', 'tier:premium']);
    const cleaned = (scopes ?? []).map((s) => s.trim()).filter((s) => allowed.has(s));
    return cleaned.length ? cleaned : ['*'];
  }

  private publicView(k: {
    id: string; teamId: string; name: string; keyPrefix: string; scopes: string[];
    status: string; lastUsedAt: Date | null; expiresAt: Date | null; createdAt: Date;
  }) {
    return {
      id: k.id,
      teamId: k.teamId,
      name: k.name,
      keyPrefix: k.keyPrefix,
      scopes: k.scopes,
      status: k.status as 'ACTIVE' | 'DISABLED',
      lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
      expiresAt: k.expiresAt?.toISOString() ?? null,
      createdAt: k.createdAt.toISOString(),
    };
  }

  private async audit(actorUserId: string, action: string, targetId: string, metadata: unknown) {
    await this.prisma.auditLog.create({
      data: { actorUserId, action, targetType: 'PlatformApiKey', targetId, metadata: metadata as object },
    });
  }
}
