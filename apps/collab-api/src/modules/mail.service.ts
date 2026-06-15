import { Inject, Injectable } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { PrismaService } from '../prisma.service';

/**
 * 邮件服务（占位式 SMTP，Top5 找回密码解法 + 邮箱验证）。
 *
 * SMTP_URL 未配置时，sendMail 把邮件内容写入 console.log（不抛错、不阻塞流程），
 * 供本地开发/未配 SMTP 的部署直接在终端看到重置/验证链接。真实部署只需配 SMTP_URL env：
 *   SMTP_URL="smtps://user:pass@smtp.example.com:465"  （或 smtp://host:587）
 * 即自动走真实 SMTP 发送，无需改代码。
 *
 * 设计理由：找回密码 / 邮箱验证流程不能因「SMTP 未配」而整条链路报错（前端只提示「链接已发送」），
 * 但开发期想验证邮件内容，console.log 兜底最简。生产由 main.ts 启动期 fail-fast 或运维自行配 env。
 *
 * 平台品牌：邮件 HTML 模板读取 PlatformSetting 的 platformName / logoUrl（缺省值兜底），
 * 实现统一品牌外观（平台名 logo、统一页脚）。PlatformSetting 由平台 Admin 维护，
 * 此处仅读不写（不注入 SettingsService 避免循环依赖，直接用 PrismaService 查白名单 key）。
 */
