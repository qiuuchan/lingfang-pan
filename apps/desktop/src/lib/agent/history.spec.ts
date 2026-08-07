// history.spec.ts —— 验证 turnsToMessages 的原生 function calling 历史还原。
import { describe, expect, it } from 'vitest';
import { turnsToMessages, type HistoryTurn } from './history';

describe('turnsToMessages', () => {
  it('纯文本对话：user/assistant 交替', () => {
    const turns: HistoryTurn[] = [
      { role: 'user', content: '帮我做个插件' },
      { role: 'assistant', content: '好的', status: 'done' },
    ];
    const msgs = turnsToMessages(turns, '再加个功能');
    expect(msgs).toEqual([
      { role: 'user', content: '帮我做个插件' },
      { role: 'assistant', content: '好的' },
      { role: 'user', content: '再加个功能' },
    ]);
  });

  it('assistant 调了工具：拆成 assistant(tool_calls) + tool result', () => {
    const turns: HistoryTurn[] = [
      { role: 'user', content: '搜索 tauri' },
      {
        role: 'assistant',
        status: 'done',
        content: '',
        parts: [
          {
            type: 'tool',
            toolCallId: 'call_1',
            name: 'WebSearch',
            args: { query: 'tauri' },
            result: 'Tauri 2.0',
            status: 'ok',
          },
          { type: 'text', content: '找到了 Tauri' },
        ],
      },
    ];
    const msgs = turnsToMessages(turns, '');
    expect(msgs).toEqual([
      { role: 'user', content: '搜索 tauri' },
      {
        role: 'assistant',
        content: '找到了 Tauri',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'WebSearch', arguments: JSON.stringify({ query: 'tauri' }) },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'Tauri 2.0' },
    ]);
  });

  it('多个工具调用：全部配对回灌', () => {
    const turns: HistoryTurn[] = [
      { role: 'user', content: '做插件' },
      {
        role: 'assistant',
        status: 'done',
        content: '',
        parts: [
          {
            type: 'tool',
            toolCallId: 'c1',
            name: 'Read',
            args: { path: 'main.py' },
            result: 'code',
            status: 'ok',
          },
          {
            type: 'tool',
            toolCallId: 'c2',
            name: 'Write',
            args: { path: 'ui/index.html' },
            result: 'ok',
            status: 'ok',
          },
        ],
      },
    ];
    const msgs = turnsToMessages(turns, '');
    // 应该有：user + assistant(2 tool_calls) + 2 个 tool result
    expect(msgs).toHaveLength(4);
    expect(msgs[1]).toMatchObject({
      role: 'assistant',
      tool_calls: expect.arrayContaining([
        expect.objectContaining({ id: 'c1' }),
        expect.objectContaining({ id: 'c2' }),
      ]),
    });
    expect(msgs[2]).toMatchObject({ role: 'tool', tool_call_id: 'c1' });
    expect(msgs[3]).toMatchObject({ role: 'tool', tool_call_id: 'c2' });
  });

  it('running 状态的工具不进历史（未完成无结果）', () => {
    const turns: HistoryTurn[] = [
      { role: 'user', content: 'x' },
      {
        role: 'assistant',
        status: 'done',
        content: '',
        parts: [{ type: 'tool', toolCallId: 'c1', name: 'Read', status: 'running' }],
      },
    ];
    const msgs = turnsToMessages(turns, '');
    // running 工具被过滤，assistant 无 tool_calls 无 text → 不产生消息
    expect(msgs).toEqual([{ role: 'user', content: 'x' }]);
  });

  it('非 done 的 assistant 轮不进历史', () => {
    const turns: HistoryTurn[] = [
      { role: 'user', content: 'x' },
      { role: 'assistant', status: 'failed', content: '出错' },
      { role: 'assistant', status: 'generating', content: '生成中' },
    ];
    const msgs = turnsToMessages(turns, '重试');
    // failed/generating 都不进，只有 user + 重试
    expect(msgs).toEqual([
      { role: 'user', content: 'x' },
      { role: 'user', content: '重试' },
    ]);
  });

  it('重试模式（skipAppendCurrent）：不追加 currentInput', () => {
    const turns: HistoryTurn[] = [
      { role: 'user', content: '已有问题' },
      { role: 'assistant', status: 'done', content: '已有答复' },
    ];
    const msgs = turnsToMessages(turns, '不应出现', true);
    expect(msgs.find((m) => m.role === 'user')).toEqual({ role: 'user', content: '已有问题' });
    expect(msgs.some((m) => m.role === 'user' && m.content === '不应出现')).toBe(false);
  });

  it('对象 result 转 JSON 字符串', () => {
    const turns: HistoryTurn[] = [
      { role: 'user', content: 'x' },
      {
        role: 'assistant',
        status: 'done',
        content: '',
        parts: [
          {
            type: 'tool',
            toolCallId: 'c1',
            name: 'Check',
            result: { errors: [], warnings: [] },
            status: 'ok',
          },
        ],
      },
    ];
    const msgs = turnsToMessages(turns, '');
    const toolMsg = msgs.find((m) => m.role === 'tool') as Extract<
      (typeof msgs)[number],
      { role: 'tool' }
    >;
    expect(toolMsg.content).toBe(JSON.stringify({ errors: [], warnings: [] }));
  });
});
