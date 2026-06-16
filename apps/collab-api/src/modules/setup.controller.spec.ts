// SetupController 单测：覆盖首次安装向导核心契约。
//  - status：无 PLATFORM_ADMIN → needsSetup=true；有 → false。
//  - setup：已初始化时抛 403 setup_already_done（防被恶意创建管理员）；邮箱已占用抛 403 email_taken；
//    未初始化时建管理员 + 写 platformName + 审计（$transaction 原子）。
// 参考 health.controller.spec.ts / auth.service.spec.ts：Mock PrismaService，不连真实 DB。
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { SetupController } from './setup.controller';

// Mock bcryptjs：避免单测跑真实 hash（慢且与业务逻辑无关），仅校验 hash 被调用。
vi.mock('bcryptjs', () => ({ default: { hash: vi.fn(async () => 'hashed-password') } }));

function mockPrisma(overrides: Record<string, unknown> = {}) {
  // 事务回调内用到的 tx 方法（user.create / platformSetting.upsert / auditLog.create）默认 resolved。
  const tx = {
    user: { create: vi.fn(async () => ({ id: 'u1', email: 'a@b.com' })) },
    platformSetting: { create: vi.fn(async () => undefined), upsert: vi.fn(async () => undefined) },
    auditLog: { create: vi.fn(async () => undefined) },
  };
  const $transaction = vi.fn(async (cb: (tx: typeof tx) => Promise<unknown>) => cb(tx));
  const user = {
    count: vi.fn(async () => 0),
    findUnique: vi.fn(async () => null),
  };
  const platformSetting = { upsert: vi.fn(async () => undefined) };
  const auditLog = { create: vi.fn(async () => undefined) };
  return { $transaction, user, platformSetting, auditLog, tx, ...overrides };
}

describe('SetupController', () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let controller: SetupController;

  beforeEach(() => {
    prisma = mockPrisma();
    // @ts-expect-error mock 仅实现 setup 用到的方法，不补全完整 PrismaService 接口。
    controller = new SetupController(prisma);
  });

  describe('status', () => {
    it('无 PLATFORM_ADMIN 时 needsSetup=true', async () => {
      prisma.user.count.mockResolvedValue(0);
      const result = await controller.status();
      expect(result).toEqual({ needsSetup: true });
    });

    it('已有 PLATFORM_ADMIN 时 needsSetup=false', async () => {
      prisma.user.count.mockResolvedValue(1);
      const result = await controller.status();
      expect(result).toEqual({ needsSetup: false });
    });
  });

  describe('setup', () => {
    const validBody = {
      email: 'Admin@Example.com',
      password: 'ChangeMe123!',
      displayName: '平台管理员',
      platformName: '我的平台',
    };

    it('已初始化时抛 403（setup_already_done），防被恶意创建管理员', async () => {
      prisma.user.count.mockResolvedValue(1);
      await expect(controller.setup(validBody as never)).rejects.toMatchObject({
        status: 403,
        code: 'forbidden',
        details: { reason: 'setup_already_done' },
      });
      // 不应继续建用户（事务不应被调用）。
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('邮箱已被占用时抛 403（email_taken），不静默提权', async () => {
      prisma.user.count.mockResolvedValue(0);
      prisma.user.findUnique.mockResolvedValue({ id: 'other', email: 'admin@example.com', platformRole: 'NONE' });
      await expect(controller.setup(validBody as never)).rejects.toMatchObject({
        status: 403,
        details: { reason: 'email_taken' },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('未初始化时建管理员 + 写 platformName + 审计（邮箱归一化 trim/lowercase）', async () => {
      await controller.setup(validBody as never);
      // 邮箱归一化为小写。
      expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { email: 'admin@example.com' } });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      // 事务内：先创建 bootstrap lock，再建管理员（platformRole=PLATFORM_ADMIN）。
      expect(prisma.tx.platformSetting.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ key: '__setup_bootstrap_lock__', value: 'completed' }),
      }));
      const createCall = prisma.tx.user.create.mock.calls[0][0];
      expect(createCall.data.email).toBe('admin@example.com');
      expect(createCall.data.platformRole).toBe('PLATFORM_ADMIN');
      expect(createCall.data.passwordHash).toBe('hashed-password');
      // 写 platformName。
      expect(prisma.tx.platformSetting.upsert).toHaveBeenCalledTimes(1);
      const settingCall = prisma.tx.platformSetting.upsert.mock.calls[0][0];
      expect(settingCall.where.key).toBe('platformName');
      expect(settingCall.create.value).toBe('我的平台');
      // 审计 platform_admin.bootstrap。
      const auditCall = prisma.tx.auditLog.create.mock.calls[0][0];
      expect(auditCall.data.action).toBe('platform_admin.bootstrap');
      expect(auditCall.data.targetType).toBe('User');
    });

    it('bootstrap lock 冲突时抛 403（setup_already_done），兜住并发初始化', async () => {
      prisma.tx.platformSetting.create.mockRejectedValueOnce({ code: 'P2002' });
      await expect(controller.setup(validBody as never)).rejects.toMatchObject({
        status: 403,
        code: 'forbidden',
        details: { reason: 'setup_already_done' },
      });
      expect(prisma.tx.user.create).not.toHaveBeenCalled();
      expect(prisma.tx.auditLog.create).not.toHaveBeenCalled();
    });

    it('platformName 为空时只写 bootstrap lock，不写 platformName 设置（保留默认兜底）', async () => {
      await controller.setup({ email: 'a@b.com', password: 'ChangeMe123!' } as never);
      expect(prisma.tx.platformSetting.create).toHaveBeenCalledTimes(1);
      expect(prisma.tx.platformSetting.upsert).not.toHaveBeenCalled();
      // 仍建管理员 + 审计。
      expect(prisma.tx.user.create).toHaveBeenCalledTimes(1);
      expect(prisma.tx.auditLog.create).toHaveBeenCalledTimes(1);
    });

    it('platformName 过长时抛 400', async () => {
      const longName = 'x'.repeat(101);
      await expect(
        controller.setup({ email: 'a@b.com', password: 'ChangeMe123!', platformName: longName } as never),
      ).rejects.toMatchObject({ status: 400, code: 'bad_request' });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('displayName 为空时用邮箱兜底', async () => {
      await controller.setup({ email: 'a@b.com', password: 'ChangeMe123!' } as never);
      const createCall = prisma.tx.user.create.mock.calls[0][0];
      expect(createCall.data.displayName).toBe('a@b.com');
    });
  });
});
