// SettingsService 单测：覆盖鉴权守卫、key 白名单、value 校验、公开信息仅暴露白名单字段、测试发信。
//  - member_cannot_update_settings（ensurePlatformAdmin 守卫，403）。
//  - member_cannot_get_settings（ensurePlatformAdmin 守卫，403）。
//  - update_rejects_unknown_key（非白名单 key 拒绝）。
//  - update_rejects_invalid_logo_url（logoUrl 非 http/https 拒绝）。
//  - update_rejects_empty_payload（空数组拒绝）。
//  - update_upserts_whitelisted_keys（白名单 key 逐项 upsert + 审计）。
//  - get_public_info_only_returns_whitelisted_fields（仅 platformName/logoUrl，缺省兜底）。
//  - test_email_lets_mail_service_send_and_returns_result（委托 MailService.sendTestEmail）。
//  - 组A：SMTP key 校验 + 改 SMTP/品牌 key 失效 mail 缓存 + getSmtpSettings 配置回退 + 密码脱敏。
// 参考 release.service.spec.ts：Mock PrismaService + AuthService + MailService，不连真实 DB。
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { SettingsService, PUBLIC_SETTING_KEYS, resetPublicInfoCache } from './settings.service';
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
  // 组A：updateSettings 在 SMTP/品牌 key 变更时调 invalidateSmtpCache 失效邮件缓存，
  // mock 需提供该方法（空实现即可，单测不验证邮件发送链路）。
  return { sendTestEmail: vi.fn(), invalidateSmtpCache: vi.fn() };
}

// 组C：updateSettings 在 geetestCaptchaId/geetestCaptchaKey 变更时调 invalidateConfigCache 失效极验缓存，
// 与 mail.invalidateSmtpCache 同模式。mock 提供该方法（空实现即可）。
function mockGeetest() {
  return { invalidateConfigCache: vi.fn() };
}

