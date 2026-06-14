// 应用版本发布 + 产物服务。
//
// 设计契约：
//  - 公开端点（latest/list/get）不鉴权（controller 标 @Public）：官网和桌面端检查更新无需登录，
//    仅返回 status='PUBLISHED' 的版本，DRAFT/ARCHIVED 不暴露（ARCHIVED 仅历史可追溯，不在最新/列表展示）。
//  - Admin 写操作（create/update/publish/archive/addAsset/deleteAsset）首行 ensurePlatformAdmin，
//    与 LlmService 的 admin 网关目录方法一致（design.md D2 平台管理）。
//  - publish 原子维护 isLatest：$transaction 内把同 channel 其他版本 isLatest=false，当前置 true，
//    status=PUBLISHED，publishedAt 首次发布时落库（已发布过则保留原值，支持归档后重新发布）。
//  - 无物理 DELETE Release（与 LlmGateway 软删除语义一致）：归档用 status=ARCHIVED + isLatest=false。
//    Asset 允许物理 DELETE（它只是链接登记，登记错了直接删，无审计价值）。
//  - 审计 metadata 固定 shape {version, channel}，写 AuditLog。
//  - semver 比较：轻量实现（split 主.次.修 → 数值比较；prerelease/build 暂不参与，MVP 够用），
//    用于 /latest 的 updateAvailable 标志，不依赖 DB 排序（latest 靠 isLatest 标志，更可靠）。
//  - 所有出参字段 camelCase，时间转 ISO 字符串。
import { Inject, Injectable } from '@nestjs/common';
import type { Release, ReleaseAsset } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { AppError, badRequest, notFound } from '../common';
import { AuthService } from './auth.service';
import type {
  ReleaseAssetCreateDto,
  ReleaseCreateDto,
  ReleaseLatestQueryDto,
  ReleaseListQueryDto,
  ReleaseUpdateDto,
} from './dto/release.dto';

