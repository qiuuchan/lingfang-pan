import { Readable } from 'node:stream';
import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./plugin-artifact', async (importOriginal) => {
  const original = await importOriginal<typeof import('./plugin-artifact')>();
  return { ...original, inspectPluginArtifact: vi.fn() };
});

import { inspectPluginArtifact } from './plugin-artifact';
import { PluginRegistryService } from './plugin-registry.service';

const now = new Date('2026-07-12T00:00:00.000Z');
const packageId = '11111111-1111-4111-8111-111111111111';
const teamId = '22222222-2222-4222-8222-222222222222';
const userId = '33333333-3333-4333-8333-333333333333';
const releaseId = '44444444-4444-4444-8444-444444444444';

describe('PluginRegistryService upload provenance', () => {
  beforeEach(() => vi.clearAllMocks());

  it('persists and returns normalized release provenance from an uploaded artifact', async () => {
    const manifest = {
      id: 'team.external-demo',
      name: 'External Demo',
      description: 'Imported from another coding tool',
      version: '1.2.3',
      entry: 'main.js',
      runtime_type: 'nodejs',
      visibility: 'team',
      capabilities: [],
    };
    const readmeMarkdown = '# External Demo\n\nImported safely.';
    vi.mocked(inspectPluginArtifact).mockResolvedValue({
      meta: { format: 'lingfang-plugin', formatVersion: 4 },
      manifest,
      files: [{ path: 'main.js', sizeBytes: 17, sha256: 'b'.repeat(64) }],
      policyFiles: [{ path: 'main.js', content: 'console.log("ok")' }],
      readmeMarkdown,
      workflowDefinition: null,
    } as never);

    const pkg = {
      id: packageId,
      ownerTeamId: teamId,
      authorUserId: userId,
      manifestId: manifest.id,
      name: manifest.name,
      description: manifest.description,
      governanceStatus: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    };
    const releaseCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: releaseId,
      ...data,
      targetPlatform: 'windows-x64',
      status: 'PUBLISHED',
      marketReviewStatus: 'DRAFT',
      reviewReason: '',
      createdAt: now,
    }));
    const auditCreate = vi.fn().mockResolvedValue({});
    const tx = {
      pluginPackage: {
        findUnique: vi.fn().mockResolvedValue(pkg),
        update: vi.fn().mockResolvedValue(pkg),
      },
      pluginRelease: { create: releaseCreate },
      auditLog: { create: auditCreate },
    };
    const prisma = {
      pluginPackage: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(pkg),
      },
      pluginRelease: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
    };
    const artifacts = { promote: vi.fn().mockResolvedValue(undefined), delete: vi.fn() };
    const registry = new PluginRegistryService(
      prisma as never,
      {
        ensureCurrentTeam: vi.fn().mockResolvedValue({ teamId, role: 'TEAM_ADMIN' }),
        ensurePermission: vi.fn(),
      } as never,
      artifacts as never
    );

    const sourceLabelBase64 = Buffer.from('Cursor workspace', 'utf8').toString('base64url');
    const result = await registry.publishTeamRelease(
      userId,
      Readable.from([Buffer.from('test-artifact')]),
      undefined,
      undefined,
      { sourceKind: 'external_tool', sourceLabelBase64, ingestChannel: 'desktop' }
    );

    expect(releaseCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        packageId,
        sourceKind: 'EXTERNAL_TOOL',
        sourceLabel: 'Cursor workspace',
        ingestChannel: 'DESKTOP',
        createdById: userId,
        readmeMarkdown,
      }),
    });
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'plugin.release.published',
        metadata: expect.objectContaining({
          sourceKind: 'EXTERNAL_TOOL',
          sourceLabel: 'Cursor workspace',
          ingestChannel: 'DESKTOP',
        }),
      }),
    });
    expect(result.release).toMatchObject({
      id: releaseId,
      sourceKind: 'EXTERNAL_TOOL',
      sourceLabel: 'Cursor workspace',
      ingestChannel: 'DESKTOP',
    });
    expect(result.release).not.toHaveProperty('readme_markdown');
    expect(artifacts.promote).toHaveBeenCalledOnce();
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
  });
});

/**
 * NEW-6：上传失败回滚路径的共享制品清理。
 * artifactKey 是内容寻址、跨 release 复用的共享制品，引用计数查询一旦被降级成 0，
 * DB 抖动就会删掉仍被其他 release 引用的制品（不可逆数据丢失）。
 */
