import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Prisma } from '@prisma/client';
import { createArtifactStore, type ArtifactDownload } from './modules/artifact-store';
import { assertPluginAiPolicy } from './modules/plugin-ai-policy-enforcement';
import { inspectPluginArtifact } from './modules/plugin-artifact';
import {
  loadLegacyPlugins,
  type LegacyPlugin,
  type LegacyPurchase,
  type LegacyRating,
} from './migrate-plugin-registry-v4-legacy';
import { PrismaService } from './prisma.service';

type LegacyFile = { path: string; content: string; binary?: boolean };
type ZipCentralEntry = { name: Buffer; crc32: number; size: number; offset: number };

type Verification = {
  pluginsWithoutMapping: number;
  purchasesWithoutV4Identity: number;
  purchasesWithoutMetric: number;
  enabledInstallationsWithoutEntitlement: number;
  installationsWithoutMetric: number;
  ratingsWithoutV4Fact: number;
  reviewsWithoutV4History: number;
  grantsWithoutPackage: number;
};

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let current = value;
  for (let bit = 0; bit < 8; bit += 1)
    current = current & 1 ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
  return current >>> 0;
});

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function safePath(raw: string): string {
  const path = raw.trim().replace(/\\/g, '/');
  const parts = path.split('/');
  if (
    !path ||
    path.startsWith('/') ||
    /^[A-Za-z]:\//.test(path) ||
    parts.some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(`legacy plugin contains unsafe path: ${raw}`);
  }
  if (
    ['data', '.git', '.venv', 'venv', 'node_modules', '.lingfang', '__pycache__'].includes(
      parts[0]!.toLowerCase()
    )
  ) {
    throw new Error(`legacy plugin contains runtime/data path: ${path}`);
  }
  return path;
}

async function writeChunk(
  file: Awaited<ReturnType<typeof open>>,
  buffer: Buffer,
  position: number
) {
  await file.write(buffer, 0, buffer.length, position);
  return position + buffer.length;
}

