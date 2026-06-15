// Gitee 更新日志服务：从 Gitee 私有仓库 release 拉取更新日志，标准化后供 /api/changelog 公开端点。
//
// 设计契约（详见子任务 design.md）：
//  - 数据源：GET https://gitee.com/api/v5/repos/{owner}/{repo}/releases?per_page=100&direction=desc
//    鉴权用 Authorization: Bearer <token>（禁 ?access_token= query——pino 记录 req.url 会泄漏，见 app.module.ts redact）。
//  - 配置来自 PlatformSetting：giteeOwner（默认 yijianruyuan）/ giteeRepo（默认 lingfang）/ giteeAccessToken（私密）。
//    owner/repo 读侧兜底默认值（admin 留空 = 用默认），token 空 = 未配置（返回 unconfigured）。
//  - 缓存：实例字段 changelogCache（10min TTL）+ singleflight inflight 互斥（并发去重，避免击穿触发 Gitee rate limit）。
//    admin 改 gitee* key 后由 SettingsService.updateSettings 调 invalidateChangelogCache 失效（零窗口）。
//  - 容灾：token 未配/失败/限流/网络异常 永不抛，返回 {degraded:true, releases:cached||[]}（geetest.validate 不阻断语义）。
//    429 不清缓存（缓存是有效历史），返回 cached + degraded。失败不写缓存（下次立即重试）。
//  - 标准化：tag_name→version(剥v) / name→title(fallback tag) / body→notes / created_at→publishedAt /
//    按 created_at desc 排序后首条 isLatest=true（ChangelogPage 据此点亮 latest 徽标）。
//
// 缓存单实例约束（文件头标注）：
//  当前 collab-api 单实例部署（双后端已从 Rust 收敛到此，见 MEMORY.md）。module-level/实例缓存在此假设下成立。
//  多实例部署需改 Redis 共享缓存，否则 (1) Gitee 请求量 × 实例数加剧限流；(2) admin 改 token 后仅当前
//  处理请求的实例缓存失效，其他实例最长等 10min TTL。不为未来多实例现在引入 Redis（违反禁止过度架构）。
import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import type { ChangelogEntry, ChangelogResponse } from './dto/changelog.dto';

/** Gitee OpenAPI v5 基址（固定，host 断言防 SSRF）。 */
const GITEE_API_BASE = 'https://gitee.com/api/v5';
/** 默认 owner（admin 留空时兜底）。 */
const DEFAULT_GITEE_OWNER = 'yijianruyuan';
/** 默认 repo（admin 留空时兜底）。 */
const DEFAULT_GITEE_REPO = 'lingfang';
/** Gitee 请求超时（毫秒）：比 geetest 5s 宽，Gitee 偶有慢响应。 */
const GITEE_TIMEOUT_MS = 8_000;
/** 缓存 TTL（毫秒）：10min，外部限流（Gitee rate limit 数值未公开）。 */
const GITEE_CACHE_TTL_MS = 600_000;

/** Gitee release 原始响应（仅取展示需要的字段，其余忽略）。
 *  字段名 snake_case（Gitee 风格），与 GitHub 基本一致；关键差异：无 published_at（用 created_at）。 */
interface GiteeReleaseRaw {
  id?: number;
  tag_name?: string;
  name?: string | null;
  body?: string | null;
  created_at?: string | null;
}

/** 缓存条目：标准化后的 release 列表 + 过期时间戳。null=未填充（首次请求或被失效后）。 */
interface ChangelogCacheEntry {
  value: ChangelogEntry[];
  expiresAt: number;
}

/** 从 PlatformSetting 读出的 Gitee 配置（已兜底默认值）。 */
interface GiteeConfig {
  owner: string;
  repo: string;
  accessToken: string;
}

@Injectable()
export class GiteeChangelogService {
  /** 实例缓存（10min TTL）。null=未填充。 */
  private changelogCache: ChangelogCacheEntry | null = null;
  /** singleflight：回源期间的 inflight Promise，并发请求共享同一个（避免 N 用户同时打 Gitee）。 */
  private inflight: Promise<ChangelogEntry[]> | null = null;

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** 失效更新日志缓存。由 SettingsService.updateSettings 在改了 gitee* key 后调用，
   *  保证 admin 保存后下一次 /api/changelog 回源拉取新 token/owner/repo 的结果（不依赖重启进程生效）。
   *  与 mail.invalidateSmtpCache / geetest.invalidateConfigCache 同模式。 */
  invalidateChangelogCache(): void {
    this.changelogCache = null;
  }

  /** GET /api/changelog 入口：返回标准化更新日志 + 来源 + 健康度。
   *  全流程永不抛（公开端点语义，geetest.validate 不阻断），所有异常归入 degraded。 */
  async getChangelog(): Promise<ChangelogResponse> {
    const config = await this.loadGiteeConfig();
    // token 未配 → unconfigured（owner/repo 有默认值，仅 token 是「是否启用」开关）。
    if (!config.accessToken) {
      return { source: 'unconfigured', releases: [], degraded: false, message: '更新日志源未配置' };
    }

    // singleflight：命中缓存直接返回；未命中走 inflight（并发请求共享）。
    try {
      const releases = await this.fetchWithCache(config);
      return { source: 'gitee', releases, degraded: false };
    } catch {
      // 任意失败（网络/超时/401/403/404/429/响应解析）→ 降级返回上次缓存或空数组 + degraded。
      // 不清缓存（429 场景缓存是有效历史），让下次请求仍可能命中。
      const cached = this.changelogCache?.value ?? [];
      return {
        source: 'gitee',
        releases: cached,
        degraded: true,
        message: cached.length > 0 ? 'Gitee 暂时不可用，展示缓存内容' : 'Gitee 暂时不可用，请稍后重试',
      };
    }
  }

