import type { WebPreviewSession } from '@lingfang/contract';
import { describe, expect, it } from 'vitest';
import { buildPreviewIframeUrl, PREVIEW_IFRAME_SANDBOX, previewOrigin } from './ClientSandboxPreview';

const session: WebPreviewSession = {
  session_id: '11111111-1111-4111-8111-111111111111',
  release_id: '22222222-2222-4222-8222-222222222222',
  release_sha256: 'a'.repeat(64),
  mode: 'CLIENT_SANDBOX',
  expires_at: '2026-07-16T00:05:00.000Z',
  channel_nonce: 'n'.repeat(32),
};

describe('Client sandbox iframe boundary', () => {
  it('uses an independent preview origin and keeps the nonce in the URL fragment', () => {
    const result = new URL(buildPreviewIframeUrl('https://preview.example.test', session, 'https://web.example.test'));
    expect(result.origin).toBe('https://preview.example.test');
    expect(result.pathname).toBe(`/sessions/${session.session_id}/index.html`);
    expect(result.search).toBe('');
    expect(result.hash).toContain(`nonce=${session.channel_nonce}`);
  });

  it('refuses same-origin, insecure remote, and credential-bearing preview origins', () => {
    expect(() => buildPreviewIframeUrl('https://web.example.test', session, 'https://web.example.test')).toThrow(/分离/);
    expect(() => previewOrigin('http://preview.example.test')).toThrow(/HTTPS/);
    expect(() => previewOrigin('https://user:pass@preview.example.test')).toThrow(/HTTPS/);
  });

  it('never enables allow-same-origin, forms, popups, or top navigation', () => {
    expect(PREVIEW_IFRAME_SANDBOX.split(/\s+/)).toEqual(['allow-scripts', 'allow-downloads']);
    expect(PREVIEW_IFRAME_SANDBOX).not.toContain('allow-same-origin');
    expect(PREVIEW_IFRAME_SANDBOX).not.toContain('allow-forms');
    expect(PREVIEW_IFRAME_SANDBOX).not.toContain('allow-popups');
    expect(PREVIEW_IFRAME_SANDBOX).not.toContain('top-navigation');
  });
});
