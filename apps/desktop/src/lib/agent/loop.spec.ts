// loop.spec.ts —— 自建 agent 循环核心逻辑单测。
//
// 验证 runAgentLoop 的：
//  - 纯文本响应（无工具调用）→ 单轮结束
//  - 工具调用 → 执行 → 回灌 → 再轮 → 最终文本
//  - abort（用户取消）
//  - 工具错误处理（ToolResult.ok:false）
//
// mock 策略：拦截 global fetch，返回构造的 SSE 流。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { configureApiBase, setAuthToken } from '@/lib/api';
import { runAgentLoop } from './loop';
import type { ToolDefinition, LoopCallbacks, ChatMessage } from './types';

// === SSE 流构造辅助 ===

/** 把一组 chunk data 拼成 SSE 响应体（每个 data: 一行，事件间空行）。 */
function sseBody(chunks: object[]): string {
  return chunks.map((c) => `data: ${JSON.stringify(c)}`).join('\n\n') + '\n\ndata: [DONE]\n\n';
}

/** 构造 content delta chunk。 */
function contentDelta(text: string, role: 'assistant' = 'assistant') {
  return { choices: [{ index: 0, delta: { role, content: text } }] };
}

/** 构造 tool_calls delta chunk（首个分片含 id+name，后续只含 arguments 增量）。 */
function toolCallDelta(index: number, opts: { id?: string; name?: string; arguments?: string }) {
  return {
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index,
              ...(opts.id != null ? { id: opts.id } : {}),
              type: 'function',
              function: {
                ...(opts.name != null ? { name: opts.name } : {}),
                ...(opts.arguments != null ? { arguments: opts.arguments } : {}),
              },
            },
          ],
        },
      },
    ],
  };
}

/** 构造 finish_reason chunk（流结束时上游告知停止原因）。 */
function finishChunk(reason: string) {
  return { choices: [{ index: 0, delta: {}, finish_reason: reason }] };
}

/** 构造一个返回给定 SSE 的 fetch mock（含 usage chunk）。 */
function mockFetchOnce(sseText: string) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sseText));
      controller.close();
    },
  });
  return vi
    .fn()
    .mockResolvedValue(
      new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    );
}

// === 测试 ===

const originalFetch = globalThis.fetch;

beforeEach(() => {
  configureApiBase('http://test.local');
  setAuthToken('test-token');
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  configureApiBase(null);
  setAuthToken(null);
  vi.restoreAllMocks();
});

function makeCallbacks(): LoopCallbacks & {
  calls: string[];
  outputs: Array<{ name: string; result: unknown; ok: boolean }>;
} {
  const calls: string[] = [];
  const outputs: Array<{ name: string; result: unknown; ok: boolean }> = [];
  return {
    calls,
    outputs,
    onTextDelta: (d) => calls.push(`text:${d}`),
    onReasoningDelta: (d) => calls.push(`reasoning:${d}`),
    onReasoningEnd: () => calls.push('reasoningEnd'),
    onToolCall: (c) => calls.push(`toolCall:${c.name}`),
    onToolOutput: (o) => {
      calls.push(`toolOutput:${o.name}:${o.ok ? 'ok' : 'err'}`);
      outputs.push({ name: o.name, result: o.result, ok: o.ok });
    },
  };
}

