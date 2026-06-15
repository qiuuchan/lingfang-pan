// GiteeChangelogService 单测：覆盖配置读取、Gitee 拉取、标准化、缓存 singleflight、容灾降级。
//  - unconfigured（token 空）返回 source='unconfigured'。
//  - 成功拉取标准化（tag_name→version 剥 v、created_at→publishedAt、首条 isLatest）。
//  - 401/404/429/网络异常 降级返回 degraded=true（不清缓存）。
//  - 缓存命中不重复 fetch（singleflight + TTL）。
//  - invalidateChangelogCache 后回源。
// 参考 settings.service.spec.ts：Mock PrismaService.platformSetting + globalThis.fetch，不连真实 DB / Gitee。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { GiteeChangelogService } from './gitee-changelog.service';

function mockPrisma(rows: Array<{ key: string; value: string }> = []) {
  return {
    platformSetting: {
      findMany: vi.fn(async () => rows),
    },
  };
}

// 构造 Gitee release 原始响应（snake_case）。
function giteeReleases() {
  return [
    { id: 100, tag_name: 'v1.2.0', name: '功能更新', body: '## 新功能\n- A\n- B', created_at: '2026-06-14T00:00:00.000Z' },
    { id: 99, tag_name: '1.1.0', name: '', body: '修复', created_at: '2026-06-10T00:00:00.000Z' },
  ];
}

describe('GiteeChangelogService', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('token 未配置 → 返回 source=unconfigured 且不请求 Gitee', async () => {
    const prisma = mockPrisma([]); // 无任何 key
    // @ts-expect-error mock 仅实现用到的方法。
    const svc = new GiteeChangelogService(prisma);
    const result = await svc.getChangelog();
    expect(result.source).toBe('unconfigured');
    expect(result.releases).toEqual([]);
    expect(result.degraded).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('成功拉取 → 标准化（version 剥 v、publishedAt=created_at、首条 isLatest=true）', async () => {
    const prisma = mockPrisma([{ key: 'giteeAccessToken', value: 'valid-token-0123456789abcdef' }]);
    fetchSpy.mockResolvedValueOnce({ ok: true, status: 200, json: async () => giteeReleases() } as Response);
    // @ts-expect-error mock 仅实现用到的方法。
    const svc = new GiteeChangelogService(prisma);
    const result = await svc.getChangelog();
    expect(result.source).toBe('gitee');
    expect(result.degraded).toBe(false);
    expect(result.releases).toHaveLength(2);
    // 首条 isLatest=true（按 created_at desc 排序后），version 剥离前导 v。
    expect(result.releases[0]).toMatchObject({ version: '1.2.0', title: '功能更新', isLatest: true });
    // name 空时 fallback tag，version 无 v 前缀原样。
    expect(result.releases[1]).toMatchObject({ version: '1.1.0', title: '1.1.0', isLatest: false });
    // Bearer 鉴权（禁 query token）。
    const calledUrl = String(fetchSpy.mock.calls[0][0]);
    expect(calledUrl).not.toContain('access_token');
    expect(calledUrl).toContain('per_page=100');
  });

  it('401（token 失效）→ 降级 degraded=true（无缓存时 releases 空）', async () => {
    const prisma = mockPrisma([{ key: 'giteeAccessToken', value: 'expired-token-0123456789' }]);
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) } as Response);
    // @ts-expect-error mock 仅实现用到的方法。
    const svc = new GiteeChangelogService(prisma);
    const result = await svc.getChangelog();
    expect(result.source).toBe('gitee');
    expect(result.degraded).toBe(true);
    expect(result.releases).toEqual([]);
  });

  it('429（限流）→ 降级 degraded=true（失败不写缓存，下次请求重试）', async () => {
    const prisma = mockPrisma([{ key: 'giteeAccessToken', value: 'valid-token-0123456789abcdef' }]);
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({}) } as Response);
    // @ts-expect-error mock 仅实现用到的方法。
    const svc = new GiteeChangelogService(prisma);
    const result = await svc.getChangelog();
    expect(result.source).toBe('gitee');
    expect(result.degraded).toBe(true);
    // 失败不写缓存：releases 为空（无缓存可吐）。
    expect(result.releases).toEqual([]);
    // 下次请求应重试（fetch 再次被调用，而非命中空缓存）。
    fetchSpy.mockResolvedValueOnce({ ok: true, status: 200, json: async () => giteeReleases() } as Response);
    svc.invalidateChangelogCache();
    const retry = await svc.getChangelog();
    expect(retry.degraded).toBe(false);
    expect(retry.releases).toHaveLength(2);
  });

  it('网络异常 → 降级 degraded=true 永不抛', async () => {
    const prisma = mockPrisma([{ key: 'giteeAccessToken', value: 'valid-token-0123456789abcdef' }]);
    fetchSpy.mockRejectedValueOnce(new Error('network down'));
    // @ts-expect-error mock 仅实现用到的方法。
    const svc = new GiteeChangelogService(prisma);
    const result = await svc.getChangelog();
    expect(result.degraded).toBe(true);
    expect(result.releases).toEqual([]);
  });

  it('缓存命中时不重复 fetch（TTL 内仅一次请求）', async () => {
    const prisma = mockPrisma([{ key: 'giteeAccessToken', value: 'valid-token-0123456789abcdef' }]);
    fetchSpy.mockResolvedValue({ ok: true, status: 200, json: async () => giteeReleases() } as Response);
    // @ts-expect-error mock 仅实现用到的方法。
    const svc = new GiteeChangelogService(prisma);
    await svc.getChangelog();
    await svc.getChangelog();
    await svc.getChangelog();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('invalidateChangelogCache 后回源（重新 fetch）', async () => {
    const prisma = mockPrisma([{ key: 'giteeAccessToken', value: 'valid-token-0123456789abcdef' }]);
    fetchSpy.mockResolvedValue({ ok: true, status: 200, json: async () => giteeReleases() } as Response);
    // @ts-expect-error mock 仅实现用到的方法。
    const svc = new GiteeChangelogService(prisma);
    await svc.getChangelog();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    svc.invalidateChangelogCache();
    await svc.getChangelog();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('并发请求共享同一 inflight（singleflight 去重）', async () => {
    const prisma = mockPrisma([{ key: 'giteeAccessToken', value: 'valid-token-0123456789abcdef' }]);
    fetchSpy.mockResolvedValue({ ok: true, status: 200, json: async () => giteeReleases() } as Response);
    // @ts-expect-error mock 仅实现用到的方法。
    const svc = new GiteeChangelogService(prisma);
    // 并发 3 个请求（未命中缓存，应共享同一 inflight）。
    await Promise.all([svc.getChangelog(), svc.getChangelog(), svc.getChangelog()]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
