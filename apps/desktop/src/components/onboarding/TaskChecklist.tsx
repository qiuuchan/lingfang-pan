// TaskChecklist.tsx — 新手任务清单（首次登录引导，纯前端，进度持久化）。
//
// 背景：用户首登进入创建页看不到「需先装 CLI / 配模型 / 发起对话 / 预览 / 上传团队」的完整路径，
// 容易流失。本组件用 Dialog 弹出 5 步任务清单，每步可点击跳转到对应页面/动作，
// 完成全部后写 localStorage 标记 done，下次不再弹。
//
// 持久化（对齐 lf: 前缀命名 + userId 隔离，见 onboarding-progress.ts）：
// - `lf:onboarding-done:{userId}`：'1' 表示该用户已完成全部任务（不再弹）。
// - `lf:task-progress:{userId}`：记录每步完成态（boolean[5]），跨会话保留进度。
//
// 完成判定：
// - 单步「标记完成」由用户点「我已完成」按钮触发（不自动探测真实状态——探测有延迟且可能误判，
//   让用户自主确认更符合「任务清单」语义，避免「明明装了却一直灰着」的困惑）。
// - 全部 5 步打勾 → 写 onboarding-done。
//
// 跳转：通过 setView 切到对应页面（Settings/Plugins 等），与现有导航一致；
// Settings 页落地到对应 Tab（cli/gateway），由父组件 App 持有受控 settingsTab 态。

import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { LoadingButton } from '@/components/loading-button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { CircleCheckIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Session, View } from '@/lib/types';
import { TASK_STEPS } from '@/components/onboarding/task-steps';
import {
  clearDone,
  isAllDone,
  loadDone,
  loadProgress,
  saveDone,
  saveProgress,
} from '@/lib/onboarding-progress';

interface TaskChecklistProps {
  /** 当前登录态（取 userId 做进度隔离）。 */
  session: Session;
  /** 跳转页面（与 App setView 一致）。 */
  setView: (v: View) => void;
  /** 切到 Settings 页时落到哪个 Tab。父组件持有 Settings 的 Tab 受控态并传入 setter。 */
  setSettingsTab: (tab: 'cli' | 'gateway' | 'backend') => void;
}

export function TaskChecklist({ session, setView, setSettingsTab }: TaskChecklistProps) {
  // 是否已全部完成（不再弹）。默认 true（loading 态不弹，避免首帧闪烁已完成的清单）。
  const [completed, setCompleted] = useState(true);
  // 会话内「稍后再说」关闭：仅本次会话不弹，不写持久化（用户未真正完成不应永久静默）。
  const [dismissed, setDismissed] = useState(false);
  const [done, setDone] = useState<boolean[]>(TASK_STEPS.map(() => false));

  // 挂载时读取持久化状态：未完成 → 弹 Dialog；已记录的进度回填 checkbox。
  useEffect(() => {
    setCompleted(loadDone(session.userId));
    setDismissed(false);
    setDone(loadProgress(session.userId, TASK_STEPS));
  }, [session.userId]);

  const finishedCount = useMemo(() => done.filter(Boolean).length, [done]);
  const allDone = isAllDone(done);

  /** 单步「我已完成」按钮：翻转该步态 + 持久化。全完成时写 done 标记。 */
  function toggleStep(index: number) {
    setDone((prev) => {
      const next = prev.map((v, i) => (i === index ? !v : v));
      saveProgress(session.userId, next);
      if (isAllDone(next)) {
        saveDone(session.userId);
        setCompleted(true);
      } else if (completed) {
        // 取消某步勾选 → 撤回「已完成」标记（允许用户重新打开清单调整）。
        clearDone(session.userId);
        setCompleted(false);
      }
      return next;
    });
  }

  /** 「去完成」按钮：跳转到对应页面（Settings 落到对应 Tab）。不自动关闭 Dialog，便于完成后回来打勾。 */
  function gotoStep(stepIndex: number) {
    const step = TASK_STEPS[stepIndex];
    if (step.view === 'settings' && step.settingsTab) {
      setSettingsTab(step.settingsTab);
    }
    setView(step.view);
  }

  // 不渲染：已全部完成（不再弹 Dialog）或本次会话已「稍后再说」关闭。
  if (completed || dismissed) return null;

  return (
    <Dialog open onOpenChange={() => { /* 不允许外点/Esc 关闭，强制走任务流程（仅「稍后再说」可关） */ }}>
      <DialogContent showCloseButton={false} className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <span>新手任务清单</span>
            <span className="text-xs font-normal text-muted-foreground">{finishedCount}/{TASK_STEPS.length}</span>
          </DialogTitle>
          <DialogDescription>
            按顺序完成以下 5 步，即可上手用 AI 创建并分享插件。每完成一步回来打勾。
          </DialogDescription>
        </DialogHeader>

        {/* 进度条 */}
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${(finishedCount / TASK_STEPS.length) * 100}%` }}
          />
        </div>

        {/* 任务列表 */}
        <div className="flex flex-col gap-1.5">
          {TASK_STEPS.map((step, index) => {
            const isStepDone = done[index];
            const Icon = step.icon;
            return (
              <div
                key={index}
                className={cn(
                  'flex items-start gap-3 rounded-lg border p-3 transition-colors',
                  isStepDone ? 'border-primary/30 bg-primary/5' : 'border-border bg-background',
                )}
              >
                <div className={cn(
                  'flex size-8 shrink-0 items-center justify-center rounded-full',
                  isStepDone ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
                )}>
                  {isStepDone ? <CircleCheckIcon className="size-4" /> : <Icon className="size-4" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{index + 1}. {step.title}</span>
                  </div>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{step.description}</p>
                  <div className="mt-2 flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => gotoStep(index)}
                    >
                      去完成
                    </Button>
                    <Button
                      variant={isStepDone ? 'secondary' : 'ghost'}
                      size="sm"
                      onClick={() => toggleStep(index)}
                    >
                      {isStepDone ? '取消完成' : '我已完成'}
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* 底部操作 */}
        <div className="flex items-center justify-between gap-2 border-t pt-3">
          <span className="text-xs text-muted-foreground">
            {allDone ? '太棒了，你已掌握全部基础操作！' : '可随时关闭本窗口，进度已自动保存。'}
          </span>
          <LoadingButton
            variant="outline"
            loading={false}
            onClick={() => {
              // 「稍后再说」：仅本次会话关闭（不写持久化完成标记）。
              // 未完成进度已自动保存（saveProgress），下次启动或登录仍会弹出继续引导。
              setDismissed(true);
            }}
          >
            稍后再说
          </LoadingButton>
        </div>
      </DialogContent>
    </Dialog>
  );
}
