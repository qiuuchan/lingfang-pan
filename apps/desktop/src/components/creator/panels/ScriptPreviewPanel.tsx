// ScriptPreviewPanel.tsx — Python/Node 脚本型插件运行面板（task 06-16 组C 改造）。
//
// 双模式（PRD AC3/AC5/AC8 + 保留创建期预览能力）：
// 1. 持久化运行（pluginId 提供时，从 Plugins Runner 进入）：调 start_plugin / stop_plugin。
//    Python 用 .venv 隔离 + pip install（若有 requirements.txt）；Node 用 pnpm install + pnpm start。
//    作为独立进程运行（外部窗口/终端），软件内仅显示「运行中」状态 + 进程信息 + 「停止」按钮。
//    PRD 需求 5/9：Python/Node 独立运行在外部，不在软件 UI 内嵌入终端输出。
// 2. 创建期预览（pluginId 缺失时，从 PreviewPanel/PreviewDrawer 进入）：调 run_plugin_script。
//    一次性 sandbox 执行（创建期插件尚未持久化，无法走独立进程），软件内终端回显 stdout/stderr。
//    保留 R3 行为：创建对话中即时预览生成出的脚本是否能跑通。
//
// 数据来源：
// - files：Plugins Runner 传入（持久化已落地）或 PreviewPanel 传入（创建期内存草稿）。
// - pluginId：持久化目录下的插件 id（仅 Plugins Runner 提供）。
// - runtime：nodejs/python，决定 RUNTIME_LABEL 文案与探测策略。
//
// 缺失解释器降级：两种模式都保留 probe 探测 + 安装指引（start/run 均依赖解释器存在）。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { PlayIcon, RefreshCwIcon, SquareIcon, TerminalIcon, Code2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LoadingButton } from '@/components/loading-button';
import { ErrorBubble } from '@/components/chat/ErrorBubble';
import { fromRunResult, toCreatorError, type CreatorError } from '@/lib/creator-error';
import {
  probeScriptRuntime,
  runPluginScript,
  RUNTIME_LABEL,
  type ProbeResult,
  type ScriptRuntime,
} from '@/lib/plugin-script';
import {
  scanPluginStatus,
  startPlugin,
  stopPlugin,
} from '@/lib/plugin-status';
import { parseManifest } from '@/lib/plugin-draft';
import { errorMessage } from '@/pages/plugins-runtime';
import type { DraftFile } from '@/lib/types';

type ProbeState =
  | { status: 'idle' }
  | { status: 'probing' }
  | { status: 'missing'; result: ProbeResult }
  | { status: 'ready'; binary?: string; version?: string };

// 组C 持久化运行态：独立进程运行（不再嵌入式终端回显）。
// running/stopping 都带 pid+startedAt，便于停止失败时回退到 running 态保留进程信息。
type PersistentRunState =
  | { status: 'idle' }
  | { status: 'starting' }
  | { status: 'running'; pid: number; startedAt: string }
  | { status: 'stopping'; pid: number; startedAt: string }
  | { status: 'error'; error: CreatorError };

// 创建期预览运行态（保留 R3 一次性 sandbox 执行语义）。
type PreviewRunState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'done'; stdout: string; stderr: string; exitCode: number | null; elapsedMs: number }
  | { status: 'error'; error: CreatorError };

