// FloatingCreator —— 悬浮窗 + 对话式 + 流式 AI 插件创建器（OpenAI Agents SDK agent）。
//
//  - 悬浮窗：App 渲染为全屏遮罩 + 居中面板（~85vh），不切 view，关窗即回原页。
//  - 对话式：多轮聊天（用户/助手气泡），输入框在底部，Enter 发送。
//  - 流式 + agent：OpenAI Agents SDK 走 relay；模型生成插件后调用 CreatePlugin 写入 plugins_root 草稿。
//    草稿在右侧分栏实时预览，用户可改名字/信息、继续对话打磨，点「提交」才真正发布。
//  - 上下文自动压缩 + Skill 动态拼装系统提示词保留。
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { XIcon, SendIcon, Loader2Icon, PlusIcon, CheckCircle2Icon, Trash2Icon, EyeIcon } from 'lucide-react';
import { useApp } from '@/App';
import type { LoadedPlugin } from '@/lib/types';
import { api, tauriInvoke } from '@/lib/api';
import { withSyncedStagedManifest, type StagedPlugin } from '@/lib/plugin-creator/creator-tools';
import { runPluginCreatorAgent } from '@/lib/agent/creator-adapter';
import type { AskQuestionArgs, AskQuestionResult, TodoItem } from '@/lib/agent/tools';
import type { AgentMessagePart } from '@/lib/agent/creator-adapter';
import { readLocalFiles, filesToStagedPlugin } from '@/lib/plugin-creator/import-local';
import { CreatorDraftPanel } from '@/components/creator/CreatorDraftPanel';
import { ToolCallCard } from '@/components/creator/ToolCallCard';
import { TodoPanel } from '@/components/creator/TodoPanel';
import { ContextInspector } from '@/components/creator/ContextInspector';
import { CreatorFloatingTitleBar, CreatorWorkspaceSidebar } from '@/components/creator/CreatorWorkspaceChrome';
import { CreatorComposer } from '@/components/creator/CreatorComposer';
import { CreatorEmptyState } from '@/components/creator/CreatorEmptyState';
import { CreatorCopyButton, CreatorRetryButton } from '@/components/creator/CreatorMessageActions';
import { assembleSystemPrompt, DEFAULT_ACTIVE_SKILLS, SKILLS } from '@/lib/skills';
import { CREATOR_CONTEXT_PROMPT } from '@/lib/agent/prompts';
import { buildContextMessages, emptyCompressState } from '@/lib/plugin-creator/context-compress';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Markdown } from '@/components/markdown';
import { cn } from '@/lib/utils';

interface QuestionPart {
  type: 'question';
  toolCallId: string;
  question: string;
  options?: { label: string; value: string }[];
  allowFreeText: boolean;
  multiSelect: boolean;
  answer?: string;
  answered: boolean;
}
interface ToolPart {
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
interface TextPart {
  type: 'text';
  content: string;
}
interface ReasoningPart {
  type: 'reasoning';
  content: string;
  /** 思考段是否已结束（reasoning-end 后置 true，UI 可停掉 loading）。 */
  done?: boolean;
}
type TurnPart = QuestionPart | ToolPart | TextPart | ReasoningPart;

/**
 * 把 UI 的 TurnPart[]（按时序：文本/工具调用/工具结果）映射成可序列化的 AgentMessagePart[]，
 * 供 creator-adapter 还原成 SDK 的 function_call / function_call_output 序列。
 *
 * 断点续的关键：重试时模型能看到「上轮已调用 WebSearch(query=x) 得到结果 Y」，
 * 因此不必重跑搜索，直接从上次进度继续。
 * - text part → text（output_text）
 * - tool part(status=ok/error) → tool_call + 紧跟一个 tool_result（一一配对）
 * - reasoning part → 跳过（思考内容不进工具续跑历史，避免噪音）
 */
function partsToAgentMessageParts(parts?: TurnPart[]): AgentMessagePart[] | undefined {
  if (!parts || !parts.length) return undefined;
  const out: AgentMessagePart[] = [];
  for (const p of parts) {
    if (p.type === 'text') {
      if (p.content.trim()) out.push({ type: 'text', text: p.content });
    } else if (p.type === 'tool') {
      // 跳过 running 态（未完成的工具调用不应进历史）。
      if (p.status === 'running') continue;
      if (!p.toolCallId) continue;
      out.push({
        type: 'tool_call',
        toolCallId: p.toolCallId,
        name: p.name,
        args: p.args,
      });
      out.push({
        type: 'tool_result',
        toolCallId: p.toolCallId,
        name: p.name,
        output: typeof p.result === 'string' ? p.result : JSON.stringify(p.result ?? ''),
      });
    }
    // reasoning / question：跳过（不进工具历史）
  }
  return out.length ? out : undefined;
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

function cleanTurnParts(parts: unknown): TurnPart[] {
  if (!Array.isArray(parts)) return [];
  return parts.flatMap((part, index) => normalizeTurnPart(part, index) ?? []);
}

interface Turn {
  role: 'user' | 'assistant';
  /**
   * 兼容字段：旧会话只有 content（无 parts）时回退渲染为单个文本块。
   * 新流程文本/思考/工具/提问全部按时序进 parts，content 仅作为旧数据回退与兜底占位。
   */
  content: string;
  /** 仅 assistant：本轮是否仍在流式输出中。 */
  streaming?: boolean;
  status?: 'generating' | 'done' | 'failed' | 'cancelled';
  /** 结构化片段：按时序排列的 文本 / 思考 / 工具调用 / 提问卡片。 */
  parts?: TurnPart[];
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

interface CreatorConversation {
  id: string;
  title: string;
  turns: Turn[];
  createdAt: string;
  updatedAt: string;
  /** 当前暂存的 AI 草稿（关窗重开 / 切回该会话时恢复右侧预览面板，修复重开右侧栏消失）。 */
  stagedDraft?: StagedPlugin | null;
  /** 用户在右侧面板改过的字段（与 stagedDraft 合并成展示用 draft）。 */
  userEdits?: Partial<StagedPlugin>;
  /** TodoWrite 工具维护的任务清单（跨轮延续，随会话持久化到 localStorage）。 */
  todos?: TodoItem[];
}

const conversationKey = (userId: string | null, tenantId: string | null) => `lf:creator-conversations:${tenantId || userId || 'none'}`;
const selectedConversationKey = (userId: string | null, tenantId: string | null) => `lf:creator-selected:${tenantId || userId || 'none'}`;

/** 归一化持久化的 todo 清单（容忍旧数据/非法值，status/priority 枚举校验）。 */
function normalizeTodos(raw: unknown): TodoItem[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const validStatus = new Set(['pending', 'in_progress', 'completed']);
  const validPriority = new Set(['high', 'medium', 'low']);
  const out: TodoItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const content = typeof r.content === 'string' ? r.content : '';
    if (!content.trim()) continue;
    const status = validStatus.has(r.status as string) ? (r.status as TodoItem['status']) : 'pending';
    const priority = validPriority.has(r.priority as string) ? (r.priority as TodoItem['priority']) : 'medium';
    out.push({ content, status, priority });
  }
  return out;
}

function loadConversations(userId: string | null, tenantId: string | null): CreatorConversation[] {
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
        userEdits: record.userEdits && typeof record.userEdits === 'object' ? record.userEdits as Partial<StagedPlugin> : undefined,
        todos: normalizeTodos(record.todos),
      }];
    }) : [];
  } catch {
    return [];
  }
}

function saveConversations(userId: string | null, tenantId: string | null, conversations: CreatorConversation[]) {
  try {
    localStorage.setItem(conversationKey(userId, tenantId), JSON.stringify(conversations.slice(0, 30)));
  } catch {
    /* localStorage 配额不足时放弃历史保存，当前对话仍可继续 */
  }
}

function makeConversationTitle(text: string) {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > 24 ? `${compact.slice(0, 24)}...` : compact || '新对话';
}

const SYSTEM_PROMPT = CREATOR_CONTEXT_PROMPT;

/**
 * 上下文自动压缩见 lib/plugin-creator/context-compress.ts（超阈值时摘要早期对话轮，保留近期+插件包原文）。
 */
