import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ACTION_CALL_MAX_CONCURRENCY,
  ACTION_CALL_MAX_DEPTH,
  ACTION_INLINE_PAYLOAD_MAX_BYTES,
  ActionCallChainEntry,
  type ActionCallChainEntry as ActionCallChainEntryValue,
  type ActionCallerKind,
  type ActionTarget,
} from '@lingfang/contract';
import { AppError, conflict, notFound } from '../common';
import { PrismaService } from '../prisma.service';
import { AuthService } from './auth.service';
import { GovernanceActionAdapter } from './governance-action-adapter';
import { assertActionValue } from './action-schema-validator';
import { RuntimeArtifactService } from './runtime-artifact.service';

type CreateInput = { target: ActionTarget; preview?: boolean; input: Record<string, unknown>; request_idempotency_key: string; effect_idempotency_key?: string; deadline_at: string; caller: { kind: ActionCallerKind; id: string }; parent_invocation_id?: string; cloud_binding?: { deployment_id: string; routing_generation: number; environment: 'PREVIEW' | 'PRODUCTION' } };
type ParentInvocation = {
  id: string; teamId: string; principalUserId: string | null; kind: 'STANDARD' | 'PREVIEW'; status: string;
  packageId: string; releaseId: string; releaseSha256: string; actionId: string; actionContractVersion: string;
  actionSurfaceSha256: string; rootInvocationId: string | null; parentInvocationId: string | null; callChain: unknown;
  deadlineAt: Date;
};
function canonicalJson(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`; if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`; return JSON.stringify(value); }
const sha = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');

