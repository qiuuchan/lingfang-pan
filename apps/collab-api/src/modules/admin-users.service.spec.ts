// AdminUsersService 单测：聚焦 adminCreateUser / adminUpdateUser 的密码安全校验。
//
// 背景（commercial-readiness audit P1）：adminCreateUser 曾把空密码回退为已知弱口令
// 'ChangeMe123!'（bcrypt.hash(input.password || 'ChangeMe123!', 12)）——后台建用户留空密码
// 即落入弱口令字典。修复后改为显式校验：空密码拒绝（400）+ 最少 8 位（400）。
// 本测试锁死该校验，防止回退逻辑复活。
//
// Mock 约定参考 admin.service.spec.ts / release.service.spec.ts：不连真实 DB。
import { describe, expect, it, vi, beforeEach } from 'vitest';
import bcrypt from 'bcryptjs';
import { AdminUsersService } from './admin-users.service';
import { forbidden } from '../common';
import { SYSTEM_PLATFORM_ADMIN_ROLE_ID } from './permissions/permission-codes';

function mockPrisma() {
  return {
    user: {
      create: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
    },
    auditLog: { create: vi.fn() },
  };
}

function mockAuth() {
  return { ensurePlatformAdmin: vi.fn() };
}

function mockNotifications() {
  return { create: vi.fn() };
}

function mockMail() {
  return { sendMail: vi.fn(async () => undefined) };
}

describe('AdminUsersService 密码安全校验（commercial-readiness P1）', () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let auth: ReturnType<typeof mockAuth>;
  let service: AdminUsersService;

  beforeEach(() => {
    prisma = mockPrisma();
    auth = mockAuth();
    // @ts-expect-error mock 不实现完整 PrismaService/NotificationService 接口，仅测用到的方法。
    service = new AdminUsersService(prisma, auth, mockNotifications(), mockMail());
  });

  describe('adminCreateUser', () => {
    it('非平台管理员被拒绝（403），不落库', async () => {
      auth.ensurePlatformAdmin.mockImplementation(() => {
        throw forbidden('仅平台管理员可操作');
      });
      await expect(
        service.adminCreateUser('user-member', { email: 'a@x.com', password: 'StrongPass123' })
      ).rejects.toMatchObject({ status: 403, code: 'forbidden' });
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('空密码被拒绝（400）——锁死 ChangeMe123! 回退不复活', async () => {
      await expect(
        service.adminCreateUser('user-admin', { email: 'a@x.com', password: '' })
      ).rejects.toMatchObject({ status: 400, code: 'bad_request' });
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('undefined/缺失密码同样被拒绝（400）', async () => {
      await expect(
        // 模拟绕过 DTO 直接调用（如内部误用），password 为 undefined。
        service.adminCreateUser('user-admin', {
          email: 'a@x.com',
          password: undefined as unknown as string,
        })
      ).rejects.toMatchObject({ status: 400, code: 'bad_request' });
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('少于 8 位的密码被拒绝（400）', async () => {
      await expect(
        service.adminCreateUser('user-admin', { email: 'a@x.com', password: 'Ab1!' })
      ).rejects.toMatchObject({ status: 400, code: 'bad_request' });
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('合法密码：bcrypt 落库（非明文、非默认弱口令）+ 审计 + publicUser 出参脱敏', async () => {
      const created = {
        id: 'u1',
        email: 'a@x.com',
        displayName: 'a@x.com',
        status: 'ACTIVE',
        platformRole: 'NONE',
        passwordHash: '$2b$12$hashedvalue',
        platformRoleId: null,
      };
      prisma.user.create.mockResolvedValue(created);

      const result = await service.adminCreateUser('user-admin', {
        email: ' A@X.com ',
        password: 'StrongPass123',
      });

      // email 归一化（trim + lower）。
      const createArg = prisma.user.create.mock.calls[0][0] as { data: Record<string, unknown> };
      expect(createArg.data.email).toBe('a@x.com');
      // 密码被哈希：绝不落明文，也绝不落入已知弱口令 ChangeMe123! 的哈希。
      const hash = createArg.data.passwordHash as string;
      expect(hash).not.toBe('StrongPass123');
      expect(await bcrypt.compare('StrongPass123', hash)).toBe(true);
      expect(await bcrypt.compare('ChangeMe123!', hash)).toBe(false);
      // 审计写入 + 出参脱敏（不含 passwordHash）。
      expect(prisma.auditLog.create).toHaveBeenCalled();
      expect(result.user).toMatchObject({ id: 'u1', email: 'a@x.com' });
      expect(result.user).not.toHaveProperty('passwordHash');
    });

    it('platformRole=PLATFORM_ADMIN 时双写系统角色 platformRoleId（RBAC 一致性）', async () => {
      prisma.user.create.mockResolvedValue({
        id: 'u2',
        email: 'b@x.com',
        displayName: 'b',
        status: 'ACTIVE',
        platformRole: 'PLATFORM_ADMIN',
        passwordHash: '$2b$12$x',
        platformRoleId: SYSTEM_PLATFORM_ADMIN_ROLE_ID,
      });
      await service.adminCreateUser('user-admin', {
        email: 'b@x.com',
        password: 'StrongPass123',
        platformRole: 'PLATFORM_ADMIN',
      });
      const createArg = prisma.user.create.mock.calls[0][0] as { data: Record<string, unknown> };
      expect(createArg.data.platformRole).toBe('PLATFORM_ADMIN');
      expect(createArg.data.platformRoleId).toBe(SYSTEM_PLATFORM_ADMIN_ROLE_ID);
    });
  });

  describe('adminUpdateUser 改密路径', () => {
    it('少于 8 位的新密码被拒绝（400），不落库', async () => {
      await expect(
        service.adminUpdateUser('user-admin', 'u1', { password: 'short' })
      ).rejects.toMatchObject({ status: 400, code: 'bad_request' });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('空字符串新密码被拒绝（400）——不允许把密码"改空"', async () => {
      await expect(
        service.adminUpdateUser('user-admin', 'u1', { password: '' })
      ).rejects.toMatchObject({ status: 400, code: 'bad_request' });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });
});
