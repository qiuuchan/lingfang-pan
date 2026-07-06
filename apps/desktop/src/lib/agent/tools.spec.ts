// tools.spec.ts —— TodoWrite 工具的核心约束单测。
//
// 验证「同一时间至多一项 in_progress」不变式（防止模型把所有任务都标进行中导致 UI 混乱），
// 以及 todo 跨轮延续（getTodos 回灌 → onTodoUpdate 同步）。
// betav2：工具走自建 defineTool（ToolDefinition），execute(args, ctx) 直接收对象返回 ToolResult。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { configureApiBase, setAuthToken } from '@/lib/api';
import { createAgentTools, normalizeToolFileContent, detectCapabilities, isVersionNewer, type AgentToolsOptions, type TodoItem } from './tools';

// RunPlugin 测试需要 mock tauriInvoke（list/read 文件）+ runPluginScript（试跑）。
// 用 vi.hoisted 拿到可在工厂内引用的 mock 引用，再 vi.mock 替换两个模块。
const runPluginMock = vi.hoisted(() => vi.fn());
const tauriInvokeMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/plugin-script', () => ({ runPluginScript: runPluginMock }));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, tauriInvoke: tauriInvokeMock };
});

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

/** 从 ToolDefinition 里取出 execute 并调用（betav2 自建契约：execute(args, ctx) → ToolResult）。
 *  返回 ToolResult；旧测试断言 data 字符串（兼容：ok 时取 data）。 */
async function callExecute(tools: ReturnType<typeof createAgentTools>['tools'], name: string, args: unknown) {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  const result = await t.execute(args, { toolCallId: 'test-call', signal: new AbortController().signal });
  // 旧断言期望字符串；ToolResult.ok 时 data 是字符串，!ok 时 error 是字符串。
  return result.ok ? String(result.data ?? '') : String(result.error ?? '');
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
    const callArgs = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(callArgs[1].body as string);
    expect(body.maxLength).toBe(500);
  });

  it('网络错误返回错误前缀', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const { tools } = createAgentTools(makeOpts().opts);
    const out = await callExecute(tools, 'WebFetch', { url: 'https://example.com' });
    expect(out).toMatch(/^错误[:：]/);
  });
});

// normalizeToolFileContent：文件内容容错归一化。
// 根因：模型对大段源码（含大量引号/反斜杠）有时传成对象/嵌套结构，严格 union 校验会抛
// InvalidToolInputError（与 WebSearch.limit 同类失败）。这里验证任意畸形输入都能回落为合法字符串，
// 不让 content 形状触发工具调用失败。
describe('normalizeToolFileContent 文件内容容错', () => {
  it('字符串原样返回', () => {
    expect(normalizeToolFileContent('hello\nworld')).toBe('hello\nworld');
  });

  it('字符串数组逐行 join', () => {
    expect(normalizeToolFileContent(['line1', 'line2', 'line3'])).toBe('line1\nline2\nline3');
  });

  it('对象取 content 字段', () => {
    expect(normalizeToolFileContent({ content: 'code here' })).toBe('code here');
  });

  it('对象取其它常见字段名（text/value/body/code）', () => {
    expect(normalizeToolFileContent({ text: 'a' })).toBe('a');
    expect(normalizeToolFileContent({ value: 'b' })).toBe('b');
    expect(normalizeToolFileContent({ body: 'c' })).toBe('c');
    expect(normalizeToolFileContent({ code: 'd' })).toBe('d');
  });

  it('对象取数组字段（逐行 join）', () => {
    expect(normalizeToolFileContent({ content: ['x', 'y'] })).toBe('x\ny');
  });

  it('对象无可识别字段 → JSON 序列化兜底', () => {
    expect(normalizeToolFileContent({ foo: 1, bar: 2 })).toBe(JSON.stringify({ foo: 1, bar: 2 }, null, 2));
  });

  it('null/undefined → 空串', () => {
    expect(normalizeToolFileContent(null)).toBe('');
    expect(normalizeToolFileContent(undefined)).toBe('');
  });

  it('数字/布尔 → String()', () => {
    expect(normalizeToolFileContent(42)).toBe('42');
    expect(normalizeToolFileContent(true)).toBe('true');
  });
});

