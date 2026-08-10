import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaService } from '../prisma.service';
import { ARTIFACT_STORE, isMissingPathError, type ArtifactStore } from './artifact-store';

const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

@Injectable()
export class PluginArtifactCleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PluginArtifactCleanupService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ARTIFACT_STORE) private readonly artifacts: ArtifactStore
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.runScheduledCleanup(), CLEANUP_INTERVAL_MS);
    this.timer.unref();
    void this.runScheduledCleanup();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** 定时清理不能把进程带崩，但失败必须留痕——否则清理线程哑火不会有任何人知道。 */
  private async runScheduledCleanup() {
    try {
      await this.cleanup();
    } catch (error) {
      this.logger.error(
        '插件制品定时清理失败',
        error instanceof Error ? error.stack : String(error)
      );
    }
  }

  async cleanup() {
    const releases = await this.prisma.pluginRelease.findMany({ select: { artifactKey: true } });
    const removedArtifacts = await this.artifacts.cleanupOrphans(
      new Set(releases.map((release) => release.artifactKey)),
      ORPHAN_AGE_MS
    );
    const removedStaging = await cleanupStaging(
      process.env.PLUGIN_ARTIFACT_STAGING_DIR || join(tmpdir(), 'lingfang-plugin-artifacts')
    );
    // 适配报告暂存位只在「跑完适配 → 发布」这几分钟内有用，过期行必须扫掉，
    // 否则未发布的失败适配会把几百 KiB 的报告永久堆在库里。
    const removedAdaptationReports = await this.prisma.pluginAdaptationReport.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    return {
      removedArtifacts,
      removedStaging,
      removedAdaptationReports: removedAdaptationReports.count,
    };
  }
}

const stagingLogger = new Logger('cleanupStaging');

export async function cleanupStaging(root: string, olderThanMs = ORPHAN_AGE_MS) {
  let removed = 0;
  // 暂存根目录不存在 = 没有东西要清，属幂等正常路径；其余 I/O 故障（EPERM/EBUSY/EMFILE）
  // 必须炸出来，否则「清理失败」会被伪装成「清理了 0 个」，暂存目录会一直涨。
  const entries = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
    if (isMissingPathError(error)) return null;
    stagingLogger.error(
      `扫描插件暂存目录失败：${root}`,
      error instanceof Error ? error.stack : String(error)
    );
    throw new Error(`扫描插件暂存目录失败：${root}`, { cause: error });
  });
  if (entries === null) return removed;
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      (!entry.name.startsWith('upload-') && !entry.name.startsWith('legacy-plugin-v4-'))
    )
      continue;
    const path = join(root, entry.name);
    // 并发清理把目录抢先删了属正常竞态，跳过即可；其余故障同样必须上抛。
    const info = await stat(path).catch((error: unknown) => {
      if (isMissingPathError(error)) return null;
      stagingLogger.error(
        `读取插件暂存目录状态失败：${path}`,
        error instanceof Error ? error.stack : String(error)
      );
      throw new Error(`读取插件暂存目录状态失败：${path}`, { cause: error });
    });
    if (info === null) continue;
    if (Date.now() - info.mtimeMs >= olderThanMs) {
      await rm(path, { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}
