// @lingfang/plugin-sdk：插件作者用的类型化能力客户端（见 docs/02 §B-5）。
// 插件不直连网络、不持 LLM key——所有越权操作经宿主注入的桥 __lingfangInvoke，
// 由壳的 capability 网关三重校验后执行。

import type { CapabilityKind } from '@lingfang/contract';

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };
type ChatInput = { messages: ChatMessage[]; model?: 'fast' | 'premium' };
type ImageGenerateInput = { prompt: string; model?: 'fast' | 'premium'; size?: string; n?: number };
type ImageGenerateResult = { images: string[] };
type ImageEditImage = { filename: string; mimeType: string; data: string };
type ImageEditInput = {
  prompt: string;
  images: ImageEditImage[];
  model?: 'fast' | 'premium';
  size?: string;
  n?: number;
};
type ImageEditResult = { images: string[] };
type PluginFile = { path: string; content: string };
type PluginUploadInput = { manifest: unknown; files: PluginFile[]; priceCents?: number };
type PluginSubmitMarketplaceInput = { pluginId: string; priceCents?: number };

export type PluginAiErrorInit = {
  code?: string;
  status?: number;
  requestId?: string;
  cause?: unknown;
};

export class PluginAiError extends Error {
  readonly code?: string;
  readonly status?: number;
  readonly requestId?: string;

  constructor(message: string, init: PluginAiErrorInit = {}) {
    super(message, { cause: init.cause });
    this.name = 'PluginAiError';
    this.code = init.code;
    this.status = init.status;
    this.requestId = init.requestId;
  }
}

// SDK-04 修复：桥层调用默认 30s 超时，避免宿主不回复（容器卸载、后端 hang 等）时插件 await 永久挂起。
// 超时后 reject 友好错误。宿主若已自带超时（如桌面 plugins-runtime.ts 的 30s）则两者取先到者。
const DEFAULT_BRIDGE_TIMEOUT_MS = 30_000;
const AI_BRIDGE_TIMEOUT_MS = 180_000;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function pluginAiError(error: unknown, fallback: PluginAiErrorInit & { message?: string } = {}): PluginAiError {
  if (error instanceof PluginAiError) return error;
  const source = record(error);
  const nested = record(source.error);
  const message = nonEmptyString(nested.message)
    ?? nonEmptyString(source.message)
    ?? (error instanceof Error ? nonEmptyString(error.message) : undefined)
    ?? fallback.message
    ?? '平台 AI 调用失败';
  const statusValue = nested.status ?? source.status ?? fallback.status;
  return new PluginAiError(message, {
    code: nonEmptyString(nested.code)
      ?? nonEmptyString(source.code)
      ?? (nonEmptyString(source.message) ? nonEmptyString(source.error) : undefined)
      ?? fallback.code,
    status: typeof statusValue === 'number' ? statusValue : undefined,
    requestId: nonEmptyString(nested.requestId) ?? nonEmptyString(source.requestId) ?? fallback.requestId,
    cause: error,
  });
}

function platformModel(value: unknown): 'fast' | 'premium' {
  if (value === undefined) return 'fast';
  if (value === 'fast' || value === 'premium') return value;
  throw new PluginAiError('仅支持平台模型档位 fast 或 premium', {
    code: 'unsupported_model',
    status: 400,
  });
}

function localhostBridgeBase(value: string): string {
  try {
    const url = new URL(value);
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
    if (url.protocol !== 'http:' || !loopback || url.username || url.password || (url.pathname !== '/' && url.pathname !== '')) {
      throw new Error('invalid bridge URL');
    }
    return url.toString().replace(/\/$/, '');
  } catch (cause) {
    throw new PluginAiError('宿主注入的本地桥地址无效', {
      code: 'bridge_invalid',
      status: 503,
      cause,
    });
  }
}

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

// 脚本桥路由表：capability → localhost 桥路径（LINGFANG_PLUGIN_BRIDGE_URL 是基础 endpoint，不含路径后缀）。
// Rust 端 plugin_llm_bridge.rs 的 route_request 据此分发：/llm/chat、/image/generate。
const SCRIPT_BRIDGE_PATH: Record<string, string> = {
  'llm.chat': '/llm/chat',
  'image.generate': '/image/generate',
  'image.edit': '/image/edit',
};