describe('RunPlugin 工具', () => {
  afterEach(() => { vi.clearAllMocks(); });

  it('已注册到工具集', () => {
    const { tools } = createAgentTools(makeOpts().opts);
    expect(tools.some((t) => t.name === 'RunPlugin')).toBe(true);
  });

  it('成功运行 → ✅ + stdout', async () => {
    // mock: list_plugin_files → ['main.py']; read → manifest + main.py 内容; runPluginScript → ok.
    tauriInvokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'list_plugin_files') return ['main.py', 'manifest.json'];
      const file = (args?.file as string) ?? '';
      if (file === 'manifest.json') return JSON.stringify({ runtime_type: 'python', entry: 'main.py' });
      return "print('hello')";
    });
    runPluginMock.mockResolvedValueOnce({ ok: true, stdout: 'hello\n', stderr: '', exitCode: 0, elapsedMs: 120 });
    const { tools } = createAgentTools(makeOpts().opts);
    const out = await callExecute(tools, 'RunPlugin', {});
    expect(out).toContain('运行成功');
    expect(out).toContain('hello');
    // 验证传给 runPluginScript 的参数：runtime=python, entry=main.py, 含 main.py 文件。
    const callArgs = runPluginMock.mock.calls[0][0];
    expect(callArgs.runtime).toBe('python');
    expect(callArgs.entry).toBe('main.py');
    expect(callArgs.files.some((f: { path: string }) => f.path === 'main.py')).toBe(true);
  });

  it('运行失败（非零退出码）→ ❌ + stderr 供模型修复', async () => {
    tauriInvokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'list_plugin_files') return ['main.py', 'manifest.json'];
      const file = (args?.file as string) ?? '';
      if (file === 'manifest.json') return JSON.stringify({ runtime_type: 'python', entry: 'main.py' });
      return 'print(x'; // 故意语法错
    });
    runPluginMock.mockResolvedValueOnce({
      ok: false, stdout: '', stderr: 'SyntaxError: unexpected EOF', exitCode: 1, failure: 'nonzero_exit', elapsedMs: 80,
    });
    const { tools } = createAgentTools(makeOpts().opts);
    const out = await callExecute(tools, 'RunPlugin', {});
    expect(out).toContain('运行失败');
    expect(out).toContain('SyntaxError');
    expect(out).toContain('退出码 1');
  });

  it('装依赖成功 → 输出含 [依赖] 前缀', async () => {
    tauriInvokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'list_plugin_files') return ['main.py', 'requirements.txt', 'manifest.json'];
      const file = (args?.file as string) ?? '';
      if (file === 'manifest.json') return JSON.stringify({ runtime_type: 'python', entry: 'main.py' });
      if (file === 'requirements.txt') return 'requests';
      return "print('ok')";
    });
    runPluginMock.mockResolvedValueOnce({
      ok: true, stdout: 'ok\n', stderr: '', exitCode: 0, elapsedMs: 100,
      installLog: 'Python 依赖已就绪（venv: /path/py）',
    });
    const { tools } = createAgentTools(makeOpts().opts);
    const out = await callExecute(tools, 'RunPlugin', {});
    expect(out).toContain('[依赖]');
    expect(out).toContain('依赖已就绪');
    expect(out).toContain('运行成功');
  });

  it('装依赖失败 → 输出含依赖安装失败原因', async () => {
    tauriInvokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'list_plugin_files') return ['main.py', 'requirements.txt', 'manifest.json'];
      const file = (args?.file as string) ?? '';
      if (file === 'manifest.json') return JSON.stringify({ runtime_type: 'python', entry: 'main.py' });
      if (file === 'requirements.txt') return 'nonexistent-pkg-xyz';
      return 'print(1)';
    });
    // 装依赖失败：Rust 返回 exit_code=null + install_log 含「依赖安装失败」。
    runPluginMock.mockResolvedValueOnce({
      ok: false, failure: 'spawn_failed',
      stderr: '依赖安装失败：pip install 失败：Could not find nonexistent-pkg-xyz',
      installLog: '依赖安装失败：pip install 失败：Could not find nonexistent-pkg-xyz',
    });
    const { tools } = createAgentTools(makeOpts().opts);
    const out = await callExecute(tools, 'RunPlugin', {});
    expect(out).toContain('依赖安装失败');
    expect(out).toContain('nonexistent-pkg-xyz');
  });

  it('client 运行时不支持试跑 → 明确指引', async () => {
    tauriInvokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'list_plugin_files') return ['ui/index.html', 'manifest.json'];
      const file = (args?.file as string) ?? '';
      if (file === 'manifest.json') return JSON.stringify({ runtime_type: 'client', entry: 'ui/index.html' });
      return '<html></html>';
    });
    const { tools } = createAgentTools(makeOpts().opts);
    const out = await callExecute(tools, 'RunPlugin', {});
    expect(out).toContain('client');
    expect(out).toMatch(/不支持试跑|运行按钮/);
    expect(runPluginMock).not.toHaveBeenCalled(); // client 不调试跑
  });

  it('解释器缺失 → 运行时缺失提示', async () => {
    tauriInvokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'list_plugin_files') return ['main.py', 'manifest.json'];
      const file = (args?.file as string) ?? '';
      if (file === 'manifest.json') return JSON.stringify({ runtime_type: 'python', entry: 'main.py' });
      return 'print(1)';
    });
    runPluginMock.mockResolvedValueOnce({ ok: false, failure: 'interpreter_missing', stderr: '未检测到内置 Python' });
    const { tools } = createAgentTools(makeOpts().opts);
    const out = await callExecute(tools, 'RunPlugin', {});
    expect(out).toContain('运行时缺失');
  });
});

