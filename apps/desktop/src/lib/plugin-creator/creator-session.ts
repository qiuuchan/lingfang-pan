import type { TodoItem } from '@/lib/agent/tools';
import type { StagedPlugin } from '@/lib/plugin-creator/creator-tools';

export interface QuestionPart {
  type: 'question';
  toolCallId: string;
  question: string;
  options?: { label: string; value: string }[];
  allowFreeText: boolean;
  multiSelect: boolean;
  answer?: string;
  answered: boolean;
}

export interface ToolPart {
  type: 'tool';
  toolCallId: string;
  name: string;
  /** 工具入参（用于卡片展开显示）。 */
  args?: unknown;
  /** 工具返回（用于卡片展开显示）。 */
  result?: unknown;
  status: 'running' | 'ok' | 'error';
}

// OpenCodeUI 式链式渲染：把文本/思考也作为按时序排列的 part，
// 让「思考块 + AI 输出 + 工具调用 + 思考 + 输出」按真实产生顺序逐块展示。
export interface TextPart {
  type: 'text';
  content: string;
}

export interface ReasoningPart {
  type: 'reasoning';
  content: string;
  /** 思考段是否已结束（reasoning-end 后置 true，UI 可停掉 loading）。 */
  done?: boolean;
}

export type TurnPart = QuestionPart | ToolPart | TextPart | ReasoningPart;

export interface Turn {
  role: 'user' | 'assistant';
  /**
   * 兼容字段：旧会话只有 content（无 parts）时回退渲染为单个文本块。
   * 新流程文本/思考/工具/提问全部按时序进 parts，content 仅作为旧数据回退与兜底占位。
   */
  content: string;
  /** 发给模型的完整内容。用户气泡可只显示摘要，附件全文放这里进入上下文。 */
  modelContent?: string;
  /** 仅 assistant：本轮是否仍在流式输出中。 */
  streaming?: boolean;
  status?: 'generating' | 'done' | 'failed' | 'cancelled';
  /** 结构化片段：按时序排列的 文本 / 思考 / 工具调用 / 提问卡片。 */
  parts?: TurnPart[];
}

export interface CreatorConversation {
  id: string;
  title: string;
  turns: Turn[];
  createdAt: string;
  updatedAt: string;
  /** 当前暂存的 AI 草稿（关窗重开 / 切回该会话时恢复右侧预览面板，修复重开右侧栏消失）。 */
  stagedDraft?: StagedPlugin | null;
  /** 当前对话绑定的 DraftWorkspace UUID。AI 工具 Read/Write/RunPlugin 以它为准。 */
  workspacePluginId?: string | null;
  /** 用户在右侧面板改过的字段（与 stagedDraft 合并成展示用 draft）。 */
  userEdits?: Partial<StagedPlugin>;
  /** TodoWrite 工具维护的任务清单（跨轮延续，随会话持久化到 localStorage）。 */
  todos?: TodoItem[];
}

function normalizeTurnPart(part: unknown, index: number): TurnPart | null {
  if (!part || typeof part !== 'object') return null;
  const raw = part as Record<string, unknown>;
  switch (raw.type) {
    case 'text':
      return { type: 'text', content: typeof raw.content === 'string' ? raw.content : '' };
    case 'reasoning':
      return { type: 'reasoning', content: typeof raw.content === 'string' ? raw.content : '', done: raw.done === true };
    case 'tool':
      return {
        type: 'tool',
        toolCallId: typeof raw.toolCallId === 'string' ? raw.toolCallId : `legacy-tool-${index}`,
        name: typeof raw.name === 'string' ? raw.name : 'Tool',
        args: raw.args,
        result: raw.result,
        status: raw.status === 'ok' || raw.status === 'error' ? raw.status : 'running',
      };
    case 'question':
      return {
        type: 'question',
        toolCallId: typeof raw.toolCallId === 'string' ? raw.toolCallId : `legacy-question-${index}`,
        question: typeof raw.question === 'string' ? raw.question : '请补充信息',
        options: Array.isArray(raw.options)
          ? raw.options.flatMap((option) => {
            if (!option || typeof option !== 'object') return [];
            const item = option as Record<string, unknown>;
            const label = typeof item.label === 'string' ? item.label : '';
            const value = typeof item.value === 'string' ? item.value : label;
            return label ? [{ label, value }] : [];
          })
          : undefined,
        allowFreeText: raw.allowFreeText !== false,
        multiSelect: raw.multiSelect === true,
        answer: typeof raw.answer === 'string' ? raw.answer : undefined,
        answered: raw.answered === true,
      };
    default:
      return null;
  }
}

export function cleanTurnParts(parts: unknown): TurnPart[] {
  if (!Array.isArray(parts)) return [];
  return parts.flatMap((part, index) => normalizeTurnPart(part, index) ?? []);
}

export function mergeStreamingText(existing: string, delta: string): string {
  if (!delta) return existing;
  if (!existing) return delta;
  if (delta.startsWith(existing)) return delta;
  const dedupeMinLength = 12;
  if (delta.trim().length >= dedupeMinLength && existing.endsWith(delta)) return existing;

  const maxOverlap = Math.min(existing.length, delta.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (overlap >= dedupeMinLength && existing.endsWith(delta.slice(0, overlap))) {
      return existing + delta.slice(overlap);
    }
  }
  return existing + delta;
}

