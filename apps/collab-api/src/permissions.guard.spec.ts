// PermissionsGuard 单测：覆盖 @Public 放行、无 metadata 放行、平台权限命中/未命中、
// 团队权限解析（含团队 SUSPENDED 不解析）、OR 语义、请求级缓存、缺登录态拒绝。
// 参考 team.service.spec.ts 的 mock 模式：mock Reflector + PrismaService，构造 ExecutionContext。
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from './permissions.guard';
import { IS_PUBLIC_KEY } from './common';
import { PERMISSIONS_KEY } from './modules/auth.decorators';

function mockReflector(opts: { isPublic?: boolean; permissions?: string[] }) {
  return {
    getAllAndOverride: vi.fn((key: string) => {
      if (key === IS_PUBLIC_KEY) return opts.isPublic ?? false;
      if (key === PERMISSIONS_KEY) return opts.permissions;
      return undefined;
    }),
  } as unknown as Reflector;
}

function mockPrisma() {
  return {
    role: {
      findUnique: vi.fn(),
    },
    teamMembership: {
      findFirst: vi.fn(),
    },
  };
}

/** 构造 NestJS ExecutionContext，request 携带 user。 */
function mockContext(request: Record<string, unknown>) {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => 'handler',
    getClass: () => 'class',
  } as unknown as Parameters<PermissionsGuard['canActivate']>[0];
}

