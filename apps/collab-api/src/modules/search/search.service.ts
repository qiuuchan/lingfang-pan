// search/search.service.ts —— 多源搜索聚合服务。
//
// 职责（对齐需求）：
//  1. 内置搜索默认可用：不依赖任何管理员配置即有一组公共 SearXNG 免密钥实例兜底。
//  2. 大陆网络兼容：对每个源做健康探测，把近期失败/超时（被墙）的源在缓存窗口内标记禁用并跳过。
//  3. 免用户密钥：免密钥源恒可用；带密钥源仅当管理员在后台配置了密钥才启用。
//  4. 多源聚合容错：并发查所有「已配置 + 健康」的源，去重合并，部分源失败仍返回其余结果。
import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { AppCacheService } from '../../cache.service';
import { badRequest } from '../../common';
import {
  type SearchProvider,
  type SearchResultItem,
  SearxngProvider,
  TavilyProvider,
  BraveProvider,
  BingHtmlProvider,
  GitHubProvider,
} from './providers';

/** 查询改写结果：剥离 site: 前缀后的裸查询 + 受限域名（用于路由/后过滤）。 */
interface RewrittenQuery {
  /** 去掉 site: 前缀后的查询词（供各源搜索）。 */
  bare: string;
  /** site: 指定的域名（小写，无 www），未指定则 null。 */
  scopedDomain: string | null;
}

/**
 * 改写查询：识别并剥离前缀 `site:<domain>` 操作符。
 *
 * 为什么需要它：Bing/SearXNG 的 HTML 搜索对 `site:` 操作符支持极不稳定（CN 索引常忽略它，
 * 返回无关结果）。剥离后用裸查询搜，再由 SearchService 按域名后过滤结果——这样无论
 * 搜索引擎是否支持 site:，结果都精准。
 *
 * 特例：`site:github.com` 时 SearchService 会优先路由到 GitHubProvider（原生 API 搜索，
 * 远比网页 site: 准确）。
 *
 * @example
 *   rewriteQuery('site:github.com douyin video download') → { bare: 'douyin video download', scopedDomain: 'github.com' }
 *   rewriteQuery('tauri 教程') → { bare: 'tauri 教程', scopedDomain: null }
 */
function rewriteQuery(query: string): RewrittenQuery {
  // 匹配开头的 site:domain（允许带/不带 www，末尾空格）。
  const m = query.match(/^\s*site:(?:www\.)?([a-z0-9.-]+)\s+(.+)$/i);
  if (!m) return { bare: query, scopedDomain: null };
  const domain = m[1].toLowerCase();
  const bare = m[2].trim();
  // bare 可能为空（查询就是 "site:github.com"）——保留原查询作兜底搜索词。
  return { bare: bare || query, scopedDomain: domain };
}

/** 主机名是否匹配受限域名（含 www 与否都算）。 */
function hostMatchesDomain(host: string, domain: string): boolean {
  const h = host.toLowerCase();
  return h === domain || h === `www.${domain}` || h.endsWith(`.${domain}`);
}

/**
 * 判断 IPv4 是否落在私有/保留段（SSRF 防护）。
 * 覆盖：回环(127)、私有(10/172.16-31/192.168)、链路本地(169.254)、运营商级 NAT(100.64/10)、
 *       benchmark(198.18/15)、本网络(0)、组播与保留(224+/240+)。
 */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts;
  return (
    a === 0 ||                            // 0.0.0.0/8 本网络
    a === 10 ||                           // 10.0.0.0/8 私有
    a === 127 ||                          // 127.0.0.0/8 回环
    (a === 172 && b >= 16 && b <= 31) ||   // 172.16.0.0/12 私有
    (a === 192 && b === 168) ||            // 192.168.0.0/16 私有
    (a === 169 && b === 254) ||            // 169.254.0.0/16 链路本地（含云元数据 169.254.169.254）
    (a === 100 && b >= 64 && b <= 127) ||  // 100.64.0.0/10 运营商级 NAT
    (a === 198 && (b === 18 || b === 19)) || // 198.18.0.0/15 benchmark
    a >= 224                              // 224.0.0.0/4 组播 + 240.0.0.0/4 保留
  );
}