describe('SettingsService', () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let auth: ReturnType<typeof mockAuth>;
  let mail: ReturnType<typeof mockMail>;
  let geetest: ReturnType<typeof mockGeetest>;
  let service: SettingsService;

  beforeEach(() => {
    // 组E 性能：module-level 公开信息缓存在用例间隔离，避免前序用例填充的缓存被后续用例命中。
    resetPublicInfoCache();
    prisma = mockPrisma();
    auth = mockAuth();
    mail = mockMail();
    geetest = mockGeetest();
    // @ts-expect-error mock 不实现完整 PrismaService 接口，仅测用到的方法。
    service = new SettingsService(prisma, auth, mail, geetest);
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

  // 组C 极验：captchaId/captchaKey 白名单 + 长度校验。
  it('update 接受 geetestCaptchaId（trim）+ geetestCaptchaKey', async () => {
    prisma.platformSetting.upsert
      .mockResolvedValueOnce({ key: 'geetestCaptchaId', value: 'fake-id' })
      .mockResolvedValueOnce({ key: 'geetestCaptchaKey', value: 'fake-secret' });
    const result = await service.updateSettings('user-admin', {
      settings: [
        { key: 'geetestCaptchaId', value: '  fake-id  ' },
        { key: 'geetestCaptchaKey', value: 'fake-secret' },
      ],
    });
    expect(prisma.platformSetting.upsert).toHaveBeenCalledTimes(2);
    // captchaId 经 trim 入库。
    expect(prisma.platformSetting.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { key: 'geetestCaptchaId' },
      create: expect.objectContaining({ value: 'fake-id' }),
    }));
    expect(result.settings).toEqual([
      { key: 'geetestCaptchaId', value: 'fake-id' },
      { key: 'geetestCaptchaKey', value: 'fake-secret' },
    ]);
  });

  it('update 拒绝过长的 geetestCaptchaId（>100 字符）', async () => {
    await expect(
      service.updateSettings('user-admin', { settings: [{ key: 'geetestCaptchaId', value: 'x'.repeat(101) }] }),
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

  it('getPublicInfo 仅返回 platformName/logoUrl/geetestCaptchaId（缺省兜底）', async () => {
    // DB 仅有 platformName 一项，logoUrl/geetestCaptchaId 缺失 → 返回兜底空串。
    prisma.platformSetting.findMany.mockResolvedValue([{ key: 'platformName', value: '灵坊' }]);
    const result = await service.getPublicInfo();
    expect(result).toEqual({ platformName: '灵坊', logoUrl: '', geetestCaptchaId: '' });
    // 关键约束：findMany 的 where 必须限定白名单 key，杜绝查询全表泄漏非公开设置。
    expect(prisma.platformSetting.findMany).toHaveBeenCalledWith({
      where: { key: { in: [...PUBLIC_SETTING_KEYS] } },
      select: { key: true, value: true },
    });
  });

  it('getPublicInfo 两项均缺失时返回兜底默认值', async () => {
    prisma.platformSetting.findMany.mockResolvedValue([]);
    const result = await service.getPublicInfo();
    expect(result).toEqual({ platformName: 'LingFang', logoUrl: '', geetestCaptchaId: '' });
  });

  // 组C 极验：captchaId 公开（前端据此初始化极验组件），captchaKey 不在白名单（绝不公开）。
  it('getPublicInfo 暴露 geetestCaptchaId 但不暴露 geetestCaptchaKey', async () => {
    prisma.platformSetting.findMany.mockResolvedValue([
      { key: 'geetestCaptchaId', value: '  fake-id  ' },
      { key: 'geetestCaptchaKey', value: 'fake-secret' }, // 不在白名单，不应被查询到
    ]);
    const result = await service.getPublicInfo();
    // captchaId 经 trim（去掉首尾空白），captchaKey 绝不在结果中。
    expect(result.geetestCaptchaId).toBe('fake-id');
    expect(result).not.toHaveProperty('geetestCaptchaKey');
    // 查询 where 限定白名单（仅 geetestCaptchaId，不含 key）。
    expect(PUBLIC_SETTING_KEYS).toContain('geetestCaptchaId');
    expect(PUBLIC_SETTING_KEYS).not.toContain('geetestCaptchaKey');
  });

  // 组E 性能：公开信息内存缓存（@Public 高频端点）。
  it('getPublicInfo 命中缓存时不重复查库（TTL 内仅 findMany 一次）', async () => {
    prisma.platformSetting.findMany.mockResolvedValue([{ key: 'platformName', value: '灵坊' }]);
    await service.getPublicInfo();
    await service.getPublicInfo();
    await service.getPublicInfo();
    // 三次调用只查一次库，后两次命中 module-level 缓存。
    expect(prisma.platformSetting.findMany).toHaveBeenCalledTimes(1);
  });

  it('updateSettings 成功后失效缓存（下次 getPublicInfo 回源查库）', async () => {
    prisma.platformSetting.findMany.mockResolvedValue([{ key: 'platformName', value: '灵坊' }]);
    prisma.platformSetting.upsert.mockResolvedValue({ key: 'platformName', value: '新名' });
    // 首次请求填充缓存。
    await service.getPublicInfo();
    expect(prisma.platformSetting.findMany).toHaveBeenCalledTimes(1);
    // 更新设置应失效缓存。
    await service.updateSettings('user-admin', { settings: [{ key: 'platformName', value: '新名' }] });
    // 下次 getPublicInfo 回源查库（缓存已被清空）。
    await service.getPublicInfo();
    expect(prisma.platformSetting.findMany).toHaveBeenCalledTimes(2);
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

  // === 组A：SMTP 后台设置 ===

  it('update 接受合法 smtpUrl/smtpFrom/smtpUser/smtpPass（trim 归一化）', async () => {
    prisma.platformSetting.upsert
      .mockResolvedValueOnce({ key: 'smtpUrl', value: 'smtps://smtp.example.com:465' })
      .mockResolvedValueOnce({ key: 'smtpFrom', value: 'LingFang <no-reply@example.com>' })
      .mockResolvedValueOnce({ key: 'smtpUser', value: 'user@example.com' })
      .mockResolvedValueOnce({ key: 'smtpPass', value: 'p w d' });
    const result = await service.updateSettings('user-admin', {
      settings: [
        { key: 'smtpUrl', value: '  smtps://smtp.example.com:465  ' },
        { key: 'smtpFrom', value: '  LingFang <no-reply@example.com>  ' },
        { key: 'smtpUser', value: '  user@example.com  ' },
        // smtpPass 不 trim（密码可能含首尾空白），原样入库。
        { key: 'smtpPass', value: 'p w d' },
      ],
    });
    expect(prisma.platformSetting.upsert).toHaveBeenCalledTimes(4);
    // smtpUrl/smtpUser 经 trim；smtpPass 保留空白（原样）。
    expect(prisma.platformSetting.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { key: 'smtpUser' },
      create: expect.objectContaining({ value: 'user@example.com' }),
    }));
    expect(prisma.platformSetting.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { key: 'smtpPass' },
      create: expect.objectContaining({ value: 'p w d' }),
    }));
    expect(result.settings).toHaveLength(4);
  });

  it('update 拒绝非 smtp(s):// 的 smtpUrl', async () => {
    await expect(
      service.updateSettings('user-admin', { settings: [{ key: 'smtpUrl', value: 'http://smtp.example.com' }] }),
    ).rejects.toMatchObject({ status: 400, code: 'bad_request' });
    expect(prisma.platformSetting.upsert).not.toHaveBeenCalled();
  });

  it('update 接受空 smtpUrl（允许清空，回退 .env fallback）', async () => {
    prisma.platformSetting.upsert.mockResolvedValueOnce({ key: 'smtpUrl', value: '' });
    const result = await service.updateSettings('user-admin', { settings: [{ key: 'smtpUrl', value: '   ' }] });
    expect(prisma.platformSetting.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ value: '' }),
    }));
    expect(result.settings).toEqual([{ key: 'smtpUrl', value: '' }]);
  });

  it('update 改 SMTP key 后失效 MailService 缓存（AC1 运行时即时生效）', async () => {
    prisma.platformSetting.upsert.mockResolvedValue({ key: 'smtpUrl', value: 'smtps://new:465' });
    await service.updateSettings('user-admin', { settings: [{ key: 'smtpUrl', value: 'smtps://new:465' }] });
    expect(mail.invalidateSmtpCache).toHaveBeenCalledTimes(1);
  });

  it('update 改品牌 key（platformName）也失效 MailService 缓存（品牌渲染依赖）', async () => {
    prisma.platformSetting.upsert.mockResolvedValue({ key: 'platformName', value: '新名' });
    await service.updateSettings('user-admin', { settings: [{ key: 'platformName', value: '新名' }] });
    expect(mail.invalidateSmtpCache).toHaveBeenCalledTimes(1);
  });

  it('update 仅改非邮件 key（如 maxLoginAttempts）不失效 MailService 缓存', async () => {
    prisma.platformSetting.upsert.mockResolvedValue({ key: 'maxLoginAttempts', value: '5' });
    await service.updateSettings('user-admin', { settings: [{ key: 'maxLoginAttempts', value: '5' }] });
    expect(mail.invalidateSmtpCache).not.toHaveBeenCalled();
  });

  // 组C 极验：改 geetestCaptchaId/geetestCaptchaKey 后失效 GeetestService 配置缓存（与 SMTP 热生效一致）。
  it('update 改 geetestCaptchaId 后失效 GeetestService 配置缓存', async () => {
    prisma.platformSetting.upsert.mockResolvedValue({ key: 'geetestCaptchaId', value: 'fake-id' });
    await service.updateSettings('user-admin', { settings: [{ key: 'geetestCaptchaId', value: 'fake-id' }] });
    expect(geetest.invalidateConfigCache).toHaveBeenCalledTimes(1);
  });

  it('update 改 geetestCaptchaKey 后失效 GeetestService 配置缓存', async () => {
    prisma.platformSetting.upsert.mockResolvedValue({ key: 'geetestCaptchaKey', value: 'secret' });
    await service.updateSettings('user-admin', { settings: [{ key: 'geetestCaptchaKey', value: 'secret' }] });
    expect(geetest.invalidateConfigCache).toHaveBeenCalledTimes(1);
  });

  it('update 改非邮件/极验 key 不失效 GeetestService 缓存', async () => {
    prisma.platformSetting.upsert.mockResolvedValue({ key: 'maxLoginAttempts', value: '5' });
    await service.updateSettings('user-admin', { settings: [{ key: 'maxLoginAttempts', value: '5' }] });
    expect(geetest.invalidateConfigCache).not.toHaveBeenCalled();
  });

  it('getSmtpSettings 返回 PlatformSetting 配置，密码脱敏（hasSmtpPass）不返回明文', async () => {
    prisma.platformSetting.findMany.mockResolvedValue([
      { key: 'smtpUrl', value: 'smtps://smtp.example.com:465' },
      { key: 'smtpFrom', value: 'no-reply@example.com' },
      { key: 'smtpUser', value: 'user' },
      { key: 'smtpPass', value: 'secret-password' },
    ]);
    const result = await service.getSmtpSettings('user-admin');
    expect(result).toEqual({
      smtpUrl: 'smtps://smtp.example.com:465',
      smtpFrom: 'no-reply@example.com',
      smtpUser: 'user',
      hasSmtpPass: true,
      hasSmtpUrl: true,
    });
    // 关键约束：绝不返回密码明文（避免经 HTTP 响应泄漏到浏览器）。
    expect(JSON.stringify(result)).not.toContain('secret-password');
  });

  it('getSmtpSettings PlatformSetting 缺失时回退 .env fallback（SMTP_URL/SMTP_FROM）', async () => {
    // 模拟 PlatformSetting 无任何 SMTP 行（首次启动 / 仅 env 配置场景）。
    prisma.platformSetting.findMany.mockResolvedValue([]);
    const prevUrl = process.env.SMTP_URL;
    const prevFrom = process.env.SMTP_FROM;
    process.env.SMTP_URL = 'smtp://relay.local:587';
    process.env.SMTP_FROM = 'fallback@example.com';
    try {
      const result = await service.getSmtpSettings('user-admin');
      expect(result.smtpUrl).toBe('smtp://relay.local:587');
      expect(result.smtpFrom).toBe('fallback@example.com');
      expect(result.hasSmtpUrl).toBe(true);
      expect(result.hasSmtpPass).toBe(false);
    } finally {
      process.env.SMTP_URL = prevUrl;
      process.env.SMTP_FROM = prevFrom;
    }
  });

  it('getSmtpSettings 完全未配置时返回空 + hasSmtpUrl=false（前端据此提示降级）', async () => {
    prisma.platformSetting.findMany.mockResolvedValue([]);
    const prevUrl = process.env.SMTP_URL;
    const prevFrom = process.env.SMTP_FROM;
    delete process.env.SMTP_URL;
    delete process.env.SMTP_FROM;
    try {
      const result = await service.getSmtpSettings('user-admin');
      expect(result).toEqual({ smtpUrl: '', smtpFrom: '', smtpUser: '', hasSmtpPass: false, hasSmtpUrl: false });
    } finally {
      process.env.SMTP_URL = prevUrl;
      process.env.SMTP_FROM = prevFrom;
    }
  });

  it('getSmtpSettings 非平台管理员被 ensurePlatformAdmin 拒绝（403）', async () => {
    auth.ensurePlatformAdmin.mockImplementation(() => {
      throw forbidden('仅平台管理员可操作');
    });
    await expect(service.getSmtpSettings('user-member')).rejects.toMatchObject({ status: 403, code: 'forbidden' });
    expect(prisma.platformSetting.findMany).not.toHaveBeenCalled();
  });
});
