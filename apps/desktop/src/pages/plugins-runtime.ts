import { api, tauriInvoke, type ApiError } from '@/lib/api';
import type { LoadedPlugin } from '@/lib/types';
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
  if (isBuiltinPlugin(plugin)) {
    if (kind === 'code-assistant.session') {
      // RT-08 修复：op 既非 'check' 也非 'stop' 时此前静默落到末尾 invoke_capability，
      // capability.rs 只识别 fs.read/system.info，其它 kind 返回 NotDeclared('code-assistant.session')，
      // 用户看到的是与真实原因（op 非法）无关的错误信息。此处显式抛描述性错误。
      if (args?.op === 'check') {
        return [
          { tool: 'claude', display_name: 'ClaudeCode', available: true },
          { tool: 'codex', display_name: 'Codex', available: true },
        ];
      }
      if (args?.op === 'stop') return tauriInvoke('code_assistant_stop_session', { input: { session_id: args.sessionId } });
      throw new Error(`code-assistant.session 需要 op='check' 或 'stop'，收到：${args?.op ?? String(args?.op)}`);
    }
    if (kind === 'code-assistant.run') return tauriInvoke('code_assistant_start_session', { input: args || {} });
    // R5 net.fetch：内置插件网络请求走 Rust plugin_net_fetch（绕 webview CORS）。
    // 仅 manifest 声明了 net.fetch 的插件可用（Rust 侧二次校验）。返回 { status, headers, body }。
    if (kind === 'net.fetch') {
      return tauriInvoke('plugin_net_fetch', { pluginId: plugin.id, args: args || {} });
    }
    return tauriInvoke('invoke_capability', { pluginId: plugin.id, kind, args: args || {} });
  }
  if (kind === 'llm.chat') {
    // RT-03 修复（部分）：ADR-0002 承诺的 /api/llm/proxy 路由在 collab-api 尚未实现，
    // 数据库插件的 llm.chat 在本地运行态恒失败。此前错误消息「请使用 code-assistant 本地代码助手」
    // 未说明根因是后端 proxy 路由缺失，给插件作者造成误导。改为说明契约缺口，引导改用 code-assistant.run。
    // sdkShim 仍无条件暴露 sdk.llm.chat（与 SDK 契约一致，不破坏既有插件 API），
    // 调用时由运行态 reject 给出清晰信号。
    throw new Error('本地运行时暂不支持 llm.chat 云端能力（/api/llm/proxy 路由未实现），请改用 code-assistant.run 本地代码助手。');
  }
  if (kind === 'plugin.upload') {
    return api('/api/plugins/upload', { method: 'POST', body: args || {} });
  }
  if (kind === 'plugin.submitMarketplace') {
    const pluginId = String(args?.pluginId || plugin.id);
    return api(`/api/plugins/${pluginId}/submit-marketplace`, { method: 'POST', body: { priceCents: args?.priceCents } });
  }
  if (kind === 'code-assistant.run' || kind === 'code-assistant.session') {
    // RT-03：错误消息此前声称「完成团队管理员授权」可解锁，但代码无此授权路径。改为说明根因。
    throw new Error('云端/平台插件默认不能调用本地代码助手能力，仅内置可信插件可用。');
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
