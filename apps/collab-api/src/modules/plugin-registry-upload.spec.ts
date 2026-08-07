import { Readable } from 'node:stream';
import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
