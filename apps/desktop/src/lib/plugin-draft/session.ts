import type { AssistantOutputStream } from '@/lib/types';
import type { ProviderId } from './providers';

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

// design §3.2.4：多会话字段镜像（对齐 Rust SessionRecord 的 #[serde(default)] 可选字段）。
// 旧 sessions.json 无这些字段时反序列化为 None/undefined，向后兼容不报错。
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
  // 会话展示标题（首启从 transcript 首 input prompt 截断回填，用户重命名后落库）。
  title?: string | null;
  // 草稿最后更新时间（会话栏排序依据，ISO 字符串）。
  draftUpdatedAt?: string | null;
  // 归档标记（会话栏折叠归档区）。
  archived?: boolean | null;
}

// design §3.2.4：会话栏列表项（轻量，不含 turns/draft 正文）。
// tauriInvoke('code_assistant_list_sessions') 直接返回该数组，前端按 draftUpdatedAt ?? startedAt 排序。
export interface ConversationMeta {
  sessionId: string;
  tool: ProviderId;
  model?: string | null;
  title?: string | null;
  status: string;
  startedAt: string;
  transcriptPath?: string;
  commandPreview?: string[];
  draftUpdatedAt?: string | null;
  archived?: boolean | null;
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
  // stream 字段：R3 流式分类——stdout（正文文本，协议解析依赖）/ stderr（诊断）/
  // thought（思考增量，不进 stdout）/ tool（工具调用卡片，含 AskUserQuestion，不进 stdout）。
  stream?: 'stdout' | 'stderr' | 'thought' | 'tool';
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

// design §3.3.3：spawn_reader 捕获到 claude session_id 后 emit 的 payload。
// 前端据此 setCliSessionId + 标记 multiturnMode='native'（claude 真 resume）。
export interface SessionCliIdPayload {
  sessionId: string;
  cliSessionId: string;
}

export type TranscriptEvent = {
  at?: string;
  event?: string;
  payload?: Record<string, unknown>;
};

export interface TurnSegmentInput {
  stream: AssistantOutputStream;
  text: string;
}

export const STATUS_LABEL: Record<string, string> = {
  ready: '可上传',
  partial: '部分结果',
  invalid: '含校验问题',
  generating: '生成中',
  published: '已发布',
  chat: '对话', // 纯对话态（无插件草稿），对话完成后标记，避免一直显示"生成中"。
};

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

// DRAFT-06 清理：transcriptText（旧多轮串接实现）已删除。
// 此前它用 .join('') 拼所有 output（即多轮串轮 bug 行为），仅被 plugin-draft.spec.ts 作为旧行为对照引用。
// 生产代码已统一改用 transcriptTextSinceLastInput（取最后一个 input 之后的 output，一问一答语义）。
// 保留了已知 bug 行为的导出函数易被新代码误用导致多轮串轮回归，故移除。
// 回归对照测试已在 spec 内改写为对 transcriptTextSinceLastInput 的单侧断言 + 注释说明。

// design §3.3.6 / 多会话 bug 修复：只拼接「最后一个 input 事件之后」的 output 事件。
//
// 背景：多轮对话的 transcript 是 append 的（store.rs append_transcript 把每轮 output
// 都追加到同一个 transcripts/{sessionId}.jsonl）。Rust 端在每轮开始时写一条 input 事件
// （code_assistant.rs:328 首轮 tool/model/prompt，:406-413 追问 prompt/kind=followup），
// 所以「最后一个 input 事件」恰好标记本轮的起点。
//
// 旧的 transcriptText 用 .join('') 拼接所有 output，导致第 N 轮 finalizeSession 拿到的
// stdout = 前 N-1 轮输出 + 本轮输出，全部塞进一个 assistant turn（用户实测现象）。
// 本函数通过 lastIndexOf('input') 定位本轮起点，只取其后的 output，保证「一问一答」语义。
//
// 边界：无 input 事件（旧 transcript 或异常）→ 取全部 output（与 transcriptText 等价，向后兼容）；
// input 后无 output（本轮 CLI 尚未产出）→ 返回空串。
export function transcriptTextSinceLastInput(events: TranscriptEvent[], stream: 'stdout' | 'stderr') {
  let lastInputIndex = -1;
  for (let i = 0; i < events.length; i++) {
    if (events[i].event === 'input') lastInputIndex = i;
  }
  // 无 input 事件：退回全量拼接（向后兼容首轮异常 / 旧数据，不丢输出）。
  const start = lastInputIndex === -1 ? 0 : lastInputIndex + 1;
  return events
    .slice(start)
    .filter((event) => event.event === 'output' && event.payload?.stream === stream)
    .map((event) => (typeof event.payload?.text === 'string' ? event.payload.text : ''))
    .join('')
    .trim();
}

export function transcriptSegmentsSinceLastInput(events: TranscriptEvent[]): TurnSegmentInput[] {
  let lastInputIndex = -1;
  for (let i = 0; i < events.length; i++) {
    if (events[i].event === 'input') lastInputIndex = i;
  }
  const start = lastInputIndex === -1 ? 0 : lastInputIndex + 1;
  return compactTurnSegments(
    events
      .slice(start)
      .filter((event) => event.event === 'output')
      .flatMap((event) => {
        const stream = event.payload?.stream;
        const text = event.payload?.text;
        if (!isAssistantOutputStream(stream) || typeof text !== 'string' || !text) return [];
        return [{ stream, text }];
      }),
  );
}

function isAssistantOutputStream(value: unknown): value is AssistantOutputStream {
  return value === 'stdout' || value === 'stderr' || value === 'thought' || value === 'tool';
}

export function compactTurnSegments(segments: TurnSegmentInput[]): TurnSegmentInput[] {
  const out: TurnSegmentInput[] = [];
  for (const segment of segments) {
    const last = out[out.length - 1];
    if (last?.stream === segment.stream) {
      last.text += segment.text;
    } else {
      out.push({ ...segment });
    }
  }
  return out;
}

export function transcriptDiagnostics(events: TranscriptEvent[]) {
  return events
    .filter((event) => event.event === 'error' || event.event === 'registry-cleanup' || event.event === 'input-rejected' || event.event === 'stopped' || event.event === 'multiturn-degraded')
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

// design §6.2：会话展示标题推导（title None 时的懒回填）。
// 优先用 record 已落库的 title；否则从 transcript 首 input 事件取 prompt 截断 24 字（前端中点宽度友好）。
// 仅显示态用途，不强制落库；用户重命名时才 rename_session 持久化。
export function deriveTitle(record: { title?: string | null }, transcriptRaw?: string): string {
  if (record.title && record.title.trim()) return record.title.trim();
  if (transcriptRaw) {
    const events = parseTranscript(transcriptRaw);
    const firstInput = events.find((event) => event.event === 'input');
    const prompt = typeof firstInput?.payload?.prompt === 'string' ? firstInput.payload.prompt : '';
    if (prompt.trim()) {
      const trimmed = prompt.trim().replace(/\s+/g, ' ');
      return trimmed.length > 24 ? `${trimmed.slice(0, 24)}…` : trimmed;
    }
  }
  return '新对话';
}

// 本地启发式秒级生成标题（不调 CLI，瞬时完成）。
// 优先从用户首句提取主题（循环去掉「帮我/请/做一个/创建一个」等连续祈使前缀，更精炼）；
// 若用户输入太短或为闲聊，回退到 assistant 回复首行有意义片段；最终截断到 16 字。
export function summarizeTitleLocally(userText: string, assistantText: string): string {
  const clean = (s: string) => s.trim().replace(/\s+/g, ' ').replace(/["""'。，,.!！?？\n]/g, '');
  const prefixes = ['帮我', '麻烦帮', '麻烦', '请', '我想', '我要', '我想要', '能不能', '可以', '你能', '做一个', '做', '创建一个', '创建', '写一个', '写', '实现一个', '实现', '开发一个', '开发', '制作一个', '制作'];
  // 循环移除连续祈使前缀（"帮我做一个" → "做一个" → ""）。
  let user = clean(userText);
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of prefixes) {
      if (user.startsWith(p)) {
        user = user.slice(p.length).trim();
        changed = true;
      }
    }
  }
  if (user.length >= 5) {
    return user.slice(0, 16);
  }
  // 闲聊类（"你好"/"hi"）：assistant 首句通常太短，取前两段拼接更有意义。
  // 注意：必须在 clean 之前按标点切分（clean 会删标点）。
  if (assistantText.trim()) {
    const segments = assistantText
      .split(/[！!。.\n，,]/)
      .map((s) => s.trim().replace(/["""']/g, ''))
      .filter((s) => s.length >= 2);
    if (segments.length) {
      const first = segments[0];
      const title = first.length <= 4 && segments[1] ? first + segments[1] : first;
      if (title.length >= 2) return title.replace(/\s+/g, ' ').slice(0, 16);
    }
  }
  return clean(userText).slice(0, 16) || '新对话';
}
export function cliCommand(result: CliProbeResult) {
  return result.commandPreview || result.command_preview || [];
}

// 命令预览摘要：保留二进制名与所有 flags，仅把 -p 后的超长 prompt/systemPrompt
// 内容替换为 <prompt…>，避免诊断面板被几 KB 文本占满（与 SessionStatusPanel 同源逻辑）。
export function summarizeCommandPreview(preview: string[]): string {
  if (!preview.length) return '未返回命令预览';
  const out: string[] = [];
  for (let i = 0; i < preview.length; i++) {
    const tok = preview[i];
    if (tok === '-p' || tok === '--print') {
      out.push(tok, '<prompt…>');
      i += 1;
    } else if (tok.length > 80) {
      out.push(`${tok.slice(0, 40)}…${tok.slice(-8)}`);
    } else {
      out.push(tok);
    }
  }
  return out.join(' ');
}

export function cliSessionId(result: CliProbeResult) {
  return result.sessionId || result.session_id || '';
}

export function cliTranscriptPath(result: CliProbeResult) {
  return result.transcriptPath || result.transcript_path || '';
}

// === 结构化输出协议解析（design §3.2.2-3.2.4） ===

