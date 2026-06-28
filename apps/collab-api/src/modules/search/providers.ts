// search/providers.ts —— 搜索源 provider 抽象与具体实现。
//
// 设计目标（对齐需求）：
//  - 免用户密钥：免密钥源（SearXNG 公共/自建实例）默认可用；带密钥源由管理员在后台配置，用户永不填。
//  - 大陆网络兼容：每个源带 isConfigured() + 自带超时；SearchService 用健康探测跳过不可达源。
//  - 多源聚合容错：每个 provider 独立 search()，失败抛错由上层捕获、跳过、故障转移。
//
// provider 只负责「查一个源并归一化结果」，不负责并发/去重/缓存（那是 SearchService 的职责）。

/** 归一化的单条搜索结果。 */
export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
  /** 来源 provider 名（searxng / tavily / brave），便于前端/日志区分与排序。 */
  source: string;
}

/** 一个搜索源。name 唯一；isConfigured 决定是否参与本次聚合。 */
export interface SearchProvider {
  readonly name: string;
  /** 该源当前是否可用（免密钥源恒 true；带密钥源取决于管理员是否配了密钥）。 */
  isConfigured(): boolean;
  /** 执行搜索，返回归一化结果。失败必须抛错（由 SearchService 捕获并跳过）。 */
  search(query: string, limit: number, signal: AbortSignal): Promise<SearchResultItem[]>;
}

/** 单源请求超时（毫秒）。大陆网络下被墙源会卡到超时，设短一些以快速故障转移到 Bing 兜底源。 */
export const PROVIDER_TIMEOUT_MS = 6_000;

/** 带超时的 fetch（叠加调用方传入的 signal 与本地超时）。 */
export async function fetchWithTimeout(url: string, init: RequestInit, outerSignal: AbortSignal): Promise<Response> {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  const onOuterAbort = () => controller.abort();
  outerSignal.addEventListener('abort', onOuterAbort, { once: true });
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    globalThis.clearTimeout(timer);
    outerSignal.removeEventListener('abort', onOuterAbort);
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * SearXNG provider —— 免密钥元搜索（自身聚合 Baidu/Bing/Google 等）。
 * 用 JSON 输出格式（?format=json）。一个 SearXNG 实例 URL = 一个 provider 实例，
 * 便于内置多个公共实例 + 管理员自建实例并存、互为故障转移。
 */
export class SearxngProvider implements SearchProvider {
  readonly name: string;
  constructor(private readonly baseUrl: string, nameSuffix?: string) {
    this.name = nameSuffix ? `searxng:${nameSuffix}` : 'searxng';
  }
  isConfigured(): boolean {
    return /^https?:\/\//i.test(this.baseUrl);
  }
  async search(query: string, limit: number, signal: AbortSignal): Promise<SearchResultItem[]> {
    const base = this.baseUrl.replace(/\/+$/, '');
    const url = `${base}/search?q=${encodeURIComponent(query)}&format=json&safesearch=1&language=zh-CN`;
    const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } }, signal);
    if (!res.ok) throw new Error(`SearXNG 返回 ${res.status}`);
    const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
    const results = Array.isArray(data.results) ? data.results : [];
    return results
      .map((r) => ({ title: str(r.title), url: str(r.url), snippet: str(r.content), source: this.name }))
      .filter((r) => r.url && r.title)
      .slice(0, limit);
  }
}

/**
 * Tavily provider —— 带密钥的搜索 API（管理员可选配置）。
 * 海外服务，大陆后端可能不可达；由健康探测自动跳过。
 */
export class TavilyProvider implements SearchProvider {
  readonly name = 'tavily';
  constructor(private readonly apiKey: string) {}
  isConfigured(): boolean {
    return this.apiKey.trim().length > 0;
  }
  async search(query: string, limit: number, signal: AbortSignal): Promise<SearchResultItem[]> {
    const res = await fetchWithTimeout(
      'https://api.tavily.com/search',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: this.apiKey, query, max_results: limit, search_depth: 'basic' }),
      },
      signal,
    );
    if (!res.ok) throw new Error(`Tavily 返回 ${res.status}`);
    const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
    const results = Array.isArray(data.results) ? data.results : [];
    return results
      .map((r) => ({ title: str(r.title), url: str(r.url), snippet: str(r.content), source: this.name }))
      .filter((r) => r.url && r.title)
      .slice(0, limit);
  }
}

/**
 * Brave Search provider —— 带密钥（管理员可选）。海外服务，同样由健康探测兜底。
 */
