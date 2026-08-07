import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  WorkflowExecutionTarget,
  WorkflowPreflightResponse,
  WorkflowRunDetail,
  WorkflowUpgradeSuggestion,
} from '@lingfang/contract';
import {
  AlertTriangleIcon,
  GitBranchIcon,
  MonitorIcon,
  PlayIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  SquareIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { LoadingButton } from '@/components/loading-button';
import type { LoadedPlugin } from '@/lib/types';
import { errorMessage } from '@/lib/api';
import { createWorkflowUpgradeDraft } from '@/lib/plugin-registry';
import {
  cancelWorkflowRun,
  createDesktopWorkflowSession,
  driveDesktopWorkflowRun,
  getWorkflowRun,
  getWorkflowUpgradeSuggestions,
  hasDesktopWorkflowBridge,
  heartbeatDesktopWorkflowSession,
  preflightWorkflowRun,
  revokeDesktopWorkflowSession,
  startWorkflowRun,
  workflowDeadline,
  workflowIdempotencyKey,
} from '@/lib/workflow-client';
import {
  assessWorkflowExecutionSupport,
  decodeWorkflowDefinition,
  initialWorkflowInput,
  validateWorkflowInput,
  type WorkflowInputIssue,
} from '@/lib/workflow-runtime';
import { WorkflowDag, type WorkflowAttemptView } from './WorkflowDag';
import { WorkflowInputForm } from './WorkflowInputForm';

const TERMINAL_RUN_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'CANCELED']);
const SESSION_DIAGNOSTICS = new Set([
  'workflow_executor_session_invalid',
  'workflow_inventory_changed',
  'workflow_installation_mismatch',
]);

function attemptsForDag(run: WorkflowRunDetail | null): WorkflowAttemptView[] {
  return (run?.attempts ?? []).map((attempt) => ({
    id: attempt.id,
    node_id: attempt.node_id,
    attempt: attempt.attempt_number,
    status: attempt.status,
    action_id: attempt.target.action_id,
    package_id: attempt.target.package_id,
    release_id: attempt.target.release_id,
    release_sha256: attempt.target.sha256,
    action_contract_version: attempt.target.action_contract_version,
    started_at: attempt.started_at,
    completed_at: attempt.completed_at,
    error_code: attempt.error?.code ?? null,
    error_message: attempt.error?.message ?? null,
    output: attempt.output,
  }));
}

function statusLabel(status: string): string {
  return (
    (
      {
        PENDING: '准备中',
        RUNNING: '运行中',
        FAILING: '失败收口中',
        SUCCEEDED: '已完成',
        FAILED: '失败',
        CANCELING: '取消中',
        CANCELED: '已取消',
      } as Record<string, string>
    )[status] ?? status
  );
}

function statusVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'FAILED') return 'destructive';
  if (status === 'SUCCEEDED') return 'default';
  if (status === 'RUNNING' || status === 'FAILING' || status === 'CANCELING') return 'secondary';
  return 'outline';
}