describe('runAgentLoop', () => {
  it('纯文本响应：单轮结束，回调收到 text delta', async () => {
    globalThis.fetch = mockFetchOnce(sseBody([contentDelta('你好'), contentDelta('世界')]));
    const cbs = makeCallbacks();
    const result = await runAgentLoop({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      tier: 'fast',
      signal: new AbortController().signal,
      callbacks: cbs,
    });
    expect(result.status).toBe('done');
    expect(result.toolCallCount).toBe(0);
    expect(cbs.calls).toEqual(expect.arrayContaining(['text:你好', 'text:世界']));
  });

  it('工具调用 → 执行 → 回灌 → 第二轮文本', async () => {
    // 第一次 fetch：模型决定调工具
    const fetch1 = sseBody([
      toolCallDelta(0, { id: 'call_1', name: 'Echo', arguments: '{"msg":"' }),
      toolCallDelta(0, { arguments: 'hello"}' }),
    ]);
    // 第二次 fetch：工具结果回灌后，模型给最终文本
    const fetch2 = sseBody([contentDelta('完成')]);

    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      const encoder = new TextEncoder();
      const text = callCount === 1 ? fetch1 : fetch2;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(text));
          controller.close();
        },
      });
      return Promise.resolve(
        new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      );
    });

    const echoTool: ToolDefinition = {
      name: 'Echo',
      description: '回显',
      parameters: { type: 'object', properties: { msg: { type: 'string' } } },
      execute: async (args) => ({ ok: true, data: `echo:${(args as { msg?: string }).msg}` }),
    };
    const cbs = makeCallbacks();
    const result = await runAgentLoop({
      messages: [{ role: 'user', content: 'echo hello' }],
      tools: [echoTool],
      tier: 'fast',
      signal: new AbortController().signal,
      callbacks: cbs,
    });
    expect(result.status).toBe('done');
    expect(result.toolCallCount).toBe(1);
    expect(cbs.calls).toContain('toolCall:Echo');
    expect(cbs.calls).toContain('toolOutput:Echo:ok');
    expect(cbs.calls).toContain('text:完成');
  });

  it('工具错误：ToolResult.ok:false → onToolOutput 收到 err', async () => {
    globalThis.fetch = mockFetchOnce(
      sseBody([toolCallDelta(0, { id: 'call_1', name: 'Fail', arguments: '{}' })])
    );
    // 第二轮（工具失败后模型应收到错误并回复）
    globalThis.fetch = vi
      .fn()
      .mockImplementationOnce(
        mockFetchOnce(sseBody([toolCallDelta(0, { id: 'call_1', name: 'Fail', arguments: '{}' })]))
      )
      .mockImplementationOnce(mockFetchOnce(sseBody([contentDelta('抱歉')])));

    const failTool: ToolDefinition = {
      name: 'Fail',
      description: '总是失败',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ ok: false, error: '故意失败' }),
    };
    const cbs = makeCallbacks();
    const result = await runAgentLoop({
      messages: [{ role: 'user', content: 'test' }],
      tools: [failTool],
      tier: 'fast',
      signal: new AbortController().signal,
      callbacks: cbs,
    });
    expect(result.status).toBe('done');
    expect(cbs.calls).toContain('toolOutput:Fail:err');
  });

  it('abort：用户取消返回 status:aborted', async () => {
    const controller = new AbortController();
    // fetch 抛 AbortError（模拟 signal abort）
    globalThis.fetch = vi.fn().mockImplementation(({ signal }) => {
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    });
    const cbs = makeCallbacks();
    const promise = runAgentLoop({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      tier: 'fast',
      signal: controller.signal,
      callbacks: cbs,
    });
    // 稍后取消
    setTimeout(() => controller.abort(), 10);
    const result = await promise;
    expect(result.status).toBe('aborted');
  });

  it('大文件 arguments 分片拼接：12000 字符 content 切多 chunk 仍能正确解析', async () => {
    // 模拟模型写一个大文件：arguments 被切成多个 chunk（真实场景：长 content 分片下发）
    const bigContent = 'x'.repeat(12000);
    const fullArgs = JSON.stringify({ path: 'big.py', content: bigContent });
    // 把 fullArgs 切成 4 段（模拟 SSE 分片）
    const chunkSize = Math.ceil(fullArgs.length / 4);
    const argChunks = [];
    for (let i = 0; i < fullArgs.length; i += chunkSize) {
      argChunks.push(fullArgs.slice(i, i + chunkSize));
    }

    const fetch1Chunks = [
      toolCallDelta(0, { id: 'call_1', name: 'Write', arguments: argChunks[0] ?? '' }),
    ];
    for (let i = 1; i < argChunks.length; i++) {
      fetch1Chunks.push(toolCallDelta(0, { arguments: argChunks[i] }));
    }
    const fetch1 = sseBody(fetch1Chunks);
    const fetch2 = sseBody([contentDelta('完成')]);

    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      const encoder = new TextEncoder();
      const text = callCount === 1 ? fetch1 : fetch2;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(text));
          controller.close();
        },
      });
      return Promise.resolve(
        new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      );
    });

    let capturedArgs: unknown = null;
    const writeTool: ToolDefinition = {
      name: 'Write',
      description: '写文件',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
      },
      execute: async (args) => {
        capturedArgs = args;
        return { ok: true, data: '已写入' };
      },
    };
    const cbs = makeCallbacks();
    const result = await runAgentLoop({
      messages: [{ role: 'user', content: '写大文件' }],
      tools: [writeTool],
      tier: 'fast',
      signal: new AbortController().signal,
      callbacks: cbs,
    });
    expect(result.status).toBe('done');
    expect(cbs.calls).toContain('toolOutput:Write:ok');
    // 关键断言：分片拼接后参数完整，不是 {}
    expect(capturedArgs).toEqual({ path: 'big.py', content: bigContent });
  });

  it('畸形 arguments：解析失败时回灌错误给模型，不静默用 {} 执行', async () => {
    // 模型传了被截断的 arguments（缺少闭合 }）
    const fetch1 = sseBody([
      toolCallDelta(0, {
        id: 'call_1',
        name: 'Write',
        arguments: '{"path":"gui.py","content":"miss',
      }),
    ]);
    const fetch2 = sseBody([contentDelta('好的，我重新传完整参数')]);

    let callCount = 0;
    let executeCalled = false;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      const encoder = new TextEncoder();
      const text = callCount === 1 ? fetch1 : fetch2;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(text));
          controller.close();
        },
      });
      return Promise.resolve(
        new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      );
    });

    const writeTool: ToolDefinition = {
      name: 'Write',
      description: '写文件',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
      },
      execute: async () => {
        executeCalled = true; // 不应该被调用
        return { ok: true, data: '不应到达' };
      },
    };
    const cbs = makeCallbacks();
    await runAgentLoop({
      messages: [{ role: 'user', content: '写文件' }],
      tools: [writeTool],
      tier: 'fast',
      signal: new AbortController().signal,
      callbacks: cbs,
    });
    // 关键：execute 不应被调用（参数解析失败时不执行工具）
    expect(executeCalled).toBe(false);
    // 工具输出应该是 error（参数解析失败错误回灌）
    expect(cbs.calls.some((c) => c.startsWith('toolOutput:Write:err'))).toBe(true);
  });

  it('max_tokens 截断（finish_reason=length）：不执行工具，回灌分块提示', async () => {
    // 模拟上游因 max_tokens 截断：arguments 只传了一半，finish_reason='length'
    const fetch1 = sseBody([
      toolCallDelta(0, {
        id: 'call_1',
        name: 'Write',
        arguments: '{"path":"big.py","content":"xxx',
      }),
      finishChunk('length'), // 截断信号
    ]);
    // 第二轮：模型看到分块提示后，改用小块写入
    const fetch2 = sseBody([contentDelta('好的，我分块写')]);

    let callCount = 0;
    let executeCalled = false;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      const encoder = new TextEncoder();
      const text = callCount === 1 ? fetch1 : fetch2;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(text));
          controller.close();
        },
      });
      return Promise.resolve(
        new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      );
    });

    const writeTool: ToolDefinition = {
      name: 'Write',
      description: '写文件',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
      },
      execute: async () => {
        executeCalled = true; // 截断时不应执行
        return { ok: true, data: '不应到达' };
      },
    };
    const cbs = makeCallbacks();
    await runAgentLoop({
      messages: [{ role: 'user', content: '写大文件' }],
      tools: [writeTool],
      tier: 'fast',
      signal: new AbortController().signal,
      callbacks: cbs,
    });
    // 关键：截断时不执行工具
    expect(executeCalled).toBe(false);
    // 回灌的错误应包含分块提示
    const truncOutput = cbs.outputs.find((o) => o.name === 'Write' && !o.ok);
    expect(truncOutput).toBeTruthy();
    expect(String(truncOutput?.result)).toMatch(/截断|拆成更小|分块/);
  });

  it('连续截断早终止：连续 3 次 finish_reason=length 直接 failed，不空转到 max_turns', async () => {
    // 模拟模型对大附件整段重写：连续 3 轮都被上游 max_tokens 截断，参数不完整。
    const truncatedResp = sseBody([
      toolCallDelta(0, {
        id: 'call_1',
        name: 'Write',
        arguments: '{"path":"big.py","content":"xxx',
      }),
      finishChunk('length'),
    ]);
    // 前 3 次 fetch 都返回截断；第 4 次不应被调用（第 3 次截断后即 failed 返回）。
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount > 3) throw new Error('不应发起第 4 次模型调用：连续截断应早终止');
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(truncatedResp));
          controller.close();
        },
      });
      return Promise.resolve(
        new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      );
    });

    let executeCalled = false;
    const writeTool: ToolDefinition = {
      name: 'Write',
      description: '写文件',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
      },
      execute: async () => {
        executeCalled = true; // 截断时不应执行
        return { ok: true, data: '不应到达' };
      },
    };
    const cbs = makeCallbacks();
    const result = await runAgentLoop({
      messages: [{ role: 'user', content: '写大附件文件' }],
      tools: [writeTool],
      tier: 'fast',
      signal: new AbortController().signal,
      callbacks: cbs,
    });
    // 关键断言：连续截断达阈值后直接 failed，不再空转到 max_turns。
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/连续.*截断/);
    expect(result.error).toMatch(/重试/);
    // 仅发起 3 次模型调用（第 3 次截断后即返回，无第 4 次）。
    expect(callCount).toBe(3);
    // 截断时工具 execute 不应被调用。
    expect(executeCalled).toBe(false);
  });

  it('contextBudget 护栏：超预算时丢弃最早历史并注入压缩提示（不破坏 tool 配对）', async () => {
    // 构造大量历史消息，使总 token 远超 budget。
    // 含 assistant(tool_calls) + role:tool 配对，验证压缩后不留下孤立 tool result。
    const bigText = 'x'.repeat(2000); // 每条约 500 token
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: `早期问题 ${bigText}` },
      { role: 'assistant', content: `早期回复 ${bigText}` },
      { role: 'user', content: `早期问题2 ${bigText}` },
      { role: 'assistant', content: `早期回复2 ${bigText}` },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_recent',
            type: 'function',
            function: { name: 'WebSearch', arguments: '{"query":"x"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_recent', content: '近期工具结果' },
      { role: 'user', content: '近期问题' },
    ];

    // 捕获发给 fetch 的 body.messages，断言压缩后的形态。
    let capturedMessages: Array<{ role: string; content?: string | null }> = [];
    globalThis.fetch = vi.fn().mockImplementation(((_url: string, init: RequestInit) => {
      try {
        const body = JSON.parse(String(init.body)) as {
          messages: Array<{ role: string; content?: string | null }>;
        };
        capturedMessages = body.messages;
      } catch {
        /* 忽略 */
      }
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder();
              controller.enqueue(encoder.encode(sseBody([contentDelta('好的')])));
              controller.close();
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } }
        )
      );
    }) as typeof globalThis.fetch);

    const cbs = makeCallbacks();
    const result = await runAgentLoop({
      messages,
      tools: [],
      tier: 'fast',
      contextBudget: 1000, // 远小于实际 token，强制压缩
      signal: new AbortController().signal,
      callbacks: cbs,
    });
    expect(result.status).toBe('done');

    // 断言 1：发出去的消息数远少于原始（压缩生效）。
    expect(capturedMessages.length).toBeLessThan(messages.length);
    // 断言 2：保留了首条 system prompt。
    expect(capturedMessages[0]).toMatchObject({ role: 'system', content: 'sys' });
    // 断言 3：注入了压缩提示 system 消息。
    expect(
      capturedMessages.some(
        (m) =>
          m.role === 'system' &&
          typeof m.content === 'string' &&
          m.content.includes('运行中历史压缩')
      )
    ).toBe(true);
    // 断言 4：保留了近期的 tool_calls + tool result 配对（不是孤立的 tool result）。
    const toolResultIdx = capturedMessages.findIndex((m) => m.role === 'tool');
    if (toolResultIdx >= 0) {
      // tool result 前一条必须是带 tool_calls 的 assistant（OpenAI 配对要求）。
      const prev = capturedMessages[toolResultIdx - 1];
      expect(prev).toBeTruthy();
      expect(prev.role).toBe('assistant');
    }
    // 断言 5：近期的 user 消息保留。
    expect(capturedMessages.some((m) => m.role === 'user' && m.content === '近期问题')).toBe(true);
  });

  it('contextBudget 未超：不压缩，原文发出', async () => {
    let capturedMessages: Array<{ role: string; content?: string | null }> = [];
    globalThis.fetch = vi.fn().mockImplementation(((_url: string, init: RequestInit) => {
      try {
        const body = JSON.parse(String(init.body)) as {
          messages: Array<{ role: string; content?: string | null }>;
        };
        capturedMessages = body.messages;
      } catch {
        /* 忽略 */
      }
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder();
              controller.enqueue(encoder.encode(sseBody([contentDelta('好的')])));
              controller.close();
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } }
        )
      );
    }) as typeof globalThis.fetch);

    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '嗨' },
    ];
    const cbs = makeCallbacks();
    await runAgentLoop({
      messages,
      tools: [],
      tier: 'fast',
      contextBudget: 100_000, // 远大于实际，不触发压缩
      signal: new AbortController().signal,
      callbacks: cbs,
    });
    // 原文发出，无压缩提示。
    expect(capturedMessages.length).toBe(3);
    expect(
      capturedMessages.some(
        (m) =>
          m.role === 'system' &&
          typeof m.content === 'string' &&
          m.content.includes('运行中历史压缩')
      )
    ).toBe(false);
  });
});