describe('DeleteFile 工具', () => {
  afterEach(() => { vi.clearAllMocks(); });

  it('已注册到工具集', () => {
    const { tools } = createAgentTools(makeOpts().opts);
    expect(tools.some((t) => t.name === 'DeleteFile')).toBe(true);
  });

  it('删除成功 → 返回已删除', async () => {
    tauriInvokeMock.mockResolvedValue(undefined);
    const { tools } = createAgentTools(makeOpts().opts);
    const out = await callExecute(tools, 'DeleteFile', { path: 'old-impl.py' });
    expect(out).toContain('已删除 old-impl.py');
    // 验证调了 delete_plugin_file 命令。
    const call = tauriInvokeMock.mock.calls.find((c) => c[0] === 'delete_plugin_file');
    expect(call).toBeTruthy();
  });

  it('文件不存在 → 返回删除失败', async () => {
    tauriInvokeMock.mockRejectedValue(new Error('文件不存在'));
    const { tools } = createAgentTools(makeOpts().opts);
    const out = await callExecute(tools, 'DeleteFile', { path: 'nope.py' });
    expect(out).toContain('删除失败');
  });

  it('非法路径 → 直接拒绝（不调 Rust）', async () => {
    const { tools } = createAgentTools(makeOpts().opts);
    const out = await callExecute(tools, 'DeleteFile', { path: '../etc/passwd' });
    expect(out).toContain('非法');
    expect(tauriInvokeMock).not.toHaveBeenCalled();
  });
});

