import { Inject, Injectable, Optional } from '@nestjs/common';
import { ActionTarget } from '@lingfang/contract';
import { randomBytes } from 'node:crypto';
import { AppError, conflict, notFound } from '../common';
import { PrismaService } from '../prisma.service';
import { CloudEndpointSecretCipher } from './cloud-endpoint-secret-cipher';
import { SafeOutboundHttpClient } from './cloud-safe-http';
import {
  CLOUD_RESPONSE_SIGNATURE_HEADER,
  cloudRequestHeaders,
  verifyCloudResponseSignature,
} from './cloud-signature';
import { CloudExecutionQuotaService } from './cloud-execution-quota.service';

export const CLOUD_ACTION_INVOKE_TYPE = 'lingfang.cloud.action.invoke.v1';

function singleHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | null {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return typeof value === 'string' ? value : null;
}

@Injectable()
export class CloudActionGatewayService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CloudEndpointSecretCipher) private readonly cipher: CloudEndpointSecretCipher,
    @Inject(SafeOutboundHttpClient) private readonly http: SafeOutboundHttpClient,
    @Optional()
    @Inject(CloudExecutionQuotaService)
    private readonly quotas?: CloudExecutionQuotaService
  ) {}

  async invoke(invocationId: string, signal?: AbortSignal) {
    const invocation = await this.prisma.actionInvocation.findUnique({
      where: { id: invocationId },
      include: { cloudDeployment: true },
    });
    if (!invocation || invocation.status !== 'RUNNING')
      throw conflict('Cloud invocation 未处于可执行状态');
    const deployment = invocation.cloudDeployment;
    if (!deployment || deployment.status !== 'READY')
      throw new AppError(409, 'cloud_endpoint_not_ready', '冻结的 Cloud deployment 当前不可用');
    await this.quotas?.assertInvocationQuota(invocation);
    const releaseQuota = await this.quotas?.acquireEndpoint(deployment, invocation.id);
    try {
      const target = {
        package_id: invocation.packageId,
        release_id: invocation.releaseId,
        sha256: invocation.releaseSha256,
        action_id: invocation.actionId,
        action_contract_version: invocation.actionContractVersion,
        action_surface_sha256: invocation.actionSurfaceSha256,
      };
      if (
        deployment.packageId !== target.package_id ||
        deployment.releaseId !== target.release_id ||
        deployment.sha256 !== target.sha256 ||
        deployment.actionId !== target.action_id ||
        deployment.actionContractVersion !== target.action_contract_version ||
        deployment.actionSurfaceSha256 !== target.action_surface_sha256 ||
        deployment.environment !== invocation.cloudEnvironment
      ) {
        throw new AppError(
          409,
          'cloud_endpoint_target_mismatch',
          'Cloud deployment 与 invocation 精确目标不匹配'
        );
      }
      const secret = this.cipher.decrypt(deployment.secretCiphertext, deployment.id);
      const timestamp = Math.floor(Date.now() / 1000);
      const nonce = randomBytes(18).toString('base64url');
      const requestBody = Buffer.from(
        JSON.stringify({
          type: CLOUD_ACTION_INVOKE_TYPE,
          invocation_id: invocation.id,
          deployment_id: deployment.id,
          target,
          input: invocation.input,
        }),
        'utf8'
      );
      const url = this.http.validateUrl(deployment.endpointUrl);
      const signatureInput = {
        method: 'POST',
        canonicalPath: `${url.pathname}${url.search}`,
        timestamp,
        nonce,
        invocationId: invocation.id,
        effectIdempotencyKey: invocation.effectIdempotencyKey ?? undefined,
        target: {
          packageId: target.package_id,
          releaseId: target.release_id,
          sha256: target.sha256,
          actionId: target.action_id,
          actionContractVersion: target.action_contract_version,
          actionSurfaceSha256: target.action_surface_sha256,
        },
        deploymentId: deployment.id,
        body: requestBody,
      };
      const response = await this.http.request({
        url: url.toString(),
        method: 'POST',
        headers: cloudRequestHeaders(signatureInput, secret),
        body: requestBody,
        timeoutMs: deployment.timeoutMs,
        responseLimitBytes: deployment.responseLimitBytes,
        signal,
      });
      if (
        !(singleHeader(response.headers, 'content-type') ?? '')
          .toLowerCase()
          .startsWith('application/json')
      )
        throw new AppError(502, 'cloud_endpoint_response_invalid', 'Cloud endpoint 响应格式无效');
      const responseSignature = singleHeader(response.headers, CLOUD_RESPONSE_SIGNATURE_HEADER);
      if (
        !responseSignature ||
        !verifyCloudResponseSignature(
          {
            statusCode: response.statusCode,
            timestamp,
            nonce,
            invocationId: invocation.id,
            deploymentId: deployment.id,
            body: response.body,
          },
          responseSignature,
          secret
        )
      )
        throw new AppError(502, 'cloud_endpoint_signature_invalid', 'Cloud endpoint 响应签名无效');
      let payload: unknown;
      try {
        payload = JSON.parse(response.body.toString('utf8'));
      } catch {
        throw new AppError(502, 'cloud_endpoint_response_invalid', 'Cloud endpoint 响应格式无效');
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        throw new AppError(502, 'cloud_endpoint_response_invalid', 'Cloud endpoint 响应无效');
      const value = payload as Record<string, unknown>;
      const parsedTarget = ActionTarget.safeParse(value.target);
      if (
        value.type !== CLOUD_ACTION_INVOKE_TYPE ||
        value.invocation_id !== invocation.id ||
        value.deployment_id !== deployment.id ||
        !parsedTarget.success ||
        JSON.stringify(parsedTarget.data) !== JSON.stringify(target)
      )
        throw new AppError(502, 'cloud_endpoint_response_invalid', 'Cloud endpoint 响应目标不匹配');
      if (response.statusCode < 200 || response.statusCode >= 300 || value.ok !== true) {
        const code =
          typeof value.error_code === 'string' && /^[a-z0-9_]{1,128}$/.test(value.error_code)
            ? value.error_code
            : 'cloud_endpoint_failed';
        const message =
          typeof value.error_message === 'string'
            ? value.error_message.slice(0, 1000)
            : 'Cloud endpoint 执行失败';
        throw new AppError(502, code, message);
      }
      if (!value.output || typeof value.output !== 'object' || Array.isArray(value.output))
        throw new AppError(502, 'cloud_endpoint_response_invalid', 'Cloud endpoint output 无效');
      return {
        output: value.output as Record<string, unknown>,
        deployment_id: deployment.id,
        request_bytes: requestBody.length,
        response_bytes: response.body.length,
        endpoint_http_status: response.statusCode,
      };
    } finally {
      await releaseQuota?.();
    }
  }
}
