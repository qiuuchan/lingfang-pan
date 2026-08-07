import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createArtifactStore, type ArtifactDownload } from './modules/artifact-store';
import {
  checkPluginAiPolicy,
  PLUGIN_AI_POLICY_VERSION,
  pluginAiPolicyReason,
  type PluginAiPolicyResult,
} from './modules/plugin-ai-policy';
import { inspectPluginArtifact } from './modules/plugin-artifact';
import { PrismaService } from './prisma.service';

type Summary = {
  mode: 'dry-run' | 'apply';
  releases: { total: number; passed: number; quarantined: number; failed: number };
  failures: Array<{ type: 'PluginRelease'; id: string; reason: string }>;
};

function unscannableResult(path: string): PluginAiPolicyResult {
  return {
    policyVersion: PLUGIN_AI_POLICY_VERSION,
    ok: false,
    diagnostics: [{ code: 'ai.policy.unscannable', path, message: '存量插件制品不可扫描' }],
    requiredCapabilities: [],
    truncated: false,
  };
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

async function main() {
  const apply = process.argv.includes('--apply');
  const prisma = new PrismaService();
  const artifacts = createArtifactStore(process.env);
  const stagingRoot =
    process.env.PLUGIN_ARTIFACT_STAGING_DIR || join(tmpdir(), 'lingfang-plugin-artifacts');
  const summary: Summary = {
    mode: apply ? 'apply' : 'dry-run',
    releases: { total: 0, passed: 0, quarantined: 0, failed: 0 },
    failures: [],
  };
  await prisma.$connect();
  try {
    const releases = await prisma.pluginRelease.findMany({ orderBy: { createdAt: 'asc' } });
    summary.releases.total = releases.length;
    await mkdir(stagingRoot, { recursive: true });
    for (const release of releases) {
      const directory = await mkdtemp(join(stagingRoot, 'ai-policy-audit-'));
      let result: PluginAiPolicyResult;
      try {
        const artifactPath = join(directory, 'artifact.lfplugin');
        await writeDownload(await artifacts.download(release.artifactKey), artifactPath);
        const inspected = await inspectPluginArtifact(artifactPath);
        result = checkPluginAiPolicy({
          manifest: inspected.manifest,
          files: inspected.policyFiles,
        });
      } catch {
        result = unscannableResult('artifact.lfplugin');
        summary.releases.failed += 1;
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
      if (result.ok) summary.releases.passed += 1;
      else {
        summary.releases.quarantined += 1;
        summary.failures.push({
          type: 'PluginRelease',
          id: release.id,
          reason: pluginAiPolicyReason(result),
        });
      }
      if (apply) {
        await prisma.$transaction(async (tx) => {
          await tx.pluginRelease.update({
            where: { id: release.id },
            data: {
              aiPolicyVersion: result.policyVersion,
              aiPolicyStatus: result.ok ? 'PASSED' : 'FAILED',
              aiPolicyReason: pluginAiPolicyReason(result),
              ...(result.ok ? {} : { status: 'YANKED' }),
            },
          });
          if (!result.ok) {
            await tx.marketplaceListing.updateMany({
              where: {
                packageId: release.packageId,
                currentReleaseId: release.id,
                status: 'ACTIVE',
              },
              data: {
                status: 'DELISTED',
                delistedBy: 'PLATFORM',
                delistReason: '当前发行版未通过插件 AI 使用政策检查',
                delistedAt: new Date(),
                delistedByUserId: null,
              },
            });
            await tx.auditLog.create({
              data: {
                action: 'plugin_release.ai_policy.quarantined',
                targetType: 'PluginRelease',
                targetId: release.id,
                metadata: {
                  policyVersion: result.policyVersion,
                  diagnostics: result.diagnostics.map((item) => item.code),
                },
              },
            });
          }
        });
      }
    }
  } finally {
    await prisma.$disconnect();
  }
  console.log(JSON.stringify(summary, null, 2));
  if (summary.failures.length > 0) process.exitCode = 1;
}

void main();
