import { describe, expect, it, vi } from 'vitest';
import { WebPreviewSessionService } from './web-preview-session.service';

describe('WebPreviewSessionService', () => {
  it('issues a short nonce once without persisting plaintext', async () => {
    const create = vi.fn(async ({ data }) => ({ id: '11111111-1111-4111-8111-111111111111', ...data }));
    const service = new WebPreviewSessionService(
      { webPreviewSession: { create } } as never,
      { ensureCurrentTeam: vi.fn(async () => ({ teamId: 'team-1' })) } as never,
      { detail: vi.fn(async () => ({ release_id: '22222222-2222-4222-8222-222222222222', release_sha256: 'a'.repeat(64), preview_mode: 'CLIENT_SANDBOX' })) } as never,
    );
    const result = await service.create('user-1', '33333333-3333-4333-8333-333333333333');
    expect(result.channel_nonce.length).toBeGreaterThanOrEqual(32);
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ nonceSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }) });
    expect(JSON.stringify(create.mock.calls[0][0].data)).not.toContain(result.channel_nonce);
  });

  it('rejects static desktop preview without creating a session', async () => {
    const create = vi.fn();
    const service = new WebPreviewSessionService(
      { webPreviewSession: { create } } as never,
      { ensureCurrentTeam: vi.fn(async () => ({ teamId: 'team-1' })) } as never,
      { detail: vi.fn(async () => ({ preview_mode: 'STATIC_DESKTOP' })) } as never,
    );
    await expect(service.create('user-1', 'pkg-1')).rejects.toMatchObject({ code: 'web_preview_unavailable' });
    expect(create).not.toHaveBeenCalled();
  });

  it('atomically consumes a matching nonce and rejects replay', async () => {
    const crypto = await import('node:crypto');
    const nonce = 'n'.repeat(32);
    const row = { id: 'session-1', userId: 'user-1', teamId: 'team-1', mode: 'CLIENT_SANDBOX', nonceSha256: crypto.createHash('sha256').update(nonce).digest('hex'), expiresAt: new Date(Date.now() + 60_000) };
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const service = new WebPreviewSessionService(
      { webPreviewSession: { findFirst: vi.fn(async () => row), updateMany } } as never,
      { ensureCurrentTeam: vi.fn(async () => ({ teamId: 'team-1' })) } as never,
      {} as never,
    );
    await expect(service.consume('user-1', 'session-1', nonce)).resolves.toMatchObject({ ok: true });
    updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.consume('user-1', 'session-1', nonce)).rejects.toMatchObject({ status: 409 });
  });
});
