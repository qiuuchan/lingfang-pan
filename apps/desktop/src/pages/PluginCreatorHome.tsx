import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { PanelRightOpenIcon, SparklesIcon, XIcon, EyeIcon, WandSparklesIcon, HistoryIcon, AlertTriangleIcon } from 'lucide-react';
import { useApp } from '@/App';
import { api, apiBase, getAuthToken, tauriInvoke, tauriListen } from '@/lib/api';
import {
  deleteConversation,
  listConversations,
  readActiveId,
  readDraft,
  renameConversation,
  saveDraft,
  scanWorkspaceFiles,
  writeActiveId,
} from '@/lib/conversations';
import { toCreatorError, toUploadError, type CreatorError } from '@/lib/creator-error';
import {
  EXAMPLES,
  PROVIDERS,
  STATUS_LABEL,
  buildDraftFromSandboxFiles,
  buildLocalDraft,
  hasStructuredBlocks,
  makeConversationDraft,
  mergeConversationTurn,
  mergeFollowupDraft,
  mergeFollowupDraftWithSandbox,
  normalizeTurns,
  parseManifest,
  parseTranscript,
  providerLabel,
  readRecent,
  resolveSendModel,
  sessionToProbeResult,
  tailText,
  transcriptDiagnostics,
  transcriptTextSinceLastInput,
  writeRecent,
  type AskUserQuestion,
  type AssistantSessionRecord,
  type AssistantSessionState,
  type ConversationMeta,
  type EffortLevel,
  type ProviderId,
  type SessionCliIdPayload,
  type SessionErrorPayload,
  type SessionExitPayload,
  type SessionOutputPayload,
  type SessionStartedPayload,
  summarizeTitleLocally,
  validatePluginStructure,
} from '@/lib/plugin-draft';
import { DEFAULT_CONVERSATION_SYSTEM_PROMPT } from '@/lib/plugin-creator-protocol';
import type { LoadedPlugin } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LoadingButton } from '@/components/loading-button';
import { cn } from '@/lib/utils';
import { useEnvReadiness } from '@/lib/env-readiness';
import { dragRegionProps } from '@/lib/window-drag';
import { TaskChecklist } from '@/components/onboarding/TaskChecklist';
import { ErrorBubble } from '@/components/chat/ErrorBubble';
import { AssistantChat } from '@/components/chat/AssistantChat';
import { Composer } from '@/components/creator/Composer';
import { ConversationRail } from '@/components/creator/ConversationRail';
import { DetailsPanel } from '@/components/creator/DetailsPanel';
import { PreviewDrawer } from '@/components/creator/PreviewDrawer';
// 组C：插件名用户命名（PRD 需求 1）+ 动态状态从文件系统扫描（PRD 需求 2）。
import { safePluginId } from '@/lib/plugin-draft';
import {
  scanPluginStatus,
  STATUS_DISPLAY,
  STATUS_VARIANT,
  type LocalPluginStatus,
} from '@/lib/plugin-status';

