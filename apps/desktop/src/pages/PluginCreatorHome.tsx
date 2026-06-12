import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  CheckCircle2Icon,
  ChevronRightIcon,
  CloudUploadIcon,
  Code2Icon,
  Loader2Icon,
  PanelRightOpenIcon,
  PlayIcon,
  RefreshCwIcon,
  SendIcon,
  SparklesIcon,
  SquareIcon,
  StoreIcon,
} from 'lucide-react';
import { useApp } from '@/App';
import { api, tauriInvoke, tauriListen, type ApiError } from '@/lib/api';
import type { DraftFile, DraftTurn, LoadedPlugin, PluginDraft } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { LoadingButton } from '@/components/loading-button';
import { Markdown } from '@/components/markdown';

const EXAMPLES = [
  '做一个番茄钟插件，可设置 25/45 分钟、暂停继续、完成后提醒',
  '我要一个视频脚本分镜表工具，输入脚本后输出镜头、画面、旁白和标签',
  '创建一个 Markdown 速记插件，左侧编辑右侧实时预览，支持复制导出',
];

const PROVIDERS = [
  { id: 'claude', label: 'Claude Code', models: ['sonnet', 'opus'] },
  { id: 'codex', label: 'Codex', models: ['default', 'gpt-5.5', 'gpt-5.1-codex', 'gpt-5.1'] },
  { id: 'opencode', label: 'OpenCode', models: ['default', 'qwen-coder'] },
];

type ProviderId = 'claude' | 'codex' | 'opencode';

interface CliProbeResult {
  tool: ProviderId;
  model?: string | null;
  success: boolean;
  command_preview?: string[];
  commandPreview?: string[];
  stdout_tail?: string;
  stdoutTail?: string;
  stderr_tail?: string;
  stderrTail?: string;
  exit_code?: number | null;
  exitCode?: number | null;
  elapsed_ms?: number;
  elapsedMs?: number;
  transcript_path?: string;
  transcriptPath?: string;
  session_id?: string;
  sessionId?: string;
  diagnostics?: string[];
}

interface AssistantSessionRecord {
  sessionId: string;
  tool: ProviderId;
  model?: string | null;
  workspaceDir: string;
  status: string;
  transcriptPath: string;
  commandPreview: string[];
  pid?: number | null;
  startedAt: string;
  endedAt?: string | null;
  exitCode?: number | null;
}

interface AssistantSessionState {
  sessionId: string;
  status: 'starting' | 'running' | 'stopping' | 'stopped' | 'exited' | 'failed';
  provider: ProviderId;
  providerLabel: string;
  model: string;
  commandPreview: string[];
  transcriptPath: string;
  pid?: number;
  exitCode?: number | null;
  startedAt?: string;
  endedAt?: string;
  stdout: string;
  stderr: string;
  diagnostics: string[];
}

interface SessionStartedPayload {
  sessionId: string;
  pid?: number;
  record?: AssistantSessionRecord;
}

interface SessionOutputPayload {
  sessionId: string;
  stream?: 'stdout' | 'stderr';
  text?: string;
}

interface SessionErrorPayload {
  sessionId: string;
  stream?: string;
  error?: string;
}

interface SessionExitPayload {
  sessionId: string;
  exitCode?: number | null;
  status?: 'stopped' | 'exited';
  endedAt?: string;
}

type TranscriptEvent = {
  at?: string;
  event?: string;
  payload?: Record<string, unknown>;
};

const STATUS_LABEL: Record<string, string> = {
  ready: '可上传',
  partial: '部分结果',
  invalid: '含校验问题',
  generating: '生成中',
  published: '已发布',
};

const LOCAL_DRAFT_ENTRY = 'ui/index.html';

function safePluginId(input: string) {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return slug || 'local-agent-plugin';
}

function extractCliText(result: CliProbeResult) {
  return (result.stdoutTail || result.stdout_tail || result.stderrTail || result.stderr_tail || '').trim();
}

function parseTranscript(raw: string): TranscriptEvent[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as TranscriptEvent];
      } catch {
        return [];
      }
    });
}

