// 平台设置服务（key/value 键值表，平台 Admin 维护）。
//
// 设计契约：
//  - getSettings()：Admin 视角返回全部 key/value/description（含非公开字段），首行 ensurePlatformAdmin。
//  - updateSettings(actorId, dto)：批量 upsert（不存在则创建，存在则覆写 value），每项落审计。
//    key 受白名单约束（KEY_VALIDATORS），杜绝任意 key 注入（XSS 注入字段名、占位垃圾行）。
//    value 一律 String 入库（富文本/URL/开关均字符串存，由调用方按 key 解析），URL 类做格式校验。
//  - getPublicInfo()：不鉴权（@Public），仅返回白名单内的公开字段（platformName/logoUrl 等），
//    供官网落地页 / 桌面端展示平台名 logo，缺省值兜底（避免空字段导致前端渲染异常）。
//  - 审计 metadata 固定 shape {key, value}，写 AuditLog。
import { Inject, Injectable } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { createHmac } from 'node:crypto';
import { PrismaService } from '../prisma.service';
import { badRequest, unauthorized } from '../common';
import { AuthService } from './auth.service';
import { MailService } from './mail.service';
import { GeetestService } from './geetest.service';
import { GiteeChangelogService } from './gitee-changelog.service';
import {
  REVEALABLE_SECRET_KEYS,
  type RevealableSecretKey,
  type UpdateSettingsDto,
} from './dto/settings.dto';
import { AppCacheService, CACHE_DEFAULT_TTL_MS, createMemoryCacheStore } from '../cache.service';

/** 极验二次校验接口地址（与 geetest.service 保持一致，用于 testCaptcha 探测连通性）。 */
const GEETEST_VALIDATE_URL = 'http://gcaptcha4.geetest.com/validate';
/** 极验二次校验请求超时（毫秒，与 geetest.service 保持一致）。 */
const GEETEST_TIMEOUT_MS = 5_000;

/** 公开字段白名单：getPublicInfo 仅暴露这些 key（与官网 / 桌面端展示字段一一对应）。
 *  其余 key（运营内部备注、未发布开关、geetestCaptchaKey 等密钥）仅 Admin 可见，绝不在公开端点暴露。
 *  组C 极验：geetestCaptchaId 公开（前端需据此初始化极验组件），geetestScenes 公开（管理端前端按场景决定是否渲染验证码，
 *  场景未启用时不强制校验，与后端 requireAdminCaptcha(scene) 语义一致），但 geetestCaptchaKey 不公开（仅后端校验用）。 */
export const PUBLIC_SETTING_KEYS = [
  'platformName',
  'logoUrl',
  'geetestCaptchaId',
  'geetestScenes',
] as const;

/** 极验场景归一化：当前仅管理端场景生效；兼容旧配置 login/forgot，register 已无对应应用端验证码语义。 */
function normalizeGeetestScenes(raw: string): string {
  const order = ['admin_login', 'admin_forgot'] as const;
  const aliases: Record<string, (typeof order)[number] | null> = {
    admin_login: 'admin_login',
    admin_forgot: 'admin_forgot',
    login: 'admin_login',
    forgot: 'admin_forgot',
    register: null,
  };
  const valid = new Set<string>();
  const items = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const item of items) {
    if (!(item in aliases)) {
      throw badRequest(`geetestScenes 含未知场景：${item}（仅支持 admin_login/admin_forgot）`);
    }
    const mapped = aliases[item];
    if (mapped) valid.add(mapped);
  }
  return order.filter((s) => valid.has(s)).join(',');
}

/** value 校验规则表：key → 校验函数。
 *  - 非白名单 key：upsert 阶段直接 badRequest（KEY_VALIDATORS 缺该 key 即拒绝）。
 *  - 校验函数返回归一化后的 String；非法值抛 AppError(400)。
 *  - 默认对空值放行（允许清空某项设置），仅对非空值做格式校验。 */
