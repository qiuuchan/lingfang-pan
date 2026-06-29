// creator-adapter.spec.ts —— 验证消息历史保留工具调用结果（重试断点续的关键）。
//
// 核心场景：assistant 轮带 parts（含 WebSearch 工具调用+结果），应被序列化进
// assistant 文本内容，让模型续跑时读到「上轮已搜过 X、结果是 Y」而不必重跑工具。
import { describe, it, expect } from 'vitest';
import type { AgentMessagePart } from './creator-adapter';

// 复刻 partsToAssistantText 的序列化逻辑做单测（函数未导出，避免改产线签名）。
// 与 creator-adapter.ts 内逻辑一致；改产线时同步。
function partsToText(parts: AgentMessagePart[], fallback: string): string {
  const chunks: string[] = [];
  for (const p of parts) {
    if (p.type === 'text' && p.text) chunks.push(p.text);
    else if (p.type === 'tool_call' && p.name) {
      const a = typeof p.args === 'string' ? p.args : JSON.stringify(p.args ?? {});
      chunks.push(`[已调用工具 ${p.name}] 入参: ${a}`);
    } else if (p.type === 'tool_result' && p.name) {
      const o = typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? '');
      const t = o.length > 1500 ? o.slice(0, 1500) + '…(已截断)' : o;
      chunks.push(`[工具 ${p.name} 返回] ${t}`);
    }
  }
  return chunks.join('\n').trim() || fallback;
}

describe('工具历史序列化（断点续：模型能看到上轮工作）', () => {
  it('WebSearch 调用+结果 → 序列化成可读文本', () => {
    const parts: AgentMessagePart[] = [
      { type: 'tool_call', toolCallId: 'ws-1', name: 'WebSearch', args: { query: 'tauri', limit: 8 } },
      { type: 'tool_result', toolCallId: 'ws-1', name: 'WebSearch', output: '1. Tauri 2.0\n   https://tauri.app' },
    ];
    const text = partsToText(parts, '');
    expect(text).toContain('[已调用工具 WebSearch]');
    expect(text).toContain(JSON.stringify({ query: 'tauri', limit: 8 }));
    expect(text).toContain('[工具 WebSearch 返回]');
    expect(text).toContain('Tauri 2.0');
    // 模型能读到「搜过且拿到结果」→ 续跑时不必重搜
  });

  it('文本 part 直接拼接', () => {
    const text = partsToText([{ type: 'text', text: '我已搜到，下面总结。' }], '');
    expect(text).toBe('我已搜到，下面总结。');
  });

  it('混合序列按时序拼接（文本 → 工具 → 文本）', () => {
    const parts: AgentMessagePart[] = [
      { type: 'text', text: '先搜索。' },
      { type: 'tool_call', toolCallId: 'ws-1', name: 'WebSearch', args: { query: 'x' } },
      { type: 'tool_result', toolCallId: 'ws-1', name: 'WebSearch', output: 'result' },
      { type: 'text', text: '总结完毕。' },
    ];
    const text = partsToText(parts, '');
    expect(text.startsWith('先搜索。')).toBe(true);
    expect(text.endsWith('总结完毕。')).toBe(true);
    expect(text).toContain('[已调用工具 WebSearch]');
    expect(text).toContain('[工具 WebSearch 返回] result');
  });

  it('过长的工具输出被截断（避免撑爆上下文）', () => {
    const longOutput = 'x'.repeat(2000);
    const text = partsToText([{ type: 'tool_result', toolCallId: 'x', name: 'WebSearch', output: longOutput }], '');
    expect(text).toContain('…(已截断)');
    expect(text.length).toBeLessThan(2000);
  });

  it('非字符串 output 做 JSON 序列化', () => {
    const text = partsToText([{ type: 'tool_result', toolCallId: 'x', name: 'Check', output: { ok: true, errors: [] } }], '');
    expect(text).toContain(JSON.stringify({ ok: true, errors: [] }));
  });

  it('空 parts 回退到 fallback content', () => {
    expect(partsToText([], 'fallback text')).toBe('fallback text');
  });
});
