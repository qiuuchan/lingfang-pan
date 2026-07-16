import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPreviewOriginServer } from './server';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const SERVICE_KEY = 'preview-service-key-32-characters-minimum';
const servers: ReturnType<typeof createPreviewOriginServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('independent plugin preview origin', () => {
  it('serves a CSP-confined entry, injects the bridge, and never forwards browser credentials', async () => {
    const upstream = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('cookie')).toBeNull();
      expect(headers.get('authorization')).toBeNull();
      expect(headers.get('x-lingfang-preview-service-key')).toBe(SERVICE_KEY);
      return new Response('<!doctype html><html><head></head><body><script>window.rendered = true;</script></body></html>', {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'set-cookie': 'should-never-reach-browser=1',
          'x-lingfang-preview-entry': '1',
          'x-lingfang-preview-entry-path': encodeURIComponent('ui/index.html'),
        },
      });
    });
    const origin = await start(upstream);
    const response = await fetch(`${origin}/sessions/${SESSION_ID}/index.html`, { headers: { cookie: 'lingfang_web_session=secret', authorization: 'Bearer secret' } });
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('permissions-policy')).toContain('clipboard-read=()');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('content-security-policy')).toContain("connect-src 'none'");
    expect(response.headers.get('content-security-policy')).toContain('frame-ancestors http://web.example.test');
    expect(response.headers.get('content-security-policy')).toMatch(/script-src 'self' 'sha256-/);
    expect(html).toContain(`<base href="/sessions/${SESSION_ID}/ui/">`);
    expect(html).toContain('<script src="/_lingfang/bridge.js"></script>');
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('rejects encoded path escapes before the internal API is called', async () => {
    const upstream = vi.fn();
    const origin = await start(upstream as never);
    const response = await fetch(`${origin}/sessions/${SESSION_ID}/ui%2F..%2Fsecret.txt`);
    expect(response.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('refuses a deployment that reuses the Web app origin', () => {
    expect(() => createPreviewOriginServer({
      internalOrigin: 'http://api.example.test',
      serviceKey: SERVICE_KEY,
      webAppOrigins: ['https://web.example.test'],
      publicOrigin: 'https://web.example.test',
    })).toThrow(/must differ/);
  });
});

async function start(fetchImplementation: typeof fetch): Promise<string> {
  const server = createPreviewOriginServer({
    internalOrigin: 'http://api.example.test',
    serviceKey: SERVICE_KEY,
    webAppOrigins: ['http://web.example.test'],
    publicOrigin: 'http://preview.example.test',
    fetchImplementation,
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}
