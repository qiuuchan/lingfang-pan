// AuthService 找回密码 + 重置密码单测（Top5 解法）。
//  - forgotPassword：邮箱不存在时静默跳过（不抛错，防邮箱探测）；存在时签发 reset token + 发邮件。
//  - resetPassword：token 无效/过期抛 bad_request；新密码 <8 位抛 bad_request；成功改密 + tokenVersion++ + 审计。
// 参考 release.service.spec.ts：Mock PrismaService + MailService，不连真实 DB。
// 注意 JWT_SECRET 由 vitest setup 注入（见 vitest.config 或 .env）；测试用真实 jwt 签发/校验闭环。
import { describe, expect, it, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { AuthService } from './auth.service';
import { MailService } from './mail.service';

// 测试用固定密钥（与 main.ts fail-fast 配合：dev 缺密钥仅 warn）。
process.env.JWT_SECRET = 'test-secret-for-password-reset-at-least-16-chars';

function mockPrisma() {
  const user = {
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    findUniqueOrThrow: vi.fn(),
  };
  const auditLog = { create: vi.fn() };
  const tx = { user: { updateMany: user.updateMany, findUniqueOrThrow: user.findUniqueOrThrow } };
  const $transaction = vi.fn(async (cb: (tx: typeof tx) => Promise<unknown>) => cb(tx));
  return { user, auditLog, $transaction, __tx: tx };
}

function mockMail() {
  return { isConfigured: vi.fn(() => false), sendMail: vi.fn(async () => undefined) };
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
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.com', status: 'ACTIVE' });
      const result = await service.forgotPassword({ email: 'a@b.com' });
      expect(result.ok).toBe(true);
      // sendMail 被调用，邮件内容含 reset_token。
      expect(mail.sendMail).toHaveBeenCalledTimes(1);
      const call = mail.sendMail.mock.calls[0];
      expect(call[0]).toBe('a@b.com'); // to
      expect(String(call[2])).toContain('reset_token='); // html 含链接
    });

    it('已禁用用户不发邮件（静默跳过）', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.com', status: 'DISABLED' });
      await service.forgotPassword({ email: 'a@b.com' });
      expect(mail.sendMail).not.toHaveBeenCalled();
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
      // 用真实 jwt 签发一个 scope=pwd_reset 的 token（与 issueResetToken 闭环）。
      const token = jwt.sign({ sub: 'u1', email: 'a@b.com', scope: 'pwd_reset' }, process.env.JWT_SECRET!, { expiresIn: '15m' });
      prisma.user.updateMany.mockResolvedValue({ count: 1 });
      prisma.user.findUniqueOrThrow.mockResolvedValue({ id: 'u1', email: 'a@b.com' });

      const result = await service.resetPassword({ token, newPassword: 'newpass123' });
      expect(result.ok).toBe(true);
      // updateMany 带 tokenVersion: { increment: 1 }（作废所有旧登录 token）。
      expect(prisma.__tx.user.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'u1', status: 'ACTIVE' },
        data: expect.objectContaining({ tokenVersion: { increment: 1 } }),
      }));
      // 审计 action=auth.password.reset。
      expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ action: 'auth.password.reset', targetId: 'u1' }),
      }));
    });

    it('账号非 ACTIVE（updateMany count=0）时抛 bad_request', async () => {
      const token = jwt.sign({ sub: 'u1', email: 'a@b.com', scope: 'pwd_reset' }, process.env.JWT_SECRET!, { expiresIn: '15m' });
      prisma.user.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.resetPassword({ token, newPassword: 'newpass123' }))
        .rejects.toMatchObject({ status: 400, code: 'bad_request' });
    });

    it('scope 非 pwd_reset 的 token 被拒绝', async () => {
      // 用登录 scope 的 token（无 scope=pwd_reset）应被拒。
      const token = jwt.sign({ sub: 'u1', email: 'a@b.com' }, process.env.JWT_SECRET!, { expiresIn: '15m' });
      await expect(service.resetPassword({ token, newPassword: 'newpass123' }))
        .rejects.toMatchObject({ status: 400, code: 'bad_request' });
    });

    it('过期的 token 被拒绝（jwt.verify 抛错）', async () => {
      // 签发一个已过期的 token（expiresIn: -1s 即已过期）。
      const token = jwt.sign({ sub: 'u1', email: 'a@b.com', scope: 'pwd_reset' }, process.env.JWT_SECRET!, { expiresIn: '-1s' });
      await expect(service.resetPassword({ token, newPassword: 'newpass123' }))
        .rejects.toMatchObject({ status: 400, code: 'bad_request' });
    });
  });
});