export class BraveProvider implements SearchProvider {
  readonly name = 'brave';
  constructor(private readonly apiKey: string) {}
  isConfigured(): boolean {
    return this.apiKey.trim().length > 0;
  }
  async search(query: string, limit: number, signal: AbortSignal): Promise<SearchResultItem[]> {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`;
    const res = await fetchWithTimeout(
      url,
      { headers: { Accept: 'application/json', 'X-Subscription-Token': this.apiKey } },
      signal,
    );
    if (!res.ok) throw new Error(`Brave 返回 ${res.status}`);
    const data = (await res.json()) as { web?: { results?: Array<Record<string, unknown>> } };
    const results = Array.isArray(data.web?.results) ? data.web!.results! : [];
    return results
      .map((r) => ({ title: str(r.title), url: str(r.url), snippet: str(r.description), source: this.name }))
      .filter((r) => r.url && r.title)
      .slice(0, limit);
  }
}

/**
 * Bing HTML provider —— 免密钥、无需自建实例的兜底搜索源。
 *
 * 为什么需要它：内置的公共 SearXNG 实例在大陆网络下经常被墙（实测全源 fetch failed），
 * 而 Bing 网页版（cn.bing.com / www.bing.com）在大陆普遍可达。直接抓 Bing 结果页 HTML，
 * 用正则解析标题/链接/摘要，作为「所有配置/公共源都失败」时的最后一道防线，保证
 * WebSearch 工具在免密钥、免管理员配置的前提下恒有结果。
 *
 * 实现说明：
 *  - 走 cn.bing.com（大陆可达性最佳）；用桌面浏览器 UA + 中文语言，减少反爬拦截。
 *  - 用宽松正则提取 <li class="b_algo"> 下的 <h2><a href>（标题+链接）与 <p>（摘要），
 *    避免 DOM 依赖（项目未引入 cheerio/jsdom，正则足够且零依赖）。
 *  - 仅做结构抽取，结果项过滤掉空标题/空 url（与其它 provider 一致）。
 */
export class BingHtmlProvider implements SearchProvider {
  readonly name = 'bing';
  private readonly baseUrl: string;
  constructor(baseUrl = 'https://cn.bing.com') {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }
  isConfigured(): boolean {
    return /^https?:\/\//i.test(this.baseUrl);
  }
  async search(query: string, limit: number, signal: AbortSignal): Promise<SearchResultItem[]> {
    const url = `${this.baseUrl}/search?q=${encodeURIComponent(query)}&setlang=zh-Hans&cc=cn&ensearch=0`;
    // ensearch=0 关闭国际版结果回退，强制中文区结果，提升大陆网络可达性下的相关性。
    const res = await fetchWithTimeout(
      url,
      {
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          // 桌面浏览器 UA，降低被识别为爬虫的概率。
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        },
      },
      signal,
    );
    if (!res.ok) throw new Error(`Bing 返回 ${res.status}`);
    const html = await res.text();
    return parseBingHtml(html, limit, this.name);
  }
}

/**
 * 解析 Bing 搜索结果页 HTML：从 <li class="b_algo"> 块里提取 标题/链接/摘要。
 *
 * Bing 结果块结构（精简）：
 *   <li class="b_algo">
 *     <h2><a href="https://...">标题文本</a></h2>
 *     <p>摘要文本...</p>
 *   </li>
 * 用正则逐块切分再解析，避免引入 DOM 解析依赖。解析失败（页面改版）返回空数组，
 * 由上层当作「该源本次无结果」处理，不影响其它源。
 */
export function parseBingHtml(html: string, limit: number, source: string): SearchResultItem[] {
  const items: SearchResultItem[] = [];
  // 按 b_algo 项切分； lookahead 到下一个 <li class="b_algo">、</ol> 或字符串结尾，
  // 保证无尾随标记的最后一个块也能被捕获。
  const blockRe = /<li\s+class="b_algo"[^>]*>([\s\S]*?)(?=<li\s+class="b_algo"|<\/ol>|$)/gi;
  let block: RegExpExecArray | null;
  while ((block = blockRe.exec(html)) && items.length < limit) {
    const seg = block[1] ?? '';
    // 标题+链接：取第一个 <h2><a href="...">。href 可能含 Bing 跳转包装，尽量取真实 url。
    const link = seg.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"/i);
    const titleText = seg.match(/<h2[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/i);
    // 摘要：取 b_caption 里的 <p> 或首个 <p>。
    const snippet = seg.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const url = link ? decodeBingUrl(link[1]) : '';
    const title = titleText ? stripTags(titleText[1] ?? '').trim() : '';
    if (!url || !title) continue;
    items.push({
      title,
      url,
      snippet: stripTags(snippet?.[1] ?? '').trim(),
      source,
    });
  }
  return items;
}

/** Bing 偶尔把链接包成 /search?q=... 的跳转，尝试解出里面的 u 参数或直接返回原 url。 */
function decodeBingUrl(raw: string): string {
  try {
    const u = new URL(raw, 'https://cn.bing.com');
    if (/^\/search$/i.test(u.pathname)) {
      // Bing 跳转链接形如 /search?q=...&url=... 或 /search?FORM=...&u=a1aHR0c...
      const direct = u.searchParams.get('url');
      if (direct) return direct;
    }
    // 站内相对路径不作为有效结果 url。
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.toString();
  } catch {
    /* 解析失败兜底返回原值 */
  }
  return raw;
}

/** 去除 HTML 标签并解码常见实体，得到纯文本用于标题/摘要展示。 */
function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&ensp;|&emsp;|&nbsp;/g, ' ')
    .replace(/&middot;|&#0183;|&#183;/g, '·')
    .replace(/&hellip;|&#8230;/g, '…')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // 兜底：其余数字实体（&#0183; 等）解码为字符，避免摘要里残留 &#xxxx;。
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/\s+/g, ' ')
    .trim();
}
