# 设计：Gitee 更新日志接入 + 密钥配置

本设计基于三方评审 workflow（后端架构师 / 前端架构师 / 安全缓存专家）的交叉验证结论，所有技术论断均已对照实际代码行号。

## 一、模块边界

```
新增模块（后端）：
  gitee-changelog.service.ts   GiteeChangelogService（拉取+缓存+标准化+容灾）
  changelog.controller.ts      ChangelogController（@Public GET /api/changelog）
  dto/changelog.dto.ts         ChangelogEntry / ChangelogResponse（出参契约）
  gitee-changelog.service.spec.ts  单元测试

改动模块（后端）：
  settings.service.ts          KEY_VALIDATORS +3 key、SECRET_KEYS 审计脱敏、
                               GITEE_CACHE_KEYS 失效钩子、构造注入、getGiteeSettings、testGitee
  admin.controller.ts          GET settings/gitee + POST settings/test-gitee
  collab.module.ts             providers + controllers 各 +1
  settings.service.spec.ts     追加 Gitee 用例

新增模块（前端）：
  无（ChangelogPage/settings-view/releases.ts 均为改动）

改动模块（前端）：
  lib/releases.ts              ChangelogEntry/ChangelogResponse/listChangelog（不动 Release）
  components/landing/ChangelogPage.tsx  改用 listChangelog + 类型 + 降级横幅 + renderNotes 升级
  components/settings-view.tsx          新增 Gitee 配置卡片

不动：release.service.ts / release.controller.ts / release.dto.ts / schema.prisma
```

## 二、Gitee API 契约（已交叉验证）

| 项 | 值 | 来源 |
|---|---|---|
| 列表端点 | `GET https://gitee.com/api/v5/repos/{owner}/{repo}/releases` | gitee-php/gitee-sdk RepositoriesApi.md |
| 鉴权 | `Authorization: Bearer <token>`（**禁 query**） | 安全专家核验 app.module.ts redact 只覆盖 header/body |
| 分页 | `page`(1起) / `per_page`(默认20,上限100) / `direction`(asc/desc) | gitee-php/gitee-sdk |
| 字段 | snake_case：`id`(int) / `tag_name` / `name` / `body` / `created_at`(ISO) / `assets[].browser_download_url` | 官方 issue I7UFD9 Response Class |
| **无 published_at** | 用 `created_at` 排序 | 与 GitHub 的关键差异 |
| **无 draft** | Gitee 不暴露草稿状态 | 同上 |
| rate limit | 存在但数值未公开 | 官方 issue I3VUJD → 必须服务端缓存 |
| asset name/size | SDK 未完整建模 | 降级：不展示 size |

## 三、接口契约（定稿）

### PlatformSetting 新增 key（KEY_VALIDATORS 追加）

```ts
// owner/repo 共享校验：空值放行（读侧兜底默认）；非空时首尾字母数字、中间 ._、显式拒 ..
giteeOwner:      validateRepoSegment
giteeRepo:       validateRepoSegment
giteeAccessToken: 空 || /^[A-Za-z0-9_-]{20,200}$/（不 trim 之外做格式校验）
```

`validateRepoSegment` 实现（module 顶层）：

```ts
function validateRepoSegment(key: string): (raw: string) => string {
  return (raw) => {
    const v = raw.trim();
    if (v.length === 0) return '';           // 空=用默认（读侧兜底，同 smtpUrl 清空回退 .env 语义）
    if (v.length > 100) throw badRequest(`${key} 过长（上限 100 字符）`);
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(v))
      throw badRequest(`${key} 仅允许字母数字/点/下划线/连字符，首尾须字母数字`);
    if (v.includes('..')) throw badRequest(`${key} 不得含连续点（防路径穿越）`);
    return v;
  };
}
```

### GET /api/changelog（@Public，无 query）

```ts
interface ChangelogEntry {
  id: string;              // String(giteeId)，无 id 时用 tag_name 兜底
  version: string;         // tag_name 剥离前导 v/V
  title: string;           // name?.trim() || tag_name
  notes: string;           // body 原文（前端 renderNotes 解析）
  publishedAt: string | null;  // created_at ISO（Gitee 无 published_at）
  isLatest: boolean;       // 按 created_at desc 排序后首条 true
}
interface ChangelogResponse {
  source: 'gitee' | 'unconfigured';
  releases: ChangelogEntry[];
  degraded: boolean;       // true=本次降级（失败/限流/吐缓存兜底）
  message?: string;        // degraded=true 时给前端展示
}
```

### GET /api/admin/settings/gitee（ensurePlatformAdmin）

```ts
{ giteeOwner: string; giteeRepo: string; hasAccessToken: boolean }
// owner/repo 读侧兜底默认值（?? 'yijianruyuan' / ?? 'lingfang'），token 脱敏
```