export function PluginCreatorHome() {
  const { currentDraft, setCurrentDraft, session, setRunningPlugin, setView, setSettingsTab, view } = useApp();
  // 平台缺口 Top7：环境就绪检测（CLI / 模型服务 / 后端地址 / 团队），用于顶部「环境未就绪」横幅。
  // loading=true 时不渲染横幅（避免首帧闪烁）；ready=false 时渲染并提示去设置。
  // view 传入让用户从设置返回 home 时自动重检（PluginCreatorHome 常驻挂载，view 切换不卸载）。
  const envReadiness = useEnvReadiness(session, view);
  const [input, setInput] = useState('');
  // 流程重构：创建期不要求命名（先对话→AI生成→预览→上传时命名）。
  // pluginId 首次发送时由 Rust 侧用 session_id 自动生成临时目录名（plugins_root/<session_id>/）。
  // 上传时弹命名 Dialog，用户填名后 rename_plugin_dir 改正式目录名。
  const [pluginId, setPluginId] = useState<string | null>(null);
  const pluginIdRef = useRef<string | null>(null);
  // 组C（PRD 需求 2）：插件状态从文件系统动态扫描（pluginId 命中持久化目录时才有意义）。
  // null=未扫描/无 pluginId；LocalPluginStatus=当前插件的真实状态（ready/incomplete/error/running）。
  const [pluginStatus, setPluginStatus] = useState<LocalPluginStatus | null>(null);
  const [provider, setProvider] = useState(PROVIDERS[0].id);
  // R1 model 初始空串：模型清单由运行时双源合并填充（PROVIDERS.models 已置空），首次拉取后 effect 自动 setModel。
  const [model, setModel] = useState<string>(PROVIDERS[0].models[0] || '');
  const [providers, setProviders] = useState(PROVIDERS);
  // R2 思考强度：随每轮 send 传（start_session + send_input 都带，可会话中途调）。默认 medium。
  const [effort, setEffort] = useState<EffortLevel>('medium');
  const [streaming, setStreaming] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  // 问题2：历史悬浮窗改居中 Dialog（自动分页=内部 ScrollArea 限高），不再用右对齐 Popover。
  const [historyOpen, setHistoryOpen] = useState(false);
  const [pendingUser, setPendingUser] = useState<string | null>(null);
  // R3 流式分类：liveSegments 直接存 {stream, text}，按 stream 字段（stdout/stderr/thought/tool）分发渲染。
  // thought/tool 走独立分类区，绝不污染 stdout（协议解析依赖，阶段1 Rust 侧已分流）。
  const [liveSegments, setLiveSegments] = useState<Array<{ stream: 'stdout' | 'stderr' | 'thought' | 'tool'; text: string }>>([]);
  const [liveStage, setLiveStage] = useState('');
  const [liveError, setLiveError] = useState<CreatorError | null>(null);
  const [assistantSession, setAssistantSession] = useState<AssistantSessionState | null>(null);
  const assistantSessionRef = useRef<AssistantSessionState | null>(null);
  // design §3.1.3 / §3.2：listener 守卫改按 activeId 路由。
  // CREATOR-13 清理：assistantSessionIdRef 此前声明并写入但全仓库无任何读取点
  // （所有路由守卫实际用 activeIdRef.current），是迁移遗留的死代码。已删除，路由职责由 activeIdRef 单独承担。
  const pendingPromptRef = useRef<{ text: string; providerLabel: string; model: string } | null>(null);
  // 标记当前进行中的轮次是否为追问（send() 追问路径置 true，finalizeSession 据此走累积分支）。
  const isFollowupRef = useRef(false);
  // ASKU-01 修复：AskUserQuestion 问题卡片防重入守卫。
  // handleAskUserAnswer 唯一守卫只有 if(!streaming) return，streaming 在 send_input resolve 前恒为 true，
  // 用户在 async 窗口内连点会触发多次 send_input（Rust 侧无 in-flight 守卫 → 派生并发进程、双 exit、transcript 串写）。
  // 此 ref 在入口置位、finally 复位，禁用 option 按钮直到本轮 send_input 完成。
  // 配套 askAnswering state（驱动 StreamingMessage 重渲染 option 按钮 disabled 态）。
  const askAnsweringRef = useRef(false);
  const [askAnswering, setAskAnswering] = useState(false);
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
  // 修复 H5：追踪后端是否报告过至少一个可用 CLI。若全 unavailable（用户未装任何 CLI），
  // send 入口拦截，避免发起注定失败的 start_session（此前仅 env-readiness 横幅提示但非阻断）。
  const hasAvailableCliRef = useRef<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    // R1 模型来源：只用「模型服务里拉取并保存的上游模型」（binding.modelOverride + active-provider.defaultModels）。
    // 不再并入本地 CLI 预填模型（sonnet/opus/gpt-5.5 等 CLI 内置默认值），因为用户未主动配置、且可能与上游模型混淆。
    // provider（claude/codex/opencode）骨架仍由本地 CLI 探测提供（决定 send 调哪个 CLI），但每个 provider 的 models 只填上游模型。
    Promise.all([
      tauriInvoke<Array<{ tool: string; display_name?: string; available?: boolean; models?: string[] }>>('code_assistant_list_tools'),
      api<{ defaultModels?: string[] } | null>('/api/llm/active-provider').catch(() => null),
      api<{ binding?: { modelOverride?: string[] | null } } | null>('/api/llm/binding').catch(() => null),
    ])
      .then(([tools, activeProvider, binding]) => {
        if (cancelled) return;
        // provider 骨架：本地已装 CLI（仅取 id/label，不取其内置 models）。
        const cliProviders = (tools || [])
          .filter((t) => t.available)
          .map((t) => ({
            id: String(t.tool),
            label: String(t.display_name || t.tool),
            models: [] as string[],
          }));
        // 上游模型（用户在模型服务里拉取保存的）：binding.modelOverride 优先，fallback activeProvider.defaultModels。
        const upstreamModels = Array.from(new Set([
          ...((binding?.binding?.modelOverride) || []),
          ...((activeProvider?.defaultModels) || []),
        ])).filter(Boolean);
        // 每个 provider 的 models 只填上游模型（不并入 CLI 预填）。
        const baseProviders = cliProviders.length ? cliProviders : PROVIDERS;
        const merged = baseProviders.map((p) => ({ ...p, models: [...upstreamModels] }));
        hasAvailableCliRef.current = cliProviders.length > 0;
        if (merged.length) setProviders(merged);
      })
      .catch(() => { /* fallback 到 PROVIDERS，hasAvailableCliRef 保持 null 不阻断 */ });
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
  }, [turns.length, liveSegments, pendingUser]);
  useEffect(() => { assistantSessionRef.current = assistantSession; }, [assistantSession]);
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);
  // CREATOR-11 修复：listener effect 此前依赖 [provider, model]，会被 list_tools 异步覆盖 providers
  // 后触发的 model 变更重新挂载。重挂窗口内到达的 exit 事件丢失 → finalizeSession 永不执行、streaming 永久 true。
  // 用 ref 读取 provider/model，让 listener 只挂载一次（依赖稳定量 tenantId）。
  const providerRef = useRef(provider);
  useEffect(() => { providerRef.current = provider; }, [provider]);
  const modelRef = useRef(model);
  useEffect(() => { modelRef.current = model; }, [model]);
  useEffect(() => { if (files.length && !files.find((file) => file.path === activeFile)) setActiveFile(files[0].path); }, [files, activeFile]);

  // 组C（PRD 需求 2 / AC2）：插件状态从文件系统动态扫描。
  // pluginId 命中持久化目录时调 scan_plugin_status 拿当前插件的真实状态（ready/incomplete/error/running）。
  // 顶部状态 Badge 显示 pluginStatus.status（优先于 currentDraft.status，反映文件系统真相）。
  // 流式进行中（streaming）也重扫（AI 正在写文件，状态可能从 incomplete→ready 动态变化）。
  useEffect(() => {
    if (!pluginId) {
      setPluginStatus(null);
      return;
    }
    let cancelled = false;
    const scan = async () => {
      try {
        const items = await scanPluginStatus();
        if (cancelled) return;
        const current = items.find((item) => item.id === pluginId);
        setPluginStatus(current ?? null);
      } catch {
        // scan 失败静默（Rust 组A 未实现时降级，不阻断创建流程；顶部状态回退到草稿状态）。
        if (!cancelled) setPluginStatus(null);
      }
    };
    void scan();
    return () => { cancelled = true; };
  }, [pluginId, streaming, files.length]);

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
    writeActiveId(session.tenantId, id);
  }

  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];

    // 修复 StrictMode 重复注册：tauriListen 是 async，StrictMode 开发模式双调用 effect 时，
    // 第一次的 await 可能在 cleanup 之后才 resolve 并 push listener，导致该 listener 永不被清理
    // → 同一 output 事件触发两次 handler → 文本重复显示两遍。
    // helper：await 后若已 disposed，立即 unlisten 不 push（防止孤儿 listener）。
    async function attachListen<T>(event: string, handler: (e: { payload: T }) => void) {
      const unlisten = await tauriListen<T>(event, handler);
      if (disposed) {
        unlisten();
      } else {
        unlisteners.push(unlisten);
      }
    }

    async function attach() {
      try {
        await attachListen<SessionStartedPayload>('code-assistant://session-started', ({ payload }) => {
          // design §3.1.3：守卫按 activeId 路由（首问已 startNewSession 设过 activeIdRef）。
          if (disposed || payload.sessionId !== activeIdRef.current) return;
          const record = payload.record;
          // CREATOR-11 修复：用 ref 读取 provider/model，避免在 listener 闭包内绑定到 effect 注册时的旧值。
          const providerVal = providerRef.current;
          const modelVal = modelRef.current;
          setLiveStage('代码助手已启动，等待响应…');
          setAssistantSession((prev) => ({
            sessionId: payload.sessionId,
            status: 'running',
            provider: (record?.tool || prev?.provider || providerVal) as ProviderId,
            providerLabel: providerLabel((record?.tool || prev?.provider || providerVal) as ProviderId),
            model: record?.model || prev?.model || modelVal,
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
        });
        // design §3.3.3：捕获 claude session_id（仅 claude stream-json 会 emit）→ 标记 native 真 resume 多轮。
        // cli_session_id 真值由 Rust 回写 SessionRecord，前端只据此切 native mode。
        await attachListen<SessionCliIdPayload>('code-assistant://session-cli-id', ({ payload }) => {
          if (disposed || payload.sessionId !== activeIdRef.current) return;
          if (payload.cliSessionId) {
            setMultiturnMode('native');
          }
        });
        await attachListen<SessionOutputPayload>('code-assistant://output', ({ payload }) => {
          if (disposed || payload.sessionId !== activeIdRef.current) return;
          const text = payload.text || '';
          if (!text) return;
          const stream = payload.stream || 'stdout';
          // 关键约束（阶段1）：stdout/stderr 进协议聚合输入（assistantSession.stdout/stderr），
          // thought/tool 走独立分类区，绝不污染 stdout（协议解析依赖纯 stdout 文本）。
          setAssistantSession((prev) => prev ? {
            ...prev,
            stdout: stream === 'stdout' ? tailText(prev.stdout + text) : prev.stdout,
            stderr: stream === 'stderr' ? tailText(prev.stderr + text) : prev.stderr,
          } : prev);
          // R3：按 stream 字段分发到分类渲染（stdout/stderr/thought/tool），thought/tool 独立区域展示。
          setLiveSegments((prev) => [...prev, { stream, text }].slice(-400));
          // R5 stage 文案动态：思考阶段「正在思考中…」/ 文本阶段「正在生成…」/ 诊断「正在输出诊断…」。
          // 兜底：未知 stream 归生成中。
          setLiveStage(
            stream === 'thought' ? '思考中…'
              : stream === 'stdout' ? '生成中…'
                : stream === 'stderr' ? '检查结果输出中…'
                  : stream === 'tool' ? '调用工具中…'
                    : '生成中…',
          );
        });
        await attachListen<SessionErrorPayload>('code-assistant://error', ({ payload }) => {
          if (disposed || payload.sessionId !== activeIdRef.current) return;
          const message = payload.error || '代码助手输出异常';
          setAssistantSession((prev) => prev ? { ...prev, status: 'failed', diagnostics: [...prev.diagnostics, message] } : prev);
          setLiveError(toCreatorError('cli_session_error', new Error(message)));
        });
        await attachListen<SessionExitPayload>('code-assistant://exit', ({ payload }) => {
          if (disposed || payload.sessionId !== activeIdRef.current) return;
          const nextStatus = payload.status === 'stopped' ? 'stopped' : 'exited';
          setAssistantSession((prev) => prev ? { ...prev, status: nextStatus, exitCode: payload.exitCode ?? null, endedAt: payload.endedAt } : prev);
          // design §3.3.6 (d)：首轮 exit 后判定多轮能力——claude 已捕获 cliSessionId 为 native；
          // 其余（codex/opencode，或 claude 未捕获 id）标记 degraded（伪多轮，透明提示）。
          setMultiturnMode((prev) => prev === 'native' ? 'native' : 'degraded');
          setLiveStage(nextStatus === 'stopped' ? '已停止，整理结果中…' : '已结束，整理结果中…');
          void finalizeSession(payload.sessionId, nextStatus, payload.exitCode ?? null, payload.endedAt);
        });
      } catch {
        // 浏览器预览环境没有 Tauri event bridge，发送时会通过 invoke 给出明确错误。
      }
    }

    void attach();
    return () => {
      disposed = true;
      for (const unlisten of unlisteners) unlisten();
    };
    // CREATOR-11 修复：依赖改为稳定量 [session.tenantId]，不再绑 [provider, model]。
    // 避免 list_tools 异步覆盖 providers 触发 model 变更 → listener 重挂丢失 exit 事件。
  }, [session.tenantId]);

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
      // CREATOR-06 修复：此前 finalSession.stdout = tailText(stdout || ..., 12000)，
      // 对 codex/opencode（stdout 围栏块解析路径）当一轮产出超 12k 字符时前段被截掉，
      // 若 manifest 块或 file 起始围栏落在丢弃的前段，hasStructuredBlocks=false → 落入纯对话态，
      // 结构化产出被丢弃。stdout 已是 transcriptTextSinceLastInput 切出的「本轮」输出（不会跨轮累积），
      // 故结构化检测与解析直接用完整本轮 stdout，不受 tailText(12000) 截断影响。
      // （tailText 仍用于 SessionStatusPanel 显示的 stdout/stderr，仅作渲染层内存保护。）
      const fullStdout = stdout || currentSession?.stdout || '';
      const fullStderr = stderr || currentSession?.stderr || '';
      const finalSession: AssistantSessionState = {
        sessionId,
        status,
        // CREATOR-11 修复：用 ref 读取 provider/model，避免 finalizeSession 闭包绑定到 listener 注册时的旧值
        // （listener effect 依赖 [session.tenantId]，provider 变化时不会重挂，闭包陈旧）。
        provider: (currentSession?.provider || providerRef.current) as ProviderId,
        providerLabel: currentSession?.providerLabel || providerLabel((currentSession?.provider || providerRef.current) as ProviderId),
        model: currentSession?.model || modelRef.current,
        commandPreview: currentSession?.commandPreview || [],
        transcriptPath: currentSession?.transcriptPath || '',
        pid: currentSession?.pid,
        exitCode,
        startedAt: currentSession?.startedAt,
        endedAt,
        stdout: tailText(fullStdout),
        stderr: tailText(fullStderr),
        diagnostics,
      };
      setAssistantSession(finalSession);
      // probeResult 用完整本轮 stdout（结构化解析依赖围栏块完整）。
      const probeResult = sessionToProbeResult({ ...finalSession, stdout: fullStdout, stderr: fullStderr });
      // 修复 CREATOR-02：finalizeSession 是 async，await read_transcript/scan_workspace 期间用户可能切换会话。
      // 若已切走，currentDraftRef 已变成新会话草稿，此时 merge 会把本轮产出叠到别会话上并脏写回本会话文件。
      // 中途守卫：sessionId 不再是活跃会话则中止（本轮产出已落 transcript，不影响后续手动恢复）。
      if (sessionId !== activeIdRef.current) return;
      // 修复 CREATOR-04：error 事件后同一进程的 exit 仍会触发 finalizeSession 成功路径。
      // 此前成功路径不清 liveError，ErrorBubble（!streaming && liveError）与 toast.success 同屏并存。
      // 成功路径起点清掉陈旧错误气泡（真正失败走 catch 块重新 setLiveError）。
      setLiveError(null);
      const promptText = pending?.text || pendingUser || '插件';
      const prevDraft = currentDraftRef.current; // 读 ref 最新值（闭包陷阱修复）

      // 方案A：claude 用 Write 工具把插件文件写到 sandbox 目录，CLI exit 后先扫描 sandbox 收文件。
      // 扫描到 manifest.json → files 直接来自磁盘（claude 真实写盘），不走 stdout 围栏块解析
      // （claude 写了文件后不再产围栏块，stdout 解析会判 invalid，故 sandbox 是结构化产出的主来源）。
      // 扫描为空（纯对话 / claude 未写文件）→ 回退到现有对话 / 围栏块逻辑。
      const sbFiles = await scanWorkspaceFiles(sessionId).catch(() => []);
      const hasSandboxManifest = sbFiles.some((file) => file.path === 'manifest.json');

      // design §3.1.2 / AC1：对话优先 gate——产出含 manifest/file 块才解析为草稿（自动检测）。
      // 纯对话态（无结构化块）只追加 turn，status='generating'，不弹详情、不判 invalid。
      // CREATOR-06：用完整本轮 stdout（fullStdout）做检测，避免 tailText 截断导致误判纯对话态。
      const structured = hasStructuredBlocks(fullStdout);
      let nextDraft: NonNullable<typeof currentDraft>;
      if (hasSandboxManifest) {
        // sandbox 扫描到 manifest.json（claude 写了文件）：走 sandbox 草稿构建，files 来自磁盘扫描。
        if (isFollowup && prevDraft) {
          nextDraft = mergeFollowupDraftWithSandbox(prevDraft, probeResult, promptText, sbFiles);
        } else {
          const built = buildDraftFromSandboxFiles({
            prompt: promptText,
            providerLabel: pending?.providerLabel || finalSession.providerLabel,
            model: pending?.model || finalSession.model,
            result: probeResult,
            files: sbFiles,
          });
          // sandbox 有 manifest.json 但 buildDraftFromSandboxFiles 返回 null（极端：manifest 解析全失败），
          // 回退到 stdout 围栏块解析，保证不丢产出。
          nextDraft = built || buildLocalDraft({
            prompt: promptText,
            providerLabel: pending?.providerLabel || finalSession.providerLabel,
            model: pending?.model || finalSession.model,
            result: probeResult,
          });
        }
        setCurrentDraft(nextDraft);
        setDetailsOpen(true);
      } else if (structured) {
        // 有结构化块（claude 偶尔仍产围栏块兜底）：走原 buildLocalDraft（首轮）/ mergeFollowupDraft（追问）。
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
        const assistantText = finalSession.stdout || finalSession.stderr || '代码助手没有返回可展示内容。';
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

      // 需求 3（状态读文件系统）：草稿携带 plugin_id，切回历史会话时据此恢复 pluginId，
      // 让顶部 Badge 走 scan_plugin_status 读文件系统真相而非解析态。
      if (nextDraft && pluginIdRef.current) {
        nextDraft.plugin_id = pluginIdRef.current;
      }

      // 结构校验：AI 生成后检测 manifest 缺失/入口文件缺失/入口名不规范，
      // 追加诊断进 draft.diagnostics，让详情面板「检查结果」显式提示（避免「生成成功却无法运行」）。
      if (nextDraft && nextDraft.files.length > 0) {
        const structureDiags = validatePluginStructure(nextDraft.files);
        if (structureDiags.length > 0) {
          nextDraft.diagnostics = [...(nextDraft.diagnostics ?? []), ...structureDiags];
        }
      }

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

      // toast 文案分场景：结构化（sandbox 扫描或围栏块）走「完成」语义；纯对话态走「已完成对话」，避免 invalid 误报。
      // hasSandboxManifest / structured 任一命中即视为「有结构化产出」，走完成语义。
      const hasStructuredOutput = hasSandboxManifest || structured;
      if (hasStructuredOutput && finalSession.status === 'exited' && finalSession.exitCode === 0) {
        toast.success(isFollowup ? '代码助手已完成本次更新' : '代码助手已完成生成');
      } else if (finalSession.status === 'stopped') {
        toast.message('已停止代码助手，保留部分结果');
      } else if (!hasStructuredOutput) {
        toast.success('对话已完成');
      } else {
        toast.error('代码助手未成功完成，查看右侧检查结果');
      }
    } catch (error) {
      const creatorError = toCreatorError('transcript_failed', error);
      setLiveError(creatorError);
      toast.error(creatorError.title);
    } finally {
      // design §3.3.6 (c)：finally 仅清流式态与 pendingPrompt，**保留** activeIdRef（追问需用）。
      setStreaming(false);
      setLiveStage('');
      // 修复 CREATOR-09：catch 路径（read_transcript 失败）此前未清 pendingUser，
      // 用户气泡残留 → hasConversation 仍为 true，空状态引导被隐藏，UI 卡在带错误气泡的对话态。
      setPendingUser(null);
      pendingPromptRef.current = null;
      isFollowupRef.current = false;
      // 修复 ASKU-01：AskUserQuestion 防重入守卫复位（任何 finalizeSession 完成都解锁 option 按钮）。
      askAnsweringRef.current = false;
      setAskAnswering(false);
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

  // CLI 配置注入（task 06-15）：把当前登录态的 backendUrl + authToken 传给 Rust，
  // Rust 内部调 decrypt/active-provider 拿 apiKey + apiUrl 生成 CLI 隔离配置（key 不进前端，AC8）。
  // 未登录或无后端地址时返回 undefined（Rust 侧降级为不注入，CLI 走默认配置，AC4）。
  function buildCliConfig() {
    const backendUrl = apiBase();
    const authToken = getAuthToken();
    if (!backendUrl || !authToken) return undefined;
    return { backendUrl, authToken };
  }

  // 流程重构：创建期不传 pluginId，Rust 侧用 session_id 自动生成临时持久化目录。
  // 上传时弹命名 Dialog，用户填名后 rename 目录。
  async function startNewSession(text: string, selectedProvider: ProviderId) {
    const record = await tauriInvoke<AssistantSessionRecord>('code_assistant_start_session', {
      input: {
        tool: selectedProvider,
        model: resolveSendModel(model),
        // 不传 pluginId → Rust 用 session_id 自动生成 plugins_root/<session_id>/ 持久化目录。
        prompt: text,
        systemPrompt: DEFAULT_CONVERSATION_SYSTEM_PROMPT,
        effort,
        cliConfig: buildCliConfig(),
      },
    });
    // 新会话立即成为 activeId（listener 守卫据此路由新会话事件）。
    setActiveIdRef(record.sessionId);
    // 流程重构（AC1 修复）：从 Rust 返回的 workspaceDir（= plugins_root/<temp_id>/ 持久化目录）
    // 提取 plugin_id，供上传时 rename_plugin_dir 改正式目录名 + 创建期状态扫描命中。
    // record.workspaceDir 是 canonicalize 后的绝对路径，取末段即 plugin_id（sanitize 白名单已通过）。
    if (record.workspaceDir) {
      const derivedId = record.workspaceDir.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
      const nextPluginId = derivedId || null;
      setPluginId(nextPluginId);
      pluginIdRef.current = nextPluginId;
    }
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
    setLiveStage('代码助手已启动，等待响应…');
    // 纯对话态默认不弹详情面板；若旧会话已打开详情也无关新对话，保持当前开合态。
  }

  // 发起一轮对话。overrideText 用于「重试」场景复用上一次 prompt
  // （send 出错时 input 已清空，重试不能用空 input）。
  async function send(overrideText?: string) {
    const text = (overrideText ?? input).trim();
    if (!text || streaming) return;
    // 修复 H5：后端已确认无可用 CLI 时拦截发送，避免发起注定失败的 start_session。
    // null 表示尚未拉取（不阻断，与原行为一致）；false 表示确认无可用 CLI。
    if (hasAvailableCliRef.current === false) {
      toast.error('当前无可用 CLI，请先在设置中安装 Claude / Codex / OpenCode');
      return;
    }
    setInput('');
    setPendingUser(text);
    setLiveSegments([]);
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
          ? '代码助手基于历史继续生成（多轮能力有限，未完整复用上下文）…'
          : '代码助手继续生成中…',
      );
      try {
        // 追问传入当前选的 model（会话内切模型，下一轮生效）；Rust 优先用此值覆盖 session 固化值。
        // R2 effort 同样随本轮传入（可会话中途调思考强度）。
        // R6 自定义模型：resolveSendModel 把哨兵/default 归一为 undefined。
        await tauriInvoke('code_assistant_send_input', {
          input: { sessionId: activeSessionId, input: text, model: resolveSendModel(model), effort, cliConfig: buildCliConfig(), systemPrompt: DEFAULT_CONVERSATION_SYSTEM_PROMPT },
        });
        // send_input 成功后新一轮 output/exit 事件由既有 listener 处理，finalizeSession 走追问累积分支。
      } catch (error) {
        handleMultiturnError(error);
      }
      return;
    }

    // 首轮路径：保留原 start_session 逻辑（抽到 startNewSession）。
    isFollowupRef.current = false;
    setLiveStage('正在启动代码助手…');
    try {
      await startNewSession(text, selectedProvider);
    } catch (error) {
      const creatorError = toCreatorError('cli_start_failed', error);
      setLiveError(creatorError);
      toast.error(creatorError.title);
      setStreaming(false);
      setLiveStage('');
      // 修复 CREATOR-08：首轮 start_session 失败的 catch 此前漏清 pendingUser，
      // line 558 刚置位的用户气泡与 ErrorBubble 同屏残留。与 handleMultiturnError 行为对齐。
      setPendingUser(null);
      pendingPromptRef.current = null;
      isFollowupRef.current = false;
      setActiveIdRef(null);
    }
  }

  async function stopCurrentSession() {
    const sessionId = activeIdRef.current || assistantSession?.sessionId;
    if (!sessionId || !streaming) return;
    setLiveStage('正在停止代码助手…');
    setAssistantSession((prev) => prev ? { ...prev, status: 'stopping' } : prev);
    try {
      await tauriInvoke('code_assistant_stop_session', { input: { sessionId } });
    } catch (error) {
      const creatorError = toCreatorError('session_op_failed', error);
      setLiveError(creatorError);
      toast.error(creatorError.title);
    }
  }

  // R4 AskUserQuestion 回答回传：用户在问题卡片选了 option 后，把答案作为下一轮 send_input 传入。
  // 本轮按 --resume 续接（答案当普通文本），tool_use_id 精确关联留后续 stream-json input 升级。
  // 复用 send() 的追问路径：答案文本走 input，effort/model 随当前选择器值。
  async function handleAskUserAnswer(question: AskUserQuestion, optionLabel: string) {
    // ASKU-01 修复：防重入守卫。streaming 在 send_input resolve 前恒为 true，
    // 此前连点会触发多次 send_input。用 askAnsweringRef 在入口置位、finally 复位，
    // 期间 StreamingMessage 的 option 按钮 disabled（读 askAnsweringRef 经 answered prop 传入）。
    if (!streaming || askAnsweringRef.current) return;
    // 修复 CREATOR-07：追问前置条件应与 send() 一致——校验首轮已退出（status !== 'running'），
    // 否则首轮 CLI 仍在 running 时派生第二个进程写同一 transcript，双 exit 覆盖草稿。
    // （Rust send_input 无 running 检查，前端必须自守。）
    const sessionId = activeIdRef.current;
    if (!sessionId) return;
    if (assistantSession?.status && assistantSession.status === 'running') {
      // 首轮仍在运行：拒绝追问提交，避免派生并发进程污染 transcript。
      toast.error('上一轮仍在运行，等待完成或停止后再回答。');
      return;
    }
    // 组合可读回答：问句 + 选项（便于上下文追溯，纯选项字面在多选语境下歧义）。
    const answer = `${question.question}\n选择：${optionLabel}`;
    // 修复 CREATOR-01：复用 send() 追问路径的状态写入。此前这些 ref/state 全程未更新，
    // 导致 CLI exit 后 finalizeSession 读 isFollowupRef(仍 false) 走首轮分支，用首问覆盖已累积草稿、答案丢失。
    setPendingUser(answer);
    pendingPromptRef.current = { text: answer, providerLabel: providerInfo.label, model };
    lastPromptRef.current = answer;
    isFollowupRef.current = true;
    // ASKU-01：防重入置位（option 按钮 disabled 直到 send_input 完成）。
    askAnsweringRef.current = true;
    setAskAnswering(true);
    setLiveStage('提交中…');
    try {
      await tauriInvoke('code_assistant_send_input', {
        input: {
          sessionId,
          input: answer,
          // R6 自定义模型：resolveSendModel 把哨兵/default 归一为 undefined。
          model: resolveSendModel(model),
          effort,
          // 修复 ASK-CLICONFIG：首问（start_session）与普通追问（上方 send_input）都注入 cliConfig，
          // 但 AskUser 问题卡片选 option 回答的追问轮此前漏传——该轮不注入平台 key/apiUrl，
          // 与普通追问行为不一致，可能在 Rust 侧未复用首轮注入配置时鉴权失败/路由到错误 provider。
          // 与 line 630 追问路径对齐，补齐 cliConfig。
          cliConfig: buildCliConfig(),
          // 追问轮也传 systemPrompt（与 send() 追问路径一致，保证降级分支/codex/opencode 有系统约束）。
          systemPrompt: DEFAULT_CONVERSATION_SYSTEM_PROMPT,
        },
      });
      // 回答提交后新一轮 output 由既有 listener 处理；清掉本轮工具片段，避免问题卡片重复渲染。
      setLiveSegments((prev) => prev.filter((s) => s.stream !== 'tool'));
    } catch (error) {
      handleMultiturnError(error);
      // ASKU-01：send_input 抛错时 finalizeSession 不会跑（无 exit 事件），askAnsweringRef 需手动复位。
      askAnsweringRef.current = false;
      setAskAnswering(false);
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
    setLiveSegments([]);
    setLiveError(null);
    setStreaming(false);
    // 修复 CREATOR-03：清理 liveSegments/liveError/streaming 但漏掉 setPendingUser(null)，
    // 旧会话的 pendingUser 气泡残留到新会话视图；且 hasConversation 含 Boolean(pendingUser)，
    // 新空会话会误进对话视图而非空状态引导。与 newDraft 一致地补上。
    setPendingUser(null);
    // 修复 ASKU-01：切会话时复位防重入守卫（若旧会话追问未完成即被切走）。
    askAnsweringRef.current = false;
    setAskAnswering(false);
    // 流程重构：切会话时清空 pluginId/状态。
    setPluginId(null);
    pluginIdRef.current = null;
    setPluginStatus(null);
    try {
      const draftRaw = await readDraft(id);
      const parsed = draftRaw ? JSON.parse(draftRaw) : null;
      setCurrentDraft(parsed);
      // 需求 3（状态读文件系统）：从草稿恢复 plugin_id（草稿落盘时已携带），让顶部 Badge
      // 走 scan_plugin_status 读文件系统真相，而非回退到解析态 status。
      const draftPluginId = typeof parsed?.plugin_id === 'string' && parsed.plugin_id.trim() ? parsed.plugin_id : null;
      if (draftPluginId) {
        setPluginId(draftPluginId);
        pluginIdRef.current = draftPluginId;
      }
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
    // 修复 CREATOR-05：selectConversation 此前无条件 setMultiturnMode(null)。
    // codex/opencode 不 emit session-cli-id（仅 claude stream-json 才 emit），追问期间 multiturnMode 仍为 null，
    // 「此 CLI 不支持原生多轮…」透明提示永不显示，且 liveStage 反而显示 native 文案误导用户上下文真复用。
    // 改为：codex/opencode 直接置 'degraded'（恢复会话首问即弹降级提示，符合设计决策）；
    // claude 保持 null（由后续 session-cli-id 或 exit 判定）。
    if (meta && (meta.tool === 'codex' || meta.tool === 'opencode')) {
      setMultiturnMode('degraded');
    } else {
      setMultiturnMode(null);
    }
    setCloudPlugin(null);
  }

  async function handleDeleteConversation(id: string) {
    try {
      await deleteConversation(id);
    } catch {
      toast.error('删除对话失败');
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
    toast.success('已删除对话');
  }

  async function handleRenameConversation(id: string, title: string) {
    try {
      await renameConversation(id, title);
    } catch {
      toast.error('重命名对话失败');
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
      // CREATOR-06：与 finalizeSession 一致——结构化解析依赖完整本轮 stdout（transcriptTextSinceLastInput
      // 已切本轮，不会跨轮累积），不受 tailText(12000) 截断影响。
      const fullStdout = stdout || base?.stdout || '';
      const fullStderr = stderr || base?.stderr || '';
      // 修复 CREATOR-12：promptText 回退此前取首个 user turn（turns.find），多轮下应取最后一个 user turn，
      // 与 transcriptTextSinceLastInput（取最后一个 input 之后）的「最近一轮」语义对齐。
      // 否则恢复历史纯对话会话后点「转为草稿」会把首轮 prompt 当本轮 user turn 追加（归因错误 + 重复 user turn）。
      const lastUserTurn = (() => {
        for (let i = turns.length - 1; i >= 0; i--) {
          if (turns[i].role === 'user') return turns[i].content;
        }
        return undefined;
      })();
      const promptText = pendingPromptRef.current?.text || lastPromptRef.current || lastUserTurn || '插件';
      // 重建完整 AssistantSessionState（强制定义解析所需的全部字段，避免 null 展开）。
      // 显示层 stdout/stderr 仍走 tailText（内存保护）；probeResult 用完整本轮 stdout。
      const rebuilt: AssistantSessionState = {
        sessionId,
        status: base?.status || 'exited',
        provider: base?.provider || (provider as ProviderId),
        providerLabel: base?.providerLabel || providerInfo.label,
        model: base?.model || model,
        commandPreview: base?.commandPreview || [],
        transcriptPath: base?.transcriptPath || '',
        startedAt: base?.startedAt,
        stdout: tailText(fullStdout),
        stderr: tailText(fullStderr),
        diagnostics: base?.diagnostics || [],
      };
      const probeResult = sessionToProbeResult({ ...rebuilt, stdout: fullStdout, stderr: fullStderr });
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

  // 流程重构：上传时弹命名 Dialog，用户确认插件名后才上传。
  const [namingOpen, setNamingOpen] = useState(false);
  const [namingValue, setNamingValue] = useState('');
  const [namingLoading, setNamingLoading] = useState(false);

  /** 上传按钮点击：先弹命名 Dialog。 */
  function uploadCloud() {
    if (!files.length) return;
    setNamingValue(manifest.name || '');
    setNamingOpen(true);
  }

  /** 命名确认后实际执行上传。 */
  async function doUpload() {
    const name = namingValue.trim();
    if (!name) return toast.error('请填写插件名称');
    setNamingLoading(true);
    try {
      // AC1 用户命名：先把临时持久化目录 rename 成正式目录名（基于用户命名的 safePluginId），
      // 并把用户命名写入 manifest.title（Rust rename_plugin_dir 的 title 参数一次完成）。
      // rename 失败不阻断上传（降级：目录名仍为 temp_id，但 title 已进 uploadManifest，云端展示名仍正确）。
      const oldId = pluginIdRef.current;
      if (oldId) {
        const safeNew = safePluginId(name);
        if (safeNew && safeNew !== oldId) {
          try {
            const renamed = await tauriInvoke<string>('rename_plugin_dir', { oldId, newId: safeNew, title: name });
            setPluginId(renamed);
            pluginIdRef.current = renamed;
          } catch (e) {
            // rename 失败（重名/权限/同名目录已存在）：仅 toast 提示，继续走上传（title 仍随 manifest 上传）。
            toast.error(`命名持久化目录失败：${(e as Error).message || e}（仍将以上传名展示）`);
          }
        }
      }
      // 上传到后端（manifest 含用户命名的 name + title）。
      const uploadManifest = { ...manifest, name, title: name };
      const result = await api<{ plugin: LoadedPlugin; deduplicated?: boolean }>('/api/plugins/upload', {
        method: 'POST',
        body: { manifest: uploadManifest, files },
      });
      const plugin = { ...result.plugin, files, manifest: uploadManifest, source: 'team' as const };
      setCloudPlugin(plugin);
      pushRecent(plugin);
      setNamingOpen(false);
      toast.success(result.deduplicated ? '团队共享中已有相同插件' : '已上传到团队共享');
    } catch (error) {
      const creatorError = toUploadError(error, 'upload');
      setLiveError(creatorError);
      toast.error(creatorError.title);
    } finally {
      setNamingLoading(false);
    }
  }

  async function submitMarketplace() {
    if (!cloudPlugin) return toast.error('先上传到团队共享');
    setSubmitting(true);
    try {
      const result = await api<{ plugin: LoadedPlugin }>(`/api/plugins/${cloudPlugin.id}/submit-marketplace`, { method: 'POST', body: { priceCents: 0 } });
      const plugin = { ...cloudPlugin, ...result.plugin, source: 'team' as const };
      setCloudPlugin(plugin);
      pushRecent(plugin);
      toast.success('已提交插件市场审核');
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
    setLiveSegments([]);
    setLiveStage('');
    setLiveError(null);
    setAssistantSession(null);
    assistantSessionRef.current = null;
    setActiveIdRef(null);
    // 修复 H3：重置活动文件选中态。此前未清 activeFile，新对话后预览/详情面板仍指向旧会话文件路径，
    // activeContent 取空串不崩但状态不一致（指向已不存在的文件）。与 setActiveIdRef(null) 同步重置。
    setActiveFile('');
    pendingPromptRef.current = null;
    isFollowupRef.current = false;
    // 重置多轮运行态：新对话回到首轮语义（multiturnMode 待定）。
    setMultiturnMode(null);
    lastPromptRef.current = null;
    // 流程重构：重置 pluginId + 动态状态。新对话不再关联上一插件的持久化目录。
    setPluginId(null);
    pluginIdRef.current = null;
    setPluginStatus(null);
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
        {/* 侧边栏折叠按钮已上移到 TitleBar，此处不再需要 pl-16 避让。 */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3">
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
            {/* 需求 3（状态读文件系统）：状态优先显示 scan_plugin_status 扫描结果（ready/incomplete/error/running），
                反映插件持久化目录的真实文件状态——AI 写完文件即实时判定，不依赖转草稿。
                仅当无 pluginId（纯对话/未关联目录）时回退到草稿解析态 status。 */}
            {(() => {
              if (pluginStatus) {
                const variant = STATUS_VARIANT[pluginStatus.status];
                return <Badge variant={variant}>{STATUS_DISPLAY[pluginStatus.status]}</Badge>;
              }
              if (status) {
                return <Badge variant={status === 'ready' ? 'default' : status === 'invalid' ? 'destructive' : 'secondary'}>{STATUS_LABEL[status] || status}</Badge>;
              }
              return null;
            })()}
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
            {/* design §3.3.2：使用插件按钮——有草稿（files 非空）才可点，否则 disabled + tooltip。 */}
            <Button
              variant="outline"
              size="sm"
              disabled={!hasDraft}
              onClick={() => setPreviewOpen(true)}
              title={hasDraft ? '使用插件' : '尚未生成插件草稿'}
            >
              <EyeIcon className="size-4" /> 使用插件
            </Button>
            <Button variant="outline" size="sm" onClick={() => setDetailsOpen(true)}>
              <PanelRightOpenIcon className="size-4" /> 详情
            </Button>
          </div>
        </div>
        {/* 平台缺口 Top7：环境未就绪横幅——ready=false 时提示缺失项 + 「去设置」按钮。
            检测项见 env-readiness.ts（CLI / 模型服务 / 后端地址 / 团队）。
            loading=true 时不渲染（首帧未拉取完，避免闪烁）；ready=true 不渲染（环境 OK 无需打扰）。 */}
        {!envReadiness.loading && !envReadiness.ready && (
          <div className="flex shrink-0 items-start gap-3 border-b bg-amber-50 px-4 py-2.5 text-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
            <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
            <div className="min-w-0 flex-1 text-xs leading-relaxed">
              环境未就绪：{envReadiness.missing.join('；')}。完善后即可创建插件。
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-7 shrink-0 border-amber-300 bg-transparent text-amber-900 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-100 dark:hover:bg-amber-900/50"
              onClick={() => {
                // 缺失项优先级：未装 CLI → cli Tab；未配模型 → gateway Tab；否则 backend Tab。
                const m = envReadiness.missing.join('');
                const tab = m.includes('CLI') ? 'cli' : m.includes('API 密钥') ? 'gateway' : 'backend';
                setSettingsTab(tab);
                setView('settings');
              }}
            >
              去设置
            </Button>
          </div>
        )}
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
              {/* 对话显示改用 assistant-ui（替换自写 Bubble+StreamingMessage）：
                  useExternalStoreRuntime 适配 Tauri 事件流，思考/工具/正文分行渲染。 */}
              <AssistantChat
                turns={[...turns, ...(pendingUser ? [{ role: 'user' as const, content: pendingUser }] : [])]}
                segments={liveSegments}
                streaming={streaming}
                stage={liveStage}
              />
              {streaming && isFollowupRef.current && multiturnMode === 'degraded' && (
                // design §3.3.6 (d)：降级伪多轮透明提示（codex/opencode 或 claude 缺 id）。
                <p className="px-1 text-xs text-muted-foreground">当前模型多轮能力有限，已基于历史继续生成（未完整复用上下文）。</p>
              )}
              {!streaming && liveError && <ErrorBubble error={liveError} onRetry={lastPromptRef.current ? () => send(lastPromptRef.current!) : undefined} />}
            </div>
          )}
          </div>
        </div>

        <div className="shrink-0 border-t bg-background px-4 py-3">
          <div className="mx-auto max-w-3xl">
            {/* 流程重构：创建期不需要插件名称输入框。
                正确流程：对话 → AI 生成代码 → 预览 → 上传时弹命名 Dialog。 */}
            <Composer
              input={input}
              model={model}
              provider={provider}
              providerInfo={providerInfo}
              providers={providers}
              streaming={streaming}
              effort={effort}
              onInputChange={setInput}
              onModelChange={setModel}
              onProviderChange={setProvider}
              onEffortChange={setEffort}
              onCustomModel={() => { setSettingsTab('gateway'); setView('settings'); }}
              onSend={send}
              onStop={stopCurrentSession}
            />
          </div>
        </div>
      </div>

      <aside className={cn(
        'flex h-full shrink-0 flex-col border-l bg-card transition-all duration-200 overflow-hidden',
        // 自适应宽度：小屏全宽，中大屏弹性（min 360 / 中屏 32vw / 大屏 24vw / max 560），替代原固定 420px。
        detailsOpen ? 'w-full md:w-[min(32vw,560px)] xl:w-[min(24vw,560px)] md:min-w-[360px] z-20' : 'w-0',
      )}>
        <div className="flex h-full w-full md:w-[min(32vw,560px)] xl:w-[min(24vw,560px)] md:min-w-[360px] flex-col">
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
        pluginId={pluginId ?? undefined}
      />
      {/* 问题2：历史对话居中 Dialog，内部 ConversationRail 自带 ScrollArea 限高分页。 */}
      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent className="gap-0 p-0 sm:max-w-xl">
          <DialogHeader className="border-b px-4 py-3" {...dragRegionProps}>
            <DialogTitle className="text-base" data-tauri-drag-region>历史对话</DialogTitle>
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
      {/* 平台缺口 Top7：新手任务清单（首次登录弹 Dialog，5 步引导，进度持久化）。
          已全部完成时组件内部 return null，不渲染 Dialog。 */}
      <TaskChecklist session={session} setView={setView} setSettingsTab={setSettingsTab} />

      {/* 流程重构：上传命名 Dialog（用户在上传时给插件命名）。 */}
      <Dialog open={namingOpen} onOpenChange={(o) => { if (!namingLoading) setNamingOpen(o); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>命名并上传插件</DialogTitle>
            <DialogDescription>给插件起个名字，团队成员将通过这个名字找到它。</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <Label htmlFor="plugin-name-input">插件名称</Label>
            <Input
              id="plugin-name-input"
              value={namingValue}
              onChange={(e) => setNamingValue(e.target.value)}
              placeholder="如：我的番茄钟"
              autoFocus
              onKeyDown={(e) => e.key === 'Enter' && !namingLoading && doUpload()}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNamingOpen(false)} disabled={namingLoading}>取消</Button>
            <LoadingButton onClick={doUpload} loading={namingLoading}>上传</LoadingButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
