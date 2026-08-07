import { expect, test } from '@playwright/test';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPreviewOriginServer } from '../src/server';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const NONCE = 'n'.repeat(32);
const SERVICE_KEY = 'preview-service-key-32-characters-minimum';

test('opaque preview cannot read parent DOM/storage/token and rejects every invalid handshake shape', async ({
  page,
  context,
}) => {
  let previewOrigin = '';
  const parent = parentServer(() => previewOrigin);
  const parentOrigin = await listen(parent, 'localhost');
  const preview = createPreviewOriginServer({
    internalOrigin: 'http://api.internal.test',
    serviceKey: SERVICE_KEY,
    webAppOrigins: [parentOrigin],
    fetchImplementation: async () =>
      new Response(
        `<!doctype html><html><head><title>Preview</title></head><body><main id="content">真实预览内容</main><script>
      addEventListener('load', async () => {
        try {
          const view = await sdk.ui.view();
          parent.postMessage({ type: 'plugin.preview.result', ok: true, view }, '*');
        } catch (error) {
          parent.postMessage({ type: 'plugin.preview.result', ok: false, code: error && error.code }, '*');
        }
      });
    </script></body></html>`,
        {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'x-lingfang-preview-entry': '1',
            'x-lingfang-preview-entry-path': encodeURIComponent('ui/index.html'),
          },
        }
      ),
  });
  previewOrigin = await listen(preview, '127.0.0.1');

  try {
    await context.addCookies([
      { name: 'lingfang_web_session', value: 'top-secret-cookie', url: parentOrigin },
    ]);
    const previewRequests: Array<Record<string, string>> = [];
    page.on('request', async (request) => {
      if (request.url().startsWith(previewOrigin)) previewRequests.push(await request.allHeaders());
    });
    await page.goto(parentOrigin);
    await expect.poll(() => page.evaluate(() => (window as any).__previewState?.ready)).toBe(true);
    const state = await page.evaluate(() => (window as any).__previewState);
    expect(state.origin).toBe('null');
    expect(state.accepted).toBe(1);
    expect(state.security).toEqual({
      parent_dom_readable: false,
      parent_storage_readable: false,
      parent_token_readable: false,
      own_storage_readable: false,
      own_cookie_readable: false,
    });
    expect(state.pluginResult).toMatchObject({ ok: true });
    expect(previewRequests.length).toBeGreaterThan(0);
    for (const headers of previewRequests) expect(headers.cookie).toBeUndefined();

    const sandbox = await page.locator('iframe').getAttribute('sandbox');
    expect(sandbox).toBe('allow-scripts allow-downloads');
    expect(sandbox).not.toContain('allow-same-origin');

    const negative = await page.evaluate(() => {
      const frame = document.querySelector('iframe')!;
      const state = (window as any).__previewState;
      const data = state.initialHandshake;
      const dispatch = (
        origin: string,
        source: MessageEventSource | null,
        override: Record<string, unknown> = {}
      ) => {
        window.dispatchEvent(
          new MessageEvent('message', { origin, source, data: { ...data, ...override } })
        );
      };
      dispatch('https://preview.example.test', frame.contentWindow, {});
      dispatch('null', window, {});
      dispatch('null', frame.contentWindow, { session_id: 'wrong-session' });
      dispatch('null', frame.contentWindow, { nonce: 'wrong-nonce' });
      dispatch('null', frame.contentWindow, {});
      return { accepted: state.accepted, rejected: state.rejected };
    });
    expect(negative).toEqual({ accepted: 1, rejected: 5 });
  } finally {
    await close(parent);
    await close(preview);
  }
});

function parentServer(previewOrigin: () => string): Server {
  return createServer((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><html><body><iframe sandbox="allow-scripts allow-downloads" src="${previewOrigin()}/sessions/${SESSION_ID}/index.html#session_id=${SESSION_ID}&nonce=${NONCE}"></iframe><script>
      window.__LINGFANG_AUTH_TOKEN__ = 'top-secret-token';
      localStorage.setItem('lingfang-session', 'top-secret-storage');
      window.__previewState = { accepted: 0, rejected: 0, ready: false, security: null, pluginResult: null, initialHandshake: null };
      const frame = document.querySelector('iframe');
      addEventListener('message', (event) => {
        const data = event.data || {};
        if (data.type === 'plugin.preview.result') { window.__previewState.pluginResult = data; return; }
        if (data.type !== 'lingfang.preview.handshake.v1') return;
        const state = window.__previewState;
        const safe = data.security_report && Object.values(data.security_report).every((value) => value === false);
        const valid = !state.ready && event.origin === 'null' && event.source === frame.contentWindow && data.session_id === '${SESSION_ID}' && data.nonce === '${NONCE}' && safe;
        if (!valid) { state.rejected += 1; return; }
        state.accepted += 1; state.origin = event.origin; state.security = data.security_report; state.initialHandshake = data;
        const channel = new MessageChannel();
        channel.port1.onmessage = (message) => {
          const request = message.data || {};
          if (request.capability === 'ui.view') channel.port1.postMessage({ type: 'lingfang.preview.capability.result.v1', request_id: request.request_id, ok: true, result: { width: frame.clientWidth, height: frame.clientHeight } });
          else channel.port1.postMessage({ type: 'lingfang.preview.capability.result.v1', request_id: request.request_id, ok: false, error: { code: 'preview_capability_denied', message: 'denied' } });
        };
        channel.port1.start();
        event.source.postMessage({ type: 'lingfang.preview.ready.v1', session_id: '${SESSION_ID}' }, '*', [channel.port2]);
        state.ready = true;
      });
    </script></body></html>`);
  });
}

async function listen(server: Server, host: string): Promise<string> {
  server.listen(0, host);
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return `http://${host}:${address.port}`;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
