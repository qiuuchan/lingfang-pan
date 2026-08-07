import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { AppError, conflict } from '../common';
import { PrismaService } from '../prisma.service';
import { assertActionValue } from './action-schema-validator';
import { ActionInvocationService } from './action-invocation.service';
import { CloudActionGatewayService } from './cloud-action-gateway.service';
@Injectable()
export class CloudPreviewWorkerProcessor {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ActionInvocationService) private readonly invocations: ActionInvocationService,
    @Inject(CloudActionGatewayService) private readonly gateway: CloudActionGatewayService
  ) {}
  async process(invocationId: string, signal?: AbortSignal) {
    const row = await this.prisma.actionInvocation.findUnique({ where: { id: invocationId } });
    if (
      !row ||
      row.kind !== 'PREVIEW' ||
      row.callerKind !== 'WEB' ||
      row.cloudEnvironment !== 'PREVIEW' ||
      !row.principalUserId
    )
      throw new AppError(
        409,
        'cloud_endpoint_target_mismatch',
        'Cloud Trial job 与 invocation 不匹配'
      );
    if (row.status !== 'AUTHORIZED')
      return { outcome: 'STALE' as const, invocation_id: invocationId };
    if (row.deadlineAt <= new Date()) {
      await this.fail(row, 'TIMED_OUT', 'action_timeout', 'Cloud Trial 已超时');
      return { outcome: 'TIMED_OUT' as const, invocation_id: invocationId };
    }
    await this.invocations.claim(row.principalUserId, row.id);
    try {
      const result = await this.gateway.invoke(row.id, signal);
      const current = await this.prisma.actionInvocation.findUniqueOrThrow({
        where: { id: row.id },
      });
      assertActionValue(
        (current.executionBinding as Record<string, unknown> | null)?.output_schema,
        result.output,
        'output'
      );
      await this.prisma.$transaction(async (tx) => {
        const changed = await tx.actionInvocation.updateMany({
          where: { id: row.id, status: 'RUNNING' },
          data: {
            status: 'SUCCEEDED',
            output: result.output as Prisma.InputJsonValue,
            outputSha256: digest(result.output),
            completedAt: new Date(),
          },
        });
        if (changed.count !== 1) throw conflict('Cloud Trial 已终止');
        await tx.cloudUsageEvent.create({
          data: {
            teamId: row.teamId,
            sourceKind: 'ACTION_INVOCATION',
            sourceId: row.id,
            packageId: row.packageId,
            releaseId: row.releaseId,
            releaseSha256: row.releaseSha256,
            actionId: row.actionId,
            actionContractVersion: row.actionContractVersion,
            actionSurfaceSha256: row.actionSurfaceSha256,
            deploymentId: result.deployment_id,
            executionScope: 'PREVIEW',
            durationMs: 0,
            requestBytes: result.request_bytes,
            responseBytes: result.response_bytes,
            outcome: 'SUCCEEDED',
            pricingDimensions: {},
            occurredAt: new Date(),
          },
        });
      });
      return { outcome: 'SUCCEEDED' as const, invocation_id: row.id };
    } catch (error) {
      if (signal?.aborted) {
        await this.fail(row, 'CANCELED', 'action_cancelled', 'Cloud Trial 已取消');
        return { outcome: 'CANCELED' as const, invocation_id: row.id };
      }
      await this.fail(
        row,
        'FAILED',
        error instanceof AppError ? error.code : 'cloud_endpoint_failed',
        error instanceof Error ? error.message : 'Cloud Trial 执行失败'
      );
      return { outcome: 'FAILED' as const, invocation_id: row.id };
    }
  }
  private async fail(
    row: any,
    outcome: 'FAILED' | 'CANCELED' | 'TIMED_OUT',
    code: string,
    message: string
  ) {
    const status =
      outcome === 'CANCELED' ? 'CANCELED' : outcome === 'TIMED_OUT' ? 'TIMED_OUT' : 'FAILED';
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.actionInvocation.updateMany({
        where: { id: row.id, status: { in: ['AUTHORIZED', 'RUNNING'] } },
        data: {
          status,
          completedAt: new Date(),
          errorCode: code.slice(0, 128),
          errorMessage: message.slice(0, 1000),
        },
      });
      if (changed.count !== 1 || !row.cloudDeploymentId) return;
      await tx.cloudUsageEvent.create({
        data: {
          teamId: row.teamId,
          sourceKind: 'ACTION_INVOCATION',
          sourceId: row.id,
          packageId: row.packageId,
          releaseId: row.releaseId,
          releaseSha256: row.releaseSha256,
          actionId: row.actionId,
          actionContractVersion: row.actionContractVersion,
          actionSurfaceSha256: row.actionSurfaceSha256,
          deploymentId: row.cloudDeploymentId,
          executionScope: 'PREVIEW',
          durationMs: 0,
          outcome,
          pricingDimensions: {},
          occurredAt: new Date(),
        },
      });
    });
  }
}
function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
