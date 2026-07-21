// Schedules.tsx —— 本地定时任务管理页（PRD R4）。
//
// 结构：
// - 顶部 banner：定时任务仅在应用运行时触发，关闭窗口将暂停所有任务。
// - 工具条：[+ 新建] [筛选：全部/激活/暂停/已完成]
// - 任务卡片列表：名称 + 类型徽章 + cron/时间 + 下次触发 + 上次结果 + 操作按钮
// - 编辑对话框（新建/编辑共用）：名称 / 类型 / 触发 / payload / timeout / 时区
// - 历史抽屉：单任务的 runs.jsonl 最近 200 条
//
// 与 Rust 端 commands.rs 一一对应，前端 API 封装在 lib/local-scheduler.ts。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  ClockIcon,
  PlusIcon,
  PlayIcon,
  PauseIcon,
  PencilIcon,
  TrashIcon,
  HistoryIcon,
  AlertTriangleIcon,
  RefreshCwIcon,
  BellIcon,
  BotIcon,
  PackageIcon,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { StaggerContainer, StaggerItem, Shimmer } from '@/lib/motion';
import { errorMessage } from '@/lib/api';
import {
  schedulerList,
  schedulerDelete,
  schedulerPause,
  schedulerResume,
  schedulerRunNow,
  schedulerListRuns,
} from '@/lib/local-scheduler';
import type {
  LocalSchedule,
  LocalScheduleRun,
  LocalScheduleStatus,
  LocalScheduleTrigger,
  LocalTaskPayload,
} from '@lingfang/contract';
import { ScheduleEditDialog } from '@/components/schedules/ScheduleEditDialog';

/** 筛选器。 */
type Filter = 'ALL' | 'ACTIVE' | 'PAUSED' | 'COMPLETED';