describe('MoveFile 工具', () => {
  afterEach(() => { vi.clearAllMocks(); });

  it('已注册到工具集', () => {
    const { tools } = createAgentTools(makeOpts().opts);
    expect(tools.some((t) => t.name === 'MoveFile')).toBe(true);
  });

  it('移动成功 → 返回 from → to', async () => {
    tauriInvokeMock.mockResolvedValue(undefined);
    const { tools } = createAgentTools(makeOpts().opts);
    const out = await callExecute(tools, 'MoveFile', { from: 'main.py', to: 'src/main.py' });
    expect(out).toContain('main.py → src/main.py');
    const call = tauriInvokeMock.mock.calls.find((c) => c[0] === 'move_plugin_file');
    expect(call).toBeTruthy();
  });

  it('源=目标 → 返回相同错误（不调 Rust）', async () => {
    const { tools } = createAgentTools(makeOpts().opts);
    const out = await callExecute(tools, 'MoveFile', { from: 'a.py', to: 'a.py' });
    expect(out).toMatch(/相同|非法/);
  });
});

describe('Grep 工具', () => {
  afterEach(() => { vi.clearAllMocks(); });

  it('已注册到工具集', () => {
    const { tools } = createAgentTools(makeOpts().opts);
    expect(tools.some((t) => t.name === 'Grep')).toBe(true);
  });

  it('找到匹配 → 返回 文件:行号:内容', async () => {
    tauriInvokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'list_plugin_files') return ['main.py', 'utils.py'];
      const file = (args?.file as string) ?? '';
      if (file === 'main.py') return 'def main():\n    print("hello")\n';
      if (file === 'utils.py') return 'def helper():\n    return 42\n';
      return '';
    });
    const { tools } = createAgentTools(makeOpts().opts);
    const out = await callExecute(tools, 'Grep', { pattern: 'def ' });
    expect(out).toContain('main.py:1');
    expect(out).toContain('utils.py:1');
    expect(out).toContain('def main');
  });

  it('无匹配 → 返回未找到', async () => {
    tauriInvokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_plugin_files') return ['main.py'];
      return 'print(1)';
    });
    const { tools } = createAgentTools(makeOpts().opts);
    const out = await callExecute(tools, 'Grep', { pattern: 'nonexistent_symbol' });
    expect(out).toContain('未找到');
  });

  it('glob 过滤 → 只搜匹配文件', async () => {
    tauriInvokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'list_plugin_files') return ['main.py', 'index.js'];
      return 'target_line';
    });
    const { tools } = createAgentTools(makeOpts().opts);
    await callExecute(tools, 'Grep', { pattern: 'target_line', glob: '*.py' });
    // 只读了 main.py（*.py 过滤掉 index.js）。
    const readFileCalls = tauriInvokeMock.mock.calls.filter((c) => c[0] === 'read_local_plugin_file');
    expect(readFileCalls.length).toBe(1);
    expect(readFileCalls[0][1].file).toBe('main.py');
  });

  it('非法正则 → 回落字面量匹配不报错', async () => {
    tauriInvokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_plugin_files') return ['main.py'];
      return 'foo (unclosed bar';
    });
    const { tools } = createAgentTools(makeOpts().opts);
    // `(unclosed` 是非法正则（未闭合分组），应回落为字面量匹配。
    const out = await callExecute(tools, 'Grep', { pattern: '(unclosed' });
    expect(out).toContain('main.py:1');
    expect(out).toContain('(unclosed');
  });
});

describe('isVersionNewer 语义版本比较', () => {
  it('patch 位递增', () => {
    expect(isVersionNewer('0.1.1', '0.1.0')).toBe(true);
  });
  it('minor 位递增', () => {
    expect(isVersionNewer('0.2.0', '0.1.9')).toBe(true);
  });
  it('major 位递增', () => {
    expect(isVersionNewer('1.0.0', '0.9.9')).toBe(true);
  });
  it('相同版本不算更新', () => {
    expect(isVersionNewer('0.1.0', '0.1.0')).toBe(false);
  });
  it('降级不允许', () => {
    expect(isVersionNewer('0.1.0', '0.1.1')).toBe(false);
    expect(isVersionNewer('0.9.0', '1.0.0')).toBe(false);
  });
  it('非法格式按 0.0.0 处理', () => {
    expect(isVersionNewer('0.0.1', 'abc')).toBe(true);
    expect(isVersionNewer('abc', '0.0.0')).toBe(false);
  });
});