function transcriptText(events: TranscriptEvent[], stream: 'stdout' | 'stderr') {
  return events
    .filter((event) => event.event === 'output' && event.payload?.stream === stream)
    .map((event) => typeof event.payload?.text === 'string' ? event.payload.text : '')
    .join('')
    .trim();
}

function transcriptDiagnostics(events: TranscriptEvent[]) {
  return events
    .filter((event) => event.event === 'error' || event.event === 'registry-cleanup' || event.event === 'input-rejected' || event.event === 'stopped')
    .map((event) => `${event.event}: ${JSON.stringify(event.payload || {})}`);
}

function sessionToProbeResult(session: AssistantSessionState): CliProbeResult {
  return {
    tool: session.provider,
    model: session.model,
    success: session.status === 'exited' && session.exitCode === 0 && Boolean(session.stdout.trim() || session.stderr.trim()),
    commandPreview: session.commandPreview,
    stdoutTail: session.stdout,
    stderrTail: session.stderr,
    exitCode: session.exitCode,
    transcriptPath: session.transcriptPath,
    sessionId: session.sessionId,
    diagnostics: session.diagnostics,
  };
}

function tailText(input: string, maxChars = 12_000) {
  return input.length > maxChars ? input.slice(-maxChars) : input;
}

function providerLabel(provider: ProviderId) {
  return PROVIDERS.find((item) => item.id === provider)?.label || provider;
}

function cliCommand(result: CliProbeResult) {
  return result.commandPreview || result.command_preview || [];
}

function cliSessionId(result: CliProbeResult) {
  return result.sessionId || result.session_id || '';
}

function cliTranscriptPath(result: CliProbeResult) {
  return result.transcriptPath || result.transcript_path || '';
}

