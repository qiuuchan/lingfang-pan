// context-compress.spec.ts —— 验证 buildContextMessages 的压缩与原生 function calling 历史还原。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildContextMessages, compressHistoryManually, emptyCompressState, turnHasPackage } from './context-compress';
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

  it('未超阈值：保留完整原文历史（原生 function calling），不调摘要', async () => {
    const result = await buildContextMessages({
      turns: [
        { role: 'user', content: '请做一个天气插件' },
        { role: 'assistant', content: '先确认城市与温度单位' },
      ],
      currentInput: '继续优化',
      systemPrompt: 'system prompt',
      state: emptyCompressState(),
      tier: 'fast',
    });

    expect(mockChatComplete).not.toHaveBeenCalled();
    expect(result.compressedCount).toBe(0);
    // messages = [system, user, assistant, user(当前输入)]
    expect(result.messages[0]).toEqual({ role: 'system', content: 'system prompt' });
    expect(result.messages[result.messages.length - 1]).toEqual({ role: 'user', content: '继续优化' });
    // 早期 user/assistant 原文保留
    expect(result.messages.some((m) => m.role === 'user' && m.content === '请做一个天气插件')).toBe(true);
    expect(result.messages.some((m) => m.role === 'assistant' && m.content === '先确认城市与温度单位')).toBe(true);
  });

  it('超阈值：摘要较早轮 + 保留含插件包的轮原文 + 近期轮原文', async () => {
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
      threshold: 1, // 极低阈值强制触发压缩
      recentWindowTurns: 1,
      tier: 'fast',
    });

    expect(mockChatComplete).toHaveBeenCalledTimes(1);
    expect(result.compressedCount).toBeGreaterThan(0);
    expect(result.breakdown.summary).toContain('核心需求');
    // 含插件包的轮原文保留（不进摘要）
    expect(result.messages.some((m) => typeof m.content === 'string' && m.content.includes('```lingfang-plugin'))).toBe(true);
    // 近期轮原文保留
    expect(result.messages.some((m) => m.content === '再补一个设置页')).toBe(true);
    // 摘要作为 system 消息注入
    expect(result.messages.some((m) => m.role === 'system' && m.content.includes('[历史上下文摘要]'))).toBe(true);
    // 当前输入在末尾
    expect(result.messages[result.messages.length - 1]).toEqual({ role: 'user', content: '继续优化' });
  });

  it('超阈值且 assistant 带工具调用：近期轮保留原生 tool_calls + role:tool 配对', async () => {
    // 关键回归：压缩后近期保留区必须保留原生 function calling 结构（tool_calls + role:tool 按 id 配对），
    // 否则 OpenAI 会因 tool result 找不到对应 tool_calls 而 400。
    mockChatComplete.mockResolvedValue('摘要：用户要搜索');
    const result = await buildContextMessages({
      turns: [
        { role: 'user', content: '搜索 tauri' },
        {
          role: 'assistant',
          content: '',
          parts: [
            { type: 'tool', toolCallId: 'call_1', name: 'WebSearch', args: { query: 'tauri' }, result: 'Tauri 2.0', status: 'ok' },
            { type: 'text', content: '找到了 Tauri' },
          ],
        },
        { role: 'user', content: '再搜索 rust' },
        {
          role: 'assistant',
          content: '',
          parts: [
            { type: 'tool', toolCallId: 'call_2', name: 'WebSearch', args: { query: 'rust' }, result: 'Rust lang', status: 'ok' },
          ],
        },
      ],
      currentInput: '继续',
      systemPrompt: 'sys',
      state: emptyCompressState(),
      threshold: 1,
      recentWindowTurns: 2, // 保留全部 2 轮（含工具），只摘要无
      tier: 'fast',
    });

    // 应有 assistant 带 tool_calls 的消息
    const assistantWithTools = result.messages.find(
      (m) => m.role === 'assistant' && Array.isArray((m as { tool_calls?: unknown[] }).tool_calls),
    );
    expect(assistantWithTools).toBeTruthy();
    // 应有 role:'tool' 消息，且 tool_call_id 与 tool_calls 配对
    const toolMsgs = result.messages.filter((m) => m.role === 'tool') as Array<{ role: 'tool'; tool_call_id: string; content: string }>;
    expect(toolMsgs.length).toBeGreaterThan(0);
    expect(toolMsgs.some((m) => m.tool_call_id === 'call_1')).toBe(true);
    expect(toolMsgs.some((m) => m.tool_call_id === 'call_2')).toBe(true);
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

  it('token 估算用 CJK/拉丁加权（不再用单一 /1.5）', async () => {
    // systemPrompt 含中文与英文混合，估算应反映加权（而非纯 chars/1.5）。
    const result = await buildContextMessages({
      turns: [{ role: 'user', content: '你好' }],
      currentInput: '继续',
      systemPrompt: 's'.repeat(600), // 纯英文 600 字符 → /4 = 150 token
      state: emptyCompressState(),
      tier: 'fast',
    });
    // 纯英文 600 字符：旧 /1.5 = 400 token，新 /4 = 150 token。
    expect(result.breakdown.estimatedTokens.system).toBe(150);
  });

  it('compressInfo 字段为 token 维度（currentTokens/remainingTokens）', async () => {
    const result = await buildContextMessages({
      turns: [{ role: 'user', content: '你好世界' }],
      currentInput: '继续',
      systemPrompt: 'sys',
      state: emptyCompressState(),
      threshold: 100,
      tier: 'fast',
    });
    expect(result.breakdown.compressInfo).toHaveProperty('currentTokens');
    expect(result.breakdown.compressInfo).toHaveProperty('remainingTokens');
    expect(result.breakdown.compressInfo).not.toHaveProperty('currentChars');
    expect(typeof result.breakdown.compressInfo.currentTokens).toBe('number');
  });
});

