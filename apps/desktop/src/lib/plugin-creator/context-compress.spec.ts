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
});