### POST /api/admin/settings/test-gitee（ensurePlatformAdmin，无 body）

```ts
{ ok: boolean; configured: boolean; message: string }
// 探测 GET {GITEE_API_BASE}/repos/{owner}/{repo}/releases?per_page=1&page=1，Bearer，8s 超时
// 状态映射：200=通；401=token失效；403=缺scope；404=owner/repo错；429=限流；网络=异常
// 直接查库不读 gitee 缓存（避免缓存延迟掩盖问题，同 testCaptcha 注释）
```

### updateSettings 审计脱敏（settings.service.ts:203 修正）

```ts
const SECRET_KEYS = new Set(['smtpPass', 'geetestCaptchaKey', 'giteeAccessToken']);
// 审计循环内（upsert 之后、audit 之前）：
const auditMeta = SECRET_KEYS.has(item.key)
  ? { key: item.key, configured: item.value.length > 0 }
  : { key: item.key, value: item.value };
```

## 四、数据流

```
Gitee release (markdown body)
   │ GET releases?per_page=100&direction=desc, Bearer token, 8s 超时
   ▼
GiteeChangelogService.getChangelog
   ├─ 命中实例缓存(10min) → 直接返回 {source:'gitee', releases, degraded:false}
   └─ 未命中 → singleflight inflight 互斥
        ├─ loadGiteeConfig（读 PlatformSetting 3 key，token 空则 {source:'unconfigured'}）
        ├─ fetchReleases（内部全 try/catch 永不抛）
        │    └─ mapGiteeRelease: tag_name→version(剥v), name→title(fallback tag),
        │       body→notes, created_at→publishedAt, 按 created_at desc 排序后 index0→isLatest
        ├─ 成功 → 写缓存 → {source:'gitee', releases, degraded:false}
        └─ 失败(401/403/404/429/网络) → 不清缓存 → {source:'gitee', releases:cached||[], degraded:true, message}
   ▼
GET /api/changelog (@Public) → ChangelogResponse
   ▼
ChangelogPage (renderNotes 升级解析器, degraded 横幅)
```

下载链路不变：DownloadPage → GET /api/releases/latest（DB，含 signature）→ Tauri updater 校验签名。

## 五、GiteeChangelogService 核心实现要点

```ts
const GITEE_API_BASE = 'https://gitee.com/api/v5';
const DEFAULT_GITEE_OWNER = 'yijianruyuan';
const DEFAULT_GITEE_REPO = 'lingfang';
const GITEE_TIMEOUT_MS = 8_000;       // 比 geetest 5s 宽，Gitee 偶有慢响应
const GITEE_CACHE_TTL_MS = 600_000;   // 10min，外部限流

@Injectable()
export class GiteeChangelogService {
  private changelogCache: { value: ChangelogEntry[]; expiresAt: number } | null = null;
  private inflight: Promise<ChangelogEntry[]> | null = null;

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  invalidateChangelogCache(): void { this.changelogCache = null; }

  async getChangelog(): Promise<ChangelogResponse> { /* 见数据流 */ }

  // singleflight：回源期间并发请求共享同一个 Promise，避免 N 用户同时打 Gitee
  private async fetchWithCache(): Promise<ChangelogEntry[]> {
    const now = Date.now();
    if (this.changelogCache && this.changelogCache.expiresAt > now) return this.changelogCache.value;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const list = await this.doFetch();
        this.changelogCache = { value: list, expiresAt: now + GITEE_CACHE_TTL_MS };
        return list;
      } finally {
        this.inflight = null;   // 失败不写缓存，下次立即重试
      }
    })();
    return this.inflight;
  }

  private async doFetch(): Promise<ChangelogEntry[]> {
    // 读 config → 拼 URL（new URL 构造 + host 断言 === 'gitee.com'）→ Bearer fetch → map → sort
    // 全 try/catch：401/403/404/429/网络 → throw 让上层 catch 走降级
  }

  private mapGiteeRelease(r: GiteeReleaseRaw, index: number): ChangelogEntry {
    const tag = r.tag_name ?? '';
    return {
      id: r.id != null ? String(r.id) : tag,
      version: tag.replace(/^v/i, ''),
      title: (r.name?.trim()) || tag,
      notes: r.body ?? '',
      publishedAt: r.created_at ?? null,
      isLatest: index === 0,
    };
  }
}
```

URL 构造（SSRF 双保险）：

