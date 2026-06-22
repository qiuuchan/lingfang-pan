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

  const res = await fetch(`${base}/api/relay/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Client': 'desktop',
      Authorization: `Bearer ${token}`,
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({ model: tier, messages, stream: true, temperature: 0.4 }),
    signal,
  });

  if (!res.ok) {
    // relay 错误体是 {code,message}（非 SSE）。读出来友好报错。
    let detail = `HTTP ${res.status}`;
    try {
      const err = await res.json();
      detail = err.message || err.code || detail;
    } catch { /* 忽略 */ }
    throw new Error(detail);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error('无响应流');
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE 事件以双换行分隔；逐事件解析。
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const evt = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of evt.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const jsonStr = t.slice(5).trim();
        if (jsonStr === '[DONE]') continue;
        try {
          const obj = JSON.parse(jsonStr) as { choices?: { delta?: { content?: string } }[] };
          const delta = obj.choices?.[0]?.delta?.content;
          if (delta) {
            full += delta;
            onDelta(delta);
          }
        } catch {
          // 非 JSON chunk 忽略（上游偶发 keep-alive 等）
        }
      }
    }
  }
  return full;
}
