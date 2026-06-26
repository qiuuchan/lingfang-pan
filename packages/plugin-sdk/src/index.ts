// @lingfang/plugin-sdk：插件作者用的类型化能力客户端（见 docs/02 §B-5）。
// 插件不直连网络、不持 LLM key——所有越权操作经宿主注入的桥 __lingfangInvoke，
// 由壳的 capability 网关三重校验后执行。

import type { CapabilityKind } from '@lingfang/contract';

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };
type ChatInput = { messages: ChatMessage[]; model?: 'fast' | 'premium' };
type ImageGenerateInput = { prompt: string; model?: 'fast' | 'premium'; size?: string; n?: number };
type ImageGenerateResult = { images: string[] };
type PluginFile = { path: string; content: string };
type PluginUploadInput = { manifest: unknown; files: PluginFile[]; priceCents?: number };
type PluginSubmitMarketplaceInput = { pluginId: string; priceCents?: number };

// SDK-04 修复：桥层调用默认 30s 超时，避免宿主不回复（容器卸载、后端 hang 等）时插件 await 永久挂起。
// 超时后 reject 友好错误。宿主若已自带超时（如桌面 plugins-runtime.ts 的 30s）则两者取先到者。
const DEFAULT_BRIDGE_TIMEOUT_MS = 30_000;

// SDK-05 修复：net.fetch 的 init 可能含 AbortSignal / 函数等不可结构化克隆字段，
// postMessage 会抛 DataCloneError。这里白名单过滤为可序列化字段。
type SerializableFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  mode?: string;
  credentials?: string;
};

function sanitizeFetchInit(init: unknown): SerializableFetchInit {
  if (!init || typeof init !== 'object') return {};
  const raw = init as Record<string, unknown>;
  const out: SerializableFetchInit = {};
  if (typeof raw.method === 'string') out.method = raw.method;
  if (raw.headers && typeof raw.headers === 'object') {
    // 仅保留字符串值的 headers（键值对），丢弃非字符串。
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.headers as Record<string, unknown>)) {
      if (typeof v === 'string') headers[k] = v;
    }
    out.headers = headers;
  }
  if (typeof raw.body === 'string') out.body = raw.body;
  if (typeof raw.mode === 'string') out.mode = raw.mode;
  if (typeof raw.credentials === 'string') out.credentials = raw.credentials;
  return out;
}

// SDK-05 修复：storage.set / ui.render 等入参若不可序列化，应给出业务友好错误而非裸 DataCloneError。
// 此函数用于抛出可读错误；实际序列化失败由 postMessage 路径兜底，但提前预检能给更清晰的码。
function assertSerializable(value: unknown, label: string): void {
  try {
    // 用 JSON.stringify 探测是否可序列化（注意：JSON.stringify 对函数/undefined 会丢弃而非抛错，
    // 但对循环引用会抛 TypeError）。这里主要防循环引用；函数字段已在 sanitize 阶段过滤。
    JSON.stringify(value);
  } catch (e) {
    throw new Error(`${label} 包含不可序列化的值（如循环引用），无法传递给宿主：${(e as Error).message}`);
  }
}

type ScriptBridgeEnv = {
  process?: { env?: Record<string, string | undefined> };
  fetch?: typeof fetch;
};

async function invokeScriptBridge<T>(capability: string, args: unknown): Promise<T | null> {
  if (capability !== 'llm.chat') return null;
  const g = globalThis as unknown as ScriptBridgeEnv;
  const url = g.process?.env?.LINGFANG_PLUGIN_BRIDGE_URL;
  const token = g.process?.env?.LINGFANG_PLUGIN_BRIDGE_TOKEN;
  if (!url || !token || typeof g.fetch !== 'function') return null;
  const res = await g.fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-LingFang-Plugin-Token': token,
    },
    body: JSON.stringify(args ?? {}),
  });
  const data = await res.json().catch(() => ({})) as { content?: unknown; message?: string; error?: string };
  if (!res.ok) throw new Error(data.message || data.error || `平台 LLM 调用失败：HTTP ${res.status}`);
  return (typeof data.content === 'string' ? data.content : '') as T;
}

