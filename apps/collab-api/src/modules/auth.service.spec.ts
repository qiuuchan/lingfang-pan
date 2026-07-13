// AuthService 找回密码 + 重置密码单测（Top5 解法）。
//  - forgotPassword：邮箱不存在时静默跳过（不抛错，防邮箱探测）；存在时签发 reset token + 发邮件。
//  - resetPassword：token 无效/过期抛 bad_request；新密码 <8 位抛 bad_request；成功改密 + tokenVersion++ + 审计。
// 参考 release.service.spec.ts：Mock PrismaService + MailService，不连真实 DB。
// 注意 JWT_SECRET 由 vitest setup 注入（见 vitest.config 或 .env）；测试用真实 jwt 签发/校验闭环。
import { describe, expect, it, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';
import { MailService } from './mail.service';

// 测试用固定密钥（与 main.ts fail-fast 配合：dev 缺密钥仅 warn）。
process.env.JWT_SECRET = 'test-secret-for-password-reset-at-least-16-chars';

function mockPrisma() {
  const user = {
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    // update 默认 resolved：组B resetFailedLogin 用 .catch() 链降级，需 thenable；
    // verifyEmail 成功路径也 await update（结果未用），resolved 默认值兼容两者。
    update: vi.fn(async () => undefined),
    create: vi.fn(),
  };
  // auditLog.create 默认返回 resolved Promise（logout/refresh 用 .catch() 链，需 thenable）。
  const auditLog = { create: vi.fn(async () => undefined) };
  const teamAdminApplication = { create: vi.fn(), findFirst: vi.fn(async () => null) };
  // platformSetting.findMany 默认返回空数组：组B getLockConfig 读 maxLoginAttempts/lockDurationMinutes，
  // 未配置时降级默认值（5 次 / 15min）；用例可在 beforeEach 后按需 mockResolvedValue 覆盖。
  const platformSetting = { findMany: vi.fn(async () => []) };
  // tx 上下文：register 事务内调用 user.create + auditLog.create（+ 可选 teamAdminApplication.create）。
  const tx = {
    user: { updateMany: user.updateMany, findUniqueOrThrow: user.findUniqueOrThrow, create: user.create },
    auditLog,
    teamAdminApplication,
  };
  const $transaction = vi.fn(async (cb: (tx: typeof tx) => Promise<unknown>) => cb(tx));
  return { user, auditLog, teamAdminApplication, platformSetting, $transaction, __tx: tx };
}

function mockMail() {
  return {
    isConfigured: vi.fn(() => false),
    sendMail: vi.fn(async () => undefined),
    sendPasswordReset: vi.fn(async () => undefined),
    sendEmailVerification: vi.fn(async () => undefined),
    sendTestEmail: vi.fn(),
  };
}

// 组C 极验 mock：默认「未配置」（isSceneEnabled=false），管理端验证码校验直接跳过，
// 不影响既有应用端认证用例的行为。isSceneEnabled 默认放行跳过校验（开发态语义）。
function mockGeetest() {
  return {
    isConfigured: vi.fn(async () => false),
    isSceneEnabled: vi.fn(async () => false),
    validate: vi.fn(async () => true),
  };
}

describe('AuthService 找回密码 + 重置密码', () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let mail: ReturnType<typeof mockMail>;
  let geetest: ReturnType<typeof mockGeetest>;
  let service: AuthService;

  beforeEach(() => {
    prisma = mockPrisma();
    mail = mockMail();
    geetest = mockGeetest();
    // @ts-expect-error mock 不实现完整 PrismaService 接口，仅测用到的方法。
    service = new AuthService(prisma, mail, geetest);
  });

  describe('forgotPassword', () => {
    it('应用端找回密码不要求验证码', async () => {
      geetest.isSceneEnabled.mockResolvedValueOnce(true);
      geetest.validate.mockResolvedValueOnce(false);
      prisma.user.findUnique.mockResolvedValue(null);
      const result = await service.forgotPassword({ email: 'a@b.com' });
      expect(result.ok).toBe(true);
      expect(result.message).toBe('若该邮箱已注册且邮件服务可用，将收到重置链接');
      expect(geetest.isSceneEnabled).not.toHaveBeenCalled();
      expect(geetest.validate).not.toHaveBeenCalled();
    });

    it('邮箱不存在时静默跳过（不抛错，防邮箱探测）', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      const result = await service.forgotPassword({ email: 'nobody@example.com' });
      // 统一返回条件式提示，不泄漏邮箱是否注册，也不伪称邮件已发送。
      expect(result.ok).toBe(true);
      expect(result.message).toBe('若该邮箱已注册且邮件服务可用，将收到重置链接');
      // 不存在的邮箱不发邮件。
      expect(mail.sendMail).not.toHaveBeenCalled();
    });

    it('邮箱存在时发邮件（含 reset_token 链接）', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.com', status: 'ACTIVE', tokenVersion: 0 });
      const result = await service.forgotPassword({ email: 'a@b.com' });
      expect(result.ok).toBe(true);
      expect(result.message).toBe('若该邮箱已注册且邮件服务可用，将收到重置链接');
      // sendPasswordReset 被调用，链接含 reset_token。
      expect(mail.sendPasswordReset).toHaveBeenCalledTimes(1);
      const call = mail.sendPasswordReset.mock.calls[0];
      expect(call[0]).toBe('a@b.com'); // to
      expect(String(call[1])).toContain('reset_token='); // link 含 token
    });

    it('邮箱存在但邮件发送失败时保持枚举不可区分且不伪称已发送', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.com', status: 'ACTIVE', tokenVersion: 0 });
      mail.sendPasswordReset.mockRejectedValueOnce(new Error('SMTP 未配置'));

      const result = await service.forgotPassword({ email: 'a@b.com' });

      expect(result).toEqual({
        ok: true,
        message: '若该邮箱已注册且邮件服务可用，将收到重置链接',
      });
      expect(mail.sendPasswordReset).toHaveBeenCalledTimes(1);
    });

    it('已禁用用户不发邮件（静默跳过）', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.com', status: 'DISABLED' });
      await service.forgotPassword({ email: 'a@b.com' });
      expect(mail.sendPasswordReset).not.toHaveBeenCalled();
    });

    it('空邮箱抛 bad_request', async () => {
      await expect(service.forgotPassword({ email: ' ' })).rejects.toMatchObject({ status: 400, code: 'bad_request' });
    });
  });

  describe('resetPassword', () => {
    it('token 无效时抛 bad_request', async () => {
      await expect(service.resetPassword({ token: 'invalid-token', newPassword: 'newpass123' }))
        .rejects.toMatchObject({ status: 400, code: 'bad_request' });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('新密码 <8 位抛 bad_request（先于 token 校验）', async () => {
      await expect(service.resetPassword({ token: 'any', newPassword: 'short' }))
        .rejects.toMatchObject({ status: 400, code: 'bad_request' });
    });

    it('合法 token 成功改密 + tokenVersion++ + 审计', async () => {
      // 修复 H1/H3：reset token 内嵌 tokenVersion，resetPassword 校验时与库比对。
      const token = jwt.sign({ sub: 'u1', email: 'a@b.com', scope: 'pwd_reset', tokenVersion: 3 }, process.env.JWT_SECRET!, { expiresIn: '15m' });
      prisma.user.findUnique.mockResolvedValue({ tokenVersion: 3, status: 'ACTIVE' });
      prisma.user.updateMany.mockResolvedValue({ count: 1 });
      prisma.user.findUniqueOrThrow.mockResolvedValue({ id: 'u1', email: 'a@b.com' });

      const result = await service.resetPassword({ token, newPassword: 'newpass123' });
      expect(result.ok).toBe(true);
      // updateMany 带 tokenVersion: { increment: 1 }（作废所有旧登录 token），
      // 且 where 含 tokenVersion（防重放 + 覆盖降级场景）。
      expect(prisma.__tx.user.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'u1', status: 'ACTIVE', tokenVersion: 3 },
        data: expect.objectContaining({ tokenVersion: { increment: 1 } }),
      }));
      // 审计 action=auth.password.reset。
      expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ action: 'auth.password.reset', targetId: 'u1' }),
      }));
    });

    it('账号非 ACTIVE 时抛 bad_request', async () => {
      const token = jwt.sign({ sub: 'u1', email: 'a@b.com', scope: 'pwd_reset', tokenVersion: 3 }, process.env.JWT_SECRET!, { expiresIn: '15m' });
      prisma.user.findUnique.mockResolvedValue({ tokenVersion: 3, status: 'DISABLED' });
      await expect(service.resetPassword({ token, newPassword: 'newpass123' }))
        .rejects.toMatchObject({ status: 400, code: 'bad_request' });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('token 内嵌 tokenVersion 与库不一致（重放/降级场景）时抛 bad_request', async () => {
      // 修复 H1/H3：改密后 tokenVersion 已自增，旧 reset token 内嵌旧值校验失败。
      const token = jwt.sign({ sub: 'u1', email: 'a@b.com', scope: 'pwd_reset', tokenVersion: 3 }, process.env.JWT_SECRET!, { expiresIn: '15m' });
      prisma.user.findUnique.mockResolvedValue({ tokenVersion: 4, status: 'ACTIVE' });
      await expect(service.resetPassword({ token, newPassword: 'newpass123' }))
        .rejects.toMatchObject({ status: 400, code: 'bad_request' });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('scope 非 pwd_reset 的 token 被拒绝', async () => {
      // 用登录 scope 的 token（无 scope=pwd_reset）应被拒。
      const token = jwt.sign({ sub: 'u1', email: 'a@b.com' }, process.env.JWT_SECRET!, { expiresIn: '15m' });
      await expect(service.resetPassword({ token, newPassword: 'newpass123' }))
        .rejects.toMatchObject({ status: 400, code: 'bad_request' });
    });

    it('过期的 token 被拒绝（jwt.verify 抛错）', async () => {
      // 签发一个已过期的 token（expiresIn: -1s 即已过期）。
      const token = jwt.sign({ sub: 'u1', email: 'a@b.com', scope: 'pwd_reset', tokenVersion: 3 }, process.env.JWT_SECRET!, { expiresIn: '-1s' });
      await expect(service.resetPassword({ token, newPassword: 'newpass123' }))
        .rejects.toMatchObject({ status: 400, code: 'bad_request' });
    });
  });

  // === 组D 审计完善：login/register/logout/refresh 审计埋点 ===
  describe('login 审计', () => {
    // sessionFor 内部 findUnique 带 memberships include，mock 需返回完整 user 行。
    // 用真实 bcrypt hash（明文 'pass1234'）确保 bcrypt.compare 通过。
    const realHash = bcrypt.hashSync('pass1234', 12);
    const activeUser = {
      id: 'u1', email: 'a@b.com', status: 'ACTIVE', passwordHash: realHash, tokenVersion: 0,
      displayName: 'A', platformRole: 'NONE', emailVerified: null, memberships: [],
      // 组B 账户锁定字段：未锁定态（lockedUntil=null + attempts=0），login 入口锁检查放行。
      failedLoginAttempts: 0, lockedUntil: null,
    };

    it('登录成功写 auth.login.success 审计', async () => {
      prisma.user.findUnique.mockResolvedValueOnce(activeUser);
      // sessionFor 内部再读一次 user + teamAdminApplication。
      prisma.user.findUnique.mockResolvedValueOnce(activeUser);
      prisma.teamAdminApplication.findFirst = vi.fn(async () => null);
      const result = await service.login({ email: 'a@b.com', password: 'pass1234' });
      expect(result.user.id).toBe('u1');
      // 成功审计 action=auth.login.success。
      expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ action: 'auth.login.success', actorUserId: 'u1', targetId: 'u1' }),
      }));
    });

    it('密码错误写 auth.login.failed 审计（reason=wrong_password）', async () => {
      prisma.user.findUnique.mockResolvedValueOnce(activeUser);
      // 组B recordFailedLogin 内部再 findUnique 读 failedLoginAttempts（返回 0 → 累计 1，未达阈值）。
      prisma.user.findUnique.mockResolvedValueOnce({ failedLoginAttempts: 0 });
      await expect(service.login({ email: 'a@b.com', password: 'wrongpass' }))
        .rejects.toMatchObject({ status: 401, code: 'unauthorized' });
      expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ action: 'auth.login.failed', actorUserId: 'u1', metadata: expect.objectContaining({ reason: 'wrong_password' }) }),
      }));
    });

    it('用户不存在时写 auth.login.failed 审计（actorUserId=null）', async () => {
      prisma.user.findUnique.mockResolvedValueOnce(null);
      await expect(service.login({ email: 'nobody@b.com', password: 'pass1234' }))
        .rejects.toMatchObject({ status: 401, code: 'unauthorized' });
      expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ action: 'auth.login.failed', actorUserId: null }),
      }));
    });

    it('账号非 ACTIVE 时写 auth.login.failed 审计（reason=account_inactive）', async () => {
      prisma.user.findUnique.mockResolvedValueOnce({ ...activeUser, status: 'DISABLED' });
      await expect(service.login({ email: 'a@b.com', password: 'pass1234' }))
        .rejects.toMatchObject({ status: 401, code: 'unauthorized' });
      expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ action: 'auth.login.failed', metadata: expect.objectContaining({ reason: 'account_inactive' }) }),
      }));
    });
  });

  // === 组B 账户级密码重试锁定 ===
  describe('组B 账户锁定', () => {
    const realHash = bcrypt.hashSync('pass1234', 12);
    const baseUser = {
      id: 'u1', email: 'a@b.com', status: 'ACTIVE', passwordHash: realHash, tokenVersion: 0,
      displayName: 'A', platformRole: 'NONE', emailVerified: null, memberships: [],
      failedLoginAttempts: 0, lockedUntil: null,
    };

    it('lockedUntil 未过期时直接拒绝并写 auth.login.locked 审计（返剩余分钟）', async () => {
      // 锁定到 10 分钟后。
      const lockedUser = { ...baseUser, lockedUntil: new Date(Date.now() + 10 * 60_000) };
      prisma.user.findUnique.mockResolvedValueOnce(lockedUser);
      await expect(service.login({ email: 'a@b.com', password: 'pass1234' }))
        .rejects.toMatchObject({ status: 403, code: 'forbidden' });
      expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ action: 'auth.login.locked', actorUserId: 'u1', metadata: expect.objectContaining({ remainingMinutes: expect.any(Number) }) }),
      }));
      // 锁定时不应比对密码（bcrypt.compare 不触发）。
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('lockedUntil 已过期（历史时间）放行登录', async () => {
      // 锁定时间已过（1 分钟前）→ 不再拦截，走正常密码校验。
      const unlockedUser = { ...baseUser, lockedUntil: new Date(Date.now() - 60_000) };
      prisma.user.findUnique.mockResolvedValueOnce(unlockedUser);
      // sessionFor 再读一次。
      prisma.user.findUnique.mockResolvedValueOnce(unlockedUser);
      const result = await service.login({ email: 'a@b.com', password: 'pass1234' });
      expect(result.user.id).toBe('u1');
    });

    it('密码错误累计 attempts，未达阈值不锁定（默认 5 次）', async () => {
      prisma.user.findUnique.mockResolvedValueOnce(baseUser);
      // recordFailedLogin 读 attempts：当前 2 → 累计 3，未达 5 → 仅自增 attempts，不写 auth.login.locked。
      prisma.user.findUnique.mockResolvedValueOnce({ failedLoginAttempts: 2 });
      await expect(service.login({ email: 'a@b.com', password: 'wrongpass' }))
        .rejects.toMatchObject({ status: 401, code: 'unauthorized' });
      // 仅自增 attempts（不设 lockedUntil）。
      expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'u1' },
        data: { failedLoginAttempts: 3 },
      }));
      // 未达阈值：不写 auth.login.locked 审计（只有 auth.login.failed）。
      expect(prisma.auditLog.create).not.toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ action: 'auth.login.locked' }),
      }));
    });

    it('达阈值时设 lockedUntil 并写 auth.login.locked 审计', async () => {
      prisma.user.findUnique.mockResolvedValueOnce(baseUser);
      // 当前 attempts=4 → 累计 5 达默认阈值 → 设 lockedUntil。
      prisma.user.findUnique.mockResolvedValueOnce({ failedLoginAttempts: 4 });
      await expect(service.login({ email: 'a@b.com', password: 'wrongpass' }))
        .rejects.toMatchObject({ status: 401, code: 'unauthorized' });
      // update 含 lockedUntil（Date）且 attempts=5。
      expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'u1' },
        data: expect.objectContaining({ failedLoginAttempts: 5, lockedUntil: expect.any(Date) }),
      }));
      // 触发锁定：写 auth.login.locked 审计（metadata 含 attempts + lockMinutes）。
      expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ action: 'auth.login.locked', actorUserId: 'u1', metadata: expect.objectContaining({ attempts: 5, lockMinutes: 15 }) }),
      }));
    });

    it('阈值/锁定期读 PlatformSetting（可配）', async () => {
      // 配置：3 次锁定 / 30 分钟。当前 attempts=2 → 累计 3 达自定义阈值。
      prisma.platformSetting.findMany.mockResolvedValueOnce([
        { key: 'maxLoginAttempts', value: '3' },
        { key: 'lockDurationMinutes', value: '30' },
      ]);
      prisma.user.findUnique.mockResolvedValueOnce(baseUser);
      prisma.user.findUnique.mockResolvedValueOnce({ failedLoginAttempts: 2 });
      await expect(service.login({ email: 'a@b.com', password: 'wrongpass' }))
        .rejects.toMatchObject({ status: 401, code: 'unauthorized' });
      expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ failedLoginAttempts: 3, lockedUntil: expect.any(Date) }),
      }));
      expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ action: 'auth.login.locked', metadata: expect.objectContaining({ attempts: 3, lockMinutes: 30 }) }),
      }));
    });

    it('登录成功后重置 failedLoginAttempts=0 + lockedUntil=null', async () => {
      prisma.user.findUnique.mockResolvedValueOnce(baseUser);
      // sessionFor 再读一次。
      prisma.user.findUnique.mockResolvedValueOnce(baseUser);
      const result = await service.login({ email: 'a@b.com', password: 'pass1234' });
      expect(result.user.id).toBe('u1');
      expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'u1' },
        data: { failedLoginAttempts: 0, lockedUntil: null },
      }));
    });
  });

  describe('register 审计', () => {
    it('注册成功写 auth.register 审计', async () => {
      // findUnique 调用顺序：① 存在性检查（null）② sendVerificationEmail 读 tokenVersion/emailVerified ③ sessionFor 读完整 user。
      prisma.user.findUnique.mockResolvedValueOnce(null);
      prisma.user.findUnique.mockResolvedValueOnce({ tokenVersion: 0, emailVerified: null });
      prisma.user.findUnique.mockResolvedValueOnce({ id: 'new-user', email: 'new@b.com', status: 'ACTIVE', tokenVersion: 0, displayName: 'New', platformRole: 'NONE', emailVerified: null, memberships: [] });
      prisma.user.create.mockResolvedValueOnce({ id: 'new-user', email: 'new@b.com', displayName: 'New' });

      const result = await service.register({ email: 'new@b.com', password: 'newpass1234' });
      expect(result.user.id).toBe('new-user');
      // 注册审计 action=auth.register（事务内 tx.auditLog.create）。
      expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ action: 'auth.register', actorUserId: 'new-user' }),
      }));
    });

    it('wantsTeamAdmin=true 时同时写 team_admin_application.created 审计', async () => {
      prisma.user.findUnique.mockResolvedValueOnce(null);
      prisma.user.findUnique.mockResolvedValueOnce({ tokenVersion: 0, emailVerified: null });
      prisma.user.findUnique.mockResolvedValueOnce({ id: 'new-admin', email: 'admin@b.com', status: 'ACTIVE', tokenVersion: 0, displayName: 'Admin', platformRole: 'NONE', emailVerified: null, memberships: [] });
      prisma.user.create.mockResolvedValueOnce({ id: 'new-admin', email: 'admin@b.com', displayName: 'Admin' });

      await service.register({ email: 'admin@b.com', password: 'newpass1234', wantsTeamAdmin: true, teamName: '我的团队' });
      // 团队管理员申请审计 action=team_admin_application.created。
      expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ action: 'team_admin_application.created' }),
      }));
    });
  });

  describe('logout / refresh 审计', () => {
    it('logout 写 auth.logout 审计（actor=用户自身）', async () => {
      const result = await service.logout('u1');
      expect(result.ok).toBe(true);
      expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ action: 'auth.logout', actorUserId: 'u1', targetId: 'u1' }),
      }));
    });

    it('logout 审计写入失败不阻塞响应（降级吞错）', async () => {
      prisma.auditLog.create.mockRejectedValueOnce(new Error('db down'));
      const result = await service.logout('u1');
      expect(result.ok).toBe(true);
    });

    it('refresh 写 auth.token.refreshed 审计', async () => {
      prisma.user.findUnique.mockResolvedValueOnce({ id: 'u1', email: 'a@b.com', status: 'ACTIVE', tokenVersion: 0, displayName: 'A', platformRole: 'NONE', emailVerified: null, memberships: [] });
      prisma.teamAdminApplication.findFirst = vi.fn(async () => null);
      await service.refresh('u1');
      expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ action: 'auth.token.refreshed', actorUserId: 'u1' }),
      }));
    });

    it('refresh 审计写入失败不阻塞 sessionFor（降级吞错）', async () => {
      prisma.auditLog.create.mockRejectedValueOnce(new Error('db down'));
      prisma.user.findUnique.mockResolvedValueOnce({ id: 'u1', email: 'a@b.com', status: 'ACTIVE', tokenVersion: 0, displayName: 'A', platformRole: 'NONE', emailVerified: null, memberships: [] });
      prisma.teamAdminApplication.findFirst = vi.fn(async () => null);
      // 审计失败但 sessionFor 仍正常返回 session（token 续签优先）。
      const result = await service.refresh('u1');
      expect(result.user.id).toBe('u1');
    });
  });


  // === 组C 极验验证码：仅管理端登录/找回密码按配置强制校验，应用端认证入口不接收验证码 ===
  describe('管理端验证码校验', () => {
    const realHash = bcrypt.hashSync('pass1234', 12);
    const activeUser = {
      id: 'u1', email: 'a@b.com', status: 'ACTIVE', passwordHash: realHash, tokenVersion: 0,
      displayName: 'A', platformRole: 'NONE', emailVerified: null, memberships: [],
      failedLoginAttempts: 0, lockedUntil: null,
    };

    const activeAdmin = { ...activeUser, platformRole: 'PLATFORM_ADMIN' };

    it('应用端 login 不读取验证码场景配置', async () => {
      geetest.isSceneEnabled.mockResolvedValue(true);
      geetest.validate.mockResolvedValue(false);
      prisma.user.findUnique.mockResolvedValueOnce(activeUser).mockResolvedValueOnce(activeUser);
      prisma.teamAdminApplication.findFirst = vi.fn(async () => null);
      const result = await service.login({ email: 'a@b.com', password: 'pass1234' });
      expect(result.user.id).toBe('u1');
      expect(geetest.isSceneEnabled).not.toHaveBeenCalled();
      expect(geetest.validate).not.toHaveBeenCalled();
    });

    it('平台管理员不能通过应用端 login 绕过管理端验证码边界', async () => {
      geetest.isSceneEnabled.mockResolvedValue(true);
      geetest.validate.mockResolvedValue(false);
      prisma.user.findUnique.mockResolvedValueOnce(activeAdmin);
      await expect(service.login({ email: 'a@b.com', password: 'pass1234' }))
        .rejects.toMatchObject({ status: 403, code: 'forbidden' });
      expect(geetest.isSceneEnabled).not.toHaveBeenCalled();
      expect(geetest.validate).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          action: 'auth.login.failed',
          actorUserId: 'u1',
          metadata: expect.objectContaining({ reason: 'platform_admin_requires_admin_login' }),
        }),
      }));
    });

    it('应用端 register 不读取验证码场景配置', async () => {
      geetest.isSceneEnabled.mockResolvedValue(true);
      geetest.validate.mockResolvedValue(false);
      prisma.user.findUnique.mockResolvedValueOnce(null);
      prisma.user.findUnique.mockResolvedValueOnce({ tokenVersion: 0, emailVerified: null });
      prisma.user.findUnique.mockResolvedValueOnce({ id: 'new-user', email: 'new@b.com', status: 'ACTIVE', tokenVersion: 0, displayName: 'New', platformRole: 'NONE', emailVerified: null, memberships: [] });
      prisma.user.create.mockResolvedValueOnce({ id: 'new-user', email: 'new@b.com', displayName: 'New' });
      const result = await service.register({ email: 'new@b.com', password: 'newpass1234' });
      expect(result.user.id).toBe('new-user');
      expect(geetest.isSceneEnabled).not.toHaveBeenCalled();
      expect(geetest.validate).not.toHaveBeenCalled();
    });

    it('管理端 login 场景未启用时跳过验证码校验', async () => {
      geetest.isSceneEnabled.mockResolvedValue(false);
      prisma.user.findUnique.mockResolvedValueOnce(activeAdmin).mockResolvedValueOnce(activeAdmin);
      prisma.teamAdminApplication.findFirst = vi.fn(async () => null);
      const result = await service.adminLogin({ email: 'a@b.com', password: 'pass1234' });
      expect(result.user.id).toBe('u1');
      expect(geetest.isSceneEnabled).toHaveBeenCalledWith('admin_login');
      expect(geetest.validate).not.toHaveBeenCalled();
    });

    it('非平台管理员不能通过管理端登录入口', async () => {
      geetest.isSceneEnabled.mockResolvedValue(false);
      prisma.user.findUnique.mockResolvedValueOnce(activeUser).mockResolvedValueOnce(activeUser);
      prisma.teamAdminApplication.findFirst = vi.fn(async () => null);
      await expect(service.adminLogin({ email: 'a@b.com', password: 'pass1234' }))
        .rejects.toMatchObject({ status: 403, code: 'forbidden' });
    });

    it('管理端 login 场景启用且缺 captcha 抛 bad_request', async () => {
      geetest.isSceneEnabled.mockResolvedValue(true);
      geetest.validate.mockResolvedValue(false);
      await expect(service.adminLogin({ email: 'a@b.com', password: 'pass1234' }))
        .rejects.toMatchObject({ status: 400, code: 'bad_request' });
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(geetest.validate).toHaveBeenCalledTimes(1);
    });

    it('管理端 forgot 场景启用且验证通过则发送重置邮件', async () => {
      geetest.isSceneEnabled.mockResolvedValue(true);
      geetest.validate.mockResolvedValue(true);
      prisma.user.findUnique.mockResolvedValueOnce({ id: 'u1', email: 'a@b.com', status: 'ACTIVE', tokenVersion: 0, platformRole: 'PLATFORM_ADMIN' });
      const result = await service.adminForgotPassword({
        email: 'a@b.com',
        captcha: { lot_number: 'l', captcha_output: 'o', pass_token: 'p', gen_time: 'g' },
      });
      expect(result.ok).toBe(true);
      expect(result.message).toBe('若该邮箱已注册且邮件服务可用，将收到重置链接');
      expect(geetest.isSceneEnabled).toHaveBeenCalledWith('admin_forgot');
      expect(geetest.validate).toHaveBeenCalledWith({ lot_number: 'l', captcha_output: 'o', pass_token: 'p', gen_time: 'g' });
      expect(mail.sendPasswordReset).toHaveBeenCalledTimes(1);
    });

    it('管理端 forgot 不向普通账号发邮件', async () => {
      geetest.isSceneEnabled.mockResolvedValue(true);
      geetest.validate.mockResolvedValue(true);
      prisma.user.findUnique.mockResolvedValueOnce({ id: 'u1', email: 'a@b.com', status: 'ACTIVE', tokenVersion: 0, platformRole: 'NONE' });
      const result = await service.adminForgotPassword({
        email: 'a@b.com',
        captcha: { lot_number: 'l', captcha_output: 'o', pass_token: 'p', gen_time: 'g' },
      });
      expect(result.ok).toBe(true);
      expect(mail.sendPasswordReset).not.toHaveBeenCalled();
    });

    it('应用端 forgot 不向平台管理员发邮件', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.com', status: 'ACTIVE', tokenVersion: 0, platformRole: 'PLATFORM_ADMIN' });
      const result = await service.forgotPassword({ email: 'a@b.com' });
      expect(result.ok).toBe(true);
      expect(mail.sendPasswordReset).not.toHaveBeenCalled();
    });

    it('应用端 forgot 不要求验证码且不读取管理端场景', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      const result = await service.forgotPassword({ email: 'a@b.com' });
      expect(result.ok).toBe(true);
      expect(geetest.isSceneEnabled).not.toHaveBeenCalled();
      expect(geetest.validate).not.toHaveBeenCalled();
    });
  });

  describe('verifyEmail', () => {
    it('token 无效时抛 bad_request', async () => {
      await expect(service.verifyEmail({ token: 'invalid-token' }))
        .rejects.toMatchObject({ status: 400, code: 'bad_request' });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('scope 非 email_verify 的 token 被拒绝', async () => {
      const token = jwt.sign({ sub: 'u1', email: 'a@b.com', scope: 'pwd_reset', tokenVersion: 3 }, process.env.JWT_SECRET!, { expiresIn: '1h' });
      await expect(service.verifyEmail({ token }))
        .rejects.toMatchObject({ status: 400, code: 'bad_request' });
    });

    it('账号非 ACTIVE 时抛 bad_request', async () => {
      const token = jwt.sign({ sub: 'u1', email: 'a@b.com', scope: 'email_verify', tokenVersion: 0 }, process.env.JWT_SECRET!, { expiresIn: '1h' });
      prisma.user.findUnique.mockResolvedValue({ tokenVersion: 0, status: 'DISABLED', emailVerified: null });
      await expect(service.verifyEmail({ token }))
        .rejects.toMatchObject({ status: 400, code: 'bad_request' });
    });

    it('已验证用户幂等返回成功（不重复 update）', async () => {
      const token = jwt.sign({ sub: 'u1', email: 'a@b.com', scope: 'email_verify', tokenVersion: 0 }, process.env.JWT_SECRET!, { expiresIn: '1h' });
      prisma.user.findUnique.mockResolvedValue({ tokenVersion: 0, status: 'ACTIVE', emailVerified: new Date('2026-01-01') });
      const result = await service.verifyEmail({ token });
      expect(result.ok).toBe(true);
      expect(result.alreadyVerified).toBe(true);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('token 内嵌 tokenVersion 与库不一致时抛 bad_request', async () => {
      const token = jwt.sign({ sub: 'u1', email: 'a@b.com', scope: 'email_verify', tokenVersion: 3 }, process.env.JWT_SECRET!, { expiresIn: '1h' });
      prisma.user.findUnique.mockResolvedValue({ tokenVersion: 4, status: 'ACTIVE', emailVerified: null });
      await expect(service.verifyEmail({ token }))
        .rejects.toMatchObject({ status: 400, code: 'bad_request' });
    });

    it('合法 token 成功标记 emailVerified + 审计', async () => {
      const token = jwt.sign({ sub: 'u1', email: 'a@b.com', scope: 'email_verify', tokenVersion: 0 }, process.env.JWT_SECRET!, { expiresIn: '1h' });
      prisma.user.findUnique.mockResolvedValue({ tokenVersion: 0, status: 'ACTIVE', emailVerified: null });
      const result = await service.verifyEmail({ token });
      expect(result.ok).toBe(true);
      expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'u1' },
        data: expect.objectContaining({ emailVerified: expect.any(Date) }),
      }));
      expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ action: 'auth.email.verified', targetId: 'u1' }),
      }));
    });
  });

  describe('resendVerification', () => {
    it('已验证用户幂等返回（不发邮件）', async () => {
      prisma.user.findUnique.mockResolvedValue({ email: 'a@b.com', status: 'ACTIVE', emailVerified: new Date('2026-01-01'), tokenVersion: 0 });
      const result = await service.resendVerification('u1');
      expect(result.ok).toBe(true);
      expect(result.alreadyVerified).toBe(true);
      expect(mail.sendEmailVerification).not.toHaveBeenCalled();
    });

    it('未验证用户重发验证邮件', async () => {
      // sendVerificationEmail 内部先 findUnique（tokenVersion/emailVerified）再发邮件。
      prisma.user.findUnique
        .mockResolvedValueOnce({ email: 'a@b.com', status: 'ACTIVE', emailVerified: null, tokenVersion: 0 }) // resendVerification 入口
        .mockResolvedValueOnce({ tokenVersion: 0, emailVerified: null }); // sendVerificationEmail 内部
      const result = await service.resendVerification('u1');
      expect(result.ok).toBe(true);
      expect(mail.sendEmailVerification).toHaveBeenCalledTimes(1);
      expect(String(mail.sendEmailVerification.mock.calls[0][1])).toContain('verify_token=');
    });
  });

  describe('团队上下文 session', () => {
    it('在 JWT 中签名一次选定的 teamId 和 teamContextVersion', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        email: 'a@b.com',
        displayName: 'A',
        status: 'ACTIVE',
        platformRole: 'NONE',
        platformRoleId: null,
        tokenVersion: 4,
        teamContextVersion: 7,
        emailVerified: null,
        memberships: [{
          teamId: 't-newest',
          role: 'MEMBER',
          teamRoleId: null,
          team: { id: 't-newest', name: 'T', slug: 't', status: 'ACTIVE' },
        }],
      });
      prisma.teamAdminApplication.findFirst.mockResolvedValue(null);

      const session = await service.sessionAfterTeamContextChange('u1');
      const payload = jwt.verify(session.token!, process.env.JWT_SECRET!) as jwt.JwtPayload;
      expect(payload).toMatchObject({
        sub: 'u1',
        teamId: 't-newest',
        teamContextVersion: 7,
        tokenVersion: 4,
      });
    });
  });
});
