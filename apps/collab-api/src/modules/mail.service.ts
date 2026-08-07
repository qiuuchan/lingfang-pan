import { Inject, Injectable } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { PrismaService } from '../prisma.service';
import { setServers } from 'node:dns';

// 修复系统代理（Clash/V2Ray TUN 模式）劫持 DNS 导致 queryA ETIMEOUT：
// 显式指定公共 DNS 服务器（阿里 223.5.5.5 + Google 8.8.8.8），绕过系统 DNS 配置。
// 仅影响 dns.resolve* 系列（不影响 dns.lookup/getaddrinfo），nodemailer lookup 回调用 resolve4。
// 安全：公共 DNS 只做域名→IP 解析（无副作用），与系统 DNS 等价但不受代理 TUN 劫持。
try {
  setServers(['223.5.5.5', '8.8.8.8']);
} catch {
  // setServers 失败不阻塞（极端环境 dns 模块不可用时回退系统默认）。
}

/**
 * 邮件服务（SMTP 配置来源：后台 PlatformSetting 优先，.env 仅作 fallback）。
 *
 * SMTP 配置（smtpUrl / smtpFrom / smtpUser / smtpPass）存 PlatformSetting 表，admin 在
 * 「平台设置 → 邮件服务」页编辑，保存后运行时立即生效（无需重启进程）。
 * .env 的 SMTP_URL / SMTP_FROM 保留作 fallback：PlatformSetting 无值时读 env，兼容老配置。
 *
 * 设计理由：
 *  - 配置来源优先级 PlatformSetting > .env：后台可热改 SMTP（换服务商 / 改密码），
 *    而改 .env 需重启进程、泄漏到容器编排配置，运维成本高。
 *  - mail.service 不注入 SettingsService（避免循环依赖：SettingsService → MailService），
 *    直接用 PrismaService 查 SMTP 白名单 key（与 getBrand 同款直查模式）。
 *
 * SMTP 未配置（PlatformSetting 与 .env 均无 smtpUrl）时，sendMail 显式抛错，
 * 避免调用方误以为验证/重置邮件已经真实发出。
 *
 * nodemailer 认证合并坑（github issue #1762）：createTransport 传 connection url 时，
 * 其余 options（如 auth）被忽略——url 独占解析。为支持「smtpUrl 给主机端口 + 独立 smtpUser/smtpPass
 * 给凭据」的拆分配置，统一改用 options 对象形式构建 transporter（buildTransporterOptions 解析 url）：
 * 从 smtpUrl 解析 host/port/secure，auth 凭据按优先级取（独立 user/pass 优先 > url 内嵌 user/pass）。
 *
 * 平台品牌：邮件 HTML 模板读取 PlatformSetting 的 platformName / logoUrl（缺省值兜底），
 * 实现统一品牌外观（平台名 logo、统一页脚）。
 */
@Injectable()
export class MailService {
  /** SMTP 配置 + 品牌信息统一缓存（启动后或配置变更后首次发信时填充）。
   *  TTL 失效 + updateSettings 改 SMTP/品牌 key 时手动 invalidateSmtpCache，二者结合：
   *  - TTL：防止极端场景下 admin 改了配置但忘了清缓存（兜底过期，最长 TTL 后必回源）。
   *  - 手动失效：SettingsService.updateSettings 写完后立即清，保证 admin 保存后下一封邮件即生效（AC1）。 */
  private smtpCache: SmtpConfigCache | null = null;

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * 加载并缓存 SMTP 配置（含品牌信息），来源：PlatformSetting 优先，.env fallback。
   * 命中缓存且未过期直接返回；否则查库并刷新缓存。
   */
  private async loadConfig(): Promise<SmtpConfig> {
    const now = Date.now();
    if (this.smtpCache && this.smtpCache.expiresAt > now) return this.smtpCache.value;
    const rows = await this.prisma.platformSetting.findMany({
      where: { key: { in: [...CONFIG_KEYS] } },
      select: { key: true, value: true },
    });
    const map = new Map(rows.map((r) => [r.key, r.value] as const));
    const cfg: SmtpConfig = {
      // PlatformSetting 有值优先，无值回退 .env（兼容老配置 / 初始化）。
      smtpUrl: (map.get('smtpUrl') || process.env.SMTP_URL || '').trim(),
      smtpFrom: (map.get('smtpFrom') || process.env.SMTP_FROM || '').trim(),
      smtpUser: (map.get('smtpUser') || '').trim(),
      smtpPass: map.get('smtpPass') || '',
      platformName: map.get('platformName') || 'LingFang',
      logoUrl: map.get('logoUrl') || '',
    };
    this.smtpCache = { value: cfg, expiresAt: now + SMTP_CACHE_TTL_MS };
    return cfg;
  }

