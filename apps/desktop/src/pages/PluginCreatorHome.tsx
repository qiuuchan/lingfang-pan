import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { PanelRightOpenIcon, SparklesIcon, XIcon, EyeIcon, WandSparklesIcon, HistoryIcon } from 'lucide-react';
import { useApp } from '@/App';
import { api, tauriInvoke, tauriListen } from '@/lib/api';
import {
  deleteConversation,
  listConversations,
  readActiveId,
  readDraft,
  renameConversation,
  saveDraft,
  writeActiveId,
} from '@/lib/conversations';
import { toCreatorError, toUploadError, type CreatorError } from '@/lib/creator-error';
import {
  EXAMPLES,
  PROVIDERS,
  STATUS_LABEL,
  buildLocalDraft,
  hasStructuredBlocks,
  makeConversationDraft,
  mergeConversationTurn,
  mergeFollowupDraft,
  normalizeTurns,
  parseManifest,
  parseTranscript,
  providerLabel,
  readRecent,
  sessionToProbeResult,
  tailText,
  transcriptDiagnostics,
  transcriptTextSinceLastInput,
  writeRecent,
  type AssistantSessionRecord,
  type AssistantSessionState,
  type ConversationMeta,
  type ProviderId,
  type SessionCliIdPayload,
  type SessionErrorPayload,
  type SessionExitPayload,
  type SessionOutputPayload,
  type SessionStartedPayload,
  summarizeTitleLocally,
  type TranscriptEvent,
} from '@/lib/plugin-draft';
import type { LoadedPlugin } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { Bubble } from '@/components/chat/Bubble';
import { ErrorBubble } from '@/components/chat/ErrorBubble';
import { LiveProcess } from '@/components/chat/LiveProcess';
import { Composer } from '@/components/creator/Composer';
import { ConversationRail } from '@/components/creator/ConversationRail';
import { DetailsPanel } from '@/components/creator/DetailsPanel';
import { PreviewDrawer } from '@/components/creator/PreviewDrawer';