// Node.js / Python 脚本插件的本地桥回退：window.__lingfangInvoke 不存在时（脚本无 DOM）走 localhost HTTP 桥。
// 桥用当前进程会话 token 鉴权，宿主转发到平台 relay（真正计费在 relay 侧扣当前团队灵石）。
// 支持能力：llm.chat（返回 {content:string}）、image.generate（返回 {images:string[]}）。
async function invokeScriptBridge<T>(capability: string, args: unknown): Promise<T | null> {
  const path = SCRIPT_BRIDGE_PATH[capability];
  if (!path) return null;
  const g = globalThis as unknown as ScriptBridgeEnv;
  const baseValue = g.process?.env?.LINGFANG_PLUGIN_BRIDGE_URL;
  const token = g.process?.env?.LINGFANG_PLUGIN_BRIDGE_TOKEN;
  if (!baseValue || !token || typeof g.fetch !== 'function') return null;
  const base = localhostBridgeBase(baseValue);
  const input = record(args);
  const body = capability === 'llm.chat' || capability === 'image.generate'
    ? { ...input, model: platformModel(input.model) }
    : input;
  const res = await g.fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-LingFang-Plugin-Token': token,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) {
    throw pluginAiError(data, {
      status: res.status,
      requestId: res.headers.get('x-request-id') ?? undefined,
      message: `平台调用失败：HTTP ${res.status}`,
    });
  }
  if (capability === 'llm.chat') {
    return (typeof data.content === 'string' ? data.content : '') as T;
  }
  // image.generate：返回 { images: string[] }
  return { images: Array.isArray(data.images) ? (data.images as string[]) : [] } as T;
}

// 桥调用默认超时（与桌面 plugins-runtime.ts 的 RUNTIME_BRIDGE_TIMEOUT_MS 对齐）。
// 宿主可能未注入带超时的桥（旧版或未升级的容器），SDK 自身加一层超时兜底。
async function invoke<T>(capability: CapabilityKind | string, args: unknown = {}, timeoutMs = DEFAULT_BRIDGE_TIMEOUT_MS): Promise<T> {
  const bridge = (globalThis as unknown as { __lingfangInvoke?: (c: string, a: unknown) => Promise<unknown> })
    .__lingfangInvoke;
  const operation = typeof bridge === 'function'
    ? bridge(capability, args) as Promise<T>
    : (async () => {
        const scriptResult = await invokeScriptBridge<T>(capability, args);
        if (scriptResult !== null) return scriptResult;
        throw new Error(`capability bridge 未注入: ${capability}`);
      })();
  // SDK-04：用 Promise.race 加超时兜底，避免桥返回的 Promise 永不 settle。
  if (timeoutMs <= 0) return operation;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`capability 调用超时: ${capability}`)), timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function invokeAi<T>(capability: 'llm.chat' | 'image.generate' | 'image.edit', input: Record<string, unknown>): Promise<T> {
  const args = { ...input, model: platformModel(input.model) };
  try {
    return await invoke<T>(capability, args, AI_BRIDGE_TIMEOUT_MS);
  } catch (error) {
    const timedOut = error instanceof Error && error.message.startsWith('capability 调用超时:');
    const bridgeUnavailable = error instanceof Error && error.message.startsWith('capability bridge 未注入:');
    throw pluginAiError(error, timedOut
      ? { code: 'request_timeout', status: 408, message: `平台 AI 调用超时: ${capability}` }
      : bridgeUnavailable
        ? { code: 'bridge_unavailable', status: 503 }
        : { code: 'plugin_ai_error' });
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
  // 不含 apiKey / apiUrl / baseUrl / provider：实际路由由平台 relay + 团队渠道配置决定。
  // model 仅是平台模型标识（fast / premium），不是上游地址或密钥配置。
  llm: {
    chat: (input: ChatInput) => invokeAi<string>('llm.chat', input),
  },
  // 计费/中转：生图走平台 relay（/api/relay/v1/images/generations），按张计费，按团队灵石结算。
  // 输入 prompt 必填；model 默认 fast；返回 { images: string[] }（url 或 data:base64）。
  // 系统提示词已由平台强制注入：必须且仅能使用灵坊平台服务（需求 #3）。
  image: {
    generate: (input: ImageGenerateInput) => invokeAi<ImageGenerateResult>('image.generate', input),
    // 计费/中转：图片编辑（带参考图）走平台 relay（/api/relay/v1/images/edits），multipart 透传，按张计费。
    // 输入 prompt + images（参考图，data 为 base64 无前缀）；model 默认 fast；返回 { images: string[] }（url 或 data:base64）。
    edit: (input: ImageEditInput) => invokeAi<ImageEditResult>('image.edit', input),
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
  ImageEditImage,
  ImageEditInput,
  ImageEditResult,
  PluginFile,
  PluginUploadInput,
  PluginSubmitMarketplaceInput,
};
