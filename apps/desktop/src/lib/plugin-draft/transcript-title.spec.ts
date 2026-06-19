import { describe, expect, it } from 'vitest';
import {
  deriveTitle,
  summarizeTitleLocally,
  transcriptSegmentsSinceLastInput,
  transcriptTextSinceLastInput,
} from '@/lib/plugin-draft';

// === design §3.3.6 / 问题5 修复：transcriptTextSinceLastInput 只取本轮输出 ===

describe('transcriptTextSinceLastInput', () => {
  // 构造一条 transcript 事件（与 Rust append_transcript 写入的 JSON 行对齐）。
  function ev(event: string, payload: Record<string, unknown> = {}) {
    return { at: '2026-06-13T00:00:00Z', event, payload };
  }

  it('单轮：input 后的 output 全部取到', () => {
    const events = [
      ev('input', { prompt: '你好' }),
      ev('output', { stream: 'stdout', text: '你好！' }),
      ev('output', { stream: 'stdout', text: '有什么可以帮你？' }),
    ];
    expect(transcriptTextSinceLastInput(events, 'stdout')).toBe('你好！有什么可以帮你？');
  });

  it('多轮：只取最后一个 input 之后的 output（不串历史轮次）', () => {
    // 问题5 复现场景：第1轮「你好」→输出 A1；第2轮「你能做什么」→输出 A2。
    // 旧 transcriptText 会拼成 A1+A2，本函数只返回 A2。
    const events = [
      ev('input', { prompt: '你好' }),
      ev('output', { stream: 'stdout', text: '你好！（第1轮输出）' }),
      ev('input', { prompt: '你能做什么', kind: 'followup' }),
      ev('output', { stream: 'stdout', text: '我能做很多事（第2轮输出）' }),
    ];
    const result = transcriptTextSinceLastInput(events, 'stdout');
    expect(result).toBe('我能做很多事（第2轮输出）');
    // 关键回归：绝不含第1轮输出。
    expect(result).not.toContain('第1轮输出');
  });

  it('无 input 事件 → 取全部 output（向后兼容首轮 / 旧数据）', () => {
    const events = [
      ev('output', { stream: 'stdout', text: 'a' }),
      ev('output', { stream: 'stdout', text: 'b' }),
    ];
    expect(transcriptTextSinceLastInput(events, 'stdout')).toBe('ab');
  });

  it('input 后无 output（本轮 CLI 尚未产出）→ 返回空串', () => {
    const events = [
      ev('input', { prompt: '你好' }),
      ev('output', { stream: 'stderr', text: 'some warn' }),
    ];
    expect(transcriptTextSinceLastInput(events, 'stdout')).toBe('');
  });

  it('按 stream 分流：stdout 不混入 stderr', () => {
    const events = [
      ev('input', { prompt: '你好' }),
      ev('output', { stream: 'stdout', text: 'out' }),
      ev('output', { stream: 'stderr', text: 'err' }),
    ];
    expect(transcriptTextSinceLastInput(events, 'stdout')).toBe('out');
    expect(transcriptTextSinceLastInput(events, 'stderr')).toBe('err');
  });

  it('错误事件作为本轮 stderr 可展示文本返回', () => {
    const events = [
      ev('input', { prompt: '你好' }),
      ev('error', { stream: 'stderr', error: 'ClaudeCode SDK 返回错误：HTTP 404 not found' }),
    ];
    expect(transcriptTextSinceLastInput(events, 'stderr')).toBe('ClaudeCode SDK 返回错误：HTTP 404 not found');
  });

  it('空数组 → 返回空串', () => {
    expect(transcriptTextSinceLastInput([], 'stdout')).toBe('');
  });

  it('三轮场景：只取最后一轮（中间轮次与首轮都不串入）', () => {
    const events = [
      ev('input', { prompt: '问1' }),
      ev('output', { stream: 'stdout', text: '答1' }),
      ev('input', { prompt: '问2', kind: 'followup' }),
      ev('output', { stream: 'stdout', text: '答2' }),
      ev('input', { prompt: '问3', kind: 'followup' }),
      ev('output', { stream: 'stdout', text: '答3' }),
    ];
    expect(transcriptTextSinceLastInput(events, 'stdout')).toBe('答3');
  });

  it('问题5 回归对照：transcriptTextSinceLastInput 只取本轮（旧行为已随 DRAFT-06 删除）', () => {
    // DRAFT-06 清理：旧的 transcriptText（多轮串接 bug 行为）已从生产代码移除，
    // 仅以此断言锁定「本轮切片」语义——多轮场景只返回最后一个 input 之后的 output。
    const events = [
      ev('input', { prompt: '你好' }),
      ev('output', { stream: 'stdout', text: '你好回复' }),
      ev('input', { prompt: '你能做什么', kind: 'followup' }),
      ev('output', { stream: 'stdout', text: '能力回复' }),
    ];
    expect(transcriptTextSinceLastInput(events, 'stdout')).toBe('能力回复'); // 新行为（本轮）
    // 关键：绝不串入历史轮次输出。
    expect(transcriptTextSinceLastInput(events, 'stdout')).not.toContain('你好回复');
  });
});

