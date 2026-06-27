import { describe, expect, it } from 'vitest';
import { createThinkTagStreamParser } from '@/lib/agent/think-tags';

type Event =
  | { type: 'text'; content: string }
  | { type: 'reasoning'; content: string }
  | { type: 'reasoning_end' };

function collect(chunks: string[]): Event[] {
  const events: Event[] = [];
  const parser = createThinkTagStreamParser({
    onText: (content) => events.push({ type: 'text', content }),
    onReasoning: (content) => events.push({ type: 'reasoning', content }),
    onReasoningEnd: () => events.push({ type: 'reasoning_end' }),
  });

  for (const chunk of chunks) parser.feed(chunk);
  parser.flush();
  return events;
}

function joined(events: Event[], type: 'text' | 'reasoning'): string {
  return events.flatMap((event) => (event.type === type ? [event.content] : [])).join('');
}

describe('createThinkTagStreamParser', () => {
  it('splits a complete think block into reasoning and visible answer text', () => {
    const events = collect(['prefix <think>plan</think> answer']);

    expect(joined(events, 'text')).toBe('prefix  answer');
    expect(joined(events, 'reasoning')).toBe('plan');
    expect(events.filter((event) => event.type === 'reasoning_end')).toHaveLength(1);
  });

  it('handles tags split across streamed chunks', () => {
    const events = collect(['hi <thi', 'nk>rea', 'son</thi', 'nk> ok']);

    expect(joined(events, 'text')).toBe('hi  ok');
    expect(joined(events, 'reasoning')).toBe('reason');
    expect(events.filter((event) => event.type === 'reasoning_end')).toHaveLength(1);
  });

  it('drops stray close tags without leaking raw markup', () => {
    const events = collect(['hello</think>world']);

    expect(joined(events, 'text')).toBe('helloworld');
    expect(joined(events, 'reasoning')).toBe('');
  });

  it('closes an unterminated think block on flush', () => {
    const events = collect(['<think>unfinished plan']);

    expect(joined(events, 'text')).toBe('');
    expect(joined(events, 'reasoning')).toBe('unfinished plan');
    expect(events.filter((event) => event.type === 'reasoning_end')).toHaveLength(1);
  });

  it('filters duplicated reasoning leaked before an extra close tag', () => {
    const reasoning = '用户发送了一个简单的问候"你好"，我应该用中文回复，表示友好并询问他们需要什么帮助。这是一个简单的交流，不需要调用任何工具。';
    const events = collect([`<think>${reasoning}</think>${reasoning} </think> 你好！有什么我可以帮助你的吗？`]);

    expect(joined(events, 'reasoning')).toBe(reasoning);
    expect(joined(events, 'text')).toBe('你好！有什么我可以帮助你的吗？');
    expect(joined(events, 'text')).not.toContain('<think>');
    expect(joined(events, 'text')).not.toContain('</think>');
  });
});