export function PluginCreatorHome() {
  const { currentDraft, setCurrentDraft, session, setRunningPlugin, setView } = useApp();
  const [input, setInput] = useState('');
  const [provider, setProvider] = useState(PROVIDERS[0].id);
  const [model, setModel] = useState(PROVIDERS[0].models[0]);
  const [providers, setProviders] = useState(PROVIDERS);
  const [streaming, setStreaming] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  // 问题2：历史悬浮窗改居中 Dialog（自动分页=内部 ScrollArea 限高），不再用右对齐 Popover。
  const [historyOpen, setHistoryOpen] = useState(false);
  const [pendingUser, setPendingUser] = useState<string | null>(null);
  const [liveEvents, setLiveEvents] = useState<TranscriptEvent[]>([]);
  const [liveStage, setLiveStage] = useState('');
  const [liveError, setLiveError] = useState<CreatorError | null>(null);
  const [assistantSession, setAssistantSession] = useState<AssistantSessionState | null>(null);
  const assistantSessionRef = useRef<AssistantSessionState | null>(null);
  // design §3.1.3 / §3.2：listener 守卫改按 activeId 路由。
  // assistantSessionIdRef 保留为活动会话 id 的同步可读源（事件回调读取），由 activeId 驱动。
  const assistantSessionIdRef = useRef<string | null>(null);
  const pendingPromptRef = useRef<{ text: string; providerLabel: string; model: string } | null>(null);
  // 标记当前进行中的轮次是否为追问（send() 追问路径置 true，finalizeSession 据此走累积分支）。
  const isFollowupRef = useRef(false);
  // design §3.2.4：多会话 store。metas 由 list_sessions 一次拉取；activeId 决定当前渲染的会话与草稿。
  const [metas, setMetas] = useState<ConversationMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeIdRef = useRef<string | null>(null);
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
  // 最近插件只写 localStorage（供「插件」页读取），创建页不再展示，故无 state。
  const chatRef = useRef<HTMLDivElement>(null);
  // 修复：finalizeSession 在 exit listener（useEffect 闭包）里调用，捕获的 currentDraft 是注册时的旧值，
  // 导致追问时读到 null → 走 makeConversationDraft 只产本轮 turn，老对话丢失。用 ref 跟踪最新值。
  const currentDraftRef = useRef(currentDraft);
  useEffect(() => { currentDraftRef.current = currentDraft; }, [currentDraft]);

  const providerInfo = providers.find((item) => item.id === provider) || providers[0];
  const turns = normalizeTurns(currentDraft?.turns);
  const files = currentDraft?.files || [];
  const manifest = useMemo(() => parseManifest(files), [files]);
  const status = currentDraft?.status;
  const diagnostics = currentDraft?.diagnostics || [];
  // 当前活动会话标题（AI 总结首轮后生成，显示在顶部「插件创建」旁）。
  const activeConversationTitle = activeId ? (metas.find((m) => m.sessionId === activeId)?.title || '') : '';
  const activeContent = files.find((file) => file.path === activeFile)?.content || '';
  const hasConversation = turns.length > 0 || Boolean(pendingUser) || streaming || Boolean(liveError);
  // design §3.3.2：预览按钮启用条件——当前会话有结构化草稿（files 非空）。
  // 纯对话态（files 空，status='generating'）不点亮，避免点开空预览。
  const hasDraft = Boolean(currentDraft?.files.length);

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
  // 问题1：智能滚动——仅当用户已贴近底部（或尚未手动向上滚）时才自动滚到底，
  // 用户向上翻看历史时新消息到来不打断（AionUi 标准模式）。
  const stickToBottomRef = useRef(true);
  const handleChatScroll = () => {
    const el = chatRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distance < 80; // 距底 80px 内视为"贴底"
  };
  useEffect(() => {
    if (stickToBottomRef.current) {
      chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight });
    }
  }, [turns.length, liveEvents, pendingUser]);
  useEffect(() => { assistantSessionRef.current = assistantSession; }, [assistantSession]);
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);
  useEffect(() => { if (files.length && !files.find((file) => file.path === activeFile)) setActiveFile(files[0].path); }, [files, activeFile]);

  // design §3.2：挂载时拉取会话列表 + 从 localStorage 恢复 activeId。
  // 恢复后若该 activeId 有效，加载其 draft 并重建 assistantSession 供历史渲染。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const records = await listConversations();
        if (cancelled) return;
        setMetas(records);
        const restored = readActiveId(session.tenantId);
        if (restored && records.some((m) => m.sessionId === restored)) {
          await selectConversation(restored, records);
        } else if (records.length) {
          // 旧 activeId 失效：默认选最近一项，但不强制写 localStorage（用户可见即恢复）。
          setActiveIdRef(records[0].sessionId);
        }
      } catch {
        // 浏览器预览环境无 Tauri bridge，静默忽略。
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.tenantId]);

  // 设置 activeId + 同步 ref + 写 localStorage（三处保持一致的唯一入口）。
  function setActiveIdRef(id: string | null) {
    activeIdRef.current = id;
    setActiveId(id);
    assistantSessionIdRef.current = id;
    writeActiveId(session.tenantId, id);
  }

  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];

    async function attach() {
      try {
        unlisteners.push(await tauriListen<SessionStartedPayload>('code-assistant://session-started', ({ payload }) => {
          // design §3.1.3：守卫按 activeId 路由（首问已 startNewSession 设过 activeIdRef）。
          if (disposed || payload.sessionId !== activeIdRef.current) return;
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
          // design §3.2.6：首问启动后把新 record 推入 metas（去重），draftUpdatedAt 暂用 startedAt。
          setMetas((prev) => {
            if (prev.some((m) => m.sessionId === record?.sessionId)) return prev;
            if (!record) return prev;
            return [{
              sessionId: record.sessionId,
              tool: record.tool,
              model: record.model,
              title: record.title,
              status: record.status || 'running',
              startedAt: record.startedAt,
              transcriptPath: record.transcriptPath,
              commandPreview: record.commandPreview,
              draftUpdatedAt: record.draftUpdatedAt,
              archived: record.archived,
            }, ...prev];
          });
        }));
        // design §3.3.3：捕获 claude session_id（仅 claude stream-json 会 emit）→ 标记 native 真 resume 多轮。
        // cli_session_id 真值由 Rust 回写 SessionRecord，前端只据此切 native mode。
        unlisteners.push(await tauriListen<SessionCliIdPayload>('code-assistant://session-cli-id', ({ payload }) => {
          if (disposed || payload.sessionId !== activeIdRef.current) return;
          if (payload.cliSessionId) {
            setMultiturnMode('native');
          }
        }));
        unlisteners.push(await tauriListen<SessionOutputPayload>('code-assistant://output', ({ payload }) => {
          if (disposed || payload.sessionId !== activeIdRef.current) return;
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
          if (disposed || payload.sessionId !== activeIdRef.current) return;
          const message = payload.error || '本地代码助手输出异常';
          setAssistantSession((prev) => prev ? { ...prev, status: 'failed', diagnostics: [...prev.diagnostics, message] } : prev);
          setLiveError(toCreatorError('cli_session_error', new Error(message)));
        }));
        unlisteners.push(await tauriListen<SessionExitPayload>('code-assistant://exit', ({ payload }) => {
          if (disposed || payload.sessionId !== activeIdRef.current) return;
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
      // 多轮 bug 修复（问题5）：transcript 是 append 的，每轮 output 都追加到同一文件。
      // 用 transcriptTextSinceLastInput 只取「最后一个 input 事件之后」的 output，
      // 保证 finalizeSession 拿到的 stdout/stderr 仅含本轮产出，不再把历史轮次拼进本轮 assistant turn。
      // diagnostics 保持全量（transcriptDiagnostics），排障更全面。
      const stdout = transcriptTextSinceLastInput(events, 'stdout');
      const stderr = transcriptTextSinceLastInput(events, 'stderr');
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
      const prevDraft = currentDraftRef.current; // 读 ref 最新值（闭包陷阱修复）

      // design §3.1.2 / AC1：对话优先 gate——产出含 manifest/file 块才解析为草稿（自动检测）。
      // 纯对话态（无结构化块）只追加 turn，status='generating'，不弹详情、不判 invalid。
      const structured = hasStructuredBlocks(finalSession.stdout);
      let nextDraft: NonNullable<typeof currentDraft>;
      if (structured) {
        // 有结构化块：走原 buildLocalDraft（首轮）/ mergeFollowupDraft（追问），产出/更新草稿并弹详情。
        if (isFollowup && prevDraft) {
          // design §3.3.6 (c)：追问在既有 draft 上累积 turns、files 用新产出覆盖（mergeFollowupDraft）。
          nextDraft = mergeFollowupDraft(prevDraft, probeResult, promptText);
        } else {
          nextDraft = buildLocalDraft({
            prompt: promptText,
            providerLabel: pending?.providerLabel || finalSession.providerLabel,
            model: pending?.model || finalSession.model,
            result: probeResult,
          });
        }
        setCurrentDraft(nextDraft);
        setDetailsOpen(true);
      } else {
        // 纯对话态（AC1）：仅累积 turn，files 保持空，status='generating'，绝不判 invalid。
        const assistantText = finalSession.stdout || finalSession.stderr || '本地 CLI 没有返回可展示内容。';
        if (isFollowup && prevDraft) {
          nextDraft = mergeConversationTurn(prevDraft, promptText, assistantText);
        } else {
          nextDraft = makeConversationDraft(promptText, assistantText);
        }
        setCurrentDraft(nextDraft);
        // 不调 setDetailsOpen(true)——纯对话默认不弹右侧面板（AC1 关键）。
      }

      setPendingUser(null);
      setPreviewKey((key) => key + 1);

      // design §3.2.7：草稿落盘到 drafts/{sessionId}.json + 更新 metas 对应项 draftUpdatedAt。
      try {
        if (nextDraft) await saveDraft(sessionId, JSON.stringify(nextDraft));
        setMetas((prev) => prev.map((m) => m.sessionId === sessionId ? { ...m, draftUpdatedAt: new Date().toISOString(), status: finalSession.status } : m));
      } catch {
        // 落盘失败不阻断对话流程（本地磁盘异常仅静默，历史仍在 transcripts/{id}.jsonl）。
      }

      // 标题生成（首轮 + 当前会话尚无 title）：本地启发式秒级总结，无 CLI 冷启动延迟。
      // 优先从用户首句去祈使前缀拿核心需求，回退 assistant 首行；rename 持久化 + 更新 metas 与顶部。
      const currentMeta = metas.find((m) => m.sessionId === sessionId);
      if (!isFollowup && !currentMeta?.title && promptText) {
        const title = summarizeTitleLocally(promptText, finalSession.stdout || '');
        if (title) {
          setMetas((prev) => prev.map((m) => m.sessionId === sessionId ? { ...m, title } : m));
          void renameConversation(sessionId, title).catch(() => {
            /* rename 失败静默，标题已停留在内存 metas */
          });
        }
      }

      // toast 文案分场景：结构化走「完成」语义；纯对话态走「已完成对话」，避免 invalid 误报。
      if (structured && finalSession.status === 'exited' && finalSession.exitCode === 0) {
        toast.success(isFollowup ? '本地代码助手已完成追问迭代' : '本地代码助手已完成长任务');
      } else if (finalSession.status === 'stopped') {
        toast.message('已停止本地代码助手，保留部分结果');
      } else if (!structured) {
        toast.success('对话已完成');
      } else {
        toast.error('本地代码助手未成功完成，请查看右侧诊断');
      }
    } catch (error) {
      const creatorError = toCreatorError('transcript_failed', error);
      setLiveError(creatorError);
      toast.error(creatorError.title);
    } finally {
      // design §3.3.6 (c)：finally 仅清流式态与 pendingPrompt，**保留** activeIdRef（追问需用）。
      setStreaming(false);
      setLiveStage('');
      pendingPromptRef.current = null;
      isFollowupRef.current = false;
    }
  }

  function pushRecent(plugin: LoadedPlugin) {
    // 仅落 localStorage（供「插件」页读取），创建页不展示最近列表。
    const prev = readRecent(session.tenantId);
    const next = [plugin, ...prev.filter((item) => item.id !== plugin.id)];
    writeRecent(session.tenantId, next.slice(0, 8));
  }

  // 最近一次发起的 prompt 快照，错误后不清空，供 ErrorBubble 的「重试」复用。
  const lastPromptRef = useRef<string | null>(null);

  // design §3.3.6 (d)：多轮错误分类处理——会话已退出 / CLI 不可用 / cli_session_id 缺失，
  // 全部走 setLiveError + ErrorBubble（复用错误气泡），不裸 toast、不静默。
  function handleMultiturnError(error: unknown) {
    setLiveError(toCreatorError('session_op_failed', error));
    setStreaming(false);
    setLiveStage('');
    setPendingUser(null);
    pendingPromptRef.current = null;
    isFollowupRef.current = false;
  }

  async function startNewSession(text: string, selectedProvider: ProviderId) {
    // design §3.1.1：不再注入 PLUGIN_CREATOR_SYSTEM_PROMPT（对话优先，AC1）。
    // 不传 systemPrompt → Rust start_session 走裸 prompt 分支（code_assistant.rs 的 match _ => prompt）。
    const record = await tauriInvoke<AssistantSessionRecord>('code_assistant_start_session', {
      input: {
        tool: selectedProvider,
        model: model === 'default' ? undefined : model,
        prompt: text,
      },
    });
    // 新会话立即成为 activeId（listener 守卫据此路由新会话事件）。
    setActiveIdRef(record.sessionId);
    // 关键：新会话立即加入 metas（历史列表），否则对话完成后切换会话找不到这条历史。
    const newMeta: ConversationMeta = {
      sessionId: record.sessionId,
      tool: (record.tool || selectedProvider) as ProviderId,
      model: record.model || model,
      title: null, // 标题待 finalizeSession 本地启发式总结填充
      status: 'running',
      startedAt: record.startedAt,
      transcriptPath: record.transcriptPath || undefined,
      commandPreview: record.commandPreview,
      draftUpdatedAt: null,
      archived: false,
    };
    setMetas((prev) => prev.some((m) => m.sessionId === record.sessionId) ? prev : [newMeta, ...prev]);
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
    // 纯对话态默认不弹详情面板；若旧会话已打开详情也无关新对话，保持当前开合态。
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
    const activeSessionId = activeIdRef.current;
    const activeExited = Boolean(activeSessionId && assistantSession?.status && assistantSession.status !== 'running');
    if (activeSessionId && activeExited) {
      // 追问路径：调用 Rust send_input（已解锁真续接）。
      isFollowupRef.current = true;
      setLiveStage(
        multiturnMode === 'degraded'
          ? '本地代码助手基于历史继续生成（降级多轮，上下文非真复用）…'
          : '本地代码助手续接上下文生成…',
      );
      try {
        // 追问传入当前选的 model（会话内切模型，下一轮生效）；Rust 优先用此值覆盖 session 固化值。
        await tauriInvoke('code_assistant_send_input', {
          input: { sessionId: activeSessionId, input: text, model: model === 'default' ? undefined : model },
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
      setActiveIdRef(null);
    }
  }

  async function stopCurrentSession() {
    const sessionId = activeIdRef.current || assistantSession?.sessionId;
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

  // design §3.2.6：切换会话——先落盘当前未保存草稿，再读目标 draft + 重建 assistantSession。
  // records 参数用于避免重复 list（挂载恢复时已有最新列表）。
  async function selectConversation(id: string, records?: ConversationMeta[]) {
    const list = records ?? metas;
    if (activeIdRef.current && activeIdRef.current !== id && currentDraft) {
      // 切换前落盘当前会话草稿（design §3.2.7 / §4.2）。
      try {
        await saveDraft(activeIdRef.current, JSON.stringify(currentDraft));
      } catch { /* 落盘失败不阻断切换 */ }
    }
    setActiveIdRef(id);
    setLiveEvents([]);
    setLiveError(null);
    setStreaming(false);
    try {
      const draftRaw = await readDraft(id);
      setCurrentDraft(draftRaw ? JSON.parse(draftRaw) : null);
    } catch {
      setCurrentDraft(null);
    }
    // 从 metas 重建 assistantSession（无 cli_session_id 真值时切回 degraded；首轮或 native 由后续事件维持）。
    const meta = list.find((m) => m.sessionId === id);
    if (meta) {
      const rebuilt: AssistantSessionState = {
        sessionId: meta.sessionId,
        status: 'exited',
        provider: meta.tool,
        providerLabel: providerLabel(meta.tool),
        model: meta.model || model,
        commandPreview: meta.commandPreview || [],
        transcriptPath: meta.transcriptPath || '',
        startedAt: meta.startedAt,
        stdout: '',
        stderr: '',
        diagnostics: [],
      };
      assistantSessionRef.current = rebuilt;
      setAssistantSession(rebuilt);
    }
    setMultiturnMode(null);
    setCloudPlugin(null);
  }

  async function handleDeleteConversation(id: string) {
    try {
      await deleteConversation(id);
    } catch {
      toast.error('删除会话失败');
      return;
    }
    const remaining = metas.filter((m) => m.sessionId !== id);
    setMetas(remaining);
    // 删的是 activeId：切到首项或清空态。
    if (activeIdRef.current === id) {
      if (remaining.length) {
        void selectConversation(remaining[0].sessionId, remaining);
      } else {
        setActiveIdRef(null);
        setCurrentDraft(null);
        setAssistantSession(null);
        assistantSessionRef.current = null;
      }
    }
    toast.success('已删除会话');
  }

  async function handleRenameConversation(id: string, title: string) {
    try {
      await renameConversation(id, title);
    } catch {
      toast.error('重命名会话失败');
      return;
    }
    setMetas((prev) => prev.map((m) => m.sessionId === id ? { ...m, title, draftUpdatedAt: new Date().toISOString() } : m));
  }

  // design §3.4.2：手动「转为插件草稿」——强制解析当前活动会话最近一轮 assistant 产出为草稿。
  // 即使 hasStructuredBlocks=false 也调 buildLocalDraft（产出 partial/invalid 草稿供兜底预览，AC6）。
  async function forceConvertToDraft() {
    const sessionId = activeIdRef.current;
    if (!sessionId) return;
    try {
      const raw = await tauriInvoke<string>('code_assistant_read_transcript', { input: { sessionId } });
      const events = parseTranscript(raw);
      // 手动转草稿取最近一轮 assistant 产出（design §3.4.2），与 finalizeSession 同源用本轮切片，
      // 避免把历史轮次输出一并塞进草稿（问题5 修复一致性）。
      const stdout = transcriptTextSinceLastInput(events, 'stdout');
      const stderr = transcriptTextSinceLastInput(events, 'stderr');
      const base = assistantSessionRef.current || assistantSession;
      const promptText = pendingPromptRef.current?.text || lastPromptRef.current || turns.find((t) => t.role === 'user')?.content || '本地代码助手插件';
      // 重建完整 AssistantSessionState（强制定义解析所需的全部字段，避免 null 展开）。
      const rebuilt: AssistantSessionState = {
        sessionId,
        status: base?.status || 'exited',
        provider: base?.provider || (provider as ProviderId),
        providerLabel: base?.providerLabel || providerInfo.label,
        model: base?.model || model,
        commandPreview: base?.commandPreview || [],
        transcriptPath: base?.transcriptPath || '',
        startedAt: base?.startedAt,
        stdout: tailText(stdout || base?.stdout || ''),
        stderr: tailText(stderr || base?.stderr || ''),
        diagnostics: base?.diagnostics || [],
      };
      const probeResult = sessionToProbeResult(rebuilt);
      const draft = (currentDraft && currentDraft.turns.length > 0)
        ? mergeFollowupDraft(currentDraft, probeResult, promptText)
        : buildLocalDraft({
            prompt: promptText,
            providerLabel: rebuilt.providerLabel,
            model: rebuilt.model,
            result: probeResult,
          });
      setCurrentDraft(draft);
      setPreviewKey((key) => key + 1);
      try {
        await saveDraft(sessionId, JSON.stringify(draft));
        setMetas((prev) => prev.map((m) => m.sessionId === sessionId ? { ...m, draftUpdatedAt: new Date().toISOString() } : m));
      } catch { /* 落盘失败不阻断 */ }
      setDetailsOpen(true);
      toast.success('已转为插件草稿');
    } catch (error) {
      const creatorError = toCreatorError('transcript_failed', error);
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

  // design §3.2.6：新建对话——清空当前运行态与草稿视图，首条消息落库后自动成为新会话。
  function newDraft() {
    setCurrentDraft(null);
    setCloudPlugin(null);
    setPendingUser(null);
    setLiveEvents([]);
    setLiveStage('');
    setLiveError(null);
    setAssistantSession(null);
    assistantSessionRef.current = null;
    setActiveIdRef(null);
    pendingPromptRef.current = null;
    isFollowupRef.current = false;
    // 重置多轮运行态：新对话回到首轮语义（multiturnMode 待定）。
    setMultiturnMode(null);
    lastPromptRef.current = null;
  }

  // 问题4：转草稿按钮显示条件——仅当「当前会话无 draft 且是最后一条 assistant turn」时显示。
  // 历史 assistant 轮次不显示（避免每条气泡都有按钮），已有 draft（hasDraft=true）不显示，
  // 流式进行中不显示（本轮尚未产出，末条 assistant 实为上轮，显示会误导）。
  const lastAssistantIndex = (() => {
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].role === 'assistant') return i;
    }
    return -1;
  })();
  const showConvertAction = Boolean(activeId) && !hasDraft && !streaming && lastAssistantIndex !== -1;

  return (
    <div className="flex h-full">
      {/* 问题2：历史记录改为顶部「历史」按钮触发的悬浮窗（Popover），不再用左侧固定栏。 */}
      {/* 布局从三栏（rail|对话|详情）收敛为两栏（对话|详情），腾出宽度给对话区。 */}
      <div className="flex h-full min-w-0 flex-1 flex-col">
        {/* pl-16 为 Sidebar 折叠态悬浮触发区避让，非视觉对称是有意为之。 */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-b pl-16 pr-4 py-3">
          <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
            <SparklesIcon className="size-4 shrink-0 text-primary" />
            <span className="shrink-0">插件创建</span>
            {/* AI 总结的当前会话标题（首轮后自动生成），显示在「插件创建」旁。 */}
            {activeConversationTitle && (
              <>
                <span className="text-muted-foreground/50">/</span>
                <span className="truncate text-muted-foreground">{activeConversationTitle}</span>
              </>
            )}
            {status && <Badge variant={status === 'ready' ? 'default' : status === 'invalid' ? 'destructive' : 'secondary'}>{STATUS_LABEL[status] || status}</Badge>}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="ghost" size="sm" onClick={newDraft}>新对话</Button>
            {/* 问题2：历史记录改居中 Dialog + 自动分页（内部 ScrollArea 限高），不再右对齐 Popover。 */}
            <Button variant="ghost" size="sm" className="gap-1" title="历史对话" onClick={() => setHistoryOpen(true)}>
              <HistoryIcon className="size-4" /> 历史
            </Button>
            {/* 问题4：转草稿按钮移顶部——仅当前会话无 draft 且有 assistant turn 时显示（不每条气泡挂）。 */}
            {showConvertAction && (
              <Button variant="outline" size="sm" onClick={() => { void forceConvertToDraft(); }}>
                <WandSparklesIcon className="size-3.5" /> 转为草稿
              </Button>
            )}
            {/* design §3.3.2：预览按钮——有草稿（files 非空）才可点，否则 disabled + tooltip。 */}
            <Button
              variant="outline"
              size="sm"
              disabled={!hasDraft}
              onClick={() => setPreviewOpen(true)}
              title={hasDraft ? '打开预览大窗' : '尚未生成插件草稿'}
            >
              <EyeIcon className="size-4" /> 预览
            </Button>
            <Button variant="outline" size="sm" onClick={() => setDetailsOpen(true)}>
              <PanelRightOpenIcon className="size-4" /> 详情
            </Button>
          </div>
        </div>
        {/* 问题1：对话区滚动条可见（scrollbar-thin），内容自然撑高超容器产生滚动；onScroll 驱动智能贴底。 */}
        <div ref={chatRef} onScroll={handleChatScroll} className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
          {/* 问题3：去 h-full（否则 pb 被视口吃掉），底部 pb-20 让长回复气泡远离 Composer 分隔线。 */}
          <div className="mx-auto max-w-3xl px-4 py-6 pb-20">
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
              {turns.map((turn, index) => (
                <Bubble
                  key={index}
                  role={turn.role}
                  content={turn.content}
                />
              ))}
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
          {/* design §3.3.1：DetailsPanel 已删 preview tab，预览/源码相关 props 全部移除（迁到 PreviewDrawer）。 */}
          <DetailsPanel
            assistantSession={assistantSession}
            status={status}
            files={files}
            diagnostics={diagnostics}
            cloudPlugin={cloudPlugin}
            uploading={uploading}
            submitting={submitting}
            onUpload={uploadCloud}
            onSubmitMarketplace={submitMarketplace}
            onRun={() => cloudPlugin && runPlugin(cloudPlugin)}
          />
        </div>
      </aside>

      {/* design §3.3.3：预览大窗（全屏 Sheet），复用 PreviewPanel + SourcePanel。 */}
      <PreviewDrawer
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        files={files}
        activeFile={activeFile}
        activeContent={activeContent}
        previewKey={previewKey}
        onActiveFileChange={setActiveFile}
        onRefreshPreview={() => setPreviewKey((key) => key + 1)}
      />
      {/* 问题2：历史对话居中 Dialog，内部 ConversationRail 自带 ScrollArea 限高分页。 */}
      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent className="gap-0 p-0 sm:max-w-xl">
          <DialogHeader className="border-b px-4 py-3">
            <DialogTitle className="text-base">历史对话</DialogTitle>
          </DialogHeader>
          <ConversationRail
            metas={metas}
            activeId={activeId}
            onSelect={(id) => { void selectConversation(id); setHistoryOpen(false); }}
            onNew={() => { newDraft(); setHistoryOpen(false); }}
            onRename={handleRenameConversation}
            onDelete={handleDeleteConversation}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
