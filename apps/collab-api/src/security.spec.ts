import { describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { JwtAuthGuard } from './security';

process.env.JWT_SECRET = 'test-secret-for-jwt-team-context-at-least-16-chars';

function contextFor(token: string) {
  const request: Record<string, unknown> & { header: (name: string) => string } = {
    header: (name) => name === 'authorization' ? `Bearer ${token}` : '',
  };
  const context = {
    getHandler: () => 'handler',
    getClass: () => 'class',
    switchToHttp: () => ({ getRequest: () => request }),
  } as never;
  return { context, request };
}

function build(user: Record<string, unknown> | null) {
  const reflector = { getAllAndOverride: vi.fn(() => false) };
  const prisma = { user: { findUnique: vi.fn(async () => user) } };
  return { guard: new JwtAuthGuard(reflector as never, prisma as never), prisma };
}

describe('JwtAuthGuard signed team context', () => {
  it('rejects legacy lf_ bearer values as invalid JWT without a key lookup', async () => {
    const { guard, prisma } = build(null);
    const { context } = contextFor('lf_0123456789abcdef');
    await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('rejects old JWTs that do not carry teamId and teamContextVersion', async () => {
    const token = jwt.sign({ sub: 'u1', email: 'u@example.com', tokenVersion: 1 }, process.env.JWT_SECRET!);
    const { guard, prisma } = build(null);
    const { context } = contextFor(token);
    await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 401 });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a signed token after teamContextVersion changes', async () => {
    const token = jwt.sign({
      sub: 'u1', email: 'u@example.com', tokenVersion: 1, teamId: 't1', teamContextVersion: 2,
    }, process.env.JWT_SECRET!);
    const { guard } = build({
      status: 'ACTIVE', tokenVersion: 1, teamContextVersion: 3, platformRole: 'NONE', platformRoleId: null,
    });
    const { context } = contextFor(token);
    await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 401 });
  });

  it('attaches only the signed team when both versions match', async () => {
    const token = jwt.sign({
      sub: 'u1', email: 'u@example.com', tokenVersion: 1, teamId: 't1', teamContextVersion: 3,
    }, process.env.JWT_SECRET!);
    const { guard } = build({
      status: 'ACTIVE', tokenVersion: 1, teamContextVersion: 3, platformRole: 'NONE', platformRoleId: null,
    });
    const { context, request } = contextFor(token);
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toMatchObject({ id: 'u1', teamId: 't1', teamContextVersion: 3 });
  });
});
