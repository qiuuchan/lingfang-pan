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
import { PrismaService } from '../prisma.service';
import { badRequest } from '../common';
import { AuthService } from './auth.service';
import { MailService } from './mail.service';
import type { UpdateSettingsDto } from './dto/settings.dto';

/** 公开字段白名单：getPublicInfo 仅暴露这些 key（与官网 / 桌面端展示字段一一对应）。
 *  其余 key（运营内部备注、未发布开关等）仅 Admin 可见，绝不在公开端点暴露。 */
export const PUBLIC_SETTING_KEYS = ['platformName', 'logoUrl'] as const;

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
};

/** 公开信息（platformName/logoUrl）的内存缓存 TTL（毫秒）。
 *  该端点 @Public 且为高频访问（官网落地页 + 桌面端启动页每次加载都请求），
 *  PlatformSetting 表改动极少（仅 Admin 改平台名/logo 时变），缓存 30s 可消除绝大多数 DB 查询。
 *  组E 性能：module-level cache + 手动失效（updateSettings 改公开 key 时清缓存），不引入 Redis 等外部依赖。 */
const PUBLIC_INFO_CACHE_TTL_MS = 30_000;

/** 缓存条目：值快照 + 过期时间戳。expiresAt=0 表示已失效（下次请求重新查库）。 */
interface PublicInfoCacheEntry {
  value: { platformName: string; logoUrl: string };
  expiresAt: number;
}

/** module-level 缓存：进程内单例，所有 SettingsService 实例共享。
 *  NestJS 默认 singleton scope，此变量等价于实例字段，但用 module-level 避免与 DI 生命周期耦合。
 *  null = 未填充（首次请求或被失效后）。 */
let publicInfoCache: PublicInfoCacheEntry | null = null;

/** 重置公开信息缓存（仅供测试隔离用例间状态）。
 *  生产代码通过 updateSettings 自动失效，无需手动调用。导出以让单测在每个用例前清空 module-level 状态，
 *  避免「前一个用例填充的缓存被后一个用例命中」导致的测试顺序依赖。 */
export function resetPublicInfoCache(): void {
  publicInfoCache = null;
}

@Injectable()
export class SettingsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(MailService) private readonly mail: MailService,
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

    // 逐项 upsert（key 为主键，create/update 分支写 updatedById + value）。
    // 未做事务包裹：设置项之间无关联不变量，逐项独立 upsert 即可，失败一项不影响已落库的其他项
    // （审计只对成功落库的项写入，保证审计与数据一致）。
    const results: Array<{ key: string; value: string }> = [];
    for (const item of normalized) {
      const setting = await this.prisma.platformSetting.upsert({
        where: { key: item.key },
        create: { key: item.key, value: item.value, updatedById: actorId },
        update: { value: item.value, updatedById: actorId },
      });
      results.push({ key: setting.key, value: setting.value });
      await this.audit(actorId, 'admin.setting.updated', 'PlatformSetting', item.key, { key: item.key, value: item.value });
    }
    // 组E 性能：设置变更后失效公开信息缓存（platformName/logoUrl 可能被改），
    // 确保下一次 GET /api/platform-info 回源读取最新值（而非命中过期缓存）。
    publicInfoCache = null;
    return { settings: results };
  }

  /** GET /api/platform-info：不鉴权（@Public），仅返回 PUBLIC_SETTING_KEYS 白名单内的字段。
   *  缺省值兜底：platformName 默认「LingFang」，logoUrl 默认空串（前端按需渲染占位）。
   *  返回对象（非数组）：公开端点契约要求扁平 {platformName, logoUrl} 便于前端直接解构。
   *  组E 性能：命中内存缓存直接返回（TTL 内零 DB 查询），过期或被失效后回源查库并刷新缓存。 */
  async getPublicInfo() {
    const now = Date.now();
    if (publicInfoCache && publicInfoCache.expiresAt > now) {
      return publicInfoCache.value;
    }
    const rows = await this.prisma.platformSetting.findMany({
      where: { key: { in: [...PUBLIC_SETTING_KEYS] } },
      select: { key: true, value: true },
    });
    const map = new Map(rows.map((r) => [r.key, r.value] as const));
    const value = {
      platformName: map.get('platformName') ?? 'LingFang',
      logoUrl: map.get('logoUrl') ?? '',
    };
    publicInfoCache = { value, expiresAt: now + PUBLIC_INFO_CACHE_TTL_MS };
    return value;
  }

  /** POST /api/admin/settings/test-email：发送测试邮件验证 SMTP 配置。
   *  仅平台 Admin 可调用（ensurePlatformAdmin）。to 由 Admin 手填（不限定当前邮箱，便于验证任意收件人）。
   *  返回 MailService.sendTestEmail 的结果（成功 / 失败 + 错误信息），供 Admin 判断 SMTP 是否配通。
   *  MailService 显式返回结果而非静默吞错：测试发信的目的就是「验证配置」，Admin 需看到失败原因。
   *  落审计：记录谁测试了发信（不记收件人邮箱全文，metadata 仅标 actor + 目标前缀防泄漏）。 */
  async testEmail(actorId: string, to: string) {
    await this.auth.ensurePlatformAdmin(actorId);
    const target = to?.trim().toLowerCase();
    if (!target || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target)) throw badRequest('收件邮箱格式不正确');
    const result = await this.mail.sendTestEmail(target);
    await this.audit(actorId, 'admin.setting.test_email', 'PlatformSetting', undefined, {
      to: target.slice(0, 2) + '***',
      ok: result.ok,
      configured: result.configured,
    });
    return result;
  }

  private async audit(actorUserId: string, action: string, targetType: string, targetId?: string, metadata?: unknown) {
    await this.prisma.auditLog.create({ data: { actorUserId, action, targetType, targetId, metadata: metadata as object } });
  }
}
