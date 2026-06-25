// search/search.spec.ts —— 搜索去重/归一化 + provider 归一化 + 聚合容错单测。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { dedupeByUrl, normalizeUrl, SearchService } from './search.service';
import { SearxngProvider, TavilyProvider, BraveProvider, type SearchResultItem } from './providers';

describe('normalizeUrl', () => {
  it('去尾斜杠 + 去 hash + 去追踪参数 + host 小写', () => {
    expect(normalizeUrl('https://Example.com/a/?utm_source=x&q=1#frag')).toBe('https://example.com/a?q=1');
    expect(normalizeUrl('https://example.com/a/')).toBe('https://example.com/a');
  });
  it('非法 URL 原样兜底（去尾斜杠）', () => {
    expect(normalizeUrl('not a url/')).toBe('not a url');
  });
});

describe('dedupeByUrl', () => {
  it('按归一化 URL 去重，保留首个（高优先级源）', () => {
    const items: SearchResultItem[] = [
      { title: 'A', url: 'https://x.com/p?utm_source=g', snippet: '', source: 'searxng:self' },
      { title: 'A2', url: 'https://x.com/p/', snippet: '', source: 'searxng:pub0' },
      { title: 'B', url: 'https://y.com', snippet: '', source: 'brave' },
    ];
    const out = dedupeByUrl(items);
    expect(out).toHaveLength(2);
    expect(out[0].title).toBe('A'); // 首个保留
    expect(out[1].title).toBe('B');
  });
});

describe('provider 配置判定', () => {
  it('SearxngProvider 仅 http/https 视为已配置', () => {
    expect(new SearxngProvider('https://s.example').isConfigured()).toBe(true);
    expect(new SearxngProvider('').isConfigured()).toBe(false);
    expect(new SearxngProvider('javascript:alert(1)').isConfigured()).toBe(false);
  });
  it('带密钥源空密钥视为未配置', () => {
    expect(new TavilyProvider('').isConfigured()).toBe(false);
    expect(new TavilyProvider('tvly-abc').isConfigured()).toBe(true);
    expect(new BraveProvider('  ').isConfigured()).toBe(false);
  });
});

describe('provider 结果归一化', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('SearxngProvider 解析 results[] → {title,url,snippet,source}，过滤无 url/title', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      results: [
        { title: 'T1', url: 'https://a.com', content: 'c1' },
        { title: '', url: 'https://b.com', content: 'c2' }, // 无 title → 过滤
        { title: 'T3', url: '', content: 'c3' }, // 无 url → 过滤
      ],
    }), { status: 200 })));
    const items = await new SearxngProvider('https://s.example', 'self').search('q', 8, new AbortController().signal);
    expect(items).toEqual([{ title: 'T1', url: 'https://a.com', snippet: 'c1', source: 'searxng:self' }]);
  });

  it('SearxngProvider 非 2xx 抛错', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('err', { status: 502 })));
    await expect(new SearxngProvider('https://s.example').search('q', 8, new AbortController().signal)).rejects.toThrow('502');
  });
});

/** 构造一个带可控 settings + 可控 cache 的 SearchService。 */
function makeService(settings: Record<string, string>) {
  const store = new Map<string, string>();
  const prisma = {
    platformSetting: {
      findMany: vi.fn(async () =>
        Object.entries(settings).map(([key, value]) => ({ key, value })),
      ),
    },
  };
  const cache = {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
    delete: vi.fn(async (k: string) => { store.delete(k); }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = new SearchService(prisma as any, cache as any);
  return { svc, store, prisma, cache };
}

describe('SearchService 聚合容错', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('空 query 抛 400', async () => {
    const { svc } = makeService({});
    await expect(svc.search('   ')).rejects.toMatchObject({ status: 400 });
  });

  it('部分源失败仍返回其余源结果，并把失败源标记不健康', async () => {
    // 配自建 searxng + tavily 两源；让 tavily 失败、searxng 成功。
    const { svc, store } = makeService({ searxngUrl: 'https://self.searx', tavilyApiKey: 'tvly-x' });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('tavily.com')) return new Response('boom', { status: 500 });
      // searxng（自建或公共）都返回一条
      return new Response(JSON.stringify({ results: [{ title: 'Hit', url: 'https://hit.com', content: 's' }] }), { status: 200 });
    }));
    const out = await svc.search('关键词');
    expect(out.results.length).toBeGreaterThan(0);
    expect(out.results[0].url).toBe('https://hit.com');
    expect(out.sourcesUsed).toContain('searxng:self');
    expect(out.sourcesSkipped.some((s) => s.source === 'tavily')).toBe(true);
    // 失败源进了不健康缓存
    expect(store.has('search:unhealthy:tavily')).toBe(true);
  });

  it('结果命中缓存时直接复用', async () => {
    const { svc } = makeService({ searxngUrl: 'https://self.searx' });
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ results: [{ title: 'C', url: 'https://c.com', content: '' }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await svc.search('缓存词');
    const callsAfterFirst = fetchMock.mock.calls.length;
    await svc.search('缓存词'); // 第二次应命中缓存，不再 fetch
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });
});
