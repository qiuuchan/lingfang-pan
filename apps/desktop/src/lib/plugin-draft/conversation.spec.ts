import { describe, expect, it } from 'vitest';
import {
  hasStructuredBlocks,
  makeConversationDraft,
  makeConversationTurn,
  mergeConversationTurn,
  normalizeTurns,
} from '@/lib/plugin-draft';

// === normalizeTurns：相邻同 role 同 content 去重（design §3.3.6 风险点 RISK5） ===

describe('normalizeTurns', () => {
  it('相邻同 role 同 content 去重', () => {
    const turns = [
      { role: 'assistant' as const, content: 'a', at: '1' },
      { role: 'assistant' as const, content: 'a', at: '2' },
    ];
    expect(normalizeTurns(turns)).toHaveLength(1);
  });

  it('不同 content 不去重', () => {
    const turns = [
      { role: 'user' as const, content: 'q1', at: '1' },
      { role: 'assistant' as const, content: 'a1', at: '2' },
      { role: 'user' as const, content: 'q2', at: '3' },
    ];
    expect(normalizeTurns(turns)).toHaveLength(3);
  });

  it('空数组 / undefined 安全', () => {
    expect(normalizeTurns([])).toEqual([]);
    expect(normalizeTurns(undefined)).toEqual([]);
  });
});

// === design §3.1.2 / §8.2：对话优先 gate 与纯对话态草稿（AC1 核心） ===

describe('hasStructuredBlocks', () => {
  it('纯自然语言无围栏块 → false（「你好」不触发结构化解析）', () => {
    expect(hasStructuredBlocks('你好！我是助手，有什么可以帮你的吗？')).toBe(false);
  });

  it('纯文本含普通段落 → false', () => {
    expect(hasStructuredBlocks('这是说明。\n再一段说明。')).toBe(false);
  });

  it('含 manifest 块 → true（自动检测触发）', () => {
    const raw = [
      '```lingfang-manifest json',
      '{ "id": "x", "name": "X" }',
      '```',
    ].join('\n');
    expect(hasStructuredBlocks(raw)).toBe(true);
  });

  it('含 file 块 → true（自动检测触发）', () => {
    const raw = [
      '```file path="ui/index.html"',
      '<div></div>',
      '```',
    ].join('\n');
    expect(hasStructuredBlocks(raw)).toBe(true);
  });

  it('只有 unknown 代码块（裸 ```js）→ false（gate 严格只认 manifest/file）', () => {
    const raw = [
      '```js',
      'console.log("hi")',
      '```',
    ].join('\n');
    expect(hasStructuredBlocks(raw)).toBe(false);
  });

  it('只有 notes 块 → false（notes 不算结构化触发）', () => {
    const raw = [
      '```lingfang-notes',
      '这是一段说明',
      '```',
    ].join('\n');
    expect(hasStructuredBlocks(raw)).toBe(false);
  });

  it('空字符串 / undefined 安全 → false', () => {
    expect(hasStructuredBlocks('')).toBe(false);
  });
});

describe('makeConversationTurn', () => {
  it('产出 user + assistant 一对 turn', () => {
    const turns = makeConversationTurn('你好', '你好！有什么可以帮你？');
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ role: 'user', content: '你好' });
    expect(turns[1]).toMatchObject({ role: 'assistant', content: '你好！有什么可以帮你？' });
  });

  it('assistant 文本为空时兜底占位文案', () => {
    const turns = makeConversationTurn('你好', '');
    expect(turns[1].content).not.toBe('');
    expect(turns[1].role).toBe('assistant');
  });

  it('每个 turn 带时间戳', () => {
    const turns = makeConversationTurn('q', 'a');
    expect(typeof turns[0].at).toBe('string');
    expect(typeof turns[1].at).toBe('string');
  });
});

describe('makeConversationDraft', () => {
  it('产出纯对话态草稿：turns=[u,a] / files=[] / status=generating', () => {
    const draft = makeConversationDraft('你好', '你好！');
    expect(draft.turns).toHaveLength(2);
    expect(draft.files).toEqual([]);
    // AC1 关键：纯对话态绝不取 'invalid'，否则触发 destructive Badge + 预览 disabled。
    expect(draft.status).toBe('chat');
    expect(draft.diagnostics).toEqual([]);
  });

  it('id 非 undefined（有稳定标识）', () => {
    const draft = makeConversationDraft('你好', '你好！');
    expect(typeof draft.id).toBe('string');
    expect(draft.id.length).toBeGreaterThan(0);
  });

  it('可以把 assistant 分块一并写进 turn', () => {
    const draft = makeConversationDraft('你好', '配置完成。', [
      { stream: 'thought', text: '先确认结构。' },
      { stream: 'stdout', text: '配置完成。' },
      { stream: 'tool', text: 'Write {"path":"main.py"}' },
    ]);
    const assistant = draft.turns[1];
    expect(assistant.segments).toEqual([
      { stream: 'thought', text: '先确认结构。' },
      { stream: 'stdout', text: '配置完成。' },
      { stream: 'tool', text: 'Write {"path":"main.py"}' },
    ]);
  });
});

describe('mergeConversationTurn', () => {
  it('在既有纯对话 draft 上累积 turns（+2）', () => {
    const prev = makeConversationDraft('你好', '你好！');
    const baseTurns = prev.turns.length;
    const merged = mergeConversationTurn(prev, '再问一句', '回答你');
    expect(merged.turns.length).toBe(baseTurns + 2);
    expect(merged.turns.some((t) => t.role === 'user' && t.content === '再问一句')).toBe(true);
    expect(merged.turns.some((t) => t.role === 'assistant' && t.content === '回答你')).toBe(true);
  });

  it('累积后 files 仍保持空（纯对话态不被污染）', () => {
    const prev = makeConversationDraft('你好', '你好！');
    const merged = mergeConversationTurn(prev, '再问', '再答');
    expect(merged.files).toEqual([]);
    expect(merged.status).toBe('chat');
  });

  it('prev.id 保持稳定（同一对话跨轮，不新开草稿）', () => {
    const prev = makeConversationDraft('你好', '你好！');
    const prevId = prev.id;
    const merged = mergeConversationTurn(prev, '再问', '再答');
    expect(merged.id).toBe(prevId);
  });

  it('经 normalizeTurns 去重（相邻同 role 同 content）', () => {
    const prev = makeConversationDraft('你好', '你好！');
    const merged = mergeConversationTurn(prev, '你好', '你好！');
    const turns = normalizeTurns(merged.turns);
    for (let i = 1; i < turns.length; i++) {
      if (turns[i].role === turns[i - 1].role) {
        expect(turns[i].content).not.toBe(turns[i - 1].content);
      }
    }
  });
});

