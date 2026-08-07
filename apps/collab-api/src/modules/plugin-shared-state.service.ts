import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  SHARED_NAMESPACE_DEFAULT_QUOTA_BYTES,
  SharedNamespaceDeclaration,
  SharedNamespaceReactivate,
  SharedSchemaMigration,
  SharedWrite,
  normalizeSharedKey,
  serializeSharedJson,
  type SharedNamespaceOwnerKind,
} from '@lingfang/contract';
import { AppError, badRequest, forbidden } from '../common';
import { PrismaService } from '../prisma.service';
import { AuthService } from './auth.service';
import { PluginGovernanceService } from './plugin-governance.service';
import {
  RuntimeArtifactService,
  sharedArtifactRenewalMs,
  sharedArtifactRetentionCap,
} from './runtime-artifact.service';
import { assertActionValue } from './action-schema-validator';

export type SharedNamespaceLocator = {
  ownerKind: SharedNamespaceOwnerKind;
  ownerId: string;
  name: string;
};

export type SharedInvocationPrincipal = {
  invocationId: string;
  userId: string;
  teamId: string;
  packageId: string;
  releaseId: string;
  releaseSha256: string;
  actionId: string;
  actionContractVersion: string;
  actionSurfaceSha256: string;
  workflowReleaseId: string | null;
};

