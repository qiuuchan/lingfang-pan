// CreatorEmptyState.tsx — 创建器「零对话」引导 / hero 空状态。
//
// 角色：用户在 creator 面板还没有任何对话（turns.length === 0）时展示的引导屏，
// 带 4 个预设提示卡片；点击卡片把对应示例 prompt 回填到输入框（onSelectPreset）。
// 使用位置：CreatorWorkspace.tsx（turns.length === 0 分支）。
//
// 为什么保持自定义、不收敛到 shadcn <Empty>：本组件是「富引导屏」而非通用列表空状态，
// 包含 图标盒 + 大标题 + 描述 + 2 列预设按钮网格。shadcn <Empty> 默认带 `border-dashed`
// 圆角盒子、内容限宽 `max-w-sm` 并居中，强行套用会注入虚线边框、压窄预设网格、破坏 hero 视觉，
// 属于过度改造、收益为负。Stage 6 收敛据此有意保留。
// 若日后要让空状态风格统一，应改造 <Empty> 组件本身（去掉强制虚线边框 / 放宽 max-w），
// 而不是把本组件硬塞进 <Empty>。

import { BookOpenIcon, Code2Icon, PenLineIcon, SparklesIcon, WandSparklesIcon } from 'lucide-react';
import { CREATOR_COLUMN_CLASS } from '@/components/creator/creator-layout';
import { cn } from '@/lib/utils';

const EXAMPLES = [
  { icon: Code2Icon, title: '界面工具', prompt: '做一个带界面的代码格式化插件，支持多种语言' },
  { icon: BookOpenIcon, title: '学习助手', prompt: '做一个能拆解知识点并生成练习题的学习插件' },
  { icon: WandSparklesIcon, title: '内容工作流', prompt: '做一个从想法到文案并自动润色的创作插件' },
  { icon: PenLineIcon, title: '日常自动化', prompt: '做一个能整理待办、提醒进度并生成日报的插件' },
] as const;

/**
 * 创建器零对话引导屏。
 *
 * @param onSelectPreset 点击预设卡片时的回调，参数为该预设的示例 prompt，用于回填输入框。
 */
export function CreatorEmptyState({
  onSelectPreset,
}: {
  onSelectPreset: (prompt: string) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center overflow-y-auto px-5 py-10 sm:px-8">
      <div className={cn(CREATOR_COLUMN_CLASS, 'flex flex-col items-center text-center')}>
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
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                    {example.prompt}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
