// normalizeSmtpUrl 单测：覆盖裸地址自动补协议头的各边界。
// 背景：admin 后台 placeholder 引导填裸地址（如 smtpdm.aliyun.com:465），但 new URL 会把首段当
// scheme 解析失败，导致 SMTP 连接异常（实测报 531 Authentication is required）。
// 此函数按端口推断协议补全，保证 new URL 能正确解析 host/port/protocol。
import { describe, expect, it, vi } from 'vitest';
import { MailService, normalizeSmtpUrl } from './mail.service';

describe('normalizeSmtpUrl', () => {
  it('裸地址带 465 端口补 smtps://', () => {
    expect(normalizeSmtpUrl('smtpdm.aliyun.com:465')).toBe('smtps://smtpdm.aliyun.com:465');
  });

  it('裸地址带 587 端口补 smtp://（STARTTLS）', () => {
    expect(normalizeSmtpUrl('smtp.qq.com:587')).toBe('smtp://smtp.qq.com:587');
  });

  it('裸地址无端口默认 smtps://+465', () => {
    expect(normalizeSmtpUrl('smtpdm.aliyun.com')).toBe('smtps://smtpdm.aliyun.com:465');
  });

  it('已带 smtps:// 协议头原样返回', () => {
    expect(normalizeSmtpUrl('smtps://smtpdm.aliyun.com:465')).toBe('smtps://smtpdm.aliyun.com:465');
  });

  it('已带 smtp:// 协议头原样返回', () => {
    expect(normalizeSmtpUrl('smtp://smtp.qq.com:587')).toBe('smtp://smtp.qq.com:587');
  });

  it('带内嵌凭据的完整 URL 原样返回', () => {
    const url = 'smtps://user:pass@smtpdm.aliyun.com:465';
    expect(normalizeSmtpUrl(url)).toBe(url);
  });

  it('大写协议头也识别为已带协议', () => {
    expect(normalizeSmtpUrl('SMTPS://smtpdm.aliyun.com:465')).toBe('SMTPS://smtpdm.aliyun.com:465');
  });

  it('首尾空白 trim', () => {
    expect(normalizeSmtpUrl('  smtpdm.aliyun.com:465  ')).toBe('smtps://smtpdm.aliyun.com:465');
  });

  it('空串返回空串', () => {
    expect(normalizeSmtpUrl('')).toBe('');
    expect(normalizeSmtpUrl('   ')).toBe('');
  });

  it('补全后能被 new URL 正确解析（host/port/protocol）', () => {
    const u = new URL(normalizeSmtpUrl('smtpdm.aliyun.com:465'));
    expect(u.hostname).toBe('smtpdm.aliyun.com');
    expect(u.port).toBe('465');
    expect(u.protocol).toBe('smtps:');
  });
});

function mockPrisma(rows: Array<{ key: string; value: string }> = []) {
  return {
    platformSetting: {
      findMany: vi.fn(async () => rows),
    },
  };
}

describe('MailService sendMail', () => {
  it('SMTP 未配置时显式抛错，不把邮件伪装成已发送', async () => {
    const prisma = mockPrisma([]);
    // @ts-expect-error mock 不实现完整 PrismaService 接口，仅测用到的方法。
    const service = new MailService(prisma);

    await expect(service.sendMail('a@b.com', '主题', '<p>hello</p>')).rejects.toThrow(
      'SMTP 未配置'
    );
  });
});