const KEY_VALIDATORS: Record<string, (raw: string) => string> = {
  // 平台展示名：去除首尾空白；长度上限防滥用（>100 视为异常输入）。
  platformName: (raw) => {
    const v = raw.trim();
    if (v.length > 100) throw badRequest('platformName 过长（上限 100 字符）');
    return v;
  },
  // logo 链接：http/https 格式校验（非空时），防止存入 javascript: 等危险协议供前端误渲染。
  logoUrl: (raw) => {
    const v = raw.trim();
    if (v && !/^https?:\/\//i.test(v)) throw badRequest('logoUrl 必须是 http 或 https 链接');
    if (v.length > 500) throw badRequest('logoUrl 过长（上限 500 字符）');
    return v;
  },
  // 组A SMTP 连接 URL：支持完整 URL（smtps://host:465）或裸地址（smtpdm.aliyun.com:465）。
  // 裸地址自动补 smtps://（默认 SSL），避免用户填「smtpdm.aliyun.com」被拒。
  // 空值允许（清空=回退 .env fallback）。
  smtpUrl: (raw) => {
    let v = raw.trim();
    if (v.length > 500) throw badRequest('smtpUrl 过长（上限 500 字符）');
    if (!v) return v;
    // 已带协议前缀，直接校验格式。
    if (/^smtp(s)?:\/\/.+/i.test(v)) return v;
    // 裸地址（无协议前缀）：自动补 smtps://（默认 SSL/TLS，465 端口最常见）。
    // 用户填 smtpdm.aliyun.com:465 → smtps://smtpdm.aliyun.com:465
    // 用户填 smtpdm.aliyun.com（无端口）→ smtps://smtpdm.aliyun.com:465（补默认端口）
    if (/^[a-z0-9.-]+(:\d+)?$/i.test(v)) {
      // 无端口则补 :465（SSL 默认端口）。
      if (!/:\d+$/.test(v)) v += ':465';
      return `smtps://${v}`;
    }
    throw badRequest(
      'smtpUrl 格式不正确（示例：smtpdm.aliyun.com:465 或 smtps://smtpdm.aliyun.com:465）'
    );
  },
  // 组A SMTP 发件人地址：允许纯地址或「名称 <addr>」格式，长度上限防滥用。空值允许（用品牌默认）。
  smtpFrom: (raw) => {
    const v = raw.trim();
    if (v.length > 200) throw badRequest('smtpFrom 过长（上限 200 字符）');
    return v;
  },
  // 组A SMTP 认证用户名：trim 去空白，长度上限防滥用（不做邮箱格式校验，部分 SMTP user 是登录名非邮箱）。
  smtpUser: (raw) => {
    const v = raw.trim();
    if (v.length > 200) throw badRequest('smtpUser 过长（上限 200 字符）');
    return v;
  },
  // 组A SMTP 认证密码：不 trim（密码可能含首尾空白），仅限长度上限；空值允许（清空独立凭据回退 url 内嵌）。
  smtpPass: (raw) => {
    if (raw.length > 500) throw badRequest('smtpPass 过长（上限 500 字符）');
    return raw;
  },
  // 组C 极验 captchaId：trim 去空白，允许空（空=未配置，前端不显验证码，开发态跳过）。
  // 长度上限防滥用；极验官方 captchaId 为 32 位 hex，此处放宽到 100 容纳未来格式变化。
  geetestCaptchaId: (raw) => {
    const v = raw.trim();
    if (v.length > 100) throw badRequest('geetestCaptchaId 过长（上限 100 字符）');
    return v;
  },
  // 组C 极验 captchaKey：服务端私钥，仅后端校验用（绝不公开）。允许空（未配置）。
  // 长度上限防滥用；极验官方 captchaKey 为 32 位 hex，放宽到 200 容纳未来格式变化。
  geetestCaptchaKey: (raw) => {
    const v = raw.trim();
    if (v.length > 200) throw badRequest('geetestCaptchaKey 过长（上限 200 字符）');
    return v;
  },
  // 组C 极验场景开关：逗号分隔的管理端场景白名单（admin_login/admin_forgot），仅命中场景才强制验证码。
  // 兼容旧配置 login/forgot：会分别映射到 admin_login/admin_forgot；register 不再参与管理端场景。
  // 空串=全部场景关闭（即便配了 id/key 也不校验）。
  geetestScenes: (raw) => normalizeGeetestScenes(raw),
  // 组B 账户级密码重试锁定阈值：正整数（1~100），默认 5（auth.service.getLockConfig 在缺省/非法时兜底）。
  maxLoginAttempts: (raw) => {
    const v = raw.trim();
    const n = Number.parseInt(v, 10);
    if (!Number.isFinite(n) || n < 1 || n > 100)
      throw badRequest('maxLoginAttempts 必须是 1~100 的整数');
    return String(n);
  },
  // 组B 账户锁定持续分钟数：正整数（1~10080，上限一周），默认 15。
  lockDurationMinutes: (raw) => {
    const v = raw.trim();
    const n = Number.parseInt(v, 10);
    if (!Number.isFinite(n) || n < 1 || n > 10080)
      throw badRequest('lockDurationMinutes 必须是 1~10080 的整数');
    return String(n);
  },
  // 组D Gitee 更新日志：owner/repo 是路径段，拼进 fetch URL（gitee.com/api/v5/repos/{owner}/{repo}/releases），
  // 必须严限字符白名单防路径穿越 / 越权访问其他仓库（token 带 repo scope，可读 token 可见任意仓库）。
  // 命名规则参照 Gitee/GitHub：[A-Za-z0-9._-]，禁连续点（..）/斜杠/空格。允许空值（读侧兜底默认仓库）。
  giteeOwner: validateRepoSegment('giteeOwner'),
  giteeRepo: validateRepoSegment('giteeRepo'),
  // 组D Gitee 私人令牌：URL-safe 字符 [A-Za-z0-9_-]，长度 20~200（Gitee token 实际约 40 hex，放宽容未来格式变化）。
  // 允许空值（未配置则更新日志降级 unconfigured）。
  giteeAccessToken: (raw) => {
    const v = raw.trim();
    if (v && !/^[A-Za-z0-9_-]{20,200}$/.test(v))
      throw badRequest(
        'giteeAccessToken 格式不合法（仅允许字母数字、下划线、连字符，20~200 字符）'
      );
    return v;
  },
  // 组E 搜索源：自建 SearXNG 实例 URL（免密钥元搜索）。空=不配自建，仅用内置公共实例兜底。
  // 拼进 fetch URL（{base}/search?...），必须 http/https 防 javascript: 等危险协议；长度上限防滥用。
  searxngUrl: (raw) => {
    const v = raw.trim();
    if (v && !/^https?:\/\//i.test(v)) throw badRequest('searxngUrl 必须是 http 或 https 链接');
    if (v.length > 500) throw badRequest('searxngUrl 过长（上限 500 字符）');
    return v;
  },
  // 组E Tavily 搜索 API 密钥（管理员可选配置；用户永不填）。空=不启用该源。
  // Tavily key 形如 tvly-xx...，放宽到 URL-safe 字符 + 长度区间容未来格式变化。
  tavilyApiKey: (raw) => {
    const v = raw.trim();
    if (v && !/^[A-Za-z0-9_-]{10,200}$/.test(v))
      throw badRequest('tavilyApiKey 格式不合法（仅允许字母数字、下划线、连字符，10~200 字符）');
    return v;
  },
  // 组E Brave Search API 密钥（管理员可选配置；用户永不填）。空=不启用该源。
  braveApiKey: (raw) => {
    const v = raw.trim();
    if (v && !/^[A-Za-z0-9_-]{10,200}$/.test(v))
      throw badRequest('braveApiKey 格式不合法（仅允许字母数字、下划线、连字符，10~200 字符）');
    return v;
  },
  // 组F RBFLow 视频生成服务地址（平台运营实例）。桥转发 RBFLow 任务的 base URL（拼进 fetch path），
  // 必须 http/https 防 javascript: 等危险协议；长度上限防滥用。允许空（未配置=桥 /video/generate 报 503）。
  rbflowUrl: (raw) => {
    const v = raw.trim();
    if (v && !/^https?:\/\//i.test(v)) throw badRequest('rbflowUrl 必须是 http 或 https 链接');
    if (v.length > 500) throw badRequest('rbflowUrl 过长（上限 500 字符）');
    return v;
  },
  // 组F RBFLow 静态 API-KEY（服务端转发用，非用户可见）。与 giteeAccessToken 同款 URL-safe 字符校验。
  // 允许空（未配置=桥报 503 rbflow_not_configured）。
  rbflowApiKey: (raw) => {
    const v = raw.trim();
    if (v && !/^[A-Za-z0-9_-]{10,200}$/.test(v))
      throw badRequest('rbflowApiKey 格式不合法（仅允许字母数字、下划线、连字符，10~200 字符）');
    return v;
  },
};

/** Gitee owner/repo 路径段校验：仅 [A-Za-z0-9._-]，首尾须字母数字，禁连续点（防 ..），长度 0 或 1~100。
 *  空值放行（返回空串，service 读侧兜底默认）；非空值会拼进 fetch URL path，斜杠/空格/编码符一律拒绝，
 *  杜绝路径穿越与越权访问其他仓库。提取为共享函数（owner/repo 共用同一规则）。 */
function validateRepoSegment(key: string): (raw: string) => string {
  return (raw) => {
    const v = raw.trim();
    if (v.length === 0) return '';
    if (v.length > 100) throw badRequest(`${key} 过长（上限 100 字符）`);
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(v)) {
      throw badRequest(`${key} 仅允许字母数字/点/下划线/连字符，首尾须字母数字`);
    }
    if (v.includes('..')) throw badRequest(`${key} 不得含连续点（防路径穿越）`);
    return v;
  };
}

/** 密钥类 PlatformSetting key 集合：审计时对命中 key 脱敏（只记 {configured} 布尔，不记明文 value）。
 *  既有缺陷修复（本次随 giteeAccessToken 一并补）：updateSettings 原对 smtpPass/geetestCaptchaKey 也记明文。
 *  SECRET_KEYS 命中后审计 metadata 改记 {key, configured}，与 testCaptcha 同范式。 */
const SECRET_KEYS = new Set([
  'smtpPass',
  'geetestCaptchaKey',
  'giteeAccessToken',
  'tavilyApiKey',
  'braveApiKey',
  'rbflowApiKey',
]);

/** 影响 MailService SMTP / 品牌缓存的 PlatformSetting key 集合。
 *  组A：更新这些 key 后调用 mail.invalidateSmtpCache()，保证 admin 保存后下一封邮件即读到新配置（AC1），
 *  不依赖 SMTP_CACHE_TTL 过期。smtpUrl/smtpFrom/smtpUser/smtpPass 影响 SMTP 连接，platformName/logoUrl 影响品牌渲染。 */
const MAIL_CACHE_KEYS = new Set([
  'smtpUrl',
  'smtpFrom',
  'smtpUser',
  'smtpPass',
  'platformName',
  'logoUrl',
]);

/** 影响 GeetestService 极验配置缓存的 PlatformSetting key 集合。
 *  组C：更新这些 key 后调用 geetest.invalidateConfigCache()，使 admin 改极验配置后下一次管理端验证码校验即读到新值
 *  （与 SMTP 热生效语义一致）。geetestCaptchaId 同时影响公开信息缓存（已在 publicInfoCache=null 处失效），
 *  geetestCaptchaKey 仅后端校验用，geetestScenes 决定哪些场景强制校验，三者均需失效 geetest 配置缓存避免
 *  「前端已显示验证码、后端仍跳过校验」或「场景配置已改、后端仍按旧场景判定」不一致。 */
const GEETEST_CACHE_KEYS = new Set(['geetestCaptchaId', 'geetestCaptchaKey', 'geetestScenes']);

/** 影响 GiteeChangelogService 更新日志缓存的 PlatformSetting key 集合。
 *  组D：更新这些 key 后调用 gitee.invalidateChangelogCache()，使 admin 改 owner/repo/token 后下一次
 *  /api/changelog 回源拉取新配置结果（不依赖缓存 10min TTL 过期），与 mail/geetest 热生效语义一致。 */
const GITEE_CACHE_KEYS = new Set(['giteeOwner', 'giteeRepo', 'giteeAccessToken']);

const PUBLIC_INFO_CACHE_KEY = 'platform:public-info';
const fallbackPublicInfoCache = new AppCacheService(createMemoryCacheStore());

/** 重置公开信息缓存（仅供测试隔离用例间状态）。
 *  生产代码通过 updateSettings 自动失效，无需手动调用。导出以让单测在每个用例前清空 module-level 状态，
 *  避免「前一个用例填充的缓存被后一个用例命中」导致的测试顺序依赖。 */
export function resetPublicInfoCache(): void {
  void fallbackPublicInfoCache.delete(PUBLIC_INFO_CACHE_KEY);
}

@Injectable()
export class SettingsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(GeetestService) private readonly geetest: GeetestService,
    @Inject(GiteeChangelogService) private readonly gitee: GiteeChangelogService,
    @Inject(AppCacheService) private readonly cache: AppCacheService = fallbackPublicInfoCache
  ) {}

  /** GET /api/admin/settings：返回全部设置项（Admin 视角，含 description + updatedById）。
   *  数组返回而非对象——管理后台需展示 description/updatedAt/updatedBy，对象形式无法承载这些元字段。 */
  async getSettings(userId: string) {
    await this.auth.ensurePlatformAdmin(userId);
    const settings = await this.prisma.platformSetting.findMany({
      orderBy: { key: 'asc' },
      select: { key: true, value: true, description: true, updatedAt: true, updatedById: true },
    });
    return { settings };
  }

  /** PATCH /api/admin/settings：批量 upsert（不存在创建，存在覆写 value）。
   *  DTO 已用 class-validator 校验整体结构（对象或单元素数组），此处逐项校验 key 白名单 + value 格式。
   *  每项落一条审计（记录 key + 新值，便于追溯谁在何时改了哪项配置）。 */
  async updateSettings(actorId: string, dto: UpdateSettingsDto) {
    await this.auth.ensurePlatformAdmin(actorId);
    const entries = dto.settings;
    if (entries.length === 0) throw badRequest('至少提交一项设置');

    // 先全量校验（任一 key 非白名单 / value 非法则整批拒绝，避免部分写入造成配置不一致）。
    const normalized: Array<{ key: string; value: string }> = [];
    for (const entry of entries) {
      const validator = KEY_VALIDATORS[entry.key];
      if (!validator) throw badRequest(`不支持的平台设置 key：${entry.key}`);
      normalized.push({ key: entry.key, value: validator(entry.value) });
    }

    // 同一批设置必须原子提交：任一 upsert 或审计失败，整批回滚，避免 SMTP/极验/Gitee 多字段半更新。
    const results = await this.prisma.$transaction(async (tx) => {
      const written: Array<{ key: string; value: string }> = [];
      for (const item of normalized) {
        const setting = await tx.platformSetting.upsert({
          where: { key: item.key },
          create: { key: item.key, value: item.value, updatedById: actorId },
          update: { value: item.value, updatedById: actorId },
        });
        written.push({ key: setting.key, value: setting.value });
        // 密钥类 key 审计不记明文（防 token 经 AuditLog.metadata 泄漏）。
        // SECRET_KEYS={smtpPass,geetestCaptchaKey,giteeAccessToken} 命中后改记 {key, configured}，
        // 与 testCaptcha 同范式（metadata 仅记布尔）。非密钥 key 仍记明文 value（便于追溯配置变更）。
        const auditMeta = SECRET_KEYS.has(item.key)
          ? { key: item.key, configured: item.value.length > 0 }
          : { key: item.key, value: item.value };
        await tx.auditLog.create({
          data: {
            actorUserId: actorId,
            action: 'admin.setting.updated',
            targetType: 'PlatformSetting',
            targetId: item.key,
            metadata: auditMeta,
          },
        });
      }
      return written;
    });
    // 组E 性能：设置变更后失效公开信息缓存（platformName/logoUrl 可能被改），
    // 确保下一次 GET /api/platform-info 回源读取最新值（而非命中过期缓存）。
    await this.cache.delete(PUBLIC_INFO_CACHE_KEY);
    // 组A：SMTP / 品牌 key 变更时失效 MailService 缓存，保证 admin 保存后下一封邮件即读到新配置（AC1）。
    // 仅当本次提交含影响邮件的 key 时才清（避免无关 key 改动也无谓失效 SMTP 缓存）。
    if (normalized.some((item) => MAIL_CACHE_KEYS.has(item.key))) {
      this.mail.invalidateSmtpCache();
    }
    // 组C：极验 key 变更时失效 GeetestService 配置缓存，保证 admin 改极验配置后下一次校验即读到新值
    // （与 SMTP 热生效语义一致；geetestCaptchaId 公开缓存已在上方 publicInfoCache=null 处统一失效）。
    if (normalized.some((item) => GEETEST_CACHE_KEYS.has(item.key))) {
      this.geetest.invalidateConfigCache();
    }
    // 组D：Gitee key 变更时失效 GiteeChangelogService 更新日志缓存，保证 admin 改 owner/repo/token 后
    // 下一次 /api/changelog 回源拉取新配置结果（与 mail/geetest 热生效语义一致，不依赖 10min TTL 过期）。
    if (normalized.some((item) => GITEE_CACHE_KEYS.has(item.key))) {
      this.gitee.invalidateChangelogCache();
    }
    return { settings: results };
  }

  /** GET /api/platform-info：不鉴权（@Public），仅返回 PUBLIC_SETTING_KEYS 白名单内的字段。
   *  缺省值兜底：platformName 默认「LingFang」，logoUrl 默认空串（前端按需渲染占位），
   *  geetestCaptchaId 默认空串（未配置极验，前端不显验证码）。
   *  返回对象（非数组）：公开端点契约要求扁平 {platformName, logoUrl, geetestCaptchaId} 便于前端直接解构。
   *  组E 性能：命中内存缓存直接返回（TTL 内零 DB 查询），过期或被失效后回源查库并刷新缓存。 */
  async getPublicInfo() {
    return this.cache.remember(PUBLIC_INFO_CACHE_KEY, CACHE_DEFAULT_TTL_MS, async () => {
      const rows = await this.prisma.platformSetting.findMany({
        where: { key: { in: [...PUBLIC_SETTING_KEYS] } },
        select: { key: true, value: true },
      });
      const map = new Map(rows.map((r) => [r.key, r.value] as const));
      return {
        platformName: map.get('platformName') ?? 'LingFang',
        logoUrl: map.get('logoUrl') ?? '',
        // 组C 极验：captchaId 公开（前端据此初始化极验组件），缺省空串=未配置，前端不显验证码。
        geetestCaptchaId: (map.get('geetestCaptchaId') ?? '').trim(),
        // 组C 场景开关：geetestScenes 公开（前端按场景决定是否渲染/强制验证码，与后端 admin 场景语义一致）。
        // 缺省空串=全部场景关闭（即便配了 captchaId 也不强制）。
        geetestScenes: normalizeGeetestScenes(map.get('geetestScenes') ?? ''),
      };
    });
  }

  /** GET /api/admin/settings/smtp：返回当前生效的 SMTP 配置（PlatformSetting 优先，.env fallback），
   *  供 admin「邮件服务」编辑表单预填。仅平台 Admin 可调用。
   *
   *  凭据安全：smtpPass 永不返回明文（避免 SMTP 密码经 HTTP 响应泄漏到浏览器 / 日志），
   *  改返 hasSmtpPass 布尔（true=已配置密码）。前端密码输入框：hasSmtpPass=true 时显示占位提示「已配置」，
   *  admin 不改密码则留空提交（updateSettings 对空值放行，MailService 按现状用旧密码）。
   *  hasSmtpUrl 标记 SMTP 是否已配置（表单据此显示「测试发信」可用性提示）。 */
  async getSmtpSettings(userId: string) {
    await this.auth.ensurePlatformAdmin(userId);
    const rows = await this.prisma.platformSetting.findMany({
      where: { key: { in: ['smtpUrl', 'smtpFrom', 'smtpUser', 'smtpPass'] } },
      select: { key: true, value: true },
    });
    const map = new Map(rows.map((r) => [r.key, r.value] as const));
    // PlatformSetting 有值优先，无值回退 .env（兼容老配置 / 初始化）。
    const smtpUrl = (map.get('smtpUrl') || process.env.SMTP_URL || '').trim();
    const smtpFrom = (map.get('smtpFrom') || process.env.SMTP_FROM || '').trim();
    const smtpUser = (map.get('smtpUser') || '').trim();
    const smtpPass = map.get('smtpPass') || '';
    return {
      smtpUrl,
      smtpFrom,
      smtpUser,
      // 密码不返回明文，仅返回是否已配置（前端据 hasSmtpPass 显示「已配置」占位）。
      hasSmtpPass: smtpPass.length > 0,
      hasSmtpUrl: smtpUrl.length > 0,
    };
  }

  /** POST /api/admin/settings/test-email：发送测试邮件验证 SMTP 配置。
   *  仅平台 Admin 可调用（ensurePlatformAdmin）。to 由 Admin 手填（不限定当前邮箱，便于验证任意收件人）。
   *  返回 MailService.sendTestEmail 的结果（成功 / 失败 + 错误信息），供 Admin 判断 SMTP 是否配通。
   *  MailService 显式返回结果而非静默吞错：测试发信的目的就是「验证配置」，Admin 需看到失败原因。
   *  落审计：记录谁测试了发信（不记收件人邮箱全文，metadata 仅标 actor + 目标前缀防泄漏）。 */
  async testEmail(actorId: string, to: string) {
    await this.auth.ensurePlatformAdmin(actorId);
    const target = to?.trim().toLowerCase();
    if (!target || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target))
      throw badRequest('收件邮箱格式不正确');
    const result = await this.mail.sendTestEmail(target);
    await this.audit(actorId, 'admin.setting.test_email', 'PlatformSetting', undefined, {
      to: target.slice(0, 2) + '***',
      ok: result.ok,
      configured: result.configured,
    });
    return result;
  }

  /** GET /api/admin/settings/geetest：返回当前极验配置（供 admin「验证码服务」编辑表单预填）。
   *  仅平台 Admin 可调用。
   *  凭据安全：geetestCaptchaKey 永不返回明文（避免私钥经 HTTP 响应泄漏到浏览器 / 日志），
   *  改返 hasCaptchaKey 布尔（true=已配置私钥）。captchaId/scenes 明文返回（公开信息 / 场景开关非密钥）。 */
  async getGeetestSettings(userId: string) {
    await this.auth.ensurePlatformAdmin(userId);
    const rows = await this.prisma.platformSetting.findMany({
      where: { key: { in: ['geetestCaptchaId', 'geetestCaptchaKey', 'geetestScenes'] } },
      select: { key: true, value: true },
    });
    const map = new Map(rows.map((r) => [r.key, r.value] as const));
    const captchaId = (map.get('geetestCaptchaId') ?? '').trim();
    const captchaKey = map.get('geetestCaptchaKey') ?? '';
    const scenes = normalizeGeetestScenes(map.get('geetestScenes') ?? '');
    return {
      geetestCaptchaId: captchaId,
      // 私钥不返回明文，仅返回是否已配置（前端据 hasCaptchaKey 显示「已配置」占位）。
      hasCaptchaKey: captchaKey.length > 0,
      geetestScenes: scenes,
      hasCaptchaId: captchaId.length > 0,
    };
  }

  /** POST /api/admin/settings/test-captcha：测试极验配置是否可用（与 SMTP test-email 同模式）。
   *  仅平台 Admin 可调用。流程：
   *  1. ensurePlatformAdmin 守卫；
   *  2. 读当前 PlatformSetting 的 captchaId/captchaKey/scenes（直接查库，不读 geetest 缓存，避免缓存延迟掩盖问题）；
   *  3. 未配置 captchaId → 返回 configured=false（提示 admin 先填配置）；
   *  4. 已配置 → 向极验二次校验接口发一个空验证请求（4 参数为测试占位值），按响应状态判定连通性
   *     （result==='success' 视为通过；result!=='success' 但接口返回 200 视为「连通但验证失败」=配置有效；
   *     网络/状态异常 → configured=true + ok=false + message 提示网络或 key 问题）。
   *  落审计：记录谁测试了极验（metadata 仅记 actor + 是否成功，不记 key）。 */
  async testCaptcha(actorId: string) {
    await this.auth.ensurePlatformAdmin(actorId);
    const rows = await this.prisma.platformSetting.findMany({
      where: { key: { in: ['geetestCaptchaId', 'geetestCaptchaKey'] } },
      select: { key: true, value: true },
    });
    const map = new Map(rows.map((r) => [r.key, r.value] as const));
    const captchaId = (map.get('geetestCaptchaId') ?? '').trim();
    const captchaKey = map.get('geetestCaptchaKey') ?? '';

    if (!captchaId || !captchaKey) {
      const result = {
        ok: false,
        configured: false,
        message: '极验 captchaId / captchaKey 未配置，请先填写并保存。',
      };
      await this.audit(actorId, 'admin.setting.test_captcha', 'PlatformSetting', undefined, {
        ok: false,
        configured: false,
      });
      return result;
    }

    // 向极验二次校验接口发测试请求（用占位参数；目的不是验证通过，而是探测接口连通性 + key 是否被极验接受）。
    const sign_token = createHmac('sha256', captchaKey).update('test-lot-number').digest('hex');
    const form = new URLSearchParams({
      lot_number: 'test-lot-number',
      captcha_output: 'test-output',
      pass_token: 'test-pass-token',
      gen_time: String(Math.floor(Date.now() / 1000)),
      sign_token,
    });
    const url = `${GEETEST_VALIDATE_URL}?captcha_id=${encodeURIComponent(captchaId)}`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), GEETEST_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form.toString(),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        // 接口返回非 200：连通性异常（极验服务异常或 captchaId 被拒）。
        const result = {
          ok: false,
          configured: true,
          message: `极验接口返回异常状态（${res.status}），请检查 captchaId 是否正确。`,
        };
        await this.audit(actorId, 'admin.setting.test_captcha', 'PlatformSetting', undefined, {
          ok: false,
          configured: true,
        });
        return result;
      }
      const data = (await res.json()) as { result?: string; reason?: string };
      // result==='success' 几乎不可能（占位参数），但若返回 'success' 说明配置异常宽松；
      // 其余 result 值（如 'fail'）说明接口正常响应且按预期拒绝了占位请求 = 配置有效。
      const ok = data.result === 'success' || data.result === 'fail';
      const message = ok
        ? '极验配置连通正常，接口已响应。'
        : `极验接口返回未知结果（${data.result ?? '空'}），请检查 captchaId / captchaKey。`;
      const result = { ok, configured: true, message };
      await this.audit(actorId, 'admin.setting.test_captcha', 'PlatformSetting', undefined, {
        ok,
        configured: true,
      });
      return result;
    } catch (error) {
      // 网络异常 / 超时：连通性问题（与 GeetestService.validate 容灾语义不同——测试场景需明确告知 admin 失败）。
      const result = {
        ok: false,
        configured: true,
        message: `极验接口请求失败：${(error as Error).message}`,
      };
      await this.audit(actorId, 'admin.setting.test_captcha', 'PlatformSetting', undefined, {
        ok: false,
        configured: true,
      });
      return result;
    }
  }

  /** GET /api/admin/settings/gitee：返回当前 Gitee 更新日志源配置（供 admin 表单预填）。
   *  仅平台 Admin 可调用。凭据安全：giteeAccessToken 永不返回明文（避免私人令牌经 HTTP 响应泄漏），
   *  改返 hasAccessToken 布尔（true=已配置）。owner/repo 明文返回（非密钥）。复刻 getGeetestSettings 同款范式。 */
  async getGiteeSettings(userId: string) {
    await this.auth.ensurePlatformAdmin(userId);
    const rows = await this.prisma.platformSetting.findMany({
      where: { key: { in: ['giteeOwner', 'giteeRepo', 'giteeAccessToken'] } },
      select: { key: true, value: true },
    });
    const map = new Map(rows.map((r) => [r.key, r.value] as const));
    const accessToken = map.get('giteeAccessToken') ?? '';
    return {
      giteeOwner: (map.get('giteeOwner') ?? '').trim(),
      giteeRepo: (map.get('giteeRepo') ?? '').trim(),
      hasAccessToken: accessToken.length > 0,
    };
  }

  /** GET /api/admin/settings/search：读搜索源配置（searxngUrl 明文 + tavily/brave 密钥用 hasXxx 布尔脱敏）。
   *  复刻 getGiteeSettings 范式：密钥不回传明文，仅 hasXxx。仅平台 Admin 可调用。 */
  async getSearchSettings(userId: string) {
    await this.auth.ensurePlatformAdmin(userId);
    const rows = await this.prisma.platformSetting.findMany({
      where: { key: { in: ['searxngUrl', 'tavilyApiKey', 'braveApiKey'] } },
      select: { key: true, value: true },
    });
    const map = new Map(rows.map((r) => [r.key, r.value] as const));
    const tavilyKey = map.get('tavilyApiKey') ?? '';
    const braveKey = map.get('braveApiKey') ?? '';
    return {
      searxngUrl: (map.get('searxngUrl') ?? '').trim(),
      hasTavilyApiKey: tavilyKey.length > 0,
      hasBraveApiKey: braveKey.length > 0,
    };
  }

  /** GET /api/admin/settings/rbflow：读 RBFLow 视频生成服务配置（供 admin 表单预填）。
   *  仅平台 Admin 可调用。凭据安全：rbflowApiKey 永不返回明文（避免 API-KEY 经 HTTP 响应泄漏到浏览器），
   *  改返 hasApiKey 布尔（true=已配置）。rbflowUrl 明文返回（非密钥）。复刻 getGiteeSettings 范式。 */
  async getRbflowSettings(userId: string) {
    await this.auth.ensurePlatformAdmin(userId);
    const rows = await this.prisma.platformSetting.findMany({
      where: { key: { in: ['rbflowUrl', 'rbflowApiKey'] } },
      select: { key: true, value: true },
    });
    const map = new Map(rows.map((r) => [r.key, r.value] as const));
    const apiKey = map.get('rbflowApiKey') ?? '';
    return {
      rbflowUrl: (map.get('rbflowUrl') ?? '').trim(),
      hasApiKey: apiKey.length > 0,
    };
  }

  /** POST /api/admin/settings/test-rbflow：测试 RBFLow 服务连通性（与 test-gitee / test-captcha 同模式）。
   *  仅平台 Admin 可调用。探测 RBFLow GET {url}/api/v1/health（公开端点，不需鉴权；8s 超时），
   *  按状态码判定连通性（200 通 / 其他异常）。直接查库不读缓存。审计仅记 ok/configured/status，不记 key。 */
  async testRbflow(actorId: string) {
    await this.auth.ensurePlatformAdmin(actorId);
    const rows = await this.prisma.platformSetting.findMany({
      where: { key: { in: ['rbflowUrl'] } },
      select: { key: true, value: true },
    });
    const map = new Map(rows.map((r) => [r.key, r.value] as const));
    const url = (map.get('rbflowUrl') ?? '').trim();

    if (!url) {
      const result = {
        ok: false,
        configured: false,
        message: 'rbflowUrl 未配置，请先填写并保存。',
      };
      await this.audit(actorId, 'admin.setting.test_rbflow', 'PlatformSetting', undefined, {
        ok: false,
        configured: false,
      });
      return result;
    }

    const healthUrl = `${url.replace(/\/+$/, '')}/api/v1/health`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8_000);
      let res: Response;
      try {
        res = await fetch(healthUrl, { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      const message = mapRbflowStatus(res.status);
      const ok = res.ok;
      const result = { ok, configured: true, message };
      await this.audit(actorId, 'admin.setting.test_rbflow', 'PlatformSetting', undefined, {
        ok,
        configured: true,
        status: res.status,
      });
      return result;
    } catch (error) {
      const result = {
        ok: false,
        configured: true,
        message: `RBFLow 接口请求失败：${(error as Error).message}`,
      };
      await this.audit(actorId, 'admin.setting.test_rbflow', 'PlatformSetting', undefined, {
        ok: false,
        configured: true,
      });
      return result;
    }
  }

  /** POST /api/admin/settings/test-gitee：测试 Gitee 配置是否可用（与极验 test-captcha / SMTP test-email 同模式）。
   *  仅平台 Admin 可调用。探测实际生产路径 GET /repos/{owner}/{repo}/releases?per_page=1（Bearer，8s 超时），
   *  按状态码判定根因（200 通 / 401 token 失效 / 403 缺 scope / 404 owner-repo 错 / 429 限流）。
   *  直接查库不读 gitee 缓存（避免缓存延迟掩盖问题，同 testCaptcha）。审计仅记 ok/configured/status，不记 token。 */
  async testGitee(actorId: string) {
    await this.auth.ensurePlatformAdmin(actorId);
    const rows = await this.prisma.platformSetting.findMany({
      where: { key: { in: ['giteeOwner', 'giteeRepo', 'giteeAccessToken'] } },
      select: { key: true, value: true },
    });
    const map = new Map(rows.map((r) => [r.key, r.value] as const));
    const owner = (map.get('giteeOwner') ?? '').trim() || 'yijianruyuan';
    const repo = (map.get('giteeRepo') ?? '').trim() || 'lingfang';
    const accessToken = (map.get('giteeAccessToken') ?? '').trim();

    if (!accessToken) {
      const result = {
        ok: false,
        configured: false,
        message: 'giteeAccessToken 未配置，请先填写并保存。',
      };
      await this.audit(actorId, 'admin.setting.test_gitee', 'PlatformSetting', undefined, {
        ok: false,
        configured: false,
      });
      return result;
    }

    const url = `https://gitee.com/api/v5/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases?per_page=1&page=1`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8_000);
      let res: Response;
      try {
        // Bearer header（禁 ?access_token= query——pino 记录 req.url 会泄漏）。
        res = await fetch(url, {
          headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      const message = mapGiteeStatus(res.status);
      const ok = res.ok;
      const result = { ok, configured: true, message };
      await this.audit(actorId, 'admin.setting.test_gitee', 'PlatformSetting', undefined, {
        ok,
        configured: true,
        status: res.status,
      });
      return result;
    } catch (error) {
      const result = {
        ok: false,
        configured: true,
        message: `Gitee 接口请求失败：${(error as Error).message}`,
      };
      await this.audit(actorId, 'admin.setting.test_gitee', 'PlatformSetting', undefined, {
        ok: false,
        configured: true,
      });
      return result;
    }
  }

  /** POST /api/admin/settings/reveal-secret：查看敏感配置明文（SMTP 密码 / 极验私钥 / Gitee token）。
   *
   *  安全模型（敏感操作，三重防护）：
   *  1. ensurePlatformAdmin：仅平台管理员可调用（守卫一）。
   *  2. 密码二次确认：用 bcrypt.compare 校验 body.password 与当前用户 passwordHash，
   *     密码错误抛 unauthorized（防 admin 会话被劫持后无门槛查看明文密钥，守卫二）。
   *  3. key 白名单：DTO 层 @IsIn 已限 smtpPass / geetestCaptchaKey / giteeAccessToken，service 层再次断言（守卫三）。
   *
   *  审计：无论成功/失败都落 admin.setting.secret_revealed（metadata 仅记 key + ok，不记 value 明文）。 */
  async revealSecret(actorId: string, input: { password: string; key: string }) {
    const user = await this.auth.ensurePlatformAdmin(actorId);
    const key = input.key as RevealableSecretKey;
    if (!(REVEALABLE_SECRET_KEYS as readonly string[]).includes(key)) {
      throw badRequest('仅支持查看 smtpPass、geetestCaptchaKey 或 giteeAccessToken');
    }
    const passwordOk = await bcrypt.compare(input.password || '', user.passwordHash);
    if (!passwordOk) {
      await this.audit(actorId, 'admin.setting.secret_revealed', 'PlatformSetting', key, {
        key,
        ok: false,
      });
      throw unauthorized('管理员密码错误');
    }
    const row = await this.prisma.platformSetting.findUnique({
      where: { key },
      select: { value: true },
    });
    await this.audit(actorId, 'admin.setting.secret_revealed', 'PlatformSetting', key, {
      key,
      ok: true,
    });
    return { value: row?.value ?? '' };
  }

  private async audit(
    actorUserId: string,
    action: string,
    targetType: string,
    targetId?: string,
    metadata?: unknown
  ) {
    await this.prisma.auditLog.create({
      data: { actorUserId, action, targetType, targetId, metadata: metadata as object },
    });
  }
}

/** Gitee 探测响应状态码 → 友好 message 映射（供 testGitee 使用）。 */
function mapGiteeStatus(status: number): string {
  if (status === 200) return 'Gitee 配置连通正常，接口已响应。';
  if (status === 401) return 'Gitee token 已失效，请重新生成私人令牌。';
  if (status === 403) return 'Gitee token 缺少 repo 权限，请确认令牌勾选了项目权限。';
  if (status === 404) return 'owner/repo 不存在或令牌无权访问该仓库。';
  if (status === 429) return 'Gitee 接口限流，请稍后重试。';
  return `Gitee 接口返回异常状态（${status}），请检查 owner/repo/token 是否正确。`;
}

/** RBFLow 探测响应状态码 → 友好 message 映射（供 testRbflow 使用）。
 *  /api/v1/health 是公开端点（不需鉴权），主要判连通性 + 服务存活。 */
function mapRbflowStatus(status: number): string {
  if (status === 200) return 'RBFLow 服务连通正常，健康检查通过。';
  if (status === 404)
    return 'RBFLow 服务未找到 /api/v1/health，请检查 URL 是否指向正确的 RBFLow 实例。';
  if (status === 502 || status === 503)
    return 'RBFLow 服务暂时不可用（502/503），可能正在重启或过载。';
  return `RBFLow 健康检查返回异常状态（${status}），请检查 URL 是否正确。`;
}
