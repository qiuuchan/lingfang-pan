import { describe, expect, it, vi } from 'vitest';
import { PluginService } from './plugin.service';

const now = new Date('2026-06-12T00:00:00.000Z');

function createService(options: {
  existingPlugin?: unknown;
  /** 同 manifest.id 匹配到的已有插件（uploadPlugin 升级路径用）；默认 null=无同 id 插件。 */
  sameLogicalPlugin?: unknown;
  membershipRole?: 'MEMBER' | 'TEAM_ADMIN';
} = {}) {
  const pluginFindUnique = vi.fn(async () => options.existingPlugin || null);
  // findFirst：uploadPlugin 按 manifest.id 查同 id 插件（升级判定）。默认无。
  const pluginFindFirst = vi.fn(async () => options.sameLogicalPlugin || null);
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
      findFirst: pluginFindFirst,
      create: pluginCreate,
      update: pluginUpdate,
    },
    pluginInstallation: {
      findMany: vi.fn(async () => []),
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
  // NotificationService mock：新版本推送通知（editPluginDraft 已上架更新时调用）。
  const notifications = {
    create: vi.fn(async () => ({})),
  };
  return { service: new PluginService(prisma as never, auth as never, grants as never, notifications as never), prisma, auth, grants, notifications };
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

  it('同 manifest.id 不同版本 → 委托 editPluginDraft in-place 升级（upgraded:true，不新建）', async () => {
    // 团队内已有 manifest.id='timer' v0.1.0（未上架 DRAFT）；上传同 id 的 v0.2.0。
    const sameLogical = existingPluginRecord({ id: 'plugin-existing', version: '0.1.0' });
    // existingPlugin 同时作 update mock 的基底（保证 createdAt/updatedAt 等 publicPlugin 需要的字段）。
    const { service, prisma } = createService({ sameLogicalPlugin: sameLogical, existingPlugin: sameLogical });
    // findUnique：第一次（contentHash 去重）返回 null；editPluginDraft 内两次（按 id→plugin、contentHash 重复→null）。
    let findUniqueCalls = 0;
    (prisma.plugin.findUnique as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      findUniqueCalls += 1;
      // 第 1、3 次（contentHash 查询）返回 null；第 2 次（按 id）返回 sameLogical。
      return findUniqueCalls === 2 ? sameLogical : null;
    });

    const upgradePackage = {
      manifest: { ...validPackage.manifest, version: '0.2.0' },
      files: [{ path: 'ui/index.html', content: '<div>v2</div>' }],
    };
    const result = await service.uploadPlugin('user-1', upgradePackage);

    expect(result.upgraded).toBe(true);
    // 委托 editPluginDraft → 走 update（不 create）。
    expect(prisma.plugin.update).toHaveBeenCalled();
    expect(prisma.plugin.create).not.toHaveBeenCalled();
    // version 升级到 0.2.0。
    expect(result.plugin.version).toBe('0.2.0');
  });

  it('无同 manifest.id → 全新创建（deduplicated:false, 无 upgraded）', async () => {
    const { service, prisma } = createService(); // sameLogical 默认 null

    const result = await service.uploadPlugin('user-1', validPackage);

    expect(result.deduplicated).toBe(false);
    expect(result.upgraded).toBeUndefined();
    expect(prisma.plugin.create).toHaveBeenCalled();
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

describe('PluginService editPluginDraft 已上架插件免重审更新', () => {
  // 已上架插件（APPROVED + marketplace=true）更新源码：保留 APPROVED，不重置 DRAFT，直接生效。
  function livePlugin(version = '1.0.0') {
    return {
      id: 'plugin-1',
      teamId: 'team-1',
      authorUserId: 'user-1',
      name: '番茄钟',
      version,
      reviewStatus: 'APPROVED',
      marketplace: true,
      visibility: 'PUBLIC',
      runtimeType: 'client',
      entry: 'ui/index.html',
      manifest: { id: 'timer', name: '番茄钟', version, runtime_type: 'client', entry: 'ui/index.html' },
      files: [],
      capabilities: [],
      contentHash: 'old-hash',
      status: 'ENABLED',
      priceCents: 0,
      installCount: 1,
      ratingCount: 0,
      ratingSum: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  function updatedPackage(version: string) {
    return {
      manifest: { ...validPackage.manifest, version, id: 'timer', name: '番茄钟', runtime_type: 'client', entry: 'ui/index.html' },
      files: validPackage.files,
    };
  }

  it('已上架插件升版本 → 保留 APPROVED + marketplace（不重审）', async () => {
    const { service, prisma } = createService({ existingPlugin: livePlugin('1.0.0') });
    const result = await service.editPluginDraft('user-1', 'plugin-1', updatedPackage('1.1.0') as never);
    // 审核态保留 APPROVED + marketplace=true（未重置 DRAFT）。
    expect(result.plugin.reviewStatus).toBe('APPROVED');
    expect(prisma.plugin.update).toHaveBeenCalled();
    const updateData = prisma.plugin.update.mock.calls[0][0].data;
    expect(updateData.version).toBe('1.1.0');
    expect(updateData.reviewStatus).toBeUndefined(); // 未传 reviewStatus = 不改
  });

  it('已上架插件降版本 → 拒绝（版本号只能递增）', async () => {
    const { service } = createService({ existingPlugin: livePlugin('1.2.0') });
    await expect(service.editPluginDraft('user-1', 'plugin-1', updatedPackage('1.1.0') as never))
      .rejects.toMatchObject({ code: 'bad_request' });
  });

  it('已上架插件同版本 → 拒绝', async () => {
    const { service } = createService({ existingPlugin: livePlugin('1.0.0') });
    await expect(service.editPluginDraft('user-1', 'plugin-1', updatedPackage('1.0.0') as never))
      .rejects.toMatchObject({ code: 'bad_request' });
  });

  it('已上架插件更新 → 推送新版本通知给旧版本用户', async () => {
    const { service, notifications, prisma } = createService({ existingPlugin: livePlugin('1.0.0') });
    // mock：1 个安装了旧版本的用户。
    prisma.pluginInstallation.findMany.mockResolvedValueOnce([
      { installedById: 'user-buyer', version: '1.0.0' },
    ]);
    await service.editPluginDraft('user-1', 'plugin-1', updatedPackage('1.1.0') as never);
    // 应向旧版本用户推送 new_version 通知。
    expect(notifications.create).toHaveBeenCalledWith(
      'user-buyer', 'new_version', '插件有新版本',
      expect.stringContaining('1.1.0'),
      expect.objectContaining({ relatedType: 'Plugin', relatedId: 'plugin-1' }),
    );
  });
});
