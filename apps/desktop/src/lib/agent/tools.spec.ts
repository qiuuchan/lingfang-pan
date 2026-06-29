// tools.spec.ts —— TodoWrite 工具的核心约束单测。
//
// 验证「同一时间至多一项 in_progress」不变式（防止模型把所有任务都标进行中导致 UI 混乱），
// 以及 todo 跨轮延续（getTodos 回灌 → onTodoUpdate 同步）。
// 工具工厂 createAgentTools 走 @openai/agents 的 tool()，execute 通过 mock 回调直接调用。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { configureApiBase, setAuthToken } from '@/lib/api';
import { createAgentTools, type AgentToolsOptions, type TodoItem } from './tools';

/** 构造最小可用的 AgentToolsOptions（所有回调 mock），返回捕获 todo 状态的容器。 */
function makeOpts(initialTodos: TodoItem[] = []) {
  let todos = [...initialTodos];
  const opts: AgentToolsOptions = {
    getPluginId: () => 'test-plugin',
    onPluginCreated: vi.fn(),
    onFilesChanged: vi.fn(),
    onAskQuestion: vi.fn(async () => ({ answer: 'ok' })),
    getTodos: () => [...todos],
    onTodoUpdate: (next) => { todos = [...next]; },
  };
  return { opts, read: () => todos };
}

/** 从 tool() 返回的 Tool 里取出 invoke 并调用（@openai/agents 的契约：invoke(runContext, inputString)）。
 *  input 必须是 JSON 字符串（SDK 内部 parser(input) 会 JSON.parse）；execute 被包在 invoke 里。 */
async function callExecute(tools: ReturnType<typeof createAgentTools>['tools'], name: string, args: unknown) {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return (t as unknown as { invoke: (ctx: unknown, input: string) => Promise<string> }).invoke({}, JSON.stringify(args));
}

describe('TodoWrite 工具', () => {
  it('已注册到工具集', () => {
    const { tools } = createAgentTools(makeOpts().opts);
    expect(tools.some((t) => t.name === 'TodoWrite')).toBe(true);
  });

  it('正常清单（单项 in_progress）→ 覆盖更新 + 回调同步 + 返回渲染摘要', async () => {
    const { opts, read } = makeOpts();
    const { tools } = createAgentTools(opts);
    const todos: TodoItem[] = [
      { content: '第一步', status: 'completed', priority: 'high' },
      { content: '第二步', status: 'in_progress', priority: 'medium' },
      { content: '第三步', status: 'pending', priority: 'low' },
    ];
    const out = await callExecute(tools, 'TodoWrite', { todos });
    expect(read()).toEqual(todos);
    expect(out).toContain('1/3 完成');
    expect(out).toContain('当前：第二步');
    // 渲染格式：序号 + 状态标记 [x/>/ ] + 优先级标签
    expect(out).toContain('[x]');
    expect(out).toContain('[>]');
    expect(out).toContain('[ ]');
  });

  it('多项 in_progress → 返回错误前缀，拒绝更新（不破坏 UI 进度语义）', async () => {
    const { opts, read } = makeOpts();
    const { tools } = createAgentTools(opts);
    const out = await callExecute(tools, 'TodoWrite', {
      todos: [
        { content: 'A', status: 'in_progress', priority: 'high' },
        { content: 'B', status: 'in_progress', priority: 'medium' },
      ],
    });
    expect(out).toMatch(/^错误[:：]/);
    // 拒绝更新：状态保持原样（空）。
    expect(read()).toEqual([]);
  });

  it('空清单 → 清空并提示', async () => {
    const { opts, read } = makeOpts([{ content: '旧任务', status: 'pending', priority: 'low' }]);
    const { tools } = createAgentTools(opts);
    const out = await callExecute(tools, 'TodoWrite', { todos: [] });
    expect(read()).toEqual([]);
    expect(out).toContain('已清空任务清单');
  });

  it('跨轮延续：getTodos 回灌上一轮状态作为初始值', () => {
    const prev: TodoItem[] = [{ content: '遗留', status: 'in_progress', priority: 'high' }];
    const { opts, read } = makeOpts(prev);
    // 新 run 重建工具集：getTodos 读到上一轮状态。
    createAgentTools(opts);
    // onTodoUpdate 尚未调用，但工具内部已初始化为 prev 的副本（深拷贝，互不影响）。
    expect(read()).toEqual(prev);
  });
});

