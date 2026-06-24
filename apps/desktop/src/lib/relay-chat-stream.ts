// relay-chat-stream.ts —— relay 聊天的 SSE 流式客户端（悬浮创建器用）。
//
// POST /api/relay/v1/chat/completions（stream:true）→ 服务端 SSE 响应，逐 chunk 透传 delta。
// 本模块读 ReadableStream，按 SSE 协议解析 `data: {...}` 行，提取 choices[0].delta.content 增量回调。
// 鉴权用当前登录态 JWT（与 api() 一致）。
import { apiBase, getAuthToken } from '@/lib/api';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface StreamArgs {
  messages: ChatMessage[];
  tier?: 'fast' | 'premium';
  signal?: AbortSignal;
  /** 每个 delta 片段到达时回调（增量文本）。 */
  onDelta: (delta: string) => void;
}

/**
 * 流式聊天：返回助手完整回复（拼接所有 delta）。失败抛错。
 * 调用方可通过 onDelta 实时渲染增量，通过 signal 中断。
 */
export async function streamChat({ messages, tier = 'fast', signal, onDelta }: StreamArgs): Promise<string> {
  const base = apiBase();
  if (!base) throw new Error('未配置平台地址');
  const token = getAuthToken();
  if (!token) throw new Error('请先登录');

  const postChat = (stream: boolean) => fetch(`${base}/api/relay/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Client': 'desktop',
      Authorization: `Bearer ${token}`,
      ...(stream ? { Accept: 'text/event-stream' } : {}),
    },
    body: JSON.stringify({ model: tier, messages, stream, temperature: 0.4 }),
    signal,
  });
  let res = await postChat(true);

  if (!res.ok) {
    // relay 错误体是 {code,message}（非 SSE）。读出来友好报错。
    let detail = `HTTP ${res.status}`;
    try {
      const err = await res.json();
      detail = err.message || err.code || detail;
    } catch { /* 忽略 */ }
    if ((res.status === 400 || res.status === 422) && /stream|流式/i.test(detail)) {
      res = await postChat(false);
    }
    if (!res.ok) {
      try {
        const err = await res.json();
        detail = err.message || err.code || detail;
      } catch { /* 忽略 */ }
      throw new Error(detail);
    }
  }

  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream')) {
    const data = await res.json().catch(() => ({}));
    const text = extractChatContent(data);
    if (text) onDelta(text);
    return text;
  }

  const reader = res.body?.getReader();
  if (!reader) {
    const text = await chatComplete(messages, tier, signal);
    if (text) onDelta(text);
    return text;
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  const consumeEvent = (evt: string) => {
    for (const line of evt.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const jsonStr = t.slice(5).trim();
      if (jsonStr === '[DONE]') continue;
      let obj: { choices?: { delta?: { content?: string } }[]; error?: { message?: string }; message?: string };
      try {
        obj = JSON.parse(jsonStr) as typeof obj;
      } catch {
        continue;
      }
      if (obj.error?.message || obj.message) throw new Error(obj.error?.message || obj.message);
      const delta = obj.choices?.[0]?.delta?.content;
      if (delta) {
        full += delta;
        onDelta(delta);
      }
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE 事件以双换行分隔；逐事件解析。
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const evt = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        consumeEvent(evt);
      }
    }
    if (buffer.trim()) consumeEvent(buffer);
  } catch (error) {
    throw new Error((error as Error).message || '模型调用失败');
  } finally {
    reader.releaseLock?.();
  }
  return full;
}

function extractChatContent(data: unknown): string {
  const obj = data as {
    choices?: Array<{ message?: { content?: string | Array<{ text?: string }> }; delta?: { content?: string }; text?: string }>;
    content?: string | Array<{ text?: string }>;
    message?: string;
    output_text?: string;
  };
  const choice = obj.choices?.[0];
  const content = choice?.message?.content ?? choice?.delta?.content ?? choice?.text ?? obj.content ?? obj.output_text ?? obj.message;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => part.text).filter(Boolean).join('');
  return '';
}

/**
 * 非流式聊天（一次性返回完整回复）。用于上下文压缩摘要等不需要流式的场景。
 * 鉴权同 streamChat（JWT）。
 */
export async function chatComplete(messages: ChatMessage[], tier: 'fast' | 'premium' = 'fast', signal?: AbortSignal): Promise<string> {
  const base = apiBase();
  if (!base) throw new Error('未配置平台地址');
  const token = getAuthToken();
  if (!token) throw new Error('请先登录');
  const res = await fetch(`${base}/api/relay/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Client': 'desktop', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ model: tier, messages, stream: false, temperature: 0.2 }),
    signal,
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { const err = await res.json(); detail = err.message || err.code || detail; } catch { /* 忽略 */ }
    throw new Error(detail);
  }
  const data = await res.json();
  return extractChatContent(data);
}
