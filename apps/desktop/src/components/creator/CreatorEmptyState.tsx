import type { ReactNode } from 'react';
import { SparklesIcon, Code2Icon, BookOpenIcon, WandSparklesIcon, PenLineIcon, HeartIcon } from 'lucide-react';
import { CREATOR_COLUMN_CLASS } from '@/components/creator/creator-layout';

const EMBEDDED_EXAMPLES = [
  { icon: Code2Icon, title: '代码工具', prompt: '做一个带界面的代码格式化插件，支持多种语言' },
  { icon: BookOpenIcon, title: '学习助手', prompt: '做一个能拆解知识点并生成练习题的学习插件' },
  { icon: WandSparklesIcon, title: '创作工作流', prompt: '做一个从想法到文案的创作流程插件' },
  { icon: PenLineIcon, title: '写作辅助', prompt: '做一个支持润色、改写和摘要的写作插件' },
  { icon: HeartIcon, title: '生活助手', prompt: '做一个日常规划与记录的生活助手插件' },
] as const;

const FLOATING_PRESETS = [
  '做一个带界面的天气查询 Python 插件',
  '做一个带界面的待办事项 Node.js 插件',
  '做一个带界面的计算器插件',
];

export function CreatorEmptyState({
  composer,
  embedded,
  onSelectPreset,
}: {
  composer: ReactNode;
  embedded: boolean;
  onSelectPreset: (prompt: string) => void;
}) {
  if (!embedded) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-5 text-center">
        <div className="flex size-12 items-center justify-center rounded-md border border-border bg-card">
          <SparklesIcon className="size-6 text-foreground" />
        </div>
        <div className="space-y-2">
          <h3 className="text-lg font-semibold text-foreground">AI 插件创建器</h3>
          <p className="max-w-md text-sm text-muted-foreground">描述你想做的插件，AI 流式生成完整代码。支持多轮对话追问修改，直到满意为止。</p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          {FLOATING_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => onSelectPreset(preset)}
              className="rounded-md border border-border bg-card px-3.5 py-2 font-mono text-xs text-muted-foreground transition-colors duration-150 hover:border-muted-foreground/40 hover:bg-accent hover:text-foreground"
            >
              {preset}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={`${CREATOR_COLUMN_CLASS} flex h-full flex-col items-center justify-center gap-8 text-center`}>
      <div className="space-y-3">
        <div className="mx-auto inline-flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
          <SparklesIcon className="size-3.5 text-foreground" />
          agent · 创建插件
        </div>
        <h1 className="text-4xl font-semibold tracking-tight text-foreground">想做什么插件？</h1>
        <p className="mx-auto max-w-xl text-base leading-7 text-muted-foreground">
          描述一个工作流、界面或自动化想法，我会生成插件草稿，并在右侧保留可编辑的提交面板。
        </p>
      </div>
      {composer}
      {/* 例子卡片网格：点击直接填入输入框。 */}
      <div className="grid w-full max-w-3xl grid-cols-2 gap-2.5 sm:grid-cols-3">
        {EMBEDDED_EXAMPLES.map((example) => {
          const Icon = example.icon;
          return (
            <button
              key={example.title}
              type="button"
              onClick={() => onSelectPreset(example.prompt)}
              className="group flex flex-col items-start gap-2 rounded-md border border-border bg-card p-3.5 text-left transition-colors duration-150 hover:border-muted-foreground/40 hover:bg-accent"
            >
              <span className="flex size-8 items-center justify-center rounded-md border border-border bg-muted text-foreground transition-colors group-hover:border-primary group-hover:bg-primary group-hover:text-primary-foreground">
                <Icon className="size-4" />
              </span>
              <span className="text-sm font-medium text-foreground">{example.title}</span>
              <span className="line-clamp-2 font-mono text-[11px] leading-relaxed text-muted-foreground">{example.prompt}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
