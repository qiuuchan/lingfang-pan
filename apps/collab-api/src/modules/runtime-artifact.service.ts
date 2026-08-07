import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppError, conflict, forbidden, notFound } from '../common';
import { PrismaService } from '../prisma.service';
import { AuthService } from './auth.service';
import {
  ARTIFACT_STORE,
  ArtifactUnavailableError,
  type ArtifactDownload,
  type ArtifactStore,
} from './artifact-store';

type Kind = 'STANDARD' | 'PREVIEW';
export type ArtifactRef = {
  type: 'artifact_ref';
  artifact_id: string;
  media_type: string;
  size_bytes: number;
  sha256: string;
  authorization: { scope: 'TEAM'; team_id: string; handle: string };
};
export type HandoffDestination = { kind: 'EDGE' | 'FINAL_OUTPUT'; id: string; scope?: unknown };
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object'
      ? `{${Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
          .join(',')}}`
      : JSON.stringify(value);
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const DAY_MS = 24 * 60 * 60 * 1000;
function configuredDays(name: string, fallback: number, min: number, max: number) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}
export function sharedArtifactRetentionCap(createdAt: Date) {
  return new Date(
    createdAt.getTime() +
      configuredDays('PLUGIN_SHARED_ARTIFACT_RETENTION_DAYS', 30, 1, 365) * DAY_MS
  );
}
export function sharedArtifactRenewalMs() {
  return configuredDays('PLUGIN_SHARED_ARTIFACT_RENEWAL_DAYS', 7, 1, 30) * DAY_MS;
}

