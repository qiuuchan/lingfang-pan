import { describe, expect, it, vi } from 'vitest';
import { RelayTeamGuard } from './relay-team.guard';

function contextFor(user: Record<string, unknown>) {
  const request = { user } as Record<string, unknown>;
  const context = { switchToHttp: () => ({ getRequest: () => request }) } as never;
  return { context, request };
}

function build(membership: Record<string, unknown> | null) {
  const prisma = { teamMembership: { findUnique: vi.fn(async () => membership) } };
  return { guard: new RelayTeamGuard(prisma as never), prisma };
}

describe('RelayTeamGuard', () => {
  it('binds relayAuth to the exact JWT team and user', async () => {
    const { guard, prisma } = build({ status: 'ACTIVE', team: { status: 'ACTIVE' } });
    const { context, request } = contextFor({ id: 'u1', teamId: 't1' });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(prisma.teamMembership.findUnique).toHaveBeenCalledWith({
      where: { teamId_userId: { teamId: 't1', userId: 'u1' } },
      include: { team: { select: { status: true } } },
    });
    expect(request.relayAuth).toEqual({ teamId: 't1', userId: 'u1' });
  });

  it.each([
    [null, 'missing membership'],
    [{ status: 'REMOVED', team: { status: 'ACTIVE' } }, 'removed membership'],
    [{ status: 'ACTIVE', team: { status: 'SUSPENDED' } }, 'suspended team'],
  ])('rejects %s before relay billing starts (%s)', async (membership) => {
    const { guard } = build(membership as Record<string, unknown> | null);
    const { context, request } = contextFor({ id: 'u1', teamId: 't1' });
    await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 403 });
    expect(request).not.toHaveProperty('relayAuth');
  });

  it('rejects a valid user session without a current team claim', async () => {
    const { guard, prisma } = build(null);
    const { context } = contextFor({ id: 'u1', teamId: null });
    await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 403 });
    expect(prisma.teamMembership.findUnique).not.toHaveBeenCalled();
  });
});
