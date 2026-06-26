import { api, tauriInvoke, type ApiError } from '@/lib/api';
import type { LoadedPlugin } from '@/lib/types';
import { setSharedData, getSharedData, listSharedKeys } from '@/lib/plugin-shared-data';
import { requestSystemPermission } from '@/lib/plugin-permissions';
// SDK-06 修复：tokens.css 头注释与 spec（ui-tokens/frontend/tokens.md）均声明「宿主注入到所有插件容器」，
// 但此前 apps/desktop 既未 import 也未在 srcDoc 注入，插件 var(--lf-color-*) 解析为空、设计令牌机制失效。
// 现通过 Vite ?inline 把 tokens.css 内容内联为 <style> 前置到每个插件运行态文档，
// 让插件按文档建议写 var(--lf-color-primary)（即便不加 fallback）也能正确解析。
import tokensCss from '@lingfang/ui-tokens/tokens.css?inline';

// 注入到插件 iframe 文档头部的宿主设计令牌 <style>。SDK-06 修复。
// 注：运行态 iframe 为 opaque origin（RT-01：sandbox 无 allow-same-origin），
// 不继承宿主 .dark 类，故此处仅注入 tokens.css 的 :root 亮色定义；
// 若插件需暗色模式，由插件自行在 .dark 下覆写 --lf-*（与宿主主题解耦）。
function tokensStyles(): string {
  return `<style data-lf-tokens>${tokensCss}</style>`;
}

// 内置插件运行态注入的桥：LingFangBridge.invokeCapability → 本地 Tauri capability 网关。
// RT-05 修复：pending[id] 此前仅在收到 __lf_reply 时删除，父端若因 Runner 卸载 / iframe 重载 /
// contentWindow=null 丢弃响应，则 Promise 永久 pending + 字典条目泄漏。增加 30s 超时兜底：
// 超时后 reject 并 delete pending[id]，避免插件侧 await sdk.invoke(...) 永久挂起。
//
// RT-07 修复：此前判定 m.error ? reject : resolve 基于真值，若某错误路径构造出 error 为空串 ''
// 的回复（falsy），子端会误判成功并 resolve(undefined)。改为基于存在性判定（'error' in m），
// 空 error 回填默认文案，避免吞错当成功。
const RUNTIME_BRIDGE_TIMEOUT_MS = 30_000;
function bridgeShim(pluginId: string): string {
  return `<script>
    (function () {
      let seq = 0; const pending = {};
      window.addEventListener('message', (ev) => {
        const m = ev.data;
        if (m && m.__lf_reply !== undefined && pending[m.id]) {
          const { resolve, reject, timer } = pending[m.id]; delete pending[m.id];
          if (timer) clearTimeout(timer);
          // RT-07：基于存在性判定（'error' in m）而非真值，空串 error 回填默认文案。
          if ('error' in m) reject(new Error(m.error || '操作失败'));
          else resolve(m.result);
        }
      });
      window.LingFangBridge = {
        invokeCapability(kind, args) {
          return window.__lingfangInvoke(kind, args || {});
        },
      };
      window.__lingfangInvoke = function (kind, args) {
        return new Promise((resolve, reject) => {
          const id = ++seq;
          const timer = setTimeout(() => {
            if (pending[id]) { delete pending[id]; reject(new Error('父端响应超时')); }
          }, ${RUNTIME_BRIDGE_TIMEOUT_MS});
          pending[id] = { resolve, reject, timer };
          parent.postMessage({ __lf_call: true, id, pluginId: ${JSON.stringify(pluginId)}, kind, args }, '*');
        });
      };
      window.sdk = {
        invoke: (cap, args) => window.__lingfangInvoke(cap, args || {}),
        llm: { chat: (input) => window.__lingfangInvoke('llm.chat', input || {}) },
        image: { generate: (input) => window.__lingfangInvoke('image.generate', input || {}) },
        net: { fetch: (input) => window.__lingfangInvoke('net.fetch', input || {}) },
        storage: {
          get: (key) => window.__lingfangInvoke('storage.kv', { op: 'get', key }),
          set: (key, value) => window.__lingfangInvoke('storage.kv', { op: 'set', key, value }),
        },
        system: {
          info: () => window.__lingfangInvoke('system.info', {}),
          notify: (title, body) => window.__lingfangInvoke('system.notify', { title, body }),
          requestPermission: (code, reason) => window.__lingfangInvoke('system.requestPermission', { code, reason }),
        },
        ui: { render: (c) => { document.body.insertAdjacentHTML('beforeend', '<pre>' + (typeof c === 'string' ? c : JSON.stringify(c, null, 2)) + '</pre>'); } },
      };
    })();
  <\/script>`;
}

