import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { PanelRightOpenIcon, SparklesIcon } from 'lucide-react';
import { useApp } from '@/App';
import { api, tauriInvoke, tauriListen, type ApiError } from '@/lib/api';
import {
  EXAMPLES,
  PROVIDERS,
  STATUS_LABEL,
  buildLocalDraft,
  normalizeTurns,
  parseManifest,
  parseTranscript,
  providerLabel,
  readRecent,
  sessionToProbeResult,
  tailText,
  transcriptDiagnostics,
  transcriptText,
  writeRecent,
  type AssistantSessionRecord,
  type AssistantSessionState,
  type CliProbeResult,
  type ProviderId,
  type SessionErrorPayload,
  type SessionExitPayload,
  type SessionOutputPayload,
  type SessionStartedPayload,
} from '@/lib/plugin-draft';
import type { LoadedPlugin } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Bubble } from '@/components/chat/Bubble';
import { LiveProcess } from '@/components/chat/LiveProcess';
import { Composer } from '@/components/creator/Composer';
import { DetailsPanel } from '@/components/creator/DetailsPanel';

export function PluginCreatorHome() {
  const { currentDraft, setCurrentDraft, session, setRunningPlugin, setView } = useApp();
  const [input, setInput] = useState('');
  const [provider, setProvider] = useState(PROVIDERS[0].id);
  const [model, setModel] = useState(PROVIDERS[0].models[0]);
  const [streaming, setStreaming] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [pendingUser, setPendingUser] = useState<string | null>(null);
  const [liveText, setLiveText] = useState('');
  const [liveReasoning, setLiveReasoning] = useState('');
  const [liveStage, setLiveStage] = useState('');
  const [liveError, setLiveError] = useState<string | null>(null);
  const [assistantSession, setAssistantSession] = useState<AssistantSessionState | null>(null);
  const assistantSessionRef = useRef<AssistantSessionState | null>(null);
  const assistantSessionIdRef = useRef<string | null>(null);
  const pendingPromptRef = useRef<{ text: string; providerLabel: string; model: string } | null>(null);
  const [activeFile, setActiveFile] = useState('');
  const [previewKey, setPreviewKey] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [cloudPlugin, setCloudPlugin] = useState<LoadedPlugin | null>(null);
  const [recent, setRecent] = useState<LoadedPlugin[]>(() => readRecent(session.tenantId));
  const chatRef = useRef<HTMLDivElement>(null);

  const providerInfo = PROVIDERS.find((item) => item.id === provider) || PROVIDERS[0];
  const turns = normalizeTurns(currentDraft?.turns);
  const files = currentDraft?.files || [];
  const manifest = useMemo(() => parseManifest(files), [files]);
  const status = currentDraft?.status;
  const diagnostics = currentDraft?.diagnostics || [];
  const activeContent = files.find((file) => file.path === activeFile)?.content || '';
  const hasConversation = turns.length > 0 || Boolean(pendingUser) || streaming || Boolean(liveError);

  useEffect(() => { setModel(providerInfo.models[0]); }, [provider, providerInfo.models]);
  useEffect(() => { chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight }); }, [turns.length, liveText, pendingUser]);
  useEffect(() => { assistantSessionRef.current = assistantSession; }, [assistantSession]);
  useEffect(() => { if (files.length && !files.find((file) => file.path === activeFile)) setActiveFile(files[0].path); }, [files, activeFile]);
  useEffect(() => { setRecent(readRecent(session.tenantId)); }, [session.tenantId]);

  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];

    async function attach() {
      try {
        unlisteners.push(await tauriListen<SessionStartedPayload>('code-assistant://session-started', ({ payload }) => {
          if (disposed || payload.sessionId !== assistantSessionIdRef.current) return;
          const record = payload.record;
          setLiveStage('本地代码助手已启动，等待输出…');
          setAssistantSession((prev) => ({
            sessionId: payload.sessionId,
            status: 'running',
            provider: (record?.tool || prev?.provider || provider) as ProviderId,
            providerLabel: providerLabel((record?.tool || prev?.provider || provider) as ProviderId),
            model: record?.model || prev?.model || model,
            commandPreview: record?.commandPreview || prev?.commandPreview || [],
            transcriptPath: record?.transcriptPath || prev?.transcriptPath || '',
            pid: payload.pid,
            startedAt: record?.startedAt || prev?.startedAt,
            stdout: prev?.stdout || '',
            stderr: prev?.stderr || '',
            diagnostics: prev?.diagnostics || [],
          }));
        }));
        unlisteners.push(await tauriListen<SessionOutputPayload>('code-assistant://output', ({ payload }) => {
          if (disposed || payload.sessionId !== assistantSessionIdRef.current) return;
          const text = payload.text || '';
          if (!text) return;
          setAssistantSession((prev) => prev ? {
            ...prev,
            stdout: payload.stream === 'stdout' ? tailText(prev.stdout + text) : prev.stdout,
            stderr: payload.stream === 'stderr' ? tailText(prev.stderr + text) : prev.stderr,
          } : prev);
          if (payload.stream === 'stderr') {
            setLiveReasoning((prev) => tailText(prev + text, 6_000));
          } else {
            setLiveText((prev) => tailText(prev + text));
          }
          setLiveStage(payload.stream === 'stderr' ? '本地代码助手正在输出诊断…' : '本地代码助手正在生成…');
        }));
        unlisteners.push(await tauriListen<SessionErrorPayload>('code-assistant://error', ({ payload }) => {
          if (disposed || payload.sessionId !== assistantSessionIdRef.current) return;
          const message = payload.error || '本地代码助手输出异常';
          setAssistantSession((prev) => prev ? { ...prev, status: 'failed', diagnostics: [...prev.diagnostics, message] } : prev);
          setLiveError(message);
        }));
        unlisteners.push(await tauriListen<SessionExitPayload>('code-assistant://exit', ({ payload }) => {
          if (disposed || payload.sessionId !== assistantSessionIdRef.current) return;
          const nextStatus = payload.status === 'stopped' ? 'stopped' : 'exited';
          setAssistantSession((prev) => prev ? { ...prev, status: nextStatus, exitCode: payload.exitCode ?? null, endedAt: payload.endedAt } : prev);
          setLiveStage(nextStatus === 'stopped' ? '已停止，正在整理部分结果…' : '已结束，正在整理结果…');
          void finalizeSession(payload.sessionId, nextStatus, payload.exitCode ?? null, payload.endedAt);
        }));
      } catch {
        // 浏览器预览环境没有 Tauri event bridge，发送时会通过 invoke 给出明确错误。
      }
    }

    void attach();
    return () => {
      disposed = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, [provider, model]);

  async function finalizeSession(sessionId: string, status: AssistantSessionState['status'], exitCode: number | null, endedAt?: string) {
    try {
      const raw = await tauriInvoke<string>('code_assistant_read_transcript', { input: { sessionId } });
      const events = parseTranscript(raw);
      const stdout = transcriptText(events, 'stdout');
      const stderr = transcriptText(events, 'stderr');
      const diagnostics = transcriptDiagnostics(events);
      const pending = pendingPromptRef.current;
      const currentSession = assistantSessionRef.current;
      const finalSession: AssistantSessionState = {
        sessionId,
        status,
        provider: (currentSession?.provider || provider) as ProviderId,
        providerLabel: currentSession?.providerLabel || providerInfo.label,
        model: currentSession?.model || model,
        commandPreview: currentSession?.commandPreview || [],
        transcriptPath: currentSession?.transcriptPath || '',
        pid: currentSession?.pid,
        exitCode,
        startedAt: currentSession?.startedAt,
        endedAt,
        stdout: tailText(stdout || currentSession?.stdout || ''),
        stderr: tailText(stderr || currentSession?.stderr || ''),
        diagnostics,
      };
      setAssistantSession(finalSession);
      const draft = buildLocalDraft({
        prompt: pending?.text || pendingUser || '本地代码助手插件',
        providerLabel: pending?.providerLabel || finalSession.providerLabel,
        model: pending?.model || finalSession.model,
        result: sessionToProbeResult(finalSession),
      });
      setCurrentDraft(draft);
      setPendingUser(null);
      setPreviewKey((key) => key + 1);
      setDetailsOpen(true);
      if (finalSession.status === 'exited' && finalSession.exitCode === 0) {
        toast.success('本地代码助手已完成长任务');
      } else if (finalSession.status === 'stopped') {
        toast.message('已停止本地代码助手，保留部分结果');
      } else {
        toast.error('本地代码助手未成功完成，请查看右侧诊断');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLiveError(`读取 transcript 失败：${message}`);
      toast.error(message);
    } finally {
      setStreaming(false);
      setLiveStage('');
      pendingPromptRef.current = null;
      assistantSessionIdRef.current = null;
    }
  }

  function pushRecent(plugin: LoadedPlugin) {
    setRecent((prev) => {
      const next = [plugin, ...prev.filter((item) => item.id !== plugin.id)];
      writeRecent(session.tenantId, next);
      return next.slice(0, 8);
    });
  }

  async function send() {
    const text = input.trim();
    if (!text || streaming) return;
    setInput('');
    setPendingUser(text);
    setLiveText('');
    setLiveReasoning('');
    setLiveStage('正在启动本地代码助手长任务…');
    setLiveError(null);
    setStreaming(true);
    setCloudPlugin(null);
    setCurrentDraft(null);
    const selectedProvider = provider as ProviderId;
    pendingPromptRef.current = { text, providerLabel: providerInfo.label, model };
    try {
      const prompt = `请基于这个需求创建一个 LingFang 插件草稿。请给出插件目标、核心交互、文件结构和关键实现建议。需求：${text}`;
      const record = await tauriInvoke<AssistantSessionRecord>('code_assistant_start_session', {
        input: {
          tool: selectedProvider,
          model: model === 'default' ? undefined : model,
          workspaceDir: '/Users/littlesheep/Desktop/lingfang',
          prompt,
        },
      });
      assistantSessionIdRef.current = record.sessionId;
      const nextSession: AssistantSessionState = {
        sessionId: record.sessionId,
        status: 'running',
        provider: selectedProvider,
        providerLabel: providerInfo.label,
        model,
        commandPreview: record.commandPreview || [],
        transcriptPath: record.transcriptPath || '',
        pid: record.pid || undefined,
        startedAt: record.startedAt,
        stdout: '',
        stderr: '',
        diagnostics: [],
      };
      assistantSessionRef.current = nextSession;
      setAssistantSession(nextSession);
      setLiveStage('本地代码助手已启动，等待输出…');
      setDetailsOpen(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLiveError(`生成失败：${message}`);
      toast.error(message);
      setStreaming(false);
      setLiveStage('');
      pendingPromptRef.current = null;
      assistantSessionIdRef.current = null;
    }
  }

  async function stopCurrentSession() {
    const sessionId = assistantSessionIdRef.current || assistantSession?.sessionId;
    if (!sessionId || !streaming) return;
    setLiveStage('正在停止本地代码助手…');
    setAssistantSession((prev) => prev ? { ...prev, status: 'stopping' } : prev);
    try {
      await tauriInvoke('code_assistant_stop_session', { input: { sessionId } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLiveError(`停止失败：${message}`);
      toast.error(message);
    }
  }

  async function uploadCloud() {
    if (!files.length) return;
    setUploading(true);
    try {
      const result = await api<{ plugin: LoadedPlugin; deduplicated?: boolean }>('/api/plugins/upload', {
        method: 'POST',
        body: { manifest, files },
      });
      const plugin = { ...result.plugin, files, manifest, source: 'team' as const };
      setCloudPlugin(plugin);
      pushRecent(plugin);
      toast.success(result.deduplicated ? '团队云端已有相同插件' : '已上传到团队云端共享');
    } catch (error) {
      toast.error((error as ApiError).message);
    } finally {
      setUploading(false);
    }
  }

  async function submitMarketplace() {
    if (!cloudPlugin) return toast.error('请先上传到团队云端');
    setSubmitting(true);
    try {
      const result = await api<{ plugin: LoadedPlugin }>(`/api/plugins/${cloudPlugin.id}/submit-marketplace`, { method: 'POST', body: { priceCents: 0 } });
      const plugin = { ...cloudPlugin, ...result.plugin, source: 'team' as const };
      setCloudPlugin(plugin);
      pushRecent(plugin);
      toast.success('已提交公共市场审核');
    } catch (error) {
      toast.error((error as ApiError).message);
    } finally {
      setSubmitting(false);
    }
  }

  function runPlugin(plugin: LoadedPlugin) {
    setRunningPlugin(plugin);
    setView('plugins');
  }

  function newDraft() {
    setCurrentDraft(null);
    setCloudPlugin(null);
    setPendingUser(null);
    setLiveText('');
    setLiveReasoning('');
    setLiveStage('');
    setLiveError(null);
    setAssistantSession(null);
    assistantSessionRef.current = null;
    assistantSessionIdRef.current = null;
    pendingPromptRef.current = null;
  }

  return (
    <Sheet open={detailsOpen} onOpenChange={setDetailsOpen}>
      <div className="flex min-h-[calc(100vh-3rem)] items-center justify-center bg-background px-4 py-6">
        <main className="w-full max-w-4xl">
          <Card className="min-h-[calc(100vh-7rem)] border-primary/10 bg-card/95 shadow-xl shadow-primary/5">
            <CardHeader className="border-b px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
                  <SparklesIcon className="size-4 shrink-0 text-primary" />
                  <span className="truncate">今天想创建什么插件？</span>
                  {status && <Badge variant={status === 'ready' ? 'default' : status === 'invalid' ? 'destructive' : 'secondary'}>{STATUS_LABEL[status] || status}</Badge>}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button variant="ghost" size="sm" onClick={newDraft}>新对话</Button>
                  <SheetTrigger render={<Button variant="outline" size="sm" />}>
                    <PanelRightOpenIcon className="size-4" /> 详情
                  </SheetTrigger>
                </div>
              </div>
            </CardHeader>
            <CardContent className="flex min-h-[calc(100vh-12rem)] flex-col p-0">
          {!hasConversation ? (
            <div className="flex flex-1 flex-col justify-center px-4 py-8 text-center md:px-8">
              <h1 className="text-balance text-4xl font-semibold tracking-tight md:text-5xl">今天想创建什么插件？</h1>
              <div className="mx-auto mt-8 grid w-full max-w-2xl gap-2">
                {EXAMPLES.map((example) => (
                  <Button key={example} variant="outline" className="h-auto justify-start whitespace-normal rounded-xl px-4 py-3 text-left text-muted-foreground" onClick={() => setInput(example)}>
                    {example}
                  </Button>
                ))}
              </div>
            </div>
          ) : (
            <ScrollArea className="min-h-0 flex-1 px-4 py-4 md:px-6">
              <div ref={chatRef} className="flex min-h-[52vh] flex-col gap-4">
                {turns.map((turn, index) => <Bubble key={index} role={turn.role} content={turn.content} />)}
                {pendingUser && <Bubble role="user" content={pendingUser} />}
                {streaming && <LiveProcess stage={liveStage} text={liveText} reasoning={liveReasoning} />}
                {!streaming && liveError && <Bubble role="assistant" content={liveError} error />}
              </div>
            </ScrollArea>
          )}

          <Composer
            input={input}
            model={model}
            provider={provider}
            providerInfo={providerInfo}
            streaming={streaming}
            onInputChange={setInput}
            onModelChange={setModel}
            onProviderChange={setProvider}
            onSend={send}
            onStop={stopCurrentSession}
          />
            </CardContent>
          </Card>
        </main>
      </div>

      <SheetContent className="flex flex-col p-0" side="right">
        <SheetHeader className="border-b p-4">
          <SheetTitle>插件创建详情</SheetTitle>
        </SheetHeader>
        <DetailsPanel
          assistantSession={assistantSession}
          status={status}
          files={files}
          diagnostics={diagnostics}
          activeFile={activeFile}
          activeContent={activeContent}
          previewKey={previewKey}
          cloudPlugin={cloudPlugin}
          recent={recent}
          uploading={uploading}
          submitting={submitting}
          onActiveFileChange={setActiveFile}
          onRefreshPreview={() => setPreviewKey((key) => key + 1)}
          onUpload={uploadCloud}
          onSubmitMarketplace={submitMarketplace}
          onRun={() => cloudPlugin && runPlugin(cloudPlugin)}
          onRunRecent={runPlugin}
        />
      </SheetContent>
    </Sheet>
  );
}