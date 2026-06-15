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

// R2 思考强度：claude --effort 取值；codex/opencode 无对应参数（忽略）。
// 「不思考」对应 none（关闭思考），medium 为默认推荐档。
export type EffortLevel = 'max' | 'high' | 'medium' | 'low' | 'none';

export const EFFORT_LEVELS: EffortLevel[] = ['max', 'high', 'medium', 'low', 'none'];

export const EFFORT_LABEL: Record<EffortLevel, string> = {
  max: '极致思考',
  high: '深度思考',
  medium: '标准思考',
  low: '轻量思考',
  none: '不思考',
};

// R1 模型名首字母大写：UI 显示层把小写 id（sonnet/opus/haiku/fable…）转为首字母大写。
// 仅做首字符大写、其余保持原样（适配 gpt-5.1-codex 这类带连字符的复合 id 不误伤）。
// default 等占位值原样返回（由调用方另显示「默认模型」）。
export function capitalizeModel(id: string | null | undefined): string {
  if (!id) return '';
  if (id === 'default') return '默认模型';
  const trimmed = id.trim();
  if (!trimmed) return '';
  const first = trimmed.charAt(0);
  const rest = trimmed.slice(1);
  // 仅对 ASCII 字母首字符做 toUpperCase（中文/数字首字符保持原样）。
  return (first >= 'a' && first <= 'z' ? first.toUpperCase() : first) + rest;
}

// R6 自定义模型哨兵：Composer 的 Select「自定义…」项 value。
// 选中后展开 Input 手输任意 model id。send 时须把哨兵视为「未选模型」回退 CLI 默认（与 default 同语义）。
// 双下划线前缀避免与真实模型 id 冲突。
export const CUSTOM_MODEL_SENTINEL = '__custom__';

// R6 发送前模型清理：把占位值（default / 自定义哨兵 / 空白）归一为 undefined，
// 与 Rust adapters clean_model 语义一致（None 或非空且非占位）。
// 父组件 send 时调用，避免把哨兵当真模型传给 Rust 写进配置文件。
export function resolveSendModel(model: string | null | undefined): string | undefined {
  const trimmed = (model ?? '').trim();
  if (!trimmed || trimmed === 'default' || trimmed === CUSTOM_MODEL_SENTINEL) return undefined;
  return trimmed;
}

// === R3/R4 流式分类渲染：工具卡片 / AskUserQuestion 解析 ===
//
// Rust spawn_reader 把 claude stream-json 的工具内容走独立 'tool' 流，每条文本形如：
//   "AskUserQuestion {\"questions\":[...]}"（content_block_start，name 已知）
//   "{\"path\":\"b"（input_json_delta 增量，name 为空，累积 JSON 片段）
// 工具流是「逐片段」的，前端需要：累积同一工具的 input 片段 → JSON.parse → 判定是否 AskUserQuestion。
// 本轮简化：把收到的 tool 片段按「name 头 + input 累积」聚合，AskUserQuestion 单独抽 questions。

// 单个工具卡片视图模型：name + 累积后的 input（字符串原文，渲染时按需 JSON 格式化）。
export interface ToolCardView {
  // 工具名（input_json_delta 增量无 name，聚合时沿用同卡片的已知 name）。
  name: string;
  // 累积的入参 JSON 文本（可能仍是不完整片段，渲染兜底按字符串展示）。
  inputText: string;
}

// AskUserQuestion 单问题模型（对齐 claude AskUserQuestion 工具的 questions[].options[]）。
export interface AskUserOption {
  label: string;
  description?: string;
}
export interface AskUserQuestion {
  question: string;
  header?: string;
  options: AskUserOption[];
}