  /**
   * 失效 SMTP + 品牌缓存。由 SettingsService.updateSettings 在改了 SMTP/品牌 key 后调用，
   * 保证 admin 保存后下一封邮件即读到新配置（不依赖 TTL 过期）。
   */
  invalidateSmtpCache(): void {
    this.smtpCache = null;
  }

  /** SMTP 是否已配置（smtpUrl 非空 = 可尝试真实发送）。 */
  async isConfigured(): Promise<boolean> {
    const cfg = await this.loadConfig();
    return cfg.smtpUrl.length > 0;
  }

  /** 平台品牌信息（platformName / logoUrl），缺省值兜底。 */
  private async getBrand(cfg: SmtpConfig): Promise<{ platformName: string; logoUrl: string }> {
    return { platformName: cfg.platformName, logoUrl: cfg.logoUrl };
  }

  /** 发件人地址：smtpFrom 未配时用默认（含品牌名，便于收件人识别）。 */
  private async fromAddress(cfg: SmtpConfig): Promise<string> {
    const { platformName } = await this.getBrand(cfg);
    return cfg.smtpFrom || `${platformName} <no-reply@lingfang.local>`;
  }

  /**
   * 根据 smtpUrl + 独立 user/pass 构建 nodemailer transporter（options 对象形式）。
   *
   * 解析逻辑（nodemailer issue #1762：裸 url 会独占解析、忽略 options.auth，故必须对象化）：
   *  - smtps:// → secure=true（465 端口 TLS 直连）；smtp:// → secure 依端口判断（465=true，其余 false）。
   *  - host/port/secure 永远从 smtpUrl 解析（URL 是连接信息的唯一来源）。
   *  - auth 凭据优先级：独立 smtpUser/smtpPass（admin 拆分配置）> smtpUrl 内嵌的 user:pass。
   *    二者皆无则不发 auth（服务端无认证场景，如本地 relay）。
   *  - smtpUrl 非法（解析失败）返回 null，调用方按「配置无效」报错。
   */
  private async buildTransporter(cfg: SmtpConfig): Promise<Transporter | null> {
    const normalized = normalizeSmtpUrl(cfg.smtpUrl);
    if (!normalized) return null;
    let parsed: URL;
    try {
      parsed = new URL(normalized);
    } catch {
      console.error('[mail.smtp_url_invalid]', { url: cfg.smtpUrl });
      return null;
    }
    const isSmtps = parsed.protocol === 'smtps:';
    const port = parsed.port ? Number(parsed.port) : isSmtps ? 465 : 587;
    const secure = isSmtps || port === 465;
    const authUser = cfg.smtpUser || (parsed.username ? decodeURIComponent(parsed.username) : '');
    const authPass = cfg.smtpPass || (parsed.password ? decodeURIComponent(parsed.password) : '');

    // 修复系统代理（Clash/V2Ray TUN）劫持 DNS 导致 nodemailer queryA ETIMEOUT：
    // 创建 transporter 前先用独立 Resolver（公共 DNS 223.5.5.5）解析出 IP，host 直接用 IP。
    // TLS SNI 用 servername 保原域名（SMTP 服务器证书校验域名）。
    const hostname = parsed.hostname;
    let resolvedHost = hostname;
    try {
      const { Resolver } = await import('node:dns');
      const resolver = new Resolver();
      resolver.setServers(['223.5.5.5', '8.8.8.8', '114.114.114.114']);
      const addresses = await new Promise<string[]>((resolve, reject) => {
        resolver.resolve4(hostname, (err, addrs) => (err ? reject(err) : resolve(addrs)));
      });
      if (addresses.length) {
        resolvedHost = addresses[0];
        console.log(`[mail.dns_resolved] ${hostname} → ${resolvedHost}（绕过代理 DNS）`);
      }
    } catch {
      console.warn(`[mail.dns_resolve_failed] ${hostname}，回退系统 DNS`);
    }

    const options: Record<string, unknown> = {
      host: resolvedHost,
      port,
      secure,
      tls: resolvedHost !== hostname ? { servername: hostname } : undefined,
      connectionTimeout: 15_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    };
    if (authUser) options.auth = { user: authUser, pass: authPass };
    try {
      return nodemailer.createTransport(
        options as Parameters<typeof nodemailer.createTransport>[0]
      );
    } catch (error) {
      console.error('[mail.transport_create_failed]', { error: (error as Error).message });
      return null;
    }
  }

