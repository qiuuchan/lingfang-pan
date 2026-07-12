import { BookOpenIcon, Code2Icon, PenLineIcon, SparklesIcon, WandSparklesIcon } from 'lucide-react';
import { CREATOR_COLUMN_CLASS } from '@/components/creator/creator-layout';

const EXAMPLES = [
  { icon: Code2Icon, title: '界面工具', prompt: '做一个带界面的代码格式化插件，支持多种语言' },
  { icon: BookOpenIcon, title: '学习助手', prompt: '做一个能拆解知识点并生成练习题的学习插件' },
  { icon: WandSparklesIcon, title: '内容工作流', prompt: '做一个从想法到文案并自动润色的创作插件' },
  { icon: PenLineIcon, title: '日常自动化', prompt: '做一个能整理待办、提醒进度并生成日报的插件' },
] as const;

export function CreatorEmptyState({ onSelectPreset }: { onSelectPreset: (prompt: string) => void }) {
  return (
    <div className="flex min-h-0 flex-1 items-center overflow-y-auto px-5 py-10 sm:px-8">
      <div className={`${CREATOR_COLUMN_CLASS} flex flex-col items-center text-center`}>
        <span className="mb-5 flex size-10 items-center justify-center rounded-lg border border-border bg-card text-primary shadow-sm">
          <SparklesIcon className="size-5" />
        </span>
        <h1 className="text-3xl font-semibold text-foreground">描述你想构建的插件</h1>
        <p className="mt-3 max-w-lg text-sm leading-6 text-muted-foreground">
          Agent 会规划任务、编写代码、运行检查，并把可编辑的插件草稿整理到右侧。
        </p>

        <div className="mt-8 grid w-full grid-cols-1 gap-2 sm:grid-cols-2">
          {EXAMPLES.map((example) => {
            const Icon = example.icon;
            return (
              <button
                key={example.title}
                type="button"
                onClick={() => onSelectPreset(example.prompt)}
                className="group flex min-w-0 items-center gap-3 rounded-lg border border-border/70 bg-card/60 px-3.5 py-3 text-left transition-colors hover:border-primary/35 hover:bg-accent/60"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground transition-colors group-hover:bg-primary/10 group-hover:text-primary">
                  <Icon className="size-4" />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-foreground">{example.title}</span>
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground">{example.prompt}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