export function FloatingCreator({ onClose, variant = 'floating', sidebarCollapsed = false }: { onClose: () => void; variant?: 'floating' | 'embedded'; sidebarCollapsed?: boolean }) {
  const { session, recentPlugins, pendingAutoFix, setPendingAutoFix, pendingDraftEdit, setPendingDraftEdit } = useApp();
  const embedded = variant === 'embedded';
  const [turns, setTurns] = useState<Turn[]>([]);
  const [conversations, setConversations] = useState<CreatorConversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [tier, setTier] = useState<'fast' | 'premium'>('fast');
  const [activeSkillIds, setActiveSkillIds] = useState<string[]>(DEFAULT_ACTIVE_SKILLS);
  const [busy, setBusy] = useState(false);
  const [thinking, setThinking] = useState(true); // 「思考」模式默认开启：让模型更深入推理（systemPrompt 追加引导）
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyPage, setHistoryPage] = useState(0); // R3：历史列表分页页码（0-based）
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null); // R3：行内删除二次确认态
  const [skillDialogOpen, setSkillDialogOpen] = useState(false); // Skill 居中悬浮窗开关（R3：由小 Popover 改为居中 Dialog + 背景模糊）
  const [referencedPlugin, setReferencedPlugin] = useState<LoadedPlugin | null>(null); // 引用的现有插件（让 agent 基于其代码修改）
  const [compressing, setCompressing] = useState(false); // 压缩中指示
  const [uploadingViaTool, setUploadingViaTool] = useState(false); // agent 工具暂存草稿中指示
  const [searchingQuery, setSearchingQuery] = useState<string | null>(null); // agent WebSearch 联网搜索中指示（展示关键词）
  const [compressedHint, setCompressedHint] = useState(0); // 上次压缩的轮数（UI 指示）
  const [publishedName, setPublishedName] = useState<string | null>(null); // 已发布插件名（用户提交成功后显示成功卡片）
  // 草稿态：AI CreatePlugin 暂存的插件 + 用户的手动编辑（覆盖 AI 字段，跨重新生成保留）。
  // stagedDraft 是 AI 最新生成的原始草稿；userEdits 是用户在右侧面板改过的字段。
  // 二者合并成展示用 draft；AI 重新 CreatePlugin 同一 id 时 userEdits 保留，换 id 则清空。
  const [stagedDraft, setStagedDraft] = useState<StagedPlugin | null>(null);
  const [userEdits, setUserEdits] = useState<Partial<StagedPlugin>>({});
  const [contextWindow, setContextWindow] = useState<number | null>(null); // 当前 tier 模型的上下文窗口（token）
  const [reasoning, setReasoning] = useState(''); // 当前轮思考内容流式累积（支持思考输出的模型）
  const [contextBreakdown, setContextBreakdown] = useState<{ systemPrompt: string; summary: string; keptTurns: Array<{ role: string; content: string }>; currentInput: string; estimatedTokens: { system: number; summary: number; history: number; input: number; total: number }; compressInfo: { threshold: number; currentChars: number; remainingChars: number; pct: number } } | null>(null); // 上下文查看面板数据
  const [contextInspectorOpen, setContextInspectorOpen] = useState(false); // 上下文查看面板开关
  const [todos, setTodos] = useState<TodoItem[]>([]); // 当前会话的 TodoWrite 任务清单（随会话持久化）
  // 网络慢检测：流式进行中但长时间（>12s）无新 token 时，状态条提示「网络较慢」。
  // lastTokenAt 记录最近一次收到流式增量的时间；netSlowTimerRef 定时检查并切换 networkSlow。
  const lastTokenAtRef = useRef<number>(0);
  const [networkSlow, setNetworkSlow] = useState(false);
  const netSlowTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const compressRef = useRef(emptyCompressState());
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null); // 文件/文件夹选择（支持多次累积）
  const [selectedFiles, setSelectedFiles] = useState<Array<{ id: string; name: string; file: File }>>([]); // 已选文件列表
  // R2：悬挂的 AskQuestion deferred —— 用户作答后 resolve（人在环）。
  // key=toolCallId，存 resolve/reject；切对话/取消/关窗时必须清掉防卡死。
  const pendingAnswersRef = useRef<Map<string, { resolve: (r: AskQuestionResult) => void; reject: (e: unknown) => void }>>(new Map());
  // 提问卡片的自由文本输入暂存（key=toolCallId）。
  const [answerDrafts, setAnswerDrafts] = useState<Record<string, string>>({});
  // 多选暂存（key=toolCallId → 已选 value 集合）。
  const [multiSelectDrafts, setMultiSelectDrafts] = useState<Record<string, string[]>>({});

  // R2：清理所有悬挂的提问 deferred（取消/切对话/关窗时调用），避免 agent run 卡死。
  function clearPendingAnswers() {
    for (const [, d] of pendingAnswersRef.current) {
      try { d.reject(new DOMException('cancelled', 'AbortError')); } catch { /* ignore */ }
    }
    pendingAnswersRef.current.clear();
  }

  // 展示用草稿 = AI 暂存的原始草稿叠加用户的手动编辑（用户改过的字段优先），并始终同步 manifest.json。
  const draft: StagedPlugin | null = stagedDraft ? withSyncedStagedManifest({ ...stagedDraft, ...userEdits }) : null;

  // CreatePlugin 工具回调：工具已写入 plugins_root/{id}/，这里同步右侧草稿预览状态。
  // 同一插件 id 继续修改时保留用户已改字段；换 id（新插件）则清空旧编辑。
  function onPluginCreated(pluginId: string, next: StagedPlugin) {
    const synced = withSyncedStagedManifest(next);
    draftRef.current = synced;
    currentPluginIdRef.current = pluginId;
    setStagedDraft((prev) => {
      if (prev && prev.id !== next.id) setUserEdits({});
      return synced;
    });
  }

  // 用户在右侧面板编辑信息 → 累积到 userEdits（覆盖 AI 字段）。
  function patchDraft(patch: Partial<StagedPlugin>) {
    setUserEdits((prev) => ({ ...prev, ...patch }));
  }

  // 草稿 ref：供 Agent 工具回调读取最新插件 id，避免异步流闭包读到旧值。
  const draftRef = useRef<StagedPlugin | null>(draft);
  const currentPluginIdRef = useRef<string | null>(draft?.id ?? null);
  useEffect(() => {
    draftRef.current = draft;
    currentPluginIdRef.current = draft?.id ?? null;
  }, [draft]);

  // Write/Edit 工具直接改 plugins_root，需要从真实目录重载文件刷新右侧预览。
  async function refreshDraftFromRoot(pluginId = currentPluginIdRef.current) {
    if (!pluginId) return;
    try {
      const paths = await tauriInvoke<string[]>('list_plugin_files', { pluginId });
      const files = await Promise.all(
        paths.map(async (path) => ({
          path,
          content: await tauriInvoke<string>('read_local_plugin_file', { pluginId, file: path }),
        })),
      );
      const manifestRaw = files.find((f) => f.path === 'manifest.json')?.content ?? '{}';
      const manifest = JSON.parse(manifestRaw) as Partial<StagedPlugin> & { id?: string };
      const next: StagedPlugin = withSyncedStagedManifest({
        id: manifest.id || pluginId,
        name: manifest.name || pluginId,
        version: manifest.version || '0.1.0',
        description: manifest.description || '',
        runtime_type: manifest.runtime_type || 'client',
        entry: manifest.entry || 'ui/index.html',
        visibility: manifest.visibility || 'tenant',
        capabilities: manifest.capabilities || [],
        files,
      });
      draftRef.current = next;
      currentPluginIdRef.current = next.id;
      setStagedDraft(next);
    } catch (e) {
      console.error('刷新草稿失败:', e);
    }
  }

  // 保存草稿成功：清草稿态，显示成功卡片。
  function onDraftSubmitted(name: string) {
    setPublishedName(name);
    setStagedDraft(null);
    setUserEdits({});
    toast.success(`草稿「${name}」已保存到本地`);
  }

  // 处理文件选择（累积模式，支持多次选择）
  function handleFileSelect(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    const newFiles = Array.from(fileList).map((file) => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
      file,
    }));
    setSelectedFiles((prev) => [...prev, ...newFiles]);
  }

  // 移除单个文件
  function removeFile(id: string) {
    setSelectedFiles((prev) => prev.filter((f) => f.id !== id));
  }

  // 从已选文件列表导入插件 → 转草稿进入预览/改信息/提交流程
  async function importFromSelectedFiles() {
    if (selectedFiles.length === 0) {
      toast.error('未选择任何文件');
      return;
    }
    try {
      const fileList = selectedFiles.map((f) => f.file);
      const result = await readLocalFiles(fileList);
      if (result.files.length === 0) {
        toast.error('未读取到可用的文本文件（可能都是二进制或超限）');
        return;
      }
      const imported = filesToStagedPlugin(result);
      ensureConversation(`导入本地插件：${imported.name}`);
      setPublishedName(null);
      setUserEdits({});
      setStagedDraft(imported);
      setSelectedFiles([]); // 导入成功后清空文件列表
      const skippedNote = result.skipped.length ? `，跳过 ${result.skipped.length} 个文件` : '';
      toast.success(`已导入「${imported.name}」（${result.files.length} 个文件${skippedNote}），可在右侧预览并修改后提交`);
      // 在对话区留一条记录，让 AI 知道当前草稿来自导入（draft 会注入 systemPrompt，可继续让 AI 改）。
      setTurns((prev) => [
        ...prev,
        { role: 'user', content: `（从本地导入了插件「${imported.name}」，共 ${result.files.length} 个文件）` },
        { role: 'assistant', content: '已载入导入的插件为草稿，你可以在右侧预览、修改信息后提交，或告诉我要怎么改。', status: 'done' },
      ]);
    } catch (e) {
      toast.error(`导入失败：${(e as Error).message || String(e)}`);
    }
  }

  useEffect(() => {
    const loaded = loadConversations(session.userId, session.tenantId);
    setConversations(loaded);
    let selected: string | null = null;
    try { selected = localStorage.getItem(selectedConversationKey(session.userId, session.tenantId)); } catch { /* ignore */ }
    const active = loaded.find((conversation) => conversation.id === selected) ?? loaded[0] ?? null;
    setActiveConversationId(active?.id ?? null);
    setTurns(active?.turns ?? []);
    // 恢复右侧草稿面板：关窗重开 / 重登后，回填上次暂存的草稿与用户编辑（修复重开右侧栏消失）。
    setStagedDraft(active?.stagedDraft ?? null);
    setUserEdits(active?.userEdits ?? {});
    setTodos(active?.todos ?? []);
  }, [session.userId, session.tenantId]);

  useEffect(() => {
    // turns 为空但有草稿（如刚导入未对话）也应持久化，故放宽空判定为「两者皆空才跳过」。
    if (!activeConversationId || (turns.length === 0 && !stagedDraft)) return;
    setConversations((prev) => {
      const now = new Date().toISOString();
      const next = prev.map((conversation) => conversation.id === activeConversationId
        ? { ...conversation, turns, stagedDraft, userEdits, todos: todos.length ? todos : undefined, updatedAt: now }
        : conversation);
      saveConversations(session.userId, session.tenantId, next);
      return next;
    });
  }, [activeConversationId, session.tenantId, session.userId, turns, stagedDraft, userEdits, todos]);

  function ensureConversation(firstUserText: string) {
    if (activeConversationId) return activeConversationId;
    const now = new Date().toISOString();
    const conversation: CreatorConversation = {
      id: `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title: makeConversationTitle(firstUserText),
      turns: [],
      createdAt: now,
      updatedAt: now,
    };
    setActiveConversationId(conversation.id);
    try { localStorage.setItem(selectedConversationKey(session.userId, session.tenantId), conversation.id); } catch { /* ignore */ }
    setConversations((prev) => {
      const next = [conversation, ...prev].slice(0, 30);
      saveConversations(session.userId, session.tenantId, next);
      return next;
    });
    return conversation.id;
  }

  function selectConversation(conversation: CreatorConversation) {
    abortRef.current?.abort();
    clearPendingAnswers();
    setBusy(false);
    setUploadingViaTool(false);
    setSearchingQuery(null);
    setCompressing(false);
    setActiveConversationId(conversation.id);
    setTurns(conversation.turns);
    setReasoning('');
    setPublishedName(null);
    // 切回该会话时恢复其暂存草稿与用户编辑（右侧栏随之重现）。
    setStagedDraft(conversation.stagedDraft ?? null);
    setUserEdits(conversation.userEdits ?? {});
    setTodos(conversation.todos ?? []);
    compressRef.current = emptyCompressState();
    try { localStorage.setItem(selectedConversationKey(session.userId, session.tenantId), conversation.id); } catch { /* ignore */ }
    setHistoryOpen(false);
  }

  function selectConversationById(id: string) {
    const conversation = conversations.find((item) => item.id === id);
    if (conversation) selectConversation(conversation);
  }

  function newConversation() {
    abortRef.current?.abort();
    clearPendingAnswers();
    setBusy(false);
    setTurns([]);
    setActiveConversationId(null);
    setReasoning('');
    setReferencedPlugin(null);
    setPublishedName(null);
    setStagedDraft(null);
    setUserEdits({});
    setTodos([]);
    compressRef.current = emptyCompressState();
    setCompressedHint(0);
    try { localStorage.removeItem(selectedConversationKey(session.userId, session.tenantId)); } catch { /* ignore */ }
    setHistoryOpen(false);
  }

  // R3：删除单条历史对话。删的是当前会话时重置为新对话。
  function deleteConversation(id: string) {
    setConversations((prev) => {
      const next = prev.filter((c) => c.id !== id);
      saveConversations(session.userId, session.tenantId, next);
      return next;
    });
    setConfirmDeleteId(null);
    if (id === activeConversationId) newConversation();
  }

  // 拉当前 tier 的 chat 定价 → 取 contextWindow（供用量条 + 压缩阈值参考）。
  useEffect(() => {
    let mounted = true;
    api<{ pricing: { contextWindow?: number | null; tier?: string; capability: string }[] }>('/api/admin/billing/pricing')
      .then((r) => {
        if (!mounted) return;
        // 取当前 tier（或不限 tier）的 chat 定价的 contextWindow。
        const chatRow = r.pricing?.find((p) => p.capability === 'chat' && (p.tier === tier.toUpperCase() || p.tier == null));
        setContextWindow(chatRow?.contextWindow ?? null);
      })
      .catch(() => undefined);
    return () => { mounted = false; };
  }, [tier]);

  // 当前对话 token 用量：优先用 contextBreakdown.estimatedTokens.total（与上下文窗口面板的
  // 堆叠条同源，/1.5 中文偏向），无 breakdown 时 fallback 用 turns 字符数 / 1.5 粗估。
  // 此前用 /3.5（旧系数），与 context-compress 的 /1.5 不一致，导致同一面板两个 token 数字矛盾。
  const usedTokens = contextBreakdown?.estimatedTokens.total
    ?? Math.round(turns.reduce((s, t) => s + t.content.length, 0) / 1.5);
  const usagePct = contextWindow ? Math.min(100, Math.round((usedTokens / contextWindow) * 100)) : 0;

  // 流式输出时自动滚到底。
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns, uploadingViaTool, compressing]);

  // R3：历史 Dialog 打开时重置分页到首页与清掉删除确认态。
  useEffect(() => {
    if (historyOpen) { setHistoryPage(0); setConfirmDeleteId(null); }
  }, [historyOpen]);

  // R3：删除后若当前页超出范围（空页且非首页），自动回退一页。
  const PAGE_SIZE = 8;
  const pageCount = Math.max(1, Math.ceil(conversations.length / PAGE_SIZE));
  useEffect(() => {
    if (historyPage > 0 && historyPage >= pageCount) setHistoryPage(pageCount - 1);
  }, [historyPage, pageCount]);
  const pagedConversations = conversations.slice(historyPage * PAGE_SIZE, (historyPage + 1) * PAGE_SIZE);

  // Esc 关窗（无内层 overlay 打开时）。
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const inner = document.querySelector('[role="dialog"][data-state="open"], [role="presentation"][data-state="open"]');
      if (inner) return; // 内层 overlay 优先
      abortRef.current?.abort();
      clearPendingAnswers();
      onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // 卸载（关窗：X/点遮罩/父组件卸载）时中止流式请求 + 清理悬挂提问 deferred。
  // 必须 abort，否则关窗时若 agent 仍在流式输出，底层 relay 请求会在后台续跑并继续按团队计费（费用泄漏）。
  useEffect(() => () => { abortRef.current?.abort(); clearPendingAnswers(); }, []);

  // 一键 AI 修复消费：插件启动/运行报错跳创建器时，pendingAutoFix 携带提示词 + 出错插件。
  // 此处预填提示词到输入框 + 引用该插件源码（注入上下文），但不自动发送——用户确认后点发送即修。
  // 消费即清（setPendingAutoFix(null)），避免下次打开创建器又被重复预填。
  useEffect(() => {
    if (!pendingAutoFix) return;
    setInput(pendingAutoFix.prompt);
    setReferencedPlugin(pendingAutoFix.plugin);
    setPendingAutoFix(null);
  }, [pendingAutoFix, setPendingAutoFix]);

  // 草稿编辑消费（task 06-25 增强）：草稿列表点「编辑」跳创建器时，pendingDraftEdit 携带草稿 + 对话历史。
  // 此处恢复对话轮次 + 引用草稿源码，让用户继续上次对话修改草稿。消费即清。
  useEffect(() => {
    if (!pendingDraftEdit) return;
    const { draft, turns: restoredTurns } = pendingDraftEdit;
    // 恢复对话轮次。
    if (Array.isArray(restoredTurns) && restoredTurns.length > 0) {
      setTurns(restoredTurns as Turn[]);
    }
    // 引用草稿源码供 AI 修改。
    setReferencedPlugin(draft);
    // 恢复草稿到右侧面板（若 draft.files 存在且含 manifest 信息）。
    if (draft.files && draft.files.length > 0) {
      const raw = draft as LoadedPlugin & {
        capabilities?: StagedPlugin['capabilities'];
        visibility?: StagedPlugin['visibility'];
      };
      setStagedDraft({
        id: draft.id,
        name: draft.name,
        version: draft.version,
        entry: draft.entry,
        description: draft.description || '',
        capabilities: raw.capabilities ?? [],
        visibility: raw.visibility ?? 'private',
        runtime_type: (draft.runtime_type as StagedPlugin['runtime_type']) || 'client',
        files: draft.files.map(f => ({ path: f.path, content: f.content })),
      });
      setUserEdits({});
    }
    setPendingDraftEdit(null);
  }, [pendingDraftEdit, setPendingDraftEdit]);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    ensureConversation(text);
    const userTurn: Turn = { role: 'user', content: text };
    const assistantIdx = turns.length + 1;
    setTurns((prev) => [...prev, userTurn, { role: 'assistant', content: '', streaming: true, status: 'generating' }]);
    await runAgentTurn(assistantIdx, text);
  }

  /**
   * 重试最后一条失败的/已取消的 assistant 轮：复用其上一条 user 轮的输入，
   * 清空失败轮的 parts 后重新发起 agent run。不新增 user 气泡，保持对话结构不变。
   */
  async function retry() {
    if (busy) return;
    // 找到最后一条 assistant 轮（失败/取消态），其上一条应为对应 user 轮。
    // 用倒序 for 循环（避免 findLastIndex 在低 lib target 下不可用）。
    let lastAssistantIdx = -1;
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].role === 'assistant') { lastAssistantIdx = i; break; }
    }
    if (lastAssistantIdx < 0) return;
    const cur = turns[lastAssistantIdx];
    if (cur.status !== 'failed' && cur.status !== 'cancelled') return;
    // 取上一条 user 轮的输入作为重跑文本；找不到则放弃。
    const userTurn = [...turns].slice(0, lastAssistantIdx).reverse().find((t) => t.role === 'user');
    const userText = userTurn?.content ?? '';
    if (!userText.trim()) return;
    // 重置该轮：清空旧 parts 与 content，回到生成中态。
    setTurns((prev) => {
      const next = [...prev];
      next[lastAssistantIdx] = { role: 'assistant', content: '', streaming: true, status: 'generating', parts: [] };
      return next;
    });
    // 重试模式：turns 里已含上一条 user 轮（紧邻被重置的 assistant 轮之前），
    // 所以不应再追加 currentInput（否则用户消息重复）。传 isRetry=true 让 runAgentTurn 跳过追加。
    await runAgentTurn(lastAssistantIdx, userText, { isRetry: true });
  }

  /**
   * 执行一次 agent run，把流式输出写回指定 assistant turn（runPluginCreatorAgent 的 UI 编排）。
   * send() 新建 turn 后调用；retry() 复用既有 turn 后调用。二者共用此函数，避免逻辑重复。
   * @param assistantIdx 要写入的 assistant 轮下标
   * @param text 本轮用户输入（用于压缩与 currentInput）
   * @param opts.isRetry 重试模式：turns 已含对应 user 轮，不重复追加 currentInput
   */
  async function runAgentTurn(assistantIdx: number, text: string, opts: { isRetry?: boolean } = {}) {
    setBusy(true);

    const controller = new AbortController();
    abortRef.current = controller;

    // 网络慢检测：本轮开始时重置 token 时间戳，启动每 3s 检查一次的定时器。
    // 若距上次收到 token 超过 12s，置 networkSlow=true（状态条提示「网络较慢」）。
    lastTokenAtRef.current = Date.now();
    setNetworkSlow(false);
    if (netSlowTimerRef.current) clearInterval(netSlowTimerRef.current);
    netSlowTimerRef.current = setInterval(() => {
      if (Date.now() - lastTokenAtRef.current > 12_000) setNetworkSlow(true);
    }, 3_000);

    try {
      // 系统提示词 = 基础提示 + 激活的 skills（+ 思考模式追加深入推理引导）；relay 服务端还会注入"必须用灵坊服务"规则。
      const basePrompt = assembleSystemPrompt(SYSTEM_PROMPT, activeSkillIds);
      const thinkPrompt = thinking
        ? `\n\n# 思考模式（已开启）\n请对需求做更深入的分析与推理：先拆解需求要点、权衡实现方案、再生成更严谨完整的代码。宁可多花时间也要保证质量与边界处理。`
        : '';
      // 引用现有插件：把其全部文件源码注入 systemPrompt，让 agent 基于现有代码做修改（而非从零生成）。
      const refPrompt = referencedPlugin?.files?.length
        ? `\n\n# 参考插件（用户要基于此修改）\n插件名：${referencedPlugin.name}\n请在此基础上按用户需求修改，保留未变文件，只改必要部分（增量重构）。\n\n当前文件：\n${referencedPlugin.files.map((f) => `--- ${f.path} ---\n${f.content}`).join('\n\n')}`
        : '';
      // 当前草稿注入：只注入元信息 + 文件路径列表，正文让 agent 用 Read 按需取。
      // 此前把全部文件全文注入 systemPrompt，但 context-compress 只压缩对话历史、对 systemPrompt
      // 视而不见 → 草稿越大每轮固定开销越大，长任务下 systemPrompt 持续膨胀，完全绕过压缩。
      // 改为路径列表后，agent 需要某文件时主动 Read（已有 read-before-edit 跟踪），上下文可控。
      const draftPrompt = draft?.files?.length
        ? `\n\n# 当前草稿（用户正在预览，要在此基础上修改）\n` +
          `id：${draft.id}\n名字：${draft.name}\n版本：${draft.version}\n描述：${draft.description}\n` +
          `runtime_type：${draft.runtime_type}\nentry：${draft.entry}\n` +
          `请基于以下文件按用户新需求做增量修改（保留未变部分）。需要查看某文件当前内容时用 Read 读取，再用 Edit/Write 改写；整体重构时才再次调用 CreatePlugin。` +
          `若用户改了名字/描述等元信息（见上方），沿用这些值，不要擅自改回。\n\n当前文件（按需 Read 查看）：\n` +
          draft.files.map((f) => `- ${f.path}`).join('\n')
        : '';
      const systemPrompt = basePrompt + thinkPrompt + refPrompt + draftPrompt;
      // 上下文自动压缩：超阈值时摘要较早对话轮（保留近期 + 含插件包的轮）。
      setCompressing(true);
      // 构建消息：assistant 轮带上 parts（工具调用+结果），让重试/续跑时模型能看到上轮已完成的工作，
      // 不必重跑 WebSearch 等工具（断点续的关键）。仅纳入 status==='done' 的 assistant 轮。
      // 重试模式：turns 里已含被重置的失败 assistant 轮（generating），切片到 assistantIdx 之前，
      // 并跳过追加 currentInput（对应 user 轮已在前面的 turns 里，避免重复）。
      const historyTurns = opts.isRetry
        ? turns.slice(0, assistantIdx)
        : turns;
      const built = await buildContextMessages({
        turns: historyTurns.map((t) => {
          if (t.role === 'assistant' && t.status === 'done') {
            return { role: t.role, content: t.content, parts: partsToAgentMessageParts(t.parts) };
          }
          return { role: t.role, content: t.content };
        }),
        currentInput: opts.isRetry ? '' : text,
        skipAppendCurrent: opts.isRetry,
        systemPrompt,
        state: compressRef.current,
        tier,
        signal: controller.signal,
      });
      setCompressing(false);
      compressRef.current = built.state;
      setCompressedHint(built.compressedCount);
      setContextBreakdown(built.breakdown); // 捕获上下文分解数据供查看面板使用

      // R2：AskQuestion 人在环回调——写提问卡片到当前 assistant 气泡的 parts，
      // 返回 deferred Promise；用户在卡片作答后 resolve，agent 多步循环继续。
      const onAskQuestion = (args: AskQuestionArgs, toolCallId: string): Promise<AskQuestionResult> => {
        setTurns((prev) => {
          const next = [...prev];
          const cur = next[assistantIdx];
          if (cur && cur.role === 'assistant') {
            const part: QuestionPart = {
              type: 'question',
              toolCallId,
              question: args.question,
              options: args.options,
              allowFreeText: args.allowFreeText ?? true,
              multiSelect: args.multiSelect ?? false,
              answered: false,
            };
            next[assistantIdx] = { ...cur, parts: [...cleanTurnParts(cur.parts), part] };
          }
          return next;
        });
        return new Promise<AskQuestionResult>((resolve, reject) => {
          pendingAnswersRef.current.set(toolCallId, { resolve, reject });
        });
      };

      let stagedName = '';
      let stageErrMsg = '';
      let sawToolCall = false; // R1：本轮是否有过工具调用（含 AskQuestion/CreatePlugin）
      let reasoningText = ''; // 本轮思考累积（流末兜底判定用，避免读 reasoning state 的陈旧闭包）
      let streamError: string | null = null; // 捕获流中的错误消息（error 事件或 finish_reason='error'）
      setReasoning('');

      // OpenAI Agents SDK：框架负责多步循环和工具调用；adapter 把事件写回现有 UI parts。
      const agentResult = await runPluginCreatorAgent(
        {
          messages: built.messages as Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
          tier,
          extraInstructions: systemPrompt,
          signal: controller.signal,
          callbacks: {
            appendTextDelta: (turnIdx, delta) => {
              lastTokenAtRef.current = Date.now();
              setNetworkSlow(false);
              appendTextDelta(turnIdx, delta);
            },
            appendReasoningDelta: (turnIdx, delta) => {
              reasoningText += delta;
              lastTokenAtRef.current = Date.now();
              setNetworkSlow(false);
              appendReasoningDelta(turnIdx, delta);
            },
            endReasoning,
            upsertToolPart: (turnIdx, patch) => {
              sawToolCall = true;
              upsertToolPart(turnIdx, patch);
            },
            getPluginId: () => currentPluginIdRef.current,
            onPluginCreated: (pluginId, nextDraft) => {
              stagedName = nextDraft.name;
              setUploadingViaTool(false);
              onPluginCreated(pluginId, nextDraft);
            },
            onFilesChanged: () => {
              void refreshDraftFromRoot();
            },
            onAskQuestion,
            getTodos: () => todos,
            onTodoUpdate: (next) => {
              setTodos(next.map((t) => ({ ...t })));
            },
            onToolStart: (toolName, args) => {
              sawToolCall = true;
              if (toolName === 'CreatePlugin') setUploadingViaTool(true);
              else if (toolName === 'WebSearch') {
                const q = (args as { query?: string } | undefined)?.query ?? '';
                setSearchingQuery(q || '联网搜索中');
              }
            },
            onToolResult: (toolName, output) => {
              if (toolName === 'CreatePlugin') {
                setUploadingViaTool(false);
                if (typeof output === 'string' && output.startsWith('错误')) stageErrMsg = output;
              } else if (toolName === 'WebSearch') {
                setSearchingQuery(null);
              }
            },
          },
        },
        assistantIdx,
      );
      if (agentResult.error) streamError = agentResult.error;
      // 流结束：清除流式标记（保留已累积的 parts 时序内容）。
      // 多步 agent 的各步文本/思考/工具已按时序进 parts；末步总结也已 delta 进来。
      // R1 前端兜底：流正常结束但无任何可见内容时，避免裸露「无内容」——按情形给友好提示（写入新 text part）。
      setTurns((prev) => {
        const next = [...prev];
        const cur = next[assistantIdx];
        if (!cur || cur.role !== 'assistant') return next;
        const parts = cleanTurnParts(cur.parts);
        // 「有内容」判定：有文本/工具/提问 part，或文本 part 含非空文字。
        const hasText = parts.some((p) => p.type === 'text' && p.content.trim().length > 0);
        const hasToolOrQuestion = parts.some((p) => p.type === 'tool' || p.type === 'question');
        const hasReasoning = parts.some((p) => p.type === 'reasoning' && p.content.trim().length > 0);
        // 兜底时追加一个 text part（保持链式渲染一致），而非写回旧 content。
        const withFallbackText = (msg: string, status: Turn['status']): Turn => ({
          ...cur,
          parts: [...parts, { type: 'text', content: msg }],
          streaming: false,
          status,
        });
        // 优先显示流中捕获的真实错误（part.type='error'），避免被空响应兜底掩盖。
        if (streamError) {
          next[assistantIdx] = withFallbackText(`调用失败：${streamError}`, 'failed');
        } else if (hasText || hasToolOrQuestion) {
          next[assistantIdx] = { ...cur, streaming: false, status: 'done' };
        } else if (stagedName) {
          // 工具步可见化（H1）：只调了 stage 没说话 → 补占位文本，配合右侧草稿面板。
          next[assistantIdx] = withFallbackText('已为你生成插件草稿，可在右侧预览并修改信息后提交。', 'done');
        } else if (hasReasoning || reasoningText.trim().length > 0) {
          // reasoning 兜底（H2）：只输出了思考过程没有正文（思考块已内联在气泡中可展开）。
          next[assistantIdx] = withFallbackText('模型仅输出了思考过程，可展开上方「思考过程」查看，或重试。', 'done');
        } else {
          // 空响应安全网：无文本、无工具、无思考 → 友好提示并标记失败。
          next[assistantIdx] = withFallbackText(
            sawToolCall ? '本轮未返回文字说明，请重试或换用高级版。' : '模型未返回内容，请重试或换用高级版。',
            'failed',
          );
        }
        return next;
      });
      if (stagedName) toast.success(`草稿「${stagedName}」已生成，可在右侧预览并提交`);
      else if (stageErrMsg) toast.error(stageErrMsg);
      else if (streamError) toast.error(`调用失败：${streamError}`); // 流错误也通过 toast 提醒
    } catch (e) {
      const aborted = (e as Error).name === 'AbortError';
      setUploadingViaTool(false);
      setSearchingQuery(null);
      setCompressing(false);
      // 提取真实错误消息：优先使用 error.message，兜底为通用提示。
      // Vercel AI SDK 在遇到上游错误时，可能会把错误包装在 Error 对象中，也可能直接抛字符串。
      let errorMsg = '生成失败';
      if (e instanceof Error) {
        errorMsg = e.message || errorMsg;
        // 某些情况下，AI SDK 会把原始响应包装在自定义属性中，尝试提取。
        const errWithCause = e as Error & { cause?: unknown };
        if (errWithCause.cause && typeof errWithCause.cause === 'object' && errWithCause.cause !== null && 'message' in errWithCause.cause) {
          errorMsg = String((errWithCause.cause as { message: unknown }).message) || errorMsg;
        }
      } else if (typeof e === 'string') {
        errorMsg = e;
      } else if (e && typeof e === 'object' && 'message' in e) {
        errorMsg = String((e as { message: unknown }).message) || errorMsg;
      }
      setTurns((prev) => {
        const next = [...prev];
        const cur = next[assistantIdx];
        if (cur && cur.role === 'assistant') {
          next[assistantIdx] = {
            role: 'assistant',
            content: aborted ? '（已取消）' : `调用失败：${errorMsg}`,
            streaming: false,
            status: aborted ? 'cancelled' : 'failed',
          };
        }
        return next;
      });
      if (!aborted) toast.error(errorMsg);
    } finally {
      setBusy(false);
      setSearchingQuery(null);
      setNetworkSlow(false);
      if (netSlowTimerRef.current) { clearInterval(netSlowTimerRef.current); netSlowTimerRef.current = null; }
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
    clearPendingAnswers();
  }

  function renderComposer(placement: 'hero' | 'bottom') {
    return (
      <CreatorComposer
        busy={busy}
        canInspectContext={!!contextBreakdown}
        embedded={embedded}
        input={input}
        onClearFiles={() => setSelectedFiles([])}
        onImportFiles={() => { void importFromSelectedFiles(); }}
        onOpenContext={() => setContextInspectorOpen(true)}
        onInputChange={setInput}
        onPickFiles={() => fileInputRef.current?.click()}
        onRemoveFile={removeFile}
        onSend={() => { void send(); }}
        onSelectReferencedPlugin={setReferencedPlugin}
        onSelectTier={setTier}
        onStop={stop}
        onToggleThinking={() => setThinking((v) => !v)}
        placement={placement}
        recentPlugins={recentPlugins}
        showContextButton={embedded}
        selectedFiles={selectedFiles}
        thinking={thinking}
        tier={tier}
        referencedPlugin={referencedPlugin}
      />
    );
  }

  function toggleSkill(id: string) {
    setActiveSkillIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  // R2：用户在提问卡片作答 → 标记 parts 的该 question 为 answered + 写 answer，并 resolve 悬挂的 deferred，
  // agent 多步循环据此继续。turnIdx 用于定位气泡。
  // 工具调用卡片：按 toolCallId 写入/更新 assistant 气泡的 parts（调用建卡，结果补状态）。
  function upsertToolPart(turnIdx: number, patch: { toolCallId: string; name: string; args?: unknown; result?: unknown; status: 'running' | 'ok' | 'error' }) {
    setTurns((prev) => {
      const next = [...prev];
      const cur = next[turnIdx];
      if (!cur || cur.role !== 'assistant') return next;
      const parts = cleanTurnParts(cur.parts);
      const idx = parts.findIndex((p) => p.type === 'tool' && p.toolCallId === patch.toolCallId);
      if (idx >= 0) {
        const existing = parts[idx] as ToolPart;
        parts[idx] = {
          ...existing,
          ...patch,
          // 结果阶段不覆盖已存的 args（tool-result 不带 input）。
          args: patch.args !== undefined ? patch.args : existing.args,
        };
      } else {
        parts.push({ type: 'tool', ...patch });
      }
      next[turnIdx] = { ...cur, parts };
      return next;
    });
  }

  // 文本增量：累积到 parts 末尾的 text part；若末尾不是 text（被 tool/reasoning/question 打断），则开新 text 段。
  // 这样「输出→工具→再输出」会形成两个独立 text 块，保持链式时序。
  function appendTextDelta(turnIdx: number, delta: string) {
    setTurns((prev) => {
      const next = [...prev];
      const cur = next[turnIdx];
      if (!cur || cur.role !== 'assistant') return next;
      const parts = cleanTurnParts(cur.parts);
      const last = parts[parts.length - 1];
      if (last && last.type === 'text') {
        parts[parts.length - 1] = { ...last, content: last.content + delta };
      } else {
        parts.push({ type: 'text', content: delta });
      }
      next[turnIdx] = { ...cur, parts, status: 'generating' };
      return next;
    });
  }

  // 思考增量：累积到 parts 末尾未结束的 reasoning part；若末尾不是「未结束的 reasoning」则开新思考段。
  function appendReasoningDelta(turnIdx: number, delta: string) {
    setTurns((prev) => {
      const next = [...prev];
      const cur = next[turnIdx];
      if (!cur || cur.role !== 'assistant') return next;
      const parts = cleanTurnParts(cur.parts);
      const last = parts[parts.length - 1];
      if (last && last.type === 'reasoning' && !last.done) {
        parts[parts.length - 1] = { ...last, content: last.content + delta };
      } else {
        parts.push({ type: 'reasoning', content: delta });
      }
      next[turnIdx] = { ...cur, parts, status: 'generating' };
      return next;
    });
  }

  // 思考段结束：把 parts 末尾的 reasoning part 标记 done（停掉其 loading 指示）。
  function endReasoning(turnIdx: number) {
    setTurns((prev) => {
      const next = [...prev];
      const cur = next[turnIdx];
      if (!cur || cur.role !== 'assistant') return next;
      const parts = cleanTurnParts(cur.parts);
      const last = parts[parts.length - 1];
      if (last && last.type === 'reasoning' && !last.done) {
        parts[parts.length - 1] = { ...last, done: true };
        next[turnIdx] = { ...cur, parts };
      }
      return next;
    });
  }

  function answerQuestion(turnIdx: number, toolCallId: string, answer: string) {
    const trimmed = answer.trim();
    if (!trimmed) return;
    setTurns((prev) => {
      const next = [...prev];
      const cur = next[turnIdx];
      if (cur && cur.role === 'assistant' && cur.parts) {
        next[turnIdx] = {
          ...cur,
          parts: cleanTurnParts(cur.parts).map((p) =>
            p.type === 'question' && p.toolCallId === toolCallId ? { ...p, answer: trimmed, answered: true } : p,
          ),
        };
      }
      return next;
    });
    const deferred = pendingAnswersRef.current.get(toolCallId);
    if (deferred) {
      deferred.resolve({ answer: trimmed });
      pendingAnswersRef.current.delete(toolCallId);
    }
    setAnswerDrafts((prev) => { const n = { ...prev }; delete n[toolCallId]; return n; });
    setMultiSelectDrafts((prev) => { const n = { ...prev }; delete n[toolCallId]; return n; });
  }

  // 渲染提问卡片（从 parts 链式渲染中调用，turnIdx 用于作答定位）。
  function renderQuestionCard(p: QuestionPart, turnIdx: number) {
    const draftText = answerDrafts[p.toolCallId] ?? '';
    const selected = multiSelectDrafts[p.toolCallId] ?? [];
    const submitMulti = () => {
      if (!selected.length) return;
      const labels = selected
        .map((v) => p.options?.find((o) => o.value === v)?.label ?? v)
        .join('、');
      answerQuestion(turnIdx, p.toolCallId, labels);
    };
    return (
      <div key={p.toolCallId} className="mt-3 first:mt-0 rounded-xl border border-primary/20 bg-gradient-to-br from-primary/5 to-primary/10 p-4 shadow-sm backdrop-blur-sm">
        <div className="flex items-start gap-2">
          <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <span className="text-xs font-bold">?</span>
          </div>
          <div className="flex-1 text-sm font-medium">{p.question}</div>
        </div>
        {p.answered ? (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-green-600/20 bg-green-50/50 px-3 py-2 dark:bg-green-950/20">
            <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-green-600" />
            <span className="text-xs text-muted-foreground">已回答：{p.answer}</span>
          </div>
        ) : (
          <div className="mt-3 space-y-2.5">
            {p.options && p.options.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {p.options.map((o) => {
                  const on = selected.includes(o.value);
                  return (
                    <button
                      key={o.value}
                      type="button"
                      onClick={() => {
                        if (p.multiSelect) {
                          setMultiSelectDrafts((prev) => {
                            const cur = prev[p.toolCallId] ?? [];
                            return { ...prev, [p.toolCallId]: on ? cur.filter((v) => v !== o.value) : [...cur, o.value] };
                          });
                        } else {
                          answerQuestion(turnIdx, p.toolCallId, o.label);
                        }
                      }}
                      className={`rounded-full border px-3.5 py-1.5 text-xs font-medium transition-all ${on ? 'border-primary bg-primary text-primary-foreground shadow-sm' : 'border-border/60 bg-background/80 hover:border-primary/50 hover:bg-primary/5 hover:shadow-sm'}`}
                    >
                      {o.label}
                    </button>
                  );
                })}
              </div>
            )}
            {p.multiSelect && p.options && p.options.length > 0 && (
              <Button size="sm" className="h-8 gap-1.5 px-3.5 text-xs shadow-sm" disabled={!selected.length} onClick={submitMulti}>
                <CheckCircle2Icon className="size-3.5" />
                确认选择
              </Button>
            )}
            {/* 兜底：allowFreeText 为真，或既无选项也不允许自由输入（防死锁——否则卡片无任何作答控件，deferred 永不 resolve）时，都给自由输入框。 */}
            {(p.allowFreeText || !(p.options && p.options.length > 0)) && (
              <div className="flex items-end gap-2">
                <Textarea
                  placeholder="或在此输入你的回答…"
                  value={draftText}
                  onChange={(e) => setAnswerDrafts((prev) => ({ ...prev, [p.toolCallId]: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); answerQuestion(turnIdx, p.toolCallId, draftText); } }}
                  rows={1}
                  className="min-h-[36px] max-h-24 resize-none rounded-lg border-border/60 text-sm shadow-sm"
                />
                <Button size="sm" className="h-9 gap-1.5 px-3.5 text-xs shadow-sm" disabled={!draftText.trim()} onClick={() => answerQuestion(turnIdx, p.toolCallId, draftText)}>
                  <SendIcon className="size-3.5" />
                  提交
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <>
    {/* 隐藏文件输入：支持文件夹（webkitdirectory）+ 多文件选择，可多次累积。 */}
    <input
      ref={fileInputRef}
      type="file"
      // webkitdirectory 为非标准属性，React 不识别故用 ref 透传；选目录时浏览器给目录下全部文件。
      {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
      multiple
      className="hidden"
      onChange={(e) => { handleFileSelect(e.target.files); e.target.value = ''; }}
    />
    <div className={cn(
      embedded
        ? 'flex h-full min-h-0 w-full bg-background'
        : 'fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-md animate-in fade-in duration-[var(--lf-dur-base)] motion-reduce:animate-none',
    )}>
      <div className={cn(
        'flex w-full overflow-hidden bg-background transition-[max-width] duration-300',
        embedded
          ? 'h-full min-h-0 border-0 shadow-none'
          : `h-[85vh] max-h-[800px] ${draft ? 'max-w-[1320px]' : 'max-w-[1100px]'} min-h-[480px] flex-col rounded-2xl border shadow-2xl animate-in zoom-in-95 fade-in slide-in-from-bottom-2 motion-reduce:animate-none`,
      )}>
        {!embedded && (
          <CreatorFloatingTitleBar
            activeSkillCount={activeSkillIds.length}
            busy={busy}
            canInspectContext={!!contextBreakdown}
            compressedHint={compressedHint}
            onClose={onClose}
            onNewConversation={newConversation}
            onOpenContext={() => setContextInspectorOpen(true)}
            onOpenHistory={() => setHistoryOpen(true)}
            onOpenSkills={() => setSkillDialogOpen(true)}
            onSelectReferencedPlugin={setReferencedPlugin}
            onSelectTier={setTier}
            recentPlugins={recentPlugins}
            referencedPlugin={referencedPlugin}
            tier={tier}
            turnsCount={turns.length}
          />
        )}

        {/* 主体：左对话列 + 右草稿面板（有草稿时分栏） */}
        <div className="flex min-h-0 flex-1">
          {embedded && (
          <CreatorWorkspaceSidebar
            activeSkillCount={activeSkillIds.length}
            activeConversationId={activeConversationId}
            busy={busy}
            collapsed={sidebarCollapsed}
            compressedHint={compressedHint}
            confirmDeleteId={confirmDeleteId}
            conversations={conversations}
            onCancelDeleteConversation={() => setConfirmDeleteId(null)}
            onConfirmDeleteConversation={deleteConversation}
            onDeleteConversation={setConfirmDeleteId}
            onNewConversation={newConversation}
            onOpenSkills={() => setSkillDialogOpen(true)}
            onSelectConversation={selectConversationById}
          />
        )}
          <div className="flex min-w-0 flex-1 flex-col">
        {/* 对话区 */}
        <div ref={scrollRef} className={cn('min-h-0 flex-1 overflow-y-auto px-6 py-6', embedded && 'px-8 py-8')}>
          {turns.length === 0 ? (
            <CreatorEmptyState
              composer={embedded ? null : renderComposer('hero')}
              embedded={embedded}
              onSelectPreset={setInput}
            />
          ) : (
            <div className="mx-auto flex max-w-3xl flex-col gap-4">
              {turns.map((t, i) => (
                <div key={i} className={`flex ${t.role === 'user' ? 'justify-end' : 'justify-start'} animate-in fade-in slide-in-from-bottom-2 duration-300`}>
                  {t.role === 'user' ? (
                    <div className="group relative max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-gradient-to-br from-primary to-primary/90 px-4 py-2.5 text-sm text-primary-foreground shadow-sm">
                      <CreatorCopyButton text={t.content} className="bg-primary-foreground/20 text-primary-foreground hover:bg-primary-foreground/30 hover:text-primary-foreground" />
                      {t.content}
                    </div>
                  ) : (
                    // 链式渲染（OpenCodeUI 式）：每个 part 是独立卡片（思考一张、内容一张、工具一张…），纵向堆叠。
                    (cleanTurnParts(t.parts).length > 0) ? (
                      <div className="flex w-full max-w-[92%] flex-col gap-2">
                        {cleanTurnParts(t.parts).map((p, pi) => {
                          if (p.type === 'reasoning') {
                            return (
                              <details key={`r-${pi}`} className="mt-1 overflow-hidden rounded-lg border border-border/30 bg-card/60 text-xs" open={!p.done && t.streaming}>
                                <summary className="flex cursor-pointer items-center gap-1.5 px-3 py-2 text-muted-foreground/70 transition-colors hover:bg-muted/25 hover:text-muted-foreground">
                                  {!p.done && t.streaming ? 'Thinking...' : 'Thinking'}
                                  {!p.done && t.streaming && <Loader2Icon className="size-2.5 animate-spin" />}
                                </summary>
                                <div className="max-h-36 overflow-y-auto whitespace-pre-wrap border-t border-border/20 bg-muted/10 px-3 py-2 font-mono text-[10px] leading-relaxed text-muted-foreground/80">
                                  {p.content}
                                </div>
                              </details>
                            );
                          }
                          if (p.type === 'text') {
                            if (!p.content.trim()) return null;
                            return (
                              <div key={`t-${pi}`} className="group relative overflow-hidden rounded-lg border border-border/30 bg-card/70 px-4 py-3 text-sm text-foreground shadow-sm">
                                <CreatorCopyButton text={p.content} />
                                {/* break-words：错误信息（含上游根因、URL、长串）需正确换行，不撑破气泡。 */}
                                <div className="break-words">
                                  <Markdown>{p.content}</Markdown>
                                </div>
                              </div>
                            );
                          }
                          if (p.type === 'tool') {
                            return <ToolCallCard key={p.toolCallId} data={p} />;
                          }
                          // question part
                          return renderQuestionCard(p, i);
                        })}
                        <CreatorRetryButton busy={busy} status={t.status} streaming={t.streaming} onRetry={() => { void retry(); }} />
                      </div>
                    ) : (
                      // 向后兼容 / 兜底：旧会话只有 content 或无任何 part 时，单个气泡渲染。
                      <div className="creator-assistant-bubble group relative max-w-[85%] overflow-hidden rounded-2xl border border-border/40 bg-gradient-to-br from-background to-muted/30 px-4 py-3 text-sm text-foreground shadow-sm backdrop-blur-sm">
                        {t.content && <CreatorCopyButton text={t.content} />}
                        {t.content ? (
                          <Markdown>{t.content}</Markdown>
                        ) : t.status === 'failed' ? (
                          <span className="text-destructive">调用失败</span>
                        ) : t.status === 'cancelled' ? (
                          <span className="text-muted-foreground">已取消</span>
                        ) : !t.streaming ? (
                          <span className="text-muted-foreground">无内容</span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-muted-foreground"><Loader2Icon className="size-3.5 animate-spin" />生成中…</span>
                        )}
                        <CreatorRetryButton busy={busy} status={t.status} streaming={t.streaming} onRetry={() => { void retry(); }} />
                      </div>
                    )
                  )}
                </div>
              ))}
            </div>
          )}
          {/* 保存成功卡片：用户在右侧面板点保存、草稿保存成功后告知「已保存到本地」 */}
          {publishedName && (
            <div className="mx-auto mt-6 max-w-3xl animate-in fade-in slide-in-from-bottom-4 duration-500">
              <div className="flex items-start gap-4 rounded-2xl border border-green-600/30 bg-gradient-to-br from-green-50 to-green-100/50 p-4 shadow-lg backdrop-blur-sm dark:from-green-950/30 dark:to-green-900/20">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-green-600 shadow-md">
                  <CheckCircle2Icon className="size-5 text-white" />
                </div>
                <div className="flex-1 space-y-1">
                  <div className="font-semibold text-green-900 dark:text-green-100">草稿「{publishedName}」已保存到本地</div>
                  <div className="text-sm text-green-800/80 dark:text-green-200/70">已保存到本地插件目录，可在插件中心「我的草稿」查看、运行和发布到团队。点击「+ 新建对话」继续创建下一个插件。</div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* #3 思考流式输出已改为内联在 assistant 气泡中按时序链式展示（见 parts 渲染），
            此处不再重复渲染底部全局思考条。reasoning state 仅用于流末兜底判定。 */}

        {/* 任务清单（底部折叠抽屉）：钉在对话区底部，默认折叠成窄横条，不占对话滚动空间。
            有任务时才显示；点击向上展开明细。 */}
        {todos.length > 0 && <TodoPanel todos={todos} streaming={busy} />}

        {/* #1 上下文用量条（contextWindow 配好后显示百分比） */}
        {contextWindow && turns.length > 0 && (
          <div className="shrink-0 border-t bg-muted/20 px-6 py-2">
            <div className="mx-auto max-w-3xl">
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span className="font-medium">上下文用量</span>
                <div className="flex items-center gap-2">
                  <span className="tabular-nums">{usedTokens.toLocaleString()} / {contextWindow.toLocaleString()} token（{usagePct}%）{usagePct > 80 && <span className="ml-1 text-amber-600 dark:text-amber-400">· 即将自动压缩</span>}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setContextInspectorOpen(true)}
                    className="h-6 gap-1 px-2 text-[10px]"
                  >
                    <EyeIcon className="size-3" />
                    查看
                  </Button>
                </div>
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted/60 shadow-inner">
                <div className={`h-full rounded-full transition-all duration-300 ${usagePct > 80 ? 'bg-gradient-to-r from-amber-500 to-amber-600' : 'bg-gradient-to-r from-primary to-primary/80'} shadow-sm`} style={{ width: `${usagePct}%` }} />
              </div>
            </div>
          </div>
        )}

        {/* 状态指示（压缩中 / 联网搜索中 / agent 工具上传中 / 网络慢） */}
        {(compressing || searchingQuery != null || uploadingViaTool || networkSlow) && (
          <div className={`shrink-0 border-t px-6 py-2.5 ${networkSlow ? 'bg-gradient-to-r from-amber-50/60 via-orange-50/60 to-amber-50/60 dark:from-amber-950/20 dark:via-orange-950/20 dark:to-amber-950/20' : 'bg-gradient-to-r from-blue-50/50 via-indigo-50/50 to-blue-50/50 dark:from-blue-950/20 dark:via-indigo-950/20 dark:to-blue-950/20'}`}>
            <div className="mx-auto flex max-w-3xl items-center gap-2 text-xs text-muted-foreground">
              <Loader2Icon className={`size-3.5 animate-spin ${networkSlow ? 'text-amber-600 dark:text-amber-400' : 'text-primary'}`} />
              <span className="font-medium">
                {networkSlow
                  ? '网络较慢，仍在等待响应…可点停止后重试'
                  : compressing
                    ? '正在压缩对话上下文…'
                    : searchingQuery != null
                      ? `正在联网搜索：${searchingQuery}…`
                      : 'AI 正在生成插件草稿…'}
              </span>
            </div>
          </div>
        )}

        {(embedded || turns.length > 0) && renderComposer('bottom')}
          </div>
          {/* 右侧草稿面板：AI 暂存草稿后出现，实时预览 + 改信息 + 提交 */}
          {draft && (
            <CreatorDraftPanel
              draft={draft}
              onChange={patchDraft}
              onSubmitted={onDraftSubmitted}
              busy={busy}
              conversationId={activeConversationId}
              turns={turns}
            />
          )}
        </div>
      </div>
    </div>
    <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>对话历史</DialogTitle>
          <DialogDescription>选择历史对话后可继续之前的会话。</DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs text-muted-foreground">最多保留最近 30 条</div>
          <Button variant="outline" size="sm" onClick={newConversation}>
            <PlusIcon className="size-3.5" />新建对话
          </Button>
        </div>
        <div className="max-h-[48vh] space-y-1 overflow-y-auto">
          {conversations.length ? pagedConversations.map((conversation) => (
            <div
              key={conversation.id}
              className={`group relative flex items-center gap-2 rounded-md border px-3 py-2 transition-colors ${conversation.id === activeConversationId ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:bg-muted'}`}
            >
              <button
                type="button"
                onClick={() => selectConversation(conversation)}
                className="min-w-0 flex-1 text-left"
                title={conversation.title}
              >
                <span className="block truncate text-sm font-medium">{conversation.title}</span>
                <span className="block text-xs text-muted-foreground">{new Date(conversation.updatedAt).toLocaleString('zh-CN', { hour12: false })}</span>
              </button>
              {confirmDeleteId === conversation.id ? (
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="destructive"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={(e) => { e.stopPropagation(); deleteConversation(conversation.id); }}
                  >
                    确认删除
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(null); }}
                  >
                    取消
                  </Button>
                </div>
              ) : (
                <button
                  type="button"
                  title="删除该对话"
                  onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(conversation.id); }}
                  className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-all hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                >
                  <Trash2Icon className="size-3.5" />
                </button>
              )}
            </div>
          )) : <div className="py-8 text-center text-sm text-muted-foreground">暂无历史对话</div>}
        </div>
        {conversations.length > PAGE_SIZE && (
          <div className="flex items-center justify-between gap-2 pt-1">
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={historyPage <= 0}
              onClick={() => setHistoryPage((p) => Math.max(0, p - 1))}
            >
              上一页
            </Button>
            <span className="text-xs text-muted-foreground tabular-nums">第 {historyPage + 1} / {pageCount} 页</span>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={historyPage >= pageCount - 1}
              onClick={() => setHistoryPage((p) => Math.min(pageCount - 1, p + 1))}
            >
              下一页
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
    <Dialog open={skillDialogOpen} onOpenChange={setSkillDialogOpen}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>技能</DialogTitle>
          <DialogDescription>按需开启，让 AI 生成更符合预期的插件。</DialogDescription>
        </DialogHeader>
        <div className="max-h-[56vh] space-y-2 overflow-y-auto">
          {SKILLS.map((s) => {
            const checked = activeSkillIds.includes(s.id);
            return (
              <label
                key={s.id}
                className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${checked ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted'}`}
              >
                <Checkbox checked={checked} onCheckedChange={() => toggleSkill(s.id)} className="mt-0.5" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{s.name}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">{s.description}</div>
                </div>
              </label>
            );
          })}
        </div>
        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={() => setSkillDialogOpen(false)}>完成</Button>
        </div>
      </DialogContent>
    </Dialog>

    {/* 上下文查看面板 */}
    <ContextInspector breakdown={contextBreakdown} open={contextInspectorOpen} onClose={() => setContextInspectorOpen(false)} modelTokens={usedTokens} contextWindow={contextWindow} />
    </>
  );
}
