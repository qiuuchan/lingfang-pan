import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaService } from '../prisma.service';
import { ARTIFACT_STORE, type ArtifactStore } from './artifact-store';

const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

@Injectable()
export class PluginArtifactCleanupService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ARTIFACT_STORE) private readonly artifacts: ArtifactStore,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.cleanup().catch(() => undefined), CLEANUP_INTERVAL_MS);
    this.timer.unref();
    void this.cleanup().catch(() => undefined);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async cleanup() {
    const releases = await this.prisma.pluginRelease.findMany({ select: { artifactKey: true } });
    const removedArtifacts = await this.artifacts.cleanupOrphans(new Set(releases.map((release) => release.artifactKey)), ORPHAN_AGE_MS);
    const removedStaging = await cleanupStaging(process.env.PLUGIN_ARTIFACT_STAGING_DIR || join(tmpdir(), 'lingfang-plugin-artifacts'));
    return { removedArtifacts, removedStaging };
  }
}

export async function cleanupStaging(root: string, olderThanMs = ORPHAN_AGE_MS) {
  let removed = 0;
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || (!entry.name.startsWith('upload-') && !entry.name.startsWith('legacy-plugin-v4-'))) continue;
    const path = join(root, entry.name);
    const info = await stat(path).catch(() => null);
    if (info && Date.now() - info.mtimeMs >= olderThanMs) {
      await rm(path, { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}
