// PlatformApiKeyService —— 平台 Relay API Key 发放与管理。
//
// 设计：
//  - 明文格式 lf_<32hex>；库存只存 sha256(keyHash)，明文仅轮换/创建时返回一次。
//  - 归属团队（消费扣该团队灵石）；scopes 白名单限定能力。
//  - 团队管理员在桌面端轮换团队共享 Key；普通成员不能创建、查看明文或配置 Key。
//  - 平台管理员仅做全局总览/吊销。
//  - keyPrefix = lf_ + 明文前 8 位（列表展示用，非敏感）。
import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma.service';
import { AppError, badRequest } from '../common';
import { PLATFORM_KEY_PREFIX } from '../dual-auth.guard';
import { normalizeBillingPage, type BillingPageQuery } from './admin-billing-data';

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

  /** 当前团队的 key 列表（脱敏，无明文/keyHash）。 */
  async listForTeam(teamId: string) {
    const keys = await this.prisma.platformApiKey.findMany({
      where: { teamId },
      orderBy: { createdAt: 'desc' },
    });
    return { apiKeys: keys.map((k) => this.publicView(k)) };
  }

  /**
   * 轮换团队共享 Key：先吊销团队现有 active key，再创建新的无过期 key。
   * 明文仅返回一次；插件/agent 不读取此 key，运行时走宿主登录态或本地桥 token。
   */
  async rotateForTeamAdmin(userId: string, teamId: string, input: { name?: string; scopes?: string[] }) {
    const scopes = this.normalizeScopes(input.scopes);
    const plaintext = generatePlaintextKey();
    const keyHash = hashKey(plaintext);
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.platformApiKey.updateMany({
        where: { teamId, status: 'ACTIVE' },
        data: { status: 'DISABLED' },
      });
      return tx.platformApiKey.create({
        data: {
          teamId,
          name: input.name?.trim() || '团队共享 Key',
          keyPrefix: plaintext.slice(0, PLATFORM_KEY_PREFIX.length + 8),
          keyHash,
          scopes,
          status: 'ACTIVE',
          createdById: userId,
          expiresAt: null,
        },
      });
    });
    await this.audit(userId, 'apikey.rotated', created.id, { teamId, name: created.name, scopes });
    return { ...this.publicView(created), plaintextKey: plaintext };
  }

  /** 兼容内部调用：直接创建 key（归属团队）。明文仅返回一次。 */
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

  /** 团队管理员吊销本团队 key。 */
  async revokeForTeamAdmin(userId: string, teamId: string, id: string) {
    const key = await this.prisma.platformApiKey.findFirst({ where: { id, teamId } });
    if (!key) throw new AppError(404, 'api_key_not_found', 'API Key 不存在');
    await this.prisma.platformApiKey.update({ where: { id }, data: { status: 'DISABLED' } });
    await this.audit(userId, 'apikey.revoked', id, { teamId, name: key.name });
    return { ok: true };
  }

  /** 兼容内部调用：吊销本团队 key。 */
  async revokeForUser(userId: string, teamId: string, id: string) {
    return this.revokeForTeamAdmin(userId, teamId, id);
  }

  /** admin 总览（全部团队）。 */
  async adminList(query: BillingPageQuery & { status?: string } = {}) {
    const { page, pageSize, skip, q } = normalizeBillingPage(query);
    const where = {
      ...(query.status ? { status: query.status as 'ACTIVE' | 'DISABLED' } : {}),
      ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' as const } }, { keyPrefix: { contains: q, mode: 'insensitive' as const } }, { team: { name: { contains: q, mode: 'insensitive' as const } } }] } : {}),
    };
    const [keys, total] = await this.prisma.$transaction([
      this.prisma.platformApiKey.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: pageSize,
      select: { id: true, teamId: true, name: true, keyPrefix: true, scopes: true, status: true, lastUsedAt: true, expiresAt: true, createdAt: true, team: { select: { name: true } } },
      }),
      this.prisma.platformApiKey.count({ where }),
    ]);
    return { items: keys.map((k) => ({ ...this.publicView(k), teamName: k.team.name })), total, page, pageSize };
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