/**
 * 检测 delta 是否是已有文本的重复输出（整段重复，非流式重叠）。
 *
 * 上游模型在多轮工具调用后，有时会把上一轮的总结/分析整段重新输出一遍
 * （表现为几百字的完整段落重复 3-6 次）。mergeStreamingText 的流式重叠
 * 去重（12 字符阈值）检测不到这种整段重复。
 *
 * 本函数检查：delta（≥40 字符）是否作为子串已存在于 existing 中。
 * 是则判定为重复，返回 null（调用方跳过该 delta）。
 */
export function detectDuplicateOutput(existing: string, delta: string): string | null {
  const trimmed = delta.trim();
  if (trimmed.length < 40) return delta; // 太短不判定，保留常见 SSE 短增量。
  if (existing.includes(trimmed)) return null; // 已包含完整 delta → 重复
  // 部分重叠检查：delta 的前 60 字符在 existing 里出现，且 delta 很长 → 大概率重复
  if (trimmed.length >= 60) {
    const head = trimmed.slice(0, 60);
    if (existing.includes(head)) return null;
  }
  return delta; // 非重复，正常追加
}

function cleanTurn(turn: unknown): Turn | null {
  if (!turn || typeof turn !== 'object') return null;
  const raw = turn as Record<string, unknown>;
  if (raw.role !== 'user' && raw.role !== 'assistant') return null;
  const next: Turn = {
    role: raw.role,
    content: typeof raw.content === 'string' ? raw.content : '',
  };
  if (raw.status === 'generating' || raw.status === 'done' || raw.status === 'failed' || raw.status === 'cancelled') {
    next.status = raw.status;
  }
  if (raw.streaming === true) next.streaming = true;
  if (raw.role === 'assistant') {
    const parts = cleanTurnParts(raw.parts);
    if (parts.length > 0) next.parts = parts;
  }
  return next;
}

function stripModelContent(turn: Turn): Turn {
  const persisted = { ...turn };
  delete persisted.modelContent;
  return persisted;
}

function sanitizeConversationForStorage(conversation: CreatorConversation): CreatorConversation {
  return {
    ...conversation,
    turns: conversation.turns.map(stripModelContent),
  };
}

export const conversationKey = (userId: string | null, tenantId: string | null) => `lf:creator-conversations:${tenantId || userId || 'none'}`;
export const selectedConversationKey = (userId: string | null, tenantId: string | null) => `lf:creator-selected:${tenantId || userId || 'none'}`;

/** 归一化持久化的 todo 清单（容忍旧数据/非法值，status/priority 枚举校验）。 */
function normalizeTodos(raw: unknown): TodoItem[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const validStatus = new Set(['pending', 'in_progress', 'completed']);
  const validPriority = new Set(['high', 'medium', 'low']);
  const out: TodoItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const content = typeof record.content === 'string' ? record.content : '';
    if (!content.trim()) continue;
    const status = validStatus.has(record.status as string) ? (record.status as TodoItem['status']) : 'pending';
    const priority = validPriority.has(record.priority as string) ? (record.priority as TodoItem['priority']) : 'medium';
    out.push({ content, status, priority });
  }
  return out;
}

export function loadConversations(userId: string | null, tenantId: string | null): CreatorConversation[] {
  try {
    const raw = localStorage.getItem(conversationKey(userId, tenantId));
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.flatMap((item): CreatorConversation[] => {
      if (!item || typeof item !== 'object') return [];
      const record = item as Record<string, unknown>;
      if (typeof record.id !== 'string' || !Array.isArray(record.turns)) return [];
      return [{
        id: record.id,
        title: typeof record.title === 'string' ? record.title : '历史对话',
        turns: record.turns.flatMap((turn) => cleanTurn(turn) ?? []),
        createdAt: typeof record.createdAt === 'string' ? record.createdAt : new Date().toISOString(),
        updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date().toISOString(),
        stagedDraft: (record.stagedDraft ?? null) as StagedPlugin | null,
        workspacePluginId: typeof record.workspacePluginId === 'string' ? record.workspacePluginId : null,
        userEdits: record.userEdits && typeof record.userEdits === 'object' ? record.userEdits as Partial<StagedPlugin> : undefined,
        todos: normalizeTodos(record.todos),
      }];
    }) : [];
  } catch {
    return [];
  }
}

export function saveConversations(userId: string | null, tenantId: string | null, conversations: CreatorConversation[]) {
  try {
    localStorage.setItem(
      conversationKey(userId, tenantId),
      JSON.stringify(conversations.slice(0, 30).map(sanitizeConversationForStorage)),
    );
  } catch {
    /* localStorage 配额不足时放弃历史保存，当前对话仍可继续 */
  }
}

export function makeConversationTitle(text: string) {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > 24 ? `${compact.slice(0, 24)}...` : compact || '新对话';
}