describe('transcriptSegmentsSinceLastInput', () => {
  function ev(event: string, payload: Record<string, unknown> = {}) {
    return { at: '2026-06-13T00:00:00Z', event, payload };
  }

  it('只提取最近一轮 output，并保留 stdout/thought/tool/stderr 分类', () => {
    const events = [
      ev('input', { prompt: '第一轮' }),
      ev('output', { stream: 'stdout', text: '旧回复' }),
      ev('input', { prompt: '第二轮' }),
      ev('output', { stream: 'thought', text: '分析。' }),
      ev('output', { stream: 'stdout', text: '现在写配置：' }),
      ev('output', { stream: 'tool', text: 'Write {"path":"main.py"}' }),
      ev('output', { stream: 'stderr', text: 'warning' }),
    ];

    expect(transcriptSegmentsSinceLastInput(events)).toEqual([
      { stream: 'thought', text: '分析。' },
      { stream: 'stdout', text: '现在写配置：' },
      { stream: 'tool', text: 'Write {"path":"main.py"}' },
      { stream: 'stderr', text: 'warning' },
    ]);
  });

  it('错误事件进入最近一轮 stderr 分段，避免收尾后变成空回复', () => {
    const events = [
      ev('input', { prompt: '你好' }),
      ev('error', { stream: 'stderr', error: 'ClaudeCode SDK 请求失败' }),
    ];

    expect(transcriptSegmentsSinceLastInput(events)).toEqual([
      { stream: 'stderr', text: 'ClaudeCode SDK 请求失败' },
    ]);
  });
});



describe('deriveTitle', () => {
  it('record 已有 title → 原样返回（去空白）', () => {
    expect(deriveTitle({ title: '番茄钟插件' })).toBe('番茄钟插件');
    expect(deriveTitle({ title: '  带空格  ' })).toBe('带空格');
  });

  it('title 为空 → 从 transcript 首 input prompt 截断 24 字', () => {
    const transcript = JSON.stringify({ event: 'input', payload: { prompt: '做一个番茄钟插件' } });
    expect(deriveTitle({}, transcript)).toBe('做一个番茄钟插件');
  });

  it('prompt 超过 24 字 → 截断加省略号', () => {
    const long = '请帮我做一个可以设置二十五分钟和四十五分钟的番茄钟计时器插件';
    const transcript = JSON.stringify({ event: 'input', payload: { prompt: long } });
    const title = deriveTitle({}, transcript);
    expect(title.length).toBeLessThanOrEqual(25); // 24 字 + …
    expect(title.endsWith('…')).toBe(true);
  });

  it('无 title 且无 transcript → 兜底「新对话」', () => {
    expect(deriveTitle({})).toBe('新对话');
    expect(deriveTitle({ title: null })).toBe('新对话');
  });

  it('transcript 无 input 事件 → 兜底「新对话」', () => {
    const transcript = JSON.stringify({ event: 'output', payload: { text: 'hi' } });
    expect(deriveTitle({}, transcript)).toBe('新对话');
  });
});

// === summarizeTitleLocally：本地启发式秒级标题（去祈使前缀，截断16字） ===
describe('summarizeTitleLocally', () => {
  it('去掉祈使前缀拿核心需求', () => {
    expect(summarizeTitleLocally('帮我做一个番茄钟插件', '好的')).toBe('番茄钟插件');
    expect(summarizeTitleLocally('请创建一个倒计时工具', '')).toBe('倒计时工具');
    expect(summarizeTitleLocally('我想实现 Markdown 编辑器', '')).toBe('Markdown 编辑器');
  });

  it('闲聊类（你好/hi）回退 assistant 首行', () => {
    // clean 会去掉标点，"你好！我是 ClaudeCode，很高兴..." → 首句"你好"+第二句"我是 ClaudeCode"
    const title = summarizeTitleLocally('你好', '你好！我是 ClaudeCode，很高兴为你服务。');
    expect(title).toBe('你好我是 ClaudeCode');
  });

  it('截断到 16 字', () => {
    const long = '做一个非常非常非常非常非常非常非常长的插件需求描述';
    expect(summarizeTitleLocally(long, '').length).toBeLessThanOrEqual(16);
  });

  it('空输入兜底新对话', () => {
    expect(summarizeTitleLocally('', '')).toBe('新对话');
  });
});

