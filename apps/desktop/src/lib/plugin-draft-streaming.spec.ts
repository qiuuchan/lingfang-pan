import { describe, expect, it } from 'vitest';
import {
  capitalizeModel,
  aggregateToolCards,
  splitToolText,
  extractAskUserQuestions,
  extractAskUserQuestionsForCard,
  formatToolInput,
  EFFORT_LEVELS,
  EFFORT_LABEL,
} from './plugin-draft';

// === R1 capitalizeModel：模型名首字母大写 ===

describe('capitalizeModel', () => {
  it('小写 id 首字母大写（sonnet→Sonnet）', () => {
    expect(capitalizeModel('sonnet')).toBe('Sonnet');
    expect(capitalizeModel('opus')).toBe('Opus');
    expect(capitalizeModel('haiku')).toBe('Haiku');
    expect(capitalizeModel('fable')).toBe('Fable');
  });

  it('复合 id 仅首字符大写（gpt-5.1-codex 保持连字符）', () => {
    expect(capitalizeModel('gpt-5.1-codex')).toBe('Gpt-5.1-codex');
  });

  it('default 显示为「默认模型」', () => {
    expect(capitalizeModel('default')).toBe('默认模型');
  });

  it('空值返回空串', () => {
    expect(capitalizeModel('')).toBe('');
    expect(capitalizeModel(null)).toBe('');
    expect(capitalizeModel(undefined)).toBe('');
    expect(capitalizeModel('   ')).toBe('');
  });

  it('首字符非字母保持原样', () => {
    expect(capitalizeModel('5-model')).toBe('5-model');
  });

  it('已大写的不重复处理', () => {
    expect(capitalizeModel('Sonnet')).toBe('Sonnet');
  });
});

// === EffortLevel 常量：取值与文案完整 ===

describe('EffortLevel 常量', () => {
  it('EFFORT_LEVELS 含 max/high/medium/low/none 五档', () => {
    expect(EFFORT_LEVELS).toEqual(['max', 'high', 'medium', 'low', 'none']);
  });

  it('EFFORT_LABEL 每档有中文文案', () => {
    for (const level of EFFORT_LEVELS) {
      expect(typeof EFFORT_LABEL[level]).toBe('string');
      expect(EFFORT_LABEL[level].length).toBeGreaterThan(0);
    }
  });
});

// === R3/R4 工具卡片解析：splitToolText / aggregateToolCards / extractAskUserQuestions / formatToolInput ===

describe('splitToolText', () => {
  it('有 name 头：拆出 name + 余下 json', () => {
    expect(splitToolText('Read {"path":"a.ts"}')).toEqual({ name: 'Read', jsonPart: '{"path":"a.ts"}' });
  });

  it('纯 json 片段（input_json_delta）：name 为空', () => {
    expect(splitToolText('{"path":"b')).toEqual({ name: '', jsonPart: '{"path":"b' });
  });

  it('仅 name 无入参：jsonPart 为空', () => {
    expect(splitToolText('Read')).toEqual({ name: 'Read', jsonPart: '' });
  });

  it('空串返回空对', () => {
    expect(splitToolText('')).toEqual({ name: '', jsonPart: '' });
    expect(splitToolText('   ')).toEqual({ name: '', jsonPart: '' });
  });

  it('前导空白被 trim', () => {
    expect(splitToolText('  Write {}')).toEqual({ name: 'Write', jsonPart: '{}' });
  });
});

describe('aggregateToolCards', () => {
  it('content_block_start（带 name）开启新卡片', () => {
    const cards = aggregateToolCards(['Read {"path":"a.ts"}']);
    expect(cards).toEqual([{ name: 'Read', inputText: '{"path":"a.ts"}' }]);
  });

  it('input_json_delta 累积到最近卡片', () => {
    // start Read {}（空 input）+ 两段 input 增量拼成完整 input。
    const cards = aggregateToolCards([
      'Read {}',
      '{"path":"b',
      '.ts"}',
    ]);
    expect(cards.length).toBe(1);
    expect(cards[0].name).toBe('Read');
    expect(cards[0].inputText).toContain('"path"');
    expect(cards[0].inputText).toContain('b.ts');
  });

  it('多工具按序产出独立卡片', () => {
    const cards = aggregateToolCards(['Read {"path":"a"}', 'Write {"path":"b"}']);
    expect(cards.map((c) => c.name)).toEqual(['Read', 'Write']);
  });

  it('无 name 头的纯片段建空名卡片兜底', () => {
    const cards = aggregateToolCards(['{"x":1}']);
    expect(cards.length).toBe(1);
    expect(cards[0].name).toBe('');
    expect(cards[0].inputText).toBe('{"x":1}');
  });

  it('空数组返回空', () => {
    expect(aggregateToolCards([])).toEqual([]);
  });
});

