import { api, tauriInvoke, type ApiError } from '@/lib/api';
import type { LoadedPlugin } from '@/lib/types';

// 内置插件运行态注入的桥：LingFangBridge.invokeCapability → 本地 Tauri capability 网关。
function bridgeShim(pluginId: string): string {
  return `<script>
    (function () {
      let seq = 0; const pending = {};
      window.addEventListener('message', (ev) => {
        const m = ev.data;
        if (m && m.__lf_reply !== undefined && pending[m.id]) {
          const { resolve, reject } = pending[m.id]; delete pending[m.id];
          m.error ? reject(new Error(m.error)) : resolve(m.result);
        }
      });
      window.LingFangBridge = {
        invokeCapability(kind, args) {
          return window.__lingfangInvoke(kind, args || {});
        },
      };
      window.__lingfangInvoke = function (kind, args) {
        return new Promise((resolve, reject) => {
          const id = ++seq; pending[id] = { resolve, reject };
          parent.postMessage({ __lf_call: true, id, pluginId: ${JSON.stringify(pluginId)}, kind, args }, '*');
        });
      };
    })();
  <\/script>`;
}

// 数据库插件（已发布/已安装）运行态注入的 sdk shim。
function sdkShim(pluginId: string): string {
  return `<script>
    (function () {
      let seq = 0; const pending = {};
      window.addEventListener('message', (ev) => {
        const m = ev.data;
        if (m && m.__lf_reply !== undefined && pending[m.id]) {
          const { resolve, reject } = pending[m.id]; delete pending[m.id];
          m.error ? reject(new Error(m.error)) : resolve(m.result);
        }
      });
      function call(kind, args) {
        return new Promise((resolve, reject) => {
          const id = ++seq; pending[id] = { resolve, reject };
          parent.postMessage({ __lf_call: true, id, pluginId: ${JSON.stringify(pluginId)}, kind, args }, '*');
        });
      }
      window.__lingfangInvoke = (cap, args) => call(cap, args || {});
      window.sdk = {
        invoke: (cap, args) => call(cap, args || {}),
        fs: {
          pick: () => Promise.reject(new Error('文件能力需将插件作为内置插件分发')),
          read: () => Promise.reject(new Error('文件能力需将插件作为内置插件分发')),
        },
        llm: { chat: (input) => call('llm.chat', input || {}) },
        codeAssistant: {
          check: (input) => call('code-assistant.session', Object.assign({ op: 'check' }, input || {})),
          run: (input) => call('code-assistant.run', input || {}),
          stop: (sessionId) => call('code-assistant.session', { op: 'stop', sessionId }),
        },
        plugin: {
          upload: (input) => call('plugin.upload', input || {}),
          submitMarketplace: (input) => call('plugin.submitMarketplace', input || {}),
        },
        ui: { render: (c) => { document.body.insertAdjacentHTML('beforeend', '<pre>' + (typeof c === 'string' ? c : JSON.stringify(c, null, 2)) + '</pre>'); } },
      };
    })();
  <\/script>`;
}

function isBuiltinPlugin(plugin: LoadedPlugin): boolean {
  return plugin.source === 'builtin' || Boolean(plugin.builtin);
}

function pluginFileContent(plugin: LoadedPlugin): string | null {
  const file = plugin.files?.find((item) => item.path === plugin.entry);
  return typeof file?.content === 'string' ? file.content : null;
}

export async function loadPluginDocument(plugin: LoadedPlugin): Promise<string> {
  if (isBuiltinPlugin(plugin)) {
    const html = await tauriInvoke<string>('read_plugin_file', {
      pluginId: plugin.id,
      file: plugin.entry,
    });
    return bridgeShim(plugin.id) + html;
  }
  const packaged = pluginFileContent(plugin);
  if (packaged !== null) return sdkShim(plugin.id) + packaged;
  // collab-api 的 publicPlugin 始终内联 files，缺失即视为异常数据；不再回退到已下线的
  // Rust /plugins/:id/files/* 路由（collab-api 无对应能力），改返回占位 HTML。
  return sdkShim(plugin.id) + `<!doctype html><html><body style="font-family:system-ui;margin:24px"><h1>${plugin.name}</h1><p>${plugin.description || '插件内容暂不可用。'}</p></body></html>`;
}