type StoredValue = {
  namespaceId: string;
  namespaceGeneration: number;
  key: string;
  valueJson: Prisma.JsonValue;
  schemaVersion: number;
  valueBytes: number;
  revision: bigint;
  createdByUserId: string | null;
  createdByPackageId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const MAX_TRANSACTION_ATTEMPTS = 3;
const ARTIFACT_RECONCILE_INTERVAL_MS = 5 * 60 * 1000;

@Injectable()
export class PluginSharedStateService implements OnModuleInit, OnModuleDestroy {
  private artifactReconcileTimer?: NodeJS.Timeout;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PluginGovernanceService) private readonly governance: PluginGovernanceService,
    @Inject(RuntimeArtifactService) private readonly artifacts: RuntimeArtifactService,
    @Inject(AuthService) private readonly auth?: AuthService
  ) {}

  /**
   * Team-admin operations intentionally expose metadata only.  They do not
   * manufacture an InvocationPrincipal (and therefore never expose or accept
   * a runtime/bridge token).  Value bodies stay behind the invocation-scoped
   * shared API; export is the one explicit owner/admin operation and redacts
   * artifact handles before streaming.
   */
  async adminListNamespaces(actorId: string) {
    const membership = await this.requireAdmin(actorId);
    const rows = await this.prisma.pluginSharedNamespace.findMany({
      where: { teamId: membership.teamId },
      orderBy: [{ deletedAt: 'asc' }, { updatedAt: 'desc' }, { id: 'asc' }],
      select: {
        id: true,
        teamId: true,
        ownerKind: true,
        ownerId: true,
        name: true,
        generation: true,
        deletedAt: true,
        activeSchemaVersion: true,
        nextValueRevision: true,
        nextChangeCursor: true,
        usedBytes: true,
        quotaBytes: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return { namespaces: rows.map(publicNamespaceAdmin) };
  }

  async adminExportNamespace(actorId: string, namespaceId: string) {
    const namespace = await this.adminNamespace(actorId, namespaceId, false);
    const prisma = this.prisma;
    async function* lines() {
      let afterKey: string | null = null;
      for (;;) {
        const rows: StoredValue[] = await prisma.pluginSharedValue.findMany({
          where: {
            namespaceId: namespace.id,
            namespaceGeneration: namespace.generation,
            ...(afterKey ? { key: { gt: afterKey } } : {}),
          },
          orderBy: { key: 'asc' },
          take: 200,
        });
        for (const row of rows) {
          yield `${JSON.stringify({
            namespace_id: namespace.id,
            namespace_generation: namespace.generation,
            key: row.key,
            value: redactArtifactHandles(row.valueJson),
            schema_version: row.schemaVersion,
            revision: row.revision.toString(),
            updated_at: row.updatedAt.toISOString(),
          })}\n`;
        }
        if (rows.length < 200) return;
        afterKey = rows.at(-1)!.key;
      }
    }
    return { namespaceId: namespace.id, generation: namespace.generation, lines: lines() };
  }

  async adminDeleteNamespace(actorId: string, namespaceId: string) {
    const membership = await this.requireAdmin(actorId);
    return this.serializable(async (tx) => {
      const namespace = await tx.pluginSharedNamespace.findFirst({
        where: { id: namespaceId, teamId: membership.teamId },
      });
      if (!namespace || namespace.deletedAt)
        throw sharedNotFound('shared_namespace_not_found', '共享命名空间不存在');
      const updated = await this.clearNamespaceTx(tx, namespace, membership.teamId);
      await tx.auditLog.create({
        data: {
          actorUserId: actorId,
          action: 'plugin_shared.namespace.deleted',
          targetType: 'PluginSharedNamespace',
          targetId: namespace.id,
          metadata: { teamId: membership.teamId, generation: namespace.generation },
        },
      });
      return publicNamespaceLifecycle(updated);
    });
  }

  async adminReactivateNamespace(actorId: string, namespaceId: string, input: unknown) {
    const membership = await this.requireAdmin(actorId);
    const request = parseReactivation(input);
    return this.serializable(async (tx) => {
      const namespace = await tx.pluginSharedNamespace.findFirst({
        where: { id: namespaceId, teamId: membership.teamId },
      });
      if (!namespace) throw sharedNotFound('shared_namespace_not_found', '共享命名空间不存在');
      if (!namespace.deletedAt) {
        if (namespace.activeSchemaVersion !== request.active_schema_version)
          throw new AppError(
            409,
            'shared_namespace_active',
            '共享命名空间仍处于启用状态，不能切换 schemaVersion'
          );
        return publicNamespaceLifecycle(namespace);
      }
      const declaration = await this.loadNamespaceDeclarationForAdmin(membership.teamId, namespace);
      if (
        !declaration.schemas.some((entry) => entry.schema_version === request.active_schema_version)
      ) {
        throw new AppError(
          409,
          'shared_schema_version_unsupported',
          '重建目标 schemaVersion 未声明'
        );
      }
      const updated = await tx.pluginSharedNamespace.update({
        where: { id: namespace.id },
        data: {
          generation: { increment: 1 },
          deletedAt: null,
          activeSchemaVersion: request.active_schema_version,
          usedBytes: 0,
        },
      });
      await tx.auditLog.create({
        data: {
          actorUserId: actorId,
          action: 'plugin_shared.namespace.reactivated',
          targetType: 'PluginSharedNamespace',
          targetId: namespace.id,
          metadata: { teamId: membership.teamId, generation: updated.generation },
        },
      });
      return publicNamespaceLifecycle(updated);
    });
  }

  async adminMigrateNamespaceValue(
    actorId: string,
    namespaceId: string,
    rawKey: string,
    input: unknown
  ) {
    const membership = await this.requireAdmin(actorId);
    const key = parseKey(rawKey);
    const migration = parseMigration(input);
    // Management migrations do not have a STANDARD invocation source grant;
    // reject artifact-bearing JSON rather than silently widening its scope.
    if (collectArtifactRefs(migration.value).length > 0)
      throw new AppError(
        403,
        'shared_artifact_invocation_required',
        '含 ArtifactRef 的共享值必须由插件 STANDARD invocation 迁移'
      );
    return this.serializable(async (tx) => {
      const namespace = await tx.pluginSharedNamespace.findFirst({
        where: { id: namespaceId, teamId: membership.teamId },
      });
      if (!namespace || namespace.deletedAt)
        throw sharedNotFound('shared_namespace_not_found', '共享命名空间不存在');
      const declaration = await this.loadNamespaceDeclarationForAdmin(membership.teamId, namespace);
      const sourceSchema = declaration.schemas.find(
        (entry) => entry.schema_version === migration.source_schema_version
      )?.schema;
      const targetSchema = declaration.schemas.find(
        (entry) => entry.schema_version === migration.target_schema_version
      )?.schema;
      if (!sourceSchema || !targetSchema)
        throw new AppError(
          409,
          'shared_schema_version_unsupported',
          '迁移源或目标 schemaVersion 未声明'
        );
      assertSharedSchemaValue(targetSchema, migration.value, '迁移目标值不符合声明 schema');
      const current = await tx.pluginSharedValue.findUnique({
        where: { namespaceId_key: { namespaceId: namespace.id, key } },
      });
      assertExpectedRevision(current, migration.expected_revision);
      if (!current) throw sharedNotFound('shared_value_not_found', '共享值不存在');
      if (current.schemaVersion !== migration.source_schema_version)
        throw new AppError(
          409,
          'shared_schema_migration_source_changed',
          '共享值源 schemaVersion 已变化',
          {
            current_schema_version: current.schemaVersion,
            current_revision: current.revision.toString(),
            retryable: true,
          }
        );
      assertSharedSchemaValue(sourceSchema, current.valueJson, '现有共享值不符合迁移源 schema');
      const serialized = measureValue(migration.value);
      const delta = serialized.bytes - current.valueBytes;
      if (namespace.usedBytes + delta > namespace.quotaBytes)
        throw new AppError(413, 'shared_namespace_quota_exceeded', '共享命名空间容量超过限制');
      const allocated = await tx.pluginSharedNamespace.update({
        where: { id: namespace.id },
        data: {
          usedBytes: { increment: delta },
          nextValueRevision: { increment: 1n },
          nextChangeCursor: { increment: 1n },
        },
        select: { generation: true, nextValueRevision: true, nextChangeCursor: true },
      });
      // A management migration cannot establish a new invocation-scoped
      // ArtifactRef grant.  Revoke/delete edges belonging to the old revision
      // before replacing the value so an old handle is never left readable.
      await this.artifacts.releaseSharedValueTx(
        tx,
        sharedArtifactTarget(namespace.id, namespace.generation, key, current.revision)
      );
      await tx.pluginSharedValueArtifact.deleteMany({
        where: { namespaceId: namespace.id, key, valueRevision: current.revision },
      });
      const row = await tx.pluginSharedValue.update({
        where: { id: current.id },
        data: {
          namespaceGeneration: allocated.generation,
          valueJson: toPrismaJson(migration.value),
          schemaVersion: migration.target_schema_version,
          valueBytes: serialized.bytes,
          revision: allocated.nextValueRevision,
          createdByUserId: actorId,
          createdByPackageId: null,
        },
      });
      await tx.pluginSharedNamespace.update({
        where: { id: namespace.id },
        data: { activeSchemaVersion: migration.target_schema_version },
      });
      await tx.sharedStateOutbox.create({
        data: {
          teamId: membership.teamId,
          namespaceId: namespace.id,
          namespaceGeneration: allocated.generation,
          cursor: allocated.nextChangeCursor,
          key,
          revision: allocated.nextValueRevision,
          schemaVersion: migration.target_schema_version,
          eventKind: 'UPSERT',
        },
      });
      await tx.auditLog.create({
        data: {
          actorUserId: actorId,
          action: 'plugin_shared.value.migrated',
          targetType: 'PluginSharedValue',
          targetId: row.id,
          metadata: {
            teamId: membership.teamId,
            namespaceId: namespace.id,
            key,
            revision: row.revision.toString(),
            sourceSchemaVersion: migration.source_schema_version,
            targetSchemaVersion: migration.target_schema_version,
          },
        },
      });
      return publicValue(row);
    });
  }

  private async requireAdmin(actorId: string) {
    if (!this.auth) throw new AppError(503, 'shared_admin_unavailable', '共享状态管理服务不可用');
    return this.auth.ensureTeamAdmin(actorId);
  }

  private async adminNamespace(actorId: string, namespaceId: string, includeDeleted: boolean) {
    const membership = await this.requireAdmin(actorId);
    const namespace = await this.prisma.pluginSharedNamespace.findFirst({
      where: {
        id: namespaceId,
        teamId: membership.teamId,
        ...(includeDeleted ? {} : { deletedAt: null }),
      },
    });
    if (!namespace) throw sharedNotFound('shared_namespace_not_found', '共享命名空间不存在');
    return namespace;
  }

  private async loadNamespaceDeclarationForAdmin(
    teamId: string,
    namespace: { ownerKind: string; ownerId: string; name: string }
  ) {
    const release = await this.prisma.pluginRelease.findFirst({
      where: {
        ...(namespace.ownerKind === 'WORKFLOW'
          ? { id: namespace.ownerId }
          : { packageId: namespace.ownerId }),
        status: 'PUBLISHED',
      },
      select: { manifest: true },
    });
    const manifest =
      release?.manifest && typeof release.manifest === 'object' && !Array.isArray(release.manifest)
        ? (release.manifest as Record<string, unknown>)
        : null;
    const declarations = Array.isArray(manifest?.shared_namespaces)
      ? manifest.shared_namespaces
      : [];
    const parsed = declarations
      .map((entry) => SharedNamespaceDeclaration.safeParse(entry))
      .find((entry) => entry.success && entry.data.name === namespace.name);
    if (!parsed?.success)
      throw new AppError(
        409,
        'shared_schema_version_unsupported',
        '发行版未声明该共享命名空间 schema'
      );
    return parsed.data;
  }

  private async clearNamespaceTx(
    tx: Prisma.TransactionClient,
    namespace: {
      id: string;
      generation: number;
      nextValueRevision: bigint;
      nextChangeCursor: bigint;
      teamId: string;
    },
    teamId: string
  ) {
    const values = await tx.pluginSharedValue.findMany({
      where: { namespaceId: namespace.id, namespaceGeneration: namespace.generation },
      orderBy: [{ revision: 'asc' }, { key: 'asc' }],
    });
    const nextGeneration = namespace.generation + 1;
    let revision = namespace.nextValueRevision;
    let cursor = namespace.nextChangeCursor;
    for (const value of values) {
      await this.artifacts.releaseSharedValueTx(
        tx,
        sharedArtifactTarget(namespace.id, namespace.generation, value.key, value.revision)
      );
      revision += 1n;
      cursor += 1n;
      await tx.sharedStateOutbox.create({
        data: {
          teamId,
          namespaceId: namespace.id,
          namespaceGeneration: nextGeneration,
          cursor,
          key: value.key,
          revision,
          schemaVersion: value.schemaVersion,
          eventKind: 'DELETE',
        },
      });
    }
    await tx.pluginSharedValue.deleteMany({ where: { namespaceId: namespace.id } });
    return tx.pluginSharedNamespace.update({
      where: { id: namespace.id },
      data: {
        generation: nextGeneration,
        deletedAt: new Date(),
        usedBytes: 0,
        nextValueRevision: revision,
        nextChangeCursor: cursor,
      },
    });
  }

  onModuleInit() {
    this.artifactReconcileTimer = setInterval(
      () => void this.reconcileArtifactRetention().catch(() => undefined),
      ARTIFACT_RECONCILE_INTERVAL_MS
    );
    this.artifactReconcileTimer.unref();
    void this.reconcileArtifactRetention().catch(() => undefined);
  }

  onModuleDestroy() {
    if (this.artifactReconcileTimer) clearInterval(this.artifactReconcileTimer);
  }

  async resolvePrincipal(
    userId: string,
    teamId: string | null,
    invocationId: string
  ): Promise<SharedInvocationPrincipal> {
    if (!teamId || !invocationId) throw badRequest('缺少有效的插件调用上下文');
    const invocation = await this.prisma.actionInvocation.findFirst({
      where: {
        id: invocationId,
        teamId,
        principalUserId: userId,
        kind: 'STANDARD',
        status: 'RUNNING',
      },
      select: {
        id: true,
        teamId: true,
        principalUserId: true,
        packageId: true,
        releaseId: true,
        releaseSha256: true,
        actionId: true,
        actionContractVersion: true,
        actionSurfaceSha256: true,
        workflowStepAttempt: {
          select: { run: { select: { workflowReleaseId: true } } },
        },
      },
    });
    if (!invocation || !invocation.principalUserId) {
      throw new AppError(403, 'shared_invocation_invalid', '插件共享数据调用上下文无效或已结束');
    }
    return {
      invocationId: invocation.id,
      userId: invocation.principalUserId,
      teamId: invocation.teamId,
      packageId: invocation.packageId,
      releaseId: invocation.releaseId,
      releaseSha256: invocation.releaseSha256,
      actionId: invocation.actionId,
      actionContractVersion: invocation.actionContractVersion,
      actionSurfaceSha256: invocation.actionSurfaceSha256,
      workflowReleaseId: invocation.workflowStepAttempt?.run.workflowReleaseId ?? null,
    };
  }

  async get(principal: SharedInvocationPrincipal, locator: SharedNamespaceLocator, rawKey: string) {
    const target = normalizeLocator(locator);
    const key = parseKey(rawKey);
    await this.authorize(principal, target, 'shared_data_read');
    return this.prisma.$transaction(
      async (tx) => {
        const namespace = await tx.pluginSharedNamespace.findUnique({
          where: { teamId_ownerKind_ownerId_name: namespaceIdentity(principal.teamId, target) },
        });
        if (!namespace || namespace.deletedAt)
          throw sharedNotFound('shared_namespace_not_found', '共享命名空间不存在');
        const value = await tx.pluginSharedValue.findUnique({
          where: { namespaceId_key: { namespaceId: namespace.id, key } },
          include: { artifacts: true },
        });
        if (!value || value.namespaceGeneration !== namespace.generation)
          throw sharedNotFound('shared_value_not_found', '共享值不存在');
        assertReadableSchema(namespace.activeSchemaVersion, value.schemaVersion);
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
        for (const edge of value.artifacts) {
          const targetId = sharedArtifactTarget(
            namespace.id,
            namespace.generation,
            key,
            value.revision
          );
          await this.artifacts.exchangeSharedValueTx(
            tx,
            principal.invocationId,
            edge.artifactId,
            targetId,
            sharedArtifactScope(
              namespace.id,
              namespace.generation,
              key,
              value.revision,
              edge.artifactId,
              edge.jsonPointer
            ),
            expiresAt
          );
        }
        return publicValue(value, value.artifacts);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  }

  async set(
    principal: SharedInvocationPrincipal,
    locator: SharedNamespaceLocator,
    rawKey: string,
    input: unknown
  ) {
    const target = normalizeLocator(locator);
    const key = parseKey(rawKey);
    const write = parseWrite(input);
    const artifactRefs = collectArtifactRefs(write.value);
    const serialized = measureValue(write.value);
    await this.authorize(principal, target, 'shared_data_write');

    return this.serializable((tx) =>
      this.writeTx(tx, principal, target, key, write, artifactRefs, serialized)
    );
  }

  async migrate(
    principal: SharedInvocationPrincipal,
    locator: SharedNamespaceLocator,
    rawKey: string,
    input: unknown
  ) {
    const target = normalizeLocator(locator);
    const key = parseKey(rawKey);
    const migration = parseMigration(input);
    if (!isOwner(principal, target)) throw forbidden('只有命名空间所有者可以执行 schema 迁移');
    await this.authorize(principal, target, 'shared_data_write');
    const declaration = await this.loadNamespaceDeclaration(principal, target);
    const sourceSchema = declaration.schemas.find(
      (entry) => entry.schema_version === migration.source_schema_version
    )?.schema;
    const targetSchema = declaration.schemas.find(
      (entry) => entry.schema_version === migration.target_schema_version
    )?.schema;
    if (!sourceSchema || !targetSchema) {
      throw new AppError(
        409,
        'shared_schema_version_unsupported',
        '迁移源或目标 schemaVersion 未声明'
      );
    }
    assertSharedSchemaValue(targetSchema, migration.value, '迁移目标值不符合声明 schema');
    const artifactRefs = collectArtifactRefs(migration.value);
    const serialized = measureValue(migration.value);

    return this.serializable(async (tx) => {
      const namespace = await tx.pluginSharedNamespace.findUnique({
        where: { teamId_ownerKind_ownerId_name: namespaceIdentity(principal.teamId, target) },
      });
      if (!namespace || namespace.deletedAt)
        throw sharedNotFound('shared_namespace_not_found', '共享命名空间不存在');
      const current = await tx.pluginSharedValue.findUnique({
        where: { namespaceId_key: { namespaceId: namespace.id, key } },
      });
      assertExpectedRevision(current, migration.expected_revision);
      if (!current) throw sharedNotFound('shared_value_not_found', '共享值不存在');
      if (current.schemaVersion !== migration.source_schema_version) {
        throw new AppError(
          409,
          'shared_schema_migration_source_changed',
          '共享值源 schemaVersion 已变化',
          {
            current_schema_version: current.schemaVersion,
            current_revision: current.revision.toString(),
            retryable: true,
          }
        );
      }
      assertSharedSchemaValue(sourceSchema, current.valueJson, '现有共享值不符合迁移源 schema');
      const activated = await tx.pluginSharedNamespace.update({
        where: { id: namespace.id },
        data: { activeSchemaVersion: migration.target_schema_version },
      });
      return this.writeTx(
        tx,
        principal,
        target,
        key,
        {
          value: migration.value,
          schema_version: migration.target_schema_version,
          expected_revision: migration.expected_revision,
        },
        artifactRefs,
        serialized,
        activated
      );
    });
  }

  private async writeTx(
    tx: Prisma.TransactionClient,
    principal: SharedInvocationPrincipal,
    target: SharedNamespaceLocator,
    key: string,
    write: { value: unknown; schema_version: number; expected_revision?: string },
    artifactRefs: Array<{ ref: SharedArtifactRefValue; pointer: string }>,
    serialized: { json: string; bytes: number },
    knownNamespace?: Awaited<ReturnType<PluginSharedStateService['namespaceForWrite']>>
  ) {
    const namespace =
      knownNamespace ?? (await this.namespaceForWrite(tx, principal, target, write.schema_version));
    assertWritableSchema(namespace.activeSchemaVersion, write.schema_version);
    const current = await tx.pluginSharedValue.findUnique({
      where: { namespaceId_key: { namespaceId: namespace.id, key } },
    });
    assertExpectedRevision(current, write.expected_revision);
    const delta = serialized.bytes - (current?.valueBytes ?? 0);
    if (namespace.usedBytes + delta > namespace.quotaBytes) {
      throw new AppError(413, 'shared_namespace_quota_exceeded', '共享命名空间容量超过限制', {
        quota_bytes: namespace.quotaBytes,
        used_bytes: namespace.usedBytes,
        requested_bytes: serialized.bytes,
      });
    }
    const allocated = await tx.pluginSharedNamespace.update({
      where: { id: namespace.id },
      data: {
        usedBytes: { increment: delta },
        nextValueRevision: { increment: 1n },
        nextChangeCursor: { increment: 1n },
      },
      select: { generation: true, nextValueRevision: true, nextChangeCursor: true },
    });
    const valueJson = toPrismaJson(write.value);
    if (current) {
      await this.artifacts.releaseSharedValueTx(
        tx,
        sharedArtifactTarget(namespace.id, namespace.generation, key, current.revision)
      );
      await tx.pluginSharedValueArtifact.deleteMany({
        where: { namespaceId: namespace.id, key, valueRevision: current.revision },
      });
    }
    const row = current
      ? await tx.pluginSharedValue.update({
          where: { id: current.id },
          data: {
            namespaceGeneration: allocated.generation,
            valueJson,
            schemaVersion: write.schema_version,
            valueBytes: serialized.bytes,
            revision: allocated.nextValueRevision,
            createdByUserId: principal.userId,
            createdByPackageId: principal.packageId,
          },
        })
      : await tx.pluginSharedValue.create({
          data: {
            namespaceId: namespace.id,
            namespaceGeneration: allocated.generation,
            key,
            valueJson,
            schemaVersion: write.schema_version,
            valueBytes: serialized.bytes,
            revision: allocated.nextValueRevision,
            createdByUserId: principal.userId,
            createdByPackageId: principal.packageId,
          },
        });
    const retainUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    for (const item of artifactRefs) {
      const targetId = sharedArtifactTarget(
        namespace.id,
        allocated.generation,
        key,
        allocated.nextValueRevision
      );
      const scope = sharedArtifactScope(
        namespace.id,
        allocated.generation,
        key,
        allocated.nextValueRevision,
        item.ref.artifact_id,
        item.pointer
      );
      await this.artifacts.bindSharedValueTx(
        tx,
        principal.invocationId,
        item.ref,
        targetId,
        scope,
        retainUntil
      );
      await tx.pluginSharedValueArtifact.create({
        data: {
          namespaceId: namespace.id,
          namespaceGeneration: allocated.generation,
          key,
          valueRevision: allocated.nextValueRevision,
          artifactId: item.ref.artifact_id,
          jsonPointer: item.pointer,
          executionKind: 'STANDARD',
        },
      });
    }
    await tx.sharedStateOutbox.create({
      data: {
        teamId: principal.teamId,
        namespaceId: namespace.id,
        namespaceGeneration: allocated.generation,
        cursor: allocated.nextChangeCursor,
        key,
        revision: allocated.nextValueRevision,
        schemaVersion: write.schema_version,
        eventKind: 'UPSERT',
      },
    });
    return publicValue(row);
  }

  async delete(
    principal: SharedInvocationPrincipal,
    locator: SharedNamespaceLocator,
    rawKey: string,
    expectedRevision: unknown
  ) {
    const target = normalizeLocator(locator);
    const key = parseKey(rawKey);
    const expected = parseRequiredRevision(expectedRevision);
    await this.authorize(principal, target, 'shared_data_write');

    return this.serializable(async (tx) => {
      const namespace = await tx.pluginSharedNamespace.findUnique({
        where: { teamId_ownerKind_ownerId_name: namespaceIdentity(principal.teamId, target) },
      });
      if (!namespace || namespace.deletedAt)
        throw sharedNotFound('shared_namespace_not_found', '共享命名空间不存在');
      const current = await tx.pluginSharedValue.findUnique({
        where: { namespaceId_key: { namespaceId: namespace.id, key } },
      });
      assertExpectedRevision(current, expected.toString());
      if (!current) throw sharedNotFound('shared_value_not_found', '共享值不存在');
      await this.artifacts.releaseSharedValueTx(
        tx,
        sharedArtifactTarget(namespace.id, namespace.generation, key, current.revision)
      );
      const allocated = await tx.pluginSharedNamespace.update({
        where: { id: namespace.id },
        data: {
          usedBytes: { decrement: current.valueBytes },
          nextValueRevision: { increment: 1n },
          nextChangeCursor: { increment: 1n },
        },
        select: { generation: true, nextValueRevision: true, nextChangeCursor: true },
      });
      await tx.pluginSharedValue.delete({ where: { id: current.id } });
      const change = await tx.sharedStateOutbox.create({
        data: {
          teamId: principal.teamId,
          namespaceId: namespace.id,
          namespaceGeneration: allocated.generation,
          cursor: allocated.nextChangeCursor,
          key,
          revision: allocated.nextValueRevision,
          schemaVersion: current.schemaVersion,
          eventKind: 'DELETE',
        },
      });
      return publicChange(change);
    });
  }

  async deleteNamespace(principal: SharedInvocationPrincipal, locator: SharedNamespaceLocator) {
    const target = normalizeLocator(locator);
    if (!isOwner(principal, target)) throw forbidden('只有命名空间所有者可以删除共享命名空间');
    await this.authorize(principal, target, 'shared_data_write');
    return this.serializable(async (tx) => {
      const namespace = await tx.pluginSharedNamespace.findUnique({
        where: { teamId_ownerKind_ownerId_name: namespaceIdentity(principal.teamId, target) },
      });
      if (!namespace || namespace.deletedAt)
        throw sharedNotFound('shared_namespace_not_found', '共享命名空间不存在');
      const values = await tx.pluginSharedValue.findMany({
        where: { namespaceId: namespace.id, namespaceGeneration: namespace.generation },
        orderBy: [{ revision: 'asc' }, { key: 'asc' }],
      });
      const nextGeneration = namespace.generation + 1;
      let revision = namespace.nextValueRevision;
      let cursor = namespace.nextChangeCursor;
      for (const value of values) {
        await this.artifacts.releaseSharedValueTx(
          tx,
          sharedArtifactTarget(namespace.id, namespace.generation, value.key, value.revision)
        );
        revision += 1n;
        cursor += 1n;
        await tx.sharedStateOutbox.create({
          data: {
            teamId: principal.teamId,
            namespaceId: namespace.id,
            namespaceGeneration: nextGeneration,
            cursor,
            key: value.key,
            revision,
            schemaVersion: value.schemaVersion,
            eventKind: 'DELETE',
          },
        });
      }
      await tx.pluginSharedValue.deleteMany({ where: { namespaceId: namespace.id } });
      const deletedAt = new Date();
      const updated = await tx.pluginSharedNamespace.update({
        where: { id: namespace.id },
        data: {
          generation: nextGeneration,
          deletedAt,
          usedBytes: 0,
          nextValueRevision: revision,
          nextChangeCursor: cursor,
        },
      });
      return publicNamespaceLifecycle(updated);
    });
  }

  async reactivateNamespace(
    principal: SharedInvocationPrincipal,
    locator: SharedNamespaceLocator,
    input: unknown
  ) {
    const target = normalizeLocator(locator);
    const request = parseReactivation(input);
    if (!isOwner(principal, target)) throw forbidden('只有命名空间所有者可以重建共享命名空间');
    await this.authorize(principal, target, 'shared_data_write');
    const declaration = await this.loadNamespaceDeclaration(principal, target);
    if (
      !declaration.schemas.some((entry) => entry.schema_version === request.active_schema_version)
    ) {
      throw new AppError(409, 'shared_schema_version_unsupported', '重建目标 schemaVersion 未声明');
    }
    return this.serializable(async (tx) => {
      const identity = namespaceIdentity(principal.teamId, target);
      const existing = await tx.pluginSharedNamespace.findUnique({
        where: { teamId_ownerKind_ownerId_name: identity },
      });
      if (!existing) {
        const created = await tx.pluginSharedNamespace.create({
          data: {
            ...identity,
            activeSchemaVersion: request.active_schema_version,
            quotaBytes: SHARED_NAMESPACE_DEFAULT_QUOTA_BYTES,
          },
        });
        return publicNamespaceLifecycle(created);
      }
      if (!existing.deletedAt) {
        if (existing.activeSchemaVersion !== request.active_schema_version) {
          throw new AppError(
            409,
            'shared_namespace_active',
            '共享命名空间仍处于启用状态，不能通过重建切换 schemaVersion'
          );
        }
        return publicNamespaceLifecycle(existing);
      }
      const updated = await tx.pluginSharedNamespace.update({
        where: { id: existing.id },
        data: {
          generation: { increment: 1 },
          deletedAt: null,
          activeSchemaVersion: request.active_schema_version,
          usedBytes: 0,
        },
      });
      return publicNamespaceLifecycle(updated);
    });
  }

  async exportNamespace(principal: SharedInvocationPrincipal, locator: SharedNamespaceLocator) {
    const target = normalizeLocator(locator);
    if (!isOwner(principal, target)) throw forbidden('只有命名空间所有者可以导出共享命名空间');
    await this.authorize(principal, target, 'shared_data_read');
    const namespace = await this.prisma.pluginSharedNamespace.findUnique({
      where: { teamId_ownerKind_ownerId_name: namespaceIdentity(principal.teamId, target) },
    });
    if (!namespace || namespace.deletedAt)
      throw sharedNotFound('shared_namespace_not_found', '共享命名空间不存在');
    const activeNamespace = namespace;
    const prisma = this.prisma;
    async function* lines() {
      let afterKey: string | null = null;
      for (;;) {
        const rows: StoredValue[] = await prisma.pluginSharedValue.findMany({
          where: {
            namespaceId: activeNamespace.id,
            namespaceGeneration: activeNamespace.generation,
            ...(afterKey ? { key: { gt: afterKey } } : {}),
          },
          orderBy: { key: 'asc' },
          take: 200,
        });
        for (const row of rows) {
          yield `${JSON.stringify({
            namespace_id: activeNamespace.id,
            namespace_generation: activeNamespace.generation,
            key: row.key,
            value: redactArtifactHandles(row.valueJson),
            schema_version: row.schemaVersion,
            revision: row.revision.toString(),
            updated_at: row.updatedAt.toISOString(),
          })}\n`;
        }
        if (rows.length < 200) return;
        afterKey = rows.at(-1)!.key;
      }
    }
    return {
      namespaceId: activeNamespace.id,
      generation: activeNamespace.generation,
      lines: lines(),
    };
  }

  async reconcileArtifactRetention(rawLimit: unknown = 100, now = new Date()) {
    const limit = parseLimit(rawLimit);
    const edges = await this.prisma.pluginSharedValueArtifact.findMany({
      where: { executionKind: 'STANDARD' },
      include: { namespace: true, value: true, artifact: true },
      orderBy: { id: 'asc' },
      take: limit,
    });
    let repaired = 0;
    let expired = 0;
    let released = 0;
    const liveTargets = new Set<string>();
    for (const edge of edges) {
      const targetId = sharedArtifactTarget(
        edge.namespaceId,
        edge.namespaceGeneration,
        edge.key,
        edge.valueRevision
      );
      const live =
        !edge.namespace.deletedAt &&
        edge.namespace.generation === edge.namespaceGeneration &&
        edge.value.namespaceGeneration === edge.namespaceGeneration &&
        edge.value.revision === edge.valueRevision &&
        edge.artifact.status === 'ACTIVE';
      if (!live) {
        await this.prisma.$transaction((tx) => this.artifacts.releaseSharedValueTx(tx, targetId), {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
        released += 1;
        continue;
      }
      liveTargets.add(`${edge.artifactId}\0${targetId}`);
      const cap = sharedArtifactRetentionCap(edge.artifact.createdAt);
      const retainUntil = new Date(
        Math.min(cap.getTime(), now.getTime() + sharedArtifactRenewalMs())
      );
      if (retainUntil <= now) {
        await this.prisma.$transaction((tx) => this.artifacts.releaseSharedValueTx(tx, targetId), {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
        expired += 1;
        continue;
      }
      try {
        await this.prisma.$transaction(
          (tx) =>
            this.artifacts.reconcileSharedValueTx(
              tx,
              edge.artifactId,
              targetId,
              sharedArtifactScope(
                edge.namespaceId,
                edge.namespaceGeneration,
                edge.key,
                edge.valueRevision,
                edge.artifactId,
                edge.jsonPointer
              ),
              retainUntil
            ),
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        );
        repaired += 1;
      } catch (error) {
        if (
          error instanceof AppError &&
          (error.code === 'conflict' || error.code === 'shared_artifact_expired')
        ) {
          await this.prisma.$transaction(
            (tx) => this.artifacts.releaseSharedValueTx(tx, targetId),
            {
              isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            }
          );
          expired += 1;
          continue;
        }
        throw error;
      }
    }

    const [grantCandidates, holdCandidates] = await Promise.all([
      this.prisma.runtimeArtifactGrant.findMany({
        where: { executionKind: 'STANDARD', targetKind: 'SHARED_VALUE', revokedAt: null },
        select: { artifactId: true, targetId: true },
        orderBy: { id: 'asc' },
        take: limit,
      }),
      this.prisma.runtimeArtifactHold.findMany({
        where: {
          executionKind: 'STANDARD',
          holderKind: 'SHARED_VALUE',
          purpose: 'SHARED_VALUE',
          releasedAt: null,
        },
        select: { artifactId: true, holderId: true },
        orderBy: { id: 'asc' },
        take: limit,
      }),
    ]);
    const candidates = [
      ...grantCandidates,
      ...holdCandidates.map((hold) => ({ artifactId: hold.artifactId, targetId: hold.holderId })),
    ].filter(
      (candidate, index, all) =>
        all.findIndex(
          (item) => item.artifactId === candidate.artifactId && item.targetId === candidate.targetId
        ) === index
    );
    for (const candidate of candidates) {
      const key = `${candidate.artifactId}\0${candidate.targetId}`;
      if (
        liveTargets.has(key) ||
        (await this.sharedTargetExists(candidate.artifactId, candidate.targetId))
      )
        continue;
      await this.prisma.$transaction(
        (tx) => this.artifacts.releaseSharedValueTx(tx, candidate.targetId),
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        }
      );
      released += 1;
    }
    return { scanned: edges.length, repaired, expired, released };
  }

  async changes(
    principal: SharedInvocationPrincipal,
    locator: SharedNamespaceLocator,
    after: unknown,
    rawLimit: unknown
  ) {
    const target = normalizeLocator(locator);
    const cursor = parseOptionalCursor(after);
    const limit = parseLimit(rawLimit);
    await this.authorize(principal, target, 'shared_data_read');
    const namespace = await this.prisma.pluginSharedNamespace.findUnique({
      where: { teamId_ownerKind_ownerId_name: namespaceIdentity(principal.teamId, target) },
    });
    if (!namespace || namespace.deletedAt)
      throw sharedNotFound('shared_namespace_not_found', '共享命名空间不存在');
    if (cursor > 0n) {
      const retained = await this.prisma.sharedStateOutbox.findFirst({
        where: {
          namespaceId: namespace.id,
          namespaceGeneration: namespace.generation,
          createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
        },
        orderBy: { cursor: 'asc' },
        select: { cursor: true },
      });
      if (retained && cursor + 1n < retained.cursor) {
        throw new AppError(
          410,
          'shared_change_cursor_expired',
          '共享数据变更游标已过期，请执行全量重建',
          {
            latest_cursor: namespace.nextChangeCursor.toString(),
          }
        );
      }
    }
    const rows = await this.prisma.sharedStateOutbox.findMany({
      where: {
        namespaceId: namespace.id,
        namespaceGeneration: namespace.generation,
        cursor: { gt: cursor },
      },
      orderBy: { cursor: 'asc' },
      take: limit,
    });
    return {
      changes: rows.map(publicChange),
      next_cursor: (rows.at(-1)?.cursor ?? cursor).toString(),
    };
  }

  async list(
    principal: SharedInvocationPrincipal,
    locator: SharedNamespaceLocator,
    input: { pageCursor?: unknown; relistToken?: unknown; limit?: unknown }
  ) {
    const target = normalizeLocator(locator);
    const limit = parseLimit(input.limit);
    await this.authorize(principal, target, 'shared_data_read');
    const namespace = await this.prisma.pluginSharedNamespace.findUnique({
      where: { teamId_ownerKind_ownerId_name: namespaceIdentity(principal.teamId, target) },
    });
    if (!namespace || namespace.deletedAt)
      throw sharedNotFound('shared_namespace_not_found', '共享命名空间不存在');
    const token = input.relistToken
      ? verifyRelistToken(String(input.relistToken), namespace.id, namespace.generation)
      : {
          namespaceId: namespace.id,
          generation: namespace.generation,
          snapshotCursor: namespace.nextValueRevision.toString(),
        };
    const pageKey = parsePageCursor(input.pageCursor);
    const rows = await this.prisma.pluginSharedValue.findMany({
      where: {
        namespaceId: namespace.id,
        namespaceGeneration: namespace.generation,
        revision: { lte: BigInt(token.snapshotCursor) },
        ...(pageKey ? { key: { gt: pageKey } } : {}),
      },
      orderBy: { key: 'asc' },
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const visible = hasMore ? rows.slice(0, limit) : rows;
    return {
      values: visible.map((row) => publicValue(row)),
      next_page_cursor: hasMore ? encodePageCursor(visible.at(-1)!.key) : null,
      snapshot_cursor: token.snapshotCursor,
      relist_token: input.relistToken ? String(input.relistToken) : signRelistToken(token),
    };
  }

  private async namespaceForWrite(
    tx: Prisma.TransactionClient,
    principal: SharedInvocationPrincipal,
    locator: SharedNamespaceLocator,
    schemaVersion: number
  ) {
    const identity = namespaceIdentity(principal.teamId, locator);
    const existing = await tx.pluginSharedNamespace.findUnique({
      where: { teamId_ownerKind_ownerId_name: identity },
    });
    if (existing) {
      if (existing.deletedAt)
        throw new AppError(409, 'shared_namespace_deleted', '共享命名空间已停用');
      return existing;
    }
    if (!isOwner(principal, locator))
      throw sharedNotFound('shared_namespace_not_found', '共享命名空间不存在');
    return tx.pluginSharedNamespace.create({
      data: {
        teamId: principal.teamId,
        ownerKind: locator.ownerKind,
        ownerId: locator.ownerId,
        name: locator.name,
        activeSchemaVersion: schemaVersion,
        quotaBytes: SHARED_NAMESPACE_DEFAULT_QUOTA_BYTES,
      },
    });
  }

  private async loadNamespaceDeclaration(
    principal: SharedInvocationPrincipal,
    locator: SharedNamespaceLocator
  ) {
    const releaseId = locator.ownerKind === 'WORKFLOW' ? locator.ownerId : principal.releaseId;
    const release = await this.prisma.pluginRelease.findFirst({
      where: {
        id: releaseId,
        ...(locator.ownerKind === 'PACKAGE' ? { packageId: locator.ownerId } : {}),
        status: 'PUBLISHED',
      },
      select: { manifest: true },
    });
    const manifest =
      release?.manifest && typeof release.manifest === 'object' && !Array.isArray(release.manifest)
        ? (release.manifest as Record<string, unknown>)
        : null;
    const declarations = Array.isArray(manifest?.shared_namespaces)
      ? manifest.shared_namespaces
      : [];
    const parsed = declarations
      .map((entry) => SharedNamespaceDeclaration.safeParse(entry))
      .find((entry) => entry.success && entry.data.name === locator.name);
    if (!parsed?.success)
      throw new AppError(
        409,
        'shared_schema_version_unsupported',
        '发行版未声明该共享命名空间 schema'
      );
    return parsed.data;
  }

  private async sharedTargetExists(artifactId: string, targetId: string) {
    const edges = await this.prisma.pluginSharedValueArtifact.findMany({
      where: { artifactId, executionKind: 'STANDARD' },
      include: { namespace: true, value: true },
    });
    return edges.some(
      (edge) =>
        !edge.namespace.deletedAt &&
        edge.namespace.generation === edge.namespaceGeneration &&
        edge.value.namespaceGeneration === edge.namespaceGeneration &&
        edge.value.revision === edge.valueRevision &&
        sharedArtifactTarget(
          edge.namespaceId,
          edge.namespaceGeneration,
          edge.key,
          edge.valueRevision
        ) === targetId
    );
  }

  private async authorize(
    principal: SharedInvocationPrincipal,
    locator: SharedNamespaceLocator,
    operation: 'shared_data_read' | 'shared_data_write'
  ) {
    const owner = isOwner(principal, locator);
    const result = await this.governance.authorizeRelease(
      principal.userId,
      {
        releaseId: principal.releaseId,
        packageId: principal.packageId,
        sha256: principal.releaseSha256,
      },
      [operation],
      {
        enforce: !owner,
        action: {
          action_id: principal.actionId,
          action_contract_version: principal.actionContractVersion,
          action_surface_sha256: principal.actionSurfaceSha256,
        },
      }
    );
    if (
      owner &&
      !result.decision.allowed &&
      result.decision.reason_code !== 'high_risk_not_enabled'
    ) {
      throw forbidden(result.decision.reason);
    }
  }

  private async serializable<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>
  ): Promise<T> {
    for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (attempt < MAX_TRANSACTION_ATTEMPTS && isRetryableTransactionError(error)) continue;
        throw error;
      }
    }
    throw new Error('unreachable');
  }
}

function normalizeLocator(locator: SharedNamespaceLocator): SharedNamespaceLocator {
  const ownerId = locator.ownerId.trim();
  const name = locator.name.normalize('NFC').trim();
  if (
    !ownerId ||
    ownerId.length > 256 ||
    !name ||
    name.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(name)
  ) {
    throw new AppError(400, 'shared_namespace_invalid', '共享命名空间标识无效');
  }
  return { ...locator, ownerId, name };
}

function namespaceIdentity(teamId: string, locator: SharedNamespaceLocator) {
  return { teamId, ownerKind: locator.ownerKind, ownerId: locator.ownerId, name: locator.name };
}

function parseKey(value: string): string {
  try {
    return normalizeSharedKey(value);
  } catch {
    throw new AppError(400, 'shared_key_invalid', '共享数据 key 无效');
  }
}

function parseWrite(input: unknown) {
  const parsed = SharedWrite.safeParse(input);
  if (!parsed.success) throw new AppError(400, 'shared_write_invalid', '共享数据写入参数无效');
  return parsed.data;
}

function parseMigration(input: unknown) {
  const parsed = SharedSchemaMigration.safeParse(input);
  if (!parsed.success)
    throw new AppError(400, 'shared_schema_migration_invalid', '共享数据 schema 迁移参数无效');
  return parsed.data;
}

function parseReactivation(input: unknown) {
  const parsed = SharedNamespaceReactivate.safeParse(input);
  if (!parsed.success)
    throw new AppError(400, 'shared_namespace_reactivation_invalid', '共享命名空间重建参数无效');
  return parsed.data;
}

function measureValue(value: unknown) {
  try {
    return serializeSharedJson(value);
  } catch (error) {
    const code = error instanceof Error ? error.message : 'shared_value_not_json';
    if (code === 'shared_value_too_large') {
      throw new AppError(413, code, '共享值超过 64 KiB 限制');
    }
    throw new AppError(400, 'shared_value_not_json', '共享值必须是可序列化 JSON');
  }
}

function parseRequiredRevision(value: unknown): bigint {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) {
    throw new AppError(
      400,
      'shared_expected_revision_required',
      '删除共享值必须提供 expected_revision'
    );
  }
  return BigInt(value);
}

function parseOptionalCursor(value: unknown): bigint {
  if (value === undefined || value === null || value === '') return 0n;
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) throw badRequest('after cursor 无效');
  return BigInt(value);
}

function parseLimit(value: unknown): number {
  if (value === undefined || value === null || value === '') return 100;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200)
    throw badRequest('limit 必须位于 1 到 200');
  return parsed;
}

function relistSecret(): string {
  const secret = process.env.SHARED_RELIST_TOKEN_SECRET?.trim() || process.env.JWT_SECRET?.trim();
  if (!secret || secret.length < 16)
    throw new AppError(503, 'shared_relist_unavailable', '共享数据全量重建服务不可用');
  return secret;
}

type RelistTokenPayload = { namespaceId: string; generation: number; snapshotCursor: string };

function signRelistToken(payload: RelistTokenPayload): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', relistSecret()).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function verifyRelistToken(
  value: string,
  namespaceId: string,
  generation: number
): RelistTokenPayload {
  try {
    const [encoded, signature, extra] = value.split('.');
    if (!encoded || !signature || extra !== undefined) throw new Error('invalid');
    const expected = createHmac('sha256', relistSecret()).update(encoded).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new Error('invalid');
    const payload = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8')
    ) as RelistTokenPayload;
    if (
      payload.namespaceId !== namespaceId ||
      payload.generation !== generation ||
      !/^[0-9]+$/.test(payload.snapshotCursor)
    )
      throw new Error('stale');
    return payload;
  } catch {
    throw new AppError(
      409,
      'shared_namespace_generation_stale',
      '共享数据全量重建令牌无效或已过期'
    );
  }
}

function encodePageCursor(key: string): string {
  return Buffer.from(key, 'utf8').toString('base64url');
}

function parsePageCursor(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 512) throw badRequest('page_cursor 无效');
  try {
    const key = Buffer.from(value, 'base64url').toString('utf8');
    return parseKey(key);
  } catch {
    throw badRequest('page_cursor 无效');
  }
}