/**
 * 判断 IPv6 是否为内网/保留地址（SSRF 防护）。
 * 覆盖：回环(::1)、未指定(::)、IPv4 映射(::ffff:x.x.x.x 内网)、唯一本地(fc00::/7)、链路本地(fe80::/10)。
 */
function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;            // 回环 / 未指定
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7 唯一本地
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true; // fe80::/10 链路本地
  // IPv4 映射地址 ::ffff:a.b.c.d —— 提取内嵌 IPv4 再判。
  const v4Mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Mapped) return isPrivateIPv4(v4Mapped[1]);
  return false;
}

/**
 * SSRF 校验：拦截会令服务器抓取内网/云元数据/非 HTTP 协议的 URL。
 *
 * 防护范围：
 *  - 协议仅允许 http/https（拒绝 file://、ftp://、gopher:// 等可触发协议级 SSRF）。
 *  - hostname 为 IP 字面量时，拒绝所有私有/保留/回环/链路本地段。
 *  - hostname 为 localhost / *.local 等本地解析域名时拒绝。
 *
 * 权衡（DNS rebinding）：本函数只校验 URL 字面量里的 IP；对域名形态，fetch 内部会做 DNS 解析，
 * 理论上存在 rebinding（解析到内网 IP）。完整防护需在 fetch 前 pre-resolve 并 pin IP，但 Node fetch
 * 不暴露此 hook。当前务实方案已能拦截最高危的「直接输入内网 IP」（如云元数据 169.254.169.254）。
 *
 * @returns null 表示安全可抓取；string 表示拒绝原因。
 */
export function assertSafeFetchUrl(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return 'URL 格式非法';
  }
  // 协议白名单：仅 http/https。
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `不支持的协议：${parsed.protocol.replace(':', '')}（仅允许 http/https）`;
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, ''); // 去掉 IPv6 方括号
  // 本地解析域名。
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    return `禁止抓取本地地址：${host}`;
  }
  // IP 字面量校验（区分 v4/v6）。
  if (host.includes(':')) {
    if (isPrivateIPv6(host)) return `禁止抓取内网地址：${host}`;
  } else if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    if (isPrivateIPv4(host)) return `禁止抓取内网地址：${host}`;
  }
  return null;
}

export interface SearchResponse {
  query: string;
  results: SearchResultItem[];
  /** 本次实际命中（返回了结果或正常空结果）的源名。 */
  sourcesUsed: string[];
  /** 本次被跳过的源名 + 原因（健康禁用 / 未配置 / 失败），供诊断，不含密钥。 */
  sourcesSkipped: Array<{ source: string; reason: string }>;
  /** 所有参与源都失败（无任何源返回成功）时为 true，前端据此区分「真无结果」与「全源故障」。 */
  allSourcesFailed?: boolean;
}

/** 内置公共 SearXNG 实例（免密钥、支持 JSON、历史上大陆可达性较好）。
 *  管理员配置了自建 searxngUrl 时，自建实例优先；公共实例作为冗余兜底。
 *  注意：公共实例可用性会漂移，靠健康探测自动筛选，不可达的会被缓存禁用窗口跳过。 */
const PUBLIC_SEARXNG_INSTANCES = [
  'https://searxng.site',
  'https://search.bus-hit.me',
  'https://baresearch.org',
  'https://priv.au',
];

/** 健康禁用缓存窗口：一个源失败后，在此窗口内不再尝试（避免每次请求都卡被墙源的超时）。 */
const HEALTH_DISABLE_TTL_MS = 5 * 60_000; // 5 分钟
const HEALTH_KEY_PREFIX = 'search:unhealthy:';
/** 搜索结果缓存窗口：同 query 短期内复用，降上游压力与延迟。 */
const RESULT_CACHE_TTL_MS = 60_000;
const RESULT_KEY_PREFIX = 'search:result:';