// 数据库插件（已发布/已安装）运行态注入的 sdk shim。
// RT-05 修复：与 bridgeShim 同款，sdkShim 的 pending[id] 也加 30s 超时兜底。
// RT-07 修复：同款基于存在性判定（'error' in m），空串 error 回填默认文案。
function sdkShim(pluginId: string): string {
  return `<script>
    (function () {
      let seq = 0; const pending = {};
      window.addEventListener('message', (ev) => {
        const m = ev.data;
        if (m && m.__lf_reply !== undefined && pending[m.id]) {
          const { resolve, reject, timer } = pending[m.id]; delete pending[m.id];
          if (timer) clearTimeout(timer);
          if ('error' in m) reject(new Error(m.error || '操作失败'));
          else resolve(m.result);
        }
      });
      function call(kind, args) {
        return new Promise((resolve, reject) => {
          const id = ++seq;
          const timer = setTimeout(() => {
            if (pending[id]) { delete pending[id]; reject(new Error('父端响应超时')); }
          }, ${RUNTIME_BRIDGE_TIMEOUT_MS});
          pending[id] = { resolve, reject, timer };
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
        image: { generate: (input) => call('image.generate', input || {}) },
        plugin: {
          upload: (input) => call('plugin.upload', input || {}),
          submitMarketplace: (input) => call('plugin.submitMarketplace', input || {}),
          // Task 5 插件间数据互通：A 写共享数据（如登录凭证），B 按 A 的 id + key 读取。
          setSharedData: (key, value) => call('plugin.setSharedData', { key, value }),
          getSharedData: (sourcePluginId, key) => call('plugin.getSharedData', { sourcePluginId, key }),
          listSharedKeys: () => call('plugin.listSharedKeys', {}),
        },
        // Task 14 系统级权限请求：插件请求系统权限，宿主弹用户确认框（授权结果记忆）。
        system: {
          requestPermission: (code, reason) => call('system.requestPermission', { code, reason }),
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

function declaresCapability(plugin: LoadedPlugin, kind: string): boolean {
  return (plugin.capabilities ?? []).some((capability) => {
    if (typeof capability === 'string') return capability === kind;
    return capability?.kind === kind;
  });
}

function requireCapability(plugin: LoadedPlugin, kind: string): void {
  if (!declaresCapability(plugin, kind)) throw new Error(`插件未声明能力: ${kind}`);
}

export async function loadPluginDocument(plugin: LoadedPlugin): Promise<string> {
  // SDK-06：tokensStyles() 前置到 shim 之前，使 --lf-* 变量在插件文档加载时即可用。
  // 顺序：tokens 样式 → 桥 shim → 插件 HTML（这样插件若自己定义 --lf-* 仍可覆盖宿主默认）。
  if (isBuiltinPlugin(plugin)) {
    const html = await tauriInvoke<string>('read_plugin_file', {
      pluginId: plugin.id,
      file: plugin.entry,
    });
    return tokensStyles() + bridgeShim(plugin.id) + html;
  }
  const packaged = pluginFileContent(plugin);
  if (packaged !== null) return tokensStyles() + sdkShim(plugin.id) + packaged;
  // collab-api 的 publicPlugin 始终内联 files，缺失即视为异常数据；不再回退到已下线的
  // Rust /plugins/:id/files/* 路由（collab-api 无对应能力），改返回占位 HTML。
  return tokensStyles() + sdkShim(plugin.id) + `<!doctype html><html><body style="font-family:system-ui;margin:24px"><h1>${plugin.name}</h1><p>${plugin.description || '插件内容暂不可用。'}</p></body></html>`;
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
  // DESK-PLUGINS-01 修复 + null 安全：
  // 1) loadPlugins 用 Promise.allSettled 永不 reject（allSettled 把 reject 转 fulfilled=[]），
  //    故 Plugins.tsx 初始加载的外层 try/catch 是死代码——但保留也无害；关键修复在 errorMessage 自身的 null 安全。
  // 2) 此前 (error as ApiError).message 在 error 为 null/undefined 时返回 'null'/'undefined' 而非真实消息，
  //    Promise.allSettled 的 reject reason 可能是 null/undefined（极罕见但可达），此时 .message 是 'undefined'
  //    会被展示给用户。此处加 null 守卫，对 null/undefined 给友好兜底文案。
  if (error == null) return '未知错误';
  if (error instanceof Error) return error.message;
  const apiMsg = (error as ApiError).message;
  if (typeof apiMsg === 'string' && apiMsg.length > 0) return apiMsg;
  return String(error);
}

async function invokeRuntime(plugin: LoadedPlugin, kind: string, args: RuntimeMessage['args']) {
  // Task 5：插件间数据互通（共享存储）。两类插件共用前端 localStorage 存储，pluginId 取自宿主侧
  // RuntimeMessage.pluginId（不由调用方自报，防 B 冒充 A 写入）。读取需显式传 sourcePluginId。
  if (kind === 'plugin.setSharedData') {
    return setSharedData(plugin.id, String(args?.key ?? ''), args?.value);
  }
  if (kind === 'plugin.getSharedData') {
    return getSharedData(String(args?.sourcePluginId ?? ''), String(args?.key ?? ''));
  }
  if (kind === 'plugin.listSharedKeys') {
    return listSharedKeys(plugin.id);
  }
  // storage.kv：HTML/client 插件的轻量本地存储。按插件隔离，避免不同插件 key 冲突。
  if (kind === 'storage.kv') {
    const op = String(args?.op ?? '');
    const key = String(args?.key ?? '');
    if (!key) throw new Error('storage.kv 缺少 key');
    const storageKey = `lf:plugin-storage:${plugin.id}:${key}`;
    if (op === 'get') {
      const raw = localStorage.getItem(storageKey);
      return raw ? JSON.parse(raw) : null;
    }
    if (op === 'set') {
      localStorage.setItem(storageKey, JSON.stringify(args?.value));
      return undefined;
    }
    throw new Error(`storage.kv 不支持的操作：${op}`);
  }
  if (kind === 'system.notify') {
    const title = String(args?.title ?? '灵坊插件');
    const body = args?.body == null ? undefined : String(args.body);
    try {
      if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body });
    } catch { /* 浏览器通知不可用时静默降级 */ }
    return undefined;
  }
  // Task 14：系统级权限运行时授权。插件调 sdk.system.requestPermission → 弹确认框（记忆决策）。
  if (kind === 'system.requestPermission') {
    return requestSystemPermission(
      plugin.id,
      plugin.name,
      String(args?.code ?? ''),
      String(args?.reason ?? ''),
    );
  }
  if (kind === 'llm.chat') {
    requireCapability(plugin, 'llm.chat');
    // 计费/中转：llm.chat 走平台 relay（/api/relay/v1/chat/completions），用当前登录态 JWT 鉴权，
    // 消费扣团队灵石。relay 据前台版本哨兵（fast/premium）解析真实模型并注入系统提示词规则。
    // 契约：input = { messages, model?: 'fast'|'premium', stream? }。非流式聚合为字符串返回（兼容 sdk.llm.chat 的 Promise<string>）。
    const input = (args || {}) as { messages?: { role: string; content: string }[]; model?: string; stream?: boolean };
    const messages = Array.isArray(input.messages) ? input.messages : [];
    if (messages.length === 0) throw new Error('llm.chat 缺少 messages');
    const tier = input.model === 'premium' ? 'premium' : 'fast';
    const res = await api<{ choices?: { message?: { content?: string } }[]; content?: string }>(
      '/api/relay/v1/chat/completions',
      { method: 'POST', body: { model: tier, messages, stream: false } },
    );
    // OpenAI 形状：choices[0].message.content；兜底 content 字段。
    return res.choices?.[0]?.message?.content ?? res.content ?? '';
  }
  if (kind === 'image.generate') {
    requireCapability(plugin, 'image.generate');
    // 计费/中转：生图走 relay（/api/relay/v1/images/generations），按张计费。
    // 契约：input = { prompt, model?: 'fast'|'premium', size?, n? }。返回 { images: string[] }（url 或 base64）。
    const input = (args || {}) as { prompt: string; model?: string; size?: string; n?: number };
    const tier = input.model === 'premium' ? 'premium' : 'fast';
    const res = await api<{ data?: { url?: string; b64_json?: string }[] }>(
      '/api/relay/v1/images/generations',
      { method: 'POST', body: { model: tier, prompt: input.prompt, n: input.n ?? 1, size: input.size } },
    );
    const images = (res.data ?? []).map((d) => d.url ?? (d.b64_json ? `data:image/png;base64,${d.b64_json}` : '')).filter(Boolean);
    return { images };
  }
  if (isBuiltinPlugin(plugin)) {
    // code-assistant CLI 已删除（AI 能力走 relay）；builtin 插件如需 AI 用 sdk.llm.chat/image.generate。
    // R5 net.fetch：内置插件网络请求走 Rust plugin_net_fetch（绕 webview CORS）。
    // 仅 manifest 声明了 net.fetch 的插件可用（Rust 侧二次校验）。返回 { status, headers, body }。
    if (kind === 'net.fetch') {
      return tauriInvoke('plugin_net_fetch', { pluginId: plugin.id, args: args || {} });
    }
    return tauriInvoke('invoke_capability', { pluginId: plugin.id, kind, args: args || {} });
  }
  if (kind === 'plugin.upload') {
    return api('/api/plugins/upload', { method: 'POST', body: args || {} });
  }
  if (kind === 'plugin.submitMarketplace') {
    const pluginId = String(args?.pluginId || plugin.id);
    return api(`/api/plugins/${pluginId}/submit-marketplace`, { method: 'POST', body: { priceCents: args?.priceCents } });
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
