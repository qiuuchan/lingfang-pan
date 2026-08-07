import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  ActionTarget,
  WorkflowBinding,
  WorkflowDefinitionV1,
  WorkflowExecutionPlan,
  WorkflowFrozenSubplan,
  WorkflowPreflightDiagnostic,
  WorkflowPreflightRequest,
  WorkflowPreflightResponse,
  WorkflowRunCreateRequest,
  WorkflowRunListRequest,
  WorkflowRunListResponse,
} from '@lingfang/contract';
import { AppError, conflict, notFound } from '../common';
import { PrismaService } from '../prisma.service';
import { AuthService } from './auth.service';
import { PluginGovernanceService } from './plugin-governance.service';
import { ActionInvocationService } from './action-invocation.service';
import { DesktopExecutorSessionService } from './desktop-executor-session.service';
import { CloudActionRoutingService } from './cloud-action-routing.service';
import { RuntimeArtifactService, type HandoffDestination } from './runtime-artifact.service';
import type { AutomationConfig } from '../automation/automation-config';
import { AUTOMATION_CONFIG } from '../automation/automation.tokens';
import {
  publicWorkflowRunDetail,
  publicWorkflowRunSummary,
  type WorkflowRunWithAttempts,
} from './workflow-run.serialization';

type WorkflowReleaseSnapshot = Prisma.WorkflowReleaseGetPayload<{
  include: { pluginRelease: true; nodes: true };
}>;
type DesktopSessionBinding = { id: string; inventorySha256: string } | null;
type ScheduledRunContext = {
  scheduleId: string;
  teamId: string;
  generation: number;
  scheduledFor: Date;
  occurrenceKey: string;
  kind: 'ONCE' | 'DAILY' | 'WEEKLY';
};
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object'
      ? `{${Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
          .join(',')}}`
      : JSON.stringify(value);
const sha = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');