async function sha256File(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function writeDownload(download: ArtifactDownload, path: string): Promise<void> {
  if (download.kind === 'stream') {
    await pipeline(download.stream as Readable, createWriteStream(path, { flags: 'wx' }));
    return;
  }
  const response = await fetch(download.url);
  if (!response.ok || !response.body)
    throw new Error(`artifact download failed: ${response.status}`);
  await pipeline(
    Readable.fromWeb(response.body as never),
    createWriteStream(path, { flags: 'wx' })
  );
}

async function writeV4Artifact(
  path: string,
  manifest: Record<string, unknown>,
  files: LegacyFile[]
): Promise<void> {
  const source = files
    .map((file) => ({
      name: safePath(file.path),
      bytes: file.binary ? Buffer.from(file.content, 'base64') : Buffer.from(file.content, 'utf8'),
    }))
    .filter((file) => file.name !== '_meta.json' && file.name !== 'manifest.json')
    .sort((left, right) => left.name.localeCompare(right.name));
  const entries = [
    { name: '_meta.json', bytes: Buffer.from('{"format":"lingfang-plugin","formatVersion":4}') },
    { name: 'manifest.json', bytes: Buffer.from(JSON.stringify(manifest, null, 2)) },
    ...source,
  ];
  const output = await open(path, 'wx');
  const central: ZipCentralEntry[] = [];
  let position = 0;
  try {
    for (const entry of entries) {
      const name = Buffer.from(entry.name, 'utf8');
      const offset = position;
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(0x808, 6);
      header.writeUInt16LE(0, 8);
      header.writeUInt16LE(name.length, 26);
      position = await writeChunk(output, header, position);
      position = await writeChunk(output, name, position);
      position = await writeChunk(output, entry.bytes, position);
      const crc = crc32(entry.bytes);
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(entry.bytes.length, 8);
      descriptor.writeUInt32LE(entry.bytes.length, 12);
      position = await writeChunk(output, descriptor, position);
      central.push({ name, crc32: crc, size: entry.bytes.length, offset });
    }
    const centralOffset = position;
    for (const entry of central) {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(0x0314, 4);
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(0x808, 8);
      header.writeUInt16LE(0, 10);
      header.writeUInt32LE(entry.crc32, 16);
      header.writeUInt32LE(entry.size, 20);
      header.writeUInt32LE(entry.size, 24);
      header.writeUInt16LE(entry.name.length, 28);
      header.writeUInt32LE((0o100644 << 16) >>> 0, 38);
      header.writeUInt32LE(entry.offset, 42);
      position = await writeChunk(output, header, position);
      position = await writeChunk(output, entry.name, position);
    }
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(central.length, 8);
    eocd.writeUInt16LE(central.length, 10);
    eocd.writeUInt32LE(position - centralOffset, 12);
    eocd.writeUInt32LE(centralOffset, 16);
    await writeChunk(output, eocd, position);
  } finally {
    await output.close();
  }
}

function legacyManifest(plugin: {
  name: string;
  description: string;
  version: string;
  entry: string;
  runtimeType: string;
  visibility: string;
  manifest: unknown;
  capabilities: unknown;
}) {
  const current =
    plugin.manifest && typeof plugin.manifest === 'object' && !Array.isArray(plugin.manifest)
      ? (plugin.manifest as Record<string, unknown>)
      : {};
  return {
    ...current,
    id: String(current.id || plugin.name),
    name: plugin.name,
    description: plugin.description,
    version: plugin.version,
    entry: plugin.entry,
    runtime_type: String(current.runtime_type || plugin.runtimeType).toLowerCase(),
    visibility: plugin.visibility === 'PRIVATE' ? 'private' : 'tenant',
    capabilities: Array.isArray(plugin.capabilities) ? plugin.capabilities : [],
  };
}

function latestRatingsByTeam(ratings: LegacyRating[]): LegacyRating[] {
  const latest = new Map<string, LegacyRating>();
  for (const rating of [...ratings].sort((left, right) => {
    const byTime = left.createdAt.getTime() - right.createdAt.getTime();
    return byTime || left.id.localeCompare(right.id);
  }))
    latest.set(rating.teamId, rating);
  return [...latest.values()];
}

function auditMapping(metadata: unknown): { packageId: string; releaseId: string } | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const value = metadata as Record<string, unknown>;
  return typeof value.packageId === 'string' && typeof value.releaseId === 'string'
    ? { packageId: value.packageId, releaseId: value.releaseId }
    : null;
}

