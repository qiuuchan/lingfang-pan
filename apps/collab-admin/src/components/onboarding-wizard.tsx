import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowRightIcon,
  CheckIcon,
  ServerIcon,
  BoxesIcon,
  RocketIcon,
  SettingsIcon,
  XIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { View } from '@/lib/types';
import { cn } from '@/lib/utils';

// 首次登录引导向导完成标记 key（localStorage）。
// 判定逻辑见 App.tsx：session 刚建立 + 此标记不存在时弹出向导。
export const ONBOARDING_DONE_KEY = 'lf:admin-onboarding-done';

type StepKey = 'platform' | 'provider' | 'team' | 'release';

type Step = {
  key: StepKey;
  // 序号（从 1 开始），用于步骤指示器渲染。
  index: number;
  title: string;
  description: string;
  icon: typeof SettingsIcon;
  // 「去完成」跳转的目标 view；platform / release 步骤为纯提示，无跳转。
  targetView?: View;
};

const STEPS: Step[] = [
  {
    key: 'platform',
    index: 1,
    title: '配置平台信息',
    description: '在「平台设置」页完善平台名称、Logo 与 SMTP 等基础信息，让平台对外形象一致。当前阶段可先跳过，后续随时回来调整。',
    icon: SettingsIcon,
    targetView: 'settings',
  },
  {
    key: 'provider',
    index: 2,
    title: '配置模型渠道',
    description: '在「渠道管理」页接入上游模型渠道并绑定范围，中转计费系统才能对外服务 AI 调用。',
    icon: ServerIcon,
    targetView: 'channels',
  },
  {
    key: 'team',
    index: 3,
    title: '创建首个团队',
    description: '在「团队管理」页创建第一个团队并指定团队管理员，平台协作由此展开。',
    icon: BoxesIcon,
    targetView: 'teams',
  },
  {
    key: 'release',
    index: 4,
    title: '发布首个版本',
    description: '准备就绪后，在 release 模块（collab-api）发布首个客户端版本，用户即可下载使用。此步骤需在服务端操作。',
    icon: RocketIcon,
  },
];

type OnboardingWizardProps = {
  // 跳转到指定 view（复用 App.tsx 的 setView）。
  onNavigate: (view: View) => void;
  // 全部完成 / 跳过时调用，App.tsx 据此关闭向导并写完成标记。
  onClose: () => void;
};

export function OnboardingWizard({ onNavigate, onClose }: OnboardingWizardProps) {
  const [stepIndex, setStepIndex] = useState(0);
  const step = STEPS[stepIndex];
  const isLast = stepIndex === STEPS.length - 1;
  const StepIcon = step.icon;

  function goNext() {
    if (isLast) {
      finish();
      return;
    }
    setStepIndex((i) => i + 1);
  }

  function goPrev() {
    setStepIndex((i) => Math.max(0, i - 1));
  }

  function finish() {
    localStorage.setItem(ONBOARDING_DONE_KEY, new Date().toISOString());
    onClose();
  }

  // 「去完成」：跳转到当前步骤的目标 view，并标记向导完成（用户已知道下一步在哪）。
  function handleGoToTarget() {
    if (step.targetView) {
      localStorage.setItem(ONBOARDING_DONE_KEY, new Date().toISOString());
      onNavigate(step.targetView);
      onClose();
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) finish(); }}>
      <DialogContent className="max-w-lg p-0 overflow-hidden">
        {/* 顶部 banner：渐变背景 + 步骤图标，营造引导仪式感 */}
        <div className="relative bg-gradient-to-br from-primary/90 to-primary text-primary-foreground p-6 pb-5">
          <button
            onClick={finish}
            className="absolute right-3 top-3 rounded-lg p-1.5 text-primary-foreground/80 transition-colors hover:bg-white/15 hover:text-primary-foreground"
            aria-label="关闭向导"
          >
            <XIcon className="size-4" />
          </button>
          <div className="flex items-center gap-3">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-white/15">
              <StepIcon className="size-6" />
            </div>
            <div className="min-w-0">
              <div className="text-xs/none opacity-80">首次登录引导 · 第 {step.index} / {STEPS.length} 步</div>
              <DialogTitle className="mt-1 text-lg font-semibold tracking-tight text-primary-foreground">
                {step.title}
              </DialogTitle>
            </div>
          </div>
        </div>

        <DialogHeader className="sr-only">
          <DialogTitle>{step.title}</DialogTitle>
          <DialogDescription>首次登录引导向导</DialogDescription>
        </DialogHeader>

        {/* 步骤进度指示器 */}
        <div className="flex items-center gap-1.5 px-6 pt-5">
          {STEPS.map((s, i) => (
            <div
              key={s.key}
              className={cn(
                'h-1.5 flex-1 rounded-full transition-colors',
                i <= stepIndex ? 'bg-primary' : 'bg-muted',
              )}
            />
          ))}
        </div>

        {/* 步骤内容（AnimatePresence + slide 切换动画） */}
        <div className="relative px-6 pb-2 pt-5">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={step.key}
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -24 }}
              transition={{ duration: 0.22, ease: 'easeOut' }}
            >
              <p className="text-sm leading-relaxed text-muted-foreground">
                {step.description}
              </p>
            </motion.div>
          </AnimatePresence>
        </div>

        {/* 步骤清单（让用户看到全貌） */}
        <div className="px-6 pb-4">
          <div className="grid gap-1.5">
            {STEPS.map((s) => {
              const done = s.index < step.index;
              const active = s.index === step.index;
              const SIcon = s.icon;
              return (
                <div
                  key={s.key}
                  className={cn(
                    'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors',
                    active ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground',
                  )}
                >
                  <span className={cn(
                    'flex size-5 shrink-0 items-center justify-center rounded-full text-[11px]',
                    done ? 'bg-primary text-primary-foreground' : active ? 'bg-primary/15 text-primary' : 'bg-muted-foreground/15',
                  )}>
                    {done ? <CheckIcon className="size-3" /> : s.index}
                  </span>
                  <SIcon className="size-3.5 opacity-70" />
                  <span className="truncate">{s.title}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* 底部操作区 */}
        <div className="flex items-center justify-between gap-2 border-t bg-muted/20 px-6 py-4">
          <div className="flex items-center gap-2">
            {stepIndex > 0 && (
              <Button variant="ghost" size="sm" onClick={goPrev}>
                上一步
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={finish}>
              跳过引导
            </Button>
          </div>
          <div className="flex items-center gap-2">
            {step.targetView && (
              <Button variant="outline" size="sm" onClick={handleGoToTarget}>
                去完成
                <ArrowRightIcon className="ml-1 size-3.5" />
              </Button>
            )}
            <Button size="sm" onClick={goNext}>
              {isLast ? '完成引导' : '下一步'}
              {!isLast && <ArrowRightIcon className="ml-1 size-3.5" />}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
