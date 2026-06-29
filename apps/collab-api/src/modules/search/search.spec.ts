// search/search.spec.ts —— 搜索去重/归一化 + provider 归一化 + 聚合容错单测。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { dedupeByUrl, normalizeUrl, SearchService } from './search.service';
import { SearxngProvider, TavilyProvider, BraveProvider, BingHtmlProvider, GitHubProvider, parseBingHtml, decodeBingUrl, type SearchResultItem } from './providers';

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

describe('BingHtmlProvider', () => {
  it('恒视为已配置（免密钥、免实例）', () => {
    expect(new BingHtmlProvider().isConfigured()).toBe(true);
    expect(new BingHtmlProvider('https://cn.bing.com').isConfigured()).toBe(true);
  });
  it('解析 b_algo 块 → {title,url,snippet,source}，过滤空标题/空 url，截断到 limit', () => {
    const html = [
      '<ol id="b_results">',
      '<li class="b_algo"><h2><a href="https://a.com/news">重大新闻</a></h2><p>这是摘要A</p></li>',
      '<li class="b_algo"><h2><a href="https://b.com">标题B</a></h2><p>摘要B</p></li>',
      '<li class="b_algo"><h2><a href="">空链接</a></h2></li>', // 空 url → 过滤
      '<li class="b_algo"><h2><a href="https://c.com"></a></h2></li>', // 空标题 → 过滤
      '</ol>',
    ].join('');
    const items = parseBingHtml(html, 5, 'bing');
    expect(items).toEqual([
      { title: '重大新闻', url: 'https://a.com/news', snippet: '这是摘要A', source: 'bing' },
      { title: '标题B', url: 'https://b.com/', snippet: '摘要B', source: 'bing' },
    ]);
  });
  it('limit 截断生效', () => {
    const html = ['<ol><li class="b_algo"><h2><a href="https://a.com">A</a></h2></li>',
      '<li class="b_algo"><h2><a href="https://b.com">B</a></h2></li></ol>'].join('');
    expect(parseBingHtml(html, 1, 'bing')).toHaveLength(1);
  });
  it('页面改版/无 b_algo → 空数组（不抛错，上层当无结果处理）', () => {
    expect(parseBingHtml('<html><body>no results here</body></html>', 8, 'bing')).toEqual([]);
  });
  it('解码 HTML 实体与去标签（标题/摘要含 <b>、&amp; 等）', () => {
    const html = '<li class="b_algo"><h2><a href="https://x.com">A &amp; B <b>bold</b></a></h2><p>cat &amp; dog</p></li>';
    const items = parseBingHtml(html, 5, 'bing');
    expect(items[0].title).toBe('A & B bold');
    expect(items[0].snippet).toBe('cat & dog');
  });
  it('fetch 成功时返回解析结果', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('<li class="b_algo"><h2><a href="https://r.com">R</a></h2><p>s</p></li>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
    ));
    const items = await new BingHtmlProvider().search('q', 8, new AbortController().signal);
    expect(items).toEqual([{ title: 'R', url: 'https://r.com/', snippet: 's', source: 'bing' }]);
  });
  it('fetch 非 2xx 抛错', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('err', { status: 503 })));
    await expect(new BingHtmlProvider().search('q', 8, new AbortController().signal)).rejects.toThrow('503');
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

  it('全源失败时 allSourcesFailed=true 并暴露诊断（即使空结果也作为错误信号）', async () => {
    const { svc } = makeService({ searxngUrl: 'https://self.searx' });
    // 所有源（含 Bing）均失败：fetch 全抛网络异常。
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fetch failed'); }));
    const out = await svc.search('全源故障关键词');
    expect(out.results).toEqual([]);
    expect(out.allSourcesFailed).toBe(true);
    expect(out.sourcesUsed).toEqual([]);
    expect(out.sourcesSkipped.length).toBeGreaterThan(0);
  });

  it('有源成功时 allSourcesFailed=false（真无结果不被误判为故障）', async () => {
    const { svc } = makeService({ searxngUrl: 'https://self.searx' });
    // searxng 成功但返回空 results（真无匹配）；Bing 返回非 HTML → 也解析为空。
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ results: [] }), { status: 200 }),
    ));
    const out = await svc.search('无匹配关键词');
    expect(out.allSourcesFailed).toBe(false);
  });
});