async function verifyLegacyCutover(
  prisma: PrismaService,
  plugins: LegacyPlugin[]
): Promise<Verification> {
  const verification: Verification = {
    pluginsWithoutMapping: 0,
    purchasesWithoutV4Identity: 0,
    purchasesWithoutMetric: 0,
    enabledInstallationsWithoutEntitlement: 0,
    installationsWithoutMetric: 0,
    ratingsWithoutV4Fact: 0,
    reviewsWithoutV4History: 0,
    grantsWithoutPackage: 0,
  };
  for (const plugin of plugins) {
    const audit = await prisma.auditLog.findFirst({
      where: {
        action: 'plugin.registry.legacy_migrated',
        targetType: 'Plugin',
        targetId: plugin.id,
      },
      orderBy: { createdAt: 'desc' },
      select: { metadata: true },
    });
    const mapping = auditMapping(audit?.metadata);
    const mappedRelease = mapping
      ? await prisma.pluginRelease.findUnique({
          where: { id: mapping.releaseId },
          select: { packageId: true, version: true, package: { select: { ownerTeamId: true } } },
        })
      : null;
    const validMapping = Boolean(
      mapping &&
      plugin.teamId &&
      mappedRelease &&
      mappedRelease.packageId === mapping.packageId &&
      mappedRelease.package.ownerTeamId === plugin.teamId &&
      mappedRelease.version === plugin.version
    );
    if (!mapping || !validMapping) {
      verification.pluginsWithoutMapping += 1;
      verification.purchasesWithoutV4Identity += plugin.purchases.filter(
        (purchase) => !purchase.packageId || !purchase.releaseId
      ).length;
      verification.purchasesWithoutMetric += plugin.purchases.length;
      verification.enabledInstallationsWithoutEntitlement += plugin.installations.filter(
        (installation) => installation.status === 'ENABLED'
      ).length;
      verification.installationsWithoutMetric += plugin.installations.length;
      verification.ratingsWithoutV4Fact += latestRatingsByTeam(plugin.ratings).length;
      verification.reviewsWithoutV4History += plugin.reviews.length;
      verification.grantsWithoutPackage += plugin.pluginGrants.filter(
        (grant) => !grant.packageId
      ).length;
      continue;
    }
    verification.purchasesWithoutV4Identity += plugin.purchases.filter(
      (purchase) =>
        purchase.packageId !== mapping.packageId || purchase.releaseId !== mapping.releaseId
    ).length;
    for (const purchase of plugin.purchases) {
      const metric = await prisma.marketplaceMetricEvent.findUnique({
        where: { idempotencyKey: `legacy-purchase:${purchase.id}` },
        select: {
          packageId: true,
          releaseId: true,
          teamId: true,
          kind: true,
          sourceRecordId: true,
        },
      });
      if (
        !metric ||
        metric.packageId !== mapping.packageId ||
        metric.releaseId !== mapping.releaseId ||
        metric.teamId !== purchase.buyerTeamId ||
        metric.kind !== 'PURCHASED' ||
        metric.sourceRecordId !== purchase.id
      )
        verification.purchasesWithoutMetric += 1;
    }
    for (const installation of plugin.installations.filter((item) => item.status === 'ENABLED')) {
      const entitlement = await prisma.pluginEntitlement.findFirst({
        where: { teamId: installation.teamId, packageId: mapping.packageId, status: 'ACTIVE' },
        select: { id: true },
      });
      if (!entitlement) verification.enabledInstallationsWithoutEntitlement += 1;
    }
    for (const installation of plugin.installations) {
      const metric = await prisma.marketplaceMetricEvent.findUnique({
        where: { idempotencyKey: `legacy-installation:${installation.id}` },
        select: {
          packageId: true,
          releaseId: true,
          teamId: true,
          kind: true,
          sourceRecordId: true,
        },
      });
      if (
        !metric ||
        metric.packageId !== mapping.packageId ||
        metric.releaseId !== mapping.releaseId ||
        metric.teamId !== installation.teamId ||
        metric.kind !== 'INSTALL_SUCCEEDED' ||
        metric.sourceRecordId !== installation.id
      )
        verification.installationsWithoutMetric += 1;
    }
    for (const rating of latestRatingsByTeam(plugin.ratings)) {
      const revision = await prisma.marketplaceRatingRevision.findFirst({
        where: {
          packageId: mapping.packageId,
          teamId: rating.teamId,
          sourceKind: 'LEGACY_PLUGIN_RATING',
          sourceId: rating.id,
        },
        select: { id: true },
      });
      const current = await prisma.marketplaceRating.findUnique({
        where: { packageId_teamId: { packageId: mapping.packageId, teamId: rating.teamId } },
        select: { id: true },
      });
      const metric = await prisma.marketplaceMetricEvent.findUnique({
        where: { idempotencyKey: `legacy-rating:${rating.id}` },
        select: {
          packageId: true,
          releaseId: true,
          teamId: true,
          kind: true,
          sourceRecordId: true,
        },
      });
      const metricMatches =
        metric &&
        metric.packageId === mapping.packageId &&
        metric.releaseId === mapping.releaseId &&
        metric.teamId === rating.teamId &&
        metric.kind === 'RATING_CHANGED' &&
        metric.sourceRecordId === rating.id;
      if ((!revision && !current) || !metricMatches) verification.ratingsWithoutV4Fact += 1;
    }
    for (const review of plugin.reviews) {
      const migrated = await prisma.pluginReleaseReview.findFirst({
        where: {
          releaseId: mapping.releaseId,
          reviewerId: review.reviewerId,
          status: review.status,
          reason: review.reason,
          createdAt: review.createdAt,
        },
        select: { id: true },
      });
      if (!migrated) verification.reviewsWithoutV4History += 1;
    }
    verification.grantsWithoutPackage += plugin.pluginGrants.filter(
      (grant) => grant.packageId !== mapping.packageId
    ).length;
  }
  return verification;
}

