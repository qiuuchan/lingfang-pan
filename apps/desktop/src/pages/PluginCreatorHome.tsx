import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { PanelRightOpenIcon, SparklesIcon, XIcon } from 'lucide-react';
import { useApp } from '@/App';
import { api, tauriInvoke, tauriListen } from '@/lib/api';
import { PLUGIN_CREATOR_SYSTEM_PROMPT } from '@/lib/plugin-creator-protocol';
import { toCreatorError, toUploadError, type CreatorError } from '@/lib/creator-error';
import {
  EXAMPLES,
  PROVIDERS,
  STATUS_LABEL,
  buildLocalDraft,
  mergeFollowupDraft,
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
  type SessionCliIdPayload,
  type SessionErrorPayload,
  type SessionExitPayload,
  type SessionOutputPayload,
  type SessionStartedPayload,
  type TranscriptEvent,
} from '@/lib/plugin-draft';
import type { LoadedPlugin } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Bubble } from '@/components/chat/Bubble';
import { ErrorBubble } from '@/components/chat/ErrorBubble';
import { LiveProcess } from '@/components/chat/LiveProcess';
import { Composer } from '@/components/creator/Composer';
import { DetailsPanel } from '@/components/creator/DetailsPanel';

export function PluginCreatorHome() {
  const { currentDraft, setCurrentDraft, session, setRunningPlugin, setView } = useApp();
  const [input, setInput] = useState('');
  const [provider, setProvider] = useState(PROVIDERS[0].id);
  const [model, setModel] = useState(PROVIDERS[0].models[0]);
  const [providers, setProviders] = useState(PROVIDERS);
  const [streaming, setStreaming] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [pendingUser, setPendingUser] = useState<string | null>(null);
  const [liveEvents, setLiveEvents] = useState<TranscriptEvent[]>([]);
  const [liveStage, setLiveStage] = useState('');
  const [liveError, setLiveError] = useState<CreatorError | null>(null);
  const [assistantSession, setAssistantSession] = useState<AssistantSessionState | null>(null);
  const assistantSessionRef = useRef<AssistantSessionState | null>(null);
  const assistantSessionIdRef = useRef<string | null>(null);
  const pendingPromptRef = useRef<{ text: string; providerLabel: string; model: string } | null>(null);
  // 标记当前进行中的轮次是否为追问（send() 追问路径置 true，finalizeSession 据此走累积分支）。
  const isFollowupRef = useRef(false);
  // 多轮运行态（design §3.3.6 (a)）：multiturnMode 标记当前会话续接能力。
  // native=claude 已捕获 session id（Rust 已回写 SessionRecord.cli_session_id 并走 --resume）；
  // degraded=codex/opencode 或 claude 未捕获 id（历史摘要伪多轮）。
  // cli_session_id 的真值在 Rust SessionRecord，前端只需 mode 信号驱动 UI 文案。
  const [multiturnMode, setMultiturnMode] = useState<'native' | 'degraded' | null>(null);
  const [activeFile, setActiveFile] = useState('');
  const [previewKey, setPreviewKey] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [cloudPlugin, setCloudPlugin] = useState<LoadedPlugin | null>(null);
  const [recent, setRecent] = useState<LoadedPlugin[]>(() => readRecent(session.tenantId));
  const chatRef = useRef<HTMLDivElement>(null);

  const providerInfo = providers.find((item) => item.id === provider) || providers[0];
  const turns = normalizeTurns(currentDraft?.turns);
  const files = currentDraft?.files || [];
  const manifest = useMemo(() => parseManifest(files), [files]);
  const status = currentDraft?.status;
  const diagnostics = currentDraft?.diagnostics || [];
  const activeContent = files.find((file) => file.path === activeFile)?.content || '';
  const hasConversation = turns.length > 0 || Boolean(pendingUser) || streaming || Boolean(liveError);

  // 从后端拉取真实工具/模型列表，覆盖前端 fallback，避免前后端两份硬编码漂移。
  useEffect(() => {
    let cancelled = false;
    tauriInvoke<Array<{ tool: string; display_name?: string; available?: boolean; models?: string[] }>>('code_assistant_list_tools')
      .then((tools) => {
        if (cancelled) return;
        const mapped = tools
          .filter((t) => t.available)
          .map((t) => ({
            id: String(t.tool),
            label: String(t.display_name || t.tool),
            models: Array.isArray(t.models) ? t.models.map(String) : [],
          }));
        if (mapped.length) setProviders(mapped);
      })
      .catch(() => { /* fallback 到 PROVIDERS */ });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => { setModel(providerInfo.models[0]); }, [provider, providerInfo.models]);
  useEffect(() => { chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight }); }, [turns.length, liveEvents, pendingUser]);
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
        // design §3.3.3：捕获 claude session_id（仅 claude stream-json 会 emit）→ 标记 native 真 resume 多轮。
        // cli_session_id 真值由 Rust 回写 SessionRecord，前端只据此切 native mode。
        unlisteners.push(await tauriListen<SessionCliIdPayload>('code-assistant://session-cli-id', ({ payload }) => {
          if (disposed || payload.sessionId !== assistantSessionIdRef.current) return;
          if (payload.cliSessionId) {
            setMultiturnMode('native');
          }
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
            setLiveEvents((prev) => [...prev, { at: new Date().toISOString(), event: 'output', payload: { stream: 'stderr', text } }].slice(-200));
          } else {
            setLiveEvents((prev) => [...prev, { at: new Date().toISOString(), event: 'output', payload: { stream: 'stdout', text } }].slice(-200));
          }
          setLiveStage(payload.stream === 'stderr' ? '本地代码助手正在输出诊断…' : '本地代码助手正在生成…');
        }));
        unlisteners.push(await tauriListen<SessionErrorPayload>('code-assistant://error', ({ payload }) => {
          if (disposed || payload.sessionId !== assistantSessionIdRef.current) return;
          const message = payload.error || '本地代码助手输出异常';
          setAssistantSession((prev) => prev ? { ...prev, status: 'failed', diagnostics: [...prev.diagnostics, message] } : prev);
          setLiveError(toCreatorError('cli_session_error', new Error(message)));
        }));
        unlisteners.push(await tauriListen<SessionExitPayload>('code-assistant://exit', ({ payload }) => {
          if (disposed || payload.sessionId !== assistantSessionIdRef.current) return;
          const nextStatus = payload.status === 'stopped' ? 'stopped' : 'exited';
          setAssistantSession((prev) => prev ? { ...prev, status: nextStatus, exitCode: payload.exitCode ?? null, endedAt: payload.endedAt } : prev);
          // design §3.3.6 (d)：首轮 exit 后判定多轮能力——claude 已捕获 cliSessionId 为 native；
          // 其余（codex/opencode，或 claude 未捕获 id）标记 degraded（伪多轮，透明提示）。
          setMultiturnMode((prev) => prev === 'native' ? 'native' : 'degraded');
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
    const isFollowup = isFollowupRef.current;
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
      const probeResult = sessionToProbeResult(finalSession);
      const promptText = pending?.text || pendingUser || '本地代码助手插件';
      if (isFollowup && currentDraft) {
        // design §3.3.6 (c)：追问在既有 draft 上累积 turns、files 用新产出覆盖（mergeFollowupDraft），
        // 不重建草稿。pendingPromptRef 在追问路径保留的是本轮追问文本。
        const merged = mergeFollowupDraft(currentDraft, probeResult, promptText);
        setCurrentDraft(merged);
      } else {
        // 首轮：全新构建（turns=[u1,a1]）。
        const draft = buildLocalDraft({
          prompt: promptText,
          providerLabel: pending?.providerLabel || finalSession.providerLabel,
          model: pending?.model || finalSession.model,
          result: probeResult,
        });
        setCurrentDraft(draft);
      }
      setPendingUser(null);
      setPreviewKey((key) => key + 1);
      setDetailsOpen(true);
      if (finalSession.status === 'exited' && finalSession.exitCode === 0) {
        toast.success(isFollowup ? '本地代码助手已完成追问迭代' : '本地代码助手已完成长任务');
      } else if (finalSession.status === 'stopped') {
        toast.message('已停止本地代码助手，保留部分结果');
      } else {
        toast.error('本地代码助手未成功完成，请查看右侧诊断');
      }
    } catch (error) {
      const creatorError = toCreatorError('transcript_failed', error);
      setLiveError(creatorError);
      toast.error(creatorError.title);
    } finally {
      // design §3.3.6 (c)：finally 仅清流式态与 pendingPrompt，**保留** assistantSessionIdRef（追问需用）。
      // newDraft 负责 session 完全重置；追问完成后仍持有 id 供下一轮追问判断 firstRoundDone。
      setStreaming(false);
      setLiveStage('');
      pendingPromptRef.current = null;
      isFollowupRef.current = false;
    }
  }

  function pushRecent(plugin: LoadedPlugin) {
    setRecent((prev) => {
      const next = [plugin, ...prev.filter((item) => item.id !== plugin.id)];
      writeRecent(session.tenantId, next);
      return next.slice(0, 8);
    });
  }

  // 最近一次发起的 prompt 快照，错误后不清空，供 ErrorBubble 的「重试」复用。
  const lastPromptRef = useRef<string | null>(null);

  // design §3.3.6 (d)：多轮错误分类处理——会话已退出 / CLI 不可用 / cli_session_id 缺失，
  // 全部走 setLiveError + ErrorBubble（复用错误气泡），不裸 toast、不静默（呼应 R1/AC6）。
  function handleMultiturnError(error: unknown) {
    setLiveError(toCreatorError('session_op_failed', error));
    setStreaming(false);
    setLiveStage('');
    setPendingUser(null);
    pendingPromptRef.current = null;
    isFollowupRef.current = false;
  }

  async function startNewSession(text: string, selectedProvider: ProviderId) {
    const systemPrompt = PLUGIN_CREATOR_SYSTEM_PROMPT;
    const record = await tauriInvoke<AssistantSessionRecord>('code_assistant_start_session', {
      input: {
        tool: selectedProvider,
        model: model === 'default' ? undefined : model,
        prompt: text,
        systemPrompt,
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
  }

  // 发起一轮对话。overrideText 用于「重试」场景复用上一次 prompt
  // （send 出错时 input 已清空，重试不能用空 input）。
  async function send(overrideText?: string) {
    const text = (overrideText ?? input).trim();
    if (!text || streaming) return;
    setInput('');
    setPendingUser(text);
    setLiveEvents([]);
    setLiveError(null);
    setStreaming(true);
    setCloudPlugin(null);
    // design §3.3.6 (b)：关键——移除原 setCurrentDraft(null)，草稿跨轮累积。
    const selectedProvider = provider as ProviderId;
    pendingPromptRef.current = { text, providerLabel: providerInfo.label, model };
    lastPromptRef.current = text;

    // 首问/追问分流（design §3.3.6 (b)）：有活动 session 且首轮已 exited → 走 send_input 追问；否则首问 start_session。
    const activeId = assistantSessionIdRef.current;
    const activeExited = Boolean(activeId && assistantSession?.status && assistantSession.status !== 'running');
    if (activeId && activeExited) {
      // 追问路径：调用 Rust send_input（已解锁真续接）。
      isFollowupRef.current = true;
      setLiveStage(
        multiturnMode === 'degraded'
          ? '本地代码助手基于历史继续生成（降级多轮，上下文非真复用）…'
          : '本地代码助手续接上下文生成…',
      );
      try {
        await tauriInvoke('code_assistant_send_input', {
          input: { sessionId: activeId, input: text },
        });
        // send_input 成功后新一轮 output/exit 事件由既有 listener 处理，finalizeSession 走追问累积分支。
      } catch (error) {
        handleMultiturnError(error);
      }
      return;
    }

    // 首轮路径：保留原 start_session 逻辑（抽到 startNewSession）。
    isFollowupRef.current = false;
    setLiveStage('正在启动本地代码助手长任务…');
    try {
      await startNewSession(text, selectedProvider);
    } catch (error) {
      const creatorError = toCreatorError('cli_start_failed', error);
      setLiveError(creatorError);
      toast.error(creatorError.title);
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
      const creatorError = toCreatorError('session_op_failed', error);
      setLiveError(creatorError);
      toast.error(creatorError.title);
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
      const creatorError = toUploadError(error, 'upload');
      // toast 用友好标题作瞬时反馈；同时 push 进 liveError 对话气泡可回看（AC6 双通道）。
      setLiveError(creatorError);
      toast.error(creatorError.title);
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
      const creatorError = toUploadError(error, 'submit');
      setLiveError(creatorError);
      toast.error(creatorError.title);
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
    setLiveEvents([]);
    setLiveStage('');
    setLiveError(null);
    setAssistantSession(null);
    assistantSessionRef.current = null;
    assistantSessionIdRef.current = null;
    pendingPromptRef.current = null;
    isFollowupRef.current = false;
    // 重置多轮运行态：新对话回到首轮语义（multiturnMode 待定）。
    setMultiturnMode(null);
    lastPromptRef.current = null;
  }

  return (
    <div className="flex h-full">
      <div className="flex h-full min-w-0 flex-1 flex-col">
        {/* pl-16 为 Sidebar 折叠态悬浮触发区避让，非视觉对称是有意为之。 */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-b pl-16 pr-4 py-3">
          <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
            <SparklesIcon className="size-4 shrink-0 text-primary" />
            <span className="truncate">插件创建</span>
            {status && <Badge variant={status === 'ready' ? 'default' : status === 'invalid' ? 'destructive' : 'secondary'}>{STATUS_LABEL[status] || status}</Badge>}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="ghost" size="sm" onClick={newDraft}>新对话</Button>
            <Button variant="outline" size="sm" onClick={() => setDetailsOpen(true)}>
              <PanelRightOpenIcon className="size-4" /> 详情
            </Button>
          </div>
        </div>
        <div ref={chatRef} className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto h-full max-w-3xl px-4 py-6">
          {!hasConversation ? (
            <div className="flex h-full flex-col justify-center text-center">
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
            <div className="flex flex-col gap-4">
              {turns.map((turn, index) => <Bubble key={index} role={turn.role} content={turn.content} />)}
              {pendingUser && <Bubble role="user" content={pendingUser} />}
              {streaming && isFollowupRef.current && multiturnMode === 'degraded' && (
                // design §3.3.6 (d)：降级伪多轮透明提示（codex/opencode 或 claude 缺 id）。
                <p className="px-1 text-xs text-muted-foreground">此 CLI 不支持原生多轮，已基于历史继续生成（上下文非真复用）。</p>
              )}
              {streaming && <LiveProcess stage={liveStage} events={liveEvents} />}
              {!streaming && liveError && <ErrorBubble error={liveError} onRetry={lastPromptRef.current ? () => send(lastPromptRef.current!) : undefined} />}
            </div>
          )}
          </div>
        </div>

        <div className="shrink-0 border-t bg-background px-4 py-3">
          <div className="mx-auto max-w-3xl">
            <Composer
              input={input}
              model={model}
              provider={provider}
              providerInfo={providerInfo}
              providers={providers}
              streaming={streaming}
              onInputChange={setInput}
              onModelChange={setModel}
              onProviderChange={setProvider}
              onSend={send}
              onStop={stopCurrentSession}
            />
          </div>
        </div>
      </div>

      <aside className={cn(
        'flex h-full shrink-0 flex-col border-l bg-card transition-all duration-200 overflow-hidden',
        detailsOpen ? 'w-full md:w-[420px] z-20' : 'w-0',
      )}>
        <div className="flex h-full w-full md:w-[420px] flex-col">
          <div className="flex shrink-0 items-center justify-between border-b px-4 py-3">
            <span className="text-sm font-medium">插件创建详情</span>
            <Button variant="ghost" size="icon" className="size-7" onClick={() => setDetailsOpen(false)}>
              <XIcon className="size-4" />
            </Button>
          </div>
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
        </div>
      </aside>
    </div>
  );
}