```ts
const owner = cfg.owner || DEFAULT_GITEE_OWNER;
const repo = cfg.repo || DEFAULT_GITEE_REPO;
const url = new URL(`/api/v5/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases`, GITEE_API_BASE);
url.searchParams.set('page', '1');
url.searchParams.set('per_page', '100');
url.searchParams.set('direction', 'desc');
if (url.hostname !== 'gitee.com') throw new Error('Gitee host 校验失败');
const res = await fetch(url, { headers: { Authorization: `Bearer ${cfg.accessToken}` }, signal });
```

## 六、缓存策略

| 缓存 | 位置 | TTL | 失效时机 | 并发保护 |
|---|---|---|---|---|
| changelogCache | GiteeChangelogService 实例字段 | 10min | updateSettings 命中 GITEE_CACHE_KEYS 调 invalidateChangelogCache（零窗口） | singleflight inflight Promise 去重 |
| publicInfoCache | module-level | 30s | updateSettings 末尾 publicInfoCache=null | 无（本地 DB 毫秒级） |
| mail.smtpCache | 实例 | 30s | MAIL_CACHE_KEYS 命中调 invalidateSmtpCache | 无 |
| geetest.configCache | 实例 | 30s | GEETEST_CACHE_KEYS 命中调 invalidateConfigCache | 无 |

- **失败不写缓存**：fetchReleases 异常返回的 `[]` 不进 cache（finally 只清 inflight），下次请求立即重试，避免「Gitee 抖动 → 缓存空 10min → 用户看不到更新」。
- **单实例约束**（文件头注释标注）：当前 collab-api 单实例，多实例部署需改 Redis 共享缓存。不为未来多实例现在引入 Redis（违反禁止过度架构）。

## 七、容灾降级

| 场景 | 行为 | HTTP |
|---|---|---|
| token 未配 | `{source:'unconfigured', releases:[], degraded:false, message}` | 200 |
| 成功 | 写缓存，`{source:'gitee', releases, degraded:false}` | 200 |
| 401（token 失效）| 不清缓存，吐 cached + degraded:true，message「Gitee token 已失效」 | 200 |
| 403（缺 scope）| 同上，message「token 缺少 repo 权限」 | 200 |
| 404（owner/repo 错）| 同上，message「owner/repo 不存在或无权访问」 | 200 |
| 429（限流）| **不清缓存**（缓存有效历史），吐 cached + degraded，message「Gitee 限流，展示缓存内容」 | 200 |
| 网络异常/超时 | 同 429，message「Gitee 暂时不可用，请稍后重试」 | 200 |
| ChangelogPage .catch | 网络层兜底 setReleases([]) | — |

前端降级横幅：degraded=true 时顶部橙色边框卡片显示 message，不阻断时间线渲染。

## 八、前端 renderNotes 升级（交付成败关键）

现有解析器只认 `## / - / > / **bold** / \`code\`` 5 种，Gitee body 标准含 `#`/`###`/图片/链接，不升级会渲染乱码。升级要点：

- 标题：`#`/`##`/`###` 全支持（正则 `/^(#{1,3})\s+(.*)$/`，level 决定 text-lg/base/sm）。
- 图片 `![alt](url)`：**必须在链接前匹配**（`!\[` 前缀），`<img>` + `loading="lazy"` + border。
- 链接 `[text](url)`：`<a target="_blank" rel="noopener noreferrer">` + accent 色。
- 列表 `- `/`* `：保留缩进（`paddingLeft: indent*0.5rem`），层级不塌平。
- `---` 分隔线：`<hr>`。
- 保留空行（原 `.filter(Boolean)` 塌了段落，改为返回 null 占位）。
- 多行代码块 fence ```` ``` ```` 不解析（标注「release notes 不建议贴代码块」），可接受。

## 九、前端 settings-view Gitee 卡片

复刻极验卡片（settings-view.tsx:509-640）结构：

- `giteeOwner` / `giteeRepo` 明文 Input（始终提交）。
- `giteeAccessToken` `type="password"` + placeholder `hasAccessToken ? '已配置，留空保持不变' : '（未配置）'`（仅 length>0 时提交）。
- 保存按钮 + 测试连通性按钮（POST test-gitee，改了未保存时提示先保存）。
- 配置状态 Badge：`giteeLoading ? '加载中' : hasAccessToken ? 'Gitee 已配置' : '未配置 · 更新日志降级'`。
- 说明文案：「更新日志源来自 Gitee release notes，下载页版本号来自本地已签名产物，两者可能不一致（属正常）」。

## 十、回滚点

- 后端：移除新增 4 文件 + 还原 settings.service.ts/admin.controller.ts/collab.module.ts 改动 + 删 3 个 PlatformSetting key（DB 数据无害，key/value 表）。
- `/api/releases` 完全不动，下载页 + Tauri updater 链路零影响。
- 前端：git revert（建议后端改动、前端改动各自独立 commit）。
