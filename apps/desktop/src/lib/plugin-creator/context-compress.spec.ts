import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildContextMessages, emptyCompressState, turnHasPackage } from './context-compress';
import { chatComplete } from '@/lib/relay-chat-stream';

vi.mock('@/lib/relay-chat-stream', () => ({
  chatComplete: vi.fn(),
}));

const mockChatComplete = vi.mocked(chatComplete);

describe('turnHasPackage', () => {
  it('detects fenced lingfang plugin package blocks', () => {
    expect(turnHasPackage('plain text')).toBe(false);
    expect(turnHasPackage('```lingfang-plugin\n{ "id": "demo" }\n```')).toBe(true);
  });
});

describe('buildContextMessages', () => {
  beforeEach(() => {
    mockChatComplete.mockReset();
  });

  it('summarizes older compressible turns and keeps package-bearing turns verbatim', async () => {
    mockChatComplete.mockResolvedValue('核心需求：做一个天气插件\n已生成 demo 插件包');

    const result = await buildContextMessages({
      turns: [
        { role: 'user', content: '请做一个天气插件' },
        { role: 'assistant', content: '先确认城市与温度单位' },
        { role: 'user', content: '```lingfang-plugin\n{"id":"demo"}\n```' },
        { role: 'assistant', content: '我会保留这个插件包' },
        { role: 'user', content: '再补一个设置页' },
        { role: 'assistant', content: '好的' },
      ],
      currentInput: '继续优化',
      systemPrompt: 'system prompt',
      state: emptyCompressState(),
      threshold: 1,
      recentWindowTurns: 1,
      tier: 'fast',
    });

    expect(mockChatComplete).toHaveBeenCalledTimes(1);
    expect(result.compressedCount).toBeGreaterThan(0);
    expect(result.breakdown.summary).toContain('核心需求');
    expect(result.breakdown.keptTurns.some((turn) => turn.content.includes('```lingfang-plugin'))).toBe(true);
    expect(result.breakdown.currentInput).toBe('继续优化');
    expect(result.messages[0]).toEqual({ role: 'system', content: 'system prompt' });
    expect(result.messages[result.messages.length - 1]).toEqual({ role: 'user', content: '继续优化' });
  });

  it('摘要失败时不推进 lastSummarizedIndex（保留这些轮下次重试，不静默丢弃）', async () => {
    // 此前 catch 块把 nextLastIndex 推进到 older.length-1 但 summary 没更新 = 静默丢弃。
    // 修复后保持原索引，下轮这些轮仍作为「未摘要新轮」参与重试。
    mockChatComplete.mockRejectedValue(new Error('网络错误'));

    const turns = [
      { role: 'user' as const, content: '第一个需求，做计算器' },
      { role: 'assistant' as const, content: '好的我会做' },
      { role: 'user' as const, content: '第二个需求，加历史记录' },
      { role: 'assistant' as const, content: '明白' },
    ];
    const result = await buildContextMessages({
      turns,
      currentInput: '继续',
      systemPrompt: 'sys',
      state: emptyCompressState(),
      threshold: 1,
      recentWindowTurns: 1,
      tier: 'fast',
    });
    // 摘要失败 → lastSummarizedIndex 不推进（保持 -1），summary 为空。
    expect(result.state.lastSummarizedIndex).toBe(-1);
    expect(result.state.summary).toBe('');
    // compressedCount 反映本次尝试了摘要（即便失败）。
    expect(result.compressedCount).toBeGreaterThan(0);
  });

  it('摘要失败后再次调用，未摘要的轮仍参与摘要重试', async () => {
    // 第一次失败（lastSummarizedIndex 保持 -1），第二次成功，验证这些轮没被丢弃。
    mockChatComplete.mockRejectedValueOnce(new Error('网络错误'));
    mockChatComplete.mockResolvedValueOnce('摘要成功：做了计算器');

    const turns = [
      { role: 'user' as const, content: '做计算器插件' },
      { role: 'assistant' as const, content: '好的' },
      { role: 'user' as const, content: '加历史记录' },
      { role: 'assistant' as const, content: '明白' },
    ];
    const args = {
      turns,
      currentInput: '继续',
      systemPrompt: 'sys',
      threshold: 1,
      recentWindowTurns: 1,
      tier: 'fast' as const,
    };
    const r1 = await buildContextMessages({ ...args, state: emptyCompressState() });
    expect(r1.state.lastSummarizedIndex).toBe(-1); // 失败未推进
    // 第二次：传入第一次的 state，验证同样的轮被重新摘要。
    const r2 = await buildContextMessages({ ...args, state: r1.state });
    expect(mockChatComplete).toHaveBeenCalledTimes(2); // 第二次又调了摘要
    expect(r2.state.summary).toContain('计算器');
  });

  it('token 估算用 /1.5（中文偏向，防低估）', async () => {
    // 600 字符的 systemPrompt → /1.5 = 400 token（旧 /4 = 150，严重低估中文）。
    const result = await buildContextMessages({
      turns: [{ role: 'user', content: '你好' }],
      currentInput: '继续',
      systemPrompt: 's'.repeat(600),
      state: emptyCompressState(),
      tier: 'fast',
    });
    expect(result.breakdown.estimatedTokens.system).toBe(400);
  });
});