@Injectable()
export class RuntimeArtifactService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(ARTIFACT_STORE) private readonly store: ArtifactStore
  ) {}
  async createForInvocation(
    invocationId: string,
    input: {
      objectKey: string;
      mediaType: string;
      sizeBytes: number;
      sha256: string;
      retainUntil: Date;
    }
  ) {
    if (
      !input.objectKey ||
      !input.mediaType ||
      !Number.isInteger(input.sizeBytes) ||
      input.sizeBytes < 0 ||
      input.sizeBytes > 300 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(input.sha256)
    )
      throw new AppError(400, 'action_artifact_invalid', '运行制品元数据无效');
    return this.prisma.$transaction(
      async (tx) => {
        const invocation = await tx.actionInvocation.findUnique({ where: { id: invocationId } });
        if (!invocation || invocation.status !== 'RUNNING')
          throw conflict('只有运行中的 Action 可以创建制品');
        const artifact = await tx.runtimeArtifact.create({
          data: {
            teamId: invocation.teamId,
            creatorInvocationId: invocation.id,
            executionKind: invocation.kind,
            objectKey: input.objectKey,
            mediaType: input.mediaType,
            sizeBytes: input.sizeBytes,
            sha256: input.sha256,
            retainUntil: input.retainUntil,
          },
        });
        await this.acquireGrantTx(
          tx,
          artifact.id,
          artifact.executionKind,
          'INVOCATION',
          invocation.id,
          digest({ invocation_id: invocation.id, purpose: 'OUTPUT' }),
          input.retainUntil
        );
        return this.toRef(artifact);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  }
  async createFromInvocation(
    userId: string,
    invocationId: string,
    input: { data_base64?: unknown; media_type?: unknown }
  ) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const invocation = await this.prisma.actionInvocation.findFirst({
      where: {
        id: invocationId,
        teamId: membership.teamId,
        principalUserId: userId,
        status: 'RUNNING',
        deadlineAt: { gt: new Date() },
      },
    });
    if (!invocation) throw forbidden('当前主体没有运行中 invocation 的制品写入权限');
    const mediaType = typeof input.media_type === 'string' ? input.media_type.trim() : '';
    const encoded = typeof input.data_base64 === 'string' ? input.data_base64.trim() : '';
    if (
      !mediaType ||
      mediaType.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(mediaType) ||
      !encoded ||
      encoded.length > 400 * 1024 * 1024 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
    )
      throw new AppError(400, 'action_artifact_invalid', '运行制品内容或 media_type 无效');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length > 300 * 1024 * 1024)
      throw new AppError(413, 'action_artifact_invalid', '运行制品不能超过 300 MiB');
    const artifactId = randomUUID();
    const objectKey = `runtime-artifacts/${membership.teamId}/${artifactId}`;
    const tempPath = join(tmpdir(), `lingfang-runtime-${artifactId}`);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const retainUntil = new Date(
      Math.max(
        invocation.deadlineAt.getTime(),
        Date.now() + (invocation.kind === 'PREVIEW' ? DAY_MS : 30 * DAY_MS)
      )
    );
    try {
      await writeFile(tempPath, bytes, { flag: 'wx' });
      await this.store.promote(tempPath, objectKey, sha256);
      return await this.createForInvocation(invocationId, {
        objectKey,
        mediaType,
        sizeBytes: bytes.length,
        sha256,
        retainUntil,
      });
    } catch (error) {
      await this.store.delete(objectKey).catch(() => undefined);
      throw error;
    } finally {
      await rm(tempPath, { force: true });
    }
  }
  async materializeForInvocation(userId: string, invocationId: string, ref: ArtifactRef) {
    const { artifact } = await this.resolveForInvocation(userId, invocationId, ref);
    const bytes = await this.downloadBytes(artifact.objectKey, 300 * 1024 * 1024);
    if (
      bytes.length !== artifact.sizeBytes ||
      createHash('sha256').update(bytes).digest('hex') !== artifact.sha256
    )
      throw new AppError(410, 'action_artifact_invalid', '运行制品对象已损坏或不完整');
    return {
      data_base64: bytes.toString('base64'),
      media_type: artifact.mediaType,
      size_bytes: artifact.sizeBytes,
      sha256: artifact.sha256,
    };
  }
  async importForInvocation(userId: string, invocationId: string, ref: ArtifactRef) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const invocation = await this.prisma.actionInvocation.findFirst({
      where: {
        id: invocationId,
        teamId: membership.teamId,
        principalUserId: userId,
        kind: 'STANDARD',
        status: 'RUNNING',
        deadlineAt: { gt: new Date() },
      },
    });
    if (!invocation || ref.authorization.team_id !== membership.teamId || !this.verifyRef(ref))
      throw forbidden('只有运行中的 STANDARD invocation 可以导入 preview 制品');
    const source = await this.prisma.runtimeArtifact.findFirst({
      where: {
        id: ref.artifact_id,
        teamId: membership.teamId,
        executionKind: 'PREVIEW',
        status: 'ACTIVE',
      },
    });
    if (
      !source ||
      source.sha256 !== ref.sha256 ||
      source.mediaType !== ref.media_type ||
      source.sizeBytes !== ref.size_bytes
    )
      throw forbidden('Preview ArtifactRef 与制品元数据不匹配');
    await this.resolvePrincipalSourceGrant(
      this.prisma,
      source.id,
      'PREVIEW',
      userId,
      membership.teamId
    );
    const bytes = await this.downloadBytes(source.objectKey, 300 * 1024 * 1024);
    if (
      bytes.length !== source.sizeBytes ||
      createHash('sha256').update(bytes).digest('hex') !== source.sha256
    )
      throw new AppError(410, 'action_artifact_invalid', 'Preview 制品对象已损坏或不完整');
    return this.createFromInvocation(userId, invocationId, {
      data_base64: bytes.toString('base64'),
      media_type: source.mediaType,
    });
  }
  async grantInvocation(
    artifactId: string,
    kind: Kind,
    invocationId: string,
    scope: unknown,
    expiresAt: Date
  ) {
    return this.prisma.$transaction(
      (tx) =>
        this.acquireGrantTx(
          tx,
          artifactId,
          kind,
          'INVOCATION',
          invocationId,
          digest(scope),
          expiresAt
        ),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  }
  async workflowInputAuthorizationDigest(input: {
    teamId: string;
    principalUserId: string;
    kind: Kind;
    value: unknown;
  }) {
    const identities = [] as Array<{
      pointer: string;
      artifact_id: string;
      source_grant_id: string;
      source_scope_digest: string;
    }>;
    for (const item of collectArtifactRefs(input.value)) {
      if (item.ref.authorization.team_id !== input.teamId || !this.verifyRef(item.ref))
        throw forbidden('工作流输入 ArtifactRef 无效或已被篡改');
      const artifact = await this.prisma.runtimeArtifact.findFirst({
        where: {
          id: item.ref.artifact_id,
          teamId: input.teamId,
          executionKind: input.kind,
          status: 'ACTIVE',
        },
      });
      if (
        !artifact ||
        artifact.sha256 !== item.ref.sha256 ||
        artifact.mediaType !== item.ref.media_type ||
        artifact.sizeBytes !== item.ref.size_bytes
      )
        throw forbidden('工作流输入 ArtifactRef 与制品元数据不匹配');
      const source = await this.resolvePrincipalSourceGrant(
        this.prisma,
        artifact.id,
        input.kind,
        input.principalUserId,
        input.teamId
      );
      identities.push({
        pointer: item.pointer,
        artifact_id: artifact.id,
        source_grant_id: source.id,
        source_scope_digest: source.scopeDigest,
      });
    }
    return digest(identities);
  }
  async bindWorkflowInputsTx(
    tx: Prisma.TransactionClient,
    input: {
      runId: string;
      teamId: string;
      principalUserId: string;
      kind: Kind;
      value: unknown;
      retainUntil: Date;
    }
  ) {
    const refs = collectArtifactRefs(input.value);
    for (const item of refs) {
      if (item.ref.authorization.team_id !== input.teamId || !this.verifyRef(item.ref))
        throw forbidden('工作流输入 ArtifactRef 无效或已被篡改');
      const artifact = await tx.runtimeArtifact.findFirst({
        where: {
          id: item.ref.artifact_id,
          teamId: input.teamId,
          executionKind: input.kind,
          status: 'ACTIVE',
        },
      });
      if (
        !artifact ||
        artifact.sha256 !== item.ref.sha256 ||
        artifact.mediaType !== item.ref.media_type ||
        artifact.sizeBytes !== item.ref.size_bytes
      )
        throw forbidden('工作流输入 ArtifactRef 与制品元数据不匹配');
      const source = await this.resolvePrincipalSourceGrant(
        tx,
        artifact.id,
        input.kind,
        input.principalUserId,
        input.teamId
      );
      const scope = {
        run_id: input.runId,
        purpose: 'RUN_INPUT',
        json_pointer: item.pointer,
        source_grant_id: source.id,
      };
      await this.acquireGrantTx(
        tx,
        artifact.id,
        input.kind,
        'WORKFLOW_RUN',
        input.runId,
        digest(scope),
        input.retainUntil
      );
      await this.acquireHoldTx(
        tx,
        artifact.id,
        input.kind,
        'WORKFLOW_RUN',
        `${input.runId}:RUN_INPUT:${item.pointer || '/'}`,
        'RUN_INPUT',
        digest(scope),
        input.retainUntil
      );
    }
    return refs.length;
  }

  async grantFinalOutputsTx(
    tx: Prisma.TransactionClient,
    input: { runId: string; teamId: string; kind: Kind; output: unknown; expiresAt: Date }
  ) {
    const refs = collectArtifactRefs(input.output);
    for (const item of refs) {
      const artifact = await tx.runtimeArtifact.findFirst({
        where: {
          id: item.ref.artifact_id,
          teamId: input.teamId,
          executionKind: input.kind,
          status: 'ACTIVE',
        },
      });
      if (!artifact || !this.verifyRef(item.ref) || artifact.sha256 !== item.ref.sha256)
        throw forbidden('工作流最终输出 ArtifactRef 无效');
      await this.acquireGrantTx(
        tx,
        artifact.id,
        input.kind,
        'WORKFLOW_RUN',
        `${input.runId}:FINAL_OUTPUT`,
        digest({ run_id: input.runId, purpose: 'FINAL_OUTPUT', json_pointer: item.pointer }),
        input.expiresAt
      );
      await this.acquireHoldTx(
        tx,
        artifact.id,
        input.kind,
        'WORKFLOW_RUN',
        `${input.runId}:FINAL_OUTPUT:${item.pointer || '/'}`,
        'FINAL_OUTPUT',
        digest({ run_id: input.runId, json_pointer: item.pointer }),
        input.expiresAt
      );
    }
    return refs.length;
  }

  async authorizeWorkflowResult(userId: string, runId: string, artifactId: string) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const run = await this.prisma.workflowRun.findFirst({
      where: { id: runId, teamId: membership.teamId, status: 'SUCCEEDED' },
    });
    if (!run) throw notFound('工作流结果不存在');
    if (run.principalUserId !== userId && membership.role !== 'TEAM_ADMIN')
      throw forbidden('无权读取该工作流结果');
    if (run.resultRetainUntil <= new Date())
      throw new AppError(410, 'workflow_result_expired', '工作流结果保留期已结束');
    const kind: Kind = run.executionScope === 'PREVIEW' ? 'PREVIEW' : 'STANDARD';
    const artifact = await this.prisma.runtimeArtifact.findFirst({
      where: { id: artifactId, teamId: membership.teamId, executionKind: kind, status: 'ACTIVE' },
    });
    const grant =
      artifact &&
      (await this.prisma.runtimeArtifactGrant.findFirst({
        where: {
          artifactId,
          executionKind: kind,
          targetKind: 'WORKFLOW_RUN',
          targetId: `${runId}:FINAL_OUTPUT`,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
      }));
    if (!artifact || !grant)
      throw new AppError(410, 'workflow_result_expired', '工作流结果授权已失效');
    return { run, artifact, download: await this.download(artifact.objectKey) };
  }

  async importPreviewResult(userId: string, runId: string, artifactId: string) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    const run = await this.prisma.workflowRun.findFirst({
      where: {
        id: runId,
        teamId: membership.teamId,
        principalUserId: userId,
        executionScope: 'PREVIEW',
        status: 'SUCCEEDED',
      },
    });
    if (!run || run.resultRetainUntil <= new Date())
      throw new AppError(410, 'workflow_result_expired', 'Preview 结果不存在或已过期');
    const source = await this.prisma.runtimeArtifact.findFirst({
      where: {
        id: artifactId,
        teamId: membership.teamId,
        executionKind: 'PREVIEW',
        status: 'ACTIVE',
      },
    });
    const grant =
      source &&
      (await this.prisma.runtimeArtifactGrant.findFirst({
        where: {
          artifactId,
          executionKind: 'PREVIEW',
          targetKind: 'WORKFLOW_RUN',
          targetId: `${runId}:FINAL_OUTPUT`,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
      }));
    if (!source || !grant) throw forbidden('Preview 结果没有可导入授权');
    const newId = randomUUID();
    const objectKey = `runtime-artifacts/${membership.teamId}/${newId}`;
    const tempPath = join(tmpdir(), `lingfang-import-${newId}`);
    try {
      const downloaded = await this.download(source.objectKey);
      if (downloaded.kind !== 'stream')
        throw new AppError(503, 'artifact_import_unavailable', '当前存储后端不支持安全服务端导入');
      await pipeline(downloaded.stream, createWriteStream(tempPath, { flags: 'wx' }));
      await this.store.promote(tempPath, objectKey, source.sha256);
      return await this.prisma.$transaction(
        async (tx) => {
          const artifact = await tx.runtimeArtifact.create({
            data: {
              id: newId,
              teamId: membership.teamId,
              creatorInvocationId: null,
              executionKind: 'STANDARD',
              objectKey,
              mediaType: source.mediaType,
              sizeBytes: source.sizeBytes,
              sha256: source.sha256,
              retainUntil: new Date(Date.now() + 30 * DAY_MS),
            },
          });
          await this.acquireGrantTx(
            tx,
            artifact.id,
            'STANDARD',
            'PRINCIPAL_IMPORT',
            userId,
            digest({
              source_run_id: runId,
              source_artifact_id: source.id,
              purpose: 'PRINCIPAL_IMPORT',
            }),
            artifact.retainUntil
          );
          await tx.auditLog.create({
            data: {
              actorUserId: userId,
              action: 'workflow.preview_result.imported',
              targetType: 'RuntimeArtifact',
              targetId: artifact.id,
              metadata: {
                teamId: membership.teamId,
                sourceRunId: runId,
                sourceArtifactId: source.id,
                sha256: source.sha256,
              },
            },
          });
          return { artifact_ref: this.toRef(artifact) };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );
    } catch (error) {
      await this.store.delete(objectKey).catch(() => undefined);
      if (error instanceof ArtifactUnavailableError)
        throw new AppError(410, 'workflow_result_expired', 'Preview 结果对象已被清理');
      throw error;
    } finally {
      await rm(tempPath, { force: true });
    }
  }

  private async download(objectKey: string): Promise<ArtifactDownload> {
    return this.store.download(objectKey);
  }
  private async downloadBytes(objectKey: string, maxBytes: number): Promise<Buffer> {
    const download = await this.download(objectKey);
    if (download.kind === 'stream' && download.sizeBytes > maxBytes)
      throw new AppError(413, 'action_artifact_invalid', '运行制品超过 materialize 上限');
    if (download.kind === 'redirect') {
      const response = await fetch(download.url, {
        redirect: 'error',
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok)
        throw new ArtifactUnavailableError(`artifact redirect failed: ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > maxBytes)
        throw new AppError(413, 'action_artifact_invalid', '运行制品超过 materialize 上限');
      return bytes;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of download.stream as AsyncIterable<Buffer | string>) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes)
        throw new AppError(413, 'action_artifact_invalid', '运行制品超过 materialize 上限');
      chunks.push(bytes);
    }
    return Buffer.concat(chunks, size);
  }
  private async resolvePrincipalSourceGrant(
    tx: Pick<Prisma.TransactionClient, 'runtimeArtifactGrant' | 'actionInvocation' | 'workflowRun'>,
    artifactId: string,
    kind: Kind,
    principalUserId: string,
    teamId: string
  ) {
    const candidates = await tx.runtimeArtifactGrant.findMany({
      where: {
        artifactId,
        executionKind: kind,
        revokedAt: null,
        expiresAt: { gt: new Date() },
        OR: [
          { targetKind: 'INVOCATION' },
          { targetKind: 'WORKFLOW_RUN' },
          { targetKind: 'PRINCIPAL_IMPORT', targetId: principalUserId },
        ],
      },
      orderBy: [{ expiresAt: 'desc' }, { id: 'asc' }],
      take: 100,
    });
    for (const candidate of candidates) {
      try {
        await this.assertPrincipalOwnsSource(tx, candidate, principalUserId, teamId);
        return candidate;
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== 'forbidden') throw error;
      }
    }
    throw forbidden('当前主体没有该工作流输入制品的有效源授权');
  }
  private async assertPrincipalOwnsSource(
    tx: Pick<Prisma.TransactionClient, 'actionInvocation' | 'workflowRun'>,
    source: { targetKind: string; targetId: string },
    principalUserId: string,
    teamId: string
  ) {
    if (source.targetKind === 'PRINCIPAL_IMPORT') {
      if (source.targetId !== principalUserId) throw forbidden('当前主体没有该导入制品的源授权');
      return;
    }
    if (source.targetKind === 'INVOCATION') {
      const invocation = await tx.actionInvocation.findFirst({
        where: { id: source.targetId, teamId, principalUserId },
      });
      if (!invocation) throw forbidden('当前主体不是源 invocation 的发起人');
      return;
    }
    if (source.targetKind === 'WORKFLOW_RUN') {
      const runId = source.targetId.endsWith(':FINAL_OUTPUT')
        ? source.targetId.slice(0, -':FINAL_OUTPUT'.length)
        : source.targetId;
      const run = await tx.workflowRun.findFirst({
        where: { id: runId, teamId, principalUserId, status: 'SUCCEEDED' },
      });
      if (!run) throw forbidden('当前主体不是源 workflow run 的发起人');
      return;
    }
    throw forbidden('不支持的工作流输入源授权');
  }
  async acquireHold(
    artifactId: string,
    kind: Kind,
    holderKind: string,
    holderId: string,
    purpose: string,
    scope: unknown,
    retainUntil: Date
  ) {
    const scopeDigest = digest(scope);
    return this.prisma.$transaction(
      (tx) =>
        this.acquireHoldTx(
          tx,
          artifactId,
          kind,
          holderKind,
          holderId,
          purpose,
          scopeDigest,
          retainUntil
        ),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  }
  /**
   * Pin every ArtifactRef emitted by a workflow-linked invocation before the
   * invocation becomes visible as SUCCEEDED.  The hold deliberately carries
   * no read authority; it only protects the object from TTL cleanup while the
   * workflow coordinator projects the frozen mapping.
   */
  async acquireHandoffPendingTx(
    tx: Prisma.TransactionClient,
    input: {
      invocationId: string;
      runId: string;
      attemptId: string;
      output: unknown;
      retainUntil: Date;
    }
  ) {
    const invocation = await tx.actionInvocation.findUnique({ where: { id: input.invocationId } });
    if (!invocation) throw notFound('Action invocation 不存在');
    if (invocation.status !== 'RUNNING')
      throw conflict('只有运行中的 Action invocation 可以建立 handoff hold');
    const refs = collectArtifactRefs(input.output);
    for (const item of refs) {
      await this.assertOutputRefTx(tx, invocation, item.ref);
      await this.acquireHoldTx(
        tx,
        item.ref.artifact_id,
        invocation.kind as Kind,
        'WORKFLOW_RUN',
        `${input.runId}:${input.attemptId}`,
        'HANDOFF_PENDING',
        digest({
          run_id: input.runId,
          attempt_id: input.attemptId,
          artifact_id: item.ref.artifact_id,
          json_pointer: item.pointer,
        }),
        input.retainUntil
      );
    }
    return refs.length;
  }

  /** Convert HANDOFF_PENDING rows after a frozen workflow mapping is known. */
  async convertHandoffPending(
    runId: string,
    attemptId: string,
    destinations: HandoffDestination[],
    retainUntil: Date
  ) {
    return this.prisma.$transaction(
      (tx) => this.convertHandoffPendingTx(tx, runId, attemptId, destinations, retainUntil),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  }

  async convertHandoffPendingTx(
    tx: Prisma.TransactionClient,
    runId: string,
    attemptId: string,
    destinations: HandoffDestination[],
    retainUntil: Date
  ) {
    const pending = await tx.runtimeArtifactHold.findMany({
      where: {
        holderKind: 'WORKFLOW_RUN',
        holderId: `${runId}:${attemptId}`,
        purpose: 'HANDOFF_PENDING',
        releasedAt: null,
      },
    });
    const now = new Date();
    for (const source of pending) {
      const targetRows = destinations.length
        ? destinations
        : [
            {
              kind: 'FINAL_OUTPUT' as const,
              id: `${runId}:FINAL_OUTPUT`,
              scope: { run_id: runId, attempt_id: attemptId },
            },
          ];
      for (const destination of targetRows) {
        await this.acquireHoldTx(
          tx,
          source.artifactId,
          source.executionKind as Kind,
          'WORKFLOW_RUN',
          destination.id,
          destination.kind,
          digest({
            ...(destination.scope && typeof destination.scope === 'object'
              ? destination.scope
              : {}),
            run_id: runId,
            attempt_id: attemptId,
            source_artifact_id: source.artifactId,
          }),
          retainUntil
        );
      }
      await tx.runtimeArtifactHold.updateMany({
        where: { id: source.id, releasedAt: null },
        data: { releasedAt: now },
      });
    }
    return { converted: pending.length };
  }

  /**
   * Crash recovery for the window after invocation terminal commit and before
   * workflow-step projection.  Repeating this method is safe: released
   * HANDOFF_PENDING rows are never reopened and destination holder keys are
   * canonical/upserted.
   */
  async reconcileHandoffPending(limit = 100) {
    const pending = await this.prisma.runtimeArtifactHold.findMany({
      where: {
        holderKind: 'WORKFLOW_RUN',
        purpose: 'HANDOFF_PENDING',
        releasedAt: null,
        retainUntil: { gt: new Date() },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: Math.max(1, Math.min(limit, 500)),
    });
    let converted = 0;
    let released = 0;
    for (const hold of pending) {
      const split = hold.holderId.lastIndexOf(':');
      if (split <= 0) {
        await this.releaseHold(hold.id).catch(() => undefined);
        released += 1;
        continue;
      }
      const runId = hold.holderId.slice(0, split);
      const attemptId = hold.holderId.slice(split + 1);
      const attempt = await this.prisma.workflowStepAttempt.findUnique({
        where: { id: attemptId },
        include: { run: true },
      });
      if (!attempt) {
        await this.releaseHold(hold.id).catch(() => undefined);
        released += 1;
        continue;
      }
      if (['FAILED', 'CANCELED'].includes(attempt.run.status)) {
        await this.releaseHold(hold.id).catch(() => undefined);
        released += 1;
      } else if (attempt.status === 'SUCCEEDED') {
        const plan = (attempt.run.frozenPlan || {}) as {
          nodes?: Array<{ node_id: string; depends_on?: string[] }>;
        };
        const children = (plan.nodes || []).filter((node) =>
          (node.depends_on || []).includes(attempt.nodeId)
        );
        const destinations: HandoffDestination[] = children.length
          ? children.map((node) => ({
              kind: 'EDGE' as const,
              id: `${runId}:${attemptId}:${node.node_id}`,
              scope: { target_node_id: node.node_id },
            }))
          : [
              {
                kind: 'FINAL_OUTPUT' as const,
                id: `${runId}:FINAL_OUTPUT`,
                scope: { run_id: runId, attempt_id: attemptId },
              },
            ];
        const result = await this.convertHandoffPending(
          runId,
          attemptId,
          destinations,
          attempt.run.resultRetainUntil
        );
        converted += result.converted;
        if (attempt.run.status === 'SUCCEEDED')
          await this.prisma.$transaction((tx) => this.releaseRunHoldsTx(tx, runId, true), {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          });
      } else if (['FAILED', 'CANCELED', 'SKIPPED'].includes(attempt.status)) {
        await this.releaseHold(hold.id).catch(() => undefined);
        released += 1;
      }
    }
    return { converted, released };
  }

  /** Release run-scoped transient holds when a run reaches a terminal state. */
  async releaseRunHoldsTx(tx: Prisma.TransactionClient, runId: string, preserveFinalOutput = true) {
    const purposes = preserveFinalOutput
      ? ['RUN_INPUT', 'EDGE', 'HANDOFF_PENDING']
      : ['RUN_INPUT', 'EDGE', 'HANDOFF_PENDING', 'FINAL_OUTPUT'];
    return tx.runtimeArtifactHold.updateMany({
      where: {
        holderKind: 'WORKFLOW_RUN',
        holderId: { startsWith: `${runId}:` },
        purpose: { in: purposes },
        releasedAt: null,
      },
      data: { releasedAt: new Date() },
    });
  }
  async releaseHold(id: string) {
    const result = await this.prisma.runtimeArtifactHold.updateMany({
      where: { id, releasedAt: null },
      data: { releasedAt: new Date() },
    });
    if (result.count !== 1) throw conflict('制品 hold 已释放');
    return { ok: true };
  }
  async resolveForInvocation(userId: string, invocationId: string, ref: ArtifactRef) {
    const membership = await this.auth.ensureCurrentTeam(userId);
    if (ref.authorization.team_id !== membership.teamId || !this.verifyRef(ref))
      throw forbidden('ArtifactRef 无效或已被篡改');
    const invocation = await this.prisma.actionInvocation.findFirst({
      where: {
        id: invocationId,
        teamId: membership.teamId,
        principalUserId: userId,
        status: 'RUNNING',
        deadlineAt: { gt: new Date() },
      },
    });
    if (!invocation) throw notFound('运行中的 Action invocation 不存在或不属于当前主体');
    const artifact = await this.prisma.runtimeArtifact.findFirst({
      where: {
        id: ref.artifact_id,
        teamId: membership.teamId,
        executionKind: invocation.kind,
        status: 'ACTIVE',
      },
    });
    if (
      !artifact ||
      artifact.sha256 !== ref.sha256 ||
      artifact.mediaType !== ref.media_type ||
      artifact.sizeBytes !== ref.size_bytes
    )
      throw forbidden('ArtifactRef 与制品元数据不匹配');
    const grant = await this.prisma.runtimeArtifactGrant.findFirst({
      where: {
        artifactId: artifact.id,
        executionKind: invocation.kind,
        targetKind: 'INVOCATION',
        targetId: invocation.id,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
    if (!grant) throw forbidden('当前 invocation 没有该制品的读取授权');
    return { artifact, grant };
  }
  toRef(artifact: {
    id: string;
    teamId: string;
    mediaType: string;
    sizeBytes: number;
    sha256: string;
  }): ArtifactRef {
    const unsigned = {
      type: 'artifact_ref' as const,
      artifact_id: artifact.id,
      media_type: artifact.mediaType,
      size_bytes: artifact.sizeBytes,
      sha256: artifact.sha256,
      authorization: { scope: 'TEAM' as const, team_id: artifact.teamId },
    };
    return {
      ...unsigned,
      authorization: { ...unsigned.authorization, handle: this.sign(unsigned) },
    };
  }
  async bindSharedValueTx(
    tx: Prisma.TransactionClient,
    invocationId: string,
    ref: ArtifactRef,
    targetId: string,
    scope: unknown,
    retainUntil: Date
  ) {
    const invocation = await tx.actionInvocation.findUnique({ where: { id: invocationId } });
    if (!invocation || invocation.kind !== 'STANDARD' || invocation.status !== 'RUNNING')
      throw forbidden('只有运行中的 STANDARD invocation 可以写入共享 ArtifactRef');
    if (ref.authorization.team_id !== invocation.teamId || !this.verifyRef(ref))
      throw forbidden('ArtifactRef 无效或已被篡改');
    const artifact = await tx.runtimeArtifact.findFirst({
      where: {
        id: ref.artifact_id,
        teamId: invocation.teamId,
        executionKind: 'STANDARD',
        status: 'ACTIVE',
      },
    });
    if (
      !artifact ||
      artifact.sha256 !== ref.sha256 ||
      artifact.mediaType !== ref.media_type ||
      artifact.sizeBytes !== ref.size_bytes
    )
      throw forbidden('ArtifactRef 与制品元数据不匹配');
    const cappedRetainUntil = new Date(
      Math.min(retainUntil.getTime(), sharedArtifactRetentionCap(artifact.createdAt).getTime())
    );
    if (cappedRetainUntil <= new Date())
      throw new AppError(
        410,
        'shared_artifact_expired',
        '共享 ArtifactRef 已超过平台保留上限，必须写入新 revision'
      );
    const source = await tx.runtimeArtifactGrant.findFirst({
      where: {
        artifactId: artifact.id,
        executionKind: 'STANDARD',
        targetKind: 'INVOCATION',
        targetId: invocation.id,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
    if (!source) throw forbidden('当前 invocation 没有该制品的源授权');
    const scopeDigest = digest(scope);
    const grant = await this.acquireGrantTx(
      tx,
      artifact.id,
      'STANDARD',
      'SHARED_VALUE',
      targetId,
      scopeDigest,
      cappedRetainUntil
    );
    const holderKey = digest({
      holderKind: 'SHARED_VALUE',
      holderId: targetId,
      purpose: 'SHARED_VALUE',
      scopeDigest,
      kind: 'STANDARD',
    });
    const existingHold = await tx.runtimeArtifactHold.findUnique({
      where: {
        artifactId_executionKind_holderKey: {
          artifactId: artifact.id,
          executionKind: 'STANDARD',
          holderKey,
        },
      },
    });
    if (existingHold) {
      if (existingHold.releasedAt || existingHold.retainUntil <= new Date())
        throw conflict('已释放的共享制品 hold 不可重新打开');
      if (cappedRetainUntil > existingHold.retainUntil)
        await tx.runtimeArtifactHold.update({
          where: { id: existingHold.id },
          data: { retainUntil: cappedRetainUntil },
        });
    } else {
      await tx.runtimeArtifactHold.create({
        data: {
          artifactId: artifact.id,
          executionKind: 'STANDARD',
          holderKind: 'SHARED_VALUE',
          holderId: targetId,
          purpose: 'SHARED_VALUE',
          scopeDigest,
          holderKey,
          retainUntil: cappedRetainUntil,
        },
      });
    }
    return { artifact, grant };
  }
  async exchangeSharedValueTx(
    tx: Prisma.TransactionClient,
    invocationId: string,
    artifactId: string,
    sharedTargetId: string,
    scope: unknown,
    expiresAt: Date
  ) {
    const invocation = await tx.actionInvocation.findUnique({ where: { id: invocationId } });
    if (!invocation || invocation.kind !== 'STANDARD' || invocation.status !== 'RUNNING')
      throw forbidden('共享 ArtifactRef 只允许运行中的 STANDARD invocation 读取');
    const scopeDigest = digest(scope);
    const shared = await tx.runtimeArtifactGrant.findFirst({
      where: {
        artifactId,
        executionKind: 'STANDARD',
        targetKind: 'SHARED_VALUE',
        targetId: sharedTargetId,
        scopeDigest,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
    const hold = await tx.runtimeArtifactHold.findFirst({
      where: {
        artifactId,
        executionKind: 'STANDARD',
        holderKind: 'SHARED_VALUE',
        holderId: sharedTargetId,
        purpose: 'SHARED_VALUE',
        scopeDigest,
        releasedAt: null,
        retainUntil: { gt: new Date() },
      },
    });
    if (!shared || !hold)
      throw new AppError(410, 'shared_artifact_expired', '共享 ArtifactRef 授权或保留期已过期');
    return this.acquireGrantTx(
      tx,
      artifactId,
      'STANDARD',
      'INVOCATION',
      invocation.id,
      digest({ shared_target_id: sharedTargetId, scope_digest: scopeDigest }),
      expiresAt
    );
  }
  async releaseSharedValueTx(tx: Prisma.TransactionClient, sharedTargetId: string) {
    const now = new Date();
    await tx.runtimeArtifactGrant.updateMany({
      where: {
        executionKind: 'STANDARD',
        targetKind: 'SHARED_VALUE',
        targetId: sharedTargetId,
        revokedAt: null,
      },
      data: { revokedAt: now },
    });
    await tx.runtimeArtifactHold.updateMany({
      where: {
        executionKind: 'STANDARD',
        holderKind: 'SHARED_VALUE',
        holderId: sharedTargetId,
        releasedAt: null,
      },
      data: { releasedAt: now },
    });
  }
  /** Repair canonical rows only for a live edge already verified by SharedStateService. */
  async reconcileSharedValueTx(
    tx: Prisma.TransactionClient,
    artifactId: string,
    sharedTargetId: string,
    scope: unknown,
    retainUntil: Date
  ) {
    const artifact = await this.assertArtifact(tx, artifactId, 'STANDARD');
    const now = new Date();
    if (retainUntil <= now)
      throw new AppError(410, 'shared_artifact_expired', '共享 ArtifactRef 已超过平台保留上限');
    const scopeDigest = digest(scope);
    const grant = await this.acquireGrantTx(
      tx,
      artifactId,
      'STANDARD',
      'SHARED_VALUE',
      sharedTargetId,
      scopeDigest,
      retainUntil
    );
    const hold = await this.acquireHoldTx(
      tx,
      artifactId,
      'STANDARD',
      'SHARED_VALUE',
      sharedTargetId,
      'SHARED_VALUE',
      scopeDigest,
      retainUntil
    );
    if (artifact.retainUntil < retainUntil) {
      await tx.runtimeArtifact.updateMany({
        where: {
          id: artifactId,
          executionKind: 'STANDARD',
          status: 'ACTIVE',
          retainUntil: { lt: retainUntil },
        },
        data: { retainUntil },
      });
    }
    return { grant, hold };
  }
  private async acquireHoldTx(
    tx: Prisma.TransactionClient,
    artifactId: string,
    kind: Kind,
    holderKind: string,
    holderId: string,
    purpose: string,
    scopeDigest: string,
    retainUntil: Date
  ) {
    await this.assertArtifact(tx, artifactId, kind);
    const holderKey = digest({ holderKind, holderId, purpose, scopeDigest, kind });
    const existing = await tx.runtimeArtifactHold.findUnique({
      where: { artifactId_executionKind_holderKey: { artifactId, executionKind: kind, holderKey } },
    });
    const now = new Date();
    if (existing) {
      if (existing.releasedAt || existing.retainUntil <= now)
        throw conflict('已释放或过期的制品 hold 不可重新打开');
      if (retainUntil <= existing.retainUntil) return existing;
      return tx.runtimeArtifactHold.update({ where: { id: existing.id }, data: { retainUntil } });
    }
    return tx.runtimeArtifactHold.create({
      data: {
        artifactId,
        executionKind: kind,
        holderKind,
        holderId,
        purpose,
        scopeDigest,
        holderKey,
        retainUntil,
      },
    });
  }
  private async acquireGrantTx(
    tx: Prisma.TransactionClient,
    artifactId: string,
    kind: Kind,
    targetKind: 'INVOCATION' | 'SHARED_VALUE' | 'WORKFLOW_RUN' | 'PRINCIPAL_IMPORT',
    targetId: string,
    scopeDigest: string,
    expiresAt: Date
  ) {
    await this.assertArtifact(tx, artifactId, kind);
    const subjectKey = digest({ targetKind, targetId, scopeDigest, kind });
    const existing = await tx.runtimeArtifactGrant.findUnique({
      where: {
        artifactId_executionKind_subjectKey: { artifactId, executionKind: kind, subjectKey },
      },
    });
    const now = new Date();
    if (existing) {
      if (existing.revokedAt || existing.expiresAt <= now)
        throw conflict('已撤销或过期的制品 grant 不可重新打开');
      if (expiresAt <= existing.expiresAt) return existing;
      return tx.runtimeArtifactGrant.update({ where: { id: existing.id }, data: { expiresAt } });
    }
    return tx.runtimeArtifactGrant.create({
      data: {
        artifactId,
        executionKind: kind,
        targetKind,
        targetId,
        scopeDigest,
        subjectKey,
        expiresAt,
      },
    });
  }
  private async assertOutputRefTx(
    tx: Prisma.TransactionClient,
    invocation: { id: string; teamId: string; kind: Kind },
    ref: ArtifactRef
  ) {
    if (ref.authorization?.team_id !== invocation.teamId || !this.verifyRef(ref))
      throw forbidden('Action 输出中的 ArtifactRef 无效或已被篡改');
    const artifact = await tx.runtimeArtifact.findFirst({
      where: {
        id: ref.artifact_id,
        teamId: invocation.teamId,
        executionKind: invocation.kind,
        status: 'ACTIVE',
      },
    });
    if (
      !artifact ||
      artifact.sha256 !== ref.sha256 ||
      artifact.mediaType !== ref.media_type ||
      artifact.sizeBytes !== ref.size_bytes
    )
      throw forbidden('Action 输出中的 ArtifactRef 与制品元数据不匹配');
    const source = await tx.runtimeArtifactGrant.findFirst({
      where: {
        artifactId: artifact.id,
        executionKind: invocation.kind,
        targetKind: 'INVOCATION',
        targetId: invocation.id,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
    if (!source) throw forbidden('Action 输出中的 ArtifactRef 没有 invocation 源授权');
    return artifact;
  }
  private async assertArtifact(tx: Prisma.TransactionClient, id: string, kind: Kind) {
    const artifact = await tx.runtimeArtifact.findUnique({
      where: { id_executionKind: { id, executionKind: kind } },
    });
    if (!artifact || artifact.status !== 'ACTIVE') throw notFound('运行制品不存在');
    return artifact;
  }
  private secret() {
    const secret = process.env.RUNTIME_ARTIFACT_SIGNING_SECRET;
    if (!secret || secret.length < 32)
      throw new AppError(500, 'artifact_signing_unavailable', '运行制品签名服务未配置');
    return secret;
  }
  private sign(value: unknown) {
    return createHmac('sha256', this.secret()).update(canonical(value)).digest('base64url');
  }
  private verifyRef(ref: ArtifactRef) {
    try {
      const unsigned = {
        ...ref,
        authorization: { scope: ref.authorization.scope, team_id: ref.authorization.team_id },
      };
      const expected = Buffer.from(this.sign(unsigned));
      const actual = Buffer.from(ref.authorization.handle);
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    } catch {
      return false;
    }
  }
}

type ArtifactRefAtPointer = { ref: ArtifactRef; pointer: string };
function collectArtifactRefs(value: unknown, pointer = ''): ArtifactRefAtPointer[] {
  if (Array.isArray(value))
    return value.flatMap((item, index) => collectArtifactRefs(item, `${pointer}/${index}`));
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  if (
    record.type === 'artifact_ref' &&
    typeof record.artifact_id === 'string' &&
    typeof record.media_type === 'string' &&
    typeof record.size_bytes === 'number' &&
    typeof record.sha256 === 'string' &&
    record.authorization &&
    typeof record.authorization === 'object'
  )
    return [{ ref: value as ArtifactRef, pointer }];
  return Object.entries(record).flatMap(([key, child]) =>
    collectArtifactRefs(child, `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`)
  );
}
