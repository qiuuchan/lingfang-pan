// ScriptPreviewPanel.tsx — R3 终端型脚本预览组件。
//
// 职责：为 nodejs/python 运行时插件提供本地预览执行 UI。
// - 首次进入 probe 解释器：缺失时展示安装指引 + 「重试检测」/「仍要预览源码」降级。
// - 「运行」按钮触发 runPluginScript，成功展示终端 stdout/stderr + 状态条（退出码/耗时）。
// - 失败复用 R5 的 ErrorBubble + fromRunResult 友好渲染（超时/非零退出/解释器缺失）。
//
// 数据来源：files 由 PreviewPanel 传入（来自 PluginDraft.files），须含 manifest.json + entry 源码。
// runtime 由 PreviewPanel 据 parseManifest(files).runtime_type 推断后传入。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Code2Icon, PlayIcon, RefreshCwIcon, TerminalIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorBubble } from '@/components/chat/ErrorBubble';
import { fromRunResult, type CreatorError } from '@/lib/creator-error';
import {
  probeScriptRuntime,
  runPluginScript,
  RUNTIME_LABEL,
  type ProbeResult,
  type ScriptRuntime,
} from '@/lib/plugin-script';
import { parseManifest } from '@/lib/plugin-draft';
import type { DraftFile } from '@/lib/types';

type ProbeState =
  | { status: 'idle' }
  | { status: 'probing' }
  | { status: 'missing'; result: ProbeResult }
  | { status: 'ready'; binary?: string; version?: string };

type RunState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'done'; stdout: string; stderr: string; exitCode: number | null; elapsedMs: number }
  | { status: 'error'; error: CreatorError };

export function ScriptPreviewPanel({
  files,
  runtime,
  previewKey,
  onRefresh,
}: {
  files: DraftFile[];
  runtime: ScriptRuntime;
  previewKey: number;
  onRefresh: () => void;
}) {
  const [probe, setProbe] = useState<ProbeState>({ status: 'idle' });
  const [run, setRun] = useState<RunState>({ status: 'idle' });
  // 降级：用户主动选择「仍要预览源码」（不执行脚本，只读展示）。
  const [sourceView, setSourceView] = useState(false);

  const manifest = useMemo(() => parseManifest(files), [files]);
  const entryFile = useMemo(
    () => files.find((file) => file.path === manifest.entry),
    [files, manifest.entry],
  );

  // 探测解释器（design §3.5：首次进入先 probe）。
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

  useEffect(() => {
    // previewKey 变化（外部刷新）或 runtime 变化时重新探测，并清空运行结果。
    setRun({ status: 'idle' });
    setSourceView(false);
    void doProbe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime, previewKey]);

  const handleRun = useCallback(async () => {
    if (!entryFile) return;
    setRun({ status: 'running' });
    try {
      const result = await runPluginScript({
        pluginId: manifest.id,
        runtime,
        entry: manifest.entry,
        files: files.filter((file) => file.path !== 'manifest.json'),
      });
      if (result.ok && !result.failure) {
        setRun({
          status: 'done',
          stdout: result.stdout ?? '',
          stderr: result.stderr ?? '',
          exitCode: result.exitCode ?? null,
          elapsedMs: 0,
        });
      } else {
        // 失败/超时/解释器缺失：经 fromRunResult 转 CreatorError，由 ErrorBubble 友好渲染。
        // 超时场景 Rust 已 kill 并返回部分输出，fromRunResult 会把 stdout/stderr 拼进 error.raw 折叠展示。
        setRun({ status: 'error', error: fromRunResult(result) });
      }
    } catch (error) {
      // Tauri 通道异常兜底（非 runPluginScript 已归类的业务失败）。
      setRun({
        status: 'error',
        error: fromRunResult({ ok: false, failure: 'spawn_failed', stderr: error instanceof Error ? error.message : String(error) }),
      });
    }
  }, [entryFile, files, manifest.entry, manifest.id, runtime]);

  // === 缺失解释器降级视图 ===
  if (probe.status === 'missing') {
    return (
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <TerminalIcon className="size-4" />{RUNTIME_LABEL[runtime]} 预览
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
              <div className="text-xs text-muted-foreground">入口文件 {manifest.entry}（只读，未执行）</div>
              <pre className="scrollbar-thin max-h-72 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs whitespace-pre-wrap break-words">{entryFile.content}</pre>
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  // === 正常预览视图（解释器就绪或探测中）===
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <TerminalIcon className="size-4" />{RUNTIME_LABEL[runtime]} 预览
        </CardTitle>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            disabled={probe.status === 'probing' || run.status === 'running' || !entryFile}
            onClick={handleRun}
          >
            <PlayIcon className="size-3.5" />运行
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onRefresh} disabled={run.status === 'running'}>
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
        {run.status === 'idle' && (
          <div className="flex h-40 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
            点击「运行」预览执行结果（无参数一次性运行，默认 15s 超时）。
          </div>
        )}
        {run.status === 'running' && (
          <div className="flex h-40 items-center justify-center rounded-lg border bg-muted/40 text-sm text-muted-foreground">
            运行中…
          </div>
        )}
        {run.status === 'done' && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border bg-muted/40 px-2 py-1.5 text-xs">
              <span>退出码：<span className={run.exitCode === 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'}>{run.exitCode ?? '未知'}</span></span>
            </div>
            <pre className="scrollbar-thin max-h-64 overflow-auto rounded-lg bg-[#0d1117] p-3 font-mono text-xs leading-relaxed text-[#e6edf3] whitespace-pre-wrap break-words">
              {run.stdout || '（无 stdout 输出）'}
              {run.stderr && `\n\n--- stderr ---\n${run.stderr}`}
            </pre>
          </div>
        )}
        {run.status === 'error' && (
          <ErrorBubble error={run.error} onRetry={run.error.retryable ? handleRun : undefined} />
        )}
      </CardContent>
    </Card>
  );
}
