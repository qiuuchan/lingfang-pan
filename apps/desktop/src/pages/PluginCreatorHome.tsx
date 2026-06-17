import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useApp } from '@/App';
import { api, tauriInvoke, tauriListen } from '@/lib/api';
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
import { toCreatorError, type CreatorError } from '@/lib/creator-error';
import {
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
  resolveSendModel,
  sessionToProbeResult,
  tailText,
  transcriptDiagnostics,
  transcriptSegmentsSinceLastInput,
  transcriptTextSinceLastInput,
  withLastAssistantSegments,
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
import { useEnvReadiness } from '@/lib/env-readiness';
import { PluginCreatorLayout } from '@/components/creator/PluginCreatorLayout';
import { UploadNamingDialog } from '@/components/creator/UploadNamingDialog';
import { buildCliConfig, promptWithAttachedPlugins } from '@/lib/plugin-creator/session-helpers';
import { canConvertConversationToDraft, lastTurnContent } from '@/lib/plugin-creator/turns';
import { useCurrentPluginStatus, useLatestRef, useMentionablePlugins, usePluginUpload, useProviderCatalog, useStickyChatScroll } from './plugin-creator/hooks';
// 组C：插件名用户命名（PRD 需求 1）+ 动态状态从文件系统扫描（PRD 需求 2）。
import { safePluginId } from '@/lib/plugin-draft';

export function PluginCreatorHome() {
  const { currentDraft, setCurrentDraft, session, setRunningPlugin, setView, setSettingsTab, view, modelConfigVersion, pendingAutoFixPrompt, setPendingAutoFixPrompt } = useApp();
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
  const { provider, setProvider, model, setModel, providers, providerInfo, hasAvailableCliRef } = useProviderCatalog(modelConfigVersion);
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
  const assistantSessionRef = useLatestRef(assistantSession);
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
  // 配套 askAnswering state（驱动 AssistantChat 问题选项 disabled 态）。
  const askAnsweringRef = useRef(false);
  const [askAnswering, setAskAnswering] = useState(false);
  // design §3.2.4：多会话 store。metas 由 list_sessions 一次拉取；activeId 决定当前渲染的会话与草稿。
  const [metas, setMetas] = useState<ConversationMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeIdRef = useLatestRef(activeId);
  // 多轮运行态（design §3.3.6 (a)）：multiturnMode 标记当前会话续接能力。
  // native=claude 已捕获 session id（Rust 已回写 SessionRecord.cli_session_id 并走 --resume）；
  // degraded=codex/opencode 或 claude 未捕获 id（历史摘要伪多轮）。
  // cli_session_id 的真值在 Rust SessionRecord，前端只需 mode 信号驱动 UI 文案。
  const [multiturnMode, setMultiturnMode] = useState<'native' | 'degraded' | null>(null);
  const [activeFile, setActiveFile] = useState('');
  const [previewKey, setPreviewKey] = useState(0);
  // B 聊天引用插件：@触发选中的插件列表（id + name + manifest 摘要），send 时拼进 prompt 让 AI 参考。
  const [attachedPlugins, setAttachedPlugins] = useState<Array<{ id: string; name: string; summary: string }>>([]);
  const mentionablePlugins = useMentionablePlugins();
  // 最近插件只写 localStorage（供「插件」页读取），创建页不再展示，故无 state。
  // 修复：finalizeSession 在 exit listener（useEffect 闭包）里调用，捕获的 currentDraft 是注册时的旧值，
  // 导致追问时读到 null → 走 makeConversationDraft 只产本轮 turn，老对话丢失。用 ref 跟踪最新值。
  const currentDraftRef = useLatestRef(currentDraft);

  const turns = normalizeTurns(currentDraft?.turns);
  const files = currentDraft?.files || [];
  const pluginStatus = useCurrentPluginStatus(pluginId, streaming, files.length);
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
  const {
    uploading,
    submitting,
    cloudPlugin,
    setCloudPlugin,
    namingOpen,
    namingValue,
    namingPriceYuan,
    namingLoading,
    setNamingOpen,
    setNamingValue,
    setNamingPriceYuan,
    uploadCloud,
    doUpload,
    submitMarketplace,
    runPlugin,
  } = usePluginUpload({
    files,
    manifest,
    tenantId: session.tenantId,
    pluginIdRef,
    setPluginId,
    setRunningPlugin,
    setView,
    setLiveError,
  });
  const { chatRef, handleChatScroll } = useStickyChatScroll([turns.length, liveSegments, pendingUser]);
  // 一键修复：从 Plugins 页跳来时 pendingAutoFixPrompt 非空 → 填 input 并自动 send 给 AI 修。
  // 用完即清（null），避免重复触发。等 currentDraft 就绪（落盘完成后）再 send。
  useEffect(() => {
    if (pendingAutoFixPrompt && currentDraft?.plugin_id) {
      const prompt = pendingAutoFixPrompt;
      setPendingAutoFixPrompt(null);
      setInput(prompt);
      void send(prompt);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAutoFixPrompt, currentDraft?.plugin_id]);
  // CREATOR-11 修复：listener effect 此前依赖 [provider, model]，会被 list_tools 异步覆盖 providers
  // 后触发的 model 变更重新挂载。重挂窗口内到达的 exit 事件丢失 → finalizeSession 永不执行、streaming 永久 true。
  // 用 ref 读取 provider/model，让 listener 只挂载一次（依赖稳定量 tenantId）。
  const providerRef = useLatestRef(provider);
  const modelRef = useLatestRef(model);
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
      const turnSegments = transcriptSegmentsSinceLastInput(events);
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
        nextDraft = withLastAssistantSegments(nextDraft, turnSegments);
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
        nextDraft = withLastAssistantSegments(nextDraft, turnSegments);
        setCurrentDraft(nextDraft);
        setDetailsOpen(true);
      } else {
        // 纯对话态（AC1）：仅累积 turn，files 保持空，status='generating'，绝不判 invalid。
        const assistantText = finalSession.stdout || finalSession.stderr || '代码助手没有返回可展示内容。';
        if (isFollowup && prevDraft) {
          nextDraft = mergeConversationTurn(prevDraft, promptText, assistantText);
        } else {
          nextDraft = makeConversationDraft(promptText, assistantText, turnSegments);
        }
        nextDraft = withLastAssistantSegments(nextDraft, turnSegments);
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
    const rawText = (overrideText ?? input).trim();
    if (!rawText || streaming) return;
    // 修复 H5：后端已确认无可用 CLI 时拦截发送，避免发起注定失败的 start_session。
    // null 表示尚未拉取（不阻断，与原行为一致）；false 表示确认无可用 CLI。
    if (hasAvailableCliRef.current === false) {
      toast.error('当前无可用 CLI，请先在设置中安装 Claude / Codex / OpenCode');
      return;
    }
    // B 聊天引用：attachedPlugins 非空时把 manifest 摘要拼进 prompt 前，让 AI 参考被引用插件。
    // 最多 5 个（防 prompt 过长）；拼完清空引用（每轮独立，不跨轮累积）。
    const text = promptWithAttachedPlugins(rawText, attachedPlugins);
    if (attachedPlugins.length > 0) setAttachedPlugins([]);
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
    // 期间 AssistantChat 的 option 按钮 disabled（读 askAnsweringRef 经 answered prop 传入）。
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
      const turnSegments = transcriptSegmentsSinceLastInput(events);
      const base = assistantSessionRef.current || assistantSession;
      // CREATOR-06：与 finalizeSession 一致——结构化解析依赖完整本轮 stdout（transcriptTextSinceLastInput
      // 已切本轮，不会跨轮累积），不受 tailText(12000) 截断影响。
      const fullStdout = stdout || base?.stdout || '';
      const fullStderr = stderr || base?.stderr || '';
      // 修复 CREATOR-12：promptText 回退此前取首个 user turn（turns.find），多轮下应取最后一个 user turn，
      // 与 transcriptTextSinceLastInput（取最后一个 input 之后）的「最近一轮」语义对齐。
      // 否则恢复历史纯对话会话后点「转为草稿」会把首轮 prompt 当本轮 user turn 追加（归因错误 + 重复 user turn）。
      const lastUserTurn = lastTurnContent(turns, 'user');
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
      const draftBase = (currentDraft && currentDraft.turns.length > 0)
        ? mergeFollowupDraft(currentDraft, probeResult, promptText)
        : buildLocalDraft({
            prompt: promptText,
            providerLabel: rebuilt.providerLabel,
            model: rebuilt.model,
            result: probeResult,
          });
      const draft = withLastAssistantSegments(draftBase, turnSegments);
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
  }

  const showConvertAction = canConvertConversationToDraft({ activeId, hasDraft, streaming, turns });

  return (
    <>
      <PluginCreatorLayout
        chatRef={chatRef}
        activeConversationTitle={activeConversationTitle}
        pluginStatus={pluginStatus}
        status={status}
        showConvertAction={showConvertAction}
        hasDraft={hasDraft}
        envReadiness={envReadiness}
        hasConversation={hasConversation}
        turns={turns}
        pendingUser={pendingUser}
        liveSegments={liveSegments}
        streaming={streaming}
        liveStage={liveStage}
        liveError={liveError}
        askAnswering={askAnswering}
        multiturnMode={multiturnMode}
        isFollowup={isFollowupRef.current}
        input={input}
        model={model}
        provider={provider}
        providerInfo={providerInfo}
        providers={providers}
        effort={effort}
        attachedPlugins={attachedPlugins}
        mentionablePlugins={mentionablePlugins}
        detailsOpen={detailsOpen}
        previewOpen={previewOpen}
        historyOpen={historyOpen}
        files={files}
        activeFile={activeFile}
        activeContent={activeContent}
        previewKey={previewKey}
        pluginId={pluginId ?? undefined}
        assistantSession={assistantSession}
        diagnostics={diagnostics}
        cloudPlugin={cloudPlugin}
        uploading={uploading}
        submitting={submitting}
        metas={metas}
        activeId={activeId}
        session={session}
        onChatScroll={handleChatScroll}
        onInputChange={setInput}
        onNewDraft={() => { newDraft(); setHistoryOpen(false); }}
        onHistoryOpenChange={setHistoryOpen}
        onForceConvert={() => { void forceConvertToDraft(); }}
        onPreviewOpenChange={setPreviewOpen}
        onDetailsOpenChange={setDetailsOpen}
        onSettingsNavigate={(tab, nextView) => { setSettingsTab(tab); setView(nextView); }}
        onAskUserAnswer={handleAskUserAnswer}
        onRetry={lastPromptRef.current ? () => send(lastPromptRef.current!) : undefined}
        onAttach={(p) => setAttachedPlugins((prev) => (prev.some((x) => x.id === p.id) ? prev : [...prev, p]))}
        onDetach={(id) => setAttachedPlugins((prev) => prev.filter((x) => x.id !== id))}
        onModelChange={setModel}
        onProviderChange={setProvider}
        onEffortChange={setEffort}
        onCustomModel={() => { setSettingsTab('gateway'); setView('settings'); }}
        onSend={send}
        onStop={stopCurrentSession}
        onUpload={uploadCloud}
        onSubmitMarketplace={submitMarketplace}
        onRunPlugin={() => cloudPlugin && runPlugin(cloudPlugin)}
        onActiveFileChange={setActiveFile}
        onRefreshPreview={() => setPreviewKey((key) => key + 1)}
        onSelectConversation={(id) => { void selectConversation(id); setHistoryOpen(false); }}
        onRenameConversation={handleRenameConversation}
        onDeleteConversation={handleDeleteConversation}
        setView={setView}
        setSettingsTab={setSettingsTab}
      />
      <UploadNamingDialog
        open={namingOpen}
        value={namingValue}
        priceYuan={namingPriceYuan}
        loading={namingLoading}
        onOpenChange={setNamingOpen}
        onValueChange={setNamingValue}
        onPriceYuanChange={setNamingPriceYuan}
        onSubmit={doUpload}
      />
    </>
  );
}