@Injectable()
export class MailService {
  private readonly transporter: Transporter | null = null;
  private readonly configured: boolean;
  /** 缓存的品牌信息（启动后平台设置变更需重启进程才生效，邮件低频场景可接受）。 */
  private brandCache: { platformName: string; logoUrl: string } | null = null;

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
    const url = process.env.SMTP_URL;
    if (url) {
      // nodemailer.createTransport 接受 connection url（smtp(s)://user:pass@host:port）。
      this.transporter = nodemailer.createTransport(url);
      this.configured = true;
    } else {
      this.configured = false;
    }
  }

  /** SMTP 是否已配置（true=真实发送，false=console.log 兜底）。 */
  isConfigured() {
    return this.configured;
  }

  /**
   * 读取平台品牌信息（platformName / logoUrl），缺省值兜底。
   * 首次调用查库并缓存到实例字段，避免每封邮件都查 PlatformSetting（邮件低频，启动后变更需重启）。
   */
  private async getBrand(): Promise<{ platformName: string; logoUrl: string }> {
    if (this.brandCache) return this.brandCache;
    const rows = await this.prisma.platformSetting.findMany({
      where: { key: { in: ['platformName', 'logoUrl'] } },
      select: { key: true, value: true },
    });
    const map = new Map(rows.map((r) => [r.key, r.value] as const));
    this.brandCache = {
      platformName: map.get('platformName') || 'LingFang',
      logoUrl: map.get('logoUrl') || '',
    };
    return this.brandCache;
  }

  /** 发件人地址：SMTP_FROM 未配时用默认（含品牌名，便于收件人识别）。 */
  private async fromAddress(): Promise<string> {
    const { platformName } = await this.getBrand();
    return process.env.SMTP_FROM || `${platformName} <no-reply@lingfang.local>`;
  }

  /**
   * 渲染统一品牌 HTML 模板（含平台名 logo + 页脚 + 内容区）。
   * @param title 邮件标题区文案（如「重置你的密码」「验证你的邮箱」）
   * @param bodyHtml 内容区 HTML（按钮 / 链接 / 说明段落）
   */
  private async renderTemplate(title: string, bodyHtml: string): Promise<string> {
    const { platformName, logoUrl } = await this.getBrand();
    const logoHtml = logoUrl
      ? `<img src="${logoUrl}" alt="${platformName}" style="height:32px;margin-bottom:16px;" />`
      : `<div style="display:inline-block;width:40px;height:40px;line-height:40px;text-align:center;background:#2563eb;color:#fff;border-radius:8px;font-weight:bold;font-size:18px;margin-bottom:16px;">${platformName.slice(0, 1).toUpperCase()}</div>`;
    return [
      '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',\'PingFang SC\',\'Microsoft YaHei\',sans-serif;max-width:520px;margin:auto;padding:24px;background:#ffffff;border-radius:12px;">',
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
   * 发送邮件。SMTP 未配置时降级为 console.log（不抛错），保证找回密码 / 邮箱验证流程不中断。
   * 失败仅记录到 console.error（不向外抛），因为「邮件发送失败」对调用方不可恢复——
   * 前端已提示「重置链接已发送」，避免泄漏邮箱是否注册（防探测）。
   */
  async sendMail(to: string, subject: string, html: string): Promise<void> {
    if (!this.configured || !this.transporter) {
      // 占位：未配 SMTP_URL，邮件内容落 console.log 供开发期查看。
      // 不视为错误：找回密码 / 邮箱验证流程继续，前端提示「链接已发送」。
      console.log('[mail.placeholder] SMTP_URL 未配置，邮件内容降级输出：', { to, subject, html });
      return;
    }
    try {
      await this.transporter.sendMail({
        from: await this.fromAddress(),
        to,
        subject,
        html,
      });
    } catch (error) {
      // 发送失败不阻断调用方流程（前端已统一提示「重置链接已发送」，防邮箱探测）。
      console.error('[mail.send_failed]', { to, subject, error: (error as Error).message });
    }
  }

  /**
   * 发送密码重置邮件（统一品牌模板）。
   * @param email 收件人
   * @param resetLink 重置链接（前端路由 ?reset_token=xxx）
   */
  async sendPasswordReset(email: string, resetLink: string): Promise<void> {
    const bodyHtml = [
      '<p>我们收到了你的密码重置请求。点击下方按钮设置新密码（链接 15 分钟内有效）：</p>',
      `<p><a href="${resetLink}" style="display:inline-block;padding:10px 20px;background:#2563eb;color:#fff;border-radius:6px;text-decoration:none;">重置密码</a></p>`,
      `<p style="word-break:break-all;font-size:12px;color:#6b7280;">若按钮无法点击，直接访问：<br>${resetLink}</p>`,
      '<p style="font-size:12px;color:#9ca3af;">如果不是你本人发起的请求，请忽略此邮件，你的密码不会被修改。</p>',
    ].join('');
    const html = await this.renderTemplate('重置你的密码', bodyHtml);
    await this.sendMail(email, '重置你的密码', html);
  }

  /**
   * 发送邮箱验证邮件（统一品牌模板）。
   * @param email 收件人
   * @param verifyLink 验证链接（前端路由 ?verify_token=xxx）
   */
  async sendEmailVerification(email: string, verifyLink: string): Promise<void> {
    const bodyHtml = [
      '<p>感谢注册！请点击下方按钮验证你的邮箱（链接 24 小时内有效）：</p>',
      `<p><a href="${verifyLink}" style="display:inline-block;padding:10px 20px;background:#2563eb;color:#fff;border-radius:6px;text-decoration:none;">验证邮箱</a></p>`,
      `<p style="word-break:break-all;font-size:12px;color:#6b7280;">若按钮无法点击，直接访问：<br>${verifyLink}</p>`,
      '<p style="font-size:12px;color:#9ca3af;">如果不是你本人注册的，请忽略此邮件。</p>',
    ].join('');
    const html = await this.renderTemplate('验证你的邮箱', bodyHtml);
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
    if (!this.configured || !this.transporter) {
      return {
        ok: false,
        configured: false,
        message: 'SMTP 未配置（SMTP_URL 为空），邮件降级为 console.log，未实际发送。',
      };
    }
    const bodyHtml = '<p>这是一封来自平台的测试邮件，用于验证 SMTP 发信配置是否正常。</p><p>如果你收到了这封邮件，说明 SMTP 配置成功。</p>';
    const html = await this.renderTemplate('SMTP 测试邮件', bodyHtml);
    try {
      await this.transporter.sendMail({
        from: await this.fromAddress(),
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