export function ScriptPreviewPanel({
  pluginId,
  files,
  runtime,
  previewKey,
  onRefresh,
}: {
  // 持久化目录下的插件 id（提供时走持久化独立进程运行；缺失时走创建期 sandbox 预览）。
  pluginId?: string;
  files: DraftFile[];
  runtime: ScriptRuntime;
  previewKey: number;
  onRefresh: () => void;
}) {
  const [probe, setProbe] = useState<ProbeState>({ status: 'idle' });
  const [persistentRun, setPersistentRun] = useState<PersistentRunState>({ status: 'idle' });
  const [previewRun, setPreviewRun] = useState<PreviewRunState>({ status: 'idle' });
  // 降级：用户主动选择「仍要预览源码」（不执行脚本，只读展示入口文件）。
  const [sourceView, setSourceView] = useState(false);

  const manifest = useMemo(() => parseManifest(files), [files]);
  const entryFile = useMemo(
    () => files.find((file) => file.path === manifest.entry),
    [files, manifest.entry],
  );
  // 模式判定：有 pluginId 走持久化独立进程，无则走创建期 sandbox 预览。
  const usePersistent = Boolean(pluginId);

  // 探测解释器（design §3.5：首次进入先 probe）。start/run 均依赖解释器存在，缺失时前置拦截。
  const doProbe = useCallback(async () => {
    setProbe({ status: 'probing' });
    try {
      const result = await probeScriptRuntime(runtime);
      if (result.available) {
        setProbe({
          status: 'ready',
          binary: result.binary_path ?? undefined,
          version: result.version ?? undefined,
        });
      } else {
        setProbe({ status: 'missing', result });
      }
    } catch (error) {
      // probe 自身异常（极端：Tauri 通道错误）归为 missing，展示通用指引 + 可重试。
      setProbe({
        status: 'missing',
        result: { available: false, binary_path: null, version: null, hint: error instanceof Error ? error.message : String(error) },
      });
    }
  }, [runtime]);

  // 组C：持久化模式下挂载时 + pluginId 变化时先 scan_plugin_status 同步当前运行态。
  // 用户从 Plugins 进入 Runner 时进程可能已在跑，据此回填 running 态。
  const syncRunState = useCallback(async () => {
    if (!usePersistent) return;
    try {
      const items = await scanPluginStatus();
      const current = items.find((item) => item.id === pluginId);
      if (current && current.status === 'running' && current.pid != null) {
        setPersistentRun({ status: 'running', pid: current.pid, startedAt: current.started_at || new Date().toISOString() });
      }
    } catch {
      // scan 失败静默（Rust 未实现时降级，不阻断 probe + 运行）。
    }
  }, [pluginId, usePersistent]);

  useEffect(() => {
    // previewKey 变化（外部刷新）或 runtime/pluginId 变化时重新探测 + 清运行态。
    setPersistentRun({ status: 'idle' });
    setPreviewRun({ status: 'idle' });
    setSourceView(false);
    void doProbe();
    void syncRunState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime, previewKey, pluginId]);

  // === 组C 持久化运行：启动/停止独立进程 ===
  const handleStart = useCallback(async () => {
    if (!pluginId) return;
    setPersistentRun({ status: 'starting' });
    try {
      const result = await startPlugin(pluginId);
      setPersistentRun({ status: 'running', pid: result.pid, startedAt: result.started_at });
      toast.success(`${RUNTIME_LABEL[runtime]} 插件已启动，运行在独立进程`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 解释器缺失：start_plugin 返回 interpreter_missing: 前缀（与 run_plugin_script 同款）。
      if (message.startsWith('interpreter_missing:')) {
        setPersistentRun({
          status: 'error',
          error: fromRunResult({ ok: false, failure: 'interpreter_missing', stderr: message.slice('interpreter_missing:'.length) }),
        });
      } else {
        setPersistentRun({ status: 'error', error: toCreatorError('run_spawn_failed', error) });
      }
    }
  }, [pluginId, runtime]);

  const handleStop = useCallback(async () => {
    if (!pluginId) return;
    setPersistentRun((prev) => (prev.status === 'running' ? { status: 'stopping', pid: prev.pid, startedAt: prev.startedAt } : prev));
    try {
      await stopPlugin(pluginId);
      setPersistentRun({ status: 'idle' });
      toast.success('插件已停止');
    } catch (error) {
      toast.error(`停止失败：${errorMessage(error)}`);
      // 停止失败回退到 running 态（进程可能仍在跑）。
      setPersistentRun((prev) => {
        if (prev.status === 'stopping') return { status: 'running', pid: prev.pid, startedAt: prev.startedAt };
        return prev;
      });
    }
  }, [pluginId]);

  // === 创建期预览运行：run_plugin_script 一次性 sandbox 执行 ===
  const handlePreviewRun = useCallback(async () => {
    if (!entryFile) return;
    setPreviewRun({ status: 'running' });
    try {
      const result = await runPluginScript({
        pluginId: pluginId || manifest.id,
        runtime,
        entry: manifest.entry,
        files: files.filter((file) => file.path !== 'manifest.json'),
      });
      if (result.ok && !result.failure) {
        setPreviewRun({
          status: 'done',
          stdout: result.stdout ?? '',
          stderr: result.stderr ?? '',
          exitCode: result.exitCode ?? null,
          elapsedMs: result.elapsedMs ?? 0,
        });
      } else {
        setPreviewRun({ status: 'error', error: fromRunResult(result) });
      }
    } catch (error) {
      setPreviewRun({
        status: 'error',
        error: fromRunResult({ ok: false, failure: 'spawn_failed', stderr: error instanceof Error ? error.message : String(error) }),
      });
    }
  }, [entryFile, files, manifest.entry, manifest.id, pluginId, runtime]);

  // === 缺失解释器降级视图（两种模式共用） ===
  if (probe.status === 'missing') {
    return (
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <TerminalIcon className="size-4" />{RUNTIME_LABEL[runtime]} 运行
          </CardTitle>
          <Button variant="ghost" size="icon-sm" onClick={onRefresh}><RefreshCwIcon className="size-4" /></Button>
        </CardHeader>
        <CardContent className="space-y-3">
          <ErrorBubble
            error={fromRunResult({ ok: false, failure: 'interpreter_missing', interpreter: undefined })}
            onRetry={probe.status === 'missing' ? doProbe : undefined}
          />
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={doProbe}>
              <RefreshCwIcon className="size-3.5" />重试检测
            </Button>
            {entryFile && (
              <Button variant="ghost" size="sm" onClick={() => setSourceView(true)}>
                <Code2Icon className="size-3.5" />仍要预览源码
              </Button>
            )}
          </div>
          {sourceView && entryFile && (
            <div className="space-y-1.5">
              <div className="text-xs text-muted-foreground">入口文件 {manifest.entry}（只读，未运行）</div>
              <pre className="scrollbar-thin max-h-72 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs whitespace-pre-wrap break-words">{entryFile.content}</pre>
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  // === 持久化运行视图（组C：独立进程，不再嵌入式终端） ===
  if (usePersistent) {
    const isRunning = persistentRun.status === 'running' || persistentRun.status === 'starting' || persistentRun.status === 'stopping';
    return (
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <TerminalIcon className="size-4" />{RUNTIME_LABEL[runtime]} 运行
          </CardTitle>
          <Button variant="ghost" size="icon-sm" onClick={onRefresh} disabled={isRunning}>
            <RefreshCwIcon className="size-4" />
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* 解释器状态条：探测中 / 就绪（binary + version） */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {probe.status === 'probing' && <span>正在检测 {RUNTIME_LABEL[runtime]} 运行环境…</span>}
            {probe.status === 'ready' && (
              <>
                <span>环境：{probe.version || RUNTIME_LABEL[runtime]}</span>
                {probe.binary && <span className="truncate">路径：{probe.binary}</span>}
              </>
            )}
            {entryFile && <span>入口：{manifest.entry}</span>}
          </div>

          {/* 运行状态展示（PRD 需求 5：软件内显示「插件运行中」+ 进程信息 + 「强制关闭」按钮） */}
          {(persistentRun.status === 'idle' || persistentRun.status === 'starting') && (
            <div className="flex h-32 flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-center text-sm text-muted-foreground">
              <p>插件将以独立进程运行（{runtime === 'python' ? '使用 .venv 隔离环境' : '使用 pnpm install + start'}）。</p>
              <p className="text-xs">点击「运行」启动；运行输出在插件自身的窗口/控制台。</p>
            </div>
          )}
          {persistentRun.status === 'running' && (
            <div className="space-y-2 rounded-lg border bg-muted/40 p-3 text-sm">
              <div className="flex items-center gap-2">
                <span className="inline-flex h-2.5 w-2.5 animate-pulse rounded-full bg-emerald-500" />
                <span className="font-medium text-emerald-600 dark:text-emerald-400">插件运行中</span>
              </div>
              <div className="text-xs text-muted-foreground">
                进程 PID：<span className="font-mono text-foreground">{persistentRun.pid}</span>
              </div>
              {persistentRun.startedAt && (
                <div className="text-xs text-muted-foreground">
                  启动时间：<span className="font-mono text-foreground">{new Date(persistentRun.startedAt).toLocaleString()}</span>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                {runtime === 'python'
                  ? '若插件是 GUI 应用（PyQt5/Tkinter 等），它会弹出独立窗口。'
                  : 'Node 服务在独立进程运行，按 package.json scripts.start 启动。'}
              </p>
            </div>
          )}
          {persistentRun.status === 'stopping' && (
            <div className="flex h-32 items-center justify-center rounded-lg border bg-muted/40 text-sm text-muted-foreground">
              正在停止进程…
            </div>
          )}
          {persistentRun.status === 'error' && (
            <ErrorBubble error={persistentRun.error} onRetry={persistentRun.error.retryable ? handleStart : undefined} />
          )}

          {/* 运行/停止按钮分派（PRD AC5：可强制关闭） */}
          <div className="flex flex-wrap gap-2">
            {persistentRun.status === 'running' || persistentRun.status === 'stopping' ? (
              <LoadingButton variant="destructive" loading={persistentRun.status === 'stopping'} disabled={persistentRun.status === 'stopping'} onClick={handleStop}>
                <SquareIcon className="size-3.5" />强制关闭
              </LoadingButton>
            ) : (
              <LoadingButton loading={persistentRun.status === 'starting'} disabled={probe.status !== 'ready'} onClick={handleStart}>
                <PlayIcon className="size-3.5" />运行
              </LoadingButton>
            )}
            {entryFile && !isRunning && (
              <Button variant="ghost" size="sm" onClick={() => setSourceView((v) => !v)}>
                <Code2Icon className="size-3.5" />{sourceView ? '隐藏源码' : '查看源码'}
              </Button>
            )}
          </div>
          {sourceView && entryFile && !isRunning && (
            <div className="space-y-1.5">
              <div className="text-xs text-muted-foreground">入口文件 {manifest.entry}（只读，未运行）</div>
              <pre className="scrollbar-thin max-h-72 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs whitespace-pre-wrap break-words">{entryFile.content}</pre>
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  // === 创建期预览视图（R3 保留：一次性 sandbox 执行 + 终端回显） ===
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <TerminalIcon className="size-4" />{RUNTIME_LABEL[runtime]} 运行
        </CardTitle>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            disabled={probe.status === 'probing' || previewRun.status === 'running' || !entryFile}
            onClick={handlePreviewRun}
          >
            <PlayIcon className="size-3.5" />运行
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onRefresh} disabled={previewRun.status === 'running'}>
            <RefreshCwIcon className="size-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* 解释器状态条：探测中 / 就绪（binary + version） */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {probe.status === 'probing' && <span>正在检测 {RUNTIME_LABEL[runtime]} 运行环境…</span>}
          {probe.status === 'ready' && (
            <>
              <span>环境：{probe.version || RUNTIME_LABEL[runtime]}</span>
              {probe.binary && <span className="truncate">路径：{probe.binary}</span>}
            </>
          )}
          {entryFile && <span>入口：{manifest.entry}</span>}
        </div>

        {/* 运行结果：成功展示终端输出；失败展示 ErrorBubble */}
        {previewRun.status === 'idle' && (
          <div className="flex h-40 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
            点击「运行」预览执行结果（无参数一次性运行，默认 15 秒超时）。
          </div>
        )}
        {previewRun.status === 'running' && (
          <div className="flex h-40 items-center justify-center rounded-lg border bg-muted/40 text-sm text-muted-foreground">
            运行中…
          </div>
        )}
        {previewRun.status === 'done' && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border bg-muted/40 px-2 py-1.5 text-xs">
              <span>运行结果：<span className={previewRun.exitCode === 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'}>{previewRun.exitCode ?? '未知'}</span></span>
              {previewRun.elapsedMs > 0 && (
                <span className="text-muted-foreground">耗时 {(previewRun.elapsedMs / 1000).toFixed(2)}s</span>
              )}
            </div>
            <pre className="scrollbar-thin max-h-64 overflow-auto rounded-lg bg-[#0d1117] p-3 font-mono text-xs leading-relaxed text-[#e6edf3] whitespace-pre-wrap break-words">
              {previewRun.stdout || '（无输出）'}
              {previewRun.stderr && `\n\n--- 错误输出 ---\n${previewRun.stderr}`}
            </pre>
          </div>
        )}
        {previewRun.status === 'error' && (
          <ErrorBubble error={previewRun.error} onRetry={previewRun.error.retryable ? handlePreviewRun : undefined} />
        )}
      </CardContent>
    </Card>
  );
}
