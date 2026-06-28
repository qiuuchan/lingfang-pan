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
} from './providers';

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
    const settled = await Promise.allSettled(
      healthy.map(async (p) => {
        const items = await p.search(query, limit, controller.signal);
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

    const results = dedupeByUrl(merged).slice(0, MAX_LIMIT);
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
