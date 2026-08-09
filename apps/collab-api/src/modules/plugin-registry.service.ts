import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  PluginManifest,
  satisfiesActionVersionRange,
  type WorkflowFrozenSubplan,
  type WorkflowUpgradeSuggestionResponse,
} from '@lingfang/contract';
import { buildWorkflowClosure } from '@lingfang/workflow-engine';
import type { Readable } from 'node:stream';
import {
  AppError,
  badRequest,
  conflict,
  forbidden,
  insufficientBalance,
  notFound,
} from '../common';
import { PrismaService } from '../prisma.service';
import {
  ARTIFACT_STORE,
  type ArtifactDownload,
  ArtifactUnavailableError,
  type ArtifactStore,
} from './artifact-store';
import { AuthService } from './auth.service';
import { PLUGIN_AI_POLICY_VERSION } from './plugin-ai-policy';
import { assertPluginAiPolicy } from './plugin-ai-policy-enforcement';
import { checkPluginAiPolicy, type PluginAiPolicyFile } from './plugin-ai-policy';
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
  assertDryRunPayloadSize,
  highestSemVer,
  listingJson,
  NO_ADAPTATION,
  normalizeAdaptationReport,
  normalizeReleaseSource,
  normalizeStoredAdaptationStatus,
  packageJson,
  releaseDetailJson,
  releaseJson,
  releaseListJson,
  type RedeemedAdaptation,
  type ReleaseSourceHeaders,
} from './plugin-registry-model';
import { compareStrictSemVer, parseStrictSemVer } from './plugin-semver';
import { PluginGovernanceService } from './plugin-governance.service';
import { resolveMarketplacePrice } from './marketplace-commerce-calculator';
import { projectMarketplaceQualityGateTx } from './marketplace-quality-projection';

type UploadResult = { path: string; directory: string; sha256: string; sizeBytes: number };

/** 适配报告暂存位存活时长：够开发者看完报告、点「修复后再发布」，又不至于长期占库。 */
const ADAPTATION_REPORT_TTL_MS = 30 * 60 * 1000;

const RELEASE_LIST_SELECT = {
  id: true,
  packageId: true,
  version: true,
  manifest: true,
  packagePolicySurfaceSha256: true,
  sha256: true,
  sizeBytes: true,
  status: true,
  marketReviewStatus: true,
  targetPlatform: true,
  sourceKind: true,
  sourceLabel: true,
  ingestChannel: true,
  reviewReason: true,
  aiPolicyVersion: true,
  aiPolicyStatus: true,
  aiPolicyReason: true,
  adaptationStatus: true,
  createdAt: true,
} satisfies Prisma.PluginReleaseSelect;

function assertStrictSemVer(version: string): void {
  if (!parseStrictSemVer(version)) throw badRequest('插件版本必须是严格 SemVer', { version });
}

