import { apiBase, getAuthToken } from '@/lib/api';
import type { PluginDraft } from '@/lib/types';

// 解析单个 SSE 块（event: xxx \n data: yyy，data 可多行）。
function parseSseBlock(block: string): { event: string; data: string } | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  if (!dataLines.length) return null;
  return { event, data: dataLines.join('\n') };
}

export interface StreamCallbacks {
  onToken: (acc: string) => void;
  onReasoning?: (acc: string) => void;
  onStage?: (stage: string) => void;
}

// SSE 流式生成：token 累积正文；reasoning 累积思考；stage 报告阶段；done 返回完整草稿；error 抛出（带 code）。
export async function streamGenerate(
  draftId: string,
  prompt: string,
  cb: StreamCallbacks,
): Promise<PluginDraft> {
  const base = apiBase();
  if (!base) throw new Error('尚未配置后端服务地址，请先填写后端 URL。');
  const res = await fetch(`${base}/drafts/${draftId}/generate/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getAuthToken()}` },
    body: JSON.stringify({ prompt }),
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.message || data.error || '流式请求失败');
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let acc = '';
  let reasoningAcc = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const ev = parseSseBlock(block);
      if (!ev) continue;
      if (ev.event === 'token') {
        acc += ev.data;
        cb.onToken(acc);
      } else if (ev.event === 'reasoning') {
        reasoningAcc += ev.data;
        cb.onReasoning?.(reasoningAcc);
      } else if (ev.event === 'stage') {
        cb.onStage?.(ev.data);
      } else if (ev.event === 'done') {
        return JSON.parse(ev.data) as PluginDraft;
      } else if (ev.event === 'error') {
        const e = JSON.parse(ev.data);
        const err = new Error(e.message || e.error) as Error & { code?: string };
        err.code = e.error;
        throw err;
      }
    }
  }
  throw new Error('生成未完成');
}