// 从一段 tool 流文本中解析出 (name, inputJson 片段)。
// 格式约定（spawn_reader 产出）：
//   - content_block_start：有 name 头，形如 "Read {json}" 或裸 "Read"（input 为空时）。
//   - input_json_delta：name 为空，文本为原始 partial_json 片段（可能不以 { 开头，如 ".ts"}" 续片）。
// 判定 name 头的稳健规则：必须形如「标识符 + 至少一个空白 + 余下」才认作 name 头；
// 否则一律视为纯 input 片段（name 为空），避免把 ".ts"}" 这类续片误判为新工具名。
export function splitToolText(text: string): { name: string; jsonPart: string } {
  const trimmed = text.trimStart();
  if (!trimmed) return { name: '', jsonPart: '' };
  // 标识符头（字母/下划线开头）+ 空白 + 余下非空 → 拆 name。
  const headerMatch = trimmed.match(/^([A-Za-z_]\w*)\s+(\S[\s\S]*)$/);
  if (headerMatch) {
    return { name: headerMatch[1], jsonPart: headerMatch[2].trim() };
  }
  // 纯标识符头无余下（content_block_start 的空 input，如裸 "Read"）：仅当整体是单个标识符时认作 name。
  const bareMatch = trimmed.match(/^([A-Za-z_]\w*)$/);
  if (bareMatch) {
    return { name: bareMatch[1], jsonPart: '' };
  }
  // 其余（{json、续片 .ts"} 等）：name 为空，整体当 input 片段。
  return { name: '', jsonPart: trimmed };
}

// 把 tool 流片段数组聚合为工具卡片视图（按到达顺序，input 累积同名/相邻卡片）。
// 聚合策略：遇到带 name 的片段开启新卡片（name 非空）；无 name 的片段 append 到最近一张卡片的 input。
// 首片无 name（极少见）时建一张空名卡片兜底。
export function aggregateToolCards(segments: string[]): ToolCardView[] {
  const cards: ToolCardView[] = [];
  for (const seg of segments) {
    const { name, jsonPart } = splitToolText(seg);
    if (name) {
      cards.push({ name, inputText: jsonPart });
    } else if (cards.length) {
      // 纯 input 增量：拼到最近一张卡片（content_block_start 后跟若干 input_json_delta）。
      cards[cards.length - 1].inputText += jsonPart;
    } else if (jsonPart) {
      // 兜底：无 name 头却有 input（异常形态），建空名卡片承载。
      cards.push({ name: '', inputText: jsonPart });
    }
  }
  return cards;
}

// 从工具卡片列表中提取所有 AskUserQuestion 的 questions（R4 问题卡片数据源）。
// inputText 可能是不完整 JSON：解析失败静默跳过（等后续增量补全后下一帧再解析）。
// 成功解析且含 questions 数组才产出，避免普通工具调用被误判为提问。
//
// 注意（DRAFT-03 / STREAM-01 修复）：本函数返回扁平化的问题数组，长度 = 所有 AskUserQuestion
// 卡片的有效问题总数（单卡多问时 > 卡片数），与输入 cards 的下标不对齐。
// 消费方（StreamingMessage）不应再按下标取值——改用 extractAskUserQuestionsForCard，
// 按卡片就地解析该卡片承载的 questions，消除下标错配与单卡多问丢问的双重缺陷。
export function extractAskUserQuestions(cards: ToolCardView[]): AskUserQuestion[] {
  const out: AskUserQuestion[] = [];
  for (const card of cards) {
    if (card.name !== 'AskUserQuestion') continue;
    if (!card.inputText) continue;
    try {
      const parsed = JSON.parse(card.inputText) as { questions?: unknown };
      if (Array.isArray(parsed.questions)) {
        for (const q of parsed.questions) {
          if (q && typeof q === 'object') {
            const question = typeof (q as { question?: unknown }).question === 'string'
              ? String((q as { question?: string }).question)
              : '';
            const header = typeof (q as { header?: unknown }).header === 'string'
              ? String((q as { header?: string }).header)
              : undefined;
            const rawOptions = (q as { options?: unknown }).options;
            const options: AskUserOption[] = Array.isArray(rawOptions)
              ? rawOptions
                  .map((o) => {
                    if (typeof o === 'string') return { label: o } as AskUserOption;
                    if (o && typeof o === 'object') {
                      const label = (o as { label?: unknown }).label;
                      const description = (o as { description?: unknown }).description;
                      return {
                        label: typeof label === 'string' ? label : String(label ?? ''),
                        description: typeof description === 'string' ? description : undefined,
                      } as AskUserOption;
                    }
                    return null;
                  })
                  .filter((o): o is AskUserOption => Boolean(o && o.label))
              : [];
            // 仅保留有可选项的问题（2-4 项约定，但这里宽松收集，渲染层不强制上限）。
            if (question && options.length) {
              out.push({ question, header, options });
            }
          }
        }
      }
    } catch {
      // input 仍在累积中（片段 JSON），跳过等下一帧。
    }
  }
  return out;
}

