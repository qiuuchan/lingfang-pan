import type { ReactNode } from 'react';
import { SparklesIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

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
  return (
    <div className={cn('flex h-full flex-col items-center justify-center gap-5 text-center', embedded && 'mx-auto max-w-4xl gap-6')}>
      {embedded ? (
        <>
          <div className="space-y-3">
            <div className="mx-auto flex size-12 items-center justify-center rounded-xl border border-[#E7E1D7] bg-[#FFFFFF] shadow-sm">
              <SparklesIcon className="size-6 text-[#C4612F]" />
            </div>
            <h1 className="text-4xl font-semibold tracking-tight text-[#1F2421]">想做什么插件?</h1>
            <p className="mx-auto max-w-xl text-base leading-7 text-[#5C635D]">
              描述一个工作流、界面或自动化想法，我会生成插件草稿，并在右侧保留可编辑的提交面板。
            </p>
          </div>
          {composer}
        </>
      ) : (
        <>
          <div className="relative">
            <div className="absolute inset-0 animate-pulse rounded-full bg-[#C4612F]/20 blur-xl" />
            <SparklesIcon className="relative size-12 text-[#C4612F]" />
          </div>
          <div className="space-y-2">
            <h3 className="text-lg font-medium text-[#1F2421]">AI 插件创建器</h3>
            <p className="max-w-md text-sm text-[#5C635D]">描述你想做的插件，AI 流式生成完整代码。支持多轮对话追问修改，直到满意为止。</p>
          </div>
          <div className="flex flex-wrap justify-center gap-2.5">
            {FLOATING_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => onSelectPreset(preset)}
                className="group rounded-full border border-[#E7E1D7] bg-[#FFFFFF]/80 px-4 py-2 text-xs font-medium text-[#5C635D] backdrop-blur-sm transition-all duration-150 hover:-translate-y-0.5 hover:border-[#C4612F]/50 hover:bg-[#F2E3D6] hover:text-[#C4612F] hover:shadow-md"
              >
                {preset}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
