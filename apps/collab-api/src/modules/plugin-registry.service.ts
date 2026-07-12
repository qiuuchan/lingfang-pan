import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Readable } from 'node:stream';
import { AppError, badRequest, conflict, forbidden, insufficientBalance, notFound } from '../common';
import { PrismaService } from '../prisma.service';
import { ARTIFACT_STORE, type ArtifactDownload, type ArtifactStore } from './artifact-store';
import { AuthService } from './auth.service';
import { inspectPluginArtifact, PLUGIN_ARTIFACT_MAX_BYTES } from './plugin-artifact';
import { compareStrictSemVer, parseStrictSemVer } from './plugin-semver';

type UploadResult = { path: string; directory: string; sha256: string; sizeBytes: number };

function assertStrictSemVer(version: string): void {
  if (!parseStrictSemVer(version)) throw badRequest('插件版本必须是严格 SemVer', { version });
}

function isPrerelease(version: string): boolean {
  const parsed = parseStrictSemVer(version);
  return !parsed || parsed.prerelease !== null;
}

function releaseJson(release: {
  id: string; packageId: string; version: string; manifest: unknown; sha256: string; sizeBytes: number;
  status: string; marketReviewStatus: string; targetPlatform: string; reviewReason?: string; createdAt: Date;
}) {
  return {
    id: release.id,
    packageId: release.packageId,
    version: release.version,
    manifest: release.manifest,
    sha256: release.sha256,
    sizeBytes: release.sizeBytes,
    status: release.status,
    marketReviewStatus: release.marketReviewStatus,
    targetPlatform: release.targetPlatform,
    ...(release.reviewReason === undefined ? {} : { reviewReason: release.reviewReason }),
    createdAt: release.createdAt.toISOString(),
  };
}

function packageJson(pkg: {
  id: string; ownerTeamId: string; authorUserId: string | null; manifestId: string; name: string; description: string;
  governanceStatus: string; createdAt: Date; updatedAt: Date;
}) {
  return {
    id: pkg.id,
    ownerTeamId: pkg.ownerTeamId,
    authorUserId: pkg.authorUserId,
    manifestId: pkg.manifestId,
    name: pkg.name,
    description: pkg.description,
    governanceStatus: pkg.governanceStatus,
    createdAt: pkg.createdAt.toISOString(),
    updatedAt: pkg.updatedAt.toISOString(),
  };
}

