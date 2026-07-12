import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Prisma } from '@prisma/client';
import { createArtifactStore } from './modules/artifact-store';
import { inspectPluginArtifact } from './modules/plugin-artifact';
import { PrismaService } from './prisma.service';

type LegacyFile = { path: string; content: string; binary?: boolean };
type ZipCentralEntry = { name: Buffer; crc32: number; size: number; offset: number };

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let current = value;
  for (let bit = 0; bit < 8; bit += 1) current = (current & 1) ? (0xedb88320 ^ (current >>> 1)) : (current >>> 1);
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
  if (!path || path.startsWith('/') || /^[A-Za-z]:\//.test(path) || parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`legacy plugin contains unsafe path: ${raw}`);
  }
  if (['data', '.git', '.venv', 'venv', 'node_modules', '.lingfang', '__pycache__'].includes(parts[0]!.toLowerCase())) {
    throw new Error(`legacy plugin contains runtime/data path: ${path}`);
  }
  return path;
}

async function writeChunk(file: Awaited<ReturnType<typeof open>>, buffer: Buffer, position: number) {
  await file.write(buffer, 0, buffer.length, position);
  return position + buffer.length;
}

async function sha256File(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function writeV4Artifact(path: string, manifest: Record<string, unknown>, files: LegacyFile[]): Promise<void> {
  const source = files
    .map((file) => ({ name: safePath(file.path), bytes: file.binary ? Buffer.from(file.content, 'base64') : Buffer.from(file.content, 'utf8') }))
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
  name: string; description: string; version: string; entry: string; runtimeType: string; visibility: string;
  manifest: unknown; capabilities: unknown;
}) {
  const current = plugin.manifest && typeof plugin.manifest === 'object' && !Array.isArray(plugin.manifest)
    ? plugin.manifest as Record<string, unknown>
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

async function main() {
  const apply = process.argv.includes('--apply');
  const prisma = new PrismaService();
  const artifacts = createArtifactStore(process.env);
  const stagingRoot = process.env.PLUGIN_ARTIFACT_STAGING_DIR || join(tmpdir(), 'lingfang-plugin-artifacts');
  await prisma.$connect();
  const summary = { mode: apply ? 'apply' : 'dry-run', total: 0, migrated: 0, skipped: 0, failed: 0, failures: [] as Array<{ pluginId: string; error: string }> };
  try {
    const plugins = await prisma.plugin.findMany({
      include: { purchases: true, pluginGrants: true, reviews: true },
      orderBy: { createdAt: 'asc' },
    });
    summary.total = plugins.length;
    for (const plugin of plugins) {
      let directory = '';
      let artifactKey = '';
      try {
        if (!plugin.teamId) {
          summary.skipped += 1;
          continue;
        }
        const manifest = legacyManifest(plugin);
        const files = Array.isArray(plugin.files) ? plugin.files as unknown as LegacyFile[] : [];
        await mkdir(stagingRoot, { recursive: true });
        directory = await mkdtemp(join(stagingRoot, 'legacy-plugin-v4-'));
        const artifactPath = join(directory, 'artifact.lfplugin');
        await writeV4Artifact(artifactPath, manifest, files);
        const inspected = await inspectPluginArtifact(artifactPath);
        const sha256 = await sha256File(artifactPath);
        const sizeBytes = (await stat(artifactPath)).size;
        const existingPackage = await prisma.pluginPackage.findUnique({
          where: { ownerTeamId_manifestId: { ownerTeamId: plugin.teamId, manifestId: inspected.manifest.id } },
        });
        const existingRelease = existingPackage
          ? await prisma.pluginRelease.findUnique({ where: { packageId_version: { packageId: existingPackage.id, version: inspected.manifest.version } } })
          : null;
        if (!apply) {
          if (existingRelease) summary.skipped += 1;
          else summary.migrated += 1;
          continue;
        }
        const pkg = existingPackage || await prisma.pluginPackage.create({
          data: { ownerTeamId: plugin.teamId, authorUserId: plugin.authorUserId, manifestId: inspected.manifest.id, name: inspected.manifest.name, description: inspected.manifest.description },
        });
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
              marketReviewStatus: plugin.reviewStatus,
              reviewReason: plugin.reviewReason,
              reviewedById: plugin.reviewedById,
              reviewedAt: plugin.reviewedAt,
              createdById: plugin.authorUserId,
              createdAt: plugin.createdAt,
            },
          });
        }
        await prisma.$transaction(async (tx) => {
          if (plugin.marketplace && plugin.reviewStatus === 'APPROVED') {
            await tx.marketplaceListing.upsert({
              where: { packageId: pkg.id },
              update: { currentReleaseId: release.id, priceCents: plugin.priceCents, status: 'ACTIVE' },
              create: { packageId: pkg.id, currentReleaseId: release.id, priceCents: plugin.priceCents, status: 'ACTIVE', installCount: plugin.installCount, ratingCount: plugin.ratingCount, ratingSum: plugin.ratingSum },
            });
          }
          const purchasesByTeam = new Map<string, (typeof plugin.purchases)[number]>();
          for (const purchase of [...plugin.purchases].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
            if (!purchasesByTeam.has(purchase.buyerTeamId)) purchasesByTeam.set(purchase.buyerTeamId, purchase);
          }
          for (const [teamId, purchase] of purchasesByTeam) {
            await tx.pluginEntitlement.upsert({
              where: { teamId_packageId: { teamId, packageId: pkg.id } },
              update: { purchaseId: purchase.id },
              create: { teamId, packageId: pkg.id, purchaseId: purchase.id },
            });
          }
          await tx.pluginGrant.updateMany({ where: { pluginId: plugin.id }, data: { packageId: pkg.id } });
          for (const review of plugin.reviews) {
            const migratedReview = await tx.pluginReleaseReview.findFirst({
              where: { releaseId: release.id, reviewerId: review.reviewerId, status: review.status, reason: review.reason, createdAt: review.createdAt },
              select: { id: true },
            });
            if (!migratedReview) {
              await tx.pluginReleaseReview.create({ data: { releaseId: release.id, reviewerId: review.reviewerId, status: review.status, reason: review.reason, createdAt: review.createdAt } });
            }
          }
          const migratedAudit = await tx.auditLog.findFirst({
            where: { action: 'plugin.registry.legacy_migrated', targetType: 'Plugin', targetId: plugin.id },
            select: { id: true },
          });
          if (!migratedAudit) {
            await tx.auditLog.create({ data: { action: 'plugin.registry.legacy_migrated', targetType: 'Plugin', targetId: plugin.id, metadata: { packageId: pkg.id, releaseId: release.id, sha256 } } });
          }
        });
        if (existingRelease) summary.skipped += 1;
        else summary.migrated += 1;
      } catch (error) {
        summary.failed += 1;
        const errorMessage = error instanceof Error ? error.message : String(error);
        summary.failures.push({ pluginId: plugin.id, error: errorMessage });
        if (apply) {
          await prisma.auditLog.create({
            data: {
              action: 'plugin.registry.legacy_migration_failed',
              targetType: 'Plugin',
              targetId: plugin.id,
              metadata: { error: errorMessage.slice(0, 500) },
            },
          }).catch(() => undefined);
        }
        if (artifactKey) {
          const referenced = await prisma.pluginRelease.count({ where: { artifactKey } }).catch(() => 0);
          if (referenced === 0) await artifacts.delete(artifactKey).catch(() => undefined);
        }
      } finally {
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    }
  } finally {
    await prisma.$disconnect();
  }
  console.log(JSON.stringify(summary, null, 2));
  if (summary.failed > 0) process.exitCode = 1;
}

void main();