function assertExpectedRevision(current: { revision: bigint } | null, expectedRevision?: string) {
  if (expectedRevision === undefined) return;
  const expected = BigInt(expectedRevision);
  if (!current || current.revision !== expected) {
    throw new AppError(409, 'shared_revision_conflict', '共享值已被其他调用更新', {
      current_revision: current?.revision.toString() ?? null,
      retryable: true,
    });
  }
}

function assertWritableSchema(active: number, requested: number) {
  if (active !== requested) {
    throw new AppError(
      409,
      'shared_schema_version_unsupported',
      '共享值 schemaVersion 未声明或当前不可写',
      {
        active_schema_version: active,
        requested_schema_version: requested,
      }
    );
  }
}

function assertReadableSchema(active: number, stored: number) {
  if (active !== stored) {
    throw new AppError(
      409,
      'shared_schema_version_unsupported',
      '当前调用方不支持该共享值 schemaVersion',
      {
        active_schema_version: active,
        stored_schema_version: stored,
      }
    );
  }
}

function assertSharedSchemaValue(schema: unknown, value: unknown, message: string) {
  try {
    assertActionValue(schema, value, 'input');
  } catch {
    throw new AppError(409, 'shared_schema_validation_failed', message);
  }
}

type SharedArtifactRefValue = {
  type: 'artifact_ref';
  artifact_id: string;
  media_type: string;
  size_bytes: number;
  sha256: string;
  authorization: { scope: 'TEAM'; team_id: string; handle: string };
};
function collectArtifactRefs(
  value: unknown,
  pointer = ''
): Array<{ ref: SharedArtifactRefValue; pointer: string }> {
  if (!value || typeof value !== 'object') return [];
  if (!Array.isArray(value) && (value as { type?: unknown }).type === 'artifact_ref')
    return [{ ref: value as SharedArtifactRefValue, pointer }];
  return Object.entries(value).flatMap(([key, child]) =>
    collectArtifactRefs(child, `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`)
  );
}

