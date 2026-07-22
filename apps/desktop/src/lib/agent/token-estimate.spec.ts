// token-estimate.spec.ts —— 验证启发式 token 估算。
import { describe, expect, it } from 'vitest';
import {
  CHARS_PER_TOKEN_CJK,
  CHARS_PER_TOKEN_LATIN,
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateTokens,
} from './token-estimate';
import type { ChatMessage } from './types';

describe('estimateTokens', () => {
  it('空串返回 0', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('纯中文按 1.5 字符/token 估算（向上取整）', () => {
    // 7 个中文字符 / 1.5 = 4.67 → ceil = 5 token
    expect(estimateTokens('做一个天气插件')).toBe(5);
  });

  it('纯英文按 4 字符/token 估算', () => {
    // 12 个英文字符 / 4 = 3 token
    expect(estimateTokens('hello world!')).toBe(3);
  });

  it('中英混合：分段加权后求和', () => {
    // 3 中文（3/1.5=2）+ 3 英文（3/4=0.75）→ 2+0.75=2.75 → ceil = 3 token
    const tokens = estimateTokens('做天气abc');
    expect(tokens).toBe(3);
    // 验证：不等于纯按单一系数算（旧 /1.5 会是 6/1.5=4，旧 /4 会是 6/4=2）
    expect(tokens).not.toBe(Math.ceil(6 / CHARS_PER_TOKEN_CJK));
    expect(tokens).not.toBe(Math.ceil(6 / CHARS_PER_TOKEN_LATIN));
  });

  it('短文本至少 1 token', () => {
    expect(estimateTokens('a')).toBeGreaterThanOrEqual(1);
  });
});

describe('estimateMessageTokens', () => {
  it('system/user 消息：content token + overhead', () => {
    const msg: ChatMessage = { role: 'user', content: '做一个天气插件' };
    const expected = 5 + 4; // 7 中文/1.5=5 token + overhead 4
    expect(estimateMessageTokens(msg)).toBe(expected);
  });

  it('assistant 带 tool_calls：计入 arguments', () => {
    const msg: ChatMessage = {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'WebSearch', arguments: JSON.stringify({ query: 'tauri 2.0 release' }) },
        },
      ],
    };
    const tokens = estimateMessageTokens(msg);
    // 至少包含 overhead（base 4 + tool_call 结构 4）+ name/arguments 估算
    expect(tokens).toBeGreaterThan(8);
  });

  it('tool 消息：按 content 估算', () => {
    const msg: ChatMessage = { role: 'tool', tool_call_id: 'c1', content: 'Tauri 2.0 已发布' };
    const tokens = estimateMessageTokens(msg);
    expect(tokens).toBeGreaterThan(4);
  });

  it('content 为 null 的 assistant 消息仍有 overhead', () => {
    const msg: ChatMessage = { role: 'assistant', content: null };
    expect(estimateMessageTokens(msg)).toBe(4);
  });
});

describe('estimateMessagesTokens', () => {
  it('累加多条消息的 token', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: '做一个天气插件' },
      { role: 'assistant', content: '好的' },
    ];
    const total = estimateMessagesTokens(messages);
    // 每条至少 4 overhead + content，3 条至少 12
    expect(total).toBeGreaterThanOrEqual(12);
  });

  it('空数组返回 0', () => {
    expect(estimateMessagesTokens([])).toBe(0);
  });

  it('与单条估算之和一致（无额外全局开销）', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
      { role: 'tool', tool_call_id: 'c1', content: 'result' },
    ];
    const sum = messages.reduce((s, m) => s + estimateMessageTokens(m), 0);
    expect(estimateMessagesTokens(messages)).toBe(sum);
  });
});

describe('常量', () => {
  it('CJK 系数为 1.5', () => {
    expect(CHARS_PER_TOKEN_CJK).toBe(1.5);
  });

  it('拉丁系数为 4', () => {
    expect(CHARS_PER_TOKEN_LATIN).toBe(4);
  });
});
