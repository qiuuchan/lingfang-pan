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
    update: vi.fn(),
    create: vi.fn(),
  };
  // auditLog.create 默认返回 resolved Promise（logout/refresh 用 .catch() 链，需 thenable）。
  const auditLog = { create: vi.fn(async () => undefined) };
  const teamAdminApplication = { create: vi.fn(), findFirst: vi.fn(async () => null) };
  // tx 上下文：register 事务内调用 user.create + auditLog.create（+ 可选 teamAdminApplication.create）。
  const tx = {
    user: { updateMany: user.updateMany, findUniqueOrThrow: user.findUniqueOrThrow, create: user.create },
    auditLog,
    teamAdminApplication,
  };
  const $transaction = vi.fn(async (cb: (tx: typeof tx) => Promise<unknown>) => cb(tx));
  return { user, auditLog, teamAdminApplication, $transaction, __tx: tx };
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

describe('AuthService 找回密码 + 重置密码', () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let mail: ReturnType<typeof mockMail>;
  let service: AuthService;

  beforeEach(() => {
    prisma = mockPrisma();
    mail = mockMail();
    // @ts-expect-error mock 不实现完整 PrismaService 接口，仅测用到的方法。
    service = new AuthService(prisma, mail);
  });

  describe('forgotPassword', () => {
    it('邮箱不存在时静默跳过（不抛错，防邮箱探测）', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      const result = await service.forgotPassword({ email: 'nobody@example.com' });
      // 统一返回「链接已发送」，不泄漏邮箱是否注册。
      expect(result.ok).toBe(true);
      // 不存在的邮箱不发邮件。
      expect(mail.sendMail).not.toHaveBeenCalled();
    });

    it('邮箱存在时发邮件（含 reset_token 链接）', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.com', status: 'ACTIVE', tokenVersion: 0 });
      const result = await service.forgotPassword({ email: 'a@b.com' });
      expect(result.ok).toBe(true);
      // sendPasswordReset 被调用，链接含 reset_token。
      expect(mail.sendPasswordReset).toHaveBeenCalledTimes(1);
      const call = mail.sendPasswordReset.mock.calls[0];
      expect(call[0]).toBe('a@b.com'); // to
      expect(String(call[1])).toContain('reset_token='); // link 含 token
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
});
