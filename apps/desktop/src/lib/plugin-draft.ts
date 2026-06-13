import { CapabilityKind, PluginManifest, RuntimeType, type CapabilityKind as CapabilityKindType, type PluginCapability } from '@lingfang/contract';
import { classifyBlockInfo, type StructuredBlock } from '@/lib/plugin-creator-protocol';
import type { DraftDiagnostic, DraftFile, DraftTurn, LoadedPlugin, PluginDraft } from '@/lib/types';

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

// === 结构化输出协议解析（design §3.2.2-3.2.4） ===

// 字节预算：与后端 plugin-package.ts:45-47 对齐，产出端前置收敛避免后端必然 400。
const MAX_PLUGIN_FILE_BYTES = 256 * 1024;
const MAX_PLUGIN_TOTAL_BYTES = 2 * 1024 * 1024;

// 合法 capabilities kind 白名单（前端镜像，权威在后端 plugin-package.ts:48-53 ALLOWED_CAPABILITIES）。
// 单一真源是契约层 CapabilityKind，这里用 Set 加速产出端收敛判定。
const FRONTEND_CAPABILITY_KINDS = new Set<CapabilityKindType>(CapabilityKind.options);

// 合法 risk 取值（前端镜像后端 plugin-package.ts CapabilityRisk；契约 plugin.ts:16）。
const FRONTEND_CAPABILITY_RISKS = new Set(['none', 'low', 'medium', 'high']);

// 兜底能力：kind 必须命中白名单（绝不裸 code-assistant）。
// 本地代码助手执行属中等风险，reason 说明产出端兜底语义。
const FALLBACK_CAPABILITY = {
  kind: 'code-assistant.run' as const,
  reason: '本地代码助手执行',
  risk: 'medium' as const,
  requires_admin: false,
};

// 前端版 cleanPath：与后端 plugin-package.ts:61-69 cleanPath 行为对齐，产出端前置收敛。
// 与后端不同：不 throw，返回 discriminated union，把非法 path 记进 diagnostics 而非中断解析（容错目标）。
export function cleanPathFrontend(value: string): { ok: true; value: string } | { ok: false; reason: string } {
  const path = String(value || '').trim().replace(/\\/g, '/');
  if (!path) return { ok: false, reason: '插件文件路径不能为空' };
  if (path.startsWith('/') || path.startsWith('~') || /^[a-zA-Z]:\//.test(path)) {
    return { ok: false, reason: '插件文件路径不能是绝对路径' };
  }
  const segments = path.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    return { ok: false, reason: '插件文件路径不能包含空段或 ..' };
  }
  if (segments.some((segment) => segment.startsWith('.'))) {
    return { ok: false, reason: '插件文件路径不能包含隐藏系统路径' };
  }
  return { ok: true, value: path };
}

// 契约收敛：把任意形态的 capabilities 规范化为合法对象数组。
// 设计要点：合法对象数组（全部 kind 在白名单）→ map 规范化；否则整体兜底 [fallback]。
// 关键回归点：绝不兜底为裸 code-assistant（白名单外，会被后端 400 拒绝）。
export function normalizeCapabilities(parsed: unknown, fallback: PluginCapability = FALLBACK_CAPABILITY): PluginCapability[] {
  if (Array.isArray(parsed) && parsed.length > 0 && parsed.every(
    (c): c is Record<string, unknown> => Boolean(c) && typeof c === 'object' && typeof c.kind === 'string' && FRONTEND_CAPABILITY_KINDS.has(c.kind as CapabilityKindType),
  )) {
    return parsed.map((c) => {
      const risk = typeof c.risk === 'string' && FRONTEND_CAPABILITY_RISKS.has(c.risk) ? c.risk : 'low';
      const base: PluginCapability = {
        kind: c.kind as CapabilityKindType,
        reason: typeof c.reason === 'string' ? c.reason : '',
        risk: risk as PluginCapability['risk'],
        requires_admin: Boolean(c.requires_admin),
      };
      // scope 仅在显式提供时透传（与后端 plugin-package.ts:112 行为一致）。
      return c.scope === undefined ? base : { ...base, scope: c.scope as Record<string, unknown> };
    });
  }
  // 退化形态（字符串数组 / 部分非法 / 空数组 / 非数组）：整体兜底。
  return [fallback];
}

