import type { DraftFile, DraftTurn, LoadedPlugin, PluginDraft } from '@/lib/types';

export const EXAMPLES = [
  '做一个番茄钟插件，可设置 25/45 分钟、暂停继续、完成后提醒',
  '我要一个视频脚本分镜表工具，输入脚本后输出镜头、画面、旁白和标签',
  '创建一个 Markdown 速记插件，左侧编辑右侧实时预览，支持复制导出',
];

export const PROVIDERS = [
  { id: 'claude', label: 'Claude Code', models: ['sonnet', 'opus'] },
  { id: 'codex', label: 'Codex', models: ['default', 'gpt-5.5', 'gpt-5.1-codex', 'gpt-5.1'] },
  { id: 'opencode', label: 'OpenCode', models: ['default', 'qwen-coder'] },
];

export type ProviderId = 'claude' | 'codex' | 'opencode';

export interface CliProbeResult {
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

export interface AssistantSessionRecord {
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

export interface AssistantSessionState {
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

export interface SessionStartedPayload {
  sessionId: string;
  pid?: number;
  record?: AssistantSessionRecord;
}

export interface SessionOutputPayload {
  sessionId: string;
  stream?: 'stdout' | 'stderr';
  text?: string;
}

export interface SessionErrorPayload {
  sessionId: string;
  stream?: string;
  error?: string;
}

export interface SessionExitPayload {
  sessionId: string;
  exitCode?: number | null;
  status?: 'stopped' | 'exited';
  endedAt?: string;
}

export type TranscriptEvent = {
  at?: string;
  event?: string;
  payload?: Record<string, unknown>;
};

export const STATUS_LABEL: Record<string, string> = {
  ready: '可上传',
  partial: '部分结果',
  invalid: '含校验问题',
  generating: '生成中',
  published: '已发布',
};

const LOCAL_DRAFT_ENTRY = 'ui/index.html';

export function safePluginId(input: string) {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return slug || 'local-agent-plugin';
}

export function extractCliText(result: CliProbeResult) {
  return (result.stdoutTail || result.stdout_tail || result.stderrTail || result.stderr_tail || '').trim();
}

export function parseTranscript(raw: string): TranscriptEvent[] {
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

export function transcriptText(events: TranscriptEvent[], stream: 'stdout' | 'stderr') {
  return events
    .filter((event) => event.event === 'output' && event.payload?.stream === stream)
    .map((event) => (typeof event.payload?.text === 'string' ? event.payload.text : ''))
    .join('')
    .trim();
}

export function transcriptDiagnostics(events: TranscriptEvent[]) {
  return events
    .filter((event) => event.event === 'error' || event.event === 'registry-cleanup' || event.event === 'input-rejected' || event.event === 'stopped')
    .map((event) => `${event.event}: ${JSON.stringify(event.payload || {})}`);
}

export function sessionToProbeResult(session: AssistantSessionState): CliProbeResult {
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

export function tailText(input: string, maxChars = 12_000) {
  return input.length > maxChars ? input.slice(-maxChars) : input;
}

export function providerLabel(provider: ProviderId) {
  return PROVIDERS.find((item) => item.id === provider)?.label || provider;
}

export function cliCommand(result: CliProbeResult) {
  return result.commandPreview || result.command_preview || [];
}

export function cliSessionId(result: CliProbeResult) {
  return result.sessionId || result.session_id || '';
}

export function cliTranscriptPath(result: CliProbeResult) {
  return result.transcriptPath || result.transcript_path || '';
}

export function buildLocalDraft(input: { prompt: string; providerLabel: string; model: string; result: CliProbeResult }): PluginDraft {
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

export function normalizeTurns(turns?: DraftTurn[]): DraftTurn[] {
  const out: DraftTurn[] = [];
  for (const turn of turns || []) {
    const last = out[out.length - 1];
    if (last && last.role === turn.role && last.content === turn.content) continue;
    out.push(turn);
  }
  return out;
}

export function parseManifest(files: DraftFile[]) {
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

export function previewSrcDoc(files: DraftFile[]): string {
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

export function recentKey(tenantId: string | null) {
  return `lf:recent-plugins:${tenantId || 'none'}`;
}

export function readRecent(tenantId: string | null): LoadedPlugin[] {
  try {
    const raw = localStorage.getItem(recentKey(tenantId));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writeRecent(tenantId: string | null, plugins: LoadedPlugin[]) {
  try {
    localStorage.setItem(recentKey(tenantId), JSON.stringify(plugins.slice(0, 8)));
  } catch {
    /* localStorage 不可用则忽略 */
  }
}