@Injectable()
export class ActionInvocationService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService, @Inject(AuthService) private readonly auth: AuthService, @Inject(GovernanceActionAdapter) private readonly governance: GovernanceActionAdapter, @Optional() @Inject(RuntimeArtifactService) private readonly artifacts?: RuntimeArtifactService) {}
  async create(userId: string, input: CreateInput) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const parent = input.parent_invocation_id
      ? await this.prisma.actionInvocation.findFirst({ where: { id: input.parent_invocation_id, teamId: membership.teamId, principalUserId: userId } }) as ParentInvocation | null
      : null;
    if (input.parent_invocation_id && !parent) throw new AppError(409, 'action_dependency_denied', '父 Action invocation 不存在或不属于当前主体');
    const kind = parent?.kind ?? (input.preview ? 'PREVIEW' as const : 'STANDARD' as const);
    const caller = parent ? { kind: 'ACTION' as const, id: parent.id } : input.caller;
    const deadline = new Date(input.deadline_at);
    if (input.cloud_binding && caller.kind !== 'CLOUD' && !(caller.kind === 'WEB' && kind === 'PREVIEW' && input.cloud_binding.environment === 'PREVIEW')) throw new AppError(400, 'cloud_endpoint_target_mismatch', '只有 Cloud gateway 或 Web PREVIEW 可以绑定 deployment');
    if (!Number.isFinite(deadline.getTime()) || deadline <= new Date()) throw new AppError(400, 'action_deadline_invalid', 'Action deadline 必须位于未来');
    if (parent && deadline > parent.deadlineAt) throw new AppError(400, 'action_deadline_invalid', 'Nested Action deadline 不能超过父调用');
    const payloadBytes = Buffer.byteLength(canonicalJson(input.input), 'utf8');
    if (payloadBytes > ACTION_INLINE_PAYLOAD_MAX_BYTES) throw new AppError(413, 'action_input_invalid', `Action input 不能超过 ${ACTION_INLINE_PAYLOAD_MAX_BYTES} bytes`);
    const invocationId = randomUUID();
    const parentChain = parent ? normalizedParentChain(parent) : [];
    if (parentChain.some((entry) => targetKey(entry.target) === targetKey(input.target))) throw new AppError(409, 'action_cycle_detected', 'Action 调用链出现重复目标');
    const callChain = [...parentChain, { invocation_id: invocationId, target: input.target }];
    if (callChain.length > ACTION_CALL_MAX_DEPTH) throw new AppError(409, 'action_depth_exceeded', `Action 调用深度不能超过 ${ACTION_CALL_MAX_DEPTH}`);
    const rootInvocationId = parent?.rootInvocationId ?? parent?.id ?? invocationId;
    const inputSha256 = sha(input.input); const requestScopeKey = sha({ team: membership.teamId, userId, caller, parentInvocationId: parent?.id ?? null, kind, target: input.target, key: input.request_idempotency_key });
    const existing = await this.prisma.actionInvocation.findUnique({ where: { requestScopeKey } });
    if (existing) { if (existing.inputSha256 !== inputSha256) throw new AppError(409, 'action_idempotency_conflict', '相同幂等键对应了不同输入'); return this.publicInvocation(existing); }
    if (parent && (parent.status !== 'RUNNING' || parent.deadlineAt <= new Date())) throw new AppError(409, 'action_dependency_denied', '父 Action invocation 已终止或过期');
    const authorization = await this.governance.authorize({ userId, target: input.target, caller: caller.kind, invocationKind: kind, webPreview: caller.kind === 'WEB' && kind === 'PREVIEW' });
    assertActionValue((authorization.action as Record<string, unknown>).input_schema, input.input, 'input');
    try {
      const createRow = async (tx: Prisma.TransactionClient | PrismaService) => {
        if (parent) {
          const liveParent = await tx.actionInvocation.findFirst({ where: { id: parent.id, teamId: membership.teamId, principalUserId: userId, status: 'RUNNING', kind, deadlineAt: { gt: new Date() } } });
          if (!liveParent) throw new AppError(409, 'action_dependency_denied', '父 Action invocation 已终止或执行范围已变化');
          const locked = await tx.actionInvocation.updateMany({ where: { id: rootInvocationId, teamId: membership.teamId }, data: { updatedAt: new Date() } });
          if (locked.count !== 1) throw new AppError(409, 'action_dependency_denied', '根 Action invocation 不存在');
          const active = await tx.actionInvocation.count({ where: { teamId: membership.teamId, status: { in: ['AUTHORIZED', 'RUNNING'] }, OR: [{ id: rootInvocationId }, { rootInvocationId }] } });
          if (active >= ACTION_CALL_MAX_CONCURRENCY) throw new AppError(429, 'action_concurrency_exceeded', `同一根调用最多允许 ${ACTION_CALL_MAX_CONCURRENCY} 个活动 Action`);
        }
        return tx.actionInvocation.create({ data: { id: invocationId, teamId: membership.teamId, principalUserId: userId, kind, packageId: input.target.package_id, releaseId: input.target.release_id, releaseSha256: input.target.sha256, actionId: input.target.action_id, actionContractVersion: input.target.action_contract_version, actionSurfaceSha256: input.target.action_surface_sha256, callerKind: caller.kind, callerId: caller.id, requestId: randomUUID(), requestScopeKey, requestIdempotencyKey: input.request_idempotency_key, effectIdempotencyKey: input.effect_idempotency_key, rootInvocationId, parentInvocationId: parent?.id, callChain: callChain as unknown as Prisma.InputJsonValue, policyRevision: authorization.decision.policy_revision, requiredOperations: authorization.required_operations, input: input.input as Prisma.InputJsonValue, inputSha256, authorizationDecision: authorization.decision as Prisma.InputJsonValue, executionBinding: authorization.action as Prisma.InputJsonValue, deadlineAt: deadline, cloudDeploymentId: input.cloud_binding?.deployment_id, cloudRoutingGeneration: input.cloud_binding?.routing_generation, cloudEnvironment: input.cloud_binding?.environment } });
      };
      const created = parent
        ? await this.prisma.$transaction((tx) => createRow(tx), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
        : await createRow(this.prisma);
      return this.publicInvocation(created);
    } catch (error) { if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') { const raced = await this.prisma.actionInvocation.findUnique({ where: { requestScopeKey } }); if (raced && raced.inputSha256 === inputSha256) return this.publicInvocation(raced); throw new AppError(409, 'action_idempotency_conflict', '相同幂等键对应了不同输入'); } throw error; }
  }
  async nestedCaller(userId: string, parentInvocationId: string) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const parent = await this.prisma.actionInvocation.findFirst({ where: { id: parentInvocationId, teamId: membership.teamId, principalUserId: userId, status: 'RUNNING', deadlineAt: { gt: new Date() } } });
    if (!parent) throw new AppError(409, 'action_dependency_denied', '父 Action invocation 不存在、已终止或不属于当前主体');
    return {
      package_id: parent.packageId,
      release_id: parent.releaseId,
      sha256: parent.releaseSha256,
    };
  }
  async completeCloudWorkflowAttempt(userId: string, invocationId: string, attemptId: string, output: Record<string, unknown>, transport: { requestBytes: number; responseBytes: number; endpointHttpStatus: number }) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    return this.settleCloudWorkflowAttempt(membership.teamId, invocationId, attemptId, { status: 'SUCCEEDED', outcome: 'SUCCEEDED', output, ...transport });
  }
  async failCloudWorkflowAttempt(userId: string, invocationId: string, attemptId: string, input: { code: string; message: string; outcome: 'FAILED' | 'TIMED_OUT' | 'RESULT_UNKNOWN'; requestBytes?: number; responseBytes?: number; endpointHttpStatus?: number }) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    return this.settleCloudWorkflowAttempt(membership.teamId, invocationId, attemptId, { status: 'FAILED', ...input });
  }
  async cancelCloudWorkflowAttempt(userId: string, invocationId: string, attemptId: string, message = 'Cloud action 已取消') {
    const membership = await this.auth.ensureCurrentTeam(userId);
    return this.settleCloudWorkflowAttempt(membership.teamId, invocationId, attemptId, { status: 'CANCELED', outcome: 'CANCELED', code: 'action_cancelled', message });
  }
  async get(userId: string, id: string) { const membership = await this.auth.ensureCurrentTeam(userId); const row = await this.prisma.actionInvocation.findFirst({ where: { id, teamId: membership.teamId } }); if (!row) throw notFound('Action invocation 不存在'); return this.publicInvocation(row); }
  async claim(userId: string, id: string) { const membership = await this.auth.ensureCurrentTeam(userId); const result = await this.prisma.actionInvocation.updateMany({ where: { id, teamId: membership.teamId, status: 'AUTHORIZED', deadlineAt: { gt: new Date() } }, data: { status: 'RUNNING', startedAt: new Date() } }); if (result.count !== 1) throw conflict('Action invocation 已被领取或已终止'); return this.get(userId, id); }
  async complete(userId: string, id: string, output: Record<string, unknown>) { const membership = await this.auth.ensureCurrentTeam(userId); const current = await this.prisma.actionInvocation.findFirst({ where: { id, teamId: membership.teamId, status: 'RUNNING' }, select: { executionBinding: true } }); if (!current) throw conflict('Action invocation 当前状态不能完成'); assertActionValue((current.executionBinding as Record<string, unknown> | null)?.output_schema, output, 'output'); const now = new Date(); const result = await this.prisma.actionInvocation.updateMany({ where: { id, teamId: membership.teamId, status: 'RUNNING' }, data: { status: 'SUCCEEDED', output: output as Prisma.InputJsonValue, outputSha256: sha(output), completedAt: now } }); if (result.count !== 1) throw conflict('Action invocation 当前状态不能完成'); return this.get(userId, id); }
  async claimDesktop(userId: string, id: string) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const result = await this.prisma.actionInvocation.updateMany({ where: { id, teamId: membership.teamId, principalUserId: userId, callerKind: { in: ['DESKTOP', 'ACTION'] }, status: 'AUTHORIZED', deadlineAt: { gt: new Date() } }, data: { status: 'RUNNING', startedAt: new Date() } });
    if (result.count !== 1) throw conflict('Desktop Action invocation 已被领取或已终止');
    return this.get(userId, id);
  }
  async completeDesktop(userId: string, id: string, output: Record<string, unknown>) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const where = { id, teamId: membership.teamId, principalUserId: userId, callerKind: { in: ['DESKTOP' as const, 'ACTION' as const] }, status: 'RUNNING' as const };
    const current = await this.prisma.actionInvocation.findFirst({ where, select: { executionBinding: true } });
    if (!current) throw conflict('Desktop Action invocation 当前状态不能完成');
    assertActionValue((current.executionBinding as Record<string, unknown> | null)?.output_schema, output, 'output');
    const result = await this.prisma.actionInvocation.updateMany({ where, data: { status: 'SUCCEEDED', output: output as Prisma.InputJsonValue, outputSha256: sha(output), completedAt: new Date() } });
    if (result.count !== 1) throw conflict('Desktop Action invocation 当前状态不能完成');
    return this.get(userId, id);
  }
  async failDesktop(userId: string, id: string, code: string, message: string) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const result = await this.prisma.actionInvocation.updateMany({ where: { id, teamId: membership.teamId, principalUserId: userId, callerKind: { in: ['DESKTOP', 'ACTION'] }, status: 'RUNNING' }, data: { status: 'FAILED', completedAt: new Date(), errorCode: code.slice(0, 128), errorMessage: message.slice(0, 1000) } });
    if (result.count !== 1) throw conflict('Desktop Action invocation 已终止');
    return this.get(userId, id);
  }

  /**
   * Desktop workflow completion boundary.  Invocation and step attempt are
   * terminalized with one Serializable transaction and conditional updates;
   * if either CAS loses, the whole transaction rolls back.  This closes the
   * crash window where an invocation was SUCCEEDED while its step remained
   * RUNNING (or vice versa).
   */
  async completeWorkflowAttempt(userId: string, invocationId: string, attemptId: string, output: Record<string, unknown>) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    await this.prisma.$transaction((tx) => this.completeWorkflowAttemptTx(tx, membership.teamId, invocationId, attemptId, output), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return { ok: true as const };
  }

  private async completeWorkflowAttemptTx(tx: Prisma.TransactionClient, teamId: string, invocationId: string, attemptId: string, output: Record<string, unknown>) {
    const invocation = await tx.actionInvocation.findFirst({ where: { id: invocationId, teamId, status: 'RUNNING' } });
    const attempt = await tx.workflowStepAttempt.findFirst({ where: { id: attemptId, actionInvocationId: invocationId, status: 'RUNNING', run: { teamId } }, include: { run: true } });
    if (!invocation || !attempt) throw conflict('Action invocation 或 workflow step 当前状态不能完成');
    const expectedKind = attempt.run.executionScope === 'PREVIEW' ? 'PREVIEW' : 'STANDARD';
    if (invocation.kind !== expectedKind) throw conflict('Action invocation 与 workflow execution scope 不一致');
    assertActionValue((invocation.executionBinding as Record<string, unknown> | null)?.output_schema, output, 'output');
    await this.artifacts?.acquireHandoffPendingTx(tx, { invocationId, runId: attempt.runId, attemptId, output, retainUntil: attempt.run.resultRetainUntil });
    const now = new Date();
    const invocationChanged = await tx.actionInvocation.updateMany({ where: { id: invocationId, teamId, status: 'RUNNING' }, data: { status: 'SUCCEEDED', output: output as Prisma.InputJsonValue, outputSha256: sha(output), completedAt: now } });
    const attemptChanged = await tx.workflowStepAttempt.updateMany({ where: { id: attemptId, actionInvocationId: invocationId, status: 'RUNNING' }, data: { status: 'SUCCEEDED', output: output as Prisma.InputJsonValue, outputSha256: sha(output), completedAt: now, leaseTokenSha256: null, leaseExpiresAt: null, leaseHeartbeatAt: null } });
    if (invocationChanged.count !== 1 || attemptChanged.count !== 1) throw conflict('Action invocation 或 workflow step 已终止');
  }

  async failWorkflowAttempt(userId: string, invocationId: string, attemptId: string, code: string, message: string) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    await this.prisma.$transaction(async (tx) => {
      const invocationChanged = await tx.actionInvocation.updateMany({ where: { id: invocationId, teamId: membership.teamId, status: 'RUNNING' }, data: { status: 'FAILED', completedAt: new Date(), errorCode: code.slice(0, 128), errorMessage: message.slice(0, 1000) } });
      const attemptChanged = await tx.workflowStepAttempt.updateMany({ where: { id: attemptId, actionInvocationId: invocationId, status: 'RUNNING' }, data: { status: 'FAILED', completedAt: new Date(), errorCode: code.slice(0, 128), errorMessage: message.slice(0, 1000), leaseTokenSha256: null, leaseExpiresAt: null, leaseHeartbeatAt: null } });
      if (invocationChanged.count !== 1 || attemptChanged.count !== 1) throw conflict('Action invocation 或 workflow step 已终止');
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return { ok: true as const };
  }
  async fail(userId: string, id: string, code: string, message: string) { const membership = await this.auth.ensureCurrentTeam(userId); return this.terminal(id, membership.teamId, ['RUNNING'], 'FAILED', code, message); }
  async cancel(userId: string, id: string) { const membership = await this.auth.ensureCurrentTeam(userId); const result = await this.prisma.actionInvocation.updateMany({ where: { id, teamId: membership.teamId, status: { in: ['AUTHORIZED', 'RUNNING'] } }, data: { status: 'CANCELED', completedAt: new Date(), errorCode: 'action_cancelled', errorMessage: 'Action invocation 已取消' } }); if (result.count !== 1) throw conflict('Action invocation 已终止'); return this.get(userId, id); }
  private async settleCloudWorkflowAttempt(teamId: string, invocationId: string, attemptId: string, settlement: { status: 'SUCCEEDED'; outcome: 'SUCCEEDED'; output: Record<string, unknown>; requestBytes: number; responseBytes: number; endpointHttpStatus: number } | { status: 'FAILED'; outcome: 'FAILED' | 'TIMED_OUT' | 'RESULT_UNKNOWN'; code: string; message: string; requestBytes?: number; responseBytes?: number; endpointHttpStatus?: number } | { status: 'CANCELED'; outcome: 'CANCELED'; code: string; message: string }) {
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const invocationStatuses = settlement.status === 'SUCCEEDED' ? ['RUNNING'] as const : ['AUTHORIZED', 'RUNNING'] as const;
      const invocation = await tx.actionInvocation.findFirst({ where: { id: invocationId, teamId, status: { in: [...invocationStatuses] }, cloudDeploymentId: { not: null } } });
      const attempt = await tx.workflowStepAttempt.findFirst({ where: { id: attemptId, actionInvocationId: invocationId, status: 'RUNNING', run: { teamId, executionTarget: 'CLOUD' } }, include: { run: true } });
      if (!invocation || !attempt || !invocation.cloudDeploymentId) throw conflict('Cloud invocation 或 workflow attempt 已终止');
      if (settlement.status === 'SUCCEEDED') assertActionValue((invocation.executionBinding as Record<string, unknown> | null)?.output_schema, settlement.output, 'output');
      if (settlement.status === 'SUCCEEDED') await this.artifacts?.acquireHandoffPendingTx(tx, { invocationId, runId: attempt.runId, attemptId, output: settlement.output, retainUntil: attempt.run.resultRetainUntil });
      const invocationData = settlement.status === 'SUCCEEDED'
        ? { status: 'SUCCEEDED' as const, output: settlement.output as Prisma.InputJsonValue, outputSha256: sha(settlement.output), completedAt: now }
        : { status: settlement.status === 'CANCELED' ? 'CANCELED' as const : 'FAILED' as const, completedAt: now, errorCode: settlement.code.slice(0, 128), errorMessage: settlement.message.slice(0, 1000) };
      const attemptData = settlement.status === 'SUCCEEDED'
        ? { status: 'SUCCEEDED' as const, output: settlement.output as Prisma.InputJsonValue, outputSha256: sha(settlement.output), completedAt: now, deliveryState: 'DELIVERED', transportResponseSha256: sha(settlement.output), endpointHttpStatus: settlement.endpointHttpStatus, requestBytes: settlement.requestBytes, responseBytes: settlement.responseBytes }
        : { status: settlement.status === 'CANCELED' ? 'CANCELED' as const : 'FAILED' as const, completedAt: now, errorCode: settlement.code.slice(0, 128), errorMessage: settlement.message.slice(0, 1000), deliveryState: settlement.outcome === 'RESULT_UNKNOWN' ? 'UNKNOWN' : 'DELIVERED', endpointHttpStatus: 'endpointHttpStatus' in settlement ? settlement.endpointHttpStatus : undefined, requestBytes: 'requestBytes' in settlement ? settlement.requestBytes ?? 0 : 0, responseBytes: 'responseBytes' in settlement ? settlement.responseBytes ?? 0 : 0 };
      const invocationChanged = await tx.actionInvocation.updateMany({ where: { id: invocationId, teamId, status: { in: [...invocationStatuses] } }, data: invocationData });
      const attemptChanged = await tx.workflowStepAttempt.updateMany({ where: { id: attemptId, actionInvocationId: invocationId, status: 'RUNNING' }, data: attemptData });
      if (invocationChanged.count !== 1 || attemptChanged.count !== 1) throw conflict('Cloud invocation 或 workflow attempt 已终止');
      await tx.cloudUsageEvent.create({ data: { teamId, sourceKind: 'WORKFLOW_ATTEMPT', sourceId: attemptId, eventKind: 'EXECUTION', packageId: invocation.packageId, releaseId: invocation.releaseId, releaseSha256: invocation.releaseSha256, actionId: invocation.actionId, actionContractVersion: invocation.actionContractVersion, actionSurfaceSha256: invocation.actionSurfaceSha256, deploymentId: invocation.cloudDeploymentId, executionScope: attempt.run.executionScope, durationMs: Math.max(0, now.getTime() - (invocation.startedAt?.getTime() ?? now.getTime())), requestBytes: 'requestBytes' in settlement ? settlement.requestBytes ?? 0 : 0, responseBytes: 'responseBytes' in settlement ? settlement.responseBytes ?? 0 : 0, outcome: settlement.outcome, pricingDimensions: {}, occurredAt: now } });
    });
    return { ok: true as const };
  }
  private async terminal(id: string, teamId: string, from: Array<'RUNNING'>, status: 'FAILED', code: string, message: string) { const result = await this.prisma.actionInvocation.updateMany({ where: { id, teamId, status: { in: from } }, data: { status, completedAt: new Date(), errorCode: code.slice(0, 128), errorMessage: message.slice(0, 1000) } }); if (result.count !== 1) throw conflict('Action invocation 已终止'); const row = await this.prisma.actionInvocation.findFirst({ where: { id, teamId } }); if (!row) throw notFound('Action invocation 不存在'); return this.publicInvocation(row); }
  private publicInvocation(row: any) { return { id: row.id, team_id: row.teamId, kind: row.kind, status: row.status, target: { package_id: row.packageId, release_id: row.releaseId, sha256: row.releaseSha256, action_id: row.actionId, action_contract_version: row.actionContractVersion, action_surface_sha256: row.actionSurfaceSha256 }, root_invocation_id: row.rootInvocationId ?? row.id, parent_invocation_id: row.parentInvocationId ?? null, call_chain: normalizedStoredChain(row), policy_revision: row.policyRevision, required_operations: row.requiredOperations, input: row.input, output: row.output ?? null, deadline_at: row.deadlineAt.toISOString(), created_at: row.createdAt.toISOString(), started_at: row.startedAt?.toISOString() ?? null, completed_at: row.completedAt?.toISOString() ?? null, error_code: row.errorCode, error_message: row.errorMessage }; }
}

function invocationTarget(row: Pick<ParentInvocation, 'packageId' | 'releaseId' | 'releaseSha256' | 'actionId' | 'actionContractVersion' | 'actionSurfaceSha256'>): ActionTarget {
  return { package_id: row.packageId, release_id: row.releaseId, sha256: row.releaseSha256, action_id: row.actionId, action_contract_version: row.actionContractVersion, action_surface_sha256: row.actionSurfaceSha256 };
}

function normalizedStoredChain(row: ParentInvocation): ActionCallChainEntryValue[] {
  const raw = Array.isArray(row.callChain) ? row.callChain : [];
  const parsed = raw.flatMap((entry) => {
    const result = ActionCallChainEntry.safeParse(entry);
    return result.success ? [result.data] : [];
  });
  if (parsed.some((entry) => entry.invocation_id === row.id)) return parsed;
  return [...parsed, { invocation_id: row.id, target: invocationTarget(row) }];
}

function normalizedParentChain(parent: ParentInvocation): ActionCallChainEntryValue[] {
  return normalizedStoredChain(parent);
}

function targetKey(target: ActionTarget): string {
  return `${target.package_id}:${target.release_id}:${target.sha256}:${target.action_id}:${target.action_contract_version}:${target.action_surface_sha256}`;
}
