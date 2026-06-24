// protocol-convert.spec.ts —— OpenAI ⟷ Anthropic 协议转换单测。
import { describe, it, expect } from 'vitest';
import {
  openAiToAnthropicRequest,
  anthropicToOpenAiResponse,
  AnthropicStreamToOpenAi,
} from './protocol-convert';

describe('openAiToAnthropicRequest', () => {
  it('system 消息抽到顶层 system，user/assistant 文本保留', () => {
    const out = openAiToAnthropicRequest({
      model: 'claude-haiku',
      messages: [
        { role: 'system', content: '你是助手' },
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '你好呀' },
      ],
    });
    expect(out.system).toBe('你是助手');
    expect(out.messages).toEqual([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好呀' },
    ]);
    expect(out.max_tokens).toBe(4096); // 默认补齐（Anthropic 必填）
  });

  it('OpenAI tools → Anthropic input_schema；tool_choice required→any', () => {
    const out = openAiToAnthropicRequest({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'upload_plugin', description: '上传', parameters: { type: 'object', properties: { name: { type: 'string' } } } } }],
      tool_choice: 'required',
    });
    expect(out.tools).toEqual([
      { name: 'upload_plugin', description: '上传', input_schema: { type: 'object', properties: { name: { type: 'string' } } } },
    ]);
    expect(out.tool_choice).toEqual({ type: 'any' });
  });

  it('assistant tool_calls → tool_use 块；role:tool → tool_result 块', () => {
    const out = openAiToAnthropicRequest({
      model: 'm',
      messages: [
        { role: 'user', content: '建插件' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'upload_plugin', arguments: '{"name":"x"}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
      ],
    });
    const msgs = out.messages as { role: string; content: unknown }[];
    expect(msgs[1]).toEqual({ role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'upload_plugin', input: { name: 'x' } }] });
    expect(msgs[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '{"ok":true}' }] });
  });
});

describe('anthropicToOpenAiResponse', () => {
  it('text + tool_use → OpenAI message + tool_calls + finish_reason', () => {
    const out = anthropicToOpenAiResponse({
      id: 'msg_1', model: 'claude', stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '好的' },
        { type: 'tool_use', id: 'tu_1', name: 'upload_plugin', input: { name: 'x' } },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    }, 1000);
    const choice = (out.choices as { message: Record<string, unknown>; finish_reason: string }[])[0];
    expect(choice.message.content).toBe('好的');
    expect(choice.message.tool_calls).toEqual([{ id: 'tu_1', type: 'function', function: { name: 'upload_plugin', arguments: '{"name":"x"}' } }]);
    expect(choice.finish_reason).toBe('tool_calls');
    expect(out.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });
});

describe('AnthropicStreamToOpenAi', () => {
  it('message_start→role chunk，text_delta→content chunk，message_stop→finish', () => {
    const c = new AnthropicStreamToOpenAi(1000);
    const e = (o: unknown) => `data: ${JSON.stringify(o)}`;
    const start = c.consume(e({ type: 'message_start', message: { id: 'm1', model: 'claude' } }));
    expect((start[0].choices as { delta: Record<string, unknown> }[])[0].delta).toEqual({ role: 'assistant', content: '' });
    const d1 = c.consume(e({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } }));
    expect((d1[0].choices as { delta: Record<string, unknown> }[])[0].delta).toEqual({ content: '你好' });
    const stop = c.consume(e({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }));
    expect(stop).toEqual([]);
    const end = c.consume(e({ type: 'message_stop' }));
    expect((end[0].choices as { finish_reason: string }[])[0].finish_reason).toBe('stop');
  });

  it('tool_use 流式：content_block_start→tool_calls 头，input_json_delta→arguments 增量', () => {
    const c = new AnthropicStreamToOpenAi(1000);
    const e = (o: unknown) => `data: ${JSON.stringify(o)}`;
    c.consume(e({ type: 'message_start', message: { id: 'm', model: 'c' } }));
    const tcStart = c.consume(e({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'upload_plugin' } }));
    const delta0 = (tcStart[0].choices as { delta: { tool_calls: { index: number; id: string; function: { name: string } }[] } }[])[0].delta;
    expect(delta0.tool_calls[0]).toMatchObject({ index: 0, id: 'tu_1', function: { name: 'upload_plugin', arguments: '' } });
    const tcDelta = c.consume(e({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"name":' } }));
    const delta1 = (tcDelta[0].choices as { delta: { tool_calls: { index: number; function: { arguments: string } }[] } }[])[0].delta;
    expect(delta1.tool_calls[0]).toMatchObject({ index: 0, function: { arguments: '{"name":' } });
  });
});
