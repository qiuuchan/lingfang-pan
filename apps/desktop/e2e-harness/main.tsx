// e2e-harness/main.tsx —— 组件视觉测试挂载页。
//
// 把 ToolCallCard / TodoPanel 以多种受控状态直接渲染在白板上，供 Playwright
// 截图 + 断言。绕过登录态/relay SSE mock 的脆弱性，直接测组件本身。
// 仅在 e2e 测试时通过 ?harness=1 路由到此页（生产构建不含本文件——它不在 index.html 入口树里）。
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ToolCallCard, type ToolCardData } from '@/components/creator/ToolCallCard';
import { TodoPanel } from '@/components/creator/TodoPanel';
import { Markdown } from '@/components/Markdown';
import type { TodoItem } from '@/lib/agent/tools';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-sm font-semibold text-muted-foreground">{title}</h2>
      <div className="max-w-md space-y-2">{children}</div>
    </section>
  );
}

function Harness() {
  const toolVariants: { id: string; data: ToolCardData }[] = [
    {
      id: 'running',
      data: {
        toolCallId: 't1',
        name: 'WebSearch',
        status: 'running',
        args: { query: '今天新闻头条' },
      },
    },
    {
      id: 'ok',
      data: {
        toolCallId: 't2',
        name: 'Read',
        status: 'ok',
        args: { path: 'plugin/main.py' },
        result: { path: 'plugin/main.py', content: 'print("hello")\n' },
      },
    },
    {
      id: 'error',
      data: {
        toolCallId: 't3',
        name: 'Edit',
        status: 'error',
        args: { path: 'plugin/main.py' },
        result: '错误：文件不存在，请先用 Read 读取再 Edit。',
      },
    },
    {
      id: 'todo-summary',
      data: {
        toolCallId: 't4',
        name: 'TodoWrite',
        status: 'ok',
        args: {
          todos: [
            { content: '初始化插件', status: 'completed', priority: 'high' },
            { content: '编写核心逻辑', status: 'in_progress', priority: 'high' },
            { content: '添加界面', status: 'pending', priority: 'medium' },
          ],
        },
      },
    },
    {
      id: 'datetime',
      data: {
        toolCallId: 't5',
        name: 'DateTime',
        status: 'ok',
        result: '当前时间：2026年6月29日 周日 15:30（Asia/Shanghai）',
      },
    },
  ];

  const todos: TodoItem[] = [
    { content: '初始化插件目录', status: 'completed', priority: 'high' },
    { content: '编写核心逻辑', status: 'in_progress', priority: 'high' },
    { content: '添加图形界面', status: 'pending', priority: 'medium' },
    { content: '编写说明文档', status: 'pending', priority: 'low' },
  ];

  return (
    <div className="mx-auto max-w-3xl p-8">
      <h1 className="mb-6 text-lg font-bold">组件视觉测试</h1>

      <Section title="ToolCallCard — 三种状态">
        {toolVariants.map((v) => (
          <ToolCallCard key={v.id} data={v.data} />
        ))}
      </Section>

      <Section title="TodoPanel — 进行中">
        <TodoPanel todos={todos} streaming />
      </Section>

      <Section title="TodoPanel — 已完成（静态）">
        <TodoPanel
          todos={todos.map((t) => ({ ...t, status: 'completed' as const }))}
          streaming={false}
        />
      </Section>

      <Section title="Markdown 排版">
        <div className="overflow-hidden rounded-lg border border-border/30 bg-card/70 px-4 py-3 text-sm text-foreground shadow-sm">
          <Markdown>{`## 标题

这是一段**粗体**和*斜体*文本，还有\`行内代码\`。

- 无序列表项一
- 无序列表项二
- 无序列表项三

1. 有序列表项一
2. 有序列表项二

| 功能 | 状态 |
|------|------|
| 天气查询 | ✅ |
| 待办事项 | ✅ |

\`\`\`python
def hello():
    print("Hello, World!")
\`\`\`

> 这是一段引用文字。`}</Markdown>
        </div>
      </Section>

      <Section title="对话气泡 — 用户/助手对齐">
        {/* 复刻 FloatingCreator 的气泡布局：用户右对齐(主色)、助手左对齐(卡片)。 */}
        <div className="flex max-w-[92%] flex-col gap-4">
          <div className="flex justify-end">
            <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-gradient-to-br from-primary to-primary/90 px-4 py-2.5 text-sm text-primary-foreground shadow-sm">
              做一个带界面的天气查询插件
            </div>
          </div>
          <div className="flex justify-start">
            <div className="w-full overflow-hidden rounded-lg border border-border/30 bg-card/70 px-4 py-3 text-sm text-foreground shadow-sm">
              <Markdown>{`好的！我来帮你创建一个**带界面的天气查询插件**。

插件包含：
- 城市搜索输入框
- 实时天气显示
- 三天预报

请稍等，我正在初始化插件…`}</Markdown>
            </div>
          </div>
        </div>
      </Section>

      <Section title="思考块（reasoning）">
        <details
          className="overflow-hidden rounded-lg border border-border/30 bg-card/60 text-xs"
          open
        >
          <summary className="flex cursor-pointer items-center gap-1.5 px-3 py-2 text-muted-foreground/70 transition-colors hover:bg-muted/25 hover:text-muted-foreground">
            Thinking...
          </summary>
          <div className="max-h-36 overflow-y-auto whitespace-pre-wrap border-t border-border/20 bg-muted/10 px-3 py-2 font-mono text-[10px] leading-relaxed text-muted-foreground/80">
            {`用户想要一个天气查询插件，需要带界面。我应该用 Python + tkinter 实现：
1. 创建 main.py 入口
2. 用 requests 调用天气 API
3. 用 tkinter 画界面
4. 创建 plugin.json 元数据`}
          </div>
        </details>
      </Section>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Harness />
  </React.StrictMode>
);