describe('UpdatePlugin 工具', () => {
  afterEach(() => { vi.clearAllMocks(); });

  it('已注册到工具集', () => {
    const { tools } = createAgentTools(makeOpts().opts);
    expect(tools.some((t) => t.name === 'UpdatePlugin')).toBe(true);
  });

  it('升版本号成功 → 写回 manifest', async () => {
    tauriInvokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'read_local_plugin_file') return JSON.stringify({ id: 'p1', name: '老名字', version: '0.1.0', description: '旧' });
      if (cmd === 'write_plugin_file') return undefined;
      return undefined;
    });
    const { tools } = createAgentTools(makeOpts().opts);
    const out = await callExecute(tools, 'UpdatePlugin', { version: '0.1.1' });
    expect(out).toContain('0.1.0 → 0.1.1');
    // 验证写了 manifest.json。
    const writeCall = tauriInvokeMock.mock.calls.find((c) => c[0] === 'write_plugin_file');
    expect(writeCall).toBeTruthy();
  });

  it('降级被拒绝', async () => {
    tauriInvokeMock.mockImplementation(async () => JSON.stringify({ version: '1.0.0' }));
    const { tools } = createAgentTools(makeOpts().opts);
    const out = await callExecute(tools, 'UpdatePlugin', { version: '0.9.0' });
    expect(out).toContain('不大于');
    expect(out).toContain('降级');
  });

  it('同时更新名字和描述', async () => {
    tauriInvokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'read_local_plugin_file') return JSON.stringify({ name: '旧', version: '0.1.0', description: '旧描述' });
      return undefined;
    });
    const { tools } = createAgentTools(makeOpts().opts);
    const out = await callExecute(tools, 'UpdatePlugin', { version: '0.2.0', name: '新名字', description: '新描述' });
    expect(out).toContain('名字 → 新名字');
    expect(out).toContain('描述已更新');
  });
});

describe('detectCapabilities 能力声明检测', () => {
  it('检测网络请求 → net.fetch', () => {
    const r = detectCapabilities(
      [{ path: 'main.py', content: 'import requests\nrequests.get("http://x")' }],
      [],
    );
    expect(r.detected).toContain('net.fetch');
    expect(r.missing).toContain('net.fetch');
  });

  it('检测文件读写 → fs.read + fs.write', () => {
    const r = detectCapabilities(
      [{ path: 'main.py', content: 'with open("f.txt", "w") as f:\n    f.write("x")' }],
      [],
    );
    expect(r.detected).toContain('fs.read');
    expect(r.detected).toContain('fs.write');
  });

  it('检测平台 LLM 调用 → llm.chat', () => {
    const r = detectCapabilities(
      [{ path: 'main.py', content: 'result = sdk.llm.chat("hi")' }],
      [],
    );
    expect(r.detected).toContain('llm.chat');
  });

  it('已声明的能力不计入 missing', () => {
    const r = detectCapabilities(
      [{ path: 'main.py', content: 'import requests' }],
      ['net.fetch', 'ui.view'],
    );
    expect(r.detected).toContain('net.fetch');
    expect(r.missing).toEqual([]); // net.fetch 已声明，不缺漏
  });

  it('代码无任何能力特征 → detected 为空', () => {
    const r = detectCapabilities(
      [{ path: 'main.py', content: 'def add(a, b):\n    return a + b' }],
      ['ui.view'],
    );
    expect(r.detected).toEqual([]);
    expect(r.missing).toEqual([]);
  });

  it('Node fetch 也检测为 net.fetch', () => {
    const r = detectCapabilities(
      [{ path: 'index.js', content: 'const res = await fetch(url)' }],
      [],
    );
    expect(r.detected).toContain('net.fetch');
  });

  it('多文件合并检测', () => {
    const r = detectCapabilities([
      { path: 'main.py', content: 'import requests' },
      { path: 'utils.py', content: 'open("f")' },
    ], []);
    expect(r.detected).toContain('net.fetch');
    expect(r.detected).toContain('fs.read');
  });
});
