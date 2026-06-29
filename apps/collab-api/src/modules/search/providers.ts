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
    const url = `${this.baseUrl}/search?q=${encodeURIComponent(query)}&setlang=zh-Hans&cc=cn&ensearch=1`;
    // ensearch=1 启用国际结果覆盖（cn.bing.com 默认走 CN 审查索引，会降权/过滤 GitHub、
    // 英文技术内容，相关性差）。实测 ensearch=0 是强制 CN 索引，注释此前写反了。
    // 国际 Bing 偶发不可达时由上层健康探测自动禁用，回落 SearXNG。
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

/**
 * 解码 Bing 结果链接，尽量还原真实目标 URL。
 *
 * Bing HTML SERP 的链接常见三种形态：
 *  1. 直链 https://example.com/...（直接返回）
 *  2. /search?url=<直链>（旧跳转，已支持）
 *  3. /ck/a?...&u=a1<base64url>（新跳转包装，a1 前缀 + base64url 编码的真实 URL）
 *
 * 形态 3 此前未处理 → 产出 bing.com/ck/a 垃圾 URL。现补齐 base64url 解码；
 * 若解出仍是 bing 内部链接（ck/a、/search），返回空串让上层丢弃（不产出垃圾结果）。
 *
 * @returns 真实 URL；无法还原或仍是 bing 内部链接时返回 ''（调用方据此丢弃）。
 */
export function decodeBingUrl(raw: string): string {
  try {
    const u = new URL(raw, 'https://cn.bing.com');
    const host = u.hostname;
    const isBing = /(^|\.)bing\.com$/i.test(host);

    // 形态 3：/ck/a?...&u=a1<base64url>
    if (isBing && /^\/ck\/a$/i.test(u.pathname)) {
      const uParam = u.searchParams.get('u') ?? '';
      // a1 前缀后是 base64url（- _ 代替 + /，无填充）。
      const decoded = decodeBase64UrlParam(uParam);
      if (decoded && /^https?:\/\//i.test(decoded) && !/bing\.com\/ck\/a/i.test(decoded)) {
        return decoded;
      }
      return ''; // 解不出或仍是内部跳转 → 丢弃
    }

    // 形态 2：/search?url=<直链>
    if (isBing && /^\/search$/i.test(u.pathname)) {
      const direct = u.searchParams.get('url');
      if (direct) return direct;
      return ''; // /search 但无 url 参数 → 内部跳转，丢弃
    }

    // 形态 1：直链或站内相对路径。站内路径（/images、/videos 等）不作为有效结果。
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      if (isBing) return ''; // 其它 bing 站内页（非 ck/a、非 search）不算有效结果
      return u.toString();
    }
  } catch {
    /* 解析失败兜底：原值若像 URL 就返回，否则空串 */
    if (/^https?:\/\//i.test(raw)) return raw;
    return '';
  }
  return raw;
}

/** 解码 Bing ck/a 的 u 参数：去 a1 前缀 + base64url 解码（补齐填充）。 */
function decodeBase64UrlParam(param: string): string {
  if (!param) return '';
  // 去 a1 前缀（Bing 在 base64url 前加 'a1' 标记，有时还有其它单字符前缀）。
  const m = param.match(/^a[0-9]+(.+)$/);
  const payload = m ? m[1] : param;
  if (!payload) return '';
  try {
    // base64url → base64：- → +，_ → /，按需补 =
    let b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4;
    if (pad) b64 += '='.repeat(4 - pad);
    // Buffer 在 Node 18+ 可用；search 服务跑在 Node，非浏览器。
    return Buffer.from(b64, 'base64').toString('utf-8');
  } catch {
    return '';
  }
}

/**
 * GitHub 原生搜索源 —— 调 GitHub Search API 搜仓库，免密钥。
 *
 * 为什么需要它：抓 Bing 的 `site:github.com` 查询极不可靠（CN 索引降权 + site: 操作符常被忽略）。
 * 直接走 GitHub API 精确搜仓库，准确性远高于网页搜索，尤其适合「找某类开源项目/库」的查询。
 *
 * 限速：免密钥 10 次/分钟/IP（GitHub 官方限制）。由 SearchService 的健康探测兜底——
 * 触发限速（403 + rate limit）时本次失败、下次探测仍会重试。
 * 仅在查询含 `site:github.com` 或由 SearchService 路由判定为「适合 GitHub」时启用。
 */
export class GitHubProvider implements SearchProvider {
  readonly name = 'github';
  isConfigured(): boolean {
    return true; // 免密钥，恒可用
  }
  async search(query: string, limit: number, signal: AbortSignal): Promise<SearchResultItem[]> {
    // GitHub Search API：q 为搜索词，sort=stars 按热度排（对「找项目」更相关）。
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${Math.min(limit, 10)}`;
    const res = await fetchWithTimeout(
      url,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          // GitHub API 要求带 UA，否则可能 403。
          'User-Agent': 'lingfang-search/1.0',
        },
      },
      signal,
    );
    if (!res.ok) {
      // 403 常见为限速；抛错让上层跳过，回落其它源。
      throw new Error(`GitHub 返回 ${res.status}`);
    }
    const data = (await res.json()) as { items?: Array<Record<string, unknown>> };
    const items = Array.isArray(data.items) ? data.items : [];
    return items.map((it) => {
      const name = str(it.full_name) || str(it.name);
      const htmlUrl = str(it.html_url);
      const desc = str(it.description);
      // snippet：描述 + ⭐星数 + 语言，便于模型判断相关性。
      const stars = typeof it.stargazers_count === 'number' ? it.stargazers_count : 0;
      const lang = str(it.language);
      const extra = [lang, `⭐${stars}`].filter(Boolean).join(' · ');
      return {
        title: name,
        url: htmlUrl,
        snippet: [desc, extra].filter(Boolean).join(' | '),
        source: this.name,
      };
    }).filter((r) => r.url && r.title);
  }
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
    .replace(/&apos;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    // 兜底：数字实体（&#0183; / &#xNN; 等）解码为字符，避免摘要里残留实体。
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const code = parseInt(h, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/\s+/g, ' ')
    .trim();
}