function isPrerelease(version: string): boolean {
  const parsed = parseStrictSemVer(version);
  return !parsed || parsed.prerelease !== null;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function actionSurfaceManifest(
  manifest: Record<string, unknown>,
  workflowDefinitionSha256?: string
) {
  const runtime = String(manifest.runtime_type || 'client');
  const actions = Array.isArray(manifest.actions) ? manifest.actions : [];
  return actions
    .map((raw) => {
      const action = raw as Record<string, unknown>;
      const handler = action.handler as Record<string, unknown> | undefined;
      const execution =
        runtime === 'workflow'
          ? {
              runtime_type: 'workflow',
              entry: manifest.entry,
              definition_sha256: workflowDefinitionSha256,
            }
          : runtime === 'cloud'
            ? { runtime_type: 'cloud', adapter: 'cloud' }
            : runtime === 'python'
              ? { runtime_type: 'python', entry: handler?.entry, callable: handler?.callable }
              : { runtime_type: runtime, entry: handler?.entry, export: handler?.export };
      const surface = {
        schema_version: 1,
        action_id: action.action_id,
        action_contract_version: action.action_contract_version,
        input_schema: action.input_schema,
        output_schema: action.output_schema,
        execution_semantics: action.execution_semantics,
        timeout_seconds: action.timeout_seconds ?? 900,
        cloud_capable: action.cloud_capable ?? false,
        previewable: action.previewable ?? false,
        execution,
      };
      return {
        ...surface,
        name: action.name,
        description: action.description ?? '',
        action_surface_sha256: createHash('sha256').update(canonicalJson(surface)).digest('hex'),
      };
    })
    .sort((a, b) => String(a.action_id).localeCompare(String(b.action_id)));
}
function packagePolicySurfaceSha256(
  manifest: Record<string, unknown>,
  actionSurfaces: ReturnType<typeof actionSurfaceManifest>
): string {
  const capabilities = Array.isArray(manifest.capabilities)
    ? [
        ...new Set(
          manifest.capabilities.flatMap((item) =>
            item &&
            typeof item === 'object' &&
            typeof (item as { kind?: unknown }).kind === 'string'
              ? [(item as { kind: string }).kind]
              : []
          )
        ),
      ].sort()
    : [];
  const actions = actionSurfaces.map((action) => ({
    action_id: action.action_id,
    action_contract_version: action.action_contract_version,
    action_surface_sha256: action.action_surface_sha256,
    cloud_capable: action.cloud_capable,
    previewable: action.previewable,
  }));
  return createHash('sha256')
    .update(
      canonicalJson({
        schema_version: 1,
        runtime_type: manifest.runtime_type,
        declared_capabilities: capabilities,
        actions,
        shared_namespaces: [],
        schedule_eligible: false,
      })
    )
    .digest('hex');
}

function assertCurrentAiPolicy(release: { aiPolicyVersion: number; aiPolicyStatus: string }): void {
  if (release.aiPolicyVersion !== PLUGIN_AI_POLICY_VERSION || release.aiPolicyStatus !== 'PASSED') {
    throw new AppError(409, 'plugin_ai_policy_required', '插件发行版尚未通过当前 AI 使用政策检查');
  }
}

@Injectable()
export class PluginRegistryService {
  private readonly logger = new Logger(PluginRegistryService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(ARTIFACT_STORE) private readonly artifacts: ArtifactStore,
    @Inject(PluginGovernanceService) private readonly governance: PluginGovernanceService
  ) {}

  private async serializableTransaction<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>
  ): Promise<T> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        const retryable =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          (error.code === 'P2034' || error.code === 'P2002');
        if (!retryable) throw error;
        if (attempt === 4) throw conflict('插件状态发生并发冲突，请重试');
      }
    }
    throw conflict('插件状态发生并发冲突，请重试');
  }

  private async currentTeamPackage(userId: string, packageId: string) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const pkg = await this.prisma.pluginPackage.findUnique({
      where: { id: packageId },
      include: { listing: true },
    });
    if (!pkg || pkg.ownerTeamId !== membership.teamId) throw notFound('插件包不存在');
    return { membership, pkg };
  }

  private async ensurePackageActor(
    userId: string,
    pkg: { authorUserId: string | null },
    membership: { role: string },
    permission: string
  ): Promise<void> {
    if (pkg.authorUserId === userId || membership.role === 'TEAM_ADMIN') return;
    await this.auth.ensurePermission(userId, permission);
  }

  private async assertListingCanActivate(
    tx: Prisma.TransactionClient,
    packageId: string,
    listing: { currentReleaseId: string | null }
  ) {
    const pkg = await tx.pluginPackage.findUnique({ where: { id: packageId } });
    if (!pkg || pkg.governanceStatus !== 'ACTIVE') throw conflict('只有活动插件包可以恢复市场上架');
    if (!listing.currentReleaseId) throw conflict('市场 listing 没有可恢复的当前发行版');
    const release = await tx.pluginRelease.findUnique({ where: { id: listing.currentReleaseId } });
    if (
      !release ||
      release.packageId !== packageId ||
      release.status !== 'PUBLISHED' ||
      release.marketReviewStatus !== 'APPROVED'
    ) {
      throw conflict('市场当前发行版不满足恢复条件');
    }
    assertCurrentAiPolicy(release);
    return release;
  }

  private async changeMarketplaceListingStatus(
    actorUserId: string,
    packageId: string,
    status: 'ACTIVE' | 'DELISTED',
    actorKind: 'OWNER' | 'PLATFORM',
    reason: string,
    expectedCurrentReleaseId?: string
  ) {
    const normalizedReason = String(reason || '')
      .trim()
      .slice(0, 500);
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
          throw conflict(
            actorKind === 'OWNER'
              ? '只有作者主动下架的插件可由团队恢复'
              : '只有平台暂停的插件可由平台恢复'
          );
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
      await projectMarketplaceQualityGateTx(tx, packageId, `LISTING_${status}`, new Date());
      await tx.auditLog.create({
        data: {
          actorUserId,
          action:
            actorKind === 'OWNER'
              ? status === 'ACTIVE'
                ? 'plugin.marketplace.relisted'
                : 'plugin.marketplace.delisted'
              : status === 'ACTIVE'
                ? 'admin.plugin_package.relisted'
                : 'admin.plugin_package.delisted',
          targetType: 'PluginPackage',
          targetId: packageId,
          metadata: { status, actorKind, reason: normalizedReason },
        },
      });
      return tx.marketplaceListing.findUnique({ where: { id: listing.id } });
    });
  }

  private async spoolUpload(stream: Readable, contentLength?: number): Promise<UploadResult> {
    if (
      contentLength !== undefined &&
      (!Number.isFinite(contentLength) ||
        contentLength <= 0 ||
        contentLength > PLUGIN_ARTIFACT_MAX_BYTES)
    ) {
      throw badRequest('插件制品大小超限');
    }
    const stagingRoot =
      process.env.PLUGIN_ARTIFACT_STAGING_DIR || join(tmpdir(), 'lingfang-plugin-artifacts');
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

  /**
   * 服务端适配干跑：仅做 manifest 符号级校验 + AI 策略闸门，不执行插件、不安装依赖。
   * 供跳过桌面端的 CLI/API 上传在发布前自检。返回可直接展示给开发者的 issue 列表。
   */
  async dryRunAdaptation(
    manifest: unknown,
    files: PluginAiPolicyFile[] = []
  ): Promise<{
    ok: boolean;
    manifestValid: boolean;
    manifestErrors: Array<{ path: string; message: string }>;
    aiPolicy: { ok: boolean; diagnostics: Array<{ code: string; path: string; message: string }> };
  }> {
    assertDryRunPayloadSize(files);
    const parsed = PluginManifest.safeParse(manifest);
    const manifestErrors: Array<{ path: string; message: string }> = [];
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        manifestErrors.push({ path: issue.path.join('.'), message: issue.message });
      }
    }
    const policy = checkPluginAiPolicy({ manifest, files });
    return {
      ok: parsed.success && policy.ok,
      manifestValid: parsed.success,
      manifestErrors,
      aiPolicy: {
        ok: policy.ok,
        diagnostics: policy.diagnostics.map((d) => ({
          code: d.code,
          path: d.path,
          message: d.message,
        })),
      },
    };
  }

  /**
   * 暂存客户端跑出来的 AdaptationReport，换一个纯 ASCII 的 reportId。
   * HTTP 头是 ASCII-only 且网关普遍限到 8~32 KiB，装不下含中文的完整报告，
   * 所以发布请求只带 id，报告本体走这个 JSON body 端点。
   */
  async stageAdaptationReport(userId: string, report: unknown) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const normalized = normalizeAdaptationReport(report);
    const expiresAt = new Date(Date.now() + ADAPTATION_REPORT_TTL_MS);
    const staged = await this.prisma.pluginAdaptationReport.create({
      data: {
        userId,
        teamId: membership.teamId,
        status: normalized.status,
        report: normalized.report,
        expiresAt,
      },
      select: { id: true },
    });
    return {
      reportId: staged.id,
      status: normalized.status,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * 一次性兑付暂存的适配报告：归属、TTL、未兑付三个条件全部写进 WHERE，
   * 用 updateMany 的受影响行数当作 CAS，避免并发下同一 id 被兑付两次。
   * 兑付失败一律退化成「没有报告」而不是报错——发布本身不该被留证环节卡死。
   */
  private async redeemAdaptationReport(
    reportId: string | undefined,
    userId: string,
    teamId: string
  ): Promise<RedeemedAdaptation> {
    const id = reportId?.trim();
    if (!id) return NO_ADAPTATION;
    const claimed = await this.prisma.pluginAdaptationReport.updateMany({
      where: { id, userId, teamId, consumedAt: null, expiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() },
    });
    if (claimed.count !== 1) return NO_ADAPTATION;
    const row = await this.prisma.pluginAdaptationReport.findUnique({
      where: { id },
      select: { report: true, status: true },
    });
    if (!row) return NO_ADAPTATION;
    return { report: row.report, status: normalizeStoredAdaptationStatus(row.status) };
  }

  async publishTeamRelease(
    userId: string,
    stream: Readable,
    packageId?: string,
    contentLength?: number,
    sourceHeaders: ReleaseSourceHeaders = {}
  ) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const adaptation = await this.redeemAdaptationReport(
      sourceHeaders.adaptationReportId,
      userId,
      membership.teamId
    );
    const source = normalizeReleaseSource(sourceHeaders, adaptation);
    let staged: UploadResult;
    try {
      staged = await this.spoolUpload(stream, contentLength);
    } catch (error) {
      await this.audit(
        userId,
        'plugin.release.upload_failed',
        'PluginPackage',
        packageId || membership.teamId,
        {
          stage: 'upload',
          error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
        }
      ).catch(() => undefined);
      throw error;
    }
    let artifactKey: string | null = null;
    try {
      const inspected = await inspectPluginArtifact(staged.path);
      assertStrictSemVer(inspected.manifest.version);
      const policy = assertPluginAiPolicy({
        manifest: inspected.manifest,
        files: inspected.policyFiles,
      });

      let pkg = packageId
        ? await this.prisma.pluginPackage.findUnique({ where: { id: packageId } })
        : null;
      if (pkg) {
        if (pkg.ownerTeamId !== membership.teamId) throw forbidden('不能发布到其他团队的插件包');
        await this.ensurePackageActor(userId, pkg, membership, 'team.plugin.edit_draft');
        if (pkg.manifestId !== inspected.manifest.id)
          throw conflict('manifest.id 与目标插件包不一致');
      } else if (packageId) {
        throw notFound('插件包不存在');
      } else {
        pkg = await this.prisma.pluginPackage.findUnique({
          where: {
            ownerTeamId_manifestId: {
              ownerTeamId: membership.teamId,
              manifestId: inspected.manifest.id,
            },
          },
        });
        if (pkg) await this.ensurePackageActor(userId, pkg, membership, 'team.plugin.edit_draft');
      }

      if (!pkg) {
        if (membership.role !== 'TEAM_ADMIN')
          await this.auth.ensurePermission(userId, 'team.plugin.upload');
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
      if (duplicate)
        throw conflict('该版本已经发布且不可覆盖', { packageId: pkg.id, releaseId: duplicate.id });
      const workflowSnapshot = inspected.workflowDefinition
        ? await this.resolveWorkflowSnapshot(inspected.workflowDefinition, inspected.manifest)
        : null;

      artifactKey = `${pkg.id}/${inspected.manifest.version}/${staged.sha256}.lfplugin`;
      await this.artifacts.promote(staged.path, artifactKey, staged.sha256);
      const published = await this.serializableTransaction(async (tx) => {
        const activePackage = await tx.pluginPackage.findUnique({ where: { id: pkg!.id } });
        if (!activePackage || activePackage.governanceStatus !== 'ACTIVE')
          throw conflict('已归档插件包不能发布新版本');
        const updatedPackage = await tx.pluginPackage.update({
          where: { id: pkg!.id },
          data: { name: inspected.manifest.name, description: inspected.manifest.description },
        });
        const actionSurfaces = actionSurfaceManifest(
          inspected.manifest,
          workflowSnapshot?.definitionSha256
        );
        const created = await tx.pluginRelease.create({
          data: {
            packageId: pkg!.id,
            version: inspected.manifest.version,
            manifest: inspected.manifest as Prisma.InputJsonValue,
            readmeMarkdown: inspected.readmeMarkdown,
            packagePolicySurfaceSha256: packagePolicySurfaceSha256(
              inspected.manifest,
              actionSurfaces
            ),
            actionSurfaceManifest: actionSurfaces as Prisma.InputJsonValue,
            fileManifest: inspected.files as Prisma.InputJsonValue,
            artifactKey: artifactKey!,
            sha256: staged.sha256,
            sizeBytes: staged.sizeBytes,
            sourceKind: source.sourceKind,
            sourceLabel: source.sourceLabel,
            ingestChannel: source.ingestChannel,
            createdById: userId,
            aiPolicyVersion: policy.policyVersion,
            aiPolicyStatus: 'PASSED',
            aiPolicyReason: '',
            adaptationStatus: source.adaptationStatus,
            runEvidence: source.adaptationReport,
          },
        });
        if (workflowSnapshot) {
          await tx.workflowRelease.create({
            data: {
              pluginReleaseId: created.id,
              definitionVersion: '1',
              definitionSha256: workflowSnapshot.definitionSha256,
              definitionJson: workflowSnapshot.definition as Prisma.InputJsonValue,
              frozenClosure: workflowSnapshot.workflowSubplans as unknown as Prisma.InputJsonValue,
              inputSchema: workflowSnapshot.inputSchema as Prisma.InputJsonValue,
              outputSchema: workflowSnapshot.outputSchema as Prisma.InputJsonValue,
              cloudEligible: workflowSnapshot.cloudEligible,
              expandedNodeCount: workflowSnapshot.expandedNodeCount,
              maxParallelism: workflowSnapshot.maxParallelism,
              nodes: {
                create: workflowSnapshot.nodes.map((node) => ({
                  ...node,
                  dependsOn: node.dependsOn as Prisma.InputJsonValue,
                  inputBindings: node.inputBindings as Prisma.InputJsonValue,
                })),
              },
            },
          });
        }
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
        const referenced = await this.prisma.pluginRelease
          .count({ where: { artifactKey } })
          .catch(() => 0);
        if (referenced === 0) await this.artifacts.delete(artifactKey).catch(() => undefined);
      }
      await this.audit(
        userId,
        'plugin.release.upload_failed',
        'PluginPackage',
        packageId || membership.teamId,
        {
          stage: artifactKey ? 'publish' : 'validation',
          error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
        }
      ).catch(() => undefined);
      throw error;
    }
  }

  async teamCatalog(userId: string) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const packages = await this.prisma.pluginPackage.findMany({
      where: { ownerTeamId: membership.teamId, governanceStatus: 'ACTIVE' },
      include: {
        releases: {
          where: {
            status: 'PUBLISHED',
            aiPolicyVersion: PLUGIN_AI_POLICY_VERSION,
            aiPolicyStatus: 'PASSED',
          },
          select: RELEASE_LIST_SELECT,
        },
      },
      orderBy: { updatedAt: 'desc' },
    });
    return {
      items: packages.flatMap((pkg) => {
        const latest = highestSemVer(pkg.releases);
        return latest
          ? [{ package: packageJson(pkg), latestRelease: releaseListJson(latest) }]
          : [];
      }),
    };
  }

  async managementCatalog(userId: string) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const packages = await this.prisma.pluginPackage.findMany({
      where: { ownerTeamId: membership.teamId },
      include: { releases: { select: RELEASE_LIST_SELECT }, listing: true },
      orderBy: { updatedAt: 'desc' },
    });
    return {
      items: packages.map((pkg) => ({
        package: packageJson(pkg),
        latestRelease: (() => {
          const latest = highestSemVer(pkg.releases);
          return latest ? releaseListJson(latest) : null;
        })(),
        releaseCount: pkg.releases.length,
        pendingReviewCount: pkg.releases.filter(
          (release) => release.marketReviewStatus === 'PENDING'
        ).length,
        listing: listingJson(pkg.listing),
      })),
    };
  }

  async marketplaceCatalog(userId: string) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const now = new Date();
    const listings = await this.prisma.marketplaceListing.findMany({
      where: { status: 'ACTIVE', currentReleaseId: { not: null } },
      include: { package: true, currentRelease: { select: RELEASE_LIST_SELECT } },
      orderBy: { updatedAt: 'desc' },
    });
    const packageIds = listings.map((item) => item.packageId);
    const [entitlements, commerceState] = await Promise.all([
      this.prisma.pluginEntitlement.findMany({
        where: { teamId: membership.teamId, status: 'ACTIVE', packageId: { in: packageIds } },
        select: { packageId: true },
      }),
      this.prisma.marketplaceCommerceState.findUnique({ where: { id: 'singleton' } }),
    ]);
    const marketingEnabled =
      commerceState?.writerMode === 'SETTLEMENT_V2' &&
      Boolean(commerceState.settlementV2ActivatedAt);
    const discounts =
      marketingEnabled && packageIds.length > 0
        ? await this.prisma.marketplaceDiscount.findMany({
            where: {
              packageId: { in: packageIds },
              canceledAt: null,
              startsAt: { lte: now },
              endsAt: { gt: now },
            },
            orderBy: [{ startsAt: 'asc' }, { revision: 'desc' }],
          })
        : [];
    const discountByPackage = new Map(discounts.map((discount) => [discount.packageId, discount]));
    const entitled = new Set(entitlements.map((item) => item.packageId));
    return {
      items: listings.flatMap((listing) => {
        const price = resolveMarketplacePrice({
          listPriceCents: listing.priceCents,
          priceRevision: listing.priceRevision,
          discount: discountByPackage.get(listing.packageId) ?? null,
          now,
        });
        return listing.currentRelease &&
          listing.currentRelease.status === 'PUBLISHED' &&
          listing.currentRelease.marketReviewStatus === 'APPROVED' &&
          listing.currentRelease.aiPolicyVersion === PLUGIN_AI_POLICY_VERSION &&
          listing.currentRelease.aiPolicyStatus === 'PASSED'
          ? [
              {
                package: packageJson(listing.package),
                latestRelease: releaseListJson(listing.currentRelease),
                priceCents: price.price_cents,
                listPriceCents: price.list_price_cents,
                discountAmountCents: price.discount_amount_cents,
                priceVersion: price.price_version,
                listingStatus: listing.status,
                entitled: price.price_cents === 0 || entitled.has(listing.packageId),
              },
            ]
          : [];
      }),
    };
  }

  async packageDetail(userId: string, packageId: string) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const pkg = await this.prisma.pluginPackage.findUnique({
      where: { id: packageId },
      include: {
        releases: { orderBy: { createdAt: 'desc' }, select: RELEASE_LIST_SELECT },
        listing: true,
      },
    });
    if (!pkg) throw notFound('插件包不存在');
    const entitlement = await this.prisma.pluginEntitlement.count({
      where: { teamId: membership.teamId, packageId },
    });
    const isOwnerTeam = pkg.ownerTeamId === membership.teamId;
    if (!isOwnerTeam && pkg.listing?.status !== 'ACTIVE' && entitlement === 0)
      throw forbidden('无权查看该插件包');
    return {
      package: packageJson(pkg),
      releases: pkg.releases
        .filter(
          (release) =>
            isOwnerTeam ||
            (release.marketReviewStatus === 'APPROVED' &&
              release.aiPolicyVersion === PLUGIN_AI_POLICY_VERSION &&
              release.aiPolicyStatus === 'PASSED')
        )
        .map(releaseListJson),
      listing: listingJson(pkg.listing),
      entitled: pkg.listing?.priceCents === 0 || entitlement > 0,
    };
  }

  async releaseDetail(userId: string, releaseId: string) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const release = await this.prisma.pluginRelease.findUnique({
      where: { id: releaseId },
      include: { package: { include: { listing: true } } },
    });
    if (!release) throw notFound('插件发行版不存在');
    const isOwnerTeam = release.package.ownerTeamId === membership.teamId;
    const entitlement = isOwnerTeam
      ? 0
      : await this.prisma.pluginEntitlement.count({
          where: { teamId: membership.teamId, packageId: release.packageId },
        });
    if (!isOwnerTeam) {
      const accessiblePackage = release.package.listing?.status === 'ACTIVE' || entitlement > 0;
      const accessibleRelease =
        release.status === 'PUBLISHED' &&
        release.marketReviewStatus === 'APPROVED' &&
        release.aiPolicyVersion === PLUGIN_AI_POLICY_VERSION &&
        release.aiPolicyStatus === 'PASSED';
      if (!accessiblePackage || !accessibleRelease) throw forbidden('无权查看该插件发行版');
    }
    // 适配报告含开发者本机的运行输出（路径、stderr 片段），只回给作者团队；
    // 购买方/市场访客拿到的详情里该字段恒为 null。
    return { release: releaseDetailJson(release, { includeRunEvidence: isOwnerTeam }) };
  }

  async workflowUpgradeSuggestions(
    userId: string,
    releaseId: string
  ): Promise<WorkflowUpgradeSuggestionResponse> {
    const membership = await this.auth.ensureCurrentTeam(userId);
    // Reuse the exact-release visibility boundary before revealing dependency data.
    await this.releaseDetail(userId, releaseId);
    const workflow = await this.prisma.workflowRelease.findUnique({
      where: { pluginReleaseId: releaseId },
      include: { pluginRelease: true, nodes: true },
    });
    if (!workflow) throw notFound('工作流发行版不存在');
    const suggestions: WorkflowUpgradeSuggestionResponse['suggestions'] = [];
    for (const node of workflow.nodes) {
      const current = await this.prisma.pluginRelease.findUnique({
        where: { id: node.releaseId },
        select: { id: true, version: true, actionSurfaceManifest: true },
      });
      if (!current || !parseStrictSemVer(current.version)) continue;
      const currentActions = Array.isArray(current.actionSurfaceManifest)
        ? (current.actionSurfaceManifest as Array<Record<string, unknown>>)
        : [];
      const currentAction = currentActions.find((action) => action.action_id === node.actionId);
      if (!currentAction) continue;
      const targetPackage = await this.prisma.pluginPackage.findUnique({
        where: { id: node.packageId },
        select: { ownerTeamId: true, listing: { select: { status: true } } },
      });
      if (!targetPackage) continue;
      const entitled =
        targetPackage.ownerTeamId === membership.teamId ||
        (await this.prisma.pluginEntitlement.count({
          where: { teamId: membership.teamId, packageId: node.packageId, status: 'ACTIVE' },
        })) > 0;
      const candidates = await this.prisma.pluginRelease.findMany({
        where: { packageId: node.packageId, status: 'PUBLISHED' },
        select: {
          id: true,
          version: true,
          sha256: true,
          marketReviewStatus: true,
          aiPolicyVersion: true,
          aiPolicyStatus: true,
          actionSurfaceManifest: true,
        },
      });
      const compatible = candidates
        .filter((candidate) => {
          if (
            !parseStrictSemVer(candidate.version) ||
            compareStrictSemVer(candidate.version, current.version) <= 0
          )
            return false;
          if (!satisfiesActionVersionRange(candidate.version, node.declaredVersionRange))
            return false;
          if (
            targetPackage.ownerTeamId !== membership.teamId &&
            ((!entitled && targetPackage.listing?.status !== 'ACTIVE') ||
              candidate.marketReviewStatus !== 'APPROVED')
          )
            return false;
          if (
            candidate.aiPolicyVersion !== PLUGIN_AI_POLICY_VERSION ||
            candidate.aiPolicyStatus !== 'PASSED'
          )
            return false;
          const actions = Array.isArray(candidate.actionSurfaceManifest)
            ? (candidate.actionSurfaceManifest as Array<Record<string, unknown>>)
            : [];
          const action = actions.find((item) => item.action_id === node.actionId);
          return (
            Boolean(action) &&
            action!.action_contract_version === node.actionContractVersion &&
            canonicalJson(action!.input_schema) === canonicalJson(currentAction.input_schema) &&
            canonicalJson(action!.output_schema) === canonicalJson(currentAction.output_schema) &&
            action!.execution_semantics === currentAction.execution_semantics
          );
        })
        .sort((left, right) => compareStrictSemVer(right.version, left.version));
      const suggested = compatible[0];
      if (!suggested) continue;
      const suggestedActions = suggested.actionSurfaceManifest as Array<Record<string, unknown>>;
      const action = suggestedActions.find((item) => item.action_id === node.actionId)!;
      suggestions.push({
        node_id: node.nodeId,
        declared_version_range: node.declaredVersionRange,
        current_version: current.version,
        current_target: {
          package_id: node.packageId,
          release_id: node.releaseId,
          sha256: node.sha256,
          action_id: node.actionId,
          action_contract_version: node.actionContractVersion,
          action_surface_sha256: node.actionSurfaceSha256,
        },
        suggested_version: suggested.version,
        suggested_target: {
          package_id: node.packageId,
          release_id: suggested.id,
          sha256: suggested.sha256,
          action_id: node.actionId,
          action_contract_version: String(action.action_contract_version),
          action_surface_sha256: String(action.action_surface_sha256),
        },
        reason: `版本 ${suggested.version} 位于声明范围 ${node.declaredVersionRange} 内，且 Action 输入输出契约保持兼容；采纳后仍需创建并发布新的工作流版本。`,
      });
    }
    return {
      workflow_release_id: workflow.pluginReleaseId,
      workflow_release_sha256: workflow.pluginRelease.sha256,
      suggestions: suggestions.sort((left, right) => left.node_id.localeCompare(right.node_id)),
    };
  }

  private async resolveWorkflowSnapshot(
    definition: Record<string, unknown>,
    manifest: Record<string, unknown>
  ) {
    const rawNodes = definition.nodes as Array<Record<string, unknown>>;
    const nodes = [] as Array<{
      nodeId: string;
      declaredVersionRange: string;
      packageId: string;
      releaseId: string;
      sha256: string;
      actionId: string;
      actionContractVersion: string;
      actionSurfaceSha256: string;
      executionSemantics: string;
      cloudCapable: boolean;
      retryLimit: number;
      dependsOn: unknown[];
      inputBindings: unknown[];
    }>;
    for (const raw of rawNodes) {
      const target = raw.target as Record<string, unknown>;
      const releaseId = String(target?.release_id || '');
      const release = await this.prisma.pluginRelease.findUnique({
        where: { id: releaseId },
        select: {
          id: true,
          packageId: true,
          sha256: true,
          status: true,
          actionSurfaceManifest: true,
          workflowRelease: { select: { pluginReleaseId: true } },
        },
      });
      if (
        !release ||
        release.status !== 'PUBLISHED' ||
        release.packageId !== target.package_id ||
        release.sha256 !== target.sha256
      )
        throw badRequest('workflow node 的精确发行版身份无效', { nodeId: raw.node_id });
      const actions = Array.isArray(release.actionSurfaceManifest)
        ? (release.actionSurfaceManifest as Array<Record<string, unknown>>)
        : [];
      const action = actions.find((candidate) => candidate.action_id === target.action_id);
      if (
        !action ||
        action.action_contract_version !== target.action_contract_version ||
        action.action_surface_sha256 !== target.action_surface_sha256
      )
        throw badRequest('workflow node 的 Action 契约已变化', { nodeId: raw.node_id });
      if (release.workflowRelease && action.action_id !== 'default')
        throw badRequest('子工作流节点只能调用 default action', { nodeId: raw.node_id });
      if (action.execution_semantics === 'side_effect' && Number(raw.retry_limit) > 0)
        throw badRequest('side_effect workflow node 不能自动重试', { nodeId: raw.node_id });
      nodes.push({
        nodeId: String(raw.node_id),
        declaredVersionRange: String(raw.declared_version_range),
        packageId: release.packageId,
        releaseId: release.id,
        sha256: release.sha256,
        actionId: String(action.action_id),
        actionContractVersion: String(action.action_contract_version),
        actionSurfaceSha256: String(action.action_surface_sha256),
        executionSemantics: String(action.execution_semantics),
        cloudCapable: Boolean(action.cloud_capable),
        retryLimit: Number(raw.retry_limit),
        dependsOn: raw.depends_on as unknown[],
        inputBindings: raw.input_bindings as unknown[],
      });
    }
    const remaining = new Set(nodes.map((node) => node.nodeId));
    const done = new Set<string>();
    let maxParallelism = 0;
    while (remaining.size) {
      const ready = nodes.filter(
        (node) =>
          remaining.has(node.nodeId) &&
          node.dependsOn.every((dependency) => done.has(String(dependency)))
      );
      if (!ready.length) throw badRequest('workflow 不能包含循环依赖');
      maxParallelism = Math.max(maxParallelism, ready.length);
      ready.forEach((node) => {
        remaining.delete(node.nodeId);
        done.add(node.nodeId);
      });
    }
    if (maxParallelism > 8) throw badRequest('workflow 并行节点不能超过 8 个');
    const rootActions = Array.isArray(manifest.actions)
      ? (manifest.actions as Array<Record<string, unknown>>)
      : [];
    const rootAction =
      rootActions.length === 1 && rootActions[0]?.action_id === 'default' ? rootActions[0] : null;
    if (
      !rootAction ||
      canonicalJson(rootAction.input_schema) !== canonicalJson(definition.input_schema) ||
      canonicalJson(rootAction.output_schema) !== canonicalJson(definition.output_schema)
    )
      throw badRequest('workflow default action 必须与整体输入输出 schema 一致');
    const semantics = nodes.some((node) => node.executionSemantics === 'side_effect')
      ? 'side_effect'
      : nodes.some((node) => node.executionSemantics === 'idempotent')
        ? 'idempotent'
        : 'read_only';
    const cloudEligible = nodes.every((node) => node.cloudCapable);
    if (
      rootAction.execution_semantics !== semantics ||
      Boolean(rootAction.cloud_capable) !== cloudEligible
    )
      throw badRequest('workflow default action 的执行语义或 Cloud 能力与节点闭包不一致');
    const definitionSha256 = createHash('sha256').update(canonicalJson(definition)).digest('hex');
    const rootSubplan: WorkflowFrozenSubplan = {
      workflow_release_id: `publishing:${String(manifest.id || 'workflow')}:${String(manifest.version || definitionSha256)}`,
      workflow_release_sha256: createHash('sha256').update(canonicalJson(manifest)).digest('hex'),
      definition_sha256: definitionSha256,
      max_parallelism: maxParallelism,
      nodes: nodes.map((node) => ({
        node_id: node.nodeId,
        declared_version_range: node.declaredVersionRange,
        target: {
          package_id: node.packageId,
          release_id: node.releaseId,
          sha256: node.sha256,
          action_id: node.actionId,
          action_contract_version: node.actionContractVersion,
          action_surface_sha256: node.actionSurfaceSha256,
        },
        depends_on: node.dependsOn.map(String),
        input_bindings: node.inputBindings as never,
        retry_limit: node.retryLimit as 0 | 1 | 2,
        execution_semantics: node.executionSemantics as 'read_only' | 'idempotent' | 'side_effect',
        cloud_capable: node.cloudCapable,
      })),
      output_bindings: definition.output_bindings as never,
    };
    const workflowCache = new Map<string, WorkflowFrozenSubplan | null>();
    const resolveChild = async (releaseId: string): Promise<WorkflowFrozenSubplan | null> => {
      if (workflowCache.has(releaseId)) return workflowCache.get(releaseId)!;
      const release = await this.prisma.pluginRelease.findUnique({
        where: { id: releaseId },
        select: { id: true, sha256: true, workflowRelease: { include: { nodes: true } } },
      });
      if (!release?.workflowRelease) {
        workflowCache.set(releaseId, null);
        return null;
      }
      const workflow = release.workflowRelease;
      const frozenDefinition = workflow.definitionJson as Record<string, unknown>;
      const definitionNodes = Array.isArray(frozenDefinition.nodes)
        ? (frozenDefinition.nodes as Array<Record<string, unknown>>)
        : [];
      const snapshotById = new Map(workflow.nodes.map((node) => [node.nodeId, node]));
      const subplan: WorkflowFrozenSubplan = {
        workflow_release_id: workflow.pluginReleaseId,
        workflow_release_sha256: release.sha256,
        definition_sha256: workflow.definitionSha256,
        max_parallelism: workflow.maxParallelism,
        nodes: definitionNodes.map((raw) => {
          const snapshot = snapshotById.get(String(raw.node_id));
          if (!snapshot)
            throw badRequest('子工作流冻结节点投影缺失', {
              workflowReleaseId: workflow.pluginReleaseId,
              nodeId: raw.node_id,
            });
          return {
            node_id: snapshot.nodeId,
            declared_version_range: snapshot.declaredVersionRange,
            target: {
              package_id: snapshot.packageId,
              release_id: snapshot.releaseId,
              sha256: snapshot.sha256,
              action_id: snapshot.actionId,
              action_contract_version: snapshot.actionContractVersion,
              action_surface_sha256: snapshot.actionSurfaceSha256,
            },
            depends_on: snapshot.dependsOn as string[],
            input_bindings: snapshot.inputBindings as never,
            retry_limit: snapshot.retryLimit as 0 | 1 | 2,
            execution_semantics: snapshot.executionSemantics as
              'read_only' | 'idempotent' | 'side_effect',
            cloud_capable: snapshot.cloudCapable,
          };
        }),
        output_bindings: frozenDefinition.output_bindings as never,
      };
      workflowCache.set(releaseId, subplan);
      return subplan;
    };
    const closure = await buildWorkflowClosure(rootSubplan, resolveChild);
    if (closure.diagnostics.length) {
      const diagnostic = closure.diagnostics[0]!;
      throw badRequest(diagnostic.message, {
        code: diagnostic.code,
        path: diagnostic.release_path,
      });
    }
    return {
      definition,
      definitionSha256,
      inputSchema: definition.input_schema as object,
      outputSchema: definition.output_schema as object,
      cloudEligible,
      maxParallelism,
      nodes,
      workflowSubplans: closure.subplans,
      expandedNodeCount: closure.expanded_node_count,
    };
  }

  async artifactDownload(
    userId: string,
    releaseId: string,
    requestId?: string
  ): Promise<{ download: ArtifactDownload; release: ReturnType<typeof releaseJson> }> {
    const access = await this.governance.authorizeRelease(userId, { releaseId }, ['install']);
    const release = access.release;
    const download = await this.downloadArtifact(release, requestId);
    await this.audit(userId, 'plugin.artifact.downloaded', 'PluginRelease', release.id, {
      packageId: release.packageId,
      sha256: release.sha256,
    });
    return { download, release: releaseJson(release) };
  }

  async runtimeAccess(userId: string, packageId: string, releaseId: string, sha256: string) {
    const access = await this.governance.authorizeRelease(
      userId,
      { releaseId, packageId, sha256 },
      ['run_local']
    );
    if (access.source !== 'team') return { allowed: true, mode: 'local-entitlement' as const };
    return {
      allowed: true,
      mode: 'online-team-membership' as const,
      checkedAt: new Date().toISOString(),
    };
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

  async adminArtifactDownload(
    actorId: string,
    releaseId: string,
    requestId?: string
  ): Promise<{ download: ArtifactDownload; release: ReturnType<typeof releaseJson> }> {
    await this.auth.ensurePlatformAdmin(actorId);
    const release = await this.prisma.pluginRelease.findUnique({ where: { id: releaseId } });
    if (!release) throw notFound('发行版不存在');
    const download = await this.downloadArtifact(release, requestId);
    await this.audit(
      actorId,
      'admin.plugin_release.artifact_downloaded',
      'PluginRelease',
      release.id,
      {
        packageId: release.packageId,
        sha256: release.sha256,
        marketReviewStatus: release.marketReviewStatus,
      }
    );
    return { download, release: releaseJson(release) };
  }

  private async downloadArtifact(
    release: { id: string; packageId: string; artifactKey: string; sha256: string },
    requestId?: string
  ): Promise<ArtifactDownload> {
    try {
      return await this.artifacts.download(release.artifactKey);
    } catch (error) {
      if (error instanceof AppError) throw error;
      const context = {
        requestId,
        releaseId: release.id,
        packageId: release.packageId,
        artifactKey: release.artifactKey,
        errorMessage: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : undefined,
      };
      if (error instanceof ArtifactUnavailableError) {
        this.logger.warn(context, '插件制品不可用：文件已被清理或未落盘');
        throw new AppError(
          410,
          'plugin_artifact_unavailable',
          '制品文件不可用，可能已被清理，请联系作者重新发布'
        );
      }
      this.logger.error(context, '插件制品下载失败：存储后端异常');
      throw error;
    }
  }

  async submitMarketplace(userId: string, releaseId: string, priceCents?: number) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const release = await this.prisma.pluginRelease.findUnique({
      where: { id: releaseId },
      include: { package: true },
    });
    if (!release || release.package.ownerTeamId !== membership.teamId)
      throw notFound('发行版不存在');
    assertCurrentAiPolicy(release);
    await this.ensurePackageActor(
      userId,
      release.package,
      membership,
      'team.plugin.submit_marketplace'
    );
    if (release.package.governanceStatus !== 'ACTIVE') throw conflict('已归档插件包不能提交市场');
    if (release.status !== 'PUBLISHED') throw conflict('已撤回发行版不能提交市场');
    if (isPrerelease(release.version)) throw badRequest('市场只允许正式 SemVer 版本');
    const updated = await this.serializableTransaction(async (tx) => {
      const activePackage = await tx.pluginPackage.findUnique({ where: { id: release.packageId } });
      if (!activePackage || activePackage.governanceStatus !== 'ACTIVE')
        throw conflict('已归档插件包不能提交市场');
      const listing = await tx.marketplaceListing.findUnique({
        where: { packageId: release.packageId },
      });
      const normalizedPrice =
        priceCents === undefined
          ? (listing?.priceCents ?? 0)
          : Math.max(0, Math.floor(Number(priceCents) || 0));
      const claimed = await tx.pluginRelease.updateMany({
        where: {
          id: releaseId,
          status: 'PUBLISHED',
          marketReviewStatus: { in: ['DRAFT', 'REJECTED'] },
        },
        data: {
          marketReviewStatus: 'PENDING',
          reviewReason: '',
          reviewedById: null,
          reviewedAt: null,
        },
      });
      if (claimed.count !== 1) throw conflict('该版本已提交、已通过审核或状态已变化');
      await tx.marketplaceListing.upsert({
        where: { packageId: release.packageId },
        update: { priceCents: normalizedPrice },
        create: { packageId: release.packageId, priceCents: normalizedPrice },
      });
      await tx.pluginReleaseReview.create({
        data: { releaseId, status: 'PENDING', reason: '作者提交审核' },
      });
      await tx.auditLog.create({
        data: {
          actorUserId: userId,
          action: 'plugin.release.marketplace_submitted',
          targetType: 'PluginRelease',
          targetId: releaseId,
          metadata: { packageId: release.packageId, priceCents: normalizedPrice },
        },
      });
      return tx.pluginRelease.findUnique({ where: { id: releaseId } });
    });
    if (!updated) throw notFound('发行版不存在');
    return { release: releaseJson(updated) };
  }

  async withdrawMarketplaceSubmission(userId: string, releaseId: string, reason: string) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const release = await this.prisma.pluginRelease.findUnique({
      where: { id: releaseId },
      include: { package: true },
    });
    if (!release || release.package.ownerTeamId !== membership.teamId)
      throw notFound('发行版不存在');
    await this.ensurePackageActor(
      userId,
      release.package,
      membership,
      'team.plugin.submit_marketplace'
    );
    const reviewReason =
      String(reason || '')
        .trim()
        .slice(0, 500) || '作者撤回市场申请';
    const updated = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.pluginRelease.updateMany({
        where: { id: releaseId, status: 'PUBLISHED', marketReviewStatus: 'PENDING' },
        data: { marketReviewStatus: 'DRAFT', reviewReason, reviewedById: null, reviewedAt: null },
      });
      if (claimed.count !== 1) throw conflict('发行版不在可撤回的待审核状态');
      await tx.pluginReleaseReview.create({
        data: { releaseId, status: 'DRAFT', reason: reviewReason },
      });
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
    if (pkg.governanceStatus === status)
      return { package: packageJson(pkg), listing: listingJson(pkg.listing) };
    const expected = status === 'ARCHIVED' ? 'ACTIVE' : 'ARCHIVED';
    const result = await this.serializableTransaction(async (tx) => {
      if (status === 'ARCHIVED') {
        const pendingReviews = await tx.pluginRelease.count({
          where: { packageId, marketReviewStatus: 'PENDING' },
        });
        if (pendingReviews > 0) throw conflict('请先撤回待审核发行版再归档插件包');
      }
      const claimed = await tx.pluginPackage.updateMany({
        where: { id: packageId, governanceStatus: expected },
        data: { governanceStatus: status },
      });
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
      await projectMarketplaceQualityGateTx(tx, packageId, `PACKAGE_${status}`, new Date());
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
    if (release.status === status)
      return { release: releaseJson(release), listing: listingJson(release.package.listing) };
    if (status === 'PUBLISHED' && release.package.governanceStatus !== 'ACTIVE')
      throw conflict('已归档插件包不能恢复发行版');
    if (status === 'PUBLISHED') assertCurrentAiPolicy(release);
    const expected = status === 'YANKED' ? 'PUBLISHED' : 'YANKED';
    const reason = status === 'YANKED' ? '作者撤回发行版' : '';
    const result = await this.serializableTransaction(async (tx) => {
      if (status === 'PUBLISHED') {
        const activePackage = await tx.pluginPackage.findUnique({
          where: { id: release.packageId },
        });
        if (!activePackage || activePackage.governanceStatus !== 'ACTIVE')
          throw conflict('已归档插件包不能恢复发行版');
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
          ...(wasPending
            ? {
                marketReviewStatus: 'DRAFT' as const,
                reviewReason: reason,
                reviewedById: null,
                reviewedAt: null,
              }
            : {}),
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
      await projectMarketplaceQualityGateTx(tx, release.packageId, `RELEASE_${status}`, new Date());
      if (wasPending)
        await tx.pluginReleaseReview.create({ data: { releaseId, status: 'DRAFT', reason } });
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
        listing: await tx.marketplaceListing.findUnique({
          where: { packageId: release.packageId },
        }),
      };
    });
    if (!result.release) throw notFound('发行版不存在');
    return { release: releaseJson(result.release), listing: listingJson(result.listing) };
  }

  async updateOwnerMarketplaceStatus(
    userId: string,
    packageId: string,
    status: 'ACTIVE' | 'DELISTED',
    reason: string
  ) {
    if (status !== 'ACTIVE' && status !== 'DELISTED') throw badRequest('市场状态无效');
    const { membership, pkg } = await this.currentTeamPackage(userId, packageId);
    await this.ensurePackageActor(userId, pkg, membership, 'team.plugin.submit_marketplace');
    const listing = await this.changeMarketplaceListingStatus(
      userId,
      packageId,
      status,
      'OWNER',
      reason
    );
    return { packageId, listing: listingJson(listing) };
  }

  async updatePlatformMarketplaceStatus(
    actorId: string,
    packageId: string,
    status: 'ACTIVE' | 'DELISTED',
    reason: string
  ) {
    if (status !== 'ACTIVE' && status !== 'DELISTED') throw badRequest('市场状态无效');
    await this.auth.ensurePlatformAdmin(actorId);
    const pkg = await this.prisma.pluginPackage.findUnique({ where: { id: packageId } });
    if (!pkg) throw notFound('插件包不存在');
    const listing = await this.changeMarketplaceListingStatus(
      actorId,
      packageId,
      status,
      'PLATFORM',
      reason
    );
    return { packageId, listing: listingJson(listing) };
  }

  async purchase(userId: string, packageId: string, expectedPriceVersion?: string) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    // Settlement cutover fence: a legacy writer that observed LEGACY before the
    // request must prove the same mode/generation again inside its money
    // transaction and immediately before commit. DRAINING/PAUSED never fall
    // through to the historical immediate-seller-credit path.
    const initialCommerceState =
      (await (this.prisma as any).marketplaceCommerceState?.findUnique?.({
        where: { id: 'singleton' },
      })) ?? null;
    if (initialCommerceState && initialCommerceState.writerMode !== 'LEGACY') {
      throw new AppError(503, 'marketplace_commerce_paused', '市场结算正在切换，暂不接受新订单');
    }
    const legacyWriterGeneration = initialCommerceState?.writerGeneration ?? 0;
    const listing = await this.prisma.marketplaceListing.findUnique({
      where: { packageId },
      include: { package: true, currentRelease: true },
    });
    if (!listing || listing.status !== 'ACTIVE' || !listing.currentReleaseId)
      throw notFound('市场插件不存在或未上架');
    if (
      !listing.currentRelease ||
      listing.currentRelease.status !== 'PUBLISHED' ||
      listing.currentRelease.marketReviewStatus !== 'APPROVED'
    ) {
      throw notFound('市场插件不存在或未上架');
    }
    const currentPrice = resolveMarketplacePrice({
      listPriceCents: listing.priceCents,
      priceRevision: listing.priceRevision,
      discount: null,
      now: new Date(),
    });
    if (expectedPriceVersion && expectedPriceVersion !== currentPrice.price_version) {
      throw new AppError(409, 'marketplace_price_changed', '插件价格已变化，请刷新后重试');
    }
    assertCurrentAiPolicy(listing.currentRelease);
    if (listing.package.ownerTeamId === membership.teamId)
      throw conflict('不能购买本团队发布的插件');
    const existing = await this.prisma.pluginEntitlement.findUnique({
      where: { teamId_packageId: { teamId: membership.teamId, packageId } },
    });
    if (existing)
      return { entitled: true, entitlementId: existing.id, purchaseId: existing.purchaseId };
    if (listing.priceCents < 0) throw badRequest('市场插件价格无效');
    const sellerUserId = listing.package.authorUserId;
    if (!sellerUserId) throw badRequest('插件无作者信息，无法结算');

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const commerceState =
          (await (tx as any).marketplaceCommerceState?.findUnique?.({
            where: { id: 'singleton' },
          })) ?? null;
        if (
          (commerceState && commerceState.writerMode !== 'LEGACY') ||
          (commerceState?.writerGeneration ?? 0) !== legacyWriterGeneration
        ) {
          throw new AppError(503, 'marketplace_commerce_paused', '市场结算 writer fence 已变化');
        }
        const transactionListing = await tx.marketplaceListing.findUnique({
          where: { packageId },
          select: { priceCents: true, priceRevision: true, status: true, currentReleaseId: true },
        });
        if (
          !transactionListing ||
          transactionListing.status !== 'ACTIVE' ||
          transactionListing.currentReleaseId !== listing.currentReleaseId
        ) {
          throw new AppError(
            409,
            'marketplace_price_changed',
            '插件价格或发行版已变化，请刷新后重试'
          );
        }
        const transactionPrice = resolveMarketplacePrice({
          listPriceCents: transactionListing.priceCents,
          priceRevision: transactionListing.priceRevision,
          discount: null,
          now: new Date(),
        });
        if (expectedPriceVersion && expectedPriceVersion !== transactionPrice.price_version) {
          throw new AppError(409, 'marketplace_price_changed', '插件价格已变化，请刷新后重试');
        }
        // The order is the transaction's idempotency claim. A concurrent purchase for the
        // same team/package loses the unique constraint and rolls back before any money moves.
        const purchase = await tx.purchase.create({
          data: {
            packageId,
            buyerUserId: userId,
            buyerTeamId: membership.teamId,
            sellerUserId,
            priceCents: transactionPrice.price_cents,
            listPriceCents: transactionPrice.list_price_cents,
            discountAmountCents: transactionPrice.discount_amount_cents,
            priceRevision: transactionPrice.internal_price_revision,
            priceVersion: transactionPrice.price_version,
          },
        });
        if (transactionPrice.price_cents > 0) {
          const debited = await tx.team.updateMany({
            where: { id: membership.teamId, balanceCents: { gte: transactionPrice.price_cents } },
            data: { balanceCents: { decrement: transactionPrice.price_cents } },
          });
          if (debited.count === 0) throw insufficientBalance();
          await tx.team.update({
            where: { id: listing.package.ownerTeamId },
            data: { balanceCents: { increment: transactionPrice.price_cents } },
          });
          await tx.balanceLedger.create({
            data: {
              teamId: membership.teamId,
              amountCents: transactionPrice.price_cents,
              direction: 'DEBIT',
              reason: 'plugin_purchase',
              actorUserId: userId,
            },
          });
          await tx.balanceLedger.create({
            data: {
              teamId: listing.package.ownerTeamId,
              amountCents: transactionPrice.price_cents,
              direction: 'CREDIT',
              reason: 'plugin_sale',
              actorUserId: sellerUserId,
            },
          });
        }
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
              priceCents: transactionPrice.price_cents,
            },
          },
        });
        const entitlement = await tx.pluginEntitlement.create({
          data: { teamId: membership.teamId, packageId, purchaseId: purchase.id },
        });
        const finalCommerceState =
          (await (tx as any).marketplaceCommerceState?.findUnique?.({
            where: { id: 'singleton' },
          })) ?? null;
        if (
          (finalCommerceState && finalCommerceState.writerMode !== 'LEGACY') ||
          (finalCommerceState?.writerGeneration ?? 0) !== legacyWriterGeneration
        ) {
          throw new AppError(503, 'marketplace_commerce_paused', '市场结算 writer fence 已变化');
        }
        return { entitlement, purchase };
      });
      return {
        entitled: true,
        entitlementId: result.entitlement.id,
        purchaseId: result.purchase.id,
      };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const concurrent = await this.prisma.pluginEntitlement.findUnique({
          where: { teamId_packageId: { teamId: membership.teamId, packageId } },
        });
        if (concurrent)
          return {
            entitled: true,
            entitlementId: concurrent.id,
            purchaseId: concurrent.purchaseId,
          };
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
    const releases =
      packageIds.length === 0
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
    const release = await this.prisma.pluginRelease.findUnique({
      where: { id: releaseId },
      select: { id: true },
    });
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
    const result = await this.updatePlatformMarketplaceStatus(
      actorId,
      packageId,
      'DELISTED',
      normalizedReason
    );
    return { ...result, listing: adminListingProjection(result.listing) };
  }

  async pendingReviews(actorId: string) {
    await this.auth.ensurePlatformAdmin(actorId);
    const releases = await this.prisma.pluginRelease.findMany({
      where: { marketReviewStatus: 'PENDING' },
      include: { package: true },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    return {
      items: releases.map((release) => ({
        package: packageJson(release.package),
        release: releaseJson(release),
        fileManifest: release.fileManifest,
      })),
    };
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
        isMarketplaceCurrent:
          release.package.listing?.status === 'ACTIVE' &&
          release.package.listing.currentReleaseId === release.id,
        priceCents: release.package.listing?.priceCents ?? null,
        listing: listingJson(release.package.listing),
      })),
    };
  }

  async reviewDetail(actorId: string, releaseId: string) {
    await this.auth.ensurePlatformAdmin(actorId);
    const release = await this.prisma.pluginRelease.findUnique({
      where: { id: releaseId },
      include: {
        package: { include: { listing: true } },
        reviews: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!release) throw notFound('发行版不存在');
    return {
      package: packageJson(release.package),
      release: releaseJson(release),
      listing: listingJson(release.package.listing),
      isMarketplaceCurrent:
        release.package.listing?.status === 'ACTIVE' &&
        release.package.listing.currentReleaseId === release.id,
      fileManifest: release.fileManifest,
      reviews: release.reviews.map((review) => ({
        ...review,
        createdAt: review.createdAt.toISOString(),
      })),
    };
  }

  async approveRelease(actorId: string, releaseId: string) {
    await this.auth.ensurePlatformAdmin(actorId);
    const release = await this.prisma.pluginRelease.findUnique({
      where: { id: releaseId },
      include: { package: true },
    });
    if (!release || release.marketReviewStatus !== 'PENDING')
      throw conflict('发行版不在待审核状态');
    assertCurrentAiPolicy(release);
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
        data: {
          marketReviewStatus: 'APPROVED',
          reviewReason: '',
          reviewedById: actorId,
          reviewedAt: new Date(),
        },
      });
      if (claimed.count !== 1) throw conflict('发行版审核状态已变化，请刷新后重试');
      const candidates = await tx.pluginRelease.findMany({
        where: {
          packageId: release.packageId,
          status: 'PUBLISHED',
          marketReviewStatus: 'APPROVED',
          aiPolicyVersion: PLUGIN_AI_POLICY_VERSION,
          aiPolicyStatus: 'PASSED',
        },
        select: { id: true, version: true },
      });
      const current = highestSemVer(candidates);
      if (!current) throw conflict('没有可上架的已通过发行版');
      const listing = await tx.marketplaceListing.findUnique({
        where: { packageId: release.packageId },
      });
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
      await projectMarketplaceQualityGateTx(tx, release.packageId, 'RELEASE_APPROVED', new Date());
      await tx.pluginReleaseReview.create({
        data: { releaseId, reviewerId: actorId, status: 'APPROVED' },
      });
      await tx.auditLog.create({
        data: {
          actorUserId: actorId,
          action: 'admin.plugin_release.approved',
          targetType: 'PluginRelease',
          targetId: releaseId,
          metadata: {
            packageId: release.packageId,
            version: release.version,
            currentReleaseId: current.id,
          },
        },
      });
      return {
        release: await tx.pluginRelease.findUnique({ where: { id: releaseId } }),
        currentReleaseId: current.id,
      };
    });
    if (!result.release) throw notFound('发行版不存在');
    return { release: releaseJson(result.release), currentReleaseId: result.currentReleaseId };
  }

  async rejectRelease(actorId: string, releaseId: string, reason: string) {
    await this.auth.ensurePlatformAdmin(actorId);
    const release = await this.prisma.pluginRelease.findUnique({ where: { id: releaseId } });
    if (!release || release.marketReviewStatus !== 'PENDING')
      throw conflict('发行版不在待审核状态');
    const reviewReason = normalizeRequiredReason(reason, '请填写 1 到 500 字符的驳回原因');
    const updated = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.pluginRelease.updateMany({
        where: { id: releaseId, status: 'PUBLISHED', marketReviewStatus: 'PENDING' },
        data: {
          marketReviewStatus: 'REJECTED',
          reviewReason,
          reviewedById: actorId,
          reviewedAt: new Date(),
        },
      });
      if (claimed.count !== 1) throw conflict('发行版审核状态已变化，请刷新后重试');
      await tx.pluginReleaseReview.create({
        data: { releaseId, reviewerId: actorId, status: 'REJECTED', reason: reviewReason },
      });
      await tx.auditLog.create({
        data: {
          actorUserId: actorId,
          action: 'admin.plugin_release.rejected',
          targetType: 'PluginRelease',
          targetId: releaseId,
          metadata: {
            packageId: release.packageId,
            version: release.version,
            reason: reviewReason,
          },
        },
      });
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
    const listing = await this.prisma.marketplaceListing.findUnique({
      where: { packageId: release.packageId },
    });
    if (!listing || listing.status !== 'ACTIVE' || listing.currentReleaseId !== releaseId) {
      throw conflict('只有市场当前发行版可以触发下架');
    }
    const updated = await this.changeMarketplaceListingStatus(
      actorId,
      release.packageId,
      'DELISTED',
      'PLATFORM',
      normalizedReason,
      releaseId
    );
    return {
      packageId: release.packageId,
      status: 'DELISTED' as const,
      listing: listingJson(updated),
    };
  }

  private async audit(
    actorUserId: string,
    action: string,
    targetType: string,
    targetId: string,
    metadata?: unknown
  ) {
    await this.prisma.auditLog.create({
      data: {
        actorUserId,
        action,
        targetType,
        targetId,
        metadata: metadata as Prisma.InputJsonValue,
      },
    });
  }
}