describe('PermissionsGuard', () => {
  let prisma: ReturnType<typeof mockPrisma>;

  beforeEach(() => {
    prisma = mockPrisma();
  });

  it('@Public 路由直接放行，不查库', async () => {
    const guard = new PermissionsGuard(mockReflector({ isPublic: true }), prisma);
    const ok = await guard.canActivate(mockContext({}));
    expect(ok).toBe(true);
    expect(prisma.role.findUnique).not.toHaveBeenCalled();
  });

  it('无 @RequirePermission metadata 放行（向后兼容无装饰器路由）', async () => {
    const guard = new PermissionsGuard(mockReflector({ permissions: undefined }), prisma);
    const ok = await guard.canActivate(mockContext({ user: { id: 'u1' } }));
    expect(ok).toBe(true);
    expect(prisma.role.findUnique).not.toHaveBeenCalled();
  });

  it('空权限数组放行', async () => {
    const guard = new PermissionsGuard(mockReflector({ permissions: [] }), prisma);
    const ok = await guard.canActivate(mockContext({ user: { id: 'u1' } }));
    expect(ok).toBe(true);
  });

  it('缺登录态（无 request.user）拒绝 403', async () => {
    const guard = new PermissionsGuard(mockReflector({ permissions: ['platform.user.list'] }), prisma);
    await expect(guard.canActivate(mockContext({}))).rejects.toMatchObject({ status: 403 });
  });

  it('平台权限命中放行：解析 User.platformRoleId → Role.permissions', async () => {
    const guard = new PermissionsGuard(mockReflector({ permissions: ['platform.user.list'] }), prisma);
    prisma.role.findUnique.mockResolvedValue({ permissions: ['platform.user.list', 'platform.user.create'] });
    const ok = await guard.canActivate(mockContext({ user: { id: 'u1', platformRoleId: 'role-p-1' } }));
    expect(ok).toBe(true);
    expect(prisma.role.findUnique).toHaveBeenCalledWith({ where: { id: 'role-p-1' }, select: { permissions: true } });
  });

  it('平台权限未命中拒绝 403', async () => {
    const guard = new PermissionsGuard(mockReflector({ permissions: ['platform.user.list'] }), prisma);
    prisma.role.findUnique.mockResolvedValue({ permissions: ['platform.team.list'] });
    await expect(
      guard.canActivate(mockContext({ user: { id: 'u1', platformRoleId: 'role-p-1' } })),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('平台 platformRoleId 为 null（无平台角色）时不查角色，拒绝', async () => {
    const guard = new PermissionsGuard(mockReflector({ permissions: ['platform.user.list'] }), prisma);
    // platformRoleId 为 null，guard 的 needPlatform && user.platformRoleId 条件为 false，不查 role
    await expect(
      guard.canActivate(mockContext({ user: { id: 'u1', platformRoleId: null } })),
    ).rejects.toMatchObject({ status: 403 });
    expect(prisma.role.findUnique).not.toHaveBeenCalled();
  });

  it('团队权限命中放行：解析当前 membership.teamRoleId → Role.permissions', async () => {
    const guard = new PermissionsGuard(mockReflector({ permissions: ['team.member.invite'] }), prisma);
    prisma.teamMembership.findFirst.mockResolvedValue({ teamRoleId: 'role-t-1', team: { status: 'ACTIVE' } });
    prisma.role.findUnique.mockResolvedValue({ permissions: ['team.member.invite'] });
    const ok = await guard.canActivate(mockContext({ user: { id: 'u1', platformRoleId: null } }));
    expect(ok).toBe(true);
  });

  it('团队 SUSPENDED 时 teamRoleId 不解析权限，团队权限拒绝', async () => {
    const guard = new PermissionsGuard(mockReflector({ permissions: ['team.member.invite'] }), prisma);
    prisma.teamMembership.findFirst.mockResolvedValue({ teamRoleId: 'role-t-1', team: { status: 'SUSPENDED' } });
    // SUSPENDED 时 guard 不会解析 teamRoleId 权限（与 AuthService.ensureCurrentTeam 同款语义），
    // perms 不含 team.member.invite → hit=false → throw forbidden(403)
    await expect(
      guard.canActivate(mockContext({ user: { id: 'u1', platformRoleId: null } })),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('无团队 membership 时团队权限拒绝', async () => {
    const guard = new PermissionsGuard(mockReflector({ permissions: ['team.member.invite'] }), prisma);
    prisma.teamMembership.findFirst.mockResolvedValue(null);
    await expect(
      guard.canActivate(mockContext({ user: { id: 'u1', platformRoleId: null } })),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('OR 语义：多权限任一命中即放行', async () => {
    const guard = new PermissionsGuard(
      mockReflector({ permissions: ['team.member.invite', 'team.member.remove'] }),
      prisma,
    );
    prisma.teamMembership.findFirst.mockResolvedValue({ teamRoleId: 'role-t-1', team: { status: 'ACTIVE' } });
    prisma.role.findUnique.mockResolvedValue({ permissions: ['team.member.remove'] }); // 只命中 remove
    const ok = await guard.canActivate(mockContext({ user: { id: 'u1', platformRoleId: null } }));
    expect(ok).toBe(true);
  });

  it('混合权限：平台 + 团队，平台命中放行（无需团队解析也放行）', async () => {
    const guard = new PermissionsGuard(
      mockReflector({ permissions: ['platform.user.list', 'team.member.invite'] }),
      prisma,
    );
    // 平台角色命中
    prisma.role.findUnique.mockResolvedValueOnce({ permissions: ['platform.user.list'] });
    // 团队也 mock（虽未命中也不影响，因 OR 语义平台已命中）
    prisma.teamMembership.findFirst.mockResolvedValue({ teamRoleId: 'role-t-1', team: { status: 'ACTIVE' } });
    prisma.role.findUnique.mockResolvedValueOnce({ permissions: [] });
    const ok = await guard.canActivate(mockContext({ user: { id: 'u1', platformRoleId: 'role-p-1' } }));
    expect(ok).toBe(true);
  });

  it('请求级缓存：同一请求多次解析复用（不重复查库）', async () => {
    const guard = new PermissionsGuard(mockReflector({ permissions: ['platform.user.list'] }), prisma);
    prisma.role.findUnique.mockResolvedValue({ permissions: ['platform.user.list'] });
    const request = { user: { id: 'u1', platformRoleId: 'role-p-1' } };
    const ctx = mockContext(request);
    await guard.canActivate(ctx);
    await guard.canActivate(ctx); // 第二次应命中缓存
    // 平台角色查询应只发生一次（缓存命中后不再查）
    expect(prisma.role.findUnique).toHaveBeenCalledTimes(1);
  });
});