  /**
   * 渲染统一品牌 HTML 模板（含平台名 logo + 页脚 + 内容区）。
   * @param cfg 当前 SMTP 配置（含品牌信息，避免重复查库）
   * @param title 邮件标题区文案（如「重置你的密码」「验证你的邮箱」）
   * @param bodyHtml 内容区 HTML（按钮 / 链接 / 说明段落）
   */
  private async renderTemplate(cfg: SmtpConfig, title: string, bodyHtml: string): Promise<string> {
    const { platformName, logoUrl } = await this.getBrand(cfg);
    const logoHtml = logoUrl
      ? `<img src="${logoUrl}" alt="${platformName}" style="height:32px;margin-bottom:16px;" />`
      : `<div style="display:inline-block;width:40px;height:40px;line-height:40px;text-align:center;background:#2563eb;color:#fff;border-radius:8px;font-weight:bold;font-size:18px;margin-bottom:16px;">${platformName.slice(0, 1).toUpperCase()}</div>`;
    return [
      "<div style=\"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;max-width:520px;margin:auto;padding:24px;background:#ffffff;border-radius:12px;\">",
      logoHtml,
      `<h2 style="margin:0 0 12px;color:#111827;">${title}</h2>`,
      '<div style="color:#374151;font-size:14px;line-height:1.6;">',
      bodyHtml,
      '</div>',
      '<hr style="margin:24px 0;border:none;border-top:1px solid #e5e7eb;" />',
      `<p style="margin:0;font-size:12px;color:#9ca3af;">此邮件由 ${platformName} 自动发送，请勿直接回复。</p>`,
      '</div>',
    ].join('');
  }

  /**
   * 发送邮件。SMTP 未配置、配置无效或发送失败都会显式抛错；
   * 调用方按自身安全语义决定是否转换成业务错误。
   */
  async sendMail(to: string, subject: string, html: string): Promise<void> {
    const cfg = await this.loadConfig();
    if (!cfg.smtpUrl) {
      throw new Error('SMTP 未配置，无法发送邮件');
    }
    const transporter = await this.buildTransporter(cfg);
    if (!transporter) {
      throw new Error('SMTP 配置无效，无法创建邮件发送通道');
    }
    try {
      await transporter.sendMail({
        from: await this.fromAddress(cfg),
        to,
        subject,
        html,
      });
    } catch (error) {
      console.error('[mail.send_failed]', { to, subject, error: (error as Error).message });
      throw error;
    }
  }

  /**
   * 发送密码重置邮件（统一品牌模板）。
   * @param email 收件人
   * @param resetLink 重置链接（前端路由 ?reset_token=xxx）
   */
  async sendPasswordReset(email: string, resetLink: string): Promise<void> {
    const cfg = await this.loadConfig();
    const bodyHtml = [
      '<p>我们收到了你的密码重置请求。点击下方按钮设置新密码（链接 15 分钟内有效）：</p>',
      `<p><a href="${resetLink}" style="display:inline-block;padding:10px 20px;background:#2563eb;color:#fff;border-radius:6px;text-decoration:none;">重置密码</a></p>`,
      `<p style="word-break:break-all;font-size:12px;color:#6b7280;">若按钮无法点击，直接访问：<br>${resetLink}</p>`,
      '<p style="font-size:12px;color:#9ca3af;">如果不是你本人发起的请求，请忽略此邮件，你的密码不会被修改。</p>',
    ].join('');
    const html = await this.renderTemplate(cfg, '重置你的密码', bodyHtml);
    await this.sendMail(email, '重置你的密码', html);
  }

  /**
   * 发送邮箱验证邮件（统一品牌模板）。
   * @param email 收件人
   * @param verifyLink 验证链接（前端路由 ?verify_token=xxx）
   */
  async sendEmailVerification(email: string, verifyLink: string): Promise<void> {
    const cfg = await this.loadConfig();
    const bodyHtml = [
      '<p>感谢注册！请点击下方按钮验证你的邮箱（链接 24 小时内有效）：</p>',
      `<p><a href="${verifyLink}" style="display:inline-block;padding:10px 20px;background:#2563eb;color:#fff;border-radius:6px;text-decoration:none;">验证邮箱</a></p>`,
      `<p style="word-break:break-all;font-size:12px;color:#6b7280;">若按钮无法点击，直接访问：<br>${verifyLink}</p>`,
      '<p style="font-size:12px;color:#9ca3af;">如果不是你本人注册的，请忽略此邮件。</p>',
    ].join('');
    const html = await this.renderTemplate(cfg, '验证你的邮箱', bodyHtml);
    await this.sendMail(email, '验证你的邮箱', html);
  }