function sharedArtifactTarget(
  namespaceId: string,
  generation: number,
  key: string,
  revision: bigint
) {
  return `${namespaceId}:${generation}:${key}:${revision.toString()}`;
}
function sharedArtifactScope(
  namespaceId: string,
  generation: number,
  key: string,
  revision: bigint,
  artifactId: string,
  jsonPointer: string
) {
  return {
    namespace_id: namespaceId,
    namespace_generation: generation,
    key,
    value_revision: revision.toString(),
    artifact_id: artifactId,
    json_pointer: jsonPointer,
  };
}

function isOwner(principal: SharedInvocationPrincipal, locator: SharedNamespaceLocator): boolean {
  if (locator.ownerKind === 'PACKAGE') return locator.ownerId === principal.packageId;
  return locator.ownerId === principal.workflowReleaseId;
}

function toPrismaJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
}

function publicValue(
  row: StoredValue,
  artifacts: Array<{
    namespaceId: string;
    namespaceGeneration: number;
    key: string;
    valueRevision: bigint;
    artifactId: string;
    jsonPointer: string;
    executionKind: string;
  }> = []
) {
  return {
    namespace_id: row.namespaceId,
    namespace_generation: row.namespaceGeneration,
    key: row.key,
    value: row.valueJson,
    schema_version: row.schemaVersion,
    value_bytes: row.valueBytes,
    revision: row.revision.toString(),
    created_by_user_id: row.createdByUserId,
    created_by_package_id: row.createdByPackageId,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    artifacts: artifacts.map((edge) => ({
      namespace_id: edge.namespaceId,
      namespace_generation: edge.namespaceGeneration,
      key: edge.key,
      value_revision: edge.valueRevision.toString(),
      artifact_id: edge.artifactId,
      json_pointer: edge.jsonPointer,
      execution_kind: edge.executionKind,
    })),
  };
}

