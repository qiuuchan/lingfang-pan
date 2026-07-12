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
import {
  ADMIN_PACKAGE_DETAIL_SELECT,
  ADMIN_PACKAGE_LIST_SELECT,
  ADMIN_RELEASE_CORE_SELECT,
  ADMIN_RELEASE_FILES_SELECT,
  ADMIN_RELEASE_MANIFEST_SELECT,
  ADMIN_RELEASE_REVIEW_SELECT,
  ADMIN_RELEASE_SUMMARY_SELECT,
  adminListingProjection,
  adminPackageDetail as projectAdminPackageDetail,
  adminPackageListItem,
  adminPackageWhere,
  adminReleaseCore as projectAdminReleaseCore,
  adminReleaseReview,
  adminReleaseSummary,
  groupAdminReleases,
  normalizeAdminPage,
  normalizeFileManifest,
  normalizeRequiredReason,
  type AdminPageQuery,
  type AdminPluginPackageQuery,
} from './plugin-registry-admin';
import {
  highestSemVer,
  listingJson,
  normalizeReleaseSource,
  packageJson,
  releaseJson,
  type ReleaseSourceHeaders,
} from './plugin-registry-model';
import { parseStrictSemVer } from './plugin-semver';

type UploadResult = { path: string; directory: string; sha256: string; sizeBytes: number };

function assertStrictSemVer(version: string): void {
  if (!parseStrictSemVer(version)) throw badRequest('插件版本必须是严格 SemVer', { version });
}

function isPrerelease(version: string): boolean {
  const parsed = parseStrictSemVer(version);
  return !parsed || parsed.prerelease !== null;
}