  /**
   * 发送测试邮件（Admin「测试发信」用，统一品牌模板）。
   * @param to 收件人（Admin 手填）
   * @returns 发送结果（成功 / 失败 + 错误信息），供 Admin 判断 SMTP 配置是否正确。
   *   此方法显式返回结果而非静默吞错：测试发信的目的是「验证 SMTP 是否配通」，
   *   Admin 需要看到失败原因（连接超时 / 认证失败等），与找回密码的「防探测」语义不同。
   */
  async sendTestEmail(to: string): Promise<{ ok: boolean; message: string; configured: boolean }> {
    const cfg = await this.loadConfig();
    const transporter = await this.buildTransporter(cfg);
    if (!transporter) {
      return {
        ok: false,
        configured: false,
        message: 'SMTP 未配置（smtpUrl 为空），未实际发送。',
      };
    }
    const bodyHtml =
      '<p>这是一封来自平台的测试邮件，用于验证 SMTP 发信配置是否正常。</p><p>如果你收到了这封邮件，说明 SMTP 配置成功。</p>';
    const html = await this.renderTemplate(cfg, 'SMTP 测试邮件', bodyHtml);
    try {
      await transporter.sendMail({
        from: await this.fromAddress(cfg),
        to,
        subject: 'SMTP 测试邮件',
        html,
      });
      return { ok: true, configured: true, message: '测试邮件已发送，请查收。' };
    } catch (error) {
      const message = (error as Error).message || '未知错误';
      console.error('[mail.test_failed]', { to, error: message });
      return { ok: false, configured: true, message: `发送失败：${message}` };
    }
  }
}

/** SMTP + 品牌配置快照（loadConfig 一次查库，多方法复用，避免 sendMail 内重复查）。 */
interface SmtpConfig {
  /** SMTP 连接 URL（smtp(s)://[user[:pass]@]host[:port]）。PlatformSetting 优先，.env fallback。 */
  smtpUrl: string;
  /** 发件人地址（可选，未配用品牌默认）。 */
  smtpFrom: string;
  /** 独立认证用户名（可选，admin 拆分配置场景）。 */
  smtpUser: string;
  /** 独立认证密码（可选，仅 smtpUser 非空时生效）。 */
  smtpPass: string;
  /** 平台展示名（邮件品牌）。 */
  platformName: string;
  /** 平台 logo 链接（邮件品牌）。 */
  logoUrl: string;
}

/** SMTP 配置缓存条目：值快照 + 过期时间戳。 */
interface SmtpConfigCache {
  value: SmtpConfig;
  expiresAt: number;
}

/** SMTP + 品牌配置查询的 PlatformSetting key 白名单（一次 findMany 全取，避免发一封信查两次库）。 */
const CONFIG_KEYS = [
  'smtpUrl',
  'smtpFrom',
  'smtpUser',
  'smtpPass',
  'platformName',
  'logoUrl',
] as const;

/**
 * 归一化 SMTP URL：裸地址自动补协议头，确保 new URL 能正确解析。
 *
 * admin 后台 placeholder 引导填裸地址（如 `smtpdm.aliyun.com:465`），但 new URL 会把首段
 * 当 scheme 解析失败。此函数按端口推断协议：465→smtps（TLS 直连），其余→smtp（STARTTLS），
 * 无端口默认 smtps+465。已带协议头的原样返回。
 *
 * 抽成纯函数（无副作用）便于单测覆盖各边界，buildTransporter 复用。
 */
export function normalizeSmtpUrl(raw: string): string {
  const url = raw.trim();
  if (!url) return '';
  if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(url)) return url;
  const hasPort = /:\d+$/.test(url);
  const port = hasPort ? Number(url.match(/:(\d+)$/)?.[1]) : 465;
  const scheme = port === 465 ? 'smtps' : 'smtp';
  return hasPort ? `${scheme}://${url}` : `smtps://${url}:465`;
}

/** SMTP 配置缓存 TTL（毫秒）。
 *  邮件低频场景，TTL 兜底过期防「admin 改了配置但忘了清缓存」；正常路径由 updateSettings 手动失效。 */
const SMTP_CACHE_TTL_MS = 30_000;
