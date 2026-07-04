// PlatformApiKeyService 单测：锁定团队共享 Key 的轮换与脱敏列表契约。
import { describe, expect, it, vi } from 'vitest';
import { PlatformApiKeyService } from './api-key.service';
import type { PrismaService } from '../prisma.service';

const now = new Date('2026-07-05T00:00:00.000Z');

function apiKey(overrides: Partial<{
  id: string;
  teamId: string;
  name: string;
  keyPrefix: string;
  keyHash: string;
  scopes: string[];
  status: string;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
}> = {}) {
  return {
    id: 'key-1',
    teamId: 'team-1',
    name: '团队共享 Key',
    keyPrefix: 'lf_12345678',
    keyHash: 'stored-hash',
    scopes: ['*'],
    status: 'ACTIVE',
    lastUsedAt: null,
    expiresAt: null,
    createdAt: now,
    ...overrides,
  };
}

function mockPrisma() {
  const tx = {
    platformApiKey: {
      updateMany: vi.fn(),
      create: vi.fn(),
    },
  };
  const prisma = {
    platformApiKey: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    $transaction: vi.fn(async (fn: (tx: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaService;
  return { prisma, tx };
}

describe('PlatformApiKeyService team shared key contract', () => {
  it('rotateForTeamAdmin disables active team keys and creates one no-expiry key', async () => {
    const { prisma, tx } = mockPrisma();
    vi.mocked(tx.platformApiKey.create).mockImplementation(async ({ data }) => apiKey({
      id: 'key-new',
      teamId: data.teamId,
      name: data.name,
      keyPrefix: data.keyPrefix,
      keyHash: data.keyHash,
      scopes: data.scopes,
      status: data.status,
      expiresAt: data.expiresAt,
    }) as never);
    const service = new PlatformApiKeyService(prisma);

    const result = await service.rotateForTeamAdmin('user-1', 'team-1', {
      name: '  新团队 Key  ',
      scopes: ['chat', 'image'],
    });

    expect(tx.platformApiKey.updateMany).toHaveBeenCalledWith({
      where: { teamId: 'team-1', status: 'ACTIVE' },
      data: { status: 'DISABLED' },
    });
    expect(tx.platformApiKey.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        teamId: 'team-1',
        name: '新团队 Key',
        scopes: ['chat', 'image'],
        status: 'ACTIVE',
        createdById: 'user-1',
        expiresAt: null,
      }),
    });
    expect(result.plaintextKey).toMatch(/^lf_[a-f0-9]{32}$/);
    expect(result.keyPrefix).toBe(result.plaintextKey.slice(0, 'lf_'.length + 8));
    expect((result as Record<string, unknown>).keyHash).toBeUndefined();
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorUserId: 'user-1',
        action: 'apikey.rotated',
        targetType: 'PlatformApiKey',
        targetId: 'key-new',
      }),
    });
  });

  it('listForTeam returns only public fields', async () => {
    const { prisma } = mockPrisma();
    vi.mocked(prisma.platformApiKey.findMany).mockResolvedValueOnce([
      apiKey({ keyHash: 'secret-hash', lastUsedAt: now }),
    ] as never);
    const service = new PlatformApiKeyService(prisma);

    const result = await service.listForTeam('team-1');

    expect(prisma.platformApiKey.findMany).toHaveBeenCalledWith({
      where: { teamId: 'team-1' },
      orderBy: { createdAt: 'desc' },
    });
    expect(result.apiKeys).toEqual([
      {
        id: 'key-1',
        teamId: 'team-1',
        name: '团队共享 Key',
        keyPrefix: 'lf_12345678',
        scopes: ['*'],
        status: 'ACTIVE',
        lastUsedAt: now.toISOString(),
        expiresAt: null,
        createdAt: now.toISOString(),
      },
    ]);
    expect((result.apiKeys[0] as Record<string, unknown>).keyHash).toBeUndefined();
    expect((result.apiKeys[0] as Record<string, unknown>).plaintextKey).toBeUndefined();
  });
});
