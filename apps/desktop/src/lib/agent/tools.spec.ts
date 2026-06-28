// tools.spec.ts —— TodoWrite 工具的核心约束单测。
//
// 验证「同一时间至多一项 in_progress」不变式（防止模型把所有任务都标进行中导致 UI 混乱），
// 以及 todo 跨轮延续（getTodos 回灌 → onTodoUpdate 同步）。
// 工具工厂 createAgentTools 走 @openai/agents 的 tool()，execute 通过 mock 回调直接调用。
import { describe, it, expect, vi } from 'vitest';
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