function buildLocalDraft(input: { prompt: string; providerLabel: string; model: string; result: CliProbeResult }): PluginDraft {
  const output = extractCliText(input.result);
  const id = `local-${input.result.tool}-${Date.now()}`;
  const pluginId = safePluginId(input.prompt);
  const manifest = {
    id: pluginId,
    name: input.prompt.slice(0, 24) || '本地代码助手插件',
    version: '0.1.0',
    description: `由 ${input.providerLabel} 本地 CLI 生成的插件草稿`,
    runtime_type: 'client',
    entry: LOCAL_DRAFT_ENTRY,
    visibility: 'tenant',
    capabilities: ['llm.chat'],
  };
  const escapedOutput = output.replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char] || char));
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f8fafc; color: #0f172a; }
    main { max-width: 720px; margin: 0 auto; padding: 32px; }
    section { border: 1px solid #e2e8f0; border-radius: 18px; background: white; padding: 24px; box-shadow: 0 20px 50px rgba(15, 23, 42, 0.08); }
    h1 { margin: 0 0 12px; font-size: 28px; }
    p { line-height: 1.7; color: #475569; }
    pre { white-space: pre-wrap; word-break: break-word; border-radius: 14px; background: #0f172a; color: #e2e8f0; padding: 16px; }
  </style>
</head>
<body>
  <main>
    <section>
      <h1>${manifest.name}</h1>
      <p>${manifest.description}</p>
      <pre>${escapedOutput || '本地 CLI 没有返回可展示内容。'}</pre>
    </section>
  </main>
</body>
</html>`;
  return {
    id,
    status: input.result.success ? 'ready' : (input.result.exitCode === null && output ? 'partial' : 'invalid'),
    files: [
      { path: 'manifest.json', content: JSON.stringify(manifest, null, 2) },
      { path: LOCAL_DRAFT_ENTRY, content: html },
    ],
    turns: [
      { role: 'user', content: input.prompt, at: new Date().toISOString() },
      { role: 'assistant', content: output || '本地 CLI 没有返回可展示内容。', at: new Date().toISOString() },
    ],
    diagnostics: [
      { stage: 'local-cli', status: input.result.success ? 'pass' : 'fail', message: `${input.providerLabel} ${input.model === 'default' ? '默认模型' : input.model}，session ${cliSessionId(input.result) || '未返回'}` },
      { stage: 'command', status: 'info', message: cliCommand(input.result).join(' ') || '未返回命令预览' },
      { stage: 'transcript', status: cliTranscriptPath(input.result) ? 'info' : 'fail', message: cliTranscriptPath(input.result) || '未返回 transcript 路径' },
      ...(input.result.diagnostics || []).map((message) => ({ stage: 'diagnostics', status: 'fail', message })),
    ],
  };
}

function normalizeTurns(turns?: DraftTurn[]): DraftTurn[] {
  const out: DraftTurn[] = [];
  for (const turn of turns || []) {
    const last = out[out.length - 1];
    if (last && last.role === turn.role && last.content === turn.content) continue;
    out.push(turn);
  }
  return out;
}

function parseManifest(files: DraftFile[]) {
  const manifestFile = files.find((file) => file.path === 'manifest.json');
  try {
    const parsed = JSON.parse(manifestFile?.content || '{}');
    return {
      id: parsed.id || parsed.name || 'generated-plugin',
      name: parsed.name || '未命名插件',
      version: parsed.version || '0.1.0',
      description: parsed.description || '',
      runtime_type: parsed.runtime_type || parsed.runtimeType || 'client',
      entry: parsed.entry || 'ui/index.html',
      visibility: parsed.visibility || 'tenant',
      capabilities: Array.isArray(parsed.capabilities) ? parsed.capabilities : [],
    };
  } catch {
    return { id: 'generated-plugin', name: '未命名插件', version: '0.1.0', description: '', runtime_type: 'client', entry: 'ui/index.html', visibility: 'tenant', capabilities: [] };
  }
}

function previewSrcDoc(files: DraftFile[]): string {
  const manifest = parseManifest(files);
  const html = files.find((file) => file.path === manifest.entry)?.content || '<p>无预览入口</p>';
  const shim = `<script>
    window.sdk = {
      invoke: async (cap) => { alert('能力 ' + cap + ' 将由宿主网关提供'); },
      llm: { chat: async () => '（预览态：发布后经平台网关调用 LLM）' },
      ui: { render: (c) => { document.body.insertAdjacentHTML('beforeend', '<pre>' + (typeof c === 'string' ? c : JSON.stringify(c, null, 2)) + '</pre>'); } },
    };
  <\/script>`;
  return shim + html;
}

function recentKey(tenantId: string | null) {
  return `lf:recent-plugins:${tenantId || 'none'}`;
}

function readRecent(tenantId: string | null): LoadedPlugin[] {
  try {
    const raw = localStorage.getItem(recentKey(tenantId));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeRecent(tenantId: string | null, plugins: LoadedPlugin[]) {
  try {
    localStorage.setItem(recentKey(tenantId), JSON.stringify(plugins.slice(0, 8)));
  } catch {
    /* localStorage 不可用则忽略 */
  }
}

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

  useEffect(() => {
    setModel(providerInfo.models[0]);
  }, [provider]);

  useEffect(() => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight });
  }, [turns.length, liveText, pendingUser]);

  useEffect(() => {
    assistantSessionRef.current = assistantSession;
  }, [assistantSession]);

  useEffect(() => {
    if (files.length && !files.find((file) => file.path === activeFile)) setActiveFile(files[0].path);
  }, [files, activeFile]);

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

  useEffect(() => {
    setRecent(readRecent(session.tenantId));
  }, [session.tenantId]);

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
              <div className="mx-auto mb-5 inline-flex items-center gap-2 rounded-full border bg-muted/40 px-3 py-1 text-xs text-muted-foreground">
                AionUI 式单对话 · 本地代码助手 · 右侧详情
              </div>
              <h1 className="text-balance text-4xl font-semibold tracking-tight md:text-5xl">今天想创建什么插件？</h1>
              <p className="mx-auto mt-3 max-w-xl text-sm text-muted-foreground">
                直接自然描述目标。插件创建状态、预览、源码、云端分享和市场审核都在右侧详情里查看。
              </p>
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
            onOpenDetails={() => setDetailsOpen(true)}
          />
            </CardContent>
          </Card>
        </main>
      </div>

      <SheetContent className="flex flex-col p-0" side="right">
        <SheetHeader className="border-b p-4">
          <SheetTitle>插件创建详情</SheetTitle>
          <SheetDescription>查看生成状态、预览、源码、云端分享和最近插件。</SheetDescription>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-4 p-4">
            <SessionStatusPanel session={assistantSession} />
            <CreationStatus status={status} manifest={manifest} files={files} diagnostics={diagnostics} />
            <PreviewPanel files={files} previewKey={previewKey} onRefresh={() => setPreviewKey((key) => key + 1)} />
            <SourcePanel files={files} activeFile={activeFile} activeContent={activeContent} onActiveFileChange={setActiveFile} />
            <CloudSharePanel
              cloudPlugin={cloudPlugin}
              disabled={!files.length || (status !== 'ready' && status !== 'published')}
              submitting={submitting}
              uploading={uploading}
              onRun={() => cloudPlugin && runPlugin(cloudPlugin)}
              onSubmitMarketplace={submitMarketplace}
              onUpload={uploadCloud}
            />
            <RecentPlugins plugins={recent} onRun={runPlugin} />
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

function Composer({
  input,
  model,
  provider,
  providerInfo,
  streaming,
  onInputChange,
  onModelChange,
  onProviderChange,
  onSend,
  onStop,
  onOpenDetails,
}: {
  input: string;
  model: string;
  provider: string;
  providerInfo: { id: string; label: string; models: string[] };
  streaming: boolean;
  onInputChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onProviderChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  onOpenDetails: () => void;
}) {
  return (
    <div className="border-t bg-card/95 p-3 backdrop-blur">
      <div className="rounded-2xl border bg-background p-3 shadow-sm">
        <Textarea
          placeholder="自然描述你想创建的插件，例如：帮我做一个能整理会议纪要并生成行动项的插件。"
          value={input}
          onChange={(event) => onInputChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              onSend();
            }
          }}
          className="max-h-44 min-h-20 resize-none border-0 bg-transparent p-0 shadow-none focus-visible:ring-0"
        />
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <Select disabled={streaming} value={provider} onValueChange={(value) => onProviderChange(value || PROVIDERS[0].id)}>
              <SelectTrigger className="h-8 w-[150px]"><SelectValue>{providerInfo.label}</SelectValue></SelectTrigger>
              <SelectContent>{PROVIDERS.map((item) => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectContent>
            </Select>
            <Select disabled={streaming} value={model} onValueChange={(value) => onModelChange(value || providerInfo.models[0])}>
              <SelectTrigger className="h-8 w-[150px]"><SelectValue>{model === 'default' ? '默认模型' : model}</SelectValue></SelectTrigger>
              <SelectContent>{providerInfo.models.map((item) => <SelectItem key={item} value={item}>{item === 'default' ? '默认模型' : item}</SelectItem>)}</SelectContent>
            </Select>
            <Button variant="ghost" size="sm" onClick={onOpenDetails}>
              <PanelRightOpenIcon className="size-4" /> 查看详情
            </Button>
          </div>
          {streaming ? (
            <Button variant="destructive" onClick={onStop}>
              <SquareIcon className="size-4" />
              停止
            </Button>
          ) : (
            <Button onClick={onSend} disabled={!input.trim()}>
              <SendIcon className="size-4" />
              发送
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function SessionStatusPanel({ session }: { session: AssistantSessionState | null }) {
  if (!session) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">长任务</CardTitle>
          <CardDescription>发送需求后显示本地代码助手的运行状态。</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  const statusLabel: Record<AssistantSessionState['status'], string> = {
    starting: '启动中',
    running: '运行中',
    stopping: '停止中',
    stopped: '已停止',
    exited: '已结束',
    failed: '异常',
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">长任务</CardTitle>
        <CardDescription>{session.providerLabel} · {session.model === 'default' ? '默认模型' : session.model}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="grid grid-cols-2 gap-2">
          <Info label="状态" value={statusLabel[session.status] || session.status} />
          <Info label="退出码" value={session.exitCode === undefined ? '运行中' : session.exitCode === null ? '无' : String(session.exitCode)} />
          <Info label="PID" value={session.pid ? String(session.pid) : '未返回'} />
          <Info label="Transcript" value={session.transcriptPath || '未返回'} />
        </div>
        <div className="space-y-1">
          <div className="font-medium">Session</div>
          <p className="break-all rounded-md bg-muted p-2 text-xs text-muted-foreground">{session.sessionId}</p>
        </div>
        <div className="space-y-1">
          <div className="font-medium">命令</div>
          <p className="break-all rounded-md bg-muted p-2 text-xs text-muted-foreground">{session.commandPreview.join(' ') || '未返回命令预览'}</p>
        </div>
        {(session.stdout || session.stderr) && (
          <div className="space-y-2">
            {session.stdout && <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 text-xs">{session.stdout}</pre>}
            {session.stderr && <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">{session.stderr}</pre>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CreationStatus({ status, manifest, files, diagnostics }: { status?: string; manifest: ReturnType<typeof parseManifest>; files: DraftFile[]; diagnostics: { stage: string; status: string; message: string }[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">创建状态</CardTitle>
        <CardDescription>{files.length ? `${manifest.name} v${manifest.version}` : '还没有插件草稿'}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-2 text-sm">
          <Info label="状态" value={status ? STATUS_LABEL[status] || status : '未开始'} />
          <Info label="文件" value={`${files.length} 个`} />
          <Info label="入口" value={manifest.entry} />
          <Info label="运行时" value={manifest.runtime_type} />
        </div>
        <div className="space-y-1 text-sm">
          <div className="flex items-center gap-2 font-medium"><CheckCircle2Icon className="size-4 text-primary" />诊断</div>
          {diagnostics.length ? diagnostics.map((item, index) => (
            <p key={index} className={item.status === 'pass' ? 'text-emerald-600' : 'text-destructive'}>[{item.stage}] {item.status} — {item.message}</p>
          )) : <p className="text-muted-foreground">暂无诊断。</p>}
        </div>
      </CardContent>
    </Card>
  );
}

function PreviewPanel({ files, previewKey, onRefresh }: { files: DraftFile[]; previewKey: number; onRefresh: () => void }) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-base">预览</CardTitle>
          <CardDescription>插件 iframe 预览。</CardDescription>
        </div>
        <Button variant="ghost" size="icon-sm" disabled={!files.length} onClick={onRefresh}><RefreshCwIcon className="size-4" /></Button>
      </CardHeader>
      <CardContent>
        {files.length ? (
          <iframe key={previewKey} title="plugin-preview" sandbox="allow-scripts" srcDoc={previewSrcDoc(files)} className="h-[360px] w-full rounded-lg border bg-white" />
        ) : (
          <div className="flex h-48 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">生成插件后显示预览。</div>
        )}
      </CardContent>
    </Card>
  );
}

function SourcePanel({ files, activeFile, activeContent, onActiveFileChange }: { files: DraftFile[]; activeFile: string; activeContent: string; onActiveFileChange: (value: string) => void }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><Code2Icon className="size-4" />源码</CardTitle>
      </CardHeader>
      <CardContent>
        {files.length ? (
          <>
            <Tabs value={activeFile} onValueChange={onActiveFileChange}>
              <TabsList className="max-w-full flex-wrap">{files.map((file) => <TabsTrigger key={file.path} value={file.path}>{file.path}</TabsTrigger>)}</TabsList>
            </Tabs>
            <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs">{activeContent}</pre>
          </>
        ) : <p className="text-sm text-muted-foreground">暂无源码。</p>}
      </CardContent>
    </Card>
  );
}

function CloudSharePanel({
  cloudPlugin,
  disabled,
  submitting,
  uploading,
  onRun,
  onSubmitMarketplace,
  onUpload,
}: {
  cloudPlugin: LoadedPlugin | null;
  disabled: boolean;
  submitting: boolean;
  uploading: boolean;
  onRun: () => void;
  onSubmitMarketplace: () => void;
  onUpload: () => void;
}) {
  const reviewStatus = cloudPlugin?.reviewStatus;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><CloudUploadIcon className="size-4" />云端分享</CardTitle>
        <CardDescription>团队共享和公共市场审核。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <LoadingButton className="w-full" loading={uploading} disabled={disabled} onClick={onUpload}>上传到团队共享</LoadingButton>
        {cloudPlugin ? (
          <div className="rounded-lg border bg-muted/40 p-3 text-sm">
            <div className="flex items-center justify-between gap-2"><span className="font-medium">{cloudPlugin.name}</span><Badge variant="secondary">{reviewStatus || 'DRAFT'}</Badge></div>
            <p className="mt-1 text-xs text-muted-foreground">ID：{cloudPlugin.id}</p>
            {cloudPlugin.reviewReason && <p className="mt-1 text-xs text-destructive">驳回原因：{cloudPlugin.reviewReason}</p>}
          </div>
        ) : <p className="text-sm text-muted-foreground">上传成功后，团队成员可在插件页运行。</p>}
        <div className="grid grid-cols-2 gap-2">
          <Button variant="outline" disabled={!cloudPlugin} onClick={onRun}><PlayIcon className="size-4" />运行</Button>
          <LoadingButton variant="outline" loading={submitting} disabled={!cloudPlugin || reviewStatus === 'PENDING' || reviewStatus === 'APPROVED'} onClick={onSubmitMarketplace}><StoreIcon className="size-4" />提交市场</LoadingButton>
        </div>
      </CardContent>
    </Card>
  );
}

function RecentPlugins({ plugins, onRun }: { plugins: LoadedPlugin[]; onRun: (plugin: LoadedPlugin) => void }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">最近插件</CardTitle>
        <CardDescription>最近创建、上传和运行的插件。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {plugins.length ? plugins.map((plugin) => (
          <button key={plugin.id} className="flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left transition hover:bg-muted/60" onClick={() => onRun(plugin)}>
            <span className="min-w-0"><span className="block truncate text-sm font-medium">{plugin.name}</span><span className="block truncate text-xs text-muted-foreground">{plugin.description || plugin.id}</span></span>
            <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
          </button>
        )) : <p className="text-sm text-muted-foreground">暂无最近插件。</p>}
      </CardContent>
    </Card>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border bg-muted/30 p-2"><div className="text-xs text-muted-foreground">{label}</div><div className="truncate font-medium">{value}</div></div>;
}

function LiveProcess({ stage, text, reasoning }: { stage: string; text: string; reasoning: string }) {
  return (
    <div className="max-w-[82%] self-start rounded-2xl border bg-muted/60 px-4 py-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-foreground/80"><Loader2Icon className="size-3.5 animate-spin text-primary" />{stage || '生成中…'}</div>
      {reasoning && <pre className="mb-2 max-h-32 overflow-auto whitespace-pre-wrap border-l-2 border-primary/30 pl-2 text-xs text-muted-foreground">{reasoning}</pre>}
      {text ? <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">{text}</pre> : <span className="text-xs text-muted-foreground">等待模型输出…</span>}
    </div>
  );
}

function Bubble({ role, content, error }: { role: 'user' | 'assistant'; content: string; error?: boolean }) {
  const isUser = role === 'user';
  return (
    <div className={cn('max-w-[82%] rounded-2xl px-4 py-3 text-sm break-words', isUser ? 'self-end bg-primary text-primary-foreground whitespace-pre-wrap' : 'self-start bg-muted', error && 'whitespace-pre-wrap border border-destructive/30 bg-destructive/5 text-destructive')}>
      <span className="mb-1 block text-[11px] opacity-70">{isUser ? '你' : 'AI'}</span>
      {error ? <div className="max-h-72 overflow-auto">{content}</div> : isUser ? content : <Markdown>{content}</Markdown>}
    </div>
  );
}