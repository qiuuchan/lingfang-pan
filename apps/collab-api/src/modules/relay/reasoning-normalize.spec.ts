// reasoning-normalize.spec.ts —— OpenAI 流式 reasoning_content 归一化为 <think> 块的单测。
//
// 背景：阶跃星辰/DeepSeek 系上游用非标准 delta.reasoning_content 发思考内容，
// @ai-sdk/openai 不认该字段。relay 在透传时把 reasoning 增量归一化为单个连续的
// <think>…</think> content 块，前端 extractReasoningMiddleware 据此抽回 reasoning。
import { describe, it, expect } from 'vitest';
import { normalizeEventReasoning } from './forwarders';

/** 从归一化输出里抽出 data JSON（取首个 data: 行）。 */
function parseOut(out: string): any[] {
  return out
    .split('\n\n')
    .map((evt) => {
      const line = evt.split('\n').find((l) => l.trim().startsWith('data:'));
      if (!line) return null;
      const payload = line.trim().slice(5).trim();
      if (payload === '[DONE]') return { done: true };
      try {
        return JSON.parse(payload);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

const evt = (obj: unknown) => `data: ${JSON.stringify(obj)}`;

describe('normalizeEventReasoning', () => {
  it('首个 reasoning_content 增量前置 <think>，置 inThinking', () => {
    const { out, nextInThinking } = normalizeEventReasoning(
      evt({ choices: [{ index: 0, delta: { reasoning_content: '用户问' } }] }),
      false
    );
    expect(nextInThinking).toBe(true);
    const [chunk] = parseOut(out);
    expect(chunk.choices[0].delta.content).toBe('<think>用户问');
    expect(chunk.choices[0].delta.reasoning_content).toBeUndefined();
  });

  it('后续 reasoning 增量不再重复 <think>', () => {
    const { out, nextInThinking } = normalizeEventReasoning(
      evt({ choices: [{ index: 0, delta: { reasoning_content: '我是谁' } }] }),
      true
    );
    expect(nextInThinking).toBe(true);
    const [chunk] = parseOut(out);
    expect(chunk.choices[0].delta.content).toBe('我是谁'); // 无 <think> 前缀
  });

  it('思考中遇到正文增量：补 </think> 闭合再拼正文', () => {
    const { out, nextInThinking } = normalizeEventReasoning(
      evt({ choices: [{ index: 0, delta: { content: '我是 Step。' } }] }),
      true
    );
    expect(nextInThinking).toBe(false);
    const [chunk] = parseOut(out);
    expect(chunk.choices[0].delta.content).toBe('</think>我是 Step。');
  });

  it('思考中遇到 tool_call 增量：先补 </think> 闭合，再原样下发 tool_call', () => {
    const toolDelta = {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                type: 'function',
                function: { name: 'gen', arguments: '' },
              },
            ],
          },
        },
      ],
    };
    const { out, nextInThinking } = normalizeEventReasoning(evt(toolDelta), true);
    expect(nextInThinking).toBe(false);
    const events = parseOut(out);
    // 先补闭合 chunk，再原样 tool_call chunk。
    expect(events[0].choices[0].delta.content).toBe('</think>');
    expect(events[1].choices[0].delta.tool_calls[0].id).toBe('call_1');
  });

  it('reasoning→tool_call→reasoning 交错：每段思考都是闭合的独立 <think> 块', () => {
    let inThinking = false;
    const collected: string[] = [];
    const feed = (raw: string) => {
      const r = normalizeEventReasoning(raw, inThinking);
      inThinking = r.nextInThinking;
      for (const c of parseOut(r.out)) {
        if (c.done) continue;
        const d = c.choices?.[0]?.delta?.content;
        if (d) collected.push(d);
      }
    };
    feed(evt({ choices: [{ index: 0, delta: { reasoning_content: '思考A' } }] }));
    feed(
      evt({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'c1',
                  type: 'function',
                  function: { name: 'gen', arguments: '{}' },
                },
              ],
            },
          },
        ],
      })
    );
    feed(evt({ choices: [{ index: 0, delta: { reasoning_content: '思考B' } }] }));
    feed('data: [DONE]');
    const full = collected.join('');
    // tool_call 处闭合后，第二段思考重开 <think>，末尾 DONE 再闭合。
    expect(full).toBe('<think>思考A</think><think>思考B</think>');
  });

  it('非思考态的正文增量原样下发', () => {
    const raw = evt({ choices: [{ index: 0, delta: { content: 'hello' } }] });
    const { out, nextInThinking } = normalizeEventReasoning(raw, false);
    expect(nextInThinking).toBe(false);
    const [chunk] = parseOut(out);
    expect(chunk.choices[0].delta.content).toBe('hello');
  });

  it('[DONE] 时若思考未闭合，补一个 </think> content chunk 再 [DONE]', () => {
    const { out, nextInThinking } = normalizeEventReasoning('data: [DONE]', true);
    expect(nextInThinking).toBe(false);
    const events = parseOut(out);
    expect(events[0].choices[0].delta.content).toBe('</think>');
    expect(events[1].done).toBe(true);
  });

  it('[DONE] 时思考已闭合则原样透传', () => {
    const { out } = normalizeEventReasoning('data: [DONE]', false);
    const events = parseOut(out);
    expect(events[0].done).toBe(true);
    expect(events.length).toBe(1);
  });

  it('带 finish_reason 但无 delta 的收尾 chunk：思考未闭合时前插 </think>', () => {
    const { out, nextInThinking } = normalizeEventReasoning(
      evt({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      true
    );
    expect(nextInThinking).toBe(false);
    const events = parseOut(out);
    // 先补闭合 chunk，再原样收尾 chunk。
    expect(events[0].choices[0].delta.content).toBe('</think>');
    expect(events[1].choices[0].finish_reason).toBe('stop');
  });

  it('完整流：reasoning×2 → 正文×2 → DONE，拼成单个 <think> 块', () => {
    let inThinking = false;
    const collected: string[] = [];
    const feed = (raw: string) => {
      const r = normalizeEventReasoning(raw, inThinking);
      inThinking = r.nextInThinking;
      for (const c of parseOut(r.out)) {
        if (c.done) continue;
        const d = c.choices?.[0]?.delta?.content;
        if (d) collected.push(d);
      }
    };
    feed(evt({ choices: [{ index: 0, delta: { reasoning_content: '思考A' } }] }));
    feed(evt({ choices: [{ index: 0, delta: { reasoning_content: '思考B' } }] }));
    feed(evt({ choices: [{ index: 0, delta: { content: '正文1' } }] }));
    feed(evt({ choices: [{ index: 0, delta: { content: '正文2' } }] }));
    feed('data: [DONE]');
    const full = collected.join('');
    expect(full).toBe('<think>思考A思考B</think>正文1正文2');
  });
});
