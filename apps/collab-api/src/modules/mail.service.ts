import { Inject, Injectable } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';

/**
 * 邮件服务（占位式 SMTP，Top5 找回密码解法）。
 *
 * SMTP_URL 未配置时，sendMail 把邮件内容写入 console.log（不抛错、不阻塞流程），
 * 供本地开发/未配 SMTP 的部署直接在终端看到重置链接。真实部署只需配 SMTP_URL env：
 *   SMTP_URL="smtps://user:pass@smtp.example.com:465"  （或 smtp://host:587）
 * 即自动走真实 SMTP 发送，无需改代码。
 *
 * 设计理由：找回密码流程不能因「SMTP 未配」而整条链路报错（前端只提示「重置链接已发送」），
 * 但开发期想验证邮件内容，console.log 兜底最简。生产由 main.ts 启动期 fail-fast 或运维自行配 env。
 */
@Injectable()
export class MailService {
  private readonly transporter: Transporter | null = null;
  private readonly configured: boolean;

  constructor() {
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
   * 发送邮件。SMTP 未配置时降级为 console.log（不抛错），保证找回密码流程不中断。
   * 失败仅记录到 console.error（不向外抛），因为「邮件发送失败」对调用方不可恢复——
   * 前端已提示「重置链接已发送」，避免泄漏邮箱是否注册（防探测）。
   */
  async sendMail(to: string, subject: string, html: string): Promise<void> {
    if (!this.configured || !this.transporter) {
      // 占位：未配 SMTP_URL，邮件内容落 console.log 供开发期查看。
      // 不视为错误：找回密码流程继续，前端提示「链接已发送」。
      console.log('[mail.placeholder] SMTP_URL 未配置，邮件内容降级输出：', { to, subject, html });
      return;
    }
    try {
      await this.transporter.sendMail({
        from: process.env.SMTP_FROM || 'LingFang 平台 <no-reply@lingfang.local>',
        to,
        subject,
        html,
      });
    } catch (error) {
      // 发送失败不阻断调用方流程（前端已统一提示「重置链接已发送」，防邮箱探测）。
      console.error('[mail.send_failed]', { to, subject, error: (error as Error).message });
    }
  }
}