describe('PluginRegistryService 上传失败回滚的制品引用计数', () => {
  const transactionError = new Error('发布事务落库失败');

  /** 组装一次「promote 成功、发布事务失败」的回滚现场，count 行为由入参决定。 */
  const buildRollbackHarness = (count: ReturnType<typeof vi.fn>) => {
    const manifest = {
      id: 'team.rollback-demo',
      name: 'Rollback Demo',
      description: '回滚路径用例',
      version: '1.0.0',
      entry: 'main.js',
      runtime_type: 'nodejs',
      visibility: 'team',
      capabilities: [],
    };
    vi.mocked(inspectPluginArtifact).mockResolvedValue({
      meta: { format: 'lingfang-plugin', formatVersion: 4 },
      manifest,
      files: [{ path: 'main.js', sizeBytes: 17, sha256: 'b'.repeat(64) }],
      policyFiles: [{ path: 'main.js', content: 'console.log("ok")' }],
      readmeMarkdown: '# Rollback Demo',
      workflowDefinition: null,
    } as never);

    const pkg = {
      id: packageId,
      ownerTeamId: teamId,
      authorUserId: userId,
      manifestId: manifest.id,
      name: manifest.name,
      description: manifest.description,
      governanceStatus: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    };
    const prisma = {
      pluginPackage: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(pkg),
      },
      pluginRelease: { findUnique: vi.fn().mockResolvedValue(null), count },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      $transaction: vi.fn().mockRejectedValue(transactionError),
    };
    const artifacts = {
      promote: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const registry = new PluginRegistryService(
      prisma as never,
      {
        ensureCurrentTeam: vi.fn().mockResolvedValue({ teamId, role: 'TEAM_ADMIN' }),
        ensurePermission: vi.fn(),
      } as never,
      artifacts as never
    );
    const publish = () =>
      registry.publishTeamRelease(userId, Readable.from([Buffer.from('rollback-artifact')]));
    return { prisma, artifacts, publish };
  };

  let loggerError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    loggerError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => loggerError.mockRestore());

  // 反向用例：引用计数查询故障绝不能降级成「无人引用」。
  it('引用计数查询失败时跳过删除，并把原始上传失败异常向上抛', async () => {
    const count = vi.fn().mockRejectedValue(new Error('数据库连接抖动'));
    const { artifacts, publish } = buildRollbackHarness(count);

    await expect(publish()).rejects.toThrow(transactionError);

    expect(count).toHaveBeenCalledOnce();
    expect(artifacts.promote).toHaveBeenCalledOnce();
    expect(artifacts.delete).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledWith(
      expect.objectContaining({ artifactKey: expect.stringContaining(packageId) }),
      '引用计数查询失败，保守跳过制品清理'
    );
  });

  // 正向用例：确实无人引用时仍要把孤儿制品删掉。
  it('引用计数为 0 时删除孤儿制品', async () => {
    const count = vi.fn().mockResolvedValue(0);
    const { artifacts, publish } = buildRollbackHarness(count);

    await expect(publish()).rejects.toThrow(transactionError);

    expect(artifacts.delete).toHaveBeenCalledOnce();
    expect(artifacts.delete).toHaveBeenCalledWith(expect.stringContaining(packageId));
  });

  // 正向用例：仍被其他 release 引用时不得删除。
  it('引用计数大于 0 时不删除共享制品', async () => {
    const count = vi.fn().mockResolvedValue(2);
    const { artifacts, publish } = buildRollbackHarness(count);

    await expect(publish()).rejects.toThrow(transactionError);

    expect(artifacts.delete).not.toHaveBeenCalled();
  });

  // 删除本身失败仍要静默兜底，但必须留痕。
  it('孤儿制品删除失败时记录错误日志且不改变抛出的异常', async () => {
    const count = vi.fn().mockResolvedValue(0);
    const { artifacts, publish } = buildRollbackHarness(count);
    artifacts.delete.mockRejectedValue(new Error('对象存储不可用'));

    await expect(publish()).rejects.toThrow(transactionError);

    expect(loggerError).toHaveBeenCalledWith(
      expect.objectContaining({ artifactKey: expect.stringContaining(packageId) }),
      '上传失败回滚：孤儿制品删除失败，等待定时清理回收'
    );
  });
});