describe('decodeBingUrl', () => {
  it('直链原样返回', () => {
    expect(decodeBingUrl('https://example.com/a/b')).toBe('https://example.com/a/b');
  });
  it('/search?url= 形态解出直链', () => {
    expect(decodeBingUrl('https://www.bing.com/search?q=x&url=https%3A%2F%2Freal.com%2Fp'))
      .toBe('https://real.com/p');
  });
  it('/ck/a?...&u=a1<base64url> 形态解出真实 URL', () => {
    // base64url('https://github.com/yt-dlp/yt-dlp') 去填充 → a1 前缀
    // https://github.com/yt-dlp/yt-dlp 的 base64 = aHR0cHM6Ly9naXRodWIuY29tL3l0LWRscC95dC1kbHA=
    const u = 'a1aHR0cHM6Ly9naXRodWIuY29tL3l0LWRscC95dC1kbHA';
    expect(decodeBingUrl(`https://www.bing.com/ck/a?u=${u}`)).toBe('https://github.com/yt-dlp/yt-dlp');
  });
  it('站内 bing 链接（非 ck/a、非 search）返回空串（丢弃，不产出垃圾）', () => {
    expect(decodeBingUrl('https://www.bing.com/images/search?q=x')).toBe('');
  });
  it('解不出的 ck/a 返回空串', () => {
    expect(decodeBingUrl('https://www.bing.com/ck/a?u=a1!!!invalid')).toBe('');
  });
});

describe('GitHubProvider', () => {
  it('恒可用（免密钥）', () => {
    expect(new GitHubProvider().isConfigured()).toBe(true);
  });
  it('解析 GitHub Search API 响应 → {title,url,snippet,source}', async () => {
    const apiResp = {
      items: [
        { full_name: 'yt-dlp/yt-dlp', html_url: 'https://github.com/yt-dlp/yt-dlp', description: 'A feature-rich downloader', stargazers_count: 90000, language: 'Python' },
        { full_name: 'nil', html_url: 'https://github.com/x/y', description: '', stargazers_count: 5, language: null },
      ],
    };
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify(apiResp), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    ));
    const items = await new GitHubProvider().search('yt-dlp', 8, new AbortController().signal);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      title: 'yt-dlp/yt-dlp',
      url: 'https://github.com/yt-dlp/yt-dlp',
      snippet: 'A feature-rich downloader | Python · ⭐90000',
      source: 'github',
    });
    // 空 description 的项仍保留（有 url+title），snippet 只剩统计。
    expect(items[1].snippet).toBe('⭐5');
  });
  it('403 限速抛错（让上层跳过回落其它源）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rate limited', { status: 403 })));
    await expect(new GitHubProvider().search('x', 8, new AbortController().signal)).rejects.toThrow('403');
  });
});

describe('rewriteQuery（site: 路由）', () => {
  // 通过 SearchService.search 间接验证：site:github.com 触发 GitHubProvider。
  it('site:github.com 查询路由到 GitHub 源', async () => {
    const { svc } = makeService({}); // 无自建/密钥源，只有公共 SearXNG + Bing
    const fetchMock = vi.fn();
    fetchMock.mockImplementation(async (url: string) => {
      // GitHub API 调用返回仓库；其它（searxng/bing）返回空，便于隔离观察 GitHub 路由。
      if (url.startsWith('https://api.github.com/')) {
        return new Response(JSON.stringify({ items: [{ full_name: 'a/b', html_url: 'https://github.com/a/b', description: 'd', stargazers_count: 1, language: 'Rust' }] }), { status: 200 });
      }
      // SearXNG/Bing 都返回无结果，确保结果只来自 GitHub。
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const out = await svc.search('site:github.com rust web framework');
    expect(out.sourcesUsed).toContain('github');
    expect(out.results.some((r) => r.url.startsWith('https://github.com/'))).toBe(true);
  });

  it('site:非github 域名按 host 后过滤（只留该域名的结果）', async () => {
    const { svc } = makeService({});
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ results: [
        { title: 'A', url: 'https://stackoverflow.com/q/1', content: '' },
        { title: 'B', url: 'https://example.com/x', content: '' },
      ] }), { status: 200 }),
    ));
    const out = await svc.search('site:stackoverflow.com rust lifetime');
    // 只保留 stackoverflow.com 的结果，example.com 被过滤掉。
    expect(out.results.every((r) => r.url.includes('stackoverflow.com'))).toBe(true);
    expect(out.results.some((r) => r.url.includes('example.com'))).toBe(false);
  });

  it('无 site: 的普通查询不过滤（全部结果保留）', async () => {
    const { svc } = makeService({});
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ results: [
        { title: 'A', url: 'https://a.com/', content: '' },
        { title: 'B', url: 'https://b.com/', content: '' },
      ] }), { status: 200 }),
    ));
    const out = await svc.search('普通查询');
    expect(out.results.length).toBe(2);
  });
});
