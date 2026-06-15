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

// 组D：updateSettings 在 giteeOwner/giteeRepo/giteeAccessToken 变更时调 invalidateChangelogCache 失效更新日志缓存。
// mock 提供该方法（空实现即可，单测不验证 Gitee 拉取链路）。
function mockGitee() {
  return { invalidateChangelogCache: vi.fn() };
}

describe('SettingsService', () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let auth: ReturnType<typeof mockAuth>;
  let mail: ReturnType<typeof mockMail>;
  let geetest: ReturnType<typeof mockGeetest>;
  let gitee: ReturnType<typeof mockGitee>;
  let service: SettingsService;

  beforeEach(() => {
    // 组E 性能：module-level 公开信息缓存在用例间隔离，避免前序用例填充的缓存被后续用例命中。
    resetPublicInfoCache();
    prisma = mockPrisma();
    auth = mockAuth();
    mail = mockMail();
    geetest = mockGeetest();
    gitee = mockGitee();
    // @ts-expect-error mock 不实现完整 PrismaService 接口，仅测用到的方法。
    service = new SettingsService(prisma, auth, mail, geetest, gitee);
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

  it('getPublicInfo 仅返回 platformName/logoUrl/geetestCaptchaId/geetestScenes（缺省兜底）', async () => {
    // DB 仅有 platformName 一项，logoUrl/geetestCaptchaId/geetestScenes 缺失 → 返回兜底空串。
    prisma.platformSetting.findMany.mockResolvedValue([{ key: 'platformName', value: '灵坊' }]);
    const result = await service.getPublicInfo();
    expect(result).toEqual({ platformName: '灵坊', logoUrl: '', geetestCaptchaId: '', geetestScenes: '' });
    // 关键约束：findMany 的 where 必须限定白名单 key，杜绝查询全表泄漏非公开设置。
    expect(prisma.platformSetting.findMany).toHaveBeenCalledWith({
      where: { key: { in: [...PUBLIC_SETTING_KEYS] } },
      select: { key: true, value: true },
    });
  });

  it('getPublicInfo 全部缺失时返回兜底默认值', async () => {
    prisma.platformSetting.findMany.mockResolvedValue([]);
    const result = await service.getPublicInfo();
    expect(result).toEqual({ platformName: 'LingFang', logoUrl: '', geetestCaptchaId: '', geetestScenes: '' });
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

  // 组C 场景开关：geetestScenes 公开（前端按场景决定是否渲染验证码），与 captchaId 同级暴露。
  it('getPublicInfo 暴露 geetestScenes（trim 归一化，前端据此按场景开关验证码）', async () => {
    prisma.platformSetting.findMany.mockResolvedValue([
      { key: 'geetestCaptchaId', value: 'fake-id' },
      { key: 'geetestScenes', value: '  login,register  ' },
    ]);
    const result = await service.getPublicInfo();
    expect(result.geetestScenes).toBe('login,register');
    expect(PUBLIC_SETTING_KEYS).toContain('geetestScenes');
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

  // 组C 极验场景开关：geetestScenes 白名单 + 归一化。
  it('update 接受合法 geetestScenes（逗号分隔，归一化为固定顺序 login,register,forgot）', async () => {
    prisma.platformSetting.upsert.mockResolvedValue({ key: 'geetestScenes', value: 'login,register,forgot' });
    // 乱序 + 大小写混合 + 多余空白，归一化后按固定顺序输出。
    const result = await service.updateSettings('user-admin', {
      settings: [{ key: 'geetestScenes', value: '  Forgot , LOGIN , register  ' }],
    });
    expect(prisma.platformSetting.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { key: 'geetestScenes' },
      create: expect.objectContaining({ value: 'login,register,forgot' }),
    }));
    expect(result.settings).toEqual([{ key: 'geetestScenes', value: 'login,register,forgot' }]);
  });

  it('update 接受空 geetestScenes（清空=全部场景关闭）', async () => {
    prisma.platformSetting.upsert.mockResolvedValue({ key: 'geetestScenes', value: '' });
    const result = await service.updateSettings('user-admin', {
      settings: [{ key: 'geetestScenes', value: '   ' }],
    });
    expect(prisma.platformSetting.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ value: '' }),
    }));
    expect(result.settings).toEqual([{ key: 'geetestScenes', value: '' }]);
  });

  it('update 拒绝含未知场景的 geetestScenes', async () => {
    await expect(
      service.updateSettings('user-admin', { settings: [{ key: 'geetestScenes', value: 'login,evil' }] }),
    ).rejects.toMatchObject({ status: 400, code: 'bad_request' });
    expect(prisma.platformSetting.upsert).not.toHaveBeenCalled();
  });

  it('update 改 geetestScenes 后失效 GeetestService 配置缓存（场景变更需重读配置）', async () => {
    prisma.platformSetting.upsert.mockResolvedValue({ key: 'geetestScenes', value: 'login' });
    await service.updateSettings('user-admin', { settings: [{ key: 'geetestScenes', value: 'login' }] });
    expect(geetest.invalidateConfigCache).toHaveBeenCalledTimes(1);
  });

  it('getGeetestSettings 返回 captchaId/scenes 明文，captchaKey 脱敏（hasCaptchaKey）', async () => {
    prisma.platformSetting.findMany.mockResolvedValue([
      { key: 'geetestCaptchaId', value: 'fake-id' },
      { key: 'geetestCaptchaKey', value: 'super-secret-key' },
      { key: 'geetestScenes', value: 'login,register' },
    ]);
    const result = await service.getGeetestSettings('user-admin');
    expect(result).toEqual({
      geetestCaptchaId: 'fake-id',
      hasCaptchaKey: true,
      geetestScenes: 'login,register',
      hasCaptchaId: true,
    });
    // 关键约束：绝不返回 captchaKey 明文（避免私钥经 HTTP 响应泄漏到浏览器）。
    expect(JSON.stringify(result)).not.toContain('super-secret-key');
  });

  it('getGeetestSettings 完全未配置时返回空 + hasCaptchaId=false', async () => {
    prisma.platformSetting.findMany.mockResolvedValue([]);
    const result = await service.getGeetestSettings('user-admin');
    expect(result).toEqual({
      geetestCaptchaId: '',
      hasCaptchaKey: false,
      geetestScenes: '',
      hasCaptchaId: false,
    });
  });

  it('getGeetestSettings 非平台管理员被 ensurePlatformAdmin 拒绝（403）', async () => {
    auth.ensurePlatformAdmin.mockImplementation(() => {
      throw forbidden('仅平台管理员可操作');
    });
    await expect(service.getGeetestSettings('user-member')).rejects.toMatchObject({ status: 403, code: 'forbidden' });
    expect(prisma.platformSetting.findMany).not.toHaveBeenCalled();
  });

  // 组C 极验测试连通性：testCaptcha 探测极验接口，按响应判定配置有效性。
  it('testCaptcha 未配置 captchaId/captchaKey 时返回 configured=false（提示先填配置）', async () => {
    prisma.platformSetting.findMany.mockResolvedValue([]);
    const result = await service.testCaptcha('user-admin');
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(false);
    // 审计落库（记录测试事件）。
    expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'admin.setting.test_captcha', metadata: expect.objectContaining({ ok: false, configured: false }) }),
    }));
  });

  it('testCaptcha 已配置但接口返回 result=fail 时返回 ok=true（连通正常）', async () => {
    prisma.platformSetting.findMany.mockResolvedValue([
      { key: 'geetestCaptchaId', value: 'fake-id' },
      { key: 'geetestCaptchaKey', value: 'fake-key' },
    ]);
    // mock 全局 fetch 返回 200 + result=fail（占位参数预期被拒，但接口正常响应=配置有效）。
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: 'fail', reason: 'lot_number expired' }),
    })) as unknown as typeof fetch;
    const prevFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    try {
      const result = await service.testCaptcha('user-admin');
      expect(result.ok).toBe(true);
      expect(result.configured).toBe(true);
    } finally {
      globalThis.fetch = prevFetch;
    }
  });

  it('testCaptcha 接口网络异常时返回 ok=false（明确告知 admin 失败，不降级放行）', async () => {
    prisma.platformSetting.findMany.mockResolvedValue([
      { key: 'geetestCaptchaId', value: 'fake-id' },
      { key: 'geetestCaptchaKey', value: 'fake-key' },
    ]);
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const prevFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    try {
      const result = await service.testCaptcha('user-admin');
      expect(result.ok).toBe(false);
      expect(result.configured).toBe(true);
      expect(result.message).toContain('network down');
    } finally {
      globalThis.fetch = prevFetch;
    }
  });

  it('testCaptcha 非平台管理员被 ensurePlatformAdmin 拒绝（403）', async () => {
    auth.ensurePlatformAdmin.mockImplementation(() => {
      throw forbidden('仅平台管理员可操作');
    });
    await expect(service.testCaptcha('user-member')).rejects.toMatchObject({ status: 403, code: 'forbidden' });
    expect(prisma.platformSetting.findMany).not.toHaveBeenCalled();
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

  // === 组D Gitee 更新日志 ===

  it('update 拒绝含路径穿越的 giteeOwner（防 URL 注入）', async () => {
    await service.updateSettings('admin-1', { settings: [{ key: 'giteeOwner', value: '../evil' }] }).catch(() => {});
    expect(prisma.platformSetting.upsert).not.toHaveBeenCalled();
  });

  it('update 拒绝含斜杠的 giteeRepo（防路径段注入）', async () => {
    await service.updateSettings('admin-1', { settings: [{ key: 'giteeRepo', value: 'a/b' }] }).catch(() => {});
    expect(prisma.platformSetting.upsert).not.toHaveBeenCalled();
  });

  it('update 拒绝格式非法的 giteeAccessToken（含特殊字符）', async () => {
    await service.updateSettings('admin-1', { settings: [{ key: 'giteeAccessToken', value: '有非法字符!!!' }] }).catch(() => {});
    expect(prisma.platformSetting.upsert).not.toHaveBeenCalled();
  });

  it('update 接受合法的 giteeOwner/giteeRepo/giteeAccessToken（逐项 upsert）', async () => {
    prisma.platformSetting.upsert
      .mockResolvedValueOnce({ key: 'giteeOwner', value: 'yijianruyuan' })
      .mockResolvedValueOnce({ key: 'giteeRepo', value: 'lingfang' })
      .mockResolvedValueOnce({ key: 'giteeAccessToken', value: 'valid-token-0123456789abcdef' });
    await service.updateSettings('admin-1', {
      settings: [
        { key: 'giteeOwner', value: 'yijianruyuan' },
        { key: 'giteeRepo', value: 'lingfang' },
        { key: 'giteeAccessToken', value: 'valid-token-0123456789abcdef' },
      ],
    });
    expect(prisma.platformSetting.upsert).toHaveBeenCalledTimes(3);
  });

  it('update 改 gitee key 后失效 changelog 缓存（invalidateChangelogCache）', async () => {
    prisma.platformSetting.upsert.mockResolvedValue({ key: 'giteeAccessToken', value: 'new-token-0123456789abcdef' });
    await service.updateSettings('admin-1', { settings: [{ key: 'giteeAccessToken', value: 'new-token-0123456789abcdef' }] });
    expect(gitee.invalidateChangelogCache).toHaveBeenCalledTimes(1);
  });

  it('update 对 giteeAccessToken 审计不记明文（脱敏 {configured}）', async () => {
    const secretValue = 'super-secret-token-0123456789';
    prisma.platformSetting.upsert.mockResolvedValue({ key: 'giteeAccessToken', value: secretValue });
    await service.updateSettings('admin-1', { settings: [{ key: 'giteeAccessToken', value: secretValue }] });
    const auditData = prisma.auditLog.create.mock.calls[0][0].data;
    expect(JSON.stringify(auditData.metadata)).not.toContain(secretValue);
    expect(auditData.metadata).toMatchObject({ key: 'giteeAccessToken', configured: true });
  });

  it('getGiteeSettings 返回 owner/repo 明文，accessToken 脱敏（hasAccessToken）', async () => {
    prisma.platformSetting.findMany.mockResolvedValue([
      { key: 'giteeOwner', value: 'yijianruyuan' },
      { key: 'giteeRepo', value: 'lingfang' },
      { key: 'giteeAccessToken', value: 'secret-token-0123456789abcdef' },
    ]);
    const result = await service.getGiteeSettings('admin-1');
    expect(result).toEqual({ giteeOwner: 'yijianruyuan', giteeRepo: 'lingfang', hasAccessToken: true });
    // 明文令牌绝不返回。
    expect(JSON.stringify(result)).not.toContain('secret-token');
  });

  it('getGiteeSettings 未配置 token 时 hasAccessToken=false', async () => {
    prisma.platformSetting.findMany.mockResolvedValue([]);
    const result = await service.getGiteeSettings('admin-1');
    expect(result.hasAccessToken).toBe(false);
  });

  it('getGiteeSettings 非平台管理员被拒绝（403）', async () => {
    auth.ensurePlatformAdmin.mockImplementation(() => {
      throw forbidden('仅平台管理员可操作');
    });
    await expect(service.getGiteeSettings('user-member')).rejects.toMatchObject({ status: 403, code: 'forbidden' });
  });

  it('testGitee 未配置 token 时返回 configured=false', async () => {
    prisma.platformSetting.findMany.mockResolvedValue([]);
    const result = await service.testGitee('admin-1');
    expect(result).toMatchObject({ ok: false, configured: false });
    expect(result.message).toContain('未配置');
  });

  it('testGitee token 已配置且 Gitee 返回 200 时 ok=true', async () => {
    prisma.platformSetting.findMany.mockResolvedValue([
      { key: 'giteeOwner', value: 'yijianruyuan' },
      { key: 'giteeRepo', value: 'lingfang' },
      { key: 'giteeAccessToken', value: 'valid-token-0123456789abcdef' },
    ]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, status: 200 } as Response);
    try {
      const result = await service.testGitee('admin-1');
      expect(result).toMatchObject({ ok: true, configured: true });
      // Bearer header 鉴权（禁 query token）。
      const calledUrl = fetchSpy.mock.calls[0][0];
      expect(String(calledUrl)).not.toContain('access_token');
      const calledOpts = fetchSpy.mock.calls[0][1];
      expect(calledOpts.headers.Authorization).toBe('Bearer valid-token-0123456789abcdef');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('testGitee Gitee 返回 401 时 ok=false 且 message 提示 token 失效', async () => {
    prisma.platformSetting.findMany.mockResolvedValue([
      { key: 'giteeAccessToken', value: 'expired-token-0123456789ab' },
    ]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 401 } as Response);
    const result = await service.testGitee('admin-1');
    expect(result).toMatchObject({ ok: false, configured: true });
    expect(result.message).toContain('失效');
    vi.restoreAllMocks();
  });

  it('testGitee 审计不记 token 明文（metadata 仅 ok/configured/status）', async () => {
    const secretValue = 'audit-secret-token-0123456789';
    prisma.platformSetting.findMany.mockResolvedValue([{ key: 'giteeAccessToken', value: secretValue }]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, status: 200 } as Response);
    await service.testGitee('admin-1');
    const auditData = prisma.auditLog.create.mock.calls[0][0].data;
    expect(JSON.stringify(auditData.metadata)).not.toContain(secretValue);
    vi.restoreAllMocks();
  });
});