const MAX_QUERY_LEN = 256;
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AppCacheService) private readonly cache: AppCacheService,
  ) {}

  /** 读取搜索相关 PlatformSetting（searxngUrl / tavilyApiKey / braveApiKey）。 */
  private async loadSettings(): Promise<{ searxngUrl: string; tavilyApiKey: string; braveApiKey: string }> {
    const rows = await this.prisma.platformSetting.findMany({
      where: { key: { in: ['searxngUrl', 'tavilyApiKey', 'braveApiKey'] } },
      select: { key: true, value: true },
    });
    const map = new Map(rows.map((r) => [r.key, r.value] as const));
    return {
      searxngUrl: (map.get('searxngUrl') ?? '').trim(),
      tavilyApiKey: (map.get('tavilyApiKey') ?? '').trim(),
      braveApiKey: (map.get('braveApiKey') ?? '').trim(),
    };
  }

  /** 组装本次参与聚合的 provider 列表（已配置者）。顺序即优先级：自建 SearXNG > 带密钥源 > 公共 SearXNG > Bing 兜底。 */
  private async buildProviders(): Promise<SearchProvider[]> {
    const cfg = await this.loadSettings();
    const providers: SearchProvider[] = [];
    // 自建 SearXNG（管理员配置）优先。
    if (/^https?:\/\//i.test(cfg.searxngUrl)) providers.push(new SearxngProvider(cfg.searxngUrl, 'self'));
    // 带密钥源（管理员可选）。
    if (cfg.tavilyApiKey) providers.push(new TavilyProvider(cfg.tavilyApiKey));
    if (cfg.braveApiKey) providers.push(new BraveProvider(cfg.braveApiKey));
    // 公共 SearXNG 兜底（免密钥，恒注入；不可达者由健康探测跳过）。
    PUBLIC_SEARXNG_INSTANCES.forEach((url, i) => providers.push(new SearxngProvider(url, `pub${i}`)));
    // Bing HTML 兜底（免密钥、免实例、免管理员配置，大陆可达性最佳）：
    // 作为最低优先级恒注入。即便所有 SearXNG 实例都被墙，也能保证 WebSearch 有结果。
    providers.push(new BingHtmlProvider());
    return providers.filter((p) => p.isConfigured());
  }

  private async isUnhealthy(name: string): Promise<boolean> {
    const v = await this.cache.get(HEALTH_KEY_PREFIX + name).catch(() => null);
    return v != null;
  }

  private async markUnhealthy(name: string): Promise<void> {
    await this.cache.set(HEALTH_KEY_PREFIX + name, '1', HEALTH_DISABLE_TTL_MS).catch(() => undefined);
  }

  /**
   * 执行多源聚合搜索。
   * @param rawQuery 用户查询
   * @param rawLimit 期望结果条数（每源），默认 8，上限 20
   */
  async search(rawQuery: string, rawLimit?: number): Promise<SearchResponse> {
    const query = (rawQuery ?? '').trim();
    if (!query) throw badRequest('搜索关键词不能为空');
    if (query.length > MAX_QUERY_LEN) throw badRequest(`搜索关键词过长（上限 ${MAX_QUERY_LEN} 字符）`);
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? Number(rawLimit) : DEFAULT_LIMIT, 1), MAX_LIMIT);

    // 结果缓存命中直接返回。
    const cacheKey = `${RESULT_KEY_PREFIX}${limit}:${query}`;
    const cached = await this.cache.get(cacheKey).catch(() => null);
    if (cached) {
      try {
        return JSON.parse(cached) as SearchResponse;
      } catch {
        /* 缓存损坏则忽略，走实时查询 */
      }
    }

    const providers = await this.buildProviders();
    // 查询改写：剥离 site: 前缀。github.com 查询路由到原生 GitHubProvider（更准）。
    const { bare: searchQuery, scopedDomain } = rewriteQuery(query);
    if (scopedDomain === 'github.com') {
      // 置顶 GitHub 源：site:github.com 时优先用 API 搜，不依赖网页 site: 操作符。
      providers.unshift(new GitHubProvider());
    }
    const sourcesUsed: string[] = [];
    const sourcesSkipped: Array<{ source: string; reason: string }> = [];

    // 过滤掉近期不健康（被墙/超时）的源。
    const healthy: SearchProvider[] = [];
    for (const p of providers) {
      if (await this.isUnhealthy(p.name)) sourcesSkipped.push({ source: p.name, reason: '近期不可达，已临时禁用' });
      else healthy.push(p);
    }

    if (healthy.length === 0) {
      // 全部源近期被标记不可达：清一次健康缓存并强制重试本批（避免缓存把所有源永久挡死）。
      for (const p of providers) await this.cache.delete(HEALTH_KEY_PREFIX + p.name).catch(() => undefined);
      healthy.push(...providers);
    }

    const controller = new AbortController();
    // 用剥离 site: 后的裸查询搜各源（site: 操作符本身对各源不可靠）。
    const settled = await Promise.allSettled(
      healthy.map(async (p) => {
        const items = await p.search(searchQuery, limit, controller.signal);
        return { name: p.name, items };
      }),
    );

    const merged: SearchResultItem[] = [];
    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i];
      const provider = healthy[i];
      if (outcome.status === 'fulfilled') {
        sourcesUsed.push(outcome.value.name);
        merged.push(...outcome.value.items);
      } else {
        const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        sourcesSkipped.push({ source: provider.name, reason: `查询失败：${reason}` });
        await this.markUnhealthy(provider.name);
      }
    }

    // 若指定了 site:<domain>（非 github，github 已走原生源），按域名后过滤结果，
    // 确保只返回该域名的条目（搜索引擎的 site: 操作符不可靠，这里做权威过滤）。
    const filtered = scopedDomain && scopedDomain !== 'github.com'
      ? merged.filter((r) => {
          try { return hostMatchesDomain(new URL(r.url).hostname, scopedDomain); }
          catch { return false; }
        })
      : merged;
    const results = dedupeByUrl(filtered).slice(0, MAX_LIMIT);
    // allSourcesFailed：没有任何源成功（sourcesUsed 为空）。即便空结果也应区分：
    //  - 有源成功但确实无匹配（allSourcesFailed=false，真无结果）
    //  - 全部源失败（allSourcesFailed=true，应作为错误暴露给用户/模型，而非静默「无结果」）
    const allSourcesFailed = sourcesUsed.length === 0;
    const response: SearchResponse = { query, results, sourcesUsed, sourcesSkipped, allSourcesFailed };

    // 仅当确有结果时缓存（空结果可能是临时全源故障，不缓存以便下次重试）。
    if (results.length > 0) {
      await this.cache.set(cacheKey, JSON.stringify(response), RESULT_CACHE_TTL_MS).catch(() => undefined);
    }
    if (allSourcesFailed) {
      this.logger.warn(`搜索「${query}」全部源不可用：${sourcesSkipped.map((s) => s.source).join(', ')}`);
    }
    return response;
  }

  /**
   * 抓取网页正文（WebFetch）。
   *
   * 为什么放后端：客户端（尤其大陆网络）直连 r.jina.ai 不可达（被墙），但后端服务器在
   * 数据中心可达。前端 → 后端 /api/search/fetch → Jina Reader，与搜索同一出口模式。
   *
   * 实现：调 Jina Reader（r.jina.ai/<url>），它专为 LLM 优化——自动正文抽取 + 转 markdown，
   * 去掉导航/广告/侧边栏噪音。返回 markdown 正文（已截断到 maxLength）。
   *
   * 容错：Jina 不可达时降级为「直接 fetch 原始 HTML + 去标签」，保证至少能拿到文本
   * （质量不如 Jina，但比完全失败好）。
   *
   * @returns { url, content, truncated, fetchedVia } fetchedVia 标识实际抓取路径（jina/direct/fail）
   */
  async fetchPage(url: string, maxLength = 6_000): Promise<{
    url: string;
    content: string;
    truncated: boolean;
    fetchedVia: 'jina' | 'direct' | 'fail';
    error?: string;
  }> {
    const limit = Math.min(20_000, Math.max(500, Math.trunc(maxLength)));

    // SSRF 防护：拒绝服务器抓取内网/云元数据/非 HTTP 协议的 URL。
    // WebFetch 的 URL 来自用户（经 WebFetch 工具），服务器端 fetch 内网地址会泄漏内网服务/云凭证。
    const ssrf = assertSafeFetchUrl(url);
    if (ssrf) {
      return { url, content: '', truncated: false, fetchedVia: 'fail', error: ssrf };
    }
    // 路径 1：Jina Reader（首选，正文抽取质量最高）。
    // 注意：不用 fetchWithTimeout（它用 PROVIDER_TIMEOUT_MS=6s，对 Jina 太短），直接 fetch + 30s 超时。
    try {
      const jinaUrl = `https://r.jina.ai/${url}`;
      const res = await fetch(jinaUrl, {
        headers: {
          Accept: 'text/markdown',
          'X-Return-Format': 'markdown',
          'User-Agent': 'Mozilla/5.0 (compatible; LingFangBot/1.0)',
        },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) {
        const text = await res.text();
        if (text && text.trim()) {
          const truncated = text.length > limit;
          return { url, content: text.slice(0, limit), truncated, fetchedVia: 'jina' };
        }
      }
      this.logger.warn(`Jina 抓取 ${url} 返回 ${res.status}，降级直接抓取`);
    } catch (e) {
      this.logger.warn(`Jina 抓取 ${url} 失败：${(e as Error).message}，降级直接抓取`);
    }

    // 路径 2：直接 fetch 原始 HTML + 粗暴去标签（Jina 不可达时的兜底，质量较低）。
    try {
      const res = await fetch(url, {
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        return { url, content: '', truncated: false, fetchedVia: 'fail', error: `目标网页返回 ${res.status}` };
      }
      const html = await res.text();
      // 去掉 script/style/nav/header/footer，再去标签，压空白。粗抽取，无正文识别。
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[\s\S]*?<\/nav>/gi, '')
        .replace(/<header[\s\S]*?<\/header>/gi, '')
        .replace(/<footer[\s\S]*?<\/footer>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;|&ensp;|&emsp;/g, ' ')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
      if (!text) return { url, content: '', truncated: false, fetchedVia: 'fail', error: '抓取到的正文为空（可能是 JS 渲染页）' };
      const truncated = text.length > limit;
      return { url, content: text.slice(0, limit), truncated, fetchedVia: 'direct' };
    } catch (e) {
      return { url, content: '', truncated: false, fetchedVia: 'fail', error: `抓取失败：${(e as Error).message}` };
    }
  }
}

/** 按规范化 URL 去重，保留首个出现（即更高优先级源）的条目。 */
export function dedupeByUrl(items: SearchResultItem[]): SearchResultItem[] {
  const seen = new Set<string>();
  const out: SearchResultItem[] = [];
  for (const it of items) {
    const key = normalizeUrl(it.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

/** URL 归一化（去尾斜杠 + 去常见追踪参数 + 小写 host），用于去重判等。 */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = '';
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'spm'].forEach((p) => u.searchParams.delete(p));
    const host = u.host.toLowerCase();
    const path = u.pathname.replace(/\/+$/, '');
    const search = u.searchParams.toString();
    return `${u.protocol}//${host}${path}${search ? `?${search}` : ''}`;
  } catch {
    return raw.trim().replace(/\/+$/, '');
  }
}