@Injectable()
export class ReleaseService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  // === 公开查询方法（controller 标 @Public）===

  /** GET /api/releases/latest：同 channel 内 isLatest=true 且 PUBLISHED 的版本。
   *  - 可选 platform/arch：附带匹配的 asset（不传则返回版本不含 asset 过滤）。
   *  - 可选 currentVersion：返回 updateAvailable（latest.version > currentVersion）。 */
  async latest(query: ReleaseLatestQueryDto) {
    const channel = query.channel ?? 'STABLE';
    const release = await this.prisma.release.findFirst({
      where: { channel, status: 'PUBLISHED', isLatest: true },
      include: { assets: { orderBy: { platform: 'asc' } } },
    });
    if (!release) throw new AppError(404, 'release_not_found', `当前没有已发布的 ${channel} 版本`);

    // platform/arch 过滤（仅缩小展示范围，不影响 latest 判定）。
    const assets = query.platform || query.arch
      ? release.assets.filter((a) => (!query.platform || a.platform === query.platform) && (!query.arch || a.arch === query.arch))
      : release.assets;

    const public_ = this.publicRelease(release, assets);
    return {
      ...public_,
      updateAvailable: query.currentVersion ? this.isNewer(release.version, query.currentVersion) : undefined,
    };
  }

  /** GET /api/releases：已发布版本列表（按 publishedAt desc）。limit 由 controller 传入，此处 clamp 到 [1,50]。 */
  async list(query: ReleaseListQueryDto, limit?: number) {
    const channel = query.channel ?? 'STABLE';
    const safeLimit = limit === undefined ? 10 : Math.min(50, Math.max(1, Math.floor(limit)));
    const releases = await this.prisma.release.findMany({
      where: { channel, status: 'PUBLISHED' },
      orderBy: { publishedAt: 'desc' },
      take: safeLimit,
    });
    return { releases: releases.map((r) => this.publicRelease(r, [])) };
  }

  /** GET /api/releases/:version：指定版本详情（含全部 asset），仅 PUBLISHED 公开可见。 */
  async get(version: string, channel: 'STABLE' | 'BETA' = 'STABLE') {
    const release = await this.prisma.release.findUnique({
      where: { channel_version: { channel, version } },
      include: { assets: { orderBy: [{ platform: 'asc' }, { arch: 'asc' }] } },
    });
    if (!release || release.status !== 'PUBLISHED') throw notFound('版本不存在或未发布');
    return { release: this.publicRelease(release, release.assets) };
  }

  // === 平台 Admin 写方法 ===

  /** POST /api/admin/releases：创建 DRAFT 版本（channel+version 唯一）。 */
  async create(actorId: string, dto: ReleaseCreateDto) {
    await this.auth.ensurePlatformAdmin(actorId);
    const channel = dto.channel ?? 'STABLE';
    const existing = await this.prisma.release.findUnique({ where: { channel_version: { channel, version: dto.version } } });
    if (existing) throw badRequest(`版本 ${dto.version} 在 ${channel} 通道已存在`);

    const release = await this.prisma.release.create({
      data: {
        version: dto.version,
        channel,
        status: 'DRAFT',
        title: dto.title ?? '',
        notes: dto.notes ?? '',
        isLatest: false,
      },
    });
    await this.audit(actorId, 'admin.release.created', 'Release', release.id, { version: release.version, channel: release.channel });
    return { release: this.adminRelease(release) };
  }

  /** PATCH /api/admin/releases/:id：更新 title/notes（DRAFT/PUBLISHED 均可改，版本号与 channel 不可改）。 */
  async update(actorId: string, id: string, dto: ReleaseUpdateDto) {
    await this.auth.ensurePlatformAdmin(actorId);
    const existing = await this.prisma.release.findUnique({ where: { id } });
    if (!existing) throw notFound('版本不存在');
    const data: { title?: string; notes?: string } = {};
    if (dto.title !== undefined) data.title = dto.title;
    if (dto.notes !== undefined) data.notes = dto.notes;
    const release = await this.prisma.release.update({ where: { id }, data });
    await this.audit(actorId, 'admin.release.updated', 'Release', release.id, { version: release.version, channel: release.channel });
    return { release: this.adminRelease(release) };
  }

  /** POST /api/admin/releases/:id/publish：发布（事务维护 isLatest 唯一性 + 落 publishedAt）。 */
  async publish(actorId: string, id: string) {
    await this.auth.ensurePlatformAdmin(actorId);
    const existing = await this.prisma.release.findUnique({ where: { id } });
    if (!existing) throw notFound('版本不存在');
    if (existing.status === 'ARCHIVED') throw badRequest('已归档的版本不可发布（请先改回 DRAFT）');

    const release = await this.prisma.$transaction(async (tx) => {
      // 同 channel 其他版本取消 latest 标志（保证 isLatest 在 channel 内唯一）。
      await tx.release.updateMany({
        where: { channel: existing.channel, isLatest: true, id: { not: id } },
        data: { isLatest: false },
      });
      // publishedAt 仅首次发布时落库，重发保持原值（归档后再发布场景）。
      return tx.release.update({
        where: { id },
        data: { status: 'PUBLISHED', isLatest: true, publishedAt: existing.publishedAt ?? new Date() },
      });
    });
    await this.audit(actorId, 'admin.release.published', 'Release', release.id, { version: release.version, channel: release.channel });
    return { release: this.adminRelease(release) };
  }

  /** POST /api/admin/releases/:id/archive：归档（status=ARCHIVED + 取消 latest，不自动晋升次新）。 */
  async archive(actorId: string, id: string) {
    await this.auth.ensurePlatformAdmin(actorId);
    const existing = await this.prisma.release.findUnique({ where: { id } });
    if (!existing) throw notFound('版本不存在');
    const release = await this.prisma.release.update({ where: { id }, data: { status: 'ARCHIVED', isLatest: false } });
    await this.audit(actorId, 'admin.release.archived', 'Release', release.id, { version: release.version, channel: release.channel });
    return { release: this.adminRelease(release) };
  }

  /** POST /api/admin/releases/:id/assets：登记一个平台产物（releaseId+platform+arch 唯一）。 */
  async addAsset(actorId: string, id: string, dto: ReleaseAssetCreateDto) {
    await this.auth.ensurePlatformAdmin(actorId);
    const existing = await this.prisma.release.findUnique({ where: { id }, select: { id: true, version: true, channel: true } });
    if (!existing) throw notFound('版本不存在');

    const asset = await this.prisma.releaseAsset.create({
      data: {
        releaseId: id,
        platform: dto.platform,
        arch: dto.arch,
        url: dto.url,
        filename: dto.filename ?? '',
        signature: dto.signature ?? '',
        sizeBytes: dto.sizeBytes ?? null,
      },
    });
    await this.audit(actorId, 'admin.release.asset_added', 'ReleaseAsset', asset.id, {
      releaseId: id,
      version: existing.version,
      platform: dto.platform,
      arch: dto.arch,
    });
    return { asset: this.publicAsset(asset) };
  }

  /** DELETE /api/admin/releases/:id/assets/:assetId：删除一个产物（物理删除，仅链接登记）。 */
  async deleteAsset(actorId: string, id: string, assetId: string) {
    await this.auth.ensurePlatformAdmin(actorId);
    const asset = await this.prisma.releaseAsset.findUnique({ where: { id: assetId }, select: { id: true, releaseId: true } });
    if (!asset || asset.releaseId !== id) throw notFound('产物不存在');
    await this.prisma.releaseAsset.delete({ where: { id: assetId } });
    await this.audit(actorId, 'admin.release.asset_deleted', 'ReleaseAsset', assetId, { releaseId: id });
    return { ok: true };
  }

  // === 辅助方法 ===

  /** 公开视角的版本出参（仅 PUBLISHED 字段，asset 列表由调用方决定是否过滤）。 */
  private publicRelease(release: Release, assets: ReleaseAsset[]) {
    return {
      id: release.id,
      version: release.version,
      channel: release.channel,
      title: release.title,
      notes: release.notes,
      isLatest: release.isLatest,
      publishedAt: release.publishedAt ? release.publishedAt.toISOString() : null,
      assets: assets.map((a) => this.publicAsset(a)),
    };
  }

  /** Admin 视角的版本全字段出参（含 status）。 */
  private adminRelease(release: Release) {
    return {
      id: release.id,
      version: release.version,
      channel: release.channel,
      status: release.status,
      title: release.title,
      notes: release.notes,
      isLatest: release.isLatest,
      publishedAt: release.publishedAt ? release.publishedAt.toISOString() : null,
      createdAt: release.createdAt.toISOString(),
      updatedAt: release.updatedAt.toISOString(),
    };
  }

  /** 产物出参：signature 在已接入 updater 后才有意义，仍返回（前端按需展示）。 */
  private publicAsset(asset: ReleaseAsset) {
    return {
      id: asset.id,
      platform: asset.platform,
      arch: asset.arch,
      url: asset.url,
      filename: asset.filename,
      signature: asset.signature,
      sizeBytes: asset.sizeBytes,
    };
  }

  /** semver 比较：返回 latestVersion > currentVersion。
   *  宽松解析（主.次.修 数值比较；prerelease 标记版本视为低于无标记版本，符合 semver）。 */
  private isNewer(latestVersion: string, currentVersion: string): boolean {
    const l = this.parseSemver(latestVersion);
    const c = this.parseSemver(currentVersion);
    if (!l || !c) return latestVersion !== currentVersion; // 解析失败退化为不等判断
    for (let i = 0; i < 3; i++) {
      if (l.nums[i] !== c.nums[i]) return l.nums[i] > c.nums[i];
    }
    // 主.次.修 相同：无 prerelease（pre=null）高于有 prerelease。
    if (l.pre === null && c.pre !== null) return true;
    if (l.pre !== null && c.pre === null) return false;
    if (l.pre !== null && c.pre !== null) return l.pre > c.pre;
    return false; // 完全相等
  }

  /** 解析 semver 为 {主,次,修,prerelease}，失败返回 null。 */
  private parseSemver(v: string): { nums: [number, number, number]; pre: string | null } | null {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v);
    if (!m) return null;
    return {
      nums: [Number(m[1]), Number(m[2]), Number(m[3])],
      pre: m[4] ?? null,
    };
  }

  private async audit(actorUserId: string, action: string, targetType: string, targetId?: string, metadata?: unknown) {
    await this.prisma.auditLog.create({ data: { actorUserId, action, targetType, targetId, metadata: metadata as object } });
  }
}
