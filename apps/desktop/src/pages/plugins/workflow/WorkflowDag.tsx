import type { WorkflowDefinitionV1 } from '@lingfang/contract';
import {
  BanIcon,
  CheckCircle2Icon,
  CircleDashedIcon,
  Clock3Icon,
  Loader2Icon,
  XCircleIcon,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export type WorkflowAttemptView = {
  id: string;
  node_id: string;
  attempt: number;
  status: string;
  action_id: string;
  package_id: string;
  release_id: string;
  release_sha256: string;
  action_contract_version: string;
  started_at: string | null;
  completed_at: string | null;
  error_code: string | null;
  error_message: string | null;
  output: unknown | null;
};

const STATUS_TEXT: Record<string, string> = {
  PENDING: '等待依赖',
  READY: '等待执行',
  RUNNING: '执行中',
  SUCCEEDED: '已完成',
  FAILED: '失败',
  SKIPPED: '已跳过',
  CANCELED: '已取消',
};

function StatusIcon({ status }: { status: string }) {
  if (status === 'RUNNING') return <Loader2Icon className="size-4 animate-spin text-primary" />;
  if (status === 'SUCCEEDED') return <CheckCircle2Icon className="size-4 text-success" />;
  if (status === 'FAILED') return <XCircleIcon className="size-4 text-destructive" />;
  if (status === 'SKIPPED' || status === 'CANCELED')
    return <BanIcon className="size-4 text-muted-foreground" />;
  if (status === 'READY') return <Clock3Icon className="size-4 text-warning" />;
  return <CircleDashedIcon className="size-4 text-muted-foreground" />;
}

function shortDigest(value: string): string {
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function latestAttempts(attempts: WorkflowAttemptView[]): Map<string, WorkflowAttemptView> {
  const latest = new Map<string, WorkflowAttemptView>();
  attempts.forEach((attempt) => {
    const current = latest.get(attempt.node_id);
    if (!current || attempt.attempt > current.attempt) latest.set(attempt.node_id, attempt);
  });
  return latest;
}

export function WorkflowDag({
  definition,
  levels,
  attempts = [],
}: {
  definition: WorkflowDefinitionV1;
  levels: string[][];
  attempts?: WorkflowAttemptView[];
}) {
  const nodeById = new Map(definition.nodes.map((node) => [node.node_id, node]));
  const latest = latestAttempts(attempts);
  return (
    <div className="overflow-x-auto pb-2">
      <div className="grid min-w-max auto-cols-[minmax(220px,260px)] grid-flow-col items-start gap-8">
        {levels.map((level, levelIndex) => (
          <div key={levelIndex} className="relative flex flex-col gap-3">
            <div className="sticky top-0 z-10 bg-background/90 pb-1 text-center text-[11px] font-medium uppercase tracking-wide text-muted-foreground backdrop-blur">
              阶段 {levelIndex + 1}
            </div>
            {level.map((nodeId) => {
              const node = nodeById.get(nodeId);
              if (!node) return null;
              const attempt = latest.get(nodeId);
              const status = attempt?.status ?? 'PENDING';
              return (
                <details
                  key={nodeId}
                  className={cn(
                    'group relative rounded-xl border bg-card shadow-sm transition-colors',
                    status === 'RUNNING' && 'border-primary/60',
                    status === 'FAILED' && 'border-destructive/60',
                    status === 'SUCCEEDED' && 'border-success/50'
                  )}
                >
                  {levelIndex > 0 && (
                    <span
                      aria-hidden
                      className="absolute -left-8 top-7 h-px w-8 bg-border after:absolute after:-right-px after:-top-1 after:size-2 after:rotate-45 after:border-r after:border-t after:border-border"
                    />
                  )}
                  <summary className="cursor-pointer list-none p-3 marker:hidden">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold">{node.node_id}</p>
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                          {node.target.action_id}
                        </p>
                      </div>
                      <StatusIcon status={status} />
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-1.5">
                      <Badge variant="secondary">{STATUS_TEXT[status] ?? status}</Badge>
                      {attempt && attempt.attempt > 0 && (
                        <Badge variant="outline">重试 {attempt.attempt}</Badge>
                      )}
                    </div>
                  </summary>
                  <div className="flex flex-col gap-2 border-t px-3 py-2.5 text-xs">
                    <p>
                      <span className="text-muted-foreground">依赖：</span>
                      {node.depends_on.join(', ') || '无'}
                    </p>
                    <p className="break-all">
                      <span className="text-muted-foreground">Package：</span>
                      {node.target.package_id}
                    </p>
                    <p className="break-all">
                      <span className="text-muted-foreground">Release：</span>
                      {node.target.release_id}
                    </p>
                    <p>
                      <span className="text-muted-foreground">SHA：</span>
                      {shortDigest(node.target.sha256)}
                    </p>
                    <p>
                      <span className="text-muted-foreground">契约：</span>v
                      {node.target.action_contract_version}
                    </p>
                    <p>
                      <span className="text-muted-foreground">重试上限：</span>
                      {node.retry_limit}
                    </p>
                    {attempt?.error_message && (
                      <Alert
                        variant="destructive"
                        className="border-transparent bg-destructive/10 text-destructive"
                      >
                        <AlertTitle className="text-xs">
                          {attempt.error_code || 'workflow_step_failed'}
                        </AlertTitle>
                        <AlertDescription className="whitespace-pre-wrap text-xs text-destructive">
                          {attempt.error_message}
                        </AlertDescription>
                      </Alert>
                    )}
                    {attempt?.output != null && (
                      <pre className="max-h-36 overflow-auto rounded-md bg-muted p-2 text-[11px]">
                        {JSON.stringify(attempt.output, null, 2)}
                      </pre>
                    )}
                  </div>
                </details>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
