import { describe, expect, it, vi } from 'vitest';
import { PluginService } from './plugin.service';

const now = new Date('2026-06-12T00:00:00.000Z');

function createService(options: {
  existingPlugin?: unknown;
  membershipRole?: 'MEMBER' | 'TEAM_ADMIN';
} = {}) {
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
  // update mock：回显合并后的数据（叠加 existingPlugin 基底），供 editPluginMeta 等更新路径断言。
  const pluginUpdate = vi.fn(async ({ data }) => ({
    ...(options.existingPlugin as Record<string, unknown> || {}),
    ...data,
    updatedAt: now,
  }));
  const prisma = {
    plugin: {
      findUnique: pluginFindUnique,
      create: pluginCreate,
      update: pluginUpdate,
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
  return { service: new PluginService(prisma as never, auth as never, grants as never), prisma, auth, grants };
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

// 构造一条已存在插件记录（供 editPluginMeta 等更新路径测试复用）。
function existingPluginRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'plugin-1',
    name: '番茄钟',
    description: '原描述',
    version: '0.1.0',
    entry: 'ui/index.html',
    runtimeType: 'CLIENT',
    status: 'ENABLED',
    visibility: 'TEAM',
    teamId: 'team-1',
    authorUserId: 'user-1',
    files: validPackage.files,
    manifest: { ...validPackage.manifest },
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
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('PluginService editPluginMeta', () => {
  it('改名称/描述/图标：浅合并 manifest、同步顶层字段、不重置审核态', async () => {
    const { service, prisma } = createService({ existingPlugin: existingPluginRecord() });

    const result = await service.editPluginMeta('user-1', 'plugin-1', {
      name: '新名字',
      description: '新描述',
      icon: '🍅',
    });

    // 顶层 name/description 同步更新，reviewStatus 不动（仍 DRAFT，未被打回）。
    expect(prisma.plugin.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'plugin-1' },
      data: expect.objectContaining({ name: '新名字', description: '新描述' }),
    }));
    const updateArg = prisma.plugin.update.mock.calls[0][0] as { data: Record<string, unknown> };
    // 不应包含任何治理字段（reviewStatus/marketplace/files/contentHash）。
    expect(updateArg.data).not.toHaveProperty('reviewStatus');
    expect(updateArg.data).not.toHaveProperty('contentHash');
    expect(updateArg.data).not.toHaveProperty('files');
    // manifest 浅合并：保留 entry/runtime_type，写入新 name/description/icon。
    const manifest = updateArg.data.manifest as Record<string, unknown>;
    expect(manifest.entry).toBe('ui/index.html');
    expect(manifest.runtime_type).toBe('client');
    expect(manifest.name).toBe('新名字');
    expect(manifest.icon).toBe('🍅');
    expect(result.plugin.name).toBe('新名字');
  });

  it('空图标串清除 manifest.icon', async () => {
    const { service, prisma } = createService({
      existingPlugin: existingPluginRecord({ manifest: { ...validPackage.manifest, icon: '🍅' } }),
    });

    await service.editPluginMeta('user-1', 'plugin-1', { icon: '' });

    const updateArg = prisma.plugin.update.mock.calls[0][0] as { data: { manifest: Record<string, unknown> } };
    expect(updateArg.data.manifest).not.toHaveProperty('icon');
  });

  it('审核中(PENDING)的插件不能编辑', async () => {
    const { service } = createService({ existingPlugin: existingPluginRecord({ reviewStatus: 'PENDING' }) });

    await expect(service.editPluginMeta('user-1', 'plugin-1', { name: 'x' }))
      .rejects.toMatchObject({ code: 'conflict' });
  });

  it('已上架(APPROVED+marketplace)允许仅改元数据', async () => {
    const { service, prisma } = createService({
      existingPlugin: existingPluginRecord({ reviewStatus: 'APPROVED', marketplace: true }),
    });

    await service.editPluginMeta('user-1', 'plugin-1', { description: '改个描述' });

    expect(prisma.plugin.update).toHaveBeenCalled();
  });

  it('拒绝 SVG 图标（防内联脚本 XSS）', async () => {
    const { service } = createService({ existingPlugin: existingPluginRecord() });

    await expect(service.editPluginMeta('user-1', 'plugin-1', {
      icon: 'data:image/svg+xml;base64,PHN2Zz4=',
    })).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('非作者且非团队管理员不能编辑', async () => {
    const { service } = createService({
      existingPlugin: existingPluginRecord({ authorUserId: 'other-user' }),
      membershipRole: 'MEMBER',
    });

    await expect(service.editPluginMeta('user-1', 'plugin-1', { name: 'x' }))
      .rejects.toMatchObject({ code: 'forbidden' });
  });

  it('未提供任何字段时报错', async () => {
    const { service } = createService({ existingPlugin: existingPluginRecord() });

    await expect(service.editPluginMeta('user-1', 'plugin-1', {}))
      .rejects.toMatchObject({ code: 'bad_request' });
  });
});