function CompatibilityCard({
  icon,
  title,
  available,
  reason,
  selected = false,
  onSelect,
  disabled = false,
}: {
  icon: React.ReactNode;
  title: string;
  available: boolean;
  reason: string;
  selected?: boolean;
  onSelect?: () => void;
  disabled?: boolean;
}) {
  return (
    <Card
      size="sm"
      className={selected ? 'ring-2 ring-primary' : available ? 'ring-success/30' : undefined}
    >
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {icon}
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={available ? 'default' : 'secondary'}>
            {available ? '可用' : '不可用'}
          </Badge>
          {selected && <Badge variant="outline">当前选择</Badge>}
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">{reason}</p>
        {onSelect && (
          <Button
            type="button"
            variant={selected ? 'secondary' : 'outline'}
            size="sm"
            className="w-full"
            disabled={disabled || selected || !available}
            onClick={onSelect}
          >
            {selected ? '已选择' : `选择${title}`}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function DefinitionError({
  diagnostics,
}: {
  diagnostics: Array<{ code: string; path: string; message: string }>;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-muted/30 p-6">
      <div className="mx-auto max-w-3xl rounded-xl border border-destructive/30 bg-background p-5">
        <div className="flex items-start gap-3">
          <AlertTriangleIcon className="mt-0.5 size-5 text-destructive" />
          <div>
            <h3 className="font-semibold">工作流定义不可运行</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              入口文件未通过共享工作流契约校验，请由插件作者修复并发布新版本。
            </p>
          </div>
        </div>
        <div className="mt-4 flex flex-col gap-2">
          {diagnostics.map((diagnostic, index) => (
            <Alert
              key={`${diagnostic.path}-${index}`}
              variant="destructive"
              className="border-transparent bg-destructive/5"
            >
              <AlertTitle className="font-mono text-xs text-destructive">
                {diagnostic.code} · {diagnostic.path || '/'}
              </AlertTitle>
              <AlertDescription className="text-sm text-foreground">
                {diagnostic.message}
              </AlertDescription>
            </Alert>
          ))}
        </div>
      </div>
    </div>
  );
}

export function WorkflowRunner({
  plugin,
  onReady,
  onAdoptedDraft,
}: {
  plugin: LoadedPlugin;
  onReady: () => void;
  onAdoptedDraft: (draft: LoadedPlugin) => void;
}) {
  const decoded = useMemo(
    () => decodeWorkflowDefinition(plugin.files, plugin.entry),
    [plugin.entry, plugin.files]
  );
  useEffect(() => {
    onReady();
  }, [onReady]);
  if (!decoded.ok) return <DefinitionError diagnostics={decoded.diagnostics} />;
  return <RunnableWorkflow plugin={plugin} decoded={decoded} onAdoptedDraft={onAdoptedDraft} />;
}

function RunnableWorkflow({
  plugin,
  decoded,
  onAdoptedDraft,
}: {
  plugin: LoadedPlugin;
  decoded: Extract<ReturnType<typeof decodeWorkflowDefinition>, { ok: true }>;
  onAdoptedDraft: (draft: LoadedPlugin) => void;
}) {
  const support = useMemo(
    () => assessWorkflowExecutionSupport(plugin, { desktopShell: hasDesktopWorkflowBridge() }),
    [plugin]
  );
  const exactIdentity = Boolean(plugin.releaseId && plugin.releaseSha256);
  const [executionTarget, setExecutionTarget] = useState<WorkflowExecutionTarget>('DESKTOP');
  const [input, setInput] = useState(() => initialWorkflowInput(decoded.definition.input_schema));
  const [issues, setIssues] = useState<WorkflowInputIssue[]>([]);
  const [preflight, setPreflight] = useState<WorkflowPreflightResponse | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [preflightError, setPreflightError] = useState('');
  const [desktopSessionReady, setDesktopSessionReady] = useState(false);
  const [run, setRun] = useState<WorkflowRunDetail | null>(null);
  const [starting, setStarting] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [executorMessage, setExecutorMessage] = useState('');
  const [upgradeSuggestions, setUpgradeSuggestions] = useState<WorkflowUpgradeSuggestion[]>([]);
  const [adoptingUpgrades, setAdoptingUpgrades] = useState(false);
  const pollInFlight = useRef(false);
  const executorInFlight = useRef(false);
  const selectedSupport = executionTarget === 'DESKTOP' ? support.desktop : support.cloud;

  useEffect(() => {
    if (!plugin.releaseId) {
      setUpgradeSuggestions([]);
      return;
    }
    let active = true;
    void getWorkflowUpgradeSuggestions(plugin.releaseId)
      .then((response) => {
        if (active) setUpgradeSuggestions(response.suggestions);
      })
      .catch(() => {
        if (active) setUpgradeSuggestions([]);
      });
    return () => {
      active = false;
    };
  }, [plugin.releaseId]);

  useEffect(() => {
    if (executionTarget !== 'DESKTOP' || !support.desktop.available || !exactIdentity) {
      setDesktopSessionReady(false);
      return;
    }
    let active = true;
    void createDesktopWorkflowSession()
      .then(() => active && setDesktopSessionReady(true))
      .catch(
        (caught) => active && setPreflightError(errorMessage(caught, '桌面执行器 session 创建失败'))
      );
    return () => {
      active = false;
      void revokeDesktopWorkflowSession().catch(() => undefined);
    };
  }, [exactIdentity, executionTarget, support.desktop.available]);

  const refreshPreflight = useCallback(async () => {
    if (
      !plugin.releaseId ||
      !plugin.releaseSha256 ||
      !selectedSupport.available ||
      (executionTarget === 'DESKTOP' && !desktopSessionReady)
    )
      return;
    setPreflightLoading(true);
    setPreflightError('');
    try {
      setPreflight(
        await preflightWorkflowRun({
          workflow_release_id: plugin.releaseId,
          sha256: plugin.releaseSha256,
          execution_target: executionTarget,
          execution_scope: 'PRODUCTION',
          input: input as Record<string, never>,
          deadline_at: workflowDeadline(),
        })
      );
    } catch (caught) {
      setPreflight(null);
      setPreflightError(errorMessage(caught, '无法完成工作流预检'));
    } finally {
      setPreflightLoading(false);
    }
  }, [
    desktopSessionReady,
    executionTarget,
    input,
    plugin.releaseId,
    plugin.releaseSha256,
    selectedSupport.available,
  ]);

  useEffect(() => {
    if (
      !exactIdentity ||
      !selectedSupport.available ||
      (executionTarget === 'DESKTOP' && !desktopSessionReady)
    )
      return;
    const timer = window.setTimeout(() => {
      void refreshPreflight();
    }, 350);
    return () => window.clearTimeout(timer);
  }, [
    desktopSessionReady,
    exactIdentity,
    executionTarget,
    refreshPreflight,
    selectedSupport.available,
  ]);

  const refreshRun = useCallback(async () => {
    if (!run || pollInFlight.current) return;
    pollInFlight.current = true;
    try {
      setRun(await getWorkflowRun(run.id));
    } catch (caught) {
      setPreflightError(errorMessage(caught, '刷新工作流运行失败'));
    } finally {
      pollInFlight.current = false;
    }
  }, [run]);

  useEffect(() => {
    if (!run || run.execution_target !== 'DESKTOP' || TERMINAL_RUN_STATUSES.has(run.status)) return;
    const drive = async () => {
      if (executorInFlight.current) return;
      executorInFlight.current = true;
      try {
        const result = await driveDesktopWorkflowRun(run.id, run.plan.max_parallelism);
        if (result.failures.length) setExecutorMessage(result.failures[0]);
        if (result.claimed > 0) await refreshRun();
      } catch (caught) {
        setExecutorMessage(errorMessage(caught, '本地 Action 执行失败'));
      } finally {
        executorInFlight.current = false;
      }
    };
    void drive();
    const timer = window.setInterval(() => {
      void drive();
    }, 750);
    return () => window.clearInterval(timer);
  }, [refreshRun, run]);

  useEffect(() => {
    if (!run || TERMINAL_RUN_STATUSES.has(run.status)) return;
    const timer = window.setInterval(() => {
      void refreshRun();
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [refreshRun, run]);

  useEffect(() => {
    if (
      executionTarget !== 'DESKTOP' ||
      !desktopSessionReady ||
      (run && TERMINAL_RUN_STATUSES.has(run.status))
    )
      return;
    const timer = window.setInterval(() => {
      void heartbeatDesktopWorkflowSession().catch((caught) =>
        setPreflightError(errorMessage(caught, '桌面执行器 heartbeat 失败'))
      );
    }, 20_000);
    return () => window.clearInterval(timer);
  }, [desktopSessionReady, executionTarget, run]);

  useEffect(() => {
    if (!run || !TERMINAL_RUN_STATUSES.has(run.status) || run.execution_target !== 'DESKTOP')
      return;
    void revokeDesktopWorkflowSession().catch(() => undefined);
  }, [run]);

  const currentPreflight = preflight?.execution_target === executionTarget ? preflight : null;
  const blockingDiagnostics = (currentPreflight?.diagnostics ?? []).filter(
    (item) => item.severity === 'ERROR' && !SESSION_DIAGNOSTICS.has(item.code)
  );
  const policyAvailable = currentPreflight?.eligible === true;
  const canStart =
    selectedSupport.available &&
    exactIdentity &&
    policyAvailable &&
    !starting &&
    !run &&
    blockingDiagnostics.length === 0 &&
    (executionTarget === 'CLOUD' || desktopSessionReady);

  const selectExecutionTarget = (target: WorkflowExecutionTarget) => {
    if (run || executionTarget === target) return;
    setExecutionTarget(target);
    setPreflight(null);
    setPreflightError('');
    setExecutorMessage('');
  };

  const adoptUpgrades = async () => {
    if (!plugin.releaseId || adoptingUpgrades) return;
    setAdoptingUpgrades(true);
    try {
      // Refresh immediately before applying so a stale suggestion cannot edit
      // the copied workflow. The pure adopter also verifies the old exact target.
      const current = await getWorkflowUpgradeSuggestions(plugin.releaseId);
      if (!current.suggestions.length) throw new Error('当前已没有可采纳的兼容升级');
      const draft = await createWorkflowUpgradeDraft(plugin, current.suggestions);
      toast.success(`已创建 v${draft.version} 工作流草稿，发布前请确认完整校验结果`);
      onAdoptedDraft(draft);
    } catch (caught) {
      toast.error(errorMessage(caught, '创建升级草稿失败'));
    } finally {
      setAdoptingUpgrades(false);
    }
  };

  const start = async () => {
    const nextIssues = validateWorkflowInput(decoded.definition.input_schema, input);
    setIssues(nextIssues);
    if (nextIssues.length) return;
    if (
      !selectedSupport.available ||
      !plugin.releaseId ||
      !plugin.releaseSha256 ||
      (executionTarget === 'DESKTOP' && !desktopSessionReady)
    )
      return;
    setStarting(true);
    setPreflightError('');
    try {
      const created = await startWorkflowRun({
        workflow_release_id: plugin.releaseId,
        sha256: plugin.releaseSha256,
        execution_target: executionTarget,
        execution_scope: 'PRODUCTION',
        input: input as Record<string, never>,
        idempotency_key: workflowIdempotencyKey(),
        deadline_at: workflowDeadline(),
      });
      setRun(created);
      toast.success('工作流运行已创建');
    } catch (caught) {
      const message = errorMessage(caught, '启动工作流失败');
      setPreflightError(message);
      toast.error(message);
      void revokeDesktopWorkflowSession().catch(() => undefined);
    } finally {
      setStarting(false);
    }
  };

  const cancel = async () => {
    if (!run) return;
    setCanceling(true);
    try {
      setRun(await cancelWorkflowRun(run.id));
      toast.success('已请求取消工作流');
    } catch (caught) {
      toast.error(errorMessage(caught, '取消工作流失败'));
    } finally {
      setCanceling(false);
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-muted/30 p-4 sm:p-6">
      <div className="mx-auto flex max-w-6xl flex-col gap-5">
        <section className="flex flex-col gap-3 rounded-xl border bg-background p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <GitBranchIcon className="mt-0.5 size-8 shrink-0 text-primary" />
            <div className="min-w-0">
              <h2 className="truncate text-lg font-semibold">{plugin.name}</h2>
              <p className="text-sm text-muted-foreground">
                {decoded.definition.nodes.length} 个精确 Action 节点 · {decoded.levels.length}{' '}
                个阶段 · 最大并行 {decoded.maxParallelism}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <LoadingButton
              variant="outline"
              size="sm"
              loading={preflightLoading}
              disabled={
                !exactIdentity ||
                !selectedSupport.available ||
                (executionTarget === 'DESKTOP' && !desktopSessionReady)
              }
              onClick={() => void refreshPreflight()}
            >
              <RefreshCwIcon className="size-4" />
              重新预检
            </LoadingButton>
            {run && !TERMINAL_RUN_STATUSES.has(run.status) ? (
              <LoadingButton
                variant="destructive"
                size="sm"
                loading={canceling}
                onClick={() => void cancel()}
              >
                <SquareIcon className="size-3.5" />
                取消运行
              </LoadingButton>
            ) : (
              <LoadingButton
                size="sm"
                loading={starting}
                disabled={!canStart}
                title={selectedSupport.reason}
                onClick={() => void start()}
              >
                <PlayIcon className="size-4" />
                {executionTarget === 'CLOUD' ? '开始 Cloud 运行' : '开始本地运行'}
              </LoadingButton>
            )}
          </div>
        </section>

        <section className="grid gap-3 md:grid-cols-3">
          <CompatibilityCard
            icon={<MonitorIcon className="size-4" />}
            title="本地手动"
            available={support.desktop.available}
            reason={support.desktop.reason}
            selected={executionTarget === 'DESKTOP'}
            disabled={Boolean(run)}
            onSelect={() => selectExecutionTarget('DESKTOP')}
          />
          <CompatibilityCard
            icon={<ShieldCheckIcon className="size-4" />}
            title={`${executionTarget === 'CLOUD' ? 'Cloud' : '本地'}运行策略`}
            available={policyAvailable}
            reason={
              preflightLoading
                ? '正在检查精确发行版、执行位置与策略…'
                : preflightError ||
                  blockingDiagnostics[0]?.message ||
                  (currentPreflight?.eligible
                    ? '当前预检允许运行；启动时仍会实时复验'
                    : currentPreflight
                      ? '当前执行位置未通过预检'
                      : '等待平台预检')
            }
          />
        </section>

        {(preflightError || executorMessage) && (
          <Alert
            variant="destructive"
            className="border-destructive/30 bg-destructive/5 text-destructive"
          >
            <AlertDescription className="text-destructive">
              {preflightError || executorMessage}
            </AlertDescription>
          </Alert>
        )}
        {(currentPreflight?.diagnostics.length ?? 0) > 0 && (
          <details className="rounded-lg border bg-background p-3">
            <summary className="cursor-pointer text-sm font-medium">
              预检诊断（{currentPreflight!.diagnostics.length}）
            </summary>
            <div className="mt-3 flex flex-col gap-2">
              {currentPreflight!.diagnostics.map((item, index) => (
                <div key={`${item.code}-${index}`} className="rounded-md bg-muted/60 p-2 text-xs">
                  <p className="font-mono">
                    {item.severity} · {item.code}
                    {item.node_id ? ` · ${item.node_id}` : ''}
                  </p>
                  <p className="mt-1 text-muted-foreground">{item.message}</p>
                </div>
              ))}
            </div>
          </details>
        )}

        {upgradeSuggestions.length > 0 && (
          <Card size="sm">
            <CardHeader>
              <CardTitle>可升级依赖</CardTitle>
              <CardDescription>
                以下版本仍满足发布时声明的范围与 Action
                契约。平台不会修改当前发行版；采纳后需创建、验证并发布新的工作流版本。
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {upgradeSuggestions.map((suggestion) => (
                <div
                  key={suggestion.node_id}
                  className="flex flex-col gap-1 rounded-lg border bg-muted/30 p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
                >
                  <div>
                    <p className="font-medium">
                      {suggestion.node_id} · {suggestion.suggested_target.action_id}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {suggestion.current_version} → {suggestion.suggested_version} · 范围{' '}
                      {suggestion.declared_version_range}
                    </p>
                  </div>
                  <Badge variant="outline">仅建议</Badge>
                </div>
              ))}
              <LoadingButton
                className="w-full sm:w-auto sm:self-start"
                loading={adoptingUpgrades}
                onClick={() => void adoptUpgrades()}
              >
                采纳到草稿
              </LoadingButton>
            </CardContent>
          </Card>
        )}

        {!run && (
          <Card>
            <CardHeader>
              <CardTitle>运行输入</CardTitle>
              <CardDescription>
                当前将在{executionTarget === 'CLOUD' ? ' Cloud' : '本地桌面端'}执行；字段来自整体
                input schema，大文件只接受 ArtifactRef。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <WorkflowInputForm
                schema={decoded.definition.input_schema}
                value={input}
                issues={issues}
                disabled={starting}
                onChange={(next) => {
                  setInput(next);
                  setIssues([]);
                }}
              />
            </CardContent>
          </Card>
        )}

        {run && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                运行 {run.id}
                <Badge variant={statusVariant(run.status)}>{statusLabel(run.status)}</Badge>
              </CardTitle>
              <CardDescription>
                精确计划 {run.plan_sha256.slice(0, 12)}… · {run.execution_target} ·{' '}
                {run.execution_scope}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {run.error && (
                <Alert
                  variant="destructive"
                  className="border-transparent bg-destructive/10 text-destructive"
                >
                  <AlertTitle className="font-mono text-xs">{run.error.code}</AlertTitle>
                  <AlertDescription className="text-destructive">
                    {run.error.message}
                  </AlertDescription>
                </Alert>
              )}
              <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                <div className="rounded-md bg-muted p-2">完成 {run.attempt_counts.succeeded}</div>
                <div className="rounded-md bg-muted p-2">运行中 {run.attempt_counts.running}</div>
                <div className="rounded-md bg-muted p-2">失败 {run.attempt_counts.failed}</div>
                <div className="rounded-md bg-muted p-2">
                  取消/跳过 {run.attempt_counts.canceled + run.attempt_counts.skipped}
                </div>
              </div>
              {run.output != null && (
                <div>
                  <p className="mb-1 text-xs font-medium text-muted-foreground">最终输出</p>
                  <pre className="max-h-64 overflow-auto rounded-lg bg-muted p-3 text-xs">
                    {JSON.stringify(run.output, null, 2)}
                  </pre>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>只读执行图</CardTitle>
            <CardDescription>
              点击节点查看精确 release、Action 契约、重试和结构化错误；图中不提供拖拽或改线入口。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <WorkflowDag
              definition={decoded.definition}
              levels={decoded.levels}
              attempts={attemptsForDag(run)}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
