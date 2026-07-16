import { Inject, Injectable, Optional } from '@nestjs/common';
import type { CloudActionJob } from '../automation/automation-queue';
import { AppError, conflict, notFound } from '../common';
import { PrismaService } from '../prisma.service';
import { ActionInvocationService } from './action-invocation.service';
import { CloudActionGatewayService } from './cloud-action-gateway.service';
import type { AutomationConfig } from '../automation/automation-config';
import { AUTOMATION_CONFIG } from '../automation/automation.tokens';

const UNCERTAIN_DELIVERY_CODES = new Set(['cloud_timeout', 'cloud_endpoint_unavailable', 'cloud_endpoint_signature_invalid', 'cloud_endpoint_response_invalid', 'cloud_response_too_large']);

export type CloudActionWorkerResult = { outcome: 'SUCCEEDED' | 'FAILED' | 'CANCELED' | 'TIMED_OUT' | 'RESULT_UNKNOWN' | 'STALE'; attempt_id: string };

@Injectable()
export class CloudActionWorkerProcessor {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ActionInvocationService) private readonly invocations: ActionInvocationService,
    @Inject(CloudActionGatewayService) private readonly gateway: CloudActionGatewayService,
    @Optional() @Inject(AUTOMATION_CONFIG) private readonly config?: AutomationConfig,
  ) {}

  async process(job: Extract<CloudActionJob['data'], { run_id: string }>, signal?: AbortSignal): Promise<CloudActionWorkerResult> {
    const attempt = await this.prisma.workflowStepAttempt.findUnique({ where: { id: job.attempt_id }, include: { run: true } });
    if (!attempt) throw notFound('Cloud workflow attempt 不存在');
    if (attempt.runId !== job.run_id || attempt.actionInvocationId !== job.invocation_id || attempt.run.planSha256 !== job.plan_sha256 || attempt.run.executionTarget !== 'CLOUD') throw new AppError(409, 'cloud_endpoint_target_mismatch', 'Cloud action job 与冻结运行不匹配');
    if (!attempt.run.principalUserId) throw new AppError(409, 'cloud_endpoint_target_mismatch', 'Cloud workflow 缺少执行主体');
    if (attempt.status !== 'RUNNING') return { outcome: 'STALE', attempt_id: attempt.id };
    const userId = attempt.run.principalUserId;
    if (this.config && (!this.config.enabled || (attempt.run.triggerKind === 'SCHEDULE' ? !this.config.schedulesEnabled : !this.config.cloudManualEnabled))) {
      await this.invocations.failCloudWorkflowAttempt(userId, job.invocation_id, attempt.id, { code: 'cloud_disabled', message: 'Cloud 自动化已由平台暂停', outcome: 'FAILED' });
      return { outcome: 'FAILED', attempt_id: attempt.id };
    }
    if (attempt.run.status === 'CANCELING' || attempt.run.status === 'CANCELED' || signal?.aborted) {
      await this.invocations.cancelCloudWorkflowAttempt(userId, job.invocation_id, attempt.id);
      return { outcome: 'CANCELED', attempt_id: attempt.id };
    }
    if (attempt.run.deadlineAt <= new Date()) {
      await this.invocations.failCloudWorkflowAttempt(userId, job.invocation_id, attempt.id, { code: 'cloud_timeout', message: 'Cloud action 已超过运行 deadline', outcome: 'TIMED_OUT' });
      return { outcome: 'TIMED_OUT', attempt_id: attempt.id };
    }
    try {
      await this.invocations.claim(userId, job.invocation_id);
    } catch (error) {
      const latest = await this.prisma.workflowStepAttempt.findUnique({ where: { id: attempt.id }, select: { status: true } });
      if (latest && latest.status !== 'RUNNING') return { outcome: 'STALE', attempt_id: attempt.id };
      throw error;
    }
    try {
      const result = await this.gateway.invoke(job.invocation_id, signal);
      await this.invocations.completeCloudWorkflowAttempt(userId, job.invocation_id, attempt.id, result.output, { requestBytes: result.request_bytes, responseBytes: result.response_bytes, endpointHttpStatus: result.endpoint_http_status });
      return { outcome: 'SUCCEEDED', attempt_id: attempt.id };
    } catch (error) {
      const appError = error instanceof AppError ? error : new AppError(502, 'cloud_endpoint_unavailable', 'Cloud endpoint 执行失败');
      if (appError.code === 'cloud_request_cancelled' || signal?.aborted) {
        await this.invocations.cancelCloudWorkflowAttempt(userId, job.invocation_id, attempt.id, appError.message);
        return { outcome: 'CANCELED', attempt_id: attempt.id };
      }
      const timedOut = appError.code === 'cloud_timeout';
      const resultUnknown = attempt.executionSemantics === 'side_effect' && UNCERTAIN_DELIVERY_CODES.has(appError.code);
      const outcome = resultUnknown ? 'RESULT_UNKNOWN' as const : timedOut ? 'TIMED_OUT' as const : 'FAILED' as const;
      await this.invocations.failCloudWorkflowAttempt(userId, job.invocation_id, attempt.id, { code: resultUnknown ? 'cloud_result_unknown' : appError.code, message: resultUnknown ? 'side-effect endpoint 可能已收到请求，平台不会自动重试' : appError.message, outcome });
      return { outcome, attempt_id: attempt.id };
    }
  }
}
