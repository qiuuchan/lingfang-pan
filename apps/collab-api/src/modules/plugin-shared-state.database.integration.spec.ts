import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../prisma.service';
import { PluginSharedStateService, type SharedInvocationPrincipal, type SharedNamespaceLocator } from './plugin-shared-state.service';

const enabled = process.env.SHARED_STATE_DATABASE_INTEGRATION === '1';
const databaseDescribe = enabled ? describe : describe.skip;
const suffix = randomUUID();
const teamId = randomUUID();
const userId = randomUUID();
const packageId = randomUUID();
const releaseId = randomUUID();

const principal: SharedInvocationPrincipal = {
  invocationId: `invocation-${suffix}`,
  userId,
  teamId,
  packageId,
  releaseId,
  releaseSha256: 'a'.repeat(64),
  actionId: 'shared.run',
  actionContractVersion: '1.0.0',
  actionSurfaceSha256: 'b'.repeat(64),
  workflowReleaseId: null,
};

let prisma: PrismaService;
let service: PluginSharedStateService;

databaseDescribe(`PluginSharedStateService database integration (${process.env.DATABASE_PROVIDER || 'unknown'})`, () => {
  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    await prisma.team.create({ data: { id: teamId, name: `Shared Integration ${suffix}`, slug: `shared-${suffix}` } });
    await prisma.user.create({ data: { id: userId, email: `shared-${suffix}@example.test`, displayName: 'Shared Integration', passwordHash: 'not-used' } });
    await prisma.pluginPackage.create({
      data: {
        id: packageId,
        ownerTeamId: teamId,
        authorUserId: userId,
        manifestId: `test.shared.${suffix}`,
        name: 'Shared Integration Plugin',
      },
    });
    await prisma.pluginRelease.create({
      data: {
        id: releaseId,
        packageId,
        version: '1.0.0',
        manifest: fixtureManifest(),
        artifactKey: `integration/${suffix}.lfplugin`,
        sha256: principal.releaseSha256,
        sizeBytes: 1,
        aiPolicyVersion: 1,
        aiPolicyStatus: 'PASSED',
      },
    });
    const governance = { authorizeRelease: vi.fn(async () => ({ decision: { allowed: true, reason_code: 'allowed', reason: 'allowed' } })) };
    const artifacts = {
      releaseSharedValueTx: vi.fn(async () => undefined),
      bindSharedValueTx: vi.fn(async () => undefined),
      exchangeSharedValueTx: vi.fn(async () => undefined),
    };
    service = new PluginSharedStateService(prisma, governance as never, artifacts as never);
  }, 60_000);

  afterAll(async () => {
    if (!prisma) return;
    await prisma.pluginRelease.deleteMany({ where: { packageId } });
    await prisma.pluginPackage.deleteMany({ where: { id: packageId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.team.deleteMany({ where: { id: teamId } });
    await prisma.$disconnect();
  }, 30_000);

  it('allows only one concurrent CAS winner and prevents delete-recreate ABA', async () => {
    const locator = locate('cas');
    const initial = await service.set(principal, locator, 'asset', { value: { name: 'initial' }, schema_version: 1 });
    const outcomes = await Promise.allSettled([
      service.set(principal, locator, 'asset', { value: { name: 'writer-a' }, schema_version: 1, expected_revision: initial.revision }),
      service.set(principal, locator, 'asset', { value: { name: 'writer-b' }, schema_version: 1, expected_revision: initial.revision }),
    ]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(rejected?.reason).toMatchObject({ status: 409, code: 'shared_revision_conflict', details: { retryable: true } });

    const current = await service.get(principal, locator, 'asset');
    const deleted = await service.delete(principal, locator, 'asset', current.revision);
    const recreated = await service.set(principal, locator, 'asset', { value: { name: 'recreated' }, schema_version: 1 });
    expect(BigInt(deleted.revision)).toBeGreaterThan(BigInt(current.revision));
    expect(BigInt(recreated.revision)).toBeGreaterThan(BigInt(deleted.revision));
    await expect(service.set(principal, locator, 'asset', {
      value: { name: 'stale-writer' },
      schema_version: 1,
      expected_revision: current.revision,
    })).rejects.toMatchObject({ status: 409, code: 'shared_revision_conflict', details: { current_revision: recreated.revision, retryable: true } });
  }, 30_000);

  it('preserves namespace identity and allocators across delete and reactivate generations', async () => {
    const locator = locate('generation');
    const first = await service.set(principal, locator, 'a', { value: { name: 'a' }, schema_version: 1 });
    await service.set(principal, locator, 'b', { value: { name: 'b' }, schema_version: 1 });
    const before = await namespace(locator);

    const deleted = await service.deleteNamespace(principal, locator);
    expect(deleted.namespace_id).toBe(before.id);
    expect(deleted.namespace_generation).toBe(before.generation + 1);
    expect(BigInt(deleted.next_value_revision)).toBeGreaterThan(before.nextValueRevision);
    expect(BigInt(deleted.next_change_cursor)).toBeGreaterThan(before.nextChangeCursor);
    await expect(prisma.pluginSharedValue.count({ where: { namespaceId: before.id } })).resolves.toBe(0);

    const reactivated = await service.reactivateNamespace(principal, locator, { active_schema_version: 1 });
    expect(reactivated.namespace_id).toBe(before.id);
    expect(reactivated.namespace_generation).toBe(deleted.namespace_generation + 1);
    expect(reactivated.next_value_revision).toBe(deleted.next_value_revision);
    expect(reactivated.next_change_cursor).toBe(deleted.next_change_cursor);
    await expect(service.set(principal, locator, 'a', {
      value: { name: 'stale-generation' },
      schema_version: 1,
      expected_revision: first.revision,
    })).rejects.toMatchObject({ status: 409, code: 'shared_revision_conflict' });
    const fresh = await service.set(principal, locator, 'a', { value: { name: 'fresh-generation' }, schema_version: 1 });
    expect(fresh.namespace_generation).toBe(reactivated.namespace_generation);
    expect(BigInt(fresh.revision)).toBeGreaterThan(BigInt(reactivated.next_value_revision));
  }, 30_000);

  it('validates migration schemas, uses CAS, and rolls back active schema on transactional failure', async () => {
    const locator = locate('migration');
    const initial = await service.set(principal, locator, 'asset', { value: { name: 'version-one' }, schema_version: 1 });
    await expect(service.migrate(principal, locator, 'asset', {
      value: { name: 'still-v1' },
      source_schema_version: 1,
      target_schema_version: 2,
      expected_revision: initial.revision,
    })).rejects.toMatchObject({ status: 409, code: 'shared_schema_validation_failed' });

    const migrated = await service.migrate(principal, locator, 'asset', {
      value: { label: 'version-two' },
      source_schema_version: 1,
      target_schema_version: 2,
      expected_revision: initial.revision,
    });
    expect(migrated.schema_version).toBe(2);
    const updated = await service.set(principal, locator, 'asset', {
      value: { label: 'concurrent-update' },
      schema_version: 2,
      expected_revision: migrated.revision,
    });
    await expect(service.migrate(principal, locator, 'asset', {
      value: { label: 'stale-migration' },
      source_schema_version: 1,
      target_schema_version: 2,
      expected_revision: initial.revision,
    })).rejects.toMatchObject({ status: 409, code: 'shared_revision_conflict', details: { current_revision: updated.revision } });

    const rollbackLocator = locate('migration.rollback');
    const rollbackValue = await service.set(principal, rollbackLocator, 'asset', { value: { name: 'small' }, schema_version: 1 });
    const rollbackNamespace = await namespace(rollbackLocator);
    await prisma.pluginSharedNamespace.update({
      where: { id: rollbackNamespace.id },
      data: { quotaBytes: rollbackNamespace.usedBytes },
    });
    await expect(service.migrate(principal, rollbackLocator, 'asset', {
      value: { label: 'a much larger migrated value' },
      source_schema_version: 1,
      target_schema_version: 2,
      expected_revision: rollbackValue.revision,
    })).rejects.toMatchObject({ status: 413, code: 'shared_namespace_quota_exceeded' });
    const afterFailure = await namespace(rollbackLocator);
    const storedAfterFailure = await prisma.pluginSharedValue.findUniqueOrThrow({
      where: { namespaceId_key: { namespaceId: rollbackNamespace.id, key: 'asset' } },
    });
    expect(afterFailure.activeSchemaVersion).toBe(1);
    expect(storedAfterFailure.schemaVersion).toBe(1);
    expect(storedAfterFailure.revision.toString()).toBe(rollbackValue.revision);
  }, 30_000);
});

function locate(name: string): SharedNamespaceLocator {
  return { ownerKind: 'PACKAGE', ownerId: packageId, name };
}

async function namespace(locator: SharedNamespaceLocator) {
  return prisma.pluginSharedNamespace.findUniqueOrThrow({
    where: { teamId_ownerKind_ownerId_name: { teamId, ownerKind: locator.ownerKind, ownerId: locator.ownerId, name: locator.name } },
  });
}

function fixtureManifest() {
  const schemaV1 = {
    type: 'object',
    additionalProperties: false,
    properties: { name: { type: 'string', minLength: 1 } },
    required: ['name'],
  };
  const schemaV2 = {
    type: 'object',
    additionalProperties: false,
    properties: { label: { type: 'string', minLength: 1 } },
    required: ['label'],
  };
  const declaration = (name: string) => ({
    name,
    active_schema_version: 1,
    read_purpose: 'Read shared integration state',
    write_purpose: 'Write shared integration state',
    schemas: [
      { schema_version: 1, schema: schemaV1 },
      { schema_version: 2, schema: schemaV2 },
    ],
  });
  return {
    id: `test.shared.${suffix}`,
    name: 'Shared Integration Plugin',
    version: '1.0.0',
    runtime_type: 'client',
    entry: 'index.html',
    shared_namespaces: ['cas', 'generation', 'migration', 'migration.rollback'].map(declaration),
  };
}