describe('DateTime 工具', () => {
  it('已注册到工具集', () => {
    const { tools } = createAgentTools(makeOpts().opts);
    expect(tools.some((t) => t.name === 'DateTime')).toBe(true);
  });

  it('返回含当前日期、星期、时区', async () => {
    const { tools } = createAgentTools(makeOpts().opts);
    const out = await callExecute(tools, 'DateTime', {});
    const now = new Date();
    const year = String(now.getFullYear());
    expect(out).toContain('当前时间');
    expect(out).toContain(year); // 含当前年份，不靠训练数据旧日期
    expect(out).toContain('时区');
    expect(out).toMatch(/[星期周][一二三四五六日天]/); // 含星期（zh-CN 为「星期一」，部分环境为「周一」）
  });

  it('返回 ISO 日期（便于放进搜索查询）', async () => {
    const { tools } = createAgentTools(makeOpts().opts);
    const out = await callExecute(tools, 'DateTime', {});
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    expect(out).toContain(`ISO 日期：${today}`);
  });
});

describe('WebFetch 工具', () => {
  // WebFetch 走 api()（前端 → 后端 /api/search/fetch），需配置 apiBase + mock fetch。
  beforeEach(() => {
    configureApiBase('http://test.local');
    setAuthToken('test-token');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    configureApiBase(null);
    setAuthToken(null);
  });

  it('已注册到工具集', () => {
    const { tools } = createAgentTools(makeOpts().opts);
    expect(tools.some((t) => t.name === 'WebFetch')).toBe(true);
  });

  it('成功抓取返回正文 + URL 前缀（mock 后端 /api/search/fetch）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({
        url: 'https://example.com', content: '# Example\n\n正文内容', truncated: false, fetchedVia: 'jina',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    ));
    const { tools } = createAgentTools(makeOpts().opts);
    const out = await callExecute(tools, 'WebFetch', { url: 'https://example.com' });
    expect(out).toContain('URL: https://example.com');
    expect(out).toContain('正文内容');
  });

  it('fetchedVia=fail 返回错误前缀（触发卡片标红）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({
        url: 'https://example.com', content: '', truncated: false, fetchedVia: 'fail', error: '目标网页返回 403',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    ));
    const { tools } = createAgentTools(makeOpts().opts);
    const out = await callExecute(tools, 'WebFetch', { url: 'https://example.com' });
    expect(out).toMatch(/^错误[:：]/);
    expect(out).toContain('403');
  });

  it('maxLength 字符串入参被归一化（容错，避免 InvalidToolInputError）', async () => {
    // 后端返回正文标记 truncated=true，验证 maxLength 字符串 "100" 被当数字传给后端。
    // 注意：100 被 clamp 到下限 500（tools.ts 的 Math.max(500, ...)）。
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        url: 'https://example.com', content: 'x'.repeat(100), truncated: true, fetchedVia: 'jina',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { tools } = createAgentTools(makeOpts().opts);
    const out = await callExecute(tools, 'WebFetch', { url: 'https://example.com', maxLength: '100' });
    expect(out).toContain('已截断');
    // 验证请求 body 里 maxLength 是归一化后的数字（100 → clamp 到 500）。
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.maxLength).toBe(500);
  });

  it('网络错误返回错误前缀', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const { tools } = createAgentTools(makeOpts().opts);
    const out = await callExecute(tools, 'WebFetch', { url: 'https://example.com' });
    expect(out).toMatch(/^错误[:：]/);
  });
});