@Injectable()
export class WorkflowRunService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(PluginGovernanceService) private readonly governance: PluginGovernanceService,
    @Inject(ActionInvocationService) private readonly invocations: ActionInvocationService,
    @Inject(DesktopExecutorSessionService)
    private readonly executorSessions: DesktopExecutorSessionService,
    @Inject(CloudActionRoutingService) private readonly cloudRouting: CloudActionRoutingService,
    @Optional() @Inject(RuntimeArtifactService) private readonly artifacts?: RuntimeArtifactService,
    @Optional() @Inject(AUTOMATION_CONFIG) private readonly automationConfig?: AutomationConfig
  ) {}
  async start(userId: string, input: WorkflowRunCreateRequest, desktopExecutorToken?: string) {
    return this.startInternal(userId, input, desktopExecutorToken);
  }
  async startScheduled(
    userId: string,
    schedule: {
      id: string;
      teamId: string;
      generation: number;
      workflowReleaseId: string;
      workflowReleaseSha256: string;
      inputJson: unknown;
      kind: 'ONCE' | 'DAILY' | 'WEEKLY';
    },
    scheduledFor: Date,
    occurrenceKey: string
  ) {
    const input: WorkflowRunCreateRequest = {
      workflow_release_id: schedule.workflowReleaseId,
      sha256: schedule.workflowReleaseSha256,
      execution_target: 'CLOUD',
      execution_scope: 'PRODUCTION',
      input: schedule.inputJson as Record<string, never>,
      idempotency_key: `schedule-${sha({ id: schedule.id, generation: schedule.generation, occurrenceKey })}`,
      deadline_at: new Date(
        Math.max(Date.now(), scheduledFor.getTime()) + 24 * 60 * 60 * 1000
      ).toISOString(),
    };
    return this.startInternal(userId, input, undefined, {
      scheduleId: schedule.id,
      teamId: schedule.teamId,
      generation: schedule.generation,
      scheduledFor,
      occurrenceKey,
      kind: schedule.kind,
    });
  }
  private async startInternal(
    userId: string,
    input: WorkflowRunCreateRequest,
    desktopExecutorToken?: string,
    scheduled?: ScheduledRunContext
  ) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const workflow = await this.prisma.workflowRelease.findUnique({
      where: { pluginReleaseId: input.workflow_release_id },
      include: { pluginRelease: true, nodes: true },
    });
    if (
      !workflow ||
      workflow.pluginRelease.sha256 !== input.sha256 ||
      workflow.pluginRelease.status !== 'PUBLISHED'
    )
      throw notFound('工作流发行版不存在或身份不匹配');
    if (scheduled && membership.teamId !== scheduled.teamId)
      throw new AppError(403, 'forbidden', '计划创建者当前团队上下文已变化');
    if (input.execution_target === 'CLOUD' && !workflow.cloudEligible)
      throw new AppError(409, 'workflow_executor_unavailable', '工作流包含不能在 Cloud 执行的节点');
    if (input.execution_target === 'CLOUD') {
      this.assertCloudEnabled(Boolean(scheduled));
      await this.assertRunQuota(membership.teamId, workflow.pluginReleaseId);
    }
    const desktopSession =
      input.execution_target === 'DESKTOP'
        ? await this.executorSessions.validate(
            userId,
            String(input.desktop_executor_session_id || ''),
            String(desktopExecutorToken || '')
          )
        : null;
    const scope = input.execution_scope;
    const deadline = new Date(input.deadline_at);
    if (!Number.isFinite(deadline.getTime()) || deadline <= new Date())
      throw new AppError(400, 'workflow_deadline_invalid', '工作流 deadline 必须位于未来');
    const plan = this.executionPlan(workflow, input.execution_target, scope, desktopSession);
    const planSha256 = sha(plan);
    const inputAuthorizationDigest = this.artifacts
      ? await this.artifacts.workflowInputAuthorizationDigest({
          teamId: membership.teamId,
          principalUserId: userId,
          kind: scope === 'PREVIEW' ? 'PREVIEW' : 'STANDARD',
          value: input.input,
        })
      : sha([]);
    const requestScopeSha256 = sha({
      team: membership.teamId,
      userId,
      release: workflow.pluginReleaseId,
      target: input.execution_target,
      scope,
      caller: 'public_workflow_run_api',
    });
    const requestDigest = sha({
      input: input.input,
      input_authorization_digest: inputAuthorizationDigest,
      deadline: deadline.toISOString(),
      desktop_executor_session_id: input.desktop_executor_session_id ?? null,
    });
    const existing = await this.prisma.workflowRun.findUnique({
      where: {
        requestScopeSha256_idempotencyKey: {
          requestScopeSha256,
          idempotencyKey: input.idempotency_key,
        },
      },
    });
    if (existing) {
      if (existing.requestDigest !== requestDigest)
        throw new AppError(409, 'workflow_run_conflict', '相同幂等键对应了不同工作流请求');
      return this.get(userId, existing.id);
    }
    const operations = [
      'run_workflow',
      ...(input.execution_target === 'CLOUD' ? ['execute_cloud'] : []),
      ...(scope === 'PREVIEW' ? ['web_preview'] : []),
      ...(scheduled ? ['trigger_schedule'] : []),
    ] as Array<'run_workflow' | 'execute_cloud' | 'web_preview' | 'trigger_schedule'>;
    operations.sort();
    const authorization = await this.governance.authorizeRelease(
      userId,
      { releaseId: workflow.pluginReleaseId, sha256: input.sha256 },
      operations,
      {
        workflow: {
          workflow_release_id: workflow.pluginReleaseId,
          workflow_plan_sha256: planSha256,
        },
      }
    );
    const rootId = randomUUID();
    const cloudBindings =
      input.execution_target === 'CLOUD'
        ? await Promise.all(
            this.workflowLeafTargets(plan).map((node) =>
              this.cloudRouting.freeze(
                userId,
                node.target,
                scope === 'PREVIEW' ? 'PREVIEW' : 'PRODUCTION',
                rootId,
                node.nodePath
              )
            )
          )
        : [];
    const decisionId = sha(authorization.decision);
    const now = new Date();
    const resultRetainUntil = new Date(
      Math.min(
        deadline.getTime() + 7 * 24 * 60 * 60 * 1000,
        now.getTime() + 30 * 24 * 60 * 60 * 1000
      )
    );
    try {
      const run = await this.prisma.$transaction(async (tx) => {
        const created = await tx.workflowRun.create({
          data: {
            id: rootId,
            teamId: membership.teamId,
            principalUserId: userId,
            workflowReleaseId: workflow.pluginReleaseId,
            executionScope: scope,
            executionTarget: input.execution_target,
            status: 'RUNNING',
            requestScopeSha256,
            idempotencyKey: input.idempotency_key,
            requestDigest,
            inputDigest: sha(input.input),
            rootLogicalExecutionId: rootId,
            triggerKind: scheduled ? 'SCHEDULE' : 'MANUAL',
            deadlineAt: deadline,
            resultRetainUntil,
            desktopExecutorSessionId: desktopSession?.id,
            desktopInventorySha256: desktopSession?.inventorySha256,
            planSha256,
            frozenPlan: plan as unknown as Prisma.InputJsonValue,
            input: input.input as Prisma.InputJsonValue,
            policyRevision: authorization.decision.policy_revision,
            authorizationDecision: authorization.decision as Prisma.InputJsonValue,
            startedAt: now,
            scheduleId: scheduled?.scheduleId,
            scheduleGeneration: scheduled?.generation,
            scheduledFor: scheduled?.scheduledFor,
            occurrenceKey: scheduled?.occurrenceKey,
            cloudBindings: {
              create: cloudBindings.map((binding) => ({
                nodePath: binding.node_path,
                deploymentId: binding.deployment_id,
                routingGeneration: binding.routing_generation,
                environment: binding.environment,
                policyDecisionId: decisionId,
              })),
            },
            attempts: {
              create: plan.nodes.map((node) => ({
                nodeId: node.node_id,
                fullNodePath: node.node_id,
                attempt: 0,
                status: node.depends_on.length === 0 ? 'READY' : 'PENDING',
                requestKey: `${rootId}:${node.node_id}:0`,
                packageId: node.target.package_id,
                releaseId: node.target.release_id,
                releaseSha256: node.target.sha256,
                actionId: node.target.action_id,
                actionContractVersion: node.target.action_contract_version,
                actionSurfaceSha256: node.target.action_surface_sha256,
                executionSemantics: node.execution_semantics,
                retryLimit: node.retry_limit,
              })),
            },
          },
        });
        if (this.artifacts)
          await this.artifacts.bindWorkflowInputsTx(tx, {
            runId: rootId,
            teamId: membership.teamId,
            principalUserId: userId,
            kind: scope === 'PREVIEW' ? 'PREVIEW' : 'STANDARD',
            value: input.input,
            retainUntil: resultRetainUntil,
          });
        if (input.execution_target === 'CLOUD')
          await tx.automationOutbox.create({
            data: {
              kind: 'ENQUEUE_RUN',
              aggregateId: rootId,
              generation: scheduled?.generation ?? 0,
              payload: { run_id: rootId, plan_sha256: planSha256 },
            },
          });
        if (scheduled)
          await tx.automationSchedule.updateMany({
            where: {
              id: scheduled.scheduleId,
              teamId: scheduled.teamId,
              generation: scheduled.generation,
              status: 'ACTIVE',
            },
            data: {
              lastScheduledFor: scheduled.scheduledFor,
              lastRunId: rootId,
              ...(scheduled.kind === 'ONCE' ? { status: 'COMPLETED', nextRunAt: null } : {}),
            },
          });
        return created;
      });
      return this.get(userId, run.id);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const raced = await this.prisma.workflowRun.findUnique({
          where: {
            requestScopeSha256_idempotencyKey: {
              requestScopeSha256,
              idempotencyKey: input.idempotency_key,
            },
          },
        });
        if (raced && raced.requestDigest === requestDigest) return this.get(userId, raced.id);
        throw new AppError(409, 'workflow_run_conflict', '相同幂等键对应了不同工作流请求');
      }
      throw error;
    }
  }
  async preflight(
    userId: string,
    input: WorkflowPreflightRequest,
    desktopExecutorToken?: string
  ): Promise<WorkflowPreflightResponse> {
    await this.auth.ensureCurrentTeam(userId);
    const diagnostics: WorkflowPreflightDiagnostic[] = [];
    const workflow = await this.prisma.workflowRelease.findUnique({
      where: { pluginReleaseId: input.workflow_release_id },
      include: { pluginRelease: true, nodes: true },
    });
    if (
      !workflow ||
      workflow.pluginRelease.sha256 !== input.sha256 ||
      workflow.pluginRelease.status !== 'PUBLISHED'
    ) {
      diagnostics.push(
        this.diagnostic('workflow_target_unavailable', '工作流发行版不存在、已撤回或身份不匹配', [
          'workflow_release_id',
        ])
      );
      return {
        eligible: false,
        workflow_release_id: input.workflow_release_id,
        execution_target: input.execution_target,
        execution_scope: input.execution_scope,
        plan: null,
        diagnostics,
      };
    }
    const deadline = new Date(input.deadline_at);
    if (!Number.isFinite(deadline.getTime()) || deadline <= new Date())
      diagnostics.push(
        this.diagnostic('workflow_deadline_invalid', '工作流 deadline 必须位于未来', [
          'deadline_at',
        ])
      );
    if (input.execution_target === 'CLOUD' && !workflow.cloudEligible)
      diagnostics.push(
        this.diagnostic('workflow_cloud_ineligible', '工作流包含不能在 Cloud 执行的节点', [
          'execution_target',
        ])
      );
    if (input.execution_target === 'CLOUD') {
      try {
        this.assertCloudEnabled(false);
      } catch (error) {
        diagnostics.push(this.errorDiagnostic(error, ['execution_target']));
      }
    }
    let desktopSession: DesktopSessionBinding = null;
    if (input.execution_target === 'DESKTOP') {
      try {
        desktopSession = await this.executorSessions.validate(
          userId,
          String(input.desktop_executor_session_id || ''),
          String(desktopExecutorToken || '')
        );
      } catch (error) {
        diagnostics.push(this.errorDiagnostic(error, ['desktop_executor_session_id']));
      }
    }
    const plan = this.executionPlan(
      workflow,
      input.execution_target,
      input.execution_scope,
      desktopSession
    );
    if (!diagnostics.some((item) => item.severity === 'ERROR')) {
      const operations = [
        'run_workflow',
        ...(input.execution_target === 'CLOUD' ? ['execute_cloud'] : []),
        ...(input.execution_scope === 'PREVIEW' ? ['web_preview'] : []),
      ] as Array<'run_workflow' | 'execute_cloud' | 'web_preview'>;
      operations.sort();
      try {
        await this.governance.authorizeRelease(
          userId,
          { releaseId: workflow.pluginReleaseId, sha256: input.sha256 },
          operations,
          {
            workflow: {
              workflow_release_id: workflow.pluginReleaseId,
              workflow_plan_sha256: sha(plan),
            },
          }
        );
      } catch (error) {
        diagnostics.push(this.errorDiagnostic(error, []));
      }
    }
    return {
      eligible: !diagnostics.some((item) => item.severity === 'ERROR'),
      workflow_release_id: workflow.pluginReleaseId,
      execution_target: input.execution_target,
      execution_scope: input.execution_scope,
      plan,
      diagnostics,
    };
  }
  async get(userId: string, id: string) {
    return { run: publicWorkflowRunDetail(await this.getRow(userId, id)) };
  }
  async resultArtifact(userId: string, runId: string, artifactId: string) {
    if (!this.artifacts)
      throw new AppError(503, 'artifact_service_unavailable', '运行制品服务不可用');
    return this.artifacts.authorizeWorkflowResult(userId, runId, artifactId);
  }
  async importPreviewArtifact(userId: string, runId: string, artifactId: string) {
    if (!this.artifacts)
      throw new AppError(503, 'artifact_service_unavailable', '运行制品服务不可用');
    return this.artifacts.importPreviewResult(userId, runId, artifactId);
  }
  async list(userId: string, query: WorkflowRunListRequest): Promise<WorkflowRunListResponse> {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const limit = Math.min(Math.max(query.limit, 1), 100);
    const rows = await this.prisma.workflowRun.findMany({
      where: { teamId: membership.teamId, ...(query.status ? { status: query.status } : {}) },
      include: { attempts: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      runs: page.map(publicWorkflowRunSummary),
      next_cursor: hasMore ? (page.at(-1)?.id ?? null) : null,
    };
  }
  async dispatchReady(userId: string, runId: string, desktopExecutorToken?: string) {
    const run = await this.getRow(userId, runId);
    if (run.status !== 'RUNNING') return { dispatched: [] };
    if (run.executionTarget === 'DESKTOP')
      await this.executorSessions.validate(
        userId,
        String(run.desktopExecutorSessionId || ''),
        String(desktopExecutorToken || ''),
        String(run.desktopInventorySha256 || '')
      );
    const plan = run.frozenPlan as unknown as WorkflowExecutionPlan;
    const nodes = plan.nodes;
    const dispatched = [] as string[];
    const parentInvocationId = run.parentStepAttemptId
      ? ((
          await this.prisma.workflowStepAttempt.findUnique({
            where: { id: run.parentStepAttemptId },
            select: { actionInvocationId: true },
          })
        )?.actionInvocationId ?? undefined)
      : undefined;
    for (const attempt of run.attempts.filter((item) => item.status === 'READY')) {
      const node = nodes.find((candidate) => candidate.node_id === attempt.nodeId);
      if (!node) throw new AppError(409, 'workflow_invalid', `冻结计划缺少节点：${attempt.nodeId}`);
      const childSubplan = (plan.workflow_subplans || []).find(
        (candidate) => candidate.workflow_release_id === node.target.release_id
      );
      if (run.executionTarget === 'CLOUD') {
        this.assertCloudEnabled(run.triggerKind === 'SCHEDULE');
        if (!childSubplan)
          await this.assertActionQuota(run.teamId, attempt.releaseId, attempt.actionId);
      }
      const mappedInput = this.materialize(
        node.input_bindings,
        run.input,
        Object.fromEntries(
          run.attempts
            .filter((item) => item.status === 'SUCCEEDED')
            .map((item) => [item.nodeId, item.output])
        )
      );
      const cloudBinding =
        run.executionTarget === 'CLOUD' && !childSubplan
          ? run.cloudBindings.find((binding) => binding.nodePath === attempt.fullNodePath)
          : undefined;
      if (run.executionTarget === 'CLOUD' && !childSubplan && !cloudBinding)
        throw new AppError(
          409,
          'cloud_endpoint_not_ready',
          `节点缺少冻结 deployment：${attempt.nodeId}`
        );
      const invocation = await this.invocations.create(userId, {
        target: node.target,
        preview: run.executionScope === 'PREVIEW',
        input: mappedInput,
        request_idempotency_key: attempt.requestKey,
        effect_idempotency_key:
          attempt.executionSemantics === 'idempotent'
            ? `${run.rootLogicalExecutionId}:${attempt.fullNodePath}`
            : undefined,
        deadline_at: run.deadlineAt.toISOString(),
        caller: { kind: run.executionTarget === 'CLOUD' ? 'CLOUD' : 'WORKFLOW', id: run.id },
        parent_invocation_id: parentInvocationId,
        cloud_binding: cloudBinding
          ? {
              deployment_id: cloudBinding.deploymentId,
              routing_generation: cloudBinding.routingGeneration,
              environment: cloudBinding.environment,
            }
          : undefined,
      });
      const changed = await this.prisma.workflowStepAttempt.updateMany({
        where: { id: attempt.id, status: 'READY', actionInvocationId: null },
        data: {
          status: 'RUNNING',
          actionInvocationId: invocation.id,
          input: mappedInput as Prisma.InputJsonValue,
          inputSha256: sha(mappedInput),
          startedAt: new Date(),
        },
      });
      if (changed.count === 1) {
        dispatched.push(attempt.id);
        if (childSubplan) {
          await this.invocations.claim(userId, invocation.id);
          const childRunId = await this.createChildRun(
            run,
            attempt,
            mappedInput,
            childSubplan,
            plan
          );
          await this.dispatchReady(userId, childRunId, desktopExecutorToken);
        }
      }
    }
    return { dispatched };
  }
  async coordinateCloud(userId: string, runId: string) {
    let run = await this.getRow(userId, runId);
    if (run.executionTarget !== 'CLOUD' || run.principalUserId !== userId)
      throw new AppError(409, 'workflow_executor_unavailable', '该运行不是当前主体的 Cloud 工作流');
    for (const attempt of run.attempts.filter((item) => item.status === 'SUCCEEDED'))
      await this.projectHandoff({ ...attempt, run });
    if (run.status === 'RUNNING') {
      const latest = new Map<string, (typeof run.attempts)[number]>();
      run.attempts.forEach((attempt) => {
        const current = latest.get(attempt.nodeId);
        if (!current || attempt.attempt > current.attempt) latest.set(attempt.nodeId, attempt);
      });
      for (const attempt of [...latest.values()].filter((item) => item.status === 'FAILED')) {
        const retryable =
          attempt.attempt < attempt.retryLimit &&
          (attempt.executionSemantics === 'read_only' ||
            attempt.executionSemantics === 'idempotent');
        if (!retryable) {
          await this.beginFailure(userId, runId);
          break;
        }
        await this.prisma.workflowStepAttempt
          .create({
            data: {
              runId: attempt.runId,
              nodeId: attempt.nodeId,
              fullNodePath: attempt.fullNodePath,
              attempt: attempt.attempt + 1,
              status: 'READY',
              requestKey: `${attempt.runId}:${attempt.fullNodePath}:${attempt.attempt + 1}`,
              effectKey:
                attempt.executionSemantics === 'idempotent'
                  ? attempt.effectKey || `${run.rootLogicalExecutionId}:${attempt.fullNodePath}`
                  : null,
              packageId: attempt.packageId,
              releaseId: attempt.releaseId,
              releaseSha256: attempt.releaseSha256,
              actionId: attempt.actionId,
              actionContractVersion: attempt.actionContractVersion,
              actionSurfaceSha256: attempt.actionSurfaceSha256,
              executionSemantics: attempt.executionSemantics,
              retryLimit: attempt.retryLimit,
            },
          })
          .catch((error) => {
            if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'))
              throw error;
          });
      }
    }
    await this.advance(runId);
    await this.dispatchReady(userId, runId);
    run = await this.getRow(userId, runId);
    return { run: publicWorkflowRunDetail(run) };
  }
  async claimReady(userId: string, runId: string, sessionToken: string) {
    await this.dispatchReady(userId, runId, sessionToken);
    const run = await this.getRow(userId, runId);
    if (run.executionTarget !== 'DESKTOP')
      throw new AppError(409, 'workflow_executor_session_invalid', '该工作流不是桌面执行目标');
    await this.executorSessions.validate(
      userId,
      String(run.desktopExecutorSessionId || ''),
      sessionToken,
      String(run.desktopInventorySha256 || '')
    );
    const now = new Date();
    const nestedReleaseIds = new Set(
      ((run.frozenPlan as unknown as WorkflowExecutionPlan).workflow_subplans || []).map(
        (item) => item.workflow_release_id
      )
    );
    let candidate = run.attempts.find(
      (attempt) =>
        attempt.status === 'RUNNING' &&
        !nestedReleaseIds.has(attempt.releaseId) &&
        (!attempt.leaseExpiresAt || attempt.leaseExpiresAt <= now)
    );
    let candidateRunId = runId;
    if (!candidate) {
      const rootId = run.rootRunId || run.id;
      const childRuns = await this.prisma.workflowRun.findMany({
        where: {
          rootRunId: rootId,
          status: 'RUNNING',
          teamId: run.teamId,
          principalUserId: userId,
        },
        include: { attempts: true },
        orderBy: { createdAt: 'asc' },
      });
      for (const child of childRuns) {
        const childNested = new Set(
          (
            ((child.frozenPlan || {}) as unknown as WorkflowExecutionPlan).workflow_subplans || []
          ).map((item) => item.workflow_release_id)
        );
        candidate = child.attempts.find(
          (attempt) =>
            attempt.status === 'RUNNING' &&
            !childNested.has(attempt.releaseId) &&
            (!attempt.leaseExpiresAt || attempt.leaseExpiresAt <= now)
        );
        if (candidate) {
          candidateRunId = child.id;
          break;
        }
      }
    }
    if (!candidate) return { attempt: null };
    const leaseToken = randomBytes(32).toString('base64url');
    const leaseExpiresAt = new Date(now.getTime() + 30_000);
    const claimed = await this.prisma.workflowStepAttempt.updateMany({
      where: {
        id: candidate.id,
        runId: candidateRunId,
        status: 'RUNNING',
        actionInvocationId: { not: null },
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
      },
      data: { leaseTokenSha256: sha(leaseToken), leaseExpiresAt, leaseHeartbeatAt: now },
    });
    if (claimed.count !== 1) return { attempt: null };
    try {
      await this.invocations.claim(userId, candidate.actionInvocationId!);
    } catch (error) {
      await this.prisma.workflowStepAttempt.updateMany({
        where: { id: candidate.id, leaseTokenSha256: sha(leaseToken) },
        data: { leaseTokenSha256: null, leaseExpiresAt: null, leaseHeartbeatAt: null },
      });
      throw error;
    }
    return {
      attempt: {
        id: candidate.id,
        run_id: candidateRunId,
        node_id: candidate.nodeId,
        input: candidate.input,
        target: {
          package_id: candidate.packageId,
          release_id: candidate.releaseId,
          sha256: candidate.releaseSha256,
          action_id: candidate.actionId,
          action_contract_version: candidate.actionContractVersion,
          action_surface_sha256: candidate.actionSurfaceSha256,
        },
        deadline_at: run.deadlineAt.toISOString(),
        lease_token: leaseToken,
        lease_expires_at: leaseExpiresAt.toISOString(),
      },
    };
  }
  async heartbeatLease(
    userId: string,
    attemptId: string,
    sessionToken: string,
    leaseToken: string
  ) {
    const attempt = await this.authorizeLease(userId, attemptId, sessionToken, leaseToken);
    const now = new Date();
    const expires = new Date(now.getTime() + 30_000);
    const changed = await this.prisma.workflowStepAttempt.updateMany({
      where: {
        id: attempt.id,
        status: 'RUNNING',
        leaseTokenSha256: sha(leaseToken),
        leaseExpiresAt: { gt: now },
      },
      data: { leaseHeartbeatAt: now, leaseExpiresAt: expires },
    });
    if (changed.count !== 1)
      throw new AppError(409, 'workflow_lease_expired', '工作流步骤 lease 已过期');
    return { ok: true as const, lease_expires_at: expires.toISOString() };
  }
  async completeLeased(
    userId: string,
    attemptId: string,
    sessionToken: string,
    leaseToken: string,
    output: Record<string, unknown>
  ) {
    await this.authorizeLease(userId, attemptId, sessionToken, leaseToken);
    return this.completeStep(userId, attemptId, output);
  }
  async failLeased(
    userId: string,
    attemptId: string,
    sessionToken: string,
    leaseToken: string,
    code: string,
    message: string
  ) {
    await this.authorizeLease(userId, attemptId, sessionToken, leaseToken);
    return this.failStep(userId, attemptId, code, message);
  }
  private async authorizeLease(
    userId: string,
    attemptId: string,
    sessionToken: string,
    leaseToken: string
  ) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const now = new Date();
    const attempt = await this.prisma.workflowStepAttempt.findFirst({
      where: {
        id: attemptId,
        status: 'RUNNING',
        leaseTokenSha256: sha(leaseToken),
        leaseExpiresAt: { gt: now },
        run: { teamId: membership.teamId, principalUserId: userId, executionTarget: 'DESKTOP' },
      },
      include: { run: true },
    });
    if (!attempt)
      throw new AppError(409, 'workflow_lease_expired', '工作流步骤 lease 无效或已过期');
    await this.executorSessions.validate(
      userId,
      String(attempt.run.desktopExecutorSessionId || ''),
      sessionToken,
      String(attempt.run.desktopInventorySha256 || '')
    );
    return attempt;
  }
  async completeStep(userId: string, attemptId: string, output: Record<string, unknown>) {
    const attempt = await this.prisma.workflowStepAttempt.findUnique({
      where: { id: attemptId },
      include: { run: true },
    });
    if (!attempt?.actionInvocationId) throw notFound('工作流步骤不存在');
    await this.invocations.completeWorkflowAttempt(
      userId,
      attempt.actionInvocationId,
      attempt.id,
      output
    );
    await this.projectHandoff(attempt);
    await this.advance(attempt.runId);
    return this.get(userId, attempt.runId);
  }
  async failStep(userId: string, attemptId: string, code: string, message: string) {
    const attempt = await this.prisma.workflowStepAttempt.findUnique({
      where: { id: attemptId },
      include: { run: true },
    });
    if (!attempt?.actionInvocationId || attempt.status !== 'RUNNING')
      throw notFound('运行中的工作流步骤不存在');
    await this.invocations.failWorkflowAttempt(
      userId,
      attempt.actionInvocationId,
      attempt.id,
      code,
      message
    );
    const changed = { count: 1 };
    if (changed.count !== 1) throw conflict('工作流步骤已终止');
    const retryable =
      attempt.attempt < attempt.retryLimit &&
      (attempt.executionSemantics === 'read_only' || attempt.executionSemantics === 'idempotent');
    if (retryable && attempt.run.status === 'RUNNING')
      await this.prisma.workflowStepAttempt.create({
        data: {
          runId: attempt.runId,
          nodeId: attempt.nodeId,
          fullNodePath: attempt.fullNodePath,
          attempt: attempt.attempt + 1,
          status: 'READY',
          requestKey: `${attempt.runId}:${attempt.fullNodePath}:${attempt.attempt + 1}`,
          effectKey:
            attempt.executionSemantics === 'idempotent'
              ? attempt.effectKey || `${attempt.run.rootLogicalExecutionId}:${attempt.fullNodePath}`
              : null,
          packageId: attempt.packageId,
          releaseId: attempt.releaseId,
          releaseSha256: attempt.releaseSha256,
          actionId: attempt.actionId,
          actionContractVersion: attempt.actionContractVersion,
          actionSurfaceSha256: attempt.actionSurfaceSha256,
          executionSemantics: attempt.executionSemantics,
          retryLimit: attempt.retryLimit,
        },
      });
    else await this.beginFailure(userId, attempt.runId);
    return this.get(userId, attempt.runId);
  }
  async cancel(userId: string, runId: string) {
    const run = await this.getRow(userId, runId);
    if (['SUCCEEDED', 'FAILED', 'CANCELED'].includes(run.status))
      return { run: publicWorkflowRunDetail(run) };
    if (run.executionTarget === 'CLOUD') {
      await this.prisma.$transaction(async (tx) => {
        await tx.workflowRun.updateMany({
          where: {
            id: runId,
            teamId: run.teamId,
            status: { in: ['PENDING', 'RUNNING', 'FAILING'] },
          },
          data: { status: 'CANCELING' },
        });
        await tx.workflowStepAttempt.updateMany({
          where: { runId, status: { in: ['PENDING', 'READY'] } },
          data: {
            status: 'CANCELED',
            completedAt: new Date(),
            errorCode: 'workflow_cancelled',
            errorMessage: '工作流已取消',
          },
        });
        await tx.automationOutbox.upsert({
          where: {
            kind_aggregateId_generation: {
              kind: 'CANCEL_RUN',
              aggregateId: runId,
              generation: run.scheduleGeneration ?? 0,
            },
          },
          create: {
            kind: 'CANCEL_RUN',
            aggregateId: runId,
            generation: run.scheduleGeneration ?? 0,
            payload: { run_id: runId, plan_sha256: run.planSha256 },
          },
          update: {
            status: 'PENDING',
            availableAt: new Date(),
            lockedBy: null,
            lockedUntil: null,
            lastErrorCode: '',
          },
        });
      });
      return this.get(userId, runId);
    }
    await this.prisma.workflowRun.updateMany({
      where: { id: runId, teamId: run.teamId, status: { in: ['PENDING', 'RUNNING'] } },
      data: { status: 'CANCELING' },
    });
    await this.prisma.workflowStepAttempt.updateMany({
      where: { runId, status: { in: ['PENDING', 'READY'] } },
      data: {
        status: 'CANCELED',
        completedAt: new Date(),
        errorCode: 'workflow_cancelled',
        errorMessage: '工作流已取消',
      },
    });
    for (const attempt of run.attempts.filter(
      (item) => item.status === 'RUNNING' && item.actionInvocationId
    )) {
      try {
        await this.invocations.cancel(userId, attempt.actionInvocationId!);
      } catch {}
      await this.prisma.workflowStepAttempt.updateMany({
        where: { id: attempt.id, status: 'RUNNING' },
        data: {
          status: 'CANCELED',
          completedAt: new Date(),
          errorCode: 'action_cancelled',
          errorMessage: '工作流取消了节点调用',
        },
      });
    }
    await this.advance(runId);
    return this.get(userId, runId);
  }
  async coordinateCloudCancellation(userId: string, runId: string) {
    const run = await this.getRow(userId, runId);
    if (run.executionTarget !== 'CLOUD' || run.principalUserId !== userId)
      throw new AppError(409, 'workflow_executor_unavailable', '该运行不是当前主体的 Cloud 工作流');
    if (run.status !== 'CANCELING') return { run: publicWorkflowRunDetail(run) };
    for (const attempt of run.attempts.filter(
      (item) => item.status === 'RUNNING' && item.actionInvocationId
    )) {
      await this.invocations
        .cancelCloudWorkflowAttempt(userId, attempt.actionInvocationId!, attempt.id)
        .catch(() => undefined);
    }
    await this.advance(runId);
    return this.get(userId, runId);
  }
  private async beginFailure(userId: string, runId: string) {
    await this.prisma.workflowRun.updateMany({
      where: { id: runId, status: 'RUNNING' },
      data: { status: 'FAILING' },
    });
    await this.prisma.workflowStepAttempt.updateMany({
      where: { runId, status: { in: ['PENDING', 'READY'] } },
      data: {
        status: 'SKIPPED',
        completedAt: new Date(),
        errorCode: 'workflow_step_failed',
        errorMessage: '前置节点失败，未再调度',
      },
    });
    const running = await this.prisma.workflowStepAttempt.findMany({
      where: { runId, status: 'RUNNING', actionInvocationId: { not: null } },
    });
    for (const attempt of running) {
      try {
        await this.invocations.cancel(userId, attempt.actionInvocationId!);
      } catch {}
      await this.prisma.workflowStepAttempt.updateMany({
        where: { id: attempt.id, status: 'RUNNING' },
        data: {
          status: 'CANCELED',
          completedAt: new Date(),
          errorCode: 'action_cancelled',
          errorMessage: '工作流失败关闭取消了并行节点',
        },
      });
    }
    await this.advance(runId);
  }
  private async createChildRun(
    parent: WorkflowRunWithAttempts & {
      cloudBindings: Array<{
        nodePath: string;
        deploymentId: string;
        routingGeneration: number;
        environment: 'PREVIEW' | 'PRODUCTION';
      }>;
    },
    parentAttempt: WorkflowRunWithAttempts['attempts'][number],
    input: Record<string, unknown>,
    subplan: WorkflowFrozenSubplan,
    rootPlan: WorkflowExecutionPlan
  ): Promise<string> {
    const childId = randomUUID();
    const childPlan: WorkflowExecutionPlan = {
      plan_version: '1',
      workflow_release_id: subplan.workflow_release_id,
      workflow_release_sha256: subplan.workflow_release_sha256,
      definition_sha256: subplan.definition_sha256,
      execution_target: parent.executionTarget,
      execution_scope: parent.executionScope,
      max_parallelism: subplan.max_parallelism,
      nodes: subplan.nodes,
      workflow_subplans: rootPlan.workflow_subplans,
      output_bindings: subplan.output_bindings,
      desktop_executor:
        parent.executionTarget === 'DESKTOP' &&
        parent.desktopExecutorSessionId &&
        parent.desktopInventorySha256
          ? {
              session_id: parent.desktopExecutorSessionId,
              inventory_sha256: parent.desktopInventorySha256,
            }
          : null,
    };
    const requestScopeSha256 = sha({
      root: parent.rootRunId || parent.id,
      parent_attempt: parentAttempt.id,
      workflow_release_id: subplan.workflow_release_id,
    });
    const idempotencyKey = `nested:${parentAttempt.id}:${parentAttempt.attempt}`;
    const existing = await this.prisma.workflowRun.findUnique({
      where: { requestScopeSha256_idempotencyKey: { requestScopeSha256, idempotencyKey } },
    });
    if (existing) return existing.id;
    const prefix = `${parentAttempt.fullNodePath}/`;
    const bindings = parent.cloudBindings.filter((binding) => binding.nodePath.startsWith(prefix));
    const created = await this.prisma.workflowRun.create({
      data: {
        id: childId,
        teamId: parent.teamId,
        principalUserId: parent.principalUserId,
        workflowReleaseId: subplan.workflow_release_id,
        executionScope: parent.executionScope,
        executionTarget: parent.executionTarget,
        status: 'RUNNING',
        requestScopeSha256,
        idempotencyKey,
        requestDigest: sha({
          input,
          parent_attempt_id: parentAttempt.id,
          plan_sha256: sha(childPlan),
        }),
        inputDigest: sha(input),
        rootLogicalExecutionId: parent.rootLogicalExecutionId,
        planSha256: sha(childPlan),
        frozenPlan: childPlan as unknown as Prisma.InputJsonValue,
        input: input as Prisma.InputJsonValue,
        policyRevision: parent.policyRevision,
        authorizationDecision: parent.authorizationDecision as Prisma.InputJsonValue,
        rootRunId: parent.rootRunId || parent.id,
        parentStepAttemptId: parentAttempt.id,
        triggerKind: parent.triggerKind,
        deadlineAt: parent.deadlineAt,
        resultRetainUntil: parent.resultRetainUntil,
        desktopExecutorSessionId: parent.desktopExecutorSessionId,
        desktopInventorySha256: parent.desktopInventorySha256,
        startedAt: new Date(),
        cloudBindings: {
          create: bindings.map((binding) => ({
            nodePath: binding.nodePath,
            deploymentId: binding.deploymentId,
            routingGeneration: binding.routingGeneration,
            environment: binding.environment,
            policyDecisionId: sha(parent.authorizationDecision),
          })),
        },
        attempts: {
          create: subplan.nodes.map((node) => ({
            nodeId: node.node_id,
            fullNodePath: `${parentAttempt.fullNodePath}/${node.node_id}`,
            attempt: 0,
            status: node.depends_on.length === 0 ? 'READY' : 'PENDING',
            requestKey: `${parent.rootLogicalExecutionId}:${parentAttempt.fullNodePath}/${node.node_id}:0`,
            effectKey:
              node.execution_semantics === 'idempotent'
                ? `${parent.rootLogicalExecutionId}:${parentAttempt.fullNodePath}/${node.node_id}`
                : null,
            packageId: node.target.package_id,
            releaseId: node.target.release_id,
            releaseSha256: node.target.sha256,
            actionId: node.target.action_id,
            actionContractVersion: node.target.action_contract_version,
            actionSurfaceSha256: node.target.action_surface_sha256,
            executionSemantics: node.execution_semantics,
            retryLimit: node.retry_limit,
          })),
        },
      },
    });
    return created.id;
  }
  private async advance(runId: string) {
    const run = await this.prisma.workflowRun.findUnique({
      where: { id: runId },
      include: { attempts: true },
    });
    if (!run) return;
    const active = run.attempts.filter((item) =>
      ['PENDING', 'READY', 'RUNNING'].includes(item.status)
    );
    if (run.status === 'FAILING' && active.length === 0) {
      await this.terminalizeRun(
        runId,
        'FAILING',
        'FAILED',
        { errorCode: 'workflow_step_failed', errorMessage: '工作流节点失败' },
        false
      );
      return;
    }
    if (run.status === 'CANCELING' && active.length === 0) {
      await this.terminalizeRun(
        runId,
        'CANCELING',
        'CANCELED',
        { errorCode: 'workflow_cancelled', errorMessage: '工作流已取消' },
        false
      );
      return;
    }
    if (run.status !== 'RUNNING') return;
    const plan = run.frozenPlan as unknown as WorkflowExecutionPlan;
    const nodes = plan.nodes;
    const latest = new Map<string, (typeof run.attempts)[number]>();
    run.attempts.forEach((attempt) => {
      const current = latest.get(attempt.nodeId);
      if (!current || attempt.attempt > current.attempt) latest.set(attempt.nodeId, attempt);
    });
    for (const attempt of [...latest.values()].filter((item) => item.status === 'PENDING')) {
      const node = nodes.find((candidate) => candidate.node_id === attempt.nodeId);
      if (!node) throw new AppError(409, 'workflow_invalid', `冻结计划缺少节点：${attempt.nodeId}`);
      if (node.depends_on.every((dependency) => latest.get(dependency)?.status === 'SUCCEEDED'))
        await this.prisma.workflowStepAttempt.updateMany({
          where: { id: attempt.id, status: 'PENDING' },
          data: { status: 'READY' },
        });
    }
    if ([...latest.values()].every((attempt) => attempt.status === 'SUCCEEDED')) {
      const outputs = Object.fromEntries(
        [...latest.values()].map((attempt) => [attempt.nodeId, attempt.output])
      );
      const output = this.materialize(plan.output_bindings, run.input, outputs);
      await this.terminalizeRun(
        runId,
        'RUNNING',
        'SUCCEEDED',
        { output: output as Prisma.InputJsonValue },
        true
      );
    }
  }
  private async projectHandoff(attempt: {
    id: string;
    runId: string;
    nodeId: string;
    run: { id: string; resultRetainUntil: Date; frozenPlan: unknown };
  }) {
    if (!this.artifacts) return;
    const plan = (attempt.run.frozenPlan || {}) as {
      nodes?: Array<{ node_id: string; depends_on?: string[] }>;
    };
    const downstream = (plan.nodes || []).filter((node) =>
      (node.depends_on || []).includes(attempt.nodeId)
    );
    const destinations: HandoffDestination[] = downstream.length
      ? downstream.map((node) => ({
          kind: 'EDGE' as const,
          id: `${attempt.runId}:${attempt.id}:${node.node_id}`,
          scope: { target_node_id: node.node_id },
        }))
      : [
          {
            kind: 'FINAL_OUTPUT' as const,
            id: `${attempt.runId}:FINAL_OUTPUT`,
            scope: { run_id: attempt.runId, attempt_id: attempt.id },
          },
        ];
    // The success transaction already owns HANDOFF_PENDING.  Projection may be
    // retried by the reconciler, so a transient coordinator failure must not
    // roll the completed step back or strand the run in an un-retryable API
    // response state.
    await this.artifacts
      .convertHandoffPending(attempt.runId, attempt.id, destinations, attempt.run.resultRetainUntil)
      .catch(() => undefined);
  }
  private async terminalizeRun(
    runId: string,
    expected: 'RUNNING' | 'FAILING' | 'CANCELING',
    status: 'SUCCEEDED' | 'FAILED' | 'CANCELED',
    fields: { output?: Prisma.InputJsonValue; errorCode?: string; errorMessage?: string },
    preserveFinalOutput: boolean
  ) {
    const work = async (tx: Prisma.TransactionClient) => {
      const run =
        status === 'SUCCEEDED' && fields.output
          ? await tx.workflowRun.findUnique({ where: { id: runId } })
          : null;
      const changed = await tx.workflowRun.updateMany({
        where: { id: runId, status: expected },
        data: { status, completedAt: new Date(), ...fields },
      });
      if (changed.count === 1 && this.artifacts) {
        if (run && fields.output)
          await this.artifacts.grantFinalOutputsTx(tx, {
            runId,
            teamId: run.teamId,
            kind: run.executionScope === 'PREVIEW' ? 'PREVIEW' : 'STANDARD',
            output: fields.output,
            expiresAt: run.resultRetainUntil,
          });
        await tx.runtimeArtifactGrant.updateMany({
          where: { targetKind: 'WORKFLOW_RUN', targetId: runId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        await this.artifacts.releaseRunHoldsTx(tx, runId, preserveFinalOutput);
      }
      return changed.count;
    };
    const changed =
      typeof (this.prisma as PrismaService & { $transaction?: unknown }).$transaction === 'function'
        ? await this.prisma.$transaction(work, {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          })
        : (
            await this.prisma.workflowRun.updateMany({
              where: { id: runId, status: expected },
              data: { status, completedAt: new Date(), ...fields },
            })
          ).count;
    if (changed === 1) await this.settleParentRun(runId, status);
  }
  private async settleParentRun(runId: string, status: 'SUCCEEDED' | 'FAILED' | 'CANCELED') {
    const child = await this.prisma.workflowRun.findUnique({
      where: { id: runId },
      select: {
        principalUserId: true,
        parentStepAttemptId: true,
        output: true,
        errorCode: true,
        errorMessage: true,
      },
    });
    if (!child?.parentStepAttemptId || !child.principalUserId) return;
    const parentAttempt = await this.prisma.workflowStepAttempt.findUnique({
      where: { id: child.parentStepAttemptId },
      include: { run: true },
    });
    if (!parentAttempt?.actionInvocationId || parentAttempt.status !== 'RUNNING') return;
    if (status === 'SUCCEEDED') {
      await this.invocations.completeWorkflowAttempt(
        child.principalUserId,
        parentAttempt.actionInvocationId,
        parentAttempt.id,
        (child.output || {}) as Record<string, unknown>
      );
      await this.projectHandoff(parentAttempt);
      await this.advance(parentAttempt.runId);
      return;
    }
    await this.failStep(
      child.principalUserId,
      parentAttempt.id,
      child.errorCode || (status === 'CANCELED' ? 'workflow_cancelled' : 'workflow_step_failed'),
      child.errorMessage || (status === 'CANCELED' ? '子工作流已取消' : '子工作流失败')
    );
  }
  private async getRow(
    userId: string,
    id: string
  ): Promise<
    WorkflowRunWithAttempts & {
      cloudBindings: Array<{
        nodePath: string;
        deploymentId: string;
        routingGeneration: number;
        environment: 'PREVIEW' | 'PRODUCTION';
      }>;
    }
  > {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const run = await this.prisma.workflowRun.findFirst({
      where: { id, teamId: membership.teamId },
      include: {
        attempts: { orderBy: [{ nodeId: 'asc' }, { attempt: 'asc' }] },
        cloudBindings: true,
      },
    });
    if (!run) throw notFound('工作流运行不存在');
    return run;
  }
  private executionPlan(
    workflow: WorkflowReleaseSnapshot,
    executionTarget: WorkflowRunCreateRequest['execution_target'],
    executionScope: WorkflowRunCreateRequest['execution_scope'],
    desktopSession: DesktopSessionBinding
  ): WorkflowExecutionPlan {
    const definition = workflow.definitionJson as unknown as WorkflowDefinitionV1;
    const nodes = definition.nodes.map((node) => {
      const snapshot = workflow.nodes.find((item) => item.nodeId === node.node_id);
      return {
        node_id: node.node_id,
        declared_version_range:
          node.declared_version_range || snapshot?.declaredVersionRange || '*',
        target: node.target,
        depends_on: node.depends_on,
        input_bindings: node.input_bindings,
        retry_limit: node.retry_limit,
        execution_semantics: this.executionSemantics(snapshot?.executionSemantics),
        cloud_capable: snapshot?.cloudCapable ?? false,
      };
    });
    return {
      plan_version: '1',
      workflow_release_id: workflow.pluginReleaseId,
      workflow_release_sha256: workflow.pluginRelease.sha256,
      definition_sha256: workflow.definitionSha256,
      execution_target: executionTarget,
      execution_scope: executionScope,
      max_parallelism: Math.max(1, Math.min(workflow.maxParallelism || 1, 8)),
      nodes,
      workflow_subplans: Array.isArray(workflow.frozenClosure)
        ? (workflow.frozenClosure as unknown as WorkflowFrozenSubplan[])
        : [],
      output_bindings: definition.output_bindings,
      desktop_executor:
        executionTarget === 'DESKTOP' && desktopSession
          ? { session_id: desktopSession.id, inventory_sha256: desktopSession.inventorySha256 }
          : null,
    };
  }
  private executionSemantics(
    value: string | undefined
  ): 'read_only' | 'idempotent' | 'side_effect' {
    return value === 'read_only' || value === 'idempotent' ? value : 'side_effect';
  }
  private workflowLeafTargets(
    plan: WorkflowExecutionPlan
  ): Array<{ nodePath: string; target: ActionTarget }> {
    const subplans = new Map(
      (plan.workflow_subplans || []).map((subplan) => [subplan.workflow_release_id, subplan])
    );
    const leaves: Array<{ nodePath: string; target: ActionTarget }> = [];
    const visit = (nodes: WorkflowExecutionPlan['nodes'], prefix = '') => {
      for (const node of nodes) {
        const nodePath = prefix ? `${prefix}/${node.node_id}` : node.node_id;
        const child = subplans.get(node.target.release_id);
        if (child) visit(child.nodes, nodePath);
        else leaves.push({ nodePath, target: node.target });
      }
    };
    visit(plan.nodes);
    return leaves;
  }
  private diagnostic(
    code: string,
    message: string,
    path: Array<string | number>,
    nodeId: string | null = null
  ): WorkflowPreflightDiagnostic {
    return {
      severity: 'ERROR',
      code: code.slice(0, 128),
      message: message.slice(0, 1000),
      path,
      node_id: nodeId,
    };
  }
  private errorDiagnostic(
    error: unknown,
    path: Array<string | number>
  ): WorkflowPreflightDiagnostic {
    return error instanceof AppError
      ? this.diagnostic(error.code, error.message, path)
      : this.diagnostic('workflow_preflight_failed', '工作流预检失败', path);
  }
  private materialize(
    bindings: WorkflowBinding[],
    workflowInput: unknown,
    outputs: Record<string, unknown>
  ) {
    let result: Record<string, unknown> = {};
    for (const binding of bindings) {
      const value =
        binding.source.kind === 'literal'
          ? binding.source.value
          : binding.source.kind === 'workflow_input'
            ? this.pointerGet(workflowInput, binding.source.source_pointer)
            : this.pointerGet(outputs[binding.source.node_id], binding.source.source_pointer);
      result = this.pointerSet(result, binding.target_pointer, value);
    }
    return result;
  }
  private pointerGet(value: unknown, pointer: string) {
    let current: unknown = value;
    for (const part of this.parts(pointer)) {
      if (!current || typeof current !== 'object') {
        current = undefined;
        break;
      }
      current = (current as Record<string, unknown>)[part];
    }
    if (current === undefined)
      throw new AppError(409, 'workflow_mapping_invalid', `映射源不存在：${pointer}`);
    return structuredClone(current);
  }
  private pointerSet(root: Record<string, unknown>, pointer: string, value: unknown) {
    const parts = this.parts(pointer);
    if (!parts.length) {
      const replacement = structuredClone(value);
      if (!replacement || typeof replacement !== 'object' || Array.isArray(replacement))
        throw new AppError(409, 'workflow_mapping_invalid', '工作流根输入必须是对象');
      return replacement as Record<string, unknown>;
    }
    let current: Record<string, unknown> = root;
    parts.forEach((part, index) => {
      if (index === parts.length - 1) current[part] = structuredClone(value);
      else {
        const child = current[part];
        if (!child || typeof child !== 'object' || Array.isArray(child)) current[part] = {};
        current = current[part] as Record<string, unknown>;
      }
    });
    return root;
  }
  private parts(pointer: string) {
    return pointer === ''
      ? []
      : pointer
          .slice(1)
          .split('/')
          .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  }
  private assertCloudEnabled(schedule: boolean) {
    if (!this.automationConfig) return;
    if (
      !this.automationConfig.enabled ||
      (schedule
        ? !this.automationConfig.schedulesEnabled
        : !this.automationConfig.cloudManualEnabled)
    )
      throw new AppError(
        503,
        'cloud_disabled',
        schedule ? '定时自动化当前已关闭' : 'Cloud 手动运行当前已关闭'
      );
  }
  private async assertRunQuota(teamId: string, workflowReleaseId: string) {
    if (!this.automationConfig) return;
    const active = ['PENDING', 'RUNNING', 'FAILING', 'CANCELING'] as const;
    const [teamCount, workflowCount] = await Promise.all([
      this.prisma.workflowRun.count({
        where: { teamId, executionTarget: 'CLOUD', status: { in: [...active] } },
      }),
      this.prisma.workflowRun.count({
        where: { teamId, workflowReleaseId, executionTarget: 'CLOUD', status: { in: [...active] } },
      }),
    ]);
    if (
      teamCount >= this.automationConfig.teamMaxActiveRuns ||
      workflowCount >= this.automationConfig.workflowMaxActiveRuns
    )
      throw new AppError(429, 'cloud_quota_exceeded', 'Cloud 工作流并发配额已用尽');
  }
  private async assertActionQuota(teamId: string, releaseId: string, actionId: string) {
    if (!this.automationConfig) return;
    const active = await this.prisma.actionInvocation.count({
      where: {
        teamId,
        releaseId,
        actionId,
        cloudDeploymentId: { not: null },
        status: { in: ['AUTHORIZED', 'RUNNING'] },
      },
    });
    if (active >= this.automationConfig.actionMaxActiveInvocations)
      throw new AppError(429, 'cloud_quota_exceeded', 'Cloud action 并发配额已用尽');
  }
}