// 合法 runtime_type（前端镜像契约 RuntimeType；后端 plugin-package.ts:81-82 严格校验）。
const FRONTEND_RUNTIME_TYPES = new Set<string>(RuntimeType.options);

// 合法 visibility（前端镜像后端 plugin-package.ts:83-84）。
const FRONTEND_VISIBILITIES = new Set(['private', 'tenant']);

// 收敛枚举字段：合法值原样采用，非法值（含 falsy）退回默认。
// 防止模型产出非法 visibility/runtime_type（如 'public'/'edge'）穿透到后端导致 400。
function normalizeEnum(value: unknown, allowed: Set<string>, fallback: string): string {
  return typeof value === 'string' && allowed.has(value) ? value : fallback;
}

// parseStructuredPackage 的返回结构。
export interface ParsedStructuredPackage {
  manifest: Partial<PluginManifest> | null; // 解析失败为 null
  files: DraftFile[]; // 同 path 后者覆盖
  notes: string; // notes 块拼接
  rawBlocks: StructuredBlock[]; // 原始块（诊断用）
  diagnostics: DraftDiagnostic[]; // schema stage 诊断
  status: 'ready' | 'partial' | 'invalid'; // 总体判定
  manifestJson: string | null; // 序列化的 manifest.json 内容
}

// 从 file 块 info string 提取 path：支持 path="..." / path='...' / 裸 token。
function extractFilePath(info: string): string | undefined {
  const trimmed = info.trim();
  const dbl = trimmed.match(/path\s*=\s*"([^"]*)"/);
  if (dbl) return dbl[1];
  const sgl = trimmed.match(/path\s*=\s*'([^']*)'/);
  if (sgl) return sgl[1];
  // 裸 token：取 file 关键字后的第一个非空白段。
  const token = trimmed.match(/^file\s+(\S+)$/);
  if (token) return token[1];
  return undefined;
}

// 用逐行扫描匹配 fenced code block，比纯正则更可控（围栏嵌套场景下取到下一个未被消费的结束围栏）。
// 处理三类：规范块（```info）、裸块（``` 无 info）、围栏嵌套（块内含 ``` 提前结束 → 剩余兜底）。
function extractFencedBlocks(raw: string): StructuredBlock[] {
  const blocks: StructuredBlock[] = [];
  const lines = raw.split('\n');
  // 字符偏移查表：lineOffsets[k] 为第 k 行在原文中的起始字符偏移（诊断用）。
  // 每行长度 + 1（换行符），与 split('\n') 后还原原文的偏移一致。
  const lineOffsets: number[] = [];
  let acc = 0;
  for (const line of lines) {
    lineOffsets.push(acc);
    acc += line.length + 1;
  }
  let i = 0;
  // 起始围栏：行首 3+ 个反引号（允许前导空白），后跟可选 info string。
  const startRe = /^\s*(`{3,})(.*)$/;
  // 结束围栏：行首 3+ 个反引号，info 为空（CommonMark 规范：结束围栏不能有 info）。
  const endRe = /^\s*(`{3,})\s*$/;
  while (i < lines.length) {
    const startMatch = lines[i].match(startRe);
    if (!startMatch) { i++; continue; }
    const fence = startMatch[1];
    const info = startMatch[2].trim();
    const startLine = i;
    const contentLines: string[] = [];
    let closeLine = -1;
    let j = i + 1;
    // 寻找匹配的结束围栏：反引号数 >= 起始，且行内无 info。
    while (j < lines.length) {
      const endMatch = lines[j].match(endRe);
      if (endMatch && endMatch[1].length >= fence.length) { closeLine = j; break; }
      contentLines.push(lines[j]);
      j++;
    }
    if (closeLine === -1) {
      // 未找到结束围栏：视为截断，内容取到文末（围栏嵌套 / 流被切断）。
      // 标记 truncated，由 parseStructuredPackage 补 schema 诊断（design §3.2.2 步骤1）。
      blocks.push({
        kind: classifyBlockInfo(info),
        info,
        content: contentLines.join('\n'),
        start: lineOffsets[startLine] || 0,
        path: undefined,
        truncated: true,
      });
      break;
    }
    blocks.push({
      kind: classifyBlockInfo(info),
      info,
      content: contentLines.join('\n'),
      start: lineOffsets[startLine] || 0,
      path: undefined,
    });
    i = closeLine + 1;
  }
  return blocks;
}


