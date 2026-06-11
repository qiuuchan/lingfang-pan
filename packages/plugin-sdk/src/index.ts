// @lingfang/plugin-sdk：插件作者用的类型化能力客户端（见 docs/02 §B-5）。
// 插件不直连网络、不持 LLM key——所有越权操作经宿主注入的桥 __lingfangInvoke，
// 由壳的 capability 网关三重校验后执行。

import type { CapabilityKind } from '@lingfang/contract';

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };
type ChatInput = { messages: ChatMessage[]; model?: string };

async function invoke<T>(capability: CapabilityKind | string, args: unknown = {}): Promise<T> {
  const bridge = (globalThis as unknown as { __lingfangInvoke?: (c: string, a: unknown) => Promise<unknown> })
    .__lingfangInvoke;
  if (typeof bridge !== 'function') {
    throw new Error(`capability bridge 未注入: ${capability}`);
  }
  return bridge(capability, args) as Promise<T>;
}

export const sdk = {
  invoke,
  fs: {
    pick: (opts?: { accept?: string[] }) => invoke<string[]>('fs.pick', opts ?? {}),
    read: (path: string) => invoke<string>('fs.read', { path }),
    write: (path: string, content: string) => invoke<void>('fs.write', { path, content }),
  },
  net: {
    fetch: (url: string, init?: unknown) => invoke<unknown>('net.fetch', { url, init }),
  },
  clipboard: {
    readText: () => invoke<string>('clipboard', { op: 'read' }),
    writeText: (text: string) => invoke<void>('clipboard', { op: 'write', text }),
  },
  storage: {
    get: (key: string) => invoke<unknown>('storage.kv', { op: 'get', key }),
    set: (key: string, value: unknown) => invoke<void>('storage.kv', { op: 'set', key, value }),
  },
  system: {
    screenshot: () => invoke<string>('system.screenshot', {}),
    notify: (title: string, body?: string) => invoke<void>('system.notify', { title, body }),
  },
  // 不含 base_url / key / 供应商：实际路由到租户绑定的第三方网关（见 docs/03）。
  llm: {
    chat: (input: ChatInput) => invoke<string>('llm.chat', input),
  },
  ui: {
    render: (content: unknown) => invoke<void>('ui.view', { content }),
  },
};

export type { ChatMessage, ChatInput };
