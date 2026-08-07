import { Inject, Injectable } from '@nestjs/common';
import { CloudActionDeploymentTarget } from '@lingfang/contract';
import { Prisma, type CloudActionDeployment as DeploymentRow } from '@prisma/client';
import { randomBytes, randomUUID } from 'node:crypto';
import { AppError, conflict, notFound } from '../common';
import { PrismaService } from '../prisma.service';
import { AuthService } from './auth.service';
import { CloudEndpointSecretCipher } from './cloud-endpoint-secret-cipher';
import { SafeOutboundHttpClient } from './cloud-safe-http';
import {
  CLOUD_RESPONSE_SIGNATURE_HEADER,
  cloudRequestHeaders,
  verifyCloudResponseSignature,
  type CloudSignatureTarget,
} from './cloud-signature';
import type {
  CloudActionTargetDto,
  CreateCloudActionDeploymentDto,
} from './dto/cloud-action-deployment.dto';
import { PluginActionRegistryService } from './plugin-action-registry.service';

export const CLOUD_ENDPOINT_VERIFY_TYPE = 'lingfang.cloud.endpoint.verify.v1';

function signatureTarget(target: CloudActionTargetDto | DeploymentRow): CloudSignatureTarget {
  return {
    packageId: 'package_id' in target ? target.package_id : target.packageId,
    releaseId: 'release_id' in target ? target.release_id : target.releaseId,
    sha256: target.sha256,
    actionId: 'action_id' in target ? target.action_id : target.actionId,
    actionContractVersion:
      'action_contract_version' in target
        ? target.action_contract_version
        : target.actionContractVersion,
    actionSurfaceSha256:
      'action_surface_sha256' in target ? target.action_surface_sha256 : target.actionSurfaceSha256,
  };
}

