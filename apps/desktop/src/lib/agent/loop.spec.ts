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
import type { ToolDefinition, LoopCallbacks } from './types';

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
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index,
          ...(opts.id != null ? { id: opts.id } : {}),
          type: 'function',
          function: {
            ...(opts.name != null ? { name: opts.name } : {}),
            ...(opts.arguments != null ? { arguments: opts.arguments } : {}),
          },
        }],
      },
    }],
  };
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
  return vi.fn().mockResolvedValue(
    new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
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

function makeCallbacks(): LoopCallbacks & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    onTextDelta: (d) => calls.push(`text:${d}`),
    onReasoningDelta: (d) => calls.push(`reasoning:${d}`),
    onReasoningEnd: () => calls.push('reasoningEnd'),
    onToolCall: (c) => calls.push(`toolCall:${c.name}`),
    onToolOutput: (o) => calls.push(`toolOutput:${o.name}:${o.ok ? 'ok' : 'err'}`),
  };
}

describe('runAgentLoop', () => {
  it('纯文本响应：单轮结束，回调收到 text delta', async () => {
    globalThis.fetch = mockFetchOnce(sseBody([
      contentDelta('你好'),
      contentDelta('世界'),
    ]));
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
        start(controller) { controller.enqueue(encoder.encode(text)); controller.close(); },
      });
      return Promise.resolve(new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
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
    globalThis.fetch = mockFetchOnce(sseBody([
      toolCallDelta(0, { id: 'call_1', name: 'Fail', arguments: '{}' }),
    ]));
    // 第二轮（工具失败后模型应收到错误并回复）
    globalThis.fetch = vi.fn().mockImplementationOnce(mockFetchOnce(sseBody([
      toolCallDelta(0, { id: 'call_1', name: 'Fail', arguments: '{}' }),
    ]))).mockImplementationOnce(mockFetchOnce(sseBody([contentDelta('抱歉')])));

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

    const fetch1Chunks = [toolCallDelta(0, { id: 'call_1', name: 'Write', arguments: argChunks[0] ?? '' })];
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
        start(controller) { controller.enqueue(encoder.encode(text)); controller.close(); },
      });
      return Promise.resolve(new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    });

    let capturedArgs: unknown = null;
    const writeTool: ToolDefinition = {
      name: 'Write',
      description: '写文件',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } },
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
      toolCallDelta(0, { id: 'call_1', name: 'Write', arguments: '{"path":"gui.py","content":"miss' }),
    ]);
    const fetch2 = sseBody([contentDelta('好的，我重新传完整参数')]);

    let callCount = 0;
    let executeCalled = false;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      const encoder = new TextEncoder();
      const text = callCount === 1 ? fetch1 : fetch2;
      const stream = new ReadableStream({
        start(controller) { controller.enqueue(encoder.encode(text)); controller.close(); },
      });
      return Promise.resolve(new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    });

    const writeTool: ToolDefinition = {
      name: 'Write',
      description: '写文件',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } },
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
});
