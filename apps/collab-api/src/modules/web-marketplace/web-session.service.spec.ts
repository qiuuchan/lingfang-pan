import { describe, expect, it, vi } from 'vitest';
import { WebSessionService } from './web-session.service';

describe('WebSessionService', () => {
  it('never returns the JWT to the browser response', async () => {
    const auth = {
      login: vi.fn(async () => ({ token: 'secret-jwt', user: { id: 'u1' }, team: null })),
    };
    const service = new WebSessionService(auth as never, {} as never);
    const result = await service.login('user@example.com', 'password');
    expect(result.token).toBe('secret-jwt');
    expect(result.session).toEqual({ user: { id: 'u1' }, team: null });
    expect(result.session).not.toHaveProperty('token');
  });

  it('lists only active memberships in active teams', async () => {
    const prisma = {
      teamMembership: {
        findMany: vi.fn(async () => [
          { role: 'MEMBER', teamRoleId: 'r1', team: { id: 't1', name: 'Team', slug: 'team' } },
        ]),
      },
    };
    const service = new WebSessionService({} as never, prisma as never);
    await expect(service.teams('u1')).resolves.toEqual({
      teams: [{ id: 't1', name: 'Team', slug: 'team', role: 'MEMBER', teamRoleId: 'r1' }],
    });
    expect(prisma.teamMembership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'u1', status: 'ACTIVE', team: { status: 'ACTIVE' } },
      })
    );
  });

  it('returns a token internally while exposing a token-free switched session', async () => {
    const auth = {
      switchWebTeam: vi.fn(async () => ({
        token: 'new-secret',
        user: { id: 'u1' },
        team: { id: 't2' },
      })),
    };
    const service = new WebSessionService(auth as never, {} as never);
    await expect(service.switchTeam('u1', 't2')).resolves.toEqual({
      token: 'new-secret',
      session: { user: { id: 'u1' }, team: { id: 't2' } },
    });
  });
});
