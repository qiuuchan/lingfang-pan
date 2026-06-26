// ReleaseService 单测：覆盖核心写操作的鉴权、唯一性约束、isLatest 原子维护。
//  - member_cannot_create_release（ensurePlatformAdmin 守卫，403）。
//  - create_conflict_on_duplicate_version（同 channel+version 唯一，409 由 Prisma 映射，此处验 service 层 badRequest 提前拦截）。
//  - publish_sets_is_latest_and_demotes_others（事务：当前 isLatest=true，同 channel 其他=false）。
//  - publish 允许归档版本重新发布（取消归档恢复下载）。
//  - latest_returns_only_published（非 PUBLISHED 不暴露）。
//  - latest_with_current_version_update_available（semver 比较：1.0.0 > 0.9.0）。
// 参考 llm.service.spec.ts：Mock PrismaService + AuthService，不连真实 DB。
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ReleaseService } from './release.service';
import { forbidden } from '../common';

const now = new Date('2026-06-14T00:00:00.000Z');

function makeRelease(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'release-1',
    version: '1.0.0',
    channel: 'STABLE',
    status: 'PUBLISHED',
    title: '首发',
    notes: '## 1.0.0',
    isLatest: true,
    publishedAt: now,
    createdAt: now,
    updatedAt: now,
    assets: [],
    ...overrides,
  };
}

function mockPrisma() {
  const release = {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  };
  const releaseAsset = {
    findUnique: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
  };
  // $transaction：把回调执行器替换为「直接用同一份 tx 对象」（单测不验真实事务隔离，只验调用链）。
  const tx = {
    release: { ...release, updateMany: vi.fn(), update: vi.fn() },
    releaseAsset,
  };
  const $transaction = vi.fn(async (cb: (tx: typeof tx) => Promise<unknown>) => cb(tx));
  return {
    release,
    releaseAsset,
    auditLog: { create: vi.fn() },
    $transaction,
    // tx 对象暴露给断言（updateMany/update 调用记录在此）。
    __tx: tx,
  };
}

function mockAuth() {
  return {
    ensurePlatformAdmin: vi.fn(),
    ensureCurrentTeam: vi.fn(),
    ensureTeamAdmin: vi.fn(),
  };
}