export type RuntimeMessage = {
  __lf_call?: unknown;
  id?: unknown;
  kind?: string;
  args?: { messages?: unknown; model?: unknown; [key: string]: unknown };
};

export function runtimeMessage(data: unknown): RuntimeMessage | null {
  if (!data || typeof data !== 'object') return null;
  const message = data as RuntimeMessage;
  if (!message.__lf_call || typeof message.kind !== 'string') return null;
  return message;
}

export function errorMessage(error: unknown): string {
  return (error as ApiError).message || (error instanceof Error ? error.message : String(error));
}

async function invokeRuntime(plugin: LoadedPlugin, kind: string, args: RuntimeMessage['args']) {
  if (isBuiltinPlugin(plugin)) {
    if (kind === 'code-assistant.session') {
      if (args?.op === 'check') return tauriInvoke('code_assistant_list_tools');
      if (args?.op === 'stop') return tauriInvoke('code_assistant_stop_session', { input: { session_id: args.sessionId } });
    }
    if (kind === 'code-assistant.run') return tauriInvoke('code_assistant_start_session', { input: args || {} });
    return tauriInvoke('invoke_capability', { pluginId: plugin.id, kind, args: args || {} });
  }
  if (kind === 'llm.chat') {
    throw new Error('本地运行时不支持 llm.chat 云端能力，请使用 code-assistant 本地代码助手。');
  }
  if (kind === 'plugin.upload') {
    return api('/api/plugins/upload', { method: 'POST', body: args || {} });
  }
  if (kind === 'plugin.submitMarketplace') {
    const pluginId = String(args?.pluginId || plugin.id);
    return api(`/api/plugins/${pluginId}/submit-marketplace`, { method: 'POST', body: { priceCents: args?.priceCents } });
  }
  if (kind === 'code-assistant.run' || kind === 'code-assistant.session') {
    throw new Error('云端/平台插件默认不能调用本地代码助手能力，请使用内置可信插件或完成团队管理员授权。');
  }
  throw new Error(`运行态暂不支持的能力：${kind}`);
}

export async function handleRuntimeCall(
  plugin: LoadedPlugin,
  frame: HTMLIFrameElement,
  message: RuntimeMessage,
) {
  try {
    const result = await invokeRuntime(plugin, message.kind ?? '', message.args);
    frame.contentWindow?.postMessage({ __lf_reply: true, id: message.id, result }, '*');
  } catch (error) {
    frame.contentWindow?.postMessage({ __lf_reply: true, id: message.id, error: errorMessage(error) }, '*');
  }
}

function mergePlugins(builtin: LoadedPlugin[], db: LoadedPlugin[]): LoadedPlugin[] {
  const builtinTagged = builtin.map((plugin) => ({ ...plugin, source: 'builtin' as const }));
  const seen = new Set(builtinTagged.map((plugin) => plugin.id));
  return [...builtinTagged, ...db.filter((plugin) => !seen.has(plugin.id))];
}

export async function loadPlugins(): Promise<{ plugins: LoadedPlugin[]; error: string }> {
  const [builtin, db] = await Promise.allSettled([
    tauriInvoke<LoadedPlugin[]>('list_plugins'),
    api<{ plugins: LoadedPlugin[] }>('/api/plugins/available').then((result) => result.plugins.map((plugin) => ({ ...plugin, version: plugin.version || '1.0.0', entry: plugin.entry || 'ui/index.html', source: plugin.source || 'platform' as const }))),
  ]);
  const builtinPlugins = builtin.status === 'fulfilled' ? builtin.value : [];
  const dbPlugins = db.status === 'fulfilled' ? db.value : [];
  const errors = [
    builtin.status === 'rejected' ? `内置插件加载失败：${errorMessage(builtin.reason)}` : '',
    db.status === 'rejected' ? `数据库插件加载失败：${errorMessage(db.reason)}` : '',
  ].filter(Boolean);
  return { plugins: mergePlugins(builtinPlugins, dbPlugins), error: errors.join('；') };
}