function publicDeployment(row: DeploymentRow) {
  return {
    id: row.id,
    target: {
      package_id: row.packageId,
      release_id: row.releaseId,
      sha256: row.sha256,
      action_id: row.actionId,
      action_contract_version: row.actionContractVersion,
      action_surface_sha256: row.actionSurfaceSha256,
      environment: row.environment,
    },
    deployment_key: row.deploymentKey,
    supersedes_deployment_id: row.supersedesDeploymentId,
    endpoint_host: new URL(row.endpointUrl).hostname,
    status: row.status,
    secret_version: row.secretVersion,
    timeout_ms: row.timeoutMs,
    max_concurrency: row.maxConcurrency,
    rate_limit_per_minute: row.rateLimitPerMinute,
    response_limit_bytes: row.responseLimitBytes,
    last_health_at: row.lastHealthAt?.toISOString() ?? null,
    last_health_ok: row.lastHealthOk,
    last_health_error_code: row.lastHealthErrorCode,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function singleHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | null {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return typeof value === 'string' ? value : null;
}

function stableErrorCode(error: unknown): string {
  return error instanceof AppError ? error.code.slice(0, 128) : 'cloud_endpoint_unavailable';
}

@Injectable()
export class CloudActionDeploymentService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(PluginActionRegistryService) private readonly actions: PluginActionRegistryService,
    @Inject(CloudEndpointSecretCipher) private readonly cipher: CloudEndpointSecretCipher,
    @Inject(SafeOutboundHttpClient) private readonly http: SafeOutboundHttpClient
  ) {}

  async create(userId: string, input: CreateCloudActionDeploymentDto) {
    const membership = await this.managementContext(userId);
    await this.assertExactOwnedTarget(membership.teamId, input.target);
    const endpointUrl = this.http.validateUrl(input.endpoint_url).toString();
    const id = randomUUID();
    const secret = randomBytes(32).toString('base64url');
    const encrypted = this.cipher.encrypt(secret, id);
    const deployment = await this.prisma.$transaction(async (tx) => {
      const row = await tx.cloudActionDeployment.create({
        data: {
          id,
          teamId: membership.teamId,
          packageId: input.target.package_id,
          releaseId: input.target.release_id,
          sha256: input.target.sha256,
          actionId: input.target.action_id,
          actionContractVersion: input.target.action_contract_version,
          actionSurfaceSha256: input.target.action_surface_sha256,
          environment: input.target.environment,
          deploymentKey: input.deployment_key,
          endpointUrl,
          secretCiphertext: encrypted.ciphertext,
          secretVersion: encrypted.version,
          status: 'DRAFT',
          timeoutMs: input.timeout_ms ?? 30_000,
          maxConcurrency: input.max_concurrency ?? 4,
          rateLimitPerMinute: input.rate_limit_per_minute ?? 60,
          responseLimitBytes: input.response_limit_bytes ?? 1_048_576,
        },
      });
      await tx.auditLog.create({
        data: {
          actorUserId: userId,
          action: 'cloud.deployment.created',
          targetType: 'CloudActionDeployment',
          targetId: id,
          metadata: {
            teamId: membership.teamId,
            releaseId: input.target.release_id,
            actionId: input.target.action_id,
            environment: input.target.environment,
            endpointHost: new URL(endpointUrl).hostname,
          },
        },
      });
      return row;
    });
    return { deployment: publicDeployment(deployment), endpoint_secret: secret };
  }

  async list(userId: string, releaseId: string, actionId: string) {
    const membership = await this.managementContext(userId);
    const release = await this.prisma.pluginRelease.findFirst({
      where: { id: releaseId, package: { ownerTeamId: membership.teamId } },
      select: { id: true },
    });
    if (!release) throw notFound('插件发行版不存在');
    const rows = await this.prisma.cloudActionDeployment.findMany({
      where: { teamId: membership.teamId, releaseId, actionId },
      orderBy: { createdAt: 'desc' },
    });
    return { deployments: rows.map(publicDeployment) };
  }

  async verify(userId: string, id: string) {
    const { membership, deployment } = await this.ownedDeployment(userId, id);
    await this.assertExactOwnedTarget(membership.teamId, this.targetOf(deployment));
    const claimed = await this.prisma.cloudActionDeployment.updateMany({
      where: { id, teamId: membership.teamId, status: 'DRAFT' },
      data: { status: 'VERIFYING' },
    });
    if (claimed.count !== 1) throw conflict('只有 DRAFT deployment 可以验证');
    try {
      await this.performChallenge(deployment);
      const now = new Date();
      const finished = await this.prisma.cloudActionDeployment.updateMany({
        where: { id, teamId: membership.teamId, status: 'VERIFYING' },
        data: { status: 'READY', lastHealthAt: now, lastHealthOk: true, lastHealthErrorCode: '' },
      });
      if (finished.count !== 1) throw conflict('deployment 状态已变化');
      const ready = await this.prisma.cloudActionDeployment.findFirst({
        where: { id, teamId: membership.teamId },
      });
      if (!ready) throw notFound('Cloud deployment 不存在');
      await this.audit(userId, 'cloud.deployment.verified', id, { teamId: membership.teamId });
      return { deployment: publicDeployment(ready) };
    } catch (error) {
      const code = stableErrorCode(error);
      await this.prisma.cloudActionDeployment.updateMany({
        where: { id, teamId: membership.teamId, status: 'VERIFYING' },
        data: {
          status: 'DRAFT',
          lastHealthAt: new Date(),
          lastHealthOk: false,
          lastHealthErrorCode: code,
        },
      });
      await this.audit(userId, 'cloud.deployment.verify_failed', id, {
        teamId: membership.teamId,
        errorCode: code,
      });
      throw error;
    }
  }

  async disable(userId: string, id: string) {
    const { membership, deployment } = await this.ownedDeployment(userId, id);
    if (deployment.status === 'RETIRED') throw conflict('已退役 deployment 不能停用');
    if (deployment.status !== 'DISABLED') {
      const result = await this.prisma.cloudActionDeployment.updateMany({
        where: { id, teamId: membership.teamId, status: { in: ['DRAFT', 'VERIFYING', 'READY'] } },
        data: { status: 'DISABLED' },
      });
      if (result.count !== 1) throw conflict('deployment 状态已变化');
      await this.audit(userId, 'cloud.deployment.disabled', id, { teamId: membership.teamId });
    }
    const row = await this.prisma.cloudActionDeployment.findFirst({
      where: { id, teamId: membership.teamId },
    });
    if (!row) throw notFound('Cloud deployment 不存在');
    return { deployment: publicDeployment(row) };
  }

  async retire(userId: string, id: string) {
    const { membership, deployment } = await this.ownedDeployment(userId, id);
    if (deployment.status === 'RETIRED') return { deployment: publicDeployment(deployment) };
    const [activeRoutes, activeInvocations, activeWorkflowBindings] = await Promise.all([
      this.prisma.cloudActionRouting.count({
        where: { OR: [{ stableDeploymentId: id }, { candidateDeploymentId: id }] },
      }),
      this.prisma.actionInvocation.count({
        where: {
          teamId: membership.teamId,
          cloudDeploymentId: id,
          status: { in: ['AUTHORIZED', 'RUNNING'] },
        },
      }),
      this.prisma.workflowRunCloudBinding.count({
        where: {
          deploymentId: id,
          run: { status: { in: ['PENDING', 'RUNNING', 'FAILING', 'CANCELING'] } },
        },
      }),
    ]);
    if (activeRoutes > 0 || activeInvocations > 0 || activeWorkflowBindings > 0) {
      throw new AppError(
        409,
        'cloud_deployment_in_use',
        'deployment 仍被活动 routing 或非终态执行绑定引用'
      );
    }
    const changed = await this.prisma.cloudActionDeployment.updateMany({
      where: {
        id,
        teamId: membership.teamId,
        status: { in: ['DRAFT', 'VERIFYING', 'READY', 'DISABLED'] },
      },
      data: { status: 'RETIRED' },
    });
    if (changed.count !== 1) throw conflict('deployment 状态已变化');
    await this.audit(userId, 'cloud.deployment.retired', id, { teamId: membership.teamId });
    const row = await this.prisma.cloudActionDeployment.findFirst({
      where: { id, teamId: membership.teamId },
    });
    if (!row) throw notFound('Cloud deployment 不存在');
    return { deployment: publicDeployment(row) };
  }

  async rotateSecret(userId: string, id: string) {
    const { membership, deployment } = await this.ownedDeployment(userId, id);
    if (deployment.status !== 'READY') throw conflict('只有 READY deployment 可以轮换密钥');
    await this.assertExactOwnedTarget(membership.teamId, this.targetOf(deployment));
    const nextId = randomUUID();
    const secret = randomBytes(32).toString('base64url');
    const encrypted = this.cipher.encrypt(secret, nextId);
    const suffix = `.rotation.${nextId}`;
    const deploymentKey = `${deployment.deploymentKey.slice(0, 256 - suffix.length)}${suffix}`;
    const next = await this.prisma.$transaction(async (tx) => {
      const source = await tx.cloudActionDeployment.findFirst({
        where: { id, teamId: membership.teamId, status: 'READY' },
      });
      if (!source) throw conflict('源 deployment 状态已变化');
      const row = await tx.cloudActionDeployment.create({
        data: {
          id: nextId,
          teamId: membership.teamId,
          packageId: deployment.packageId,
          releaseId: deployment.releaseId,
          sha256: deployment.sha256,
          actionId: deployment.actionId,
          actionContractVersion: deployment.actionContractVersion,
          actionSurfaceSha256: deployment.actionSurfaceSha256,
          environment: deployment.environment,
          deploymentKey,
          supersedesDeploymentId: id,
          endpointUrl: deployment.endpointUrl,
          secretCiphertext: encrypted.ciphertext,
          secretVersion: deployment.secretVersion + 1,
          status: 'DRAFT',
          timeoutMs: deployment.timeoutMs,
          maxConcurrency: deployment.maxConcurrency,
          rateLimitPerMinute: deployment.rateLimitPerMinute,
          responseLimitBytes: deployment.responseLimitBytes,
        },
      });
      await tx.auditLog.create({
        data: {
          actorUserId: userId,
          action: 'cloud.deployment.secret_rotation_created',
          targetType: 'CloudActionDeployment',
          targetId: nextId,
          metadata: { teamId: membership.teamId, supersedesDeploymentId: id },
        },
      });
      return row;
    });
    return { deployment: publicDeployment(next), endpoint_secret: secret };
  }

  private async managementContext(userId: string) {
    await this.auth.ensurePermission(userId, 'team.plugin.edit_draft');
    return this.auth.ensureCurrentTeam(userId);
  }

  private async ownedDeployment(userId: string, id: string) {
    const membership = await this.managementContext(userId);
    const deployment = await this.prisma.cloudActionDeployment.findFirst({
      where: { id, teamId: membership.teamId },
    });
    if (!deployment) throw notFound('Cloud deployment 不存在');
    return { membership, deployment };
  }

  private targetOf(deployment: DeploymentRow): CloudActionTargetDto {
    return {
      package_id: deployment.packageId,
      release_id: deployment.releaseId,
      sha256: deployment.sha256,
      action_id: deployment.actionId,
      action_contract_version: deployment.actionContractVersion,
      action_surface_sha256: deployment.actionSurfaceSha256,
      environment: deployment.environment,
    };
  }

  private async assertExactOwnedTarget(teamId: string, target: CloudActionTargetDto) {
    const release = await this.prisma.pluginRelease.findFirst({
      where: {
        id: target.release_id,
        packageId: target.package_id,
        sha256: target.sha256,
        status: 'PUBLISHED',
        package: { ownerTeamId: teamId, governanceStatus: 'ACTIVE' },
      },
      select: { id: true },
    });
    if (!release) throw notFound('插件发行版不存在或不属于当前团队');
    const resolved = await this.actions.resolve({
      package_id: target.package_id,
      release_id: target.release_id,
      sha256: target.sha256,
      action_id: target.action_id,
      action_contract_version: target.action_contract_version,
      action_surface_sha256: target.action_surface_sha256,
    });
    if (resolved.action.cloud_capable !== true)
      throw new AppError(409, 'cloud_endpoint_target_mismatch', '指定 Action 未声明 Cloud 能力');
  }

  private async performChallenge(deployment: DeploymentRow) {
    const secret = this.cipher.decrypt(deployment.secretCiphertext, deployment.id);
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = randomBytes(18).toString('base64url');
    const challengeId = randomUUID();
    const target = this.targetOf(deployment);
    const body = Buffer.from(
      JSON.stringify({
        type: CLOUD_ENDPOINT_VERIFY_TYPE,
        challenge_id: challengeId,
        deployment_id: deployment.id,
        target,
      }),
      'utf8'
    );
    const url = this.http.validateUrl(deployment.endpointUrl);
    const signatureInput = {
      method: 'POST',
      canonicalPath: `${url.pathname}${url.search}`,
      timestamp,
      nonce,
      invocationId: challengeId,
      target: signatureTarget(deployment),
      deploymentId: deployment.id,
      body,
    };
    const response = await this.http.request({
      url: url.toString(),
      method: 'POST',
      headers: cloudRequestHeaders(signatureInput, secret),
      body,
      timeoutMs: deployment.timeoutMs,
      responseLimitBytes: Math.min(deployment.responseLimitBytes, 64 * 1024),
    });
    if (response.statusCode !== 200)
      throw new AppError(502, 'cloud_endpoint_unavailable', 'Cloud endpoint 验证失败');
    if (
      !(singleHeader(response.headers, 'content-type') ?? '')
        .toLowerCase()
        .startsWith('application/json')
    )
      throw new AppError(502, 'cloud_endpoint_response_invalid', 'Cloud endpoint 验证响应格式无效');
    const responseSignature = singleHeader(response.headers, CLOUD_RESPONSE_SIGNATURE_HEADER);
    if (
      !responseSignature ||
      !verifyCloudResponseSignature(
        {
          statusCode: response.statusCode,
          timestamp,
          nonce,
          invocationId: challengeId,
          deploymentId: deployment.id,
          body: response.body,
        },
        responseSignature,
        secret
      )
    ) {
      throw new AppError(502, 'cloud_endpoint_signature_invalid', 'Cloud endpoint 响应签名无效');
    }
    let payload: unknown;
    try {
      payload = JSON.parse(response.body.toString('utf8'));
    } catch {
      throw new AppError(502, 'cloud_endpoint_response_invalid', 'Cloud endpoint 验证响应格式无效');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      throw new AppError(502, 'cloud_endpoint_response_invalid', 'Cloud endpoint 验证响应无效');
    const value = payload as Record<string, unknown>;
    const parsedTarget = CloudActionDeploymentTarget.safeParse(value.target);
    if (
      value.type !== CLOUD_ENDPOINT_VERIFY_TYPE ||
      value.ok !== true ||
      value.challenge_id !== challengeId ||
      value.deployment_id !== deployment.id ||
      !parsedTarget.success ||
      JSON.stringify(parsedTarget.data) !== JSON.stringify(target)
    ) {
      throw new AppError(502, 'cloud_endpoint_response_invalid', 'Cloud endpoint 验证目标不匹配');
    }
  }

  private async audit(
    userId: string,
    action: string,
    targetId: string,
    metadata: Record<string, unknown>
  ) {
    await this.prisma.auditLog.create({
      data: {
        actorUserId: userId,
        action,
        targetType: 'CloudActionDeployment',
        targetId,
        metadata: metadata as Prisma.InputJsonValue,
      },
    });
  }
}