// DRAFT-03 / STREAM-01 修复：按单张卡片就地解析其承载的 AskUserQuestion questions。
// 返回值与该卡片 1:1 对齐，不再受其它卡片（如前置的 Read/Write）下标错配影响，
// 且天然支持「单卡多问」（Claude AskUserQuestion 工具 questions 字段官方 1-4 项数组）。
// 卡片非 AskUserQuestion 或解析失败时返回空数组（普通工具渲染由 StreamingMessage 内 card.name 判定兜底）。
export function extractAskUserQuestionsForCard(card: ToolCardView): AskUserQuestion[] {
  if (card.name !== 'AskUserQuestion' || !card.inputText) return [];
  const out: AskUserQuestion[] = [];
  try {
    const parsed = JSON.parse(card.inputText) as { questions?: unknown };
    if (!Array.isArray(parsed.questions)) return [];
    for (const q of parsed.questions) {
      if (!q || typeof q !== 'object') continue;
      const question = typeof (q as { question?: unknown }).question === 'string'
        ? String((q as { question?: string }).question)
        : '';
      const header = typeof (q as { header?: unknown }).header === 'string'
        ? String((q as { header?: string }).header)
        : undefined;
      const rawOptions = (q as { options?: unknown }).options;
      const options: AskUserOption[] = Array.isArray(rawOptions)
        ? rawOptions
            .map((o) => {
              if (typeof o === 'string') return { label: o } as AskUserOption;
              if (o && typeof o === 'object') {
                const label = (o as { label?: unknown }).label;
                const description = (o as { description?: unknown }).description;
                return {
                  label: typeof label === 'string' ? label : String(label ?? ''),
                  description: typeof description === 'string' ? description : undefined,
                } as AskUserOption;
              }
              return null;
            })
            .filter((o): o is AskUserOption => Boolean(o && o.label))
        : [];
      if (question && options.length) {
        out.push({ question, header, options });
      }
    }
  } catch {
    // input 仍在累积中（片段 JSON），跳过等下一帧。
  }
  return out;
}

// 把任意工具卡片的 input 文本安全格式化为可展示字符串：
// 能 JSON.parse 则 pretty print，否则原样返回（增量未闭合场景兜底）。
export function formatToolInput(inputText: string): string {
  const trimmed = inputText.trim();
  if (!trimmed) return '';
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return trimmed;
  }
}

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

export const STATUS_LABEL: Record<string, string> = {
  ready: '可上传',
  partial: '部分结果',
  invalid: '含校验问题',
  generating: '生成中',
  published: '已发布',
  chat: '对话', // 纯对话态（无插件草稿），对话完成后标记，避免一直显示"生成中"。
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

export function providerLabel(provider: ProviderId) {
  return PROVIDERS.find((item) => item.id === provider)?.label || provider;
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

// 收敛枚举字段：合法值原样采用，非法值（含 falsy）退回 fallback；
// DRAFT-04 修复：若 fallback 本身不在白名单（磁盘脏值经 parseManifest 透传为 prevManifest.runtime_type/visibility），
// 退回白名单首个允许值，避免脏值继续传播到新写出的 manifest.json（最终被后端 normalizePluginPackage 400 拒绝）。
function normalizeEnum(value: unknown, allowed: Set<string>, fallback: string): string {
  if (typeof value === 'string' && allowed.has(value)) return value;
  if (allowed.has(fallback)) return fallback;
  // fallback 不在白名单：退回白名单首个允许值（保守，保证产出端永不写出非法枚举）。
  const first = allowed.values().next();
  return first.done ? fallback : first.value;
}

// DRAFT-01 / DRAFT-04 修复：判断 capabilities 源是否「合法非空对象数组」。
// 用于 mergeFollowupDraft / mergeFollowupDraftWithSandbox：仅当 parsed 提供合法 capabilities
// 才覆盖 prev，否则透传 prev（避免追问未重发完整 manifest 时多能力降级为单能力兜底）。
function hasValidCapabilities(value: unknown): boolean {
  return Array.isArray(value)
    && value.length > 0
    && value.every(
      (c): c is Record<string, unknown> => Boolean(c) && typeof c === 'object' && typeof (c as { kind?: unknown }).kind === 'string' && FRONTEND_CAPABILITY_KINDS.has((c as { kind: CapabilityKindType }).kind),
    );
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
    runtime_type: normalizeEnum(parsedManifest?.runtime_type, FRONTEND_RUNTIME_TYPES, 'client') as PluginManifest['runtime_type'],
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

  // 状态判定（DRAFT-02 修复）：
  // - 无 manifest 输出 → fallbackStatus（与 success 联动：success+output→partial，否则 invalid）。
  // - manifest 解析成功 + 字节超限 → 保持 parse 的 invalid（parse 在字节超限时强制设 invalid）。
  //   此前三元把任何非 ready 的 parsed.status（含 invalid）一律折叠为 partial，丢失了 parse 层判定。
  // - 其余（ready/partial）→ 原样采用。
  const fallbackStatus = input.result.success && output ? 'partial' : 'invalid';
  const status = !parsedManifest
    ? fallbackStatus
    : parsed.status === 'ready' ? 'ready' : parsed.status;

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
      // 只保留用户关心的 schema 结果（成功/失败原因）；session/命令/transcript 等工程排障信息
      // 已在「分析」tab 的 SessionStatusPanel 展示，此处不再重复（避免诊断面板对普通用户太工程化）。
      { stage: 'schema', status: schemaStatus, message: schemaSummary },
      ...(input.result.diagnostics || []).map((message) => ({ stage: 'diagnostics', status: 'fail' as const, message })),
      ...schemaDiagnostics,
    ],
  };
}

