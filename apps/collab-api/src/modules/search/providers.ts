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

/** 单源请求超时（毫秒）。大陆网络下被墙源会卡到超时，设短一些以快速故障转移。 */
export const PROVIDER_TIMEOUT_MS = 8_000;

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
