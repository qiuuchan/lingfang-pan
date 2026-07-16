import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError, notFound } from '../../common';
import { PrismaService } from '../../prisma.service';
import { ARTIFACT_STORE, ArtifactUnavailableError, type ArtifactDownload, type ArtifactStore } from '../artifact-store';
import { PLUGIN_AI_POLICY_VERSION } from '../plugin-ai-policy';
import { readPluginArtifactEntry } from '../plugin-artifact';

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

type PreviewFileManifestItem = { path: string; sizeBytes: number };

@Injectable()
export class WebPreviewAssetService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ARTIFACT_STORE) private readonly artifacts: ArtifactStore,
  ) {}

  async read(sessionId: string, requestedPath: string | undefined) {
    if (process.env.CLIENT_PLUGIN_PREVIEW_ENABLED === 'false') {
      throw new AppError(503, 'client_plugin_preview_disabled', 'Client 插件预览当前未开放');
    }
    const session = await this.prisma.webPreviewSession.findFirst({
      where: { id: sessionId, mode: 'CLIENT_SANDBOX', expiresAt: { gt: new Date() } },
      include: {
        release: {
          include: {
            package: { include: { listing: true } },
          },
        },
      },
    });
    if (!session) throw notFound('预览会话不存在或已过期');
    const release = session.release;
    const listing = release.package.listing;
    if (session.packageId !== release.packageId
      || session.releaseSha256 !== release.sha256
      || release.status !== 'PUBLISHED'
      || release.marketReviewStatus !== 'APPROVED'
      || release.aiPolicyVersion !== PLUGIN_AI_POLICY_VERSION
      || release.aiPolicyStatus !== 'PASSED'
      || release.package.governanceStatus !== 'ACTIVE'
      || !listing
      || listing.status !== 'ACTIVE'
      || listing.currentReleaseId !== release.id) {
      throw new AppError(410, 'web_preview_release_unavailable', '该发行版已无法预览');
    }
    const manifest = objectValue(release.manifest);
    const entry = typeof manifest.entry === 'string' ? manifest.entry : '';
    if (manifest.runtime_type !== 'client' || !entry.toLowerCase().endsWith('.html')) {
      throw new AppError(409, 'web_preview_bundle_incompatible', '发行版不是可预览的 Client HTML bundle');
    }
    const path = requestedPath?.trim() || entry;
    const files = normalizeFileManifest(release.fileManifest);
    const file = files.find((item) => item.path === path);
    if (!file) throw notFound('预览资源不存在');

    const directory = await mkdtemp(join(tmpdir(), 'lingfang-web-preview-'));
    const artifactPath = join(directory, 'release.lfplugin');
    try {
      await stageDownload(await this.artifacts.download(release.artifactKey), artifactPath);
      if (await sha256File(artifactPath) !== release.sha256) {
        throw new AppError(410, 'web_preview_artifact_mismatch', '预览制品完整性校验失败');
      }
      const body = await readPluginArtifactEntry(artifactPath, path);
      if (body.length !== file.sizeBytes) {
        throw new AppError(410, 'web_preview_asset_mismatch', '预览资源与审核文件清单不一致');
      }
      return {
        body,
        contentType: contentType(path, path === entry),
        entryPath: entry,
        isEntry: path === entry,
        path,
        releaseId: release.id,
        releaseSha256: release.sha256,
      };
    } catch (error) {
      if (error instanceof ArtifactUnavailableError) {
        throw new AppError(410, 'web_preview_artifact_unavailable', '预览制品已不可用');
      }
      throw error;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

async function sha256File(path: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer);
  return digest.digest('hex');
}

async function stageDownload(download: ArtifactDownload, path: string): Promise<void> {
  if (download.kind === 'stream') {
    await pipeline(download.stream, createWriteStream(path, { flags: 'wx' }));
    return;
  }
  const response = await fetch(download.url, { redirect: 'error' });
  if (!response.ok || !response.body) throw new ArtifactUnavailableError(`preview artifact download failed: ${response.status}`);
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(path, { flags: 'wx' }));
}

function normalizeFileManifest(value: unknown): PreviewFileManifestItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const item = objectValue(candidate);
    return typeof item.path === 'string' && Number.isSafeInteger(item.sizeBytes) && Number(item.sizeBytes) >= 0
      ? [{ path: item.path, sizeBytes: Number(item.sizeBytes) }]
      : [];
  });
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function contentType(path: string, isEntry: boolean): string {
  const dot = path.lastIndexOf('.');
  const extension = dot >= 0 ? path.slice(dot).toLowerCase() : '';
  if (extension === '.html' && !isEntry) return 'text/plain; charset=utf-8';
  return MIME_TYPES[extension] || 'application/octet-stream';
}