export function Schedules() {
  const [tasks, setTasks] = useState<LocalSchedule[] | null>(null);
  const [filter, setFilter] = useState<Filter>('ALL');
  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState<LocalSchedule | null>(null);
  const [historyTask, setHistoryTask] = useState<LocalSchedule | null>(null);
  const [runs, setRuns] = useState<LocalScheduleRun[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await schedulerList();
      setTasks(list);
    } catch (e) {
      toast.error(errorMessage(e, '加载定时任务失败'));
      setTasks([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    if (!tasks) return null;
    if (filter === 'ALL') return tasks;
    return tasks.filter((t) => t.status === filter);
  }, [tasks, filter]);

  // 历史抽屉打开时加载 runs。
  useEffect(() => {
    if (!historyTask) {
      setRuns(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const list = await schedulerListRuns(historyTask.id, 200);
        if (!cancelled) setRuns(list);
      } catch (e) {
        if (!cancelled) {
          toast.error(errorMessage(e, '加载历史失败'));
          setRuns([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [historyTask]);

  function openCreate() {
    setEditing(null);
    setEditOpen(true);
  }
  function openEdit(task: LocalSchedule) {
    setEditing(task);
    setEditOpen(true);
  }
  async function onSaved() {
    setEditOpen(false);
    setEditing(null);
    await load();
  }

  async function onPause(id: string) {
    setBusyId(id);
    try {
      await schedulerPause(id);
      toast.success('已暂停');
      await load();
    } catch (e) {
      toast.error(errorMessage(e, '暂停失败'));
    } finally {
      setBusyId(null);
    }
  }
  async function onResume(id: string) {
    setBusyId(id);
    try {
      await schedulerResume(id);
      toast.success('已恢复');
      await load();
    } catch (e) {
      toast.error(errorMessage(e, '恢复失败'));
    } finally {
      setBusyId(null);
    }
  }
  async function onRunNow(id: string) {
    setBusyId(id);
    try {
      await schedulerRunNow(id);
      toast.success('已加入执行队列');
    } catch (e) {
      toast.error(errorMessage(e, '立即运行失败'));
    } finally {
      setBusyId(null);
    }
  }
  async function onDelete(id: string) {
    if (!window.confirm('确定删除此定时任务？此操作不可恢复。')) return;
    setBusyId(id);
    try {
      await schedulerDelete(id);
      toast.success('已删除');
      await load();
    } catch (e) {
      toast.error(errorMessage(e, '删除失败'));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      {/* Banner：明示任务生命周期。 */}
      <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
        <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
        <div>
          <p className="font-medium">定时任务仅在应用运行时触发</p>
          <p className="mt-0.5 text-xs opacity-90">关闭窗口或退出应用将暂停所有任务；漏掉的任务不会自动补跑。</p>
        </div>
      </div>

      {/* 工具条。 */}
      <div className="flex items-center gap-2">
        <Button onClick={openCreate} size="sm" className="gap-1.5">
          <PlusIcon className="size-4" />新建任务
        </Button>
        <Select value={filter} onValueChange={(v) => setFilter(v as Filter)}>
          <SelectTrigger className="h-9 w-40" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">全部</SelectItem>
            <SelectItem value="ACTIVE">激活中</SelectItem>
            <SelectItem value="PAUSED">已暂停</SelectItem>
            <SelectItem value="COMPLETED">已完成</SelectItem>
          </SelectContent>
        </Select>
        <Button onClick={load} variant="ghost" size="icon-sm" title="刷新" disabled={!tasks}>
          <RefreshCwIcon className="size-4" />
        </Button>
      </div>

      {/* 任务列表。 */}
      <Card className="flex-1 overflow-hidden">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ClockIcon className="size-5 text-primary" />本地定时任务
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-y-auto">
          {filtered === null ? (
            <div className="flex flex-col gap-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Shimmer key={i} className="h-24 w-full" />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState onCreate={openCreate} />
          ) : (
            <StaggerContainer className="flex flex-col gap-3" stagger={0.05}>
              {filtered.map((task) => (
                <StaggerItem key={task.id}>
                  <TaskCard
                    task={task}
                    busy={busyId === task.id}
                    onEdit={() => openEdit(task)}
                    onPause={() => onPause(task.id)}
                    onResume={() => onResume(task.id)}
                    onRunNow={() => onRunNow(task.id)}
                    onDelete={() => onDelete(task.id)}
                    onHistory={() => setHistoryTask(task)}
                  />
                </StaggerItem>
              ))}
            </StaggerContainer>
          )}
        </CardContent>
      </Card>

      {/* 编辑/新建对话框。 */}
      <ScheduleEditDialog
        open={editOpen}
        editing={editing}
        onClose={() => {
          setEditOpen(false);
          setEditing(null);
        }}
        onSaved={onSaved}
      />

      {/* 历史抽屉。 */}
      <Sheet open={!!historyTask} onOpenChange={(o) => !o && setHistoryTask(null)}>
        <SheetContent side="right" className="flex w-full flex-col gap-4 sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <HistoryIcon className="size-4" />
              执行历史{historyTask ? `·${historyTask.name}` : ''}
            </SheetTitle>
            <SheetDescription>最近 200 条运行记录（最新在前）</SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto">
            {runs === null ? (
              <div className="flex flex-col gap-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Shimmer key={i} className="h-16 w-full" />
                ))}
              </div>
            ) : runs.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">暂无运行记录</p>
            ) : (
              <div className="flex flex-col gap-2">
                {runs.map((run) => (
                  <RunItem key={run.id} run={run} />
                ))}
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

// —— 任务卡片 ——
function TaskCard({
  task,
  busy,
  onEdit,
  onPause,
  onResume,
  onRunNow,
  onDelete,
  onHistory,
}: {
  task: LocalSchedule;
  busy: boolean;
  onEdit: () => void;
  onPause: () => void;
  onResume: () => void;
  onRunNow: () => void;
  onDelete: () => void;
  onHistory: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-medium">{task.name}</h3>
            <StatusBadge status={task.status} />
            <PayloadTypeBadge payload={task.payload} />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{describeTrigger(task.trigger)}</p>
        </div>
        <div className="shrink-0 text-right text-xs text-muted-foreground">
          {task.next_run_at ? (
            <>
              <p className="font-medium text-foreground">下次触发</p>
              <p>{formatTime(task.next_run_at)}</p>
            </>
          ) : (
            <p>—</p>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <Button
          variant="outline"
          size="sm"
          onClick={onRunNow}
          disabled={busy || task.status === 'COMPLETED'}
          className="gap-1.5"
        >
          <PlayIcon className="size-3.5" />立即运行
        </Button>
        {task.status === 'ACTIVE' ? (
          <Button variant="outline" size="sm" onClick={onPause} disabled={busy} className="gap-1.5">
            <PauseIcon className="size-3.5" />暂停
          </Button>
        ) : task.status === 'PAUSED' ? (
          <Button variant="outline" size="sm" onClick={onResume} disabled={busy} className="gap-1.5">
            <PlayIcon className="size-3.5" />恢复
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" onClick={onEdit} disabled={busy} className="gap-1.5">
          <PencilIcon className="size-3.5" />编辑
        </Button>
        <Button variant="ghost" size="sm" onClick={onHistory} className="gap-1.5">
          <HistoryIcon className="size-3.5" />历史
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onDelete}
          disabled={busy}
          className="ml-auto gap-1.5 text-destructive hover:text-destructive"
        >
          <TrashIcon className="size-3.5" />删除
        </Button>
      </div>
    </div>
  );
}

// —— Run 历史项 ——
function RunItem({ run }: { run: LocalScheduleRun }) {
  return (
    <div className="flex items-start gap-2 rounded-md border bg-background p-2.5 text-xs">
      <RunStatusIcon status={run.status} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <RunStatusBadge status={run.status} />
          <span className="text-muted-foreground">{formatTime(run.started_at)}</span>
          {run.duration_ms != null && (
            <span className="text-muted-foreground">耗时 {(run.duration_ms / 1000).toFixed(1)}s</span>
          )}
        </div>
        {run.skip_reason && <p className="mt-1 text-muted-foreground">原因：{run.skip_reason}</p>}
        {run.error && <p className="mt-1 text-destructive">错误：{run.error}</p>}
        {run.output_summary && (
          <p className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-foreground">
            {run.output_summary}
          </p>
        )}
      </div>
    </div>
  );
}

// —— 空状态 ——
function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-muted">
        <ClockIcon className="size-6 text-muted-foreground" />
      </div>
      <div>
        <p className="text-sm font-medium">还没有定时任务</p>
        <p className="mt-1 text-xs text-muted-foreground">创建一个任务，让 Agent 或插件在指定时间自动运行</p>
      </div>
      <Button onClick={onCreate} size="sm" className="gap-1.5">
        <PlusIcon className="size-4" />新建任务
      </Button>
    </div>
  );
}

// —— 辅助组件 ——
function StatusBadge({ status }: { status: LocalScheduleStatus }) {
  const variant =
    status === 'ACTIVE'
      ? 'default'
      : status === 'PAUSED'
        ? 'secondary'
        : status === 'COMPLETED'
          ? 'outline'
          : 'destructive';
  const text =
    status === 'ACTIVE' ? '激活' : status === 'PAUSED' ? '暂停' : status === 'COMPLETED' ? '已完成' : '已删除';
  return <Badge variant={variant}>{text}</Badge>;
}

function PayloadTypeBadge({ payload }: { payload: LocalTaskPayload }) {
  if (payload.type === 'AGENT_PROMPT') {
    return (
      <Badge variant="outline" className="gap-1">
        <BotIcon className="size-3" />Agent
      </Badge>
    );
  }
  if (payload.type === 'PLUGIN_ACTION') {
    return (
      <Badge variant="outline" className="gap-1">
        <PackageIcon className="size-3" />插件
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1">
      <BellIcon className="size-3" />通知
    </Badge>
  );
}

function RunStatusBadge({ status }: { status: LocalScheduleRun['status'] }) {
  const map: Record<LocalScheduleRun['status'], { text: string; className: string }> = {
    RUNNING: { text: '运行中', className: 'text-blue-600' },
    SUCCESS: { text: '成功', className: 'text-green-600' },
    FAILED: { text: '失败', className: 'text-red-600' },
    TIMEOUT: { text: '超时', className: 'text-orange-600' },
    SKIPPED: { text: '跳过', className: 'text-muted-foreground' },
  };
  const entry = map[status];
  return <span className={`text-xs font-medium ${entry.className}`}>{entry.text}</span>;
}

function RunStatusIcon({ status }: { status: LocalScheduleRun['status'] }) {
  if (status === 'SUCCESS') return <div className="mt-0.5 size-2 shrink-0 rounded-full bg-green-500" />;
  if (status === 'FAILED') return <div className="mt-0.5 size-2 shrink-0 rounded-full bg-red-500" />;
  if (status === 'TIMEOUT') return <div className="mt-0.5 size-2 shrink-0 rounded-full bg-orange-500" />;
  if (status === 'RUNNING') return <div className="mt-0.5 size-2 shrink-0 rounded-full bg-blue-500" />;
  return <div className="mt-0.5 size-2 shrink-0 rounded-full bg-muted-foreground" />;
}

function describeTrigger(trigger: LocalScheduleTrigger): string {
  if (trigger.kind === 'ONCE') {
    return `一次性触发 · ${formatTime(trigger.run_at)}`;
  }
  return `周期触发 · ${trigger.cron}（${trigger.time_zone}）`;
}

/** ISO 字符串 → 本地可读时间。 */
function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}
