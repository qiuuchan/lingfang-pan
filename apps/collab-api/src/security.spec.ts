import { describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { JwtAuthGuard } from './security';

process.env.JWT_SECRET = 'test-secret-for-jwt-team-context-at-least-16-chars';

function contextFor(token: string) {
  const request: Record<string, unknown> & { header: (name: string) => string } = {
    header: (name) => (name === 'authorization' ? `Bearer ${token}` : ''),
  };
  const context = {
    getHandler: () => 'handler',
    getClass: () => 'class',
    switchToHttp: () => ({ getRequest: () => request }),
  } as never;
  return { context, request };
}

function cookieContext(
  token: string,
  options: { path?: string; method?: string; csrf?: string } = {}
) {
  const csrf = options.csrf ?? '';
  const request: Record<string, unknown> & { header: (name: string) => string } = {
    path: options.path ?? '/web/session',
    method: options.method ?? 'GET',
    header: (name) =>
      name === 'cookie'
        ? `lingfang_web_session=${encodeURIComponent(token)}; lingfang_web_csrf=${encodeURIComponent(csrf)}`
        : name === 'x-csrf-token'
          ? csrf
          : '',
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
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      status: 401,
      code: 'unauthorized',
    });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('rejects old JWTs that do not carry teamId and teamContextVersion', async () => {
    const token = jwt.sign(
      { sub: 'u1', email: 'u@example.com', tokenVersion: 1 },
      process.env.JWT_SECRET!
    );
    const { guard, prisma } = build(null);
    const { context } = contextFor(token);
    await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 401 });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a signed token after teamContextVersion changes', async () => {
    const token = jwt.sign(
      {
        sub: 'u1',
        email: 'u@example.com',
        tokenVersion: 1,
        teamId: 't1',
        teamContextVersion: 2,
      },
      process.env.JWT_SECRET!
    );
    const { guard } = build({
      status: 'ACTIVE',
      tokenVersion: 1,
      teamContextVersion: 3,
      platformRole: 'NONE',
      platformRoleId: null,
    });
    const { context } = contextFor(token);
    await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 401 });
  });

  it('attaches only the signed team when both versions match', async () => {
    const token = jwt.sign(
      {
        sub: 'u1',
        email: 'u@example.com',
        tokenVersion: 1,
        teamId: 't1',
        teamContextVersion: 3,
      },
      process.env.JWT_SECRET!
    );
    const { guard } = build({
      status: 'ACTIVE',
      tokenVersion: 1,
      teamContextVersion: 3,
      platformRole: 'NONE',
      platformRoleId: null,
    });
    const { context, request } = contextFor(token);
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toMatchObject({ id: 'u1', teamId: 't1', teamContextVersion: 3 });
  });

  it('accepts HttpOnly-style cookie authentication only on the web API boundary', async () => {
    const token = jwt.sign(
      { sub: 'u1', email: 'u@example.com', tokenVersion: 1, teamId: 't1', teamContextVersion: 3 },
      process.env.JWT_SECRET!
    );
    const { guard } = build({
      status: 'ACTIVE',
      tokenVersion: 1,
      teamContextVersion: 3,
      platformRole: 'NONE',
      platformRoleId: null,
    });
    const web = cookieContext(token);
    await expect(guard.canActivate(web.context)).resolves.toBe(true);
    expect(web.request.user).toMatchObject({ id: 'u1', teamId: 't1' });
    const admin = cookieContext(token, { path: '/admin/users' });
    await expect(guard.canActivate(admin.context)).rejects.toMatchObject({ status: 401 });
  });

  it('requires a matching CSRF header for cookie-authenticated Web mutations', async () => {
    const token = jwt.sign(
      { sub: 'u1', email: 'u@example.com', tokenVersion: 1, teamId: 't1', teamContextVersion: 3 },
      process.env.JWT_SECRET!
    );
    const { guard } = build({
      status: 'ACTIVE',
      tokenVersion: 1,
      teamContextVersion: 3,
      platformRole: 'NONE',
      platformRoleId: null,
    });
    const missing = cookieContext(token, { method: 'POST' });
    await expect(guard.canActivate(missing.context)).rejects.toMatchObject({
      status: 403,
      code: 'csrf_invalid',
    });
    const valid = cookieContext(token, { method: 'POST', csrf: 'csrf-token-123' });
    await expect(guard.canActivate(valid.context)).resolves.toBe(true);
  });
});
