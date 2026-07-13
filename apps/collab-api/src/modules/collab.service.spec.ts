import { describe, expect, it, vi } from 'vitest';
import { PluginService } from './plugin.service';

const now = new Date('2026-06-12T00:00:00.000Z');

function createService(options: { existingPlugin?: unknown; membershipRole?: 'MEMBER' | 'TEAM_ADMIN' } = {}) {
  const pluginFindUnique = vi.fn(async () => options.existingPlugin || null);
  const pluginCreate = vi.fn(async ({ data }) => ({
    id: 'plugin-1',
    ...data,
    status: data.status || 'ENABLED',
    reviewStatus: data.reviewStatus || 'DRAFT',
    reviewReason: data.reviewReason || '',
    reviewedById: data.reviewedById || null,
    reviewedAt: data.reviewedAt || null,
    marketplace: data.marketplace || false,
    priceCents: data.priceCents || 0,
    installCount: 0,
    ratingCount: 0,
    ratingSum: 0,
    createdAt: now,
    updatedAt: now,
  }));
  const prisma = {
    plugin: {
      findUnique: pluginFindUnique,
      // uploadPlugin 按 manifest.id 查同 id 插件（升级判定）；此 spec 走全新创建路径，返回 null。
      findFirst: vi.fn(async () => null),
      create: pluginCreate,
    },
    auditLog: {
      create: vi.fn(async () => ({})),
    },
  };
  const auth = {
    ensureCurrentTeam: vi.fn(async () => ({
      teamId: 'team-1',
      role: options.membershipRole || 'MEMBER',
      team: { id: 'team-1', status: 'ACTIVE' },
    })),
  };
  // RBAC 插件授权 service mock：默认放行（availablePlugins 调用）。
  const grants = {
    resolvePluginAccess: vi.fn(async () => true),
  };
  return { service: new PluginService(prisma as never, auth as never, grants as never), prisma, auth };
}

const validPackage = {
  manifest: {
    id: 'timer',
    name: '番茄钟',
    version: '0.1.0',
    description: '可配置时长的计时器',
    runtime_type: 'client',
    entry: 'ui/index.html',
    visibility: 'tenant',
    capabilities: [{ kind: 'ui.view', reason: '展示界面', risk: 'low' }],
  },
  files: [
    { path: 'manifest.json', content: '{}' },
    { path: 'ui/index.html', content: '<div>timer</div>' },
  ],
};

describe('CollabService plugin cloud sharing', () => {
  it('uploads a valid plugin package into the current team', async () => {
    const { service, prisma } = createService();

    const result = await service.uploadPlugin('user-1', validPackage);

    expect(result.deduplicated).toBe(false);
    expect(result.plugin.teamId).toBe('team-1');
    expect(result.plugin.source).toBe('team');
    expect(result.plugin.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(prisma.plugin.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        name: '番茄钟',
        version: '0.1.0',
        entry: 'ui/index.html',
        runtimeType: 'CLIENT',
        visibility: 'TEAM',
        teamId: 'team-1',
        authorUserId: 'user-1',
      }),
    }));
  });

  it('deduplicates the same content hash inside one team', async () => {
    const existingPlugin = {
      id: 'plugin-existing',
      name: '番茄钟',
      description: '',
      version: '0.1.0',
      entry: 'ui/index.html',
      runtimeType: 'CLIENT',
      status: 'ENABLED',
      visibility: 'TEAM',
      teamId: 'team-1',
      authorUserId: 'user-1',
      files: validPackage.files,
      manifest: validPackage.manifest,
      capabilities: [],
      contentHash: 'a'.repeat(64),
      reviewStatus: 'DRAFT',
      reviewReason: '',
      reviewedById: null,
      reviewedAt: null,
      marketplace: false,
      priceCents: 0,
      installCount: 0,
      ratingCount: 0,
      ratingSum: 0,
      aiPolicyVersion: 1,
      aiPolicyStatus: 'PASSED',
      aiPolicyReason: '',
      createdAt: now,
      updatedAt: now,
    };
    const { service, prisma } = createService({ existingPlugin });

    const result = await service.uploadPlugin('user-1', validPackage);

    expect(result.deduplicated).toBe(true);
    expect(result.plugin.id).toBe('plugin-existing');
    expect(prisma.plugin.create).not.toHaveBeenCalled();
  });

  it('rejects unsafe plugin paths', async () => {
    const { service } = createService();

    await expect(service.uploadPlugin('user-1', {
      manifest: { ...validPackage.manifest, entry: '../ui/index.html' },
      files: validPackage.files,
    })).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('rejects capabilities outside the contract boundary', async () => {
    const { service } = createService();

    await expect(service.uploadPlugin('user-1', {
      manifest: {
        ...validPackage.manifest,
        capabilities: [{ kind: 'shell.exec', reason: '越权能力', risk: 'high' }],
      },
      files: validPackage.files,
    })).rejects.toMatchObject({ code: 'bad_request' });
  });
});