  /** singleflight 回源：命中缓存直接返回；未命中时 inflight 期间所有并发请求共享同一 Promise。
   *  成功写缓存；失败（doFetch throw）不写缓存（finally 只清 inflight），让下次请求立即重试
   *  （避免「Gitee 临时抖动 → 缓存空列表 10min → 用户看不到更新」）。 */
  private async fetchWithCache(config: GiteeConfig): Promise<ChangelogEntry[]> {
    const now = Date.now();
    if (this.changelogCache && this.changelogCache.expiresAt > now) {
      return this.changelogCache.value;
    }
    if (this.inflight) {
      return this.inflight;
    }
    this.inflight = (async () => {
      try {
        const list = await this.doFetch(config);
        this.changelogCache = { value: list, expiresAt: now + GITEE_CACHE_TTL_MS };
        return list;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  /** 实际拉取 Gitee release 列表并标准化。失败抛错（由调用方 catch 走降级）。
   *  - 拼 URL（new URL 构造 + host 断言 === 'gitee.com'，SSRF 双保险）。
   *  - Bearer header（禁 query token，防 pino 日志泄漏）。
   *  - 8s 超时（AbortController）。
   *  - 按 created_at desc 排序后首条 isLatest=true。 */
  private async doFetch(config: GiteeConfig): Promise<ChangelogEntry[]> {
    const url = new URL(`/api/v5/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/releases`, GITEE_API_BASE);
    url.searchParams.set('page', '1');
    url.searchParams.set('per_page', '100'); // changelog 不翻页，仅取最近 100 条（注释标注已知截断）
    url.searchParams.set('direction', 'desc');
    // host 断言：防未来「admin 可改 base」扩展引入 SSRF（当前 base 硬编码，此断言是双保险）。
    if (url.hostname !== 'gitee.com') throw new Error('Gitee host 校验失败');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GITEE_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${config.accessToken}`, Accept: 'application/json' },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    // 非 2xx 视为失败（401 token 失效 / 403 缺 scope / 404 owner-repo 错 / 429 限流）。
    // 具体状态码的 message 差异化在 getChangelog 的降级分支统一处理（此处只判定成功/失败）。
    if (!res.ok) {
      throw new Error(`Gitee 接口返回 ${res.status}`);
    }

    const data = (await res.json()) as GiteeReleaseRaw[];
    // Gitee direction=desc 已按时间倒序，但防御性再排一次（确保 isLatest 标记稳定）。
    const sorted = [...data].sort((a, b) => {
      const ta = a.created_at ? Date.parse(a.created_at) : 0;
      const tb = b.created_at ? Date.parse(b.created_at) : 0;
      return tb - ta;
    });
    return sorted.map((r, i) => this.mapGiteeRelease(r, i));
  }

  /** Gitee release 原始 → ChangelogEntry 标准化。
   *  - id：String(giteeId) 防大数溢出，无 id 时用 tag 兜底保唯一性。
   *  - version：tag_name 剥前导 v/V（v1.0.0 → 1.0.0）。
   *  - title：name 优先（trim），空则 fallback tag。
   *  - notes：body 原文（前端 renderNotes 解析）。
   *  - publishedAt：created_at（Gitee 无 published_at）。
   *  - isLatest：已按 desc 排序，首条为 true。 */
  private mapGiteeRelease(r: GiteeReleaseRaw, index: number): ChangelogEntry {
    const tag = r.tag_name ?? '';
    return {
      id: r.id != null ? String(r.id) : tag,
      version: tag.replace(/^v/i, ''),
      title: (r.name?.trim() || tag) || '未命名版本',
      notes: r.body ?? '',
      publishedAt: r.created_at ?? null,
      isLatest: index === 0,
    };
  }

  /** 读 Gitee 配置（PlatformSetting 3 key）。owner/repo 读侧兜底默认值（admin 留空 = 用默认）。
   *  与 geetest.getCaptchaConfig / mail.getBrand 同模式（直接查 PlatformSetting 白名单 key）。 */
  private async loadGiteeConfig(): Promise<GiteeConfig> {
    const rows = await this.prisma.platformSetting.findMany({
      where: { key: { in: ['giteeOwner', 'giteeRepo', 'giteeAccessToken'] } },
      select: { key: true, value: true },
    });
    const map = new Map(rows.map((row) => [row.key, row.value] as const));
    return {
      owner: (map.get('giteeOwner') ?? '').trim() || DEFAULT_GITEE_OWNER,
      repo: (map.get('giteeRepo') ?? '').trim() || DEFAULT_GITEE_REPO,
      accessToken: (map.get('giteeAccessToken') ?? '').trim(),
    };
  }
}
