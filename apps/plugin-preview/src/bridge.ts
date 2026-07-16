export const PREVIEW_BRIDGE_SOURCE = `(() => {
  'use strict';
  const params = new URLSearchParams(location.hash.slice(1));
  const sessionId = params.get('session_id') || '';
  const nonce = params.get('nonce') || '';
  try { history.replaceState(null, '', location.pathname + location.search); } catch {}

  const denied = () => false;
  const probe = (fn) => { try { return Boolean(fn()); } catch { return false; } };
  const security = Object.freeze({
    parent_dom_readable: probe(() => parent.document && parent.document.documentElement),
    parent_storage_readable: probe(() => parent.localStorage && parent.localStorage.length >= 0),
    parent_token_readable: probe(() => parent.__LINGFANG_AUTH_TOKEN__),
    own_storage_readable: probe(() => localStorage && localStorage.length >= 0),
    own_cookie_readable: probe(() => document.cookie && document.cookie.length > 0),
  });

  let port = null;
  let sequence = 0;
  const pending = new Map();
  let resolveChannel;
  const channelReady = new Promise((resolve) => { resolveChannel = resolve; });
  const invoke = async (capability, args = {}) => {
    if (!port) await Promise.race([
      channelReady,
      new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('预览消息通道尚未建立'), { code: 'preview_channel_unavailable' })), 10000)),
    ]);
    return new Promise((resolve, reject) => {
    const requestId = String(++sequence);
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(Object.assign(new Error('预览能力调用超时'), { code: 'preview_capability_timeout' }));
    }, 30000);
    pending.set(requestId, { resolve, reject, timer });
    port.postMessage({ type: 'lingfang.preview.capability.v1', request_id: requestId, capability, args });
    });
  };

  const sdk = Object.freeze({
    invoke,
    ui: Object.freeze({
      view: () => invoke('ui.view', {}),
      render: (value) => {
        const node = document.createElement('pre');
        node.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
        document.body.appendChild(node);
      },
    }),
    artifact: Object.freeze({ readPreview: (reference) => invoke('artifact.read.preview', { reference }) }),
  });
  Object.defineProperty(window, 'sdk', { configurable: false, enumerable: true, writable: false, value: sdk });

  addEventListener('message', (event) => {
    const data = event.data;
    if (event.source !== parent || !data || data.type !== 'lingfang.preview.ready.v1' || data.session_id !== sessionId || port || event.ports.length !== 1) return;
    port = event.ports[0];
    resolveChannel();
    port.onmessage = (message) => {
      const payload = message.data || {};
      if (payload.type !== 'lingfang.preview.capability.result.v1' || typeof payload.request_id !== 'string') return;
      const item = pending.get(payload.request_id);
      if (!item) return;
      clearTimeout(item.timer); pending.delete(payload.request_id);
      if (payload.ok) item.resolve(payload.result);
      else item.reject(Object.assign(new Error(payload.error && payload.error.message || '预览能力调用失败'), payload.error || {}));
    };
    port.start();
  });

  parent.postMessage({
    type: 'lingfang.preview.handshake.v1',
    session_id: sessionId,
    nonce,
    security_report: security,
  }, '*');
})();\n`;