function verificationFailed(value: Verification): boolean {
  return Object.values(value).some((count) => count > 0);
}

async function main() {
  const apply = process.argv.includes('--apply');
  const verify = process.argv.includes('--verify');
  const prisma = new PrismaService();
  const artifacts = createArtifactStore(process.env);
  const stagingRoot =
    process.env.PLUGIN_ARTIFACT_STAGING_DIR || join(tmpdir(), 'lingfang-plugin-artifacts');
  await prisma.$connect();
  const summary = {
    mode: verify ? 'verify' : apply ? 'apply' : 'dry-run',
    total: 0,
    migrated: 0,
    skipped: 0,
    failed: 0,
    failures: [] as Array<{ pluginId: string; error: string }>,
    verification: null as Verification | null,
  };
  try {
    const plugins = await loadLegacyPlugins(prisma);
    summary.total = plugins.length;
    if (verify) {
      summary.verification = await verifyLegacyCutover(prisma, plugins);
      if (verificationFailed(summary.verification))
        summary.failed = Object.values(summary.verification).reduce((sum, count) => sum + count, 0);
    } else {
      for (const plugin of plugins) {
        let directory = '';
        let artifactKey = '';
        try {
          if (!plugin.teamId)
            throw new Error(
              'legacy plugin has no teamId and cannot be mapped to PluginPackage.ownerTeamId'
            );
          const manifest = legacyManifest(plugin);
          const files = Array.isArray(plugin.files)
            ? (plugin.files as unknown as LegacyFile[])
            : [];
          await mkdir(stagingRoot, { recursive: true });
          directory = await mkdtemp(join(stagingRoot, 'legacy-plugin-v4-'));
          const artifactPath = join(directory, 'artifact.lfplugin');
          await writeV4Artifact(artifactPath, manifest, files);
          const inspected = await inspectPluginArtifact(artifactPath);
          let policy = assertPluginAiPolicy({
            manifest: inspected.manifest,
            files: inspected.policyFiles,
          });
          const sha256 = await sha256File(artifactPath);
          const sizeBytes = (await stat(artifactPath)).size;
          const existingPackage = await prisma.pluginPackage.findUnique({
            where: {
              ownerTeamId_manifestId: {
                ownerTeamId: plugin.teamId,
                manifestId: inspected.manifest.id,
              },
            },
          });
          const existingRelease = existingPackage
            ? await prisma.pluginRelease.findUnique({
                where: {
                  packageId_version: {
                    packageId: existingPackage.id,
                    version: inspected.manifest.version,
                  },
                },
              })
            : null;
          if (existingRelease) {
            if (existingRelease.sha256 !== sha256 || existingRelease.sizeBytes !== sizeBytes) {
              throw new Error('existing release artifact does not match the legacy plugin content');
            }
            const existingArtifactPath = join(directory, 'existing-artifact.lfplugin');
            await writeDownload(
              await artifacts.download(existingRelease.artifactKey),
              existingArtifactPath
            );
            const actualSha256 = await sha256File(existingArtifactPath);
            const actualSizeBytes = (await stat(existingArtifactPath)).size;
            if (
              actualSha256 !== existingRelease.sha256 ||
              actualSizeBytes !== existingRelease.sizeBytes
            ) {
              throw new Error('existing release artifact integrity check failed');
            }
            const existingInspected = await inspectPluginArtifact(existingArtifactPath);
            policy = assertPluginAiPolicy({
              manifest: existingInspected.manifest,
              files: existingInspected.policyFiles,
            });
          }
          if (!apply) {
            if (existingRelease) summary.skipped += 1;
            else summary.migrated += 1;
            continue;
          }
          const pkg =
            existingPackage ||
            (await prisma.pluginPackage.create({
              data: {
                ownerTeamId: plugin.teamId,
                authorUserId: plugin.authorUserId,
                manifestId: inspected.manifest.id,
                name: inspected.manifest.name,
                description: inspected.manifest.description,
              },
            }));
          let release = existingRelease;
          if (!release) {
            artifactKey = `${pkg.id}/${inspected.manifest.version}/${sha256}.lfplugin`;
            await artifacts.promote(artifactPath, artifactKey, sha256);
            release = await prisma.pluginRelease.create({
              data: {
                packageId: pkg.id,
                version: inspected.manifest.version,
                manifest: inspected.manifest as Prisma.InputJsonValue,
                fileManifest: inspected.files as Prisma.InputJsonValue,
                artifactKey,
                sha256,
                sizeBytes,
                sourceKind: 'LEGACY_MIGRATION',
                sourceLabel: '',
                ingestChannel: 'MIGRATION',
                marketReviewStatus: plugin.reviewStatus,
                reviewReason: plugin.reviewReason,
                reviewedById: plugin.reviewedById,
                reviewedAt: plugin.reviewedAt,
                createdById: plugin.authorUserId,
                createdAt: plugin.createdAt,
                aiPolicyVersion: policy.policyVersion,
                aiPolicyStatus: 'PASSED',
                aiPolicyReason: '',
              },
            });
          }
          await prisma.$transaction(async (tx) => {
            if (existingRelease) {
              await tx.pluginRelease.update({
                where: { id: release.id },
                data: {
                  aiPolicyVersion: policy.policyVersion,
                  aiPolicyStatus: 'PASSED',
                  aiPolicyReason: '',
                },
              });
            }
            const existingListing = await tx.marketplaceListing.findUnique({
              where: { packageId: pkg.id },
              select: { installCount: true },
            });
            if (plugin.marketplace && plugin.reviewStatus === 'APPROVED') {
              await tx.marketplaceListing.upsert({
                where: { packageId: pkg.id },
                update: {
                  currentReleaseId: release.id,
                  priceCents: plugin.priceCents,
                  status: 'ACTIVE',
                  installCount: Math.max(existingListing?.installCount ?? 0, plugin.installCount),
                },
                create: {
                  packageId: pkg.id,
                  currentReleaseId: release.id,
                  priceCents: plugin.priceCents,
                  status: 'ACTIVE',
                  installCount: plugin.installCount,
                  ratingCount: 0,
                  ratingSum: 0,
                },
              });
            }
            const purchasesByTeam = new Map<string, LegacyPurchase>();
            for (const purchase of [...plugin.purchases].sort(
              (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)
            )) {
              await tx.purchase.update({
                where: { id: purchase.id },
                data: {
                  packageId: pkg.id,
                  releaseId: release.id,
                  sellerTeamId: purchase.sellerTeamId ?? plugin.teamId,
                },
              });
              if (purchase.status !== 'REFUNDED' && !purchasesByTeam.has(purchase.buyerTeamId))
                purchasesByTeam.set(purchase.buyerTeamId, purchase);
              await tx.marketplaceMetricEvent.upsert({
                where: { idempotencyKey: `legacy-purchase:${purchase.id}` },
                update: {
                  packageId: pkg.id,
                  releaseId: release.id,
                  teamId: purchase.buyerTeamId,
                  kind: 'PURCHASED',
                  source: 'REGISTRY',
                  sourceRecordId: purchase.id,
                  value: purchase.status === 'REFUNDED' ? 0 : purchase.priceCents,
                  metadata: { legacyPluginId: plugin.id },
                  occurredAt: purchase.createdAt,
                },
                create: {
                  idempotencyKey: `legacy-purchase:${purchase.id}`,
                  packageId: pkg.id,
                  releaseId: release.id,
                  teamId: purchase.buyerTeamId,
                  kind: 'PURCHASED',
                  source: 'REGISTRY',
                  sourceRecordId: purchase.id,
                  value: purchase.status === 'REFUNDED' ? 0 : purchase.priceCents,
                  metadata: { legacyPluginId: plugin.id },
                  occurredAt: purchase.createdAt,
                },
              });
            }
            for (const [teamId, purchase] of purchasesByTeam) {
              const existingEntitlement = await tx.pluginEntitlement.findUnique({
                where: { teamId_packageId: { teamId, packageId: pkg.id } },
              });
              if (!existingEntitlement) {
                await tx.pluginEntitlement.create({
                  data: {
                    teamId,
                    packageId: pkg.id,
                    purchaseId: purchase.id,
                    activatedAt: purchase.createdAt,
                  },
                });
              } else if (
                !existingEntitlement.purchaseId &&
                existingEntitlement.status === 'ACTIVE'
              ) {
                await tx.pluginEntitlement.update({
                  where: { id: existingEntitlement.id },
                  data: { purchaseId: purchase.id },
                });
              }
            }
            await (tx as any).pluginGrant.updateMany({
              where: { pluginId: plugin.id },
              data: { packageId: pkg.id },
            });
            for (const review of plugin.reviews) {
              const migratedReview = await tx.pluginReleaseReview.findFirst({
                where: {
                  releaseId: release.id,
                  reviewerId: review.reviewerId,
                  status: review.status,
                  reason: review.reason,
                  createdAt: review.createdAt,
                },
                select: { id: true },
              });
              if (!migratedReview) {
                await tx.pluginReleaseReview.create({
                  data: {
                    releaseId: release.id,
                    reviewerId: review.reviewerId,
                    status: review.status,
                    reason: review.reason,
                    createdAt: review.createdAt,
                  },
                });
              }
            }
            for (const installation of plugin.installations) {
              const entitlement = await tx.pluginEntitlement.findUnique({
                where: { teamId_packageId: { teamId: installation.teamId, packageId: pkg.id } },
              });
              if (installation.status === 'ENABLED' && !entitlement) {
                const purchase = purchasesByTeam.get(installation.teamId);
                await tx.pluginEntitlement.create({
                  data: {
                    teamId: installation.teamId,
                    packageId: pkg.id,
                    purchaseId: purchase?.id ?? null,
                    activatedAt: installation.installedAt,
                  },
                });
              }
              await tx.marketplaceMetricEvent.upsert({
                where: { idempotencyKey: `legacy-installation:${installation.id}` },
                update: {
                  packageId: pkg.id,
                  releaseId: release.id,
                  teamId: installation.teamId,
                  kind: 'INSTALL_SUCCEEDED',
                  source: 'REGISTRY',
                  sourceRecordId: installation.id,
                  value: installation.status === 'ENABLED' ? 1 : 0,
                  metadata: {
                    legacyPluginId: plugin.id,
                    status: installation.status,
                    version: installation.version,
                    installedById: installation.installedById,
                  },
                  occurredAt: installation.installedAt,
                },
                create: {
                  idempotencyKey: `legacy-installation:${installation.id}`,
                  packageId: pkg.id,
                  releaseId: release.id,
                  teamId: installation.teamId,
                  kind: 'INSTALL_SUCCEEDED',
                  source: 'REGISTRY',
                  sourceRecordId: installation.id,
                  value: installation.status === 'ENABLED' ? 1 : 0,
                  metadata: {
                    legacyPluginId: plugin.id,
                    status: installation.status,
                    version: installation.version,
                    installedById: installation.installedById,
                  },
                  occurredAt: installation.installedAt,
                },
              });
            }
            for (const rating of latestRatingsByTeam(plugin.ratings)) {
              const sourceKind = 'LEGACY_PLUGIN_RATING';
              const sourceId = rating.id;
              await tx.marketplaceMetricEvent.upsert({
                where: { idempotencyKey: `legacy-rating:${rating.id}` },
                update: {
                  packageId: pkg.id,
                  releaseId: release.id,
                  teamId: rating.teamId,
                  kind: 'RATING_CHANGED',
                  source: 'REGISTRY',
                  sourceRecordId: rating.id,
                  value: rating.score,
                  metadata: { legacyPluginId: plugin.id },
                  occurredAt: rating.createdAt,
                },
                create: {
                  idempotencyKey: `legacy-rating:${rating.id}`,
                  packageId: pkg.id,
                  releaseId: release.id,
                  teamId: rating.teamId,
                  kind: 'RATING_CHANGED',
                  source: 'REGISTRY',
                  sourceRecordId: rating.id,
                  value: rating.score,
                  metadata: { legacyPluginId: plugin.id },
                  occurredAt: rating.createdAt,
                },
              });
              const existingFact = await tx.marketplaceRatingRevision.findFirst({
                where: { packageId: pkg.id, teamId: rating.teamId, sourceKind, sourceId },
                select: { id: true },
              });
              if (existingFact) continue;
              const current = await tx.marketplaceRating.findUnique({
                where: { packageId_teamId: { packageId: pkg.id, teamId: rating.teamId } },
              });
              if (current) continue; // Never overwrite a newer v4 team rating.
              const row = await tx.marketplaceRating.create({
                data: {
                  packageId: pkg.id,
                  teamId: rating.teamId,
                  score: rating.score,
                  comment: rating.comment,
                  revision: 1,
                  createdById: rating.userId,
                  updatedById: rating.userId,
                  createdAt: rating.createdAt,
                  updatedAt: rating.createdAt,
                },
              });
              await tx.marketplaceRatingRevision.create({
                data: {
                  ratingId: row.id,
                  packageId: pkg.id,
                  teamId: rating.teamId,
                  revision: 1,
                  score: rating.score,
                  recordedAt: rating.createdAt,
                  sourceKind,
                  sourceId,
                  actorUserId: rating.userId,
                },
              });
            }
            const listingRatings = await tx.marketplaceRating.findMany({
              where: { packageId: pkg.id },
              select: { score: true },
            });
            await tx.marketplaceListing.updateMany({
              where: { packageId: pkg.id },
              data: {
                ratingCount: listingRatings.length,
                ratingSum: listingRatings.reduce((sum, row) => sum + row.score, 0),
              },
            });
            const migratedAudit = await tx.auditLog.findFirst({
              where: {
                action: 'plugin.registry.legacy_migrated',
                targetType: 'Plugin',
                targetId: plugin.id,
              },
              select: { id: true },
            });
            if (migratedAudit) {
              await tx.auditLog.updateMany({
                where: {
                  action: 'plugin.registry.legacy_migrated',
                  targetType: 'Plugin',
                  targetId: plugin.id,
                },
                data: { metadata: { packageId: pkg.id, releaseId: release.id, sha256 } },
              });
            } else {
              await tx.auditLog.create({
                data: {
                  action: 'plugin.registry.legacy_migrated',
                  targetType: 'Plugin',
                  targetId: plugin.id,
                  metadata: { packageId: pkg.id, releaseId: release.id, sha256 },
                },
              });
            }
          });
          if (existingRelease) summary.skipped += 1;
          else summary.migrated += 1;
        } catch (error) {
          summary.failed += 1;
          const errorMessage = error instanceof Error ? error.message : String(error);
          summary.failures.push({ pluginId: plugin.id, error: errorMessage });
          if (apply) {
            await prisma.auditLog
              .create({
                data: {
                  action: 'plugin.registry.legacy_migration_failed',
                  targetType: 'Plugin',
                  targetId: plugin.id,
                  metadata: { error: errorMessage.slice(0, 500) },
                },
              })
              .catch(() => undefined);
          }
          if (artifactKey) {
            const referenced = await prisma.pluginRelease
              .count({ where: { artifactKey } })
              .catch(() => 0);
            if (referenced === 0) await artifacts.delete(artifactKey).catch(() => undefined);
          }
        } finally {
          if (directory) await rm(directory, { recursive: true, force: true });
        }
      }
    }
  } finally {
    await prisma.$disconnect();
  }
  console.log(JSON.stringify(summary, null, 2));
  if (summary.failed > 0) process.exitCode = 1;
}

void main();
