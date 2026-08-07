import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loginWeb, prepareWebSession, switchWebTeam } from './session';

function response(payload: unknown) {
  return Promise.resolve(
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  );
}

describe('Web session client', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('uses credentials cookies and sends CSRF without accepting an auth token', async () => {
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => response({ csrfToken: 'csrf-1' }))
      .mockImplementationOnce(() => response({ user: { id: 'u1' }, team: null }));
    await prepareWebSession(fetcher);
    const session = await loginWeb('user@example.com', 'password', fetcher);
    expect(session).not.toHaveProperty('token');
    const [, init] = fetcher.mock.calls[1];
    expect(init.credentials).toBe('include');
    expect((init.headers as Headers).get('x-csrf-token')).toBe('csrf-1');
  });

  it('uses the same CSRF-protected cookie session for team switching', async () => {
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => response({ csrfToken: 'csrf-2' }))
      .mockImplementationOnce(() =>
        response({ team: { id: '22222222-2222-4222-8222-222222222222' } })
      );
    await prepareWebSession(fetcher);
    await switchWebTeam('22222222-2222-4222-8222-222222222222', fetcher);
    const [, init] = fetcher.mock.calls[1];
    expect((init.headers as Headers).get('authorization')).toBeNull();
    expect((init.headers as Headers).get('x-csrf-token')).toBe('csrf-2');
  });
});