describe('compressHistoryManually（手动压缩）', () => {
  beforeEach(() => {
    mockChatComplete.mockReset();
  });

  it('可压缩的早期轮进摘要，近窗口 + 包轮保留', async () => {
    mockChatComplete.mockResolvedValue('摘要：做了天气插件');
    const result = await compressHistoryManually({
      turns: [
        { role: 'user', content: '做一个天气插件' },
        { role: 'assistant', content: '好的开始' },
        { role: 'user', content: '加设置页' },
        { role: 'assistant', content: '明白' },
        { role: 'user', content: '```lingfang-plugin\n{"id":"demo"}\n```' },
        { role: 'assistant', content: '已生成 demo' },
        { role: 'user', content: '再优化一下' },
        { role: 'assistant', content: '好的' },
      ],
      state: emptyCompressState(),
      recentWindowTurns: 1, // 只保留最近 1 轮（2 条）
      tier: 'fast',
    });

    expect(mockChatComplete).toHaveBeenCalledTimes(1);
    expect(result.compressedCount).toBeGreaterThan(0);
    expect(result.summary).toContain('天气插件');
    // 包轮（下标 4）必须保留
    expect(result.keptTurnIndices).toContain(4);
    // 近窗口（下标 6、7）必须保留
    expect(result.keptTurnIndices).toContain(6);
    expect(result.keptTurnIndices).toContain(7);
    // 早期可压缩轮（0、1）不保留
    expect(result.keptTurnIndices).not.toContain(0);
    expect(result.keptTurnIndices).not.toContain(1);
    // 保留下标按原序
    const sorted = [...result.keptTurnIndices].sort((a, b) => a - b);
    expect(result.keptTurnIndices).toEqual(sorted);
  });

  it('对话很短（无可压缩轮）：不调摘要，全保留', async () => {
    const result = await compressHistoryManually({
      turns: [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '嗨' },
      ],
      state: emptyCompressState(),
      recentWindowTurns: 4,
      tier: 'fast',
    });
    expect(mockChatComplete).not.toHaveBeenCalled();
    expect(result.compressedCount).toBe(0);
    expect(result.keptTurnIndices).toEqual([0, 1]);
  });

  it('带工具调用的早期轮：工具结果也进摘要文本', async () => {
    mockChatComplete.mockImplementation(async (messages) => {
      // 验证摘要输入里包含了工具结果的渲染文本
      const allContent = messages.map((m) => m.content).join('\n');
      expect(allContent).toContain('WebSearch');
      expect(allContent).toContain('Tauri 2.0');
      return '摘要：搜索了 tauri';
    });
    await compressHistoryManually({
      turns: [
        { role: 'user', content: '搜索 tauri' },
        {
          role: 'assistant',
          content: '',
          parts: [
            { type: 'tool', toolCallId: 'c1', name: 'WebSearch', args: { query: 'tauri' }, result: 'Tauri 2.0', status: 'ok' },
          ],
        },
        { role: 'user', content: '基于搜索结果做插件' },
        { role: 'assistant', content: '好的' },
      ],
      state: emptyCompressState(),
      recentWindowTurns: 1,
      tier: 'fast',
    });
    expect(mockChatComplete).toHaveBeenCalledTimes(1);
  });

  it('摘要失败：抛错（不静默丢轮）', async () => {
    mockChatComplete.mockRejectedValue(new Error('网络错误'));
    await expect(compressHistoryManually({
      turns: [
        { role: 'user', content: '需求1' },
        { role: 'assistant', content: '回复1' },
        { role: 'user', content: '需求2' },
        { role: 'assistant', content: '回复2' },
      ],
      state: emptyCompressState(),
      recentWindowTurns: 1,
      tier: 'fast',
    })).rejects.toThrow('网络错误');
  });

  it('增量合并：已有 summary 与新可压缩轮一起进摘要', async () => {
    mockChatComplete.mockResolvedValue('合并摘要：含旧摘要 + 新轮');
    const result = await compressHistoryManually({
      turns: [
        { role: 'user', content: '早期需求' },
        { role: 'assistant', content: '早期回复' },
        { role: 'user', content: '近期' },
        { role: 'assistant', content: '近期回复' },
      ],
      state: { lastSummarizedIndex: 0, summary: '已有摘要：之前做了计算器' },
      recentWindowTurns: 1,
      tier: 'fast',
    });
    expect(result.summary).toContain('合并摘要');
    // 验证摘要输入包含了已有 summary
    const inputContent = mockChatComplete.mock.calls[0]?.[0]?.map((m: { content: string }) => m.content).join('\n') ?? '';
    expect(inputContent).toContain('已有摘要：之前做了计算器');
  });
});