// 桥调用默认超时（与桌面 plugins-runtime.ts 的 RUNTIME_BRIDGE_TIMEOUT_MS 对齐）。
// 宿主可能未注入带超时的桥（旧版或未升级的容器），SDK 自身加一层超时兜底。
async function invoke<T>(capability: CapabilityKind | string, args: unknown = {}, timeoutMs = DEFAULT_BRIDGE_TIMEOUT_MS): Promise<T> {
  const bridge = (globalThis as unknown as { __lingfangInvoke?: (c: string, a: unknown) => Promise<unknown> })
    .__lingfangInvoke;
  if (typeof bridge !== 'function') {
    const scriptResult = await invokeScriptBridge<T>(capability, args);
    if (scriptResult !== null) return scriptResult;
    throw new Error(`capability bridge 未注入: ${capability}`);
  }
  // SDK-04：用 Promise.race 加超时兜底，避免桥返回的 Promise 永不 settle。
  if (timeoutMs <= 0) return bridge(capability, args) as Promise<T>;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`capability 调用超时: ${capability}`)), timeoutMs);
  });
  try {
    return await Promise.race([bridge(capability, args) as Promise<T>, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// SDK-08 修复：sdk 不再导出原始 invoke 入口，避免插件作者绕过类型化分组直接传任意字符串 kind。
// 8 组类型化 API 已覆盖 CapabilityKind 全部 kind；如确需调用未封装的 kind，应通过 capability 网关
// 显式声明并扩展 sdk.xxx 组。注释而非删除：保留此说明以提醒未来维护者不要把 invoke 重新挂回 sdk。
export const sdk = {
  fs: {
    pick: (opts?: { accept?: string[] }) => invoke<string[]>('fs.pick', opts ?? {}),
    // SDK-01 修复：fs.read 实际返回 {content}（文件）/ {entries}（目录）对象，而非裸字符串。
    // 原契约 Promise<string> 与 Rust capability.rs 返回结构不一致，按契约编写的插件会拿到 [object Object]。
    read: (path: string) => invoke<{ content: string } | { entries: string[] }>('fs.read', { path }),
    write: (path: string, content: string) => invoke<void>('fs.write', { path, content }),
  },
  net: {
    // SDK-05 修复：init 白名单过滤为可序列化字段，丢弃 AbortSignal/函数等。
    fetch: (url: string, init?: unknown) => invoke<unknown>('net.fetch', { url, init: sanitizeFetchInit(init) }),
  },
  clipboard: {
    readText: () => invoke<string>('clipboard', { op: 'read' }),
    writeText: (text: string) => invoke<void>('clipboard', { op: 'write', text }),
  },
  storage: {
    get: (key: string) => invoke<unknown>('storage.kv', { op: 'get', key }),
    // SDK-05 修复：预检 value 可序列化（主要防循环引用），给业务友好错误而非 DataCloneError。
    set: (key: string, value: unknown) => {
      assertSerializable(value, 'storage.set value');
      return invoke<void>('storage.kv', { op: 'set', key, value });
    },
  },
  system: {
    // SDK-08 修复：补齐 system.info 分组，原 invoke 泄漏（可 sdk.invoke('system.info')）现收敛为正式方法。
    info: () => invoke<unknown>('system.info', {}),
    screenshot: () => invoke<string>('system.screenshot', {}),
    notify: (title: string, body?: string) => invoke<void>('system.notify', { title, body }),
  },
  // 不含 base_url / key / 供应商：实际路由到租户绑定的第三方网关（见 docs/03）。
  llm: {
    chat: (input: ChatInput) => invoke<string>('llm.chat', input),
  },
  // 计费/中转：生图走平台 relay（/api/relay/v1/images/generations），按张计费，按团队灵石结算。
  // 输入 prompt 必填；model 默认 fast；返回 { images: string[] }（url 或 data:base64）。
  // 系统提示词已由平台强制注入：必须且仅能使用灵坊平台服务（需求 #3）。
  image: {
    generate: (input: ImageGenerateInput) => invoke<ImageGenerateResult>('image.generate', input),
  },
  plugin: {
    upload: (input: PluginUploadInput) => invoke<unknown>('plugin.upload', input),
    submitMarketplace: (input: PluginSubmitMarketplaceInput) => invoke<unknown>('plugin.submitMarketplace', input),
  },
  ui: {
    // SDK-05 修复：content 预检可序列化（防 DOM 节点 / 循环引用）。
    render: (content: unknown) => {
      assertSerializable(content, 'ui.render content');
      return invoke<void>('ui.view', { content });
    },
  },
};

export type {
  ChatMessage,
  ChatInput,
  ImageGenerateInput,
  ImageGenerateResult,
  PluginFile,
  PluginUploadInput,
  PluginSubmitMarketplaceInput,
};
