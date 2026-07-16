import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { WebCloudTrialCreateRequest, WebCloudTrialProjection } from '@lingfang/contract';
import { AppError, notFound } from '../../common';
import { PrismaService } from '../../prisma.service';
import { ActionInvocationService } from '../action-invocation.service';
import { AuthService } from '../auth.service';
import { CloudActionRoutingService } from '../cloud-action-routing.service';
import { PluginActionRegistryService } from '../plugin-action-registry.service';

const DAILY_LIMIT = 5;
const CONCURRENCY_LIMIT = 1;
const ACTIVE_STATUSES = ['AUTHORIZED', 'RUNNING'] as const;

type PreviewInvocationRow = {
  id: string;
  teamId: string;
  principalUserId: string | null;
  kind: string;
  callerKind: string;
  status: string;
  packageId: string;
  releaseId: string;
  releaseSha256: string;
  actionId: string;
  actionContractVersion: string;
  actionSurfaceSha256: string;
  requestIdempotencyKey: string;
  inputSha256: string;
  policyRevision: number;
  output: unknown;
  deadlineAt: Date;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  errorCode: string;
  errorMessage: string;
};

@Injectable()
export class WebCloudTrialService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(PluginActionRegistryService) private readonly actions: PluginActionRegistryService,
    @Inject(CloudActionRoutingService) private readonly routing: CloudActionRoutingService,
    @Inject(ActionInvocationService) private readonly invocations: ActionInvocationService,
  ) {}

  async start(userId: string, packageId: string, actionId: string, body: unknown) {
    const parsed = WebCloudTrialCreateRequest.safeParse(body);
    if (!parsed.success) {
      throw new AppError(400, 'web_preview_request_invalid', 'Cloud Trial 请求参数无效', {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      });
    }
    const membership = await this.auth.ensureCurrentTeam(userId);
    const listing = await this.prisma.marketplaceListing.findFirst({
      where: { packageId, status: 'ACTIVE', currentRelease: { status: 'PUBLISHED', marketReviewStatus: 'APPROVED', aiPolicyStatus: 'PASSED' } },
      include: { currentRelease: true },
    });
    if (!listing?.currentRelease) throw notFound('可试用插件不存在');
    if (listing.currentRelease.id !== parsed.data.release_id || listing.currentRelease.sha256 !== parsed.data.release_sha256) {
      throw new AppError(409, 'web_preview_release_changed', '插件发行版已更新，请刷新页面后重试');
    }
    const target = {
      package_id: packageId,
      release_id: listing.currentRelease.id,
      sha256: listing.currentRelease.sha256,
      action_id: actionId,
      action_contract_version: actionVersion(listing.currentRelease.actionSurfaceManifest, actionId),
      action_surface_sha256: actionSurface(listing.currentRelease.actionSurfaceManifest, actionId),
    };
    if (target.action_contract_version !== parsed.data.action_contract_version
      || target.action_surface_sha256 !== parsed.data.action_surface_sha256) {
      throw new AppError(409, 'web_preview_action_changed', 'Action 契约已更新，请刷新页面后重试');
    }
    const resolved = await this.actions.resolve(target);
    const action = resolved.action as Record<string, unknown>;
    const semantics = String(action.execution_semantics || '');
    if (action.previewable !== true || action.cloud_capable !== true || semantics !== 'read_only' && semantics !== 'idempotent') {
      throw new AppError(409, 'web_preview_unavailable', '该 Action 不允许 Web Cloud Trial');
    }

    const existing = await this.prisma.actionInvocation.findFirst({
      where: {
        teamId: membership.teamId,
        principalUserId: userId,
        kind: 'PREVIEW',
        callerKind: 'WEB',
        packageId,
        releaseId: target.release_id,
        actionId,
        requestIdempotencyKey: parsed.data.request_idempotency_key,
      },
    }) as PreviewInvocationRow | null;
    if (existing) {
      if (existing.inputSha256 !== digest(parsed.data.input)) {
        throw new AppError(409, 'action_idempotency_conflict', '相同幂等键对应了不同输入');
      }
      return this.project(existing, await this.quotaSnapshot(userId, membership.teamId));
    }

    const quota = await this.quotaSnapshot(userId, membership.teamId);
    if (quota.daily >= DAILY_LIMIT) throw new AppError(429, 'web_preview_quota_exceeded', '今日 Cloud Trial 次数已用完');
    if (quota.concurrent >= CONCURRENCY_LIMIT) throw new AppError(429, 'web_preview_concurrency_exceeded', '已有 Cloud Trial 正在运行');

    const requestId = randomUUID();
    const binding = await this.routing.freeze(userId, resolved.target, 'PREVIEW', requestId, `web-preview:${actionId}`);
    const invocation = await this.invocations.create(userId, {
      target: resolved.target,
      preview: true,
      input: parsed.data.input,
      request_idempotency_key: parsed.data.request_idempotency_key,
      deadline_at: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
      caller: { kind: 'WEB', id: userId },
      cloud_binding: { deployment_id: binding.deployment_id, routing_generation: binding.routing_generation, environment: 'PREVIEW' },
    });
    await this.prisma.automationOutbox.upsert({
      where: { kind_aggregateId_generation: { kind: 'ENQUEUE_ACTION', aggregateId: invocation.id, generation: 0 } },
      create: { kind: 'ENQUEUE_ACTION', aggregateId: invocation.id, generation: 0, payload: { invocation_id: invocation.id } },
      update: {},
    });
    const row = await this.loadOwned(userId, membership.teamId, invocation.id);
    return this.project(row, await this.quotaSnapshot(userId, membership.teamId));
  }

  async get(userId: string, invocationId: string) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const row = await this.loadOwned(userId, membership.teamId, invocationId);
    return this.project(row, await this.quotaSnapshot(userId, membership.teamId));
  }

  async cancel(userId: string, invocationId: string) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    await this.loadOwned(userId, membership.teamId, invocationId);
    await this.invocations.cancel(userId, invocationId);
    const row = await this.loadOwned(userId, membership.teamId, invocationId);
    return this.project(row, await this.quotaSnapshot(userId, membership.teamId));
  }

  private async loadOwned(userId: string, teamId: string, invocationId: string): Promise<PreviewInvocationRow> {
    const row = await this.prisma.actionInvocation.findFirst({
      where: { id: invocationId, teamId, principalUserId: userId, kind: 'PREVIEW', callerKind: 'WEB' },
    }) as PreviewInvocationRow | null;
    if (!row) throw notFound('Cloud Trial 不存在');
    return row;
  }

  private async quotaSnapshot(userId: string, teamId: string) {
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const [daily, concurrent] = await Promise.all([
      this.prisma.actionInvocation.count({ where: { teamId, principalUserId: userId, kind: 'PREVIEW', callerKind: 'WEB', createdAt: { gte: dayStart } } }),
      this.prisma.actionInvocation.count({ where: { teamId, principalUserId: userId, kind: 'PREVIEW', callerKind: 'WEB', status: { in: [...ACTIVE_STATUSES] } } }),
    ]);
    return { daily, concurrent, resetAt: nextUtcDay(dayStart) };
  }

  private project(row: PreviewInvocationRow, quota: { daily: number; concurrent: number; resetAt: Date }) {
    return WebCloudTrialProjection.parse({
      invocation_id: row.id,
      status: row.status,
      target: {
        package_id: row.packageId,
        release_id: row.releaseId,
        sha256: row.releaseSha256,
        action_id: row.actionId,
        action_contract_version: row.actionContractVersion,
        action_surface_sha256: row.actionSurfaceSha256,
      },
      quota_remaining: Math.max(0, DAILY_LIMIT - quota.daily),
      daily_limit: DAILY_LIMIT,
      concurrency_limit: CONCURRENCY_LIMIT,
      concurrent_active: quota.concurrent,
      quota_reset_at: quota.resetAt.toISOString(),
      expires_at: row.deadlineAt.toISOString(),
      policy_decision_id: `policy-revision:${row.policyRevision}`,
      output: recordOrNull(row.output),
      error: row.errorCode || row.errorMessage
        ? { code: row.errorCode || 'action_execution_failed', message: row.errorMessage || 'Cloud Trial 执行失败' }
        : null,
      created_at: row.createdAt.toISOString(),
      started_at: row.startedAt?.toISOString() ?? null,
      completed_at: row.completedAt?.toISOString() ?? null,
    });
  }
}

function actionRecord(value: unknown, actionId: string): Record<string, unknown> {
  const found = Array.isArray(value)
    ? value.find((item) => item && typeof item === 'object' && (item as Record<string, unknown>).action_id === actionId)
    : null;
  if (!found) throw notFound('Action 不存在');
  return found as Record<string, unknown>;
}

function actionVersion(value: unknown, actionId: string): string {
  return String(actionRecord(value, actionId).action_contract_version || '');
}

function actionSurface(value: unknown, actionId: string): string {
  return String(actionRecord(value, actionId).action_surface_sha256 || '');
}

function nextUtcDay(dayStart: Date): Date {
  const result = new Date(dayStart);
  result.setUTCDate(result.getUTCDate() + 1);
  return result;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