@Injectable()
export class PluginRegistryService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(ARTIFACT_STORE) private readonly artifacts: ArtifactStore,
  ) {}

  private async spoolUpload(stream: Readable, contentLength?: number): Promise<UploadResult> {
    if (contentLength !== undefined && (!Number.isFinite(contentLength) || contentLength <= 0 || contentLength > PLUGIN_ARTIFACT_MAX_BYTES)) {
      throw badRequest('插件制品大小超限');
    }
    const stagingRoot = process.env.PLUGIN_ARTIFACT_STAGING_DIR || join(tmpdir(), 'lingfang-plugin-artifacts');
    await mkdir(stagingRoot, { recursive: true });
    const directory = await mkdtemp(join(stagingRoot, 'upload-'));
    const path = join(directory, 'artifact.lfplugin');
    const output = createWriteStream(path, { flags: 'wx' });
    const hash = createHash('sha256');
    let sizeBytes = 0;
    try {
      for await (const raw of stream) {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
        sizeBytes += chunk.length;
        if (sizeBytes > PLUGIN_ARTIFACT_MAX_BYTES) throw badRequest('插件制品大小超限');
        hash.update(chunk);
        if (!output.write(chunk)) await once(output, 'drain');
      }
      output.end();
      await once(output, 'finish');
      if (sizeBytes === 0) throw badRequest('插件制品不能为空');
      return { path, directory, sha256: hash.digest('hex'), sizeBytes };
    } catch (error) {
      output.destroy();
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async publishTeamRelease(userId: string, stream: Readable, packageId?: string, contentLength?: number) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    let staged: UploadResult;
    try {
      staged = await this.spoolUpload(stream, contentLength);
    } catch (error) {
      await this.audit(userId, 'plugin.release.upload_failed', 'PluginPackage', packageId || membership.teamId, {
        stage: 'upload',
        error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      }).catch(() => undefined);
      throw error;
    }
    let artifactKey: string | null = null;
    try {
      const inspected = await inspectPluginArtifact(staged.path);
      assertStrictSemVer(inspected.manifest.version);

      let pkg = packageId ? await this.prisma.pluginPackage.findUnique({ where: { id: packageId } }) : null;
      if (pkg) {
        if (pkg.ownerTeamId !== membership.teamId) throw forbidden('不能发布到其他团队的插件包');
        if (pkg.authorUserId !== userId && membership.role !== 'TEAM_ADMIN') throw forbidden('仅作者或团队管理员可发布新版本');
        if (pkg.manifestId !== inspected.manifest.id) throw conflict('manifest.id 与目标插件包不一致');
      } else if (packageId) {
        throw notFound('插件包不存在');
      } else {
        pkg = await this.prisma.pluginPackage.findUnique({
          where: { ownerTeamId_manifestId: { ownerTeamId: membership.teamId, manifestId: inspected.manifest.id } },
        });
        if (pkg && pkg.authorUserId !== userId && membership.role !== 'TEAM_ADMIN') throw forbidden('仅作者或团队管理员可发布新版本');
      }

      if (!pkg) {
        pkg = await this.prisma.pluginPackage.create({
          data: {
            ownerTeamId: membership.teamId,
            authorUserId: userId,
            manifestId: inspected.manifest.id,
            name: inspected.manifest.name,
            description: inspected.manifest.description,
          },
        });
      }
      if (pkg.governanceStatus !== 'ACTIVE') throw conflict('已归档插件包不能发布新版本');

      const duplicate = await this.prisma.pluginRelease.findUnique({
        where: { packageId_version: { packageId: pkg.id, version: inspected.manifest.version } },
      });
      if (duplicate) throw conflict('该版本已经发布且不可覆盖', { packageId: pkg.id, releaseId: duplicate.id });

      artifactKey = `${pkg.id}/${inspected.manifest.version}/${staged.sha256}.lfplugin`;
      await this.artifacts.promote(staged.path, artifactKey, staged.sha256);
      const release = await this.prisma.$transaction(async (tx) => {
        await tx.pluginPackage.update({
          where: { id: pkg!.id },
          data: { name: inspected.manifest.name, description: inspected.manifest.description },
        });
        const created = await tx.pluginRelease.create({
          data: {
            packageId: pkg!.id,
            version: inspected.manifest.version,
            manifest: inspected.manifest as Prisma.InputJsonValue,
            fileManifest: inspected.files as Prisma.InputJsonValue,
            artifactKey: artifactKey!,
            sha256: staged.sha256,
            sizeBytes: staged.sizeBytes,
            createdById: userId,
          },
        });
        await tx.auditLog.create({
          data: {
            actorUserId: userId,
            action: 'plugin.release.published',
            targetType: 'PluginRelease',
            targetId: created.id,
            metadata: { packageId: pkg!.id, version: created.version, sha256: staged.sha256, sizeBytes: staged.sizeBytes },
          },
        });
        return created;
      });
      await rm(staged.directory, { recursive: true, force: true });
      return { package: packageJson(pkg), release: releaseJson(release) };
    } catch (error) {
      await rm(staged.directory, { recursive: true, force: true });
      if (artifactKey) {
        const referenced = await this.prisma.pluginRelease.count({ where: { artifactKey } }).catch(() => 0);
        if (referenced === 0) await this.artifacts.delete(artifactKey).catch(() => undefined);
      }
      await this.audit(userId, 'plugin.release.upload_failed', 'PluginPackage', packageId || membership.teamId, {
        stage: artifactKey ? 'publish' : 'validation',
        error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      }).catch(() => undefined);
      throw error;
    }
  }

  async teamCatalog(userId: string) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const packages = await this.prisma.pluginPackage.findMany({
      where: { ownerTeamId: membership.teamId, governanceStatus: 'ACTIVE' },
      include: { releases: { where: { status: 'PUBLISHED' } } },
      orderBy: { updatedAt: 'desc' },
    });
    return {
      items: packages.flatMap((pkg) => {
        const latest = pkg.releases.reduce<(typeof pkg.releases)[number] | null>(
          (current, release) => !current || compareStrictSemVer(release.version, current.version) > 0 ? release : current,
          null,
        );
        return latest ? [{ package: packageJson(pkg), latestRelease: releaseJson(latest) }] : [];
      }),
    };
  }

  async marketplaceCatalog(userId: string) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const listings = await this.prisma.marketplaceListing.findMany({
      where: { status: 'ACTIVE', currentReleaseId: { not: null } },
      include: { package: true, currentRelease: true },
      orderBy: { updatedAt: 'desc' },
    });
    const entitlements = await this.prisma.pluginEntitlement.findMany({
      where: { teamId: membership.teamId, packageId: { in: listings.map((item) => item.packageId) } },
      select: { packageId: true },
    });
    const entitled = new Set(entitlements.map((item) => item.packageId));
    return {
      items: listings.flatMap((listing) => listing.currentRelease
        && listing.currentRelease.status === 'PUBLISHED'
        && listing.currentRelease.marketReviewStatus === 'APPROVED'
        ? [{
            package: packageJson(listing.package),
            latestRelease: releaseJson(listing.currentRelease),
            priceCents: listing.priceCents,
            listingStatus: listing.status,
            entitled: listing.priceCents === 0 || entitled.has(listing.packageId),
          }]
        : []),
    };
  }

  async packageDetail(userId: string, packageId: string) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const pkg = await this.prisma.pluginPackage.findUnique({
      where: { id: packageId },
      include: { releases: { orderBy: { createdAt: 'desc' } }, listing: true },
    });
    if (!pkg) throw notFound('插件包不存在');
    const entitlement = await this.prisma.pluginEntitlement.count({ where: { teamId: membership.teamId, packageId } });
    const isOwnerTeam = pkg.ownerTeamId === membership.teamId;
    if (!isOwnerTeam && pkg.listing?.status !== 'ACTIVE' && entitlement === 0) throw forbidden('无权查看该插件包');
    return {
      package: packageJson(pkg),
      releases: pkg.releases
        .filter((release) => isOwnerTeam || release.marketReviewStatus === 'APPROVED')
        .map(releaseJson),
      listing: pkg.listing ? { priceCents: pkg.listing.priceCents, status: pkg.listing.status, currentReleaseId: pkg.listing.currentReleaseId } : null,
      entitled: pkg.listing?.priceCents === 0 || entitlement > 0,
    };
  }

  private async resolvePackageAccess(userId: string, packageId: string) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const pkg = await this.prisma.pluginPackage.findUnique({ where: { id: packageId }, include: { listing: true } });
    if (!pkg) throw notFound('插件包不存在');
    if (pkg.ownerTeamId === membership.teamId) {
      if (membership.role === 'TEAM_ADMIN') return { membership, pkg, source: 'team' as const };
      const grants = await this.prisma.pluginGrant.findMany({
        where: {
          teamId: membership.teamId,
          packageId,
          OR: [
            { subjectKind: 'USER', subjectId: userId },
            ...(membership.teamRoleId ? [{ subjectKind: 'ROLE' as const, subjectId: membership.teamRoleId }] : []),
          ],
        },
        select: { subjectKind: true, effect: true },
      });
      const userGrants = grants.filter((grant) => grant.subjectKind === 'USER');
      const roleGrants = grants.filter((grant) => grant.subjectKind === 'ROLE');
      if (userGrants.some((grant) => grant.effect === 'DENY') || (!userGrants.some((grant) => grant.effect === 'ALLOW') && roleGrants.some((grant) => grant.effect === 'DENY'))) {
        await this.audit(userId, 'plugin.runtime_access.denied', 'PluginPackage', packageId, { teamId: membership.teamId });
        throw forbidden('当前成员没有该团队插件的使用授权');
      }
      return { membership, pkg, source: 'team' as const };
    }
    const entitled = await this.prisma.pluginEntitlement.count({ where: { teamId: membership.teamId, packageId } });
    if (entitled > 0 || (pkg.listing?.status === 'ACTIVE' && pkg.listing.priceCents === 0)) {
      return { membership, pkg, source: 'marketplace' as const };
    }
    await this.audit(userId, 'plugin.runtime_access.denied', 'PluginPackage', packageId, {
      teamId: membership.teamId,
      reason: 'entitlement_required',
    });
    throw new AppError(402, 'payment_required', '当前团队尚未购买该插件');
  }

  async artifactDownload(userId: string, releaseId: string): Promise<{ download: ArtifactDownload; release: ReturnType<typeof releaseJson> }> {
    const release = await this.prisma.pluginRelease.findUnique({ where: { id: releaseId } });
    if (!release || release.status === 'YANKED') throw notFound('插件发行版不存在或已撤回');
    const access = await this.resolvePackageAccess(userId, release.packageId);
    if (access.source === 'marketplace' && release.marketReviewStatus !== 'APPROVED') {
      throw forbidden('该市场发行版尚未通过审核');
    }
    const download = await this.artifacts.download(release.artifactKey);
    await this.audit(userId, 'plugin.artifact.downloaded', 'PluginRelease', release.id, { packageId: release.packageId, sha256: release.sha256 });
    return { download, release: releaseJson(release) };
  }

  async runtimeAccess(userId: string, packageId: string) {
    const access = await this.resolvePackageAccess(userId, packageId);
    if (access.source !== 'team') return { allowed: true, mode: 'local-entitlement' as const };
    return { allowed: true, mode: 'online-team-membership' as const, checkedAt: new Date().toISOString() };
  }

  async reportIntegrityFailure(userId: string, releaseId: string, detail: string) {
    const release = await this.prisma.pluginRelease.findUnique({ where: { id: releaseId } });
    if (!release) throw notFound('发行版不存在');
    await this.audit(userId, 'plugin.artifact.sha_failed', 'PluginRelease', releaseId, {
      packageId: release.packageId,
      detail: String(detail || '').slice(0, 500),
    });
    return { ok: true };
  }

  async submitMarketplace(userId: string, releaseId: string, priceCents = 0) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const release = await this.prisma.pluginRelease.findUnique({ where: { id: releaseId }, include: { package: true } });
    if (!release || release.package.ownerTeamId !== membership.teamId) throw notFound('发行版不存在');
    if (release.package.authorUserId !== userId && membership.role !== 'TEAM_ADMIN') throw forbidden('仅作者或团队管理员可提交审核');
    if (release.status !== 'PUBLISHED') throw conflict('已撤回发行版不能提交市场');
    if (isPrerelease(release.version)) throw badRequest('市场只允许正式 SemVer 版本');
    if (release.marketReviewStatus === 'PENDING' || release.marketReviewStatus === 'APPROVED') throw conflict('该版本已提交或已通过审核');
    const normalizedPrice = Math.max(0, Math.floor(Number(priceCents) || 0));
    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.pluginRelease.update({
        where: { id: releaseId },
        data: { marketReviewStatus: 'PENDING', reviewReason: '', reviewedById: null, reviewedAt: null },
      });
      await tx.marketplaceListing.upsert({
        where: { packageId: release.packageId },
        update: { priceCents: normalizedPrice },
        create: { packageId: release.packageId, priceCents: normalizedPrice },
      });
      await tx.pluginReleaseReview.create({ data: { releaseId, status: 'PENDING', reason: '作者提交审核' } });
      await tx.auditLog.create({ data: { actorUserId: userId, action: 'plugin.release.marketplace_submitted', targetType: 'PluginRelease', targetId: releaseId, metadata: { packageId: release.packageId, priceCents: normalizedPrice } } });
      return next;
    });
    return { release: releaseJson(updated) };
  }

  async purchase(userId: string, packageId: string) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const listing = await this.prisma.marketplaceListing.findUnique({ where: { packageId }, include: { package: true } });
    if (!listing || listing.status !== 'ACTIVE' || !listing.currentReleaseId) throw notFound('市场插件不存在或未上架');
    if (listing.package.ownerTeamId === membership.teamId) throw conflict('不能购买本团队发布的插件');
    const existing = await this.prisma.pluginEntitlement.findUnique({ where: { teamId_packageId: { teamId: membership.teamId, packageId } } });
    if (existing) return { entitled: true, entitlementId: existing.id, purchaseId: existing.purchaseId };
    if (listing.priceCents < 0) throw badRequest('市场插件价格无效');
    if (listing.priceCents === 0) return { entitled: true, entitlementId: null, purchaseId: null };
    const sellerUserId = listing.package.authorUserId;
    if (!sellerUserId) throw badRequest('插件无作者信息，无法结算');

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        // The order is the transaction's idempotency claim. A concurrent purchase for the
        // same team/package loses the unique constraint and rolls back before any money moves.
        const purchase = await tx.purchase.create({
          data: {
            packageId,
            buyerUserId: userId,
            buyerTeamId: membership.teamId,
            sellerUserId,
            priceCents: listing.priceCents,
          },
        });
        const debited = await tx.team.updateMany({
          where: { id: membership.teamId, balanceCents: { gte: listing.priceCents } },
          data: { balanceCents: { decrement: listing.priceCents } },
        });
        if (debited.count === 0) throw insufficientBalance();
        await tx.team.update({
          where: { id: listing.package.ownerTeamId },
          data: { balanceCents: { increment: listing.priceCents } },
        });
        await tx.balanceLedger.create({
          data: { teamId: membership.teamId, amountCents: listing.priceCents, direction: 'DEBIT', reason: 'plugin_purchase', actorUserId: userId },
        });
        await tx.balanceLedger.create({
          data: { teamId: listing.package.ownerTeamId, amountCents: listing.priceCents, direction: 'CREDIT', reason: 'plugin_sale', actorUserId: sellerUserId },
        });
        await tx.auditLog.create({
          data: {
            actorUserId: userId,
            action: 'plugin.marketplace.purchased',
            targetType: 'PluginPackage',
            targetId: packageId,
            metadata: {
              purchaseId: purchase.id,
              buyerTeamId: membership.teamId,
              sellerTeamId: listing.package.ownerTeamId,
              priceCents: listing.priceCents,
            },
          },
        });
        const entitlement = await tx.pluginEntitlement.create({
          data: { teamId: membership.teamId, packageId, purchaseId: purchase.id },
        });
        return { entitlement, purchase };
      });
      return { entitled: true, entitlementId: result.entitlement.id, purchaseId: result.purchase.id };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const concurrent = await this.prisma.pluginEntitlement.findUnique({
          where: { teamId_packageId: { teamId: membership.teamId, packageId } },
        });
        if (concurrent) return { entitled: true, entitlementId: concurrent.id, purchaseId: concurrent.purchaseId };
      }
      throw error;
    }
  }

  async pendingReviews(actorId: string) {
    await this.auth.ensurePlatformAdmin(actorId);
    const releases = await this.prisma.pluginRelease.findMany({
      where: { marketReviewStatus: 'PENDING' },
      include: { package: true },
      orderBy: { createdAt: 'asc' },
    });
    return { items: releases.map((release) => ({ package: packageJson(release.package), release: releaseJson(release), fileManifest: release.fileManifest })) };
  }

  async adminReleases(actorId: string) {
    await this.auth.ensurePlatformAdmin(actorId);
    const releases = await this.prisma.pluginRelease.findMany({
      include: { package: { include: { listing: true } } },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return {
      items: releases.map((release) => ({
        package: packageJson(release.package),
        release: releaseJson(release),
        listingStatus: release.package.listing?.status ?? null,
        priceCents: release.package.listing?.priceCents ?? null,
      })),
    };
  }

  async reviewDetail(actorId: string, releaseId: string) {
    await this.auth.ensurePlatformAdmin(actorId);
    const release = await this.prisma.pluginRelease.findUnique({
      where: { id: releaseId }, include: { package: true, reviews: { orderBy: { createdAt: 'desc' } } },
    });
    if (!release) throw notFound('发行版不存在');
    return { package: packageJson(release.package), release: releaseJson(release), fileManifest: release.fileManifest, reviews: release.reviews.map((review) => ({ ...review, createdAt: review.createdAt.toISOString() })) };
  }

  async approveRelease(actorId: string, releaseId: string) {
    await this.auth.ensurePlatformAdmin(actorId);
    const release = await this.prisma.pluginRelease.findUnique({ where: { id: releaseId } });
    if (!release || release.marketReviewStatus !== 'PENDING') throw conflict('发行版不在待审核状态');
    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.pluginRelease.update({ where: { id: releaseId }, data: { marketReviewStatus: 'APPROVED', reviewReason: '', reviewedById: actorId, reviewedAt: new Date() } });
      await tx.marketplaceListing.update({ where: { packageId: release.packageId }, data: { currentReleaseId: releaseId, status: 'ACTIVE' } });
      await tx.pluginReleaseReview.create({ data: { releaseId, reviewerId: actorId, status: 'APPROVED' } });
      await tx.auditLog.create({ data: { actorUserId: actorId, action: 'admin.plugin_release.approved', targetType: 'PluginRelease', targetId: releaseId, metadata: { packageId: release.packageId, version: release.version } } });
      return next;
    });
    return { release: releaseJson(updated) };
  }

  async rejectRelease(actorId: string, releaseId: string, reason: string) {
    await this.auth.ensurePlatformAdmin(actorId);
    const release = await this.prisma.pluginRelease.findUnique({ where: { id: releaseId } });
    if (!release || release.marketReviewStatus !== 'PENDING') throw conflict('发行版不在待审核状态');
    const reviewReason = String(reason || '').trim() || '未通过平台审核';
    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.pluginRelease.update({ where: { id: releaseId }, data: { marketReviewStatus: 'REJECTED', reviewReason, reviewedById: actorId, reviewedAt: new Date() } });
      await tx.pluginReleaseReview.create({ data: { releaseId, reviewerId: actorId, status: 'REJECTED', reason: reviewReason } });
      await tx.auditLog.create({ data: { actorUserId: actorId, action: 'admin.plugin_release.rejected', targetType: 'PluginRelease', targetId: releaseId, metadata: { packageId: release.packageId, version: release.version, reason: reviewReason } } });
      return next;
    });
    return { release: releaseJson(updated) };
  }

  async delistRelease(actorId: string, releaseId: string, reason: string) {
    await this.auth.ensurePlatformAdmin(actorId);
    const release = await this.prisma.pluginRelease.findUnique({ where: { id: releaseId } });
    if (!release) throw notFound('发行版不存在');
    const listing = await this.prisma.marketplaceListing.findUnique({ where: { packageId: release.packageId } });
    if (!listing || listing.status !== 'ACTIVE') throw conflict('插件包当前未上架');
    await this.prisma.$transaction([
      this.prisma.marketplaceListing.update({ where: { id: listing.id }, data: { status: 'DELISTED' } }),
      this.prisma.auditLog.create({ data: { actorUserId: actorId, action: 'admin.plugin_package.delisted', targetType: 'PluginPackage', targetId: release.packageId, metadata: { releaseId, reason: String(reason || '').trim() } } }),
    ]);
    return { packageId: release.packageId, status: 'DELISTED' as const };
  }

  private async audit(actorUserId: string, action: string, targetType: string, targetId: string, metadata?: unknown) {
    await this.prisma.auditLog.create({ data: { actorUserId, action, targetType, targetId, metadata: metadata as Prisma.InputJsonValue } });
  }
}