function publicChange(row: {
  namespaceId: string;
  namespaceGeneration: number;
  cursor: bigint;
  key: string;
  revision: bigint;
  schemaVersion: number | null;
  eventKind: 'UPSERT' | 'DELETE';
  createdAt: Date;
}) {
  return {
    namespace_id: row.namespaceId,
    namespace_generation: row.namespaceGeneration,
    cursor: row.cursor.toString(),
    key: row.key,
    revision: row.revision.toString(),
    schema_version: row.schemaVersion,
    event_kind: row.eventKind,
    created_at: row.createdAt.toISOString(),
  };
}

function publicNamespaceLifecycle(row: {
  id: string;
  generation: number;
  activeSchemaVersion: number;
  nextValueRevision: bigint;
  nextChangeCursor: bigint;
  usedBytes: number;
  deletedAt: Date | null;
}) {
  return {
    namespace_id: row.id,
    namespace_generation: row.generation,
    active_schema_version: row.activeSchemaVersion,
    next_value_revision: row.nextValueRevision.toString(),
    next_change_cursor: row.nextChangeCursor.toString(),
    used_bytes: row.usedBytes,
    deleted_at: row.deletedAt?.toISOString() ?? null,
  };
}

function publicNamespaceAdmin(row: {
  id: string;
  teamId: string;
  ownerKind: 'PACKAGE' | 'WORKFLOW';
  ownerId: string;
  name: string;
  generation: number;
  deletedAt: Date | null;
  activeSchemaVersion: number;
  nextValueRevision: bigint;
  nextChangeCursor: bigint;
  usedBytes: number;
  quotaBytes: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    namespace_id: row.id,
    team_id: row.teamId,
    owner_kind: row.ownerKind,
    owner_id: row.ownerId,
    name: row.name,
    generation: row.generation,
    deleted_at: row.deletedAt?.toISOString() ?? null,
    active_schema_version: row.activeSchemaVersion,
    next_value_revision: row.nextValueRevision.toString(),
    next_change_cursor: row.nextChangeCursor.toString(),
    used_bytes: row.usedBytes,
    quota_bytes: row.quotaBytes,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function redactArtifactHandles(value: Prisma.JsonValue): Prisma.JsonValue {
  if (Array.isArray(value)) return value.map(redactArtifactHandles);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, Prisma.JsonValue>;
  if (
    record.type === 'artifact_ref' &&
    record.authorization &&
    typeof record.authorization === 'object' &&
    !Array.isArray(record.authorization)
  ) {
    const authorization = record.authorization as Record<string, Prisma.JsonValue>;
    const { handle: _handle, ...publicAuthorization } = authorization;
    return { ...record, authorization: publicAuthorization };
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, child]) => [key, redactArtifactHandles(child)])
  );
}

function sharedNotFound(code: string, message: string) {
  return new AppError(404, code, message);
}

function isRetryableTransactionError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === 'P2034' || error.code === 'P2002')
  );
}