describe('ReleaseService', () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let auth: ReturnType<typeof mockAuth>;
  let service: ReleaseService;

  beforeEach(() => {
    prisma = mockPrisma();
    auth = mockAuth();
    // @ts-expect-error mock 不实现完整 PrismaService 接口，仅测用到的方法。
    service = new ReleaseService(prisma, auth);
  });

  it('非平台管理员创建版本被 ensurePlatformAdmin 拒绝（403）', async () => {
    auth.ensurePlatformAdmin.mockImplementation(() => {
      throw forbidden('仅平台管理员可操作');
    });
    await expect(
      service.create('user-member', { version: '1.0.0' }),
    ).rejects.toMatchObject({ status: 403, code: 'forbidden' });
    expect(prisma.release.create).not.toHaveBeenCalled();
  });

  it('同 channel+version 已存在时 create 抛 bad_request', async () => {
    prisma.release.findUnique.mockResolvedValue(makeRelease());
    await expect(
      service.create('user-admin', { version: '1.0.0', channel: 'STABLE' }),
    ).rejects.toMatchObject({ status: 400, code: 'bad_request' });
    expect(prisma.release.create).not.toHaveBeenCalled();
  });

  it('publish 把当前置 isLatest=true 且同 channel 其他置 false（事务）', async () => {
    prisma.release.findUnique.mockResolvedValue(makeRelease({ status: 'DRAFT', isLatest: false, publishedAt: null }));
    prisma.__tx.release.update.mockResolvedValue(makeRelease({ status: 'PUBLISHED', isLatest: true }));

    await service.publish('user-admin', 'release-1');

    // 1) 同 channel 其他 isLatest=true 被批量取消。
    expect(prisma.__tx.release.updateMany).toHaveBeenCalledWith({
      where: { channel: 'STABLE', isLatest: true, id: { not: 'release-1' } },
      data: { isLatest: false },
    });
    // 2) 当前 status=PUBLISHED + isLatest=true + publishedAt 落库。
    expect(prisma.__tx.release.update).toHaveBeenCalledWith({
      where: { id: 'release-1' },
      data: expect.objectContaining({ status: 'PUBLISHED', isLatest: true }),
    });
    // 3) 审计写入。
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });

  it('publish 允许归档版本重新发布（取消归档，恢复下载）', async () => {
    prisma.release.findUnique.mockResolvedValue(makeRelease({ status: 'ARCHIVED', publishedAt: now }));
    prisma.__tx.release.update.mockResolvedValue(makeRelease({ status: 'PUBLISHED', isLatest: true, publishedAt: now }));
    const result = await service.publish('user-admin', 'release-1');
    expect(result.release.status).toBe('PUBLISHED');
    expect(result.release.isLatest).toBe(true);
    expect(prisma.__tx.release.update).toHaveBeenCalled();
  });

  it('update 移动已发布 latest 到另一 channel 时重建两边 latest', async () => {
    prisma.release.findUnique
      .mockResolvedValueOnce(makeRelease({ id: 'release-1', channel: 'STABLE', version: '1.0.0', status: 'PUBLISHED', isLatest: true }))
      .mockResolvedValueOnce(null);
    prisma.__tx.release.update
      .mockResolvedValueOnce(makeRelease({ id: 'release-1', channel: 'BETA', version: '1.0.0', isLatest: true }))
      .mockResolvedValueOnce(makeRelease({ id: 'release-stable-prev', channel: 'STABLE', version: '0.9.0', isLatest: true }));
    prisma.__tx.release.findFirst.mockResolvedValue(makeRelease({
      id: 'release-stable-prev', channel: 'STABLE', version: '0.9.0', isLatest: false,
    }));

    const result = await service.update('user-admin', 'release-1', { channel: 'BETA' });

    expect(result.release.channel).toBe('BETA');
    expect(prisma.__tx.release.updateMany).toHaveBeenNthCalledWith(1, {
      where: { channel: 'BETA', isLatest: true, id: { not: 'release-1' } },
      data: { isLatest: false },
    });
    expect(prisma.__tx.release.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'release-1' },
      data: { channel: 'BETA', isLatest: true },
    });
    expect(prisma.__tx.release.findFirst).toHaveBeenCalledWith({
      where: { channel: 'STABLE', status: 'PUBLISHED', id: { not: 'release-1' } },
      orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
    });
    expect(prisma.__tx.release.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'release-stable-prev' },
      data: { isLatest: true },
    });
  });

  it('latest 仅返回 PUBLISHED+isLatest 版本', async () => {
    prisma.release.findFirst.mockResolvedValue(makeRelease({ status: 'PUBLISHED', isLatest: true }));
    const result = await service.latest({ channel: 'STABLE' });
    expect(result.version).toBe('1.0.0');
    expect(result.updateAvailable).toBeUndefined(); // 未传 currentVersion
  });

  it('latest 带 currentVersion 时 updateAvailable 正确（1.0.0 > 0.9.0）', async () => {
    prisma.release.findFirst.mockResolvedValue(makeRelease({ version: '1.0.0' }));
    const result = await service.latest({ currentVersion: '0.9.0' });
    expect(result.updateAvailable).toBe(true);
  });

  it('latest 按 channel 独立查询，beta 不影响 stable latest', async () => {
    prisma.release.findFirst.mockResolvedValue(makeRelease({ channel: 'BETA', version: '1.1.0-beta.1' }));
    const result = await service.latest({ channel: 'BETA', currentVersion: '1.0.0' });
    expect(prisma.release.findFirst).toHaveBeenCalledWith({
      where: { channel: 'BETA', status: 'PUBLISHED', isLatest: true },
      include: { assets: { orderBy: { platform: 'asc' } } },
    });
    expect(result.channel).toBe('BETA');
    expect(result.version).toBe('1.1.0-beta.1');
    expect(result.updateAvailable).toBe(true);
  });

  it('latest 无版本时抛 release_not_found', async () => {
    prisma.release.findFirst.mockResolvedValue(null);
    await expect(service.latest({ channel: 'BETA' })).rejects.toMatchObject({ status: 404, code: 'release_not_found' });
  });

  it('latest 的 platform/arch 过滤缩小 asset 范围', async () => {
    const winAsset = { id: 'a1', platform: 'WINDOWS', arch: 'X86_64', url: 'u', filename: 'f', sha256: '', signature: '', sizeBytes: null, createdAt: now };
    const macAsset = { id: 'a2', platform: 'DARWIN', arch: 'AARCH64', url: 'u', filename: 'f', sha256: '', signature: '', sizeBytes: null, createdAt: now };
    prisma.release.findFirst.mockResolvedValue(makeRelease({ assets: [winAsset, macAsset] }));
    const result = await service.latest({ platform: 'WINDOWS' });
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0].platform).toBe('WINDOWS');
  });

  it('latest 的 asset 出参包含 sha256（自制更新器校验用）', async () => {
    const winAsset = { id: 'a1', platform: 'WINDOWS', arch: 'X86_64', url: '/downloads/x.exe', filename: 'f', sha256: 'abc123', signature: '', sizeBytes: 100, createdAt: now };
    prisma.release.findFirst.mockResolvedValue(makeRelease({ assets: [winAsset] }));
    const result = await service.latest({ platform: 'WINDOWS', arch: 'X86_64' });
    expect(result.assets[0].sha256).toBe('abc123');
  });

  it('get 非 PUBLISHED 版本抛 not_found', async () => {
    prisma.release.findUnique.mockResolvedValue(makeRelease({ status: 'DRAFT' }));
    await expect(service.get('1.0.0', 'STABLE')).rejects.toMatchObject({ status: 404 });
  });

  it('addAsset 校验 release 存在且 platform/arch 写库', async () => {
    prisma.release.findUnique.mockResolvedValue({ id: 'release-1', version: '1.0.0', channel: 'STABLE' });
    prisma.releaseAsset.create.mockResolvedValue({
      id: 'asset-1', releaseId: 'release-1', platform: 'WINDOWS', arch: 'X86_64', url: 'u', filename: 'f', sha256: '', signature: '', sizeBytes: 1024, createdAt: now,
    });
    const result = await service.addAsset('user-admin', 'release-1', {
      platform: 'WINDOWS', arch: 'X86_64', url: 'u',
    });
    expect(result.asset.platform).toBe('WINDOWS');
    expect(prisma.releaseAsset.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ releaseId: 'release-1', platform: 'WINDOWS', arch: 'X86_64', url: 'u' }),
    });
  });

  it('deleteAsset 校验 asset 归属 release', async () => {
    prisma.releaseAsset.findUnique.mockResolvedValue({ id: 'asset-1', releaseId: 'release-1' });
    await service.deleteAsset('user-admin', 'release-1', 'asset-1');
    expect(prisma.releaseAsset.delete).toHaveBeenCalledWith({ where: { id: 'asset-1' } });
  });

  it('deleteAsset asset 不属于该 release 时抛 not_found', async () => {
    prisma.releaseAsset.findUnique.mockResolvedValue({ id: 'asset-1', releaseId: 'release-other' });
    await expect(service.deleteAsset('user-admin', 'release-1', 'asset-1')).rejects.toMatchObject({ status: 404 });
    expect(prisma.releaseAsset.delete).not.toHaveBeenCalled();
  });

  it('listAdmin 返回全部状态（含 DRAFT/ARCHIVED）且含 assets', async () => {
    prisma.release.findMany.mockResolvedValue([
      makeRelease({ id: 'r1', status: 'DRAFT', assets: [] }),
      makeRelease({ id: 'r2', status: 'ARCHIVED', assets: [{ id: 'a', platform: 'WINDOWS', arch: 'X86_64', url: 'u', filename: 'f', sha256: '', signature: '', sizeBytes: 1, createdAt: now }] }),
    ]);
    const result = await service.listAdmin('user-admin');
    expect(prisma.release.findMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: { updatedAt: 'desc' },
    }));
    expect(result.releases).toHaveLength(2);
    expect(result.releases[0].status).toBe('DRAFT');
    expect(result.releases[1].status).toBe('ARCHIVED');
    expect(result.releases[1].assets).toHaveLength(1);
  });

  it('listAdmin channel 过滤传入 where', async () => {
    prisma.release.findMany.mockResolvedValue([]);
    await service.listAdmin('user-admin', 'BETA');
    expect(prisma.release.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { channel: 'BETA' },
    }));
  });

  it('listAdmin 非 platform admin 被拒（403）', async () => {
    auth.ensurePlatformAdmin.mockRejectedValueOnce(forbidden('需要平台管理员'));
    await expect(service.listAdmin('user-member')).rejects.toMatchObject({ status: 403 });
    expect(prisma.release.findMany).not.toHaveBeenCalled();
  });

  it('uploadAsset 写文件 + 自动计算 SHA-256 + 建 asset', async () => {
    prisma.release.findUnique.mockResolvedValue({ id: 'release-1', version: '0.0.2', channel: 'STABLE' });
    // buffer 'exe-content' 的 SHA-256（与 service 内 createHash 计算一致）。
    const expectedSha = 'c4f69a3c35671f2fe0ef9e54b4e535541d89f7e45774ddb7d31cef7223320117';
    prisma.releaseAsset.create.mockResolvedValue({
      id: 'asset-1', releaseId: 'release-1', platform: 'WINDOWS', arch: 'X86_64', url: '/downloads/x.exe', filename: 'setup.exe', sha256: expectedSha, signature: '', sizeBytes: 100, createdAt: now,
    });
    const file = { originalname: 'setup.exe', buffer: Buffer.from('exe-content'), size: 100 };
    const result = await service.uploadAsset('user-admin', 'release-1', file, 'WINDOWS', 'X86_64');
    expect(result.asset.sha256).toBe(expectedSha);
    expect(prisma.releaseAsset.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        releaseId: 'release-1', platform: 'WINDOWS', arch: 'X86_64',
        url: expect.stringContaining('/downloads/'),
        filename: 'setup.exe', sha256: expectedSha, sizeBytes: 100,
      }),
    });
  });

  it('uploadAsset 未传 file 抛 bad_request', async () => {
    await expect(service.uploadAsset('user-admin', 'release-1', undefined)).rejects.toMatchObject({ status: 400 });
    expect(prisma.releaseAsset.create).not.toHaveBeenCalled();
  });
});