@Injectable()
export class PluginRegistryService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(ARTIFACT_STORE) private readonly artifacts: ArtifactStore,
  ) {}

  private async serializableTransaction<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        const retryable = error instanceof Prisma.PrismaClientKnownRequestError
          && (error.code === 'P2034' || error.code === 'P2002');
        if (!retryable) throw error;
        if (attempt === 4) throw conflict('插件状态发生并发冲突，请重试');
      }
    }
    throw conflict('插件状态发生并发冲突，请重试');
  }

  private async currentTeamPackage(userId: string, packageId: string) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const pkg = await this.prisma.pluginPackage.findUnique({ where: { id: packageId }, include: { listing: true } });
    if (!pkg || pkg.ownerTeamId !== membership.teamId) throw notFound('插件包不存在');
    return { membership, pkg };
  }

  private async ensurePackageActor(
    userId: string,
    pkg: { authorUserId: string | null },
    membership: { role: string },
    permission: string,
  ): Promise<void> {
    if (pkg.authorUserId === userId || membership.role === 'TEAM_ADMIN') return;
    await this.auth.ensurePermission(userId, permission);
  }

  private async assertListingCanActivate(
    tx: Prisma.TransactionClient,
    packageId: string,
    listing: { currentReleaseId: string | null },
  ) {
    const pkg = await tx.pluginPackage.findUnique({ where: { id: packageId } });
    if (!pkg || pkg.governanceStatus !== 'ACTIVE') throw conflict('只有活动插件包可以恢复市场上架');
    if (!listing.currentReleaseId) throw conflict('市场 listing 没有可恢复的当前发行版');
    const release = await tx.pluginRelease.findUnique({ where: { id: listing.currentReleaseId } });
    if (!release || release.packageId !== packageId || release.status !== 'PUBLISHED' || release.marketReviewStatus !== 'APPROVED') {
      throw conflict('市场当前发行版不满足恢复条件');
    }
    return release;
  }

  private async changeMarketplaceListingStatus(
    actorUserId: string,
    packageId: string,
    status: 'ACTIVE' | 'DELISTED',
    actorKind: 'OWNER' | 'PLATFORM',
    reason: string,
    expectedCurrentReleaseId?: string,
  ) {
    const normalizedReason = String(reason || '').trim().slice(0, 500);
    return this.serializableTransaction(async (tx) => {
      const listing = await tx.marketplaceListing.findUnique({ where: { packageId } });
      if (!listing) throw notFound('市场 listing 不存在');
      if (status === 'DELISTED') {
        const claimed = await tx.marketplaceListing.updateMany({
          where: {
            id: listing.id,
            status: 'ACTIVE',
            ...(expectedCurrentReleaseId ? { currentReleaseId: expectedCurrentReleaseId } : {}),
          },
          data: {
            status: 'DELISTED',
            delistedBy: actorKind,
            delistReason: normalizedReason,
            delistedAt: new Date(),
            delistedByUserId: actorUserId,
          },
        });
        if (claimed.count !== 1) throw conflict('插件包当前未上架');
      } else {
        if (listing.status !== 'DELISTED' || listing.delistedBy !== actorKind) {
          throw conflict(actorKind === 'OWNER' ? '只有作者主动下架的插件可由团队恢复' : '只有平台暂停的插件可由平台恢复');
        }
        await this.assertListingCanActivate(tx, packageId, listing);
        const claimed = await tx.marketplaceListing.updateMany({
          where: { id: listing.id, status: 'DELISTED', delistedBy: actorKind },
          data: {
            status: 'ACTIVE',
            delistedBy: null,
            delistReason: '',
            delistedAt: null,
            delistedByUserId: null,
          },
        });
        if (claimed.count !== 1) throw conflict('市场 listing 状态已变化，请刷新后重试');
      }
      await tx.auditLog.create({
        data: {
          actorUserId,
          action: actorKind === 'OWNER'
            ? status === 'ACTIVE' ? 'plugin.marketplace.relisted' : 'plugin.marketplace.delisted'
            : status === 'ACTIVE' ? 'admin.plugin_package.relisted' : 'admin.plugin_package.delisted',
          targetType: 'PluginPackage',
          targetId: packageId,
          metadata: { status, actorKind, reason: normalizedReason },
        },
      });
      return tx.marketplaceListing.findUnique({ where: { id: listing.id } });
    });
  }

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

  async publishTeamRelease(
    userId: string,
    stream: Readable,
    packageId?: string,
    contentLength?: number,
    sourceHeaders: ReleaseSourceHeaders = {},
  ) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const source = normalizeReleaseSource(sourceHeaders);
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
        await this.ensurePackageActor(userId, pkg, membership, 'team.plugin.edit_draft');
        if (pkg.manifestId !== inspected.manifest.id) throw conflict('manifest.id 与目标插件包不一致');
      } else if (packageId) {
        throw notFound('插件包不存在');
      } else {
        pkg = await this.prisma.pluginPackage.findUnique({
          where: { ownerTeamId_manifestId: { ownerTeamId: membership.teamId, manifestId: inspected.manifest.id } },
        });
        if (pkg) await this.ensurePackageActor(userId, pkg, membership, 'team.plugin.edit_draft');
      }

      if (!pkg) {
        if (membership.role !== 'TEAM_ADMIN') await this.auth.ensurePermission(userId, 'team.plugin.upload');
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
      const published = await this.serializableTransaction(async (tx) => {
        const activePackage = await tx.pluginPackage.findUnique({ where: { id: pkg!.id } });
        if (!activePackage || activePackage.governanceStatus !== 'ACTIVE') throw conflict('已归档插件包不能发布新版本');
        const updatedPackage = await tx.pluginPackage.update({
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
            sourceKind: source.sourceKind,
            sourceLabel: source.sourceLabel,
            ingestChannel: source.ingestChannel,
            createdById: userId,
          },
        });
        await tx.auditLog.create({
          data: {
            actorUserId: userId,
            action: 'plugin.release.published',
            targetType: 'PluginRelease',
            targetId: created.id,
            metadata: {
              packageId: pkg!.id,
              version: created.version,
              sha256: staged.sha256,
              sizeBytes: staged.sizeBytes,
              sourceKind: source.sourceKind,
              sourceLabel: source.sourceLabel,
              ingestChannel: source.ingestChannel,
            },
          },
        });
        return { release: created, package: updatedPackage };
      });
      await rm(staged.directory, { recursive: true, force: true });
      return { package: packageJson(published.package), release: releaseJson(published.release) };
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
        const latest = highestSemVer(pkg.releases);
        return latest ? [{ package: packageJson(pkg), latestRelease: releaseJson(latest) }] : [];
      }),
    };
  }

  async managementCatalog(userId: string) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const packages = await this.prisma.pluginPackage.findMany({
      where: { ownerTeamId: membership.teamId },
      include: { releases: true, listing: true },
      orderBy: { updatedAt: 'desc' },
    });
    return {
      items: packages.map((pkg) => ({
        package: packageJson(pkg),
        latestRelease: (() => {
          const latest = highestSemVer(pkg.releases);
          return latest ? releaseJson(latest) : null;
        })(),
        releaseCount: pkg.releases.length,
        pendingReviewCount: pkg.releases.filter((release) => release.marketReviewStatus === 'PENDING').length,
        listing: listingJson(pkg.listing),
      })),
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
      listing: listingJson(pkg.listing),
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

  async adminArtifactDownload(actorId: string, releaseId: string): Promise<{ download: ArtifactDownload; release: ReturnType<typeof releaseJson> }> {
    await this.auth.ensurePlatformAdmin(actorId);
    const release = await this.prisma.pluginRelease.findUnique({ where: { id: releaseId } });
    if (!release) throw notFound('发行版不存在');
    const download = await this.artifacts.download(release.artifactKey);
    await this.audit(actorId, 'admin.plugin_release.artifact_downloaded', 'PluginRelease', release.id, {
      packageId: release.packageId,
      sha256: release.sha256,
      marketReviewStatus: release.marketReviewStatus,
    });
    return { download, release: releaseJson(release) };
  }

  async submitMarketplace(userId: string, releaseId: string, priceCents?: number) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const release = await this.prisma.pluginRelease.findUnique({ where: { id: releaseId }, include: { package: true } });
    if (!release || release.package.ownerTeamId !== membership.teamId) throw notFound('发行版不存在');
    await this.ensurePackageActor(userId, release.package, membership, 'team.plugin.submit_marketplace');
    if (release.package.governanceStatus !== 'ACTIVE') throw conflict('已归档插件包不能提交市场');
    if (release.status !== 'PUBLISHED') throw conflict('已撤回发行版不能提交市场');
    if (isPrerelease(release.version)) throw badRequest('市场只允许正式 SemVer 版本');
    const updated = await this.serializableTransaction(async (tx) => {
      const activePackage = await tx.pluginPackage.findUnique({ where: { id: release.packageId } });
      if (!activePackage || activePackage.governanceStatus !== 'ACTIVE') throw conflict('已归档插件包不能提交市场');
      const listing = await tx.marketplaceListing.findUnique({ where: { packageId: release.packageId } });
      const normalizedPrice = priceCents === undefined
        ? listing?.priceCents ?? 0
        : Math.max(0, Math.floor(Number(priceCents) || 0));
      const claimed = await tx.pluginRelease.updateMany({
        where: { id: releaseId, status: 'PUBLISHED', marketReviewStatus: { in: ['DRAFT', 'REJECTED'] } },
        data: { marketReviewStatus: 'PENDING', reviewReason: '', reviewedById: null, reviewedAt: null },
      });
      if (claimed.count !== 1) throw conflict('该版本已提交、已通过审核或状态已变化');
      await tx.marketplaceListing.upsert({
        where: { packageId: release.packageId },
        update: { priceCents: normalizedPrice },
        create: { packageId: release.packageId, priceCents: normalizedPrice },
      });
      await tx.pluginReleaseReview.create({ data: { releaseId, status: 'PENDING', reason: '作者提交审核' } });
      await tx.auditLog.create({ data: { actorUserId: userId, action: 'plugin.release.marketplace_submitted', targetType: 'PluginRelease', targetId: releaseId, metadata: { packageId: release.packageId, priceCents: normalizedPrice } } });
      return tx.pluginRelease.findUnique({ where: { id: releaseId } });
    });
    if (!updated) throw notFound('发行版不存在');
    return { release: releaseJson(updated) };
  }

  async withdrawMarketplaceSubmission(userId: string, releaseId: string, reason: string) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const release = await this.prisma.pluginRelease.findUnique({ where: { id: releaseId }, include: { package: true } });
    if (!release || release.package.ownerTeamId !== membership.teamId) throw notFound('发行版不存在');
    await this.ensurePackageActor(userId, release.package, membership, 'team.plugin.submit_marketplace');
    const reviewReason = String(reason || '').trim().slice(0, 500) || '作者撤回市场申请';
    const updated = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.pluginRelease.updateMany({
        where: { id: releaseId, status: 'PUBLISHED', marketReviewStatus: 'PENDING' },
        data: { marketReviewStatus: 'DRAFT', reviewReason, reviewedById: null, reviewedAt: null },
      });
      if (claimed.count !== 1) throw conflict('发行版不在可撤回的待审核状态');
      await tx.pluginReleaseReview.create({ data: { releaseId, status: 'DRAFT', reason: reviewReason } });
      await tx.auditLog.create({
        data: {
          actorUserId: userId,
          action: 'plugin.release.marketplace_withdrawn',
          targetType: 'PluginRelease',
          targetId: releaseId,
          metadata: { packageId: release.packageId, reason: reviewReason },
        },
      });
      return tx.pluginRelease.findUnique({ where: { id: releaseId } });
    });
    if (!updated) throw notFound('发行版不存在');
    return { release: releaseJson(updated) };
  }

  async updatePackageStatus(userId: string, packageId: string, status: 'ACTIVE' | 'ARCHIVED') {
    if (status !== 'ACTIVE' && status !== 'ARCHIVED') throw badRequest('插件包状态无效');
    const { membership, pkg } = await this.currentTeamPackage(userId, packageId);
    await this.ensurePackageActor(userId, pkg, membership, 'team.plugin.edit_metadata');
    if (pkg.governanceStatus === status) return { package: packageJson(pkg), listing: listingJson(pkg.listing) };
    const expected = status === 'ARCHIVED' ? 'ACTIVE' : 'ARCHIVED';
    const result = await this.serializableTransaction(async (tx) => {
      if (status === 'ARCHIVED') {
        const pendingReviews = await tx.pluginRelease.count({ where: { packageId, marketReviewStatus: 'PENDING' } });
        if (pendingReviews > 0) throw conflict('请先撤回待审核发行版再归档插件包');
      }
      const claimed = await tx.pluginPackage.updateMany({ where: { id: packageId, governanceStatus: expected }, data: { governanceStatus: status } });
      if (claimed.count !== 1) throw conflict('插件包状态已变化，请刷新后重试');
      if (status === 'ARCHIVED') {
        await tx.marketplaceListing.updateMany({
          where: { packageId, status: 'ACTIVE' },
          data: {
            status: 'DELISTED',
            delistedBy: 'OWNER',
            delistReason: '插件包已归档',
            delistedAt: new Date(),
            delistedByUserId: userId,
          },
        });
      }
      await tx.auditLog.create({
        data: {
          actorUserId: userId,
          action: status === 'ARCHIVED' ? 'plugin.package.archived' : 'plugin.package.restored',
          targetType: 'PluginPackage',
          targetId: packageId,
          metadata: { from: expected, to: status },
        },
      });
      return {
        package: await tx.pluginPackage.findUnique({ where: { id: packageId } }),
        listing: await tx.marketplaceListing.findUnique({ where: { packageId } }),
      };
    });
    if (!result.package) throw notFound('插件包不存在');
    return { package: packageJson(result.package), listing: listingJson(result.listing) };
  }

  async updateReleaseStatus(userId: string, releaseId: string, status: 'PUBLISHED' | 'YANKED') {
    if (status !== 'PUBLISHED' && status !== 'YANKED') throw badRequest('发行版状态无效');
    const release = await this.prisma.pluginRelease.findUnique({
      where: { id: releaseId },
      include: { package: { include: { listing: true } } },
    });
    if (!release) throw notFound('发行版不存在');
    const membership = await this.auth.ensureCurrentTeam(userId);
    if (release.package.ownerTeamId !== membership.teamId) throw notFound('发行版不存在');
    await this.ensurePackageActor(userId, release.package, membership, 'team.plugin.edit_draft');
    if (release.status === status) return { release: releaseJson(release), listing: listingJson(release.package.listing) };
    if (status === 'PUBLISHED' && release.package.governanceStatus !== 'ACTIVE') throw conflict('已归档插件包不能恢复发行版');
    const expected = status === 'YANKED' ? 'PUBLISHED' : 'YANKED';
    const reason = status === 'YANKED' ? '作者撤回发行版' : '';
    const result = await this.serializableTransaction(async (tx) => {
      if (status === 'PUBLISHED') {
        const activePackage = await tx.pluginPackage.findUnique({ where: { id: release.packageId } });
        if (!activePackage || activePackage.governanceStatus !== 'ACTIVE') throw conflict('已归档插件包不能恢复发行版');
      }
      const wasPending = status === 'YANKED' && release.marketReviewStatus === 'PENDING';
      const claimed = await tx.pluginRelease.updateMany({
        where: {
          id: releaseId,
          status: expected,
          ...(status === 'YANKED' ? { marketReviewStatus: release.marketReviewStatus } : {}),
        },
        data: {
          status,
          ...(wasPending ? { marketReviewStatus: 'DRAFT' as const, reviewReason: reason, reviewedById: null, reviewedAt: null } : {}),
        },
      });
      if (claimed.count !== 1) throw conflict('发行版状态已变化，请刷新后重试');
      if (status === 'YANKED') {
        await tx.marketplaceListing.updateMany({
          where: { packageId: release.packageId, currentReleaseId: releaseId, status: 'ACTIVE' },
          data: {
            status: 'DELISTED',
            delistedBy: 'OWNER',
            delistReason: reason,
            delistedAt: new Date(),
            delistedByUserId: userId,
          },
        });
      }
      if (wasPending) await tx.pluginReleaseReview.create({ data: { releaseId, status: 'DRAFT', reason } });
      await tx.auditLog.create({
        data: {
          actorUserId: userId,
          action: status === 'YANKED' ? 'plugin.release.yanked' : 'plugin.release.restored',
          targetType: 'PluginRelease',
          targetId: releaseId,
          metadata: { packageId: release.packageId, from: expected, to: status },
        },
      });
      return {
        release: await tx.pluginRelease.findUnique({ where: { id: releaseId } }),
        listing: await tx.marketplaceListing.findUnique({ where: { packageId: release.packageId } }),
      };
    });
    if (!result.release) throw notFound('发行版不存在');
    return { release: releaseJson(result.release), listing: listingJson(result.listing) };
  }

  async updateOwnerMarketplaceStatus(userId: string, packageId: string, status: 'ACTIVE' | 'DELISTED', reason: string) {
    if (status !== 'ACTIVE' && status !== 'DELISTED') throw badRequest('市场状态无效');
    const { membership, pkg } = await this.currentTeamPackage(userId, packageId);
    await this.ensurePackageActor(userId, pkg, membership, 'team.plugin.submit_marketplace');
    const listing = await this.changeMarketplaceListingStatus(userId, packageId, status, 'OWNER', reason);
    return { packageId, listing: listingJson(listing) };
  }

  async updatePlatformMarketplaceStatus(actorId: string, packageId: string, status: 'ACTIVE' | 'DELISTED', reason: string) {
    if (status !== 'ACTIVE' && status !== 'DELISTED') throw badRequest('市场状态无效');
    await this.auth.ensurePlatformAdmin(actorId);
    const pkg = await this.prisma.pluginPackage.findUnique({ where: { id: packageId } });
    if (!pkg) throw notFound('插件包不存在');
    const listing = await this.changeMarketplaceListingStatus(actorId, packageId, status, 'PLATFORM', reason);
    return { packageId, listing: listingJson(listing) };
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

  async adminPackages(actorId: string, query: AdminPluginPackageQuery = {}) {
    await this.auth.ensurePlatformAdmin(actorId);
    const { page, pageSize, skip } = normalizeAdminPage(query);
    const where = adminPackageWhere(query);
    const [packages, total] = await Promise.all([
      this.prisma.pluginPackage.findMany({
        where,
        select: ADMIN_PACKAGE_LIST_SELECT,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        skip,
        take: pageSize,
      }),
      this.prisma.pluginPackage.count({ where }),
    ]);
    const packageIds = packages.map((pkg) => pkg.id);
    const releases = packageIds.length === 0
      ? []
      : await this.prisma.pluginRelease.findMany({
          where: { packageId: { in: packageIds } },
          select: ADMIN_RELEASE_SUMMARY_SELECT,
        });
    const releasesByPackage = groupAdminReleases(releases);
    return {
      items: packages.map((pkg) => adminPackageListItem(pkg, releasesByPackage.get(pkg.id) ?? [])),
      total,
      page,
      pageSize,
    };
  }

  async adminPackageDetail(actorId: string, packageId: string) {
    await this.auth.ensurePlatformAdmin(actorId);
    const pkg = await this.prisma.pluginPackage.findUnique({
      where: { id: packageId },
      select: ADMIN_PACKAGE_DETAIL_SELECT,
    });
    if (!pkg) throw notFound('插件包不存在');
    const [releaseCount, pendingReviewCount] = await Promise.all([
      this.prisma.pluginRelease.count({ where: { packageId } }),
      this.prisma.pluginRelease.count({ where: { packageId, marketReviewStatus: 'PENDING' } }),
    ]);
    return projectAdminPackageDetail(pkg, releaseCount, pendingReviewCount);
  }

  async adminPackageReleases(actorId: string, packageId: string, query: AdminPageQuery = {}) {
    await this.auth.ensurePlatformAdmin(actorId);
    const { page, pageSize, skip } = normalizeAdminPage(query);
    const pkg = await this.prisma.pluginPackage.findUnique({
      where: { id: packageId },
      select: { id: true, listing: { select: { status: true, currentReleaseId: true } } },
    });
    if (!pkg) throw notFound('插件包不存在');
    const [releases, total] = await Promise.all([
      this.prisma.pluginRelease.findMany({
        where: { packageId },
        select: ADMIN_RELEASE_SUMMARY_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: pageSize,
      }),
      this.prisma.pluginRelease.count({ where: { packageId } }),
    ]);
    return {
      items: releases.map((release) => adminReleaseSummary(release, pkg.listing)),
      total,
      page,
      pageSize,
    };
  }

  async adminReleaseCore(actorId: string, releaseId: string) {
    await this.auth.ensurePlatformAdmin(actorId);
    const release = await this.prisma.pluginRelease.findUnique({
      where: { id: releaseId },
      select: ADMIN_RELEASE_CORE_SELECT,
    });
    if (!release) throw notFound('发行版不存在');
    return projectAdminReleaseCore(release);
  }

  async adminReleaseManifest(actorId: string, releaseId: string) {
    await this.auth.ensurePlatformAdmin(actorId);
    const release = await this.prisma.pluginRelease.findUnique({
      where: { id: releaseId },
      select: ADMIN_RELEASE_MANIFEST_SELECT,
    });
    if (!release) throw notFound('发行版不存在');
    return { releaseId: release.id, manifest: release.manifest };
  }

  async adminReleaseFiles(actorId: string, releaseId: string, query: AdminPageQuery = {}) {
    await this.auth.ensurePlatformAdmin(actorId);
    const { page, pageSize, skip } = normalizeAdminPage(query);
    const release = await this.prisma.pluginRelease.findUnique({
      where: { id: releaseId },
      select: ADMIN_RELEASE_FILES_SELECT,
    });
    if (!release) throw notFound('发行版不存在');
    const files = normalizeFileManifest(release.fileManifest);
    return {
      items: files.slice(skip, skip + pageSize),
      total: files.length,
      page,
      pageSize,
    };
  }

  async adminReleaseReviews(actorId: string, releaseId: string, query: AdminPageQuery = {}) {
    await this.auth.ensurePlatformAdmin(actorId);
    const { page, pageSize, skip } = normalizeAdminPage(query);
    const release = await this.prisma.pluginRelease.findUnique({ where: { id: releaseId }, select: { id: true } });
    if (!release) throw notFound('发行版不存在');
    const [reviews, total] = await Promise.all([
      this.prisma.pluginReleaseReview.findMany({
        where: { releaseId },
        select: ADMIN_RELEASE_REVIEW_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: pageSize,
      }),
      this.prisma.pluginReleaseReview.count({ where: { releaseId } }),
    ]);
    return {
      items: reviews.map(adminReleaseReview),
      total,
      page,
      pageSize,
    };
  }

  async delistPackage(actorId: string, packageId: string, reason: string) {
    const normalizedReason = normalizeRequiredReason(reason, '请填写 1 到 500 字符的下架原因');
    const result = await this.updatePlatformMarketplaceStatus(actorId, packageId, 'DELISTED', normalizedReason);
    return { ...result, listing: adminListingProjection(result.listing) };
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
        currentReleaseId: release.package.listing?.currentReleaseId ?? null,
        isMarketplaceCurrent: release.package.listing?.status === 'ACTIVE'
          && release.package.listing.currentReleaseId === release.id,
        priceCents: release.package.listing?.priceCents ?? null,
        listing: listingJson(release.package.listing),
      })),
    };
  }

  async reviewDetail(actorId: string, releaseId: string) {
    await this.auth.ensurePlatformAdmin(actorId);
    const release = await this.prisma.pluginRelease.findUnique({
      where: { id: releaseId }, include: { package: { include: { listing: true } }, reviews: { orderBy: { createdAt: 'desc' } } },
    });
    if (!release) throw notFound('发行版不存在');
    return {
      package: packageJson(release.package),
      release: releaseJson(release),
      listing: listingJson(release.package.listing),
      isMarketplaceCurrent: release.package.listing?.status === 'ACTIVE'
        && release.package.listing.currentReleaseId === release.id,
      fileManifest: release.fileManifest,
      reviews: release.reviews.map((review) => ({ ...review, createdAt: review.createdAt.toISOString() })),
    };
  }

  async approveRelease(actorId: string, releaseId: string) {
    await this.auth.ensurePlatformAdmin(actorId);
    const release = await this.prisma.pluginRelease.findUnique({ where: { id: releaseId }, include: { package: true } });
    if (!release || release.marketReviewStatus !== 'PENDING') throw conflict('发行版不在待审核状态');
    if (release.status !== 'PUBLISHED' || release.package.governanceStatus !== 'ACTIVE') {
      throw conflict('只有活动插件包中的已发布发行版可以通过审核');
    }
    const result = await this.serializableTransaction(async (tx) => {
      const activePackage = await tx.pluginPackage.findUnique({ where: { id: release.packageId } });
      if (!activePackage || activePackage.governanceStatus !== 'ACTIVE') {
        throw conflict('已归档插件包不能通过市场审核');
      }
      const claimed = await tx.pluginRelease.updateMany({
        where: { id: releaseId, status: 'PUBLISHED', marketReviewStatus: 'PENDING' },
        data: { marketReviewStatus: 'APPROVED', reviewReason: '', reviewedById: actorId, reviewedAt: new Date() },
      });
      if (claimed.count !== 1) throw conflict('发行版审核状态已变化，请刷新后重试');
      const candidates = await tx.pluginRelease.findMany({
        where: { packageId: release.packageId, status: 'PUBLISHED', marketReviewStatus: 'APPROVED' },
        select: { id: true, version: true },
      });
      const current = highestSemVer(candidates);
      if (!current) throw conflict('没有可上架的已通过发行版');
      const listing = await tx.marketplaceListing.findUnique({ where: { packageId: release.packageId } });
      const delisted = listing?.status === 'DELISTED';
      await tx.marketplaceListing.upsert({
        where: { packageId: release.packageId },
        update: delisted
          ? { currentReleaseId: current.id }
          : {
              currentReleaseId: current.id,
              status: 'ACTIVE',
              delistedBy: null,
              delistReason: '',
              delistedAt: null,
              delistedByUserId: null,
            },
        create: { packageId: release.packageId, currentReleaseId: current.id, status: 'ACTIVE' },
      });
      await tx.pluginReleaseReview.create({ data: { releaseId, reviewerId: actorId, status: 'APPROVED' } });
      await tx.auditLog.create({
        data: {
          actorUserId: actorId,
          action: 'admin.plugin_release.approved',
          targetType: 'PluginRelease',
          targetId: releaseId,
          metadata: { packageId: release.packageId, version: release.version, currentReleaseId: current.id },
        },
      });
      return { release: await tx.pluginRelease.findUnique({ where: { id: releaseId } }), currentReleaseId: current.id };
    });
    if (!result.release) throw notFound('发行版不存在');
    return { release: releaseJson(result.release), currentReleaseId: result.currentReleaseId };
  }

  async rejectRelease(actorId: string, releaseId: string, reason: string) {
    await this.auth.ensurePlatformAdmin(actorId);
    const release = await this.prisma.pluginRelease.findUnique({ where: { id: releaseId } });
    if (!release || release.marketReviewStatus !== 'PENDING') throw conflict('发行版不在待审核状态');
    const reviewReason = normalizeRequiredReason(reason, '请填写 1 到 500 字符的驳回原因');
    const updated = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.pluginRelease.updateMany({
        where: { id: releaseId, status: 'PUBLISHED', marketReviewStatus: 'PENDING' },
        data: { marketReviewStatus: 'REJECTED', reviewReason, reviewedById: actorId, reviewedAt: new Date() },
      });
      if (claimed.count !== 1) throw conflict('发行版审核状态已变化，请刷新后重试');
      await tx.pluginReleaseReview.create({ data: { releaseId, reviewerId: actorId, status: 'REJECTED', reason: reviewReason } });
      await tx.auditLog.create({ data: { actorUserId: actorId, action: 'admin.plugin_release.rejected', targetType: 'PluginRelease', targetId: releaseId, metadata: { packageId: release.packageId, version: release.version, reason: reviewReason } } });
      return tx.pluginRelease.findUnique({ where: { id: releaseId } });
    });
    if (!updated) throw notFound('发行版不存在');
    return { release: releaseJson(updated) };
  }

  async delistRelease(actorId: string, releaseId: string, reason: string) {
    await this.auth.ensurePlatformAdmin(actorId);
    const normalizedReason = normalizeRequiredReason(reason, '请填写 1 到 500 字符的下架原因');
    const release = await this.prisma.pluginRelease.findUnique({ where: { id: releaseId } });
    if (!release) throw notFound('发行版不存在');
    const listing = await this.prisma.marketplaceListing.findUnique({ where: { packageId: release.packageId } });
    if (!listing || listing.status !== 'ACTIVE' || listing.currentReleaseId !== releaseId) {
      throw conflict('只有市场当前发行版可以触发下架');
    }
    const updated = await this.changeMarketplaceListingStatus(
      actorId,
      release.packageId,
      'DELISTED',
      'PLATFORM',
      normalizedReason,
      releaseId,
    );
    return { packageId: release.packageId, status: 'DELISTED' as const, listing: listingJson(updated) };
  }

  private async audit(actorUserId: string, action: string, targetType: string, targetId: string, metadata?: unknown) {
    await this.prisma.auditLog.create({ data: { actorUserId, action, targetType, targetId, metadata: metadata as Prisma.InputJsonValue } });
  }
}