// === 方案A：从 sandbox 扫描结果构建插件草稿（claude 用 Write 工具写文件到 workspace） ===
//
// 与 buildLocalDraft 的差异：files 直接来自 Rust scan_workspace_files 扫描目录（非 stdout 围栏块解析），
// manifest 从扫描结果里的 manifest.json 内容解析（claude 真实写盘，比强制纯文本围栏块稳定）。
//
// 调用时机：CLI exit 后，finalizeSession 先调 scanWorkspaceFiles，若返回 manifest.json + 文件即走本函数，
// 不再走 stdout 围栏块解析（claude 写了文件就不再产围栏块，stdout 解析会判 invalid）。
//
// 返回值约定：
// - 扫描到 manifest.json 且至少一个文件 → 完整 PluginDraft（status=ready/partial）。
// - 空 sandbox 或无 manifest.json → 返回 null（调用方据回退到对话态 / stdout 围栏块解析）。

export interface SbFile {
  path: string;
  content: string;
}

export function buildDraftFromSandboxFiles(input: {
  prompt: string;
  providerLabel: string;
  model: string;
  result: CliProbeResult;
  files: SbFile[];
}): PluginDraft | null {
  // 无 manifest.json → 无法识别为插件包（claude 未写文件或纯对话），返回 null 让调用方回退。
  const manifestFile = input.files.find((file) => file.path === 'manifest.json');
  if (!manifestFile) return null;

  const id = `local-${input.result.tool}-${Date.now()}`;
  const pluginId = safePluginId(input.prompt);
  const now = new Date().toISOString();

  // 从 manifest.json 内容解析 manifest（claude 写盘的原始 JSON，可能含字段缺失 → 兜底补全）。
  // 复用 parseStructuredPackage 同款兜底策略（枚举 normalizeEnum + capabilities normalizeCapabilities）。
  let parsedManifest: Partial<PluginManifest> | null = null;
  const schemaDiagnostics: DraftDiagnostic[] = [];
  try {
    const obj = JSON.parse(manifestFile.content);
    const zodParsed = PluginManifest.safeParse(obj);
    if (zodParsed.success) {
      parsedManifest = zodParsed.data;
    } else {
      // zod 校验失败：保留可读字段供兜底补全，并补 schema 诊断。
      parsedManifest = typeof obj === 'object' && obj ? (obj as Partial<PluginManifest>) : null;
      schemaDiagnostics.push({
        stage: 'schema',
        status: 'fail',
        message: `manifest 校验失败：${zodParsed.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`,
      });
    }
  } catch (err) {
    schemaDiagnostics.push({
      stage: 'schema',
      status: 'fail',
      message: `manifest JSON 解析失败：${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // CLI 字段优先 + 前端兜底补全（与 buildLocalDraft 同款策略，保证少字段 partial 场景仍可用）。
  const manifest = {
    id: parsedManifest?.id || pluginId,
    name: parsedManifest?.name || input.prompt.slice(0, 24) || '本地代码助手插件',
    version: parsedManifest?.version || '0.1.0',
    description: parsedManifest?.description || `由 ${input.providerLabel} 本地 CLI 生成的插件草稿`,
    runtime_type: normalizeEnum(parsedManifest?.runtime_type, FRONTEND_RUNTIME_TYPES, 'client') as PluginManifest['runtime_type'],
    entry: parsedManifest?.entry || LOCAL_DRAFT_ENTRY,
    visibility: normalizeEnum(parsedManifest?.visibility, FRONTEND_VISIBILITIES, 'tenant') as 'private' | 'tenant',
    capabilities: normalizeCapabilities(parsedManifest?.capabilities),
  };

  // files：扫描结果去掉旧的 manifest.json（claude 写盘的原始 JSON 可能字段不全），
  // 重新塞入收敛后的合法 manifest.json（放首位，与 buildLocalDraft 同款约定）。
  const scanFilesExceptManifest = input.files.filter((file) => file.path !== 'manifest.json');
  let files: DraftFile[] = [...scanFilesExceptManifest];

  // entry 缺失自动兜底页（claude 偶尔只写 manifest.json 漏 entry 文件）。
  // entryMissing 标记原始扫描是否缺失 entry（决定 status：原始缺失则 partial，即使兜底页注入也不判 ready）。
  const entryMissing = !scanFilesExceptManifest.some((file) => file.path === manifest.entry);
  if (entryMissing) {
    files = [...files, {
      path: manifest.entry,
      content: buildFallbackEntryHtml({
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
  files = [{ path: 'manifest.json', content: JSON.stringify(manifest, null, 2) }, ...files];

  // 状态判定：有 manifest 且原始扫描含 entry 文件 → ready；entry 缺失（兜底页注入）或 manifest 解析失败 → partial。
  const status: PluginDraft['status'] = parsedManifest && !entryMissing ? 'ready' : 'partial';

  const schemaStatus: DraftDiagnostic['status'] = status === 'ready' ? 'pass' : 'warn';
  const schemaSummary = `sandbox 扫描：${status}（manifest ${parsedManifest ? '已解析' : '兜底'}，扫描文件 ${input.files.length}）`;

  return {
    id,
    status,
    files,
    turns: [
      { role: 'user', content: input.prompt, at: now },
      // assistant 内容优先用 stdout（claude 写完文件后给用户的自然语言说明），其次固定文案。
      { role: 'assistant', content: extractCliText(input.result) || '本地代码助手已把插件文件写入工作目录。', at: now },
    ],
    diagnostics: [
      // 只保留用户关心的 schema 结果（成功/失败原因）；session/命令/transcript 等工程排障信息
      // 已在「分析」tab 的 SessionStatusPanel 展示，此处不再重复（避免诊断面板对普通用户太工程化）。
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

// === design §3.1.2 / §3.4.1：对话优先 gate 与纯对话态草稿（AC1 核心） ===
//
// 这组纯函数解耦「对话」与「插件创建」：
// - hasStructuredBlocks 探测产出是否含 manifest/file 块（gate，决定是否自动解析为草稿）。
// - makeConversationTurn / mergeConversationTurn 产出「纯对话态」草稿（无 files，仅 turns），
//   使「你好」这类闲聊不再被判 invalid、不再强制弹详情面板。
//
// 纯对话态草稿约定 status='generating'（STATUS_LABEL 已有此键），绝不取 'invalid'
// （否则触发右侧 destructive Badge + 预览 disabled，违背 AC1）。

// 探测产出是否含结构化块（manifest 或 file）。复用 extractFencedBlocks，严格只认协议块：
// 纯文本 / 只有 unknown 代码块（如裸 ```js）→ false；含 manifest 或 file 块 → true。
export function hasStructuredBlocks(rawText: string): boolean {
  const blocks = extractFencedBlocks(rawText);
  return blocks.some((b) => b.kind === 'manifest' || b.kind === 'file');
}

// 生成单个纯对话 turn（user + assistant 一对）。
// 与 makeConversationDraft/mergeConversationTurn 的差异：本函数仅产出 turn 数组，
// 供调用方按需拼装（如 finalizeSession 纯对话态累积）。
export function makeConversationTurn(userPrompt: string, assistantText: string): DraftTurn[] {
  const now = new Date().toISOString();
  return [
    { role: 'user', content: userPrompt, at: now },
    { role: 'assistant', content: assistantText || '本地 CLI 没有返回可展示内容。', at: now },
  ];
}

// 首轮纯对话态草稿：无 files/manifest，仅 turns=[u,a]，status='chat'（已完成对话，非"生成中"）。
export function makeConversationDraft(userPrompt: string, assistantText: string): PluginDraft {
  return {
    id: `conversation-${Date.now()}`,
    status: 'chat',
    files: [],
    turns: makeConversationTurn(userPrompt, assistantText),
    diagnostics: [],
  };
}

// 追问纯对话态：在既有 draft 上累积 turns（normalizeTurns 去重），files 保持空。
// prev.id 保持稳定（同一对话跨轮，不新开草稿）。
export function mergeConversationTurn(prev: PluginDraft, userPrompt: string, assistantText: string): PluginDraft {
  const now = new Date().toISOString();
  return {
    ...prev,
    status: 'chat',
    files: prev.files,
    turns: normalizeTurns([
      ...prev.turns,
      { role: 'user', content: userPrompt, at: now },
      { role: 'assistant', content: assistantText || '本地 CLI 没有返回可展示内容。', at: now },
    ]),
    diagnostics: prev.diagnostics,
  };
}

// design §3.3.6 (e)：追问草稿合并——在既有 draft 上累积 turns，files/manifest 用追问产出（R2 解析）覆盖迭代，
// R2 未产出时兜底保留 prev.files（保证追问即使结构化失败也能累积对话、不丢上轮文件）。
// prev.id 保持稳定（同一插件跨轮迭代，不新开草稿）。
export function mergeFollowupDraft(prev: PluginDraft, result: CliProbeResult, prompt: string): PluginDraft {
  const output = extractCliText(result);
  const now = new Date().toISOString();

  // 追问产出重新解析（R2 parseStructuredPackage 已存在）；失败时 parsed.files 为空，兜底 prev。
  const parsed = parseStructuredPackage(output);
  const parsedManifest = parsed.manifest;

  // manifest 沿用 prev 的 id/name（迭代不换插件），仅用追问产出补全可变字段。
  const prevManifest = parseManifest(prev.files);
  const manifest = {
    id: parsedManifest?.id || prevManifest.id,
    name: parsedManifest?.name || prevManifest.name,
    version: parsedManifest?.version || prevManifest.version,
    description: parsedManifest?.description || prevManifest.description,
    runtime_type: normalizeEnum(parsedManifest?.runtime_type, FRONTEND_RUNTIME_TYPES, prevManifest.runtime_type as string) as PluginManifest['runtime_type'],
    entry: parsedManifest?.entry || prevManifest.entry,
    visibility: normalizeEnum(parsedManifest?.visibility, FRONTEND_VISIBILITIES, prevManifest.visibility as string) as 'private' | 'tenant',
    // 修复 DRAFT-01：此前 capabilities 写成 normalizeCapabilities(parsedManifest?.capabilities)，
    // 不参考 prevManifest.capabilities。normalizeCapabilities 在收到 undefined/[]/非法数组时一律兜底为
    // [FALLBACK_CAPABILITY]（单 code-assistant.run）。追问只产 file 块无 manifest 块（codex/opencode 伪多轮常见）
    // 时 prevManifest.capabilities 被整体丢弃，多能力插件静默降级为单能力。
    // 与 entry/runtime_type/visibility 同款语义：parsed 合法非空才覆盖，否则透传 prev。
    capabilities: hasValidCapabilities(parsedManifest?.capabilities)
      ? normalizeCapabilities(parsedManifest?.capabilities)
      : prevManifest.capabilities,
  };

  // files：追问产出非空则覆盖（R2 迭代），否则保留 prev.files（兜底，design §3.3.6 风险点 RISK8）。
  let files: DraftFile[];
  const schemaDiagnostics: DraftDiagnostic[] = [...parsed.diagnostics];
  if (parsed.files.length > 0) {
    files = [...parsed.files];
    if (!files.find((file) => file.path === manifest.entry)) {
      files = [...files, {
        path: manifest.entry,
        content: buildFallbackEntryHtml({
          notes: parsed.notes,
          manifestName: manifest.name,
          description: manifest.description,
        }),
      }];
      schemaDiagnostics.push({ stage: 'schema', status: 'warn', message: `entry ${manifest.entry} 缺失，已生成兜底预览页` });
    }
  } else {
    // R2 未产出结构化文件：保留上轮文件，标记 partial。
    files = prev.files.filter((file) => file.path !== 'manifest.json');
  }
  // manifest.json 始终以收敛后的合法对象序列化，放 files 首位。
  files = [{ path: 'manifest.json', content: JSON.stringify(manifest, null, 2) }, ...files];

  // 状态：追问成功（有结构化产出或 success）→ ready/partial；完全无输出 → partial（保留可用态，不判 invalid）。
  // DRAFT-05 修复：此前三元 (result.success || output ? 'partial' : 'partial') 两支同值（死分支）。
  // 简化为单一 'partial'；若未来需把「完全无输出」改为 invalid，再展开为独立分支并补 spec。
  const status: PluginDraft['status'] = parsed.status === 'ready' ? 'ready' : 'partial';

  const schemaStatus: DraftDiagnostic['status'] = parsed.status === 'ready' ? 'pass' : parsed.status === 'partial' ? 'warn' : 'fail';
  const schemaSummary = `追问解析：${parsed.status}（manifest ${parsedManifest ? '已解析' : '缺失'}，文件 ${parsed.files.length}，notes ${parsed.notes ? '有' : '无'}）`;

  return {
    ...prev,
    status,
    files,
    turns: normalizeTurns([
      ...prev.turns,
      { role: 'user', content: prompt, at: now },
      { role: 'assistant', content: parsed.notes || output || '本地 CLI 没有返回可展示内容。', at: now },
    ]),
    diagnostics: [
      ...prev.diagnostics,
      { stage: 'local-cli', status: result.success ? 'pass' : 'fail', message: `追问 ${cliSessionId(result) || '未返回 session'}` },
      { stage: 'schema', status: schemaStatus, message: schemaSummary },
      ...(result.diagnostics || []).map((message) => ({ stage: 'diagnostics', status: 'fail' as const, message })),
      ...schemaDiagnostics,
    ],
  };
}

// 方案A 追问合并：与 mergeFollowupDraft 同款语义，但 files 数据源改为 sandbox 扫描结果（非 stdout 围栏块）。
// 调用时机：追问 CLI exit 后，finalizeSession 先调 scanWorkspaceFiles；返回 manifest.json 即走本函数，
// 否则回退到 mergeFollowupDraft（stdout 围栏块解析）或对话态。
// prev.id 保持稳定（同一插件跨轮迭代，不新开草稿）。
export function mergeFollowupDraftWithSandbox(prev: PluginDraft, result: CliProbeResult, prompt: string, sbFiles: SbFile[]): PluginDraft {
  const output = extractCliText(result);
  const now = new Date().toISOString();

  // 从 sandbox 扫描的 manifest.json 解析 manifest（claude 真实写盘）。
  const manifestFile = sbFiles.find((file) => file.path === 'manifest.json');
  let parsedManifest: Partial<PluginManifest> | null = null;
  if (manifestFile) {
    try {
      const obj = JSON.parse(manifestFile.content);
      parsedManifest = typeof obj === 'object' && obj ? (obj as Partial<PluginManifest>) : null;
    } catch {
      parsedManifest = null;
    }
  }

  // manifest 沿用 prev 的 id/name（迭代不换插件），仅用追问产出补全可变字段。
  const prevManifest = parseManifest(prev.files);
  const manifest = {
    id: parsedManifest?.id || prevManifest.id,
    name: parsedManifest?.name || prevManifest.name,
    version: parsedManifest?.version || prevManifest.version,
    description: parsedManifest?.description || prevManifest.description,
    runtime_type: normalizeEnum(parsedManifest?.runtime_type, FRONTEND_RUNTIME_TYPES, prevManifest.runtime_type as string) as PluginManifest['runtime_type'],
    entry: parsedManifest?.entry || prevManifest.entry,
    visibility: normalizeEnum(parsedManifest?.visibility, FRONTEND_VISIBILITIES, prevManifest.visibility as string) as 'private' | 'tenant',
    // 修复 DRAFT-01：与 mergeFollowupDraft 同款修复——parsed 合法非空才覆盖，否则透传 prev，
    // 避免追问未重发完整 manifest 时 prevManifest.capabilities 被整体丢弃（多能力插件降级为单能力）。
    capabilities: hasValidCapabilities(parsedManifest?.capabilities)
      ? normalizeCapabilities(parsedManifest?.capabilities)
      : prevManifest.capabilities,
  };

  // files：sandbox 扫描结果非空则覆盖（迭代），否则保留 prev.files（兜底，追问未改文件时维持上轮）。
  const scanFilesExceptManifest = sbFiles.filter((file) => file.path !== 'manifest.json');
  let files: DraftFile[];
  let status: PluginDraft['status'];
  const schemaDiagnostics: DraftDiagnostic[] = [];
  if (scanFilesExceptManifest.length > 0) {
    files = [...scanFilesExceptManifest];
    // 原始扫描是否含 entry（决定 ready/partial，兜底页注入不算）。
    const entryMissing = !scanFilesExceptManifest.some((file) => file.path === manifest.entry);
    if (entryMissing) {
      files = [...files, {
        path: manifest.entry,
        content: buildFallbackEntryHtml({
          manifestName: manifest.name,
          description: manifest.description,
        }),
      }];
      schemaDiagnostics.push({ stage: 'schema', status: 'warn', message: `entry ${manifest.entry} 缺失，已生成兜底预览页` });
    }
    // sandbox 有源码产出且原始含 entry → ready；entry 缺失（兜底页注入）→ partial。
    status = parsedManifest && !entryMissing ? 'ready' : 'partial';
  } else {
    // sandbox 仅 manifest.json 无源码文件：保留上轮文件，标记 partial（追问未改源码，保守标记）。
    files = prev.files.filter((file) => file.path !== 'manifest.json');
    status = 'partial';
  }
  files = [{ path: 'manifest.json', content: JSON.stringify(manifest, null, 2) }, ...files];

  const schemaStatus: DraftDiagnostic['status'] = status === 'ready' ? 'pass' : 'warn';
  const schemaSummary = `追问 sandbox 扫描：${status}（manifest ${parsedManifest ? '已解析' : '沿用上轮'}，扫描文件 ${sbFiles.length}）`;

  return {
    ...prev,
    status,
    files,
    turns: normalizeTurns([
      ...prev.turns,
      { role: 'user', content: prompt, at: now },
      { role: 'assistant', content: output || '本地代码助手已更新插件文件。', at: now },
    ]),
    diagnostics: [
      ...prev.diagnostics,
      { stage: 'local-cli', status: result.success ? 'pass' : 'fail', message: `追问 ${cliSessionId(result) || '未返回 session'}` },
      { stage: 'schema', status: schemaStatus, message: schemaSummary },
      ...(result.diagnostics || []).map((message) => ({ stage: 'diagnostics', status: 'fail' as const, message })),
      ...schemaDiagnostics,
    ],
  };
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
  // SDK-06 修复：预览态同样注入宿主设计令牌，与运行态 tokensStyles() 行为一致，
  // 让创建器预览的 var(--lf-color-*) 正确解析（而非依赖插件自身 fallback）。
  const tokens = `<style data-lf-tokens>:root{--lf-color-primary:#2563eb;--lf-color-bg:#fafafa;--lf-color-text:#1a1a1a;--lf-color-border:#dddddd;--lf-radius-md:10px;--lf-spacing-md:14px;--lf-font-sans:system-ui,sans-serif;}</style>`;
  const shim = `<script>
    window.sdk = {
      invoke: async (cap) => { alert('能力 ' + cap + ' 将由宿主网关提供'); },
      codeAssistant: { run: async () => '（预览态：发布后由本地代码助手执行）' },
      ui: { render: (c) => { document.body.insertAdjacentHTML('beforeend', '<pre>' + (typeof c === 'string' ? c : JSON.stringify(c, null, 2)) + '</pre>'); } },
    };
  <\/script>`;
  return tokens + shim + html;
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