describe('extractAskUserQuestions', () => {
  it('AskUserQuestion 完整 input 解析出 questions', () => {
    const cards = [{
      name: 'AskUserQuestion',
      inputText: JSON.stringify({
        questions: [
          {
            question: '选哪个方案？',
            header: '确认方案',
            options: [{ label: 'A', description: '方案一' }, { label: 'B' }],
          },
        ],
      }),
    }];
    const qs = extractAskUserQuestions(cards);
    expect(qs.length).toBe(1);
    expect(qs[0].question).toBe('选哪个方案？');
    expect(qs[0].header).toBe('确认方案');
    expect(qs[0].options.length).toBe(2);
    expect(qs[0].options[0]).toEqual({ label: 'A', description: '方案一' });
    expect(qs[0].options[1]).toEqual({ label: 'B', description: undefined });
  });

  it('options 为字符串数组时转 label', () => {
    const cards = [{
      name: 'AskUserQuestion',
      inputText: JSON.stringify({ questions: [{ question: '用哪个？', options: ['红', '蓝'] }] }),
    }];
    const qs = extractAskUserQuestions(cards);
    expect(qs[0].options).toEqual([{ label: '红' }, { label: '蓝' }]);
  });

  it('input 未闭合 JSON（增量中）跳过不抛错', () => {
    const cards = [{ name: 'AskUserQuestion', inputText: '{"questions":[{"question":"选' }];
    expect(extractAskUserQuestions(cards)).toEqual([]);
  });

  it('非 AskUserQuestion 工具不产出问题', () => {
    const cards = [{ name: 'Read', inputText: '{"path":"a.ts"}' }];
    expect(extractAskUserQuestions(cards)).toEqual([]);
  });

  it('无可选项的问题被丢弃', () => {
    const cards = [{
      name: 'AskUserQuestion',
      inputText: JSON.stringify({ questions: [{ question: '空的', options: [] }] }),
    }];
    expect(extractAskUserQuestions(cards)).toEqual([]);
  });

  it('多问全部提取', () => {
    const cards = [{
      name: 'AskUserQuestion',
      inputText: JSON.stringify({
        questions: [
          { question: '问1', options: [{ label: 'a' }, { label: 'b' }] },
          { question: '问2', options: [{ label: 'c' }, { label: 'd' }] },
        ],
      }),
    }];
    expect(extractAskUserQuestions(cards).length).toBe(2);
  });
});

// === STREAM-01 / DRAFT-03 修复：extractAskUserQuestionsForCard 按卡片就地解析 ===
describe('extractAskUserQuestionsForCard', () => {
  it('AskUserQuestion 卡片就地解析其承载的 questions（与卡片 1:1 对齐）', () => {
    const card = {
      name: 'AskUserQuestion',
      inputText: JSON.stringify({
        questions: [
          { question: '选哪个？', options: [{ label: 'A' }, { label: 'B' }] },
        ],
      }),
    };
    const qs = extractAskUserQuestionsForCard(card);
    expect(qs.length).toBe(1);
    expect(qs[0].question).toBe('选哪个？');
    expect(qs[0].options.length).toBe(2);
  });

  it('单卡多问（Claude AskUserQuestion questions 字段 1-4 项）全部解析', () => {
    // STREAM-01 核心场景：单卡 2 个 question 此前用全局下标只渲染第 1 个，后续被吞。
    // 按卡片就地解析后两问都返回，渲染方对每个 question 各渲染一张 ToolCard。
    const card = {
      name: 'AskUserQuestion',
      inputText: JSON.stringify({
        questions: [
          { question: '问1', options: [{ label: 'a' }, { label: 'b' }] },
          { question: '问2', options: [{ label: 'c' }, { label: 'd' }] },
        ],
      }),
    };
    expect(extractAskUserQuestionsForCard(card).length).toBe(2);
  });

  it('非 AskUserQuestion 卡片返回空数组', () => {
    expect(extractAskUserQuestionsForCard({ name: 'Read', inputText: '{"path":"a.ts"}' })).toEqual([]);
  });

  it('input 未闭合 JSON 跳过不抛错', () => {
    expect(extractAskUserQuestionsForCard({ name: 'AskUserQuestion', inputText: '{"questions":[' })).toEqual([]);
  });

  it('无可选项的问题被丢弃', () => {
    const card = {
      name: 'AskUserQuestion',
      inputText: JSON.stringify({ questions: [{ question: '空', options: [] }] }),
    };
    expect(extractAskUserQuestionsForCard(card)).toEqual([]);
  });
});

describe('formatToolInput', () => {
  it('合法 JSON pretty print', () => {
    expect(formatToolInput('{"path":"a.ts"}')).toBe('{\n  "path": "a.ts"\n}');
  });

  it('未闭合 JSON 原样返回（增量兜底）', () => {
    expect(formatToolInput('{"path":"b')).toBe('{"path":"b');
  });

  it('空串返回空', () => {
    expect(formatToolInput('')).toBe('');
    expect(formatToolInput('   ')).toBe('');
  });
});