// unknown 块候选归类：内容特征 → ui/index.html；其余 snippet-N。
// 设计 §3.2.2 步骤5：保证模型只输出裸代码块时也能拿到至少一个文件。
function classifyUnknownBlock(block: StructuredBlock, snippetCounter: { n: number }, hasEntry: boolean): { path: string; language?: string } {
  const lower = block.content.toLowerCase();
  const isHtml =
    /^html/.test(block.info) ||
    lower.includes('<html') ||
    lower.includes('<!doctype') ||
    lower.includes('<body');
  if (isHtml && !hasEntry) {
    return { path: 'ui/index.html', language: 'html' };
  }
  // 其余（含已知语言标识但非 html）按 snippet-N 命名。
  const idx = snippetCounter.n++;
  return { path: `snippet-${idx}` };
}

// 解析模型 stdout 文本为结构化插件包（design §3.2.2）。
// 纯函数：无副作用，确定性，可单测。
export function parseStructuredPackage(rawText: string): ParsedStructuredPackage {
  const diagnostics: DraftDiagnostic[] = [];
  const rawBlocks = extractFencedBlocks(rawText);
  // 截断块诊断（design §3.2.2 步骤1 / §6.3 风险点）：围栏嵌套或流被切断导致提前结束。
  for (const block of rawBlocks) {
    if (block.truncated) {
      diagnostics.push({ stage: 'schema', status: 'fail', message: `围栏可能被截断（块 ${block.kind} 未找到结束围栏）` });
    }
  }

  const notesParts: string[] = [];
  const fileMap = new Map<string, DraftFile>();
  const snippetCounter = { n: 0 };
  let manifestJson: string | null = null;
  let manifestObj: Partial<PluginManifest> | null = null;
  let manifestBlockCount = 0;
  let entryHint: string | undefined;

  // 第一轮：先收集 manifest 以确定 entry（unknown 块候选归类需要知道是否已有 entry）。
  for (const block of rawBlocks) {
    if (block.kind === 'manifest') {
      manifestBlockCount++;
      try {
        const obj = JSON.parse(block.content);
        manifestJson = block.content;
        const parsed = PluginManifest.safeParse(obj);
        if (parsed.success) {
          manifestObj = parsed.data;
          entryHint = parsed.data.entry;
        } else {
          // zod 校验失败：尝试保留可读字段供 buildLocalDraft 兜底补全。
          manifestObj = typeof obj === 'object' && obj ? (obj as Partial<PluginManifest>) : null;
          entryHint = typeof obj?.entry === 'string' ? obj.entry : undefined;
          diagnostics.push({
            stage: 'schema',
            status: 'fail',
            message: `manifest 校验失败：${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`,
          });
        }
      } catch (err) {
        manifestObj = null;
        diagnostics.push({
          stage: 'schema',
          status: 'fail',
          message: `manifest JSON 解析失败：${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }
  if (manifestBlockCount > 1) {
    diagnostics.push({ stage: 'schema', status: 'warn', message: `检测到 ${manifestBlockCount} 个 manifest 块，已采用最后一个` });
  }

  // 第二轮：file / notes / unknown 块。
  for (const block of rawBlocks) {
    if (block.kind === 'notes') {
      notesParts.push(block.content);
      continue;
    }
    if (block.kind === 'file') {
      const rawPath = extractFilePath(block.info);
      if (!rawPath) {
        diagnostics.push({ stage: 'schema', status: 'fail', message: 'file 块缺少 path，已丢弃' });
        continue;
      }
      const cleaned = cleanPathFrontend(rawPath);
      if (!cleaned.ok) {
        diagnostics.push({ stage: 'schema', status: 'fail', message: `文件路径非法（${cleaned.reason}）：${rawPath}` });
        continue;
      }
      fileMap.set(cleaned.value, { path: cleaned.value, content: block.content });
      continue;
    }
    if (block.kind === 'unknown') {
      const hasEntry = entryHint ? fileMap.has(entryHint) : false;
      const { path, language } = classifyUnknownBlock(block, snippetCounter, hasEntry);
      block.language = language;
      block.path = path;
      fileMap.set(path, { path, content: block.content });
    }
  }

  const files = Array.from(fileMap.values());
  const notes = notesParts.join('\n\n').trim();

  // 状态判定（字节预算检查后再最终确定）。
  let status: ParsedStructuredPackage['status'];
  if (!manifestObj) {
    status = 'invalid';
  } else {
    const entry = typeof manifestObj.entry === 'string' ? manifestObj.entry : undefined;
    if (entry && files.some((f) => f.path === entry)) {
      status = 'ready';
    } else {
      status = 'partial';
    }
  }

  // 字节预算检查（design §3.2.2 步骤7）：单文件 256KB / 总量 2MB 超限强制 invalid。
  let totalBytes = 0;
  let overLimit = false;
  for (const file of files) {
    const bytes = new TextEncoder().encode(file.content).length;
    if (bytes > MAX_PLUGIN_FILE_BYTES) {
      overLimit = true;
      diagnostics.push({ stage: 'schema', status: 'fail', message: `单文件超 256KB 限制：${file.path}` });
    }
    totalBytes += bytes;
  }
  if (totalBytes > MAX_PLUGIN_TOTAL_BYTES) {
    overLimit = true;
    diagnostics.push({ stage: 'schema', status: 'fail', message: '插件包总大小超 2MB 限制' });
  }
  if (overLimit) status = 'invalid';

  return {
    manifest: manifestObj,
    files,
    notes,
    rawBlocks,
    diagnostics,
    status,
    manifestJson,
  };
}

// entry 文件缺失时生成兜底预览页（design §3.2.5 / B5）。
// HTML 转义防注入，展示 manifest 名称与 notes 片段。
function escapeHtml(input: string): string {
  return input.replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char] || char));
}

export function buildFallbackEntryHtml(input: { notes?: string; manifestName: string; description?: string }): string {
  const name = escapeHtml(input.manifestName || '本地代码助手插件');
  const desc = escapeHtml(input.description || '');
  const notes = escapeHtml(input.notes || '');
  return `<!doctype html>
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
      <h1>${name}</h1>
      <p>${desc || '本地代码助手未产出入口文件，已生成兜底预览页。'}</p>
      <pre>${notes || '（无说明）'}</pre>
    </section>
  </main>
</body>
</html>`;
}

export function buildLocalDraft(input: { prompt: string; providerLabel: string; model: string; result: CliProbeResult }): PluginDraft {
  const output = extractCliText(input.result);
  const id = `local-${input.result.tool}-${Date.now()}`;
  const pluginId = safePluginId(input.prompt);
  const now = new Date().toISOString();

  // 协议解析（design §3.2.5）：把 CLI stdout 解析为结构化 manifest + 多文件 + notes + 诊断。
  const parsed = parseStructuredPackage(output);
  const parsedManifest = parsed.manifest;

  // CLI 字段优先 + 前端兜底补全（兼容模型少产字段的 partial 场景）。
  // 枚举字段用 normalizeEnum 收敛：非法值（如 'public'/'edge'）退回默认，避免穿透后端 400。
  const manifest = {
    id: parsedManifest?.id || pluginId,
    name: parsedManifest?.name || input.prompt.slice(0, 24) || '本地代码助手插件',
    version: parsedManifest?.version || '0.1.0',
    description: parsedManifest?.description || `由 ${input.providerLabel} 本地 CLI 生成的插件草稿`,
    runtime_type: normalizeEnum(parsedManifest?.runtime_type, FRONTEND_RUNTIME_TYPES, 'client') as 'client' | 'cloud', // 本子任务仅 client|cloud
    entry: parsedManifest?.entry || LOCAL_DRAFT_ENTRY,
    visibility: normalizeEnum(parsedManifest?.visibility, FRONTEND_VISIBILITIES, 'tenant') as 'private' | 'tenant',
    // 契约收敛：彻底消除字符串数组 bug（旧 :198 的 ['code-assistant']）。
    capabilities: normalizeCapabilities(parsedManifest?.capabilities),
  };

  // entry 缺失自动兜底页 + warning（保证模型未产 entry 时仍有可预览文件）。
  let files: DraftFile[] = [...parsed.files];
  const schemaDiagnostics: DraftDiagnostic[] = [...parsed.diagnostics];
  if (!files.find((file) => file.path === manifest.entry)) {
    files = [...files, {
      path: manifest.entry,
      content: buildFallbackEntryHtml({
        notes: parsed.notes,
        manifestName: manifest.name,
        description: manifest.description,
      }),
    }];
    schemaDiagnostics.push({
      stage: 'schema',
      status: 'warn',
      message: `entry ${manifest.entry} 缺失，已生成兜底预览页`,
    });
  }
  // manifest.json 始终以收敛后的合法对象序列化，放在 files 首位。
  files = [{ path: 'manifest.json', content: JSON.stringify(manifest, null, 2) }, ...files];

  // 状态判定：完全失败（无 manifest 且无输出）退回当前行为，否则采用 parse 的 ready/partial。
  const fallbackStatus = input.result.success && output ? 'partial' : 'invalid';
  const status = parsed.status === 'invalid' && !parsedManifest
    ? fallbackStatus
    : parsed.status === 'ready' ? 'ready' : 'partial';

  // schema stage 汇总诊断。
  const schemaStatus: DraftDiagnostic['status'] = parsed.status === 'ready' ? 'pass' : parsed.status === 'partial' ? 'warn' : 'fail';
  const schemaSummary = `结构化解析：${parsed.status}（manifest ${parsedManifest ? '已解析' : '缺失'}，文件 ${parsed.files.length}，notes ${parsed.notes ? '有' : '无'}）`;

  return {
    id,
    status,
    files,
    turns: [
      { role: 'user', content: input.prompt, at: now },
      // assistant 内容优先 notes（模型给用户的自然语言说明），其次 stdout 原文。
      { role: 'assistant', content: parsed.notes || output || '本地 CLI 没有返回可展示内容。', at: now },
    ],
    diagnostics: [
      { stage: 'local-cli', status: input.result.success ? 'pass' : 'fail', message: `${input.providerLabel} ${input.model === 'default' ? '默认模型' : input.model}，session ${cliSessionId(input.result) || '未返回'}` },
      { stage: 'command', status: 'info', message: cliCommand(input.result).join(' ') || '未返回命令预览' },
      { stage: 'transcript', status: cliTranscriptPath(input.result) ? 'info' : 'fail', message: cliTranscriptPath(input.result) || '未返回 transcript 路径' },
      { stage: 'schema', status: schemaStatus, message: schemaSummary },
      ...(input.result.diagnostics || []).map((message) => ({ stage: 'diagnostics', status: 'fail' as const, message })),
      ...schemaDiagnostics,
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
      // 契约收敛：localStorage 读取的历史草稿（含旧字符串数组形态）在此统一收敛为合法对象数组。
      capabilities: normalizeCapabilities(parsed.capabilities),
    };
  } catch {
    // 解析失败：无能力声明，空数组合法（后端接受）。
    return { id: 'generated-plugin', name: '未命名插件', version: '0.1.0', description: '', runtime_type: 'client', entry: 'ui/index.html', visibility: 'tenant', capabilities: [] };
  }
}

export function previewSrcDoc(files: DraftFile[]): string {
  const manifest = parseManifest(files);
  const html = files.find((file) => file.path === manifest.entry)?.content || '<p>无预览入口</p>';
  const shim = `<script>
    window.sdk = {
      invoke: async (cap) => { alert('能力 ' + cap + ' 将由宿主网关提供'); },
      codeAssistant: { run: async () => '（预览态：发布后由本地代码助手执行）' },
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