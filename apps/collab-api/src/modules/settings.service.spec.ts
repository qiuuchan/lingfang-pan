// SettingsService 单测：覆盖鉴权守卫、key 白名单、value 校验、公开信息仅暴露白名单字段、测试发信。
//  - member_cannot_update_settings（ensurePlatformAdmin 守卫，403）。
//  - member_cannot_get_settings（ensurePlatformAdmin 守卫，403）。
//  - update_rejects_unknown_key（非白名单 key 拒绝）。
//  - update_rejects_invalid_logo_url（logoUrl 非 http/https 拒绝）。
//  - update_rejects_empty_payload（空数组拒绝）。
//  - update_upserts_whitelisted_keys（白名单 key 逐项 upsert + 审计）。
//  - get_public_info_only_returns_whitelisted_fields（仅 platformName/logoUrl，缺省兜底）。
//  - test_email_lets_mail_service_send_and_returns_result（委托 MailService.sendTestEmail）。
// 参考 release.service.spec.ts：Mock PrismaService + AuthService + MailService，不连真实 DB。
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { SettingsService, PUBLIC_SETTING_KEYS } from './settings.service';
import { forbidden } from '../common';

function mockPrisma() {
  return {
    platformSetting: {
      findMany: vi.fn(),
      upsert: vi.fn(),
    },
    auditLog: { create: vi.fn() },
  };
}

function mockAuth() {
  return {
    ensurePlatformAdmin: vi.fn(),
    ensureCurrentTeam: vi.fn(),
    ensureTeamAdmin: vi.fn(),
  };
}

function mockMail() {
  return { sendTestEmail: vi.fn() };
}

describe('SettingsService', () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let auth: ReturnType<typeof mockAuth>;
  let mail: ReturnType<typeof mockMail>;
  let service: SettingsService;

  beforeEach(() => {
    prisma = mockPrisma();
    auth = mockAuth();
    mail = mockMail();
    // @ts-expect-error mock 不实现完整 PrismaService 接口，仅测用到的方法。
    service = new SettingsService(prisma, auth, mail);
  });

  it('非平台管理员读取设置被 ensurePlatformAdmin 拒绝（403）', async () => {
    auth.ensurePlatformAdmin.mockImplementation(() => {
      throw forbidden('仅平台管理员可操作');
    });
    await expect(service.getSettings('user-member')).rejects.toMatchObject({ status: 403, code: 'forbidden' });
    expect(prisma.platformSetting.findMany).not.toHaveBeenCalled();
  });

  it('非平台管理员更新设置被 ensurePlatformAdmin 拒绝（403）', async () => {
    auth.ensurePlatformAdmin.mockImplementation(() => {
      throw forbidden('仅平台管理员可操作');
    });
    await expect(
      service.updateSettings('user-member', { settings: [{ key: 'platformName', value: 'X' }] }),
    ).rejects.toMatchObject({ status: 403, code: 'forbidden' });
    expect(prisma.platformSetting.upsert).not.toHaveBeenCalled();
  });

  it('update 拒绝非白名单 key', async () => {
    await expect(
      service.updateSettings('user-admin', { settings: [{ key: 'evilKey', value: 'X' }] }),
    ).rejects.toMatchObject({ status: 400, code: 'bad_request' });
    expect(prisma.platformSetting.upsert).not.toHaveBeenCalled();
  });

  it('update 拒绝非 http/https 的 logoUrl', async () => {
    await expect(
      service.updateSettings('user-admin', { settings: [{ key: 'logoUrl', value: 'javascript:alert(1)' }] }),
    ).rejects.toMatchObject({ status: 400, code: 'bad_request' });
    expect(prisma.platformSetting.upsert).not.toHaveBeenCalled();
  });

  it('update 拒绝空数组', async () => {
    // DTO 层 ArrayMinSize(1) 已拦截，但 service 仍做防御性校验（DTO 绕过场景）。
    await expect(
      service.updateSettings('user-admin', { settings: [] }),
    ).rejects.toMatchObject({ status: 400, code: 'bad_request' });
    expect(prisma.platformSetting.upsert).not.toHaveBeenCalled();
  });

  it('update 对白名单 key 逐项 upsert + 写审计', async () => {
    prisma.platformSetting.upsert
      .mockResolvedValueOnce({ key: 'platformName', value: '灵坊' })
      .mockResolvedValueOnce({ key: 'logoUrl', value: 'https://x/logo.png' });
    const result = await service.updateSettings('user-admin', {
      settings: [
        { key: 'platformName', value: '灵坊' },
        { key: 'logoUrl', value: 'https://x/logo.png' },
      ],
    });
    expect(prisma.platformSetting.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(2);
    expect(result.settings).toEqual([
      { key: 'platformName', value: '灵坊' },
      { key: 'logoUrl', value: 'https://x/logo.png' },
    ]);
  });

  it('getPublicInfo 仅返回 platformName/logoUrl（缺省兜底）', async () => {
    // DB 仅有 platformName 一项，logoUrl 缺失 → 返回兜底空串。
    prisma.platformSetting.findMany.mockResolvedValue([{ key: 'platformName', value: '灵坊' }]);
    const result = await service.getPublicInfo();
    expect(result).toEqual({ platformName: '灵坊', logoUrl: '' });
    // 关键约束：findMany 的 where 必须限定白名单 key，杜绝查询全表泄漏非公开设置。
    expect(prisma.platformSetting.findMany).toHaveBeenCalledWith({
      where: { key: { in: [...PUBLIC_SETTING_KEYS] } },
      select: { key: true, value: true },
    });
  });

  it('getPublicInfo 两项均缺失时返回兜底默认值', async () => {
    prisma.platformSetting.findMany.mockResolvedValue([]);
    const result = await service.getPublicInfo();
    expect(result).toEqual({ platformName: 'LingFang', logoUrl: '' });
  });

  it('testEmail 拒绝非法邮箱格式', async () => {
    await expect(service.testEmail('user-admin', 'not-an-email')).rejects.toMatchObject({ status: 400, code: 'bad_request' });
    expect(mail.sendTestEmail).not.toHaveBeenCalled();
  });

  it('testEmail 委托 MailService 发送并返回结果 + 落审计', async () => {
    mail.sendTestEmail.mockResolvedValue({ ok: true, configured: true, message: '测试邮件已发送，请查收。' });
    const result = await service.testEmail('user-admin', 'Dest@example.com');
    expect(mail.sendTestEmail).toHaveBeenCalledWith('dest@example.com');
    expect(result).toEqual({ ok: true, configured: true, message: '测试邮件已发送，请查收。' });
    // 审计落库：metadata 收件人邮箱脱敏（仅前 2 字符 + ***）。
    expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: 'admin.setting.test_email',
        metadata: expect.objectContaining({ to: 'de***', ok: true, configured: true }),
      }),
    }));
  });
});
