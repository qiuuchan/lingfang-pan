import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareWebSession } from './session';
import { consumeClientPreviewSession, createClientPreviewSession } from './preview-session';

function response(payload: unknown) {
  return Promise.resolve(
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  );
}

describe('Client preview session client', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('creates and consumes the one-time nonce only through the CSRF cookie session', async () => {
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => response({ csrfToken: 'csrf-preview' }))
      .mockImplementationOnce(() =>
        response({
          session_id: '11111111-1111-4111-8111-111111111111',
          release_id: '22222222-2222-4222-8222-222222222222',
          release_sha256: 'a'.repeat(64),
          mode: 'CLIENT_SANDBOX',
          expires_at: '2026-07-16T00:05:00.000Z',
          channel_nonce: 'n'.repeat(32),
        })
      )
      .mockImplementationOnce(() =>
        response({
          ok: true,
          session_id: '11111111-1111-4111-8111-111111111111',
          mode: 'CLIENT_SANDBOX',
        })
      );
    await prepareWebSession(fetcher);
    const session = await createClientPreviewSession(
      '33333333-3333-4333-8333-333333333333',
      fetcher
    );
    await consumeClientPreviewSession(session.session_id, session.channel_nonce, fetcher);
    for (const call of fetcher.mock.calls.slice(1)) {
      const init = call[1] as RequestInit;
      expect(init.credentials).toBe('include');
      expect(new Headers(init.headers).get('authorization')).toBeNull();
      expect(new Headers(init.headers).get('x-csrf-token')).toBe('csrf-preview');
    }
  });
});
