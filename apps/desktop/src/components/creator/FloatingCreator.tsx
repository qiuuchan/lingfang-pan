// FloatingCreator —— 悬浮窗 + 对话式 + 流式 AI 插件创建器（Vercel AI SDK agent）。
//
//  - 悬浮窗：App 渲染为全屏遮罩 + 居中面板（~85vh），不切 view，关窗即回原页。
//  - 对话式：多轮聊天（用户/助手气泡），输入框在底部，Enter 发送。
//  - 流式 + agent：Vercel AI SDK streamText 走 relay；模型生成插件后**调用 stage_plugin 工具**暂存为草稿
//    （不直接发布）。草稿在右侧分栏实时预览，用户可改名字/信息、继续对话打磨，点「提交」才真正发布。
//  - 上下文自动压缩 + Skill 动态拼装系统提示词保留。
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { streamText, stepCountIs } from 'ai';
import { SparklesIcon, XIcon, SendIcon, Loader2Icon, WrenchIcon, BrainIcon, FileCode2Icon, PlusIcon, CheckCircle2Icon, HistoryIcon, Trash2Icon, FolderUpIcon, FileUpIcon } from 'lucide-react';
import { useApp } from '@/App';
import type { LoadedPlugin } from '@/lib/types';
import { api, type ApiError } from '@/lib/api';
import { relayProvider } from '@/lib/relay-provider';
import { createCreatorTools, type AskQuestionArgs, type AskQuestionResult, type StagedPlugin } from '@/lib/plugin-creator/creator-tools';
import { readLocalFiles, filesToStagedPlugin } from '@/lib/plugin-creator/import-local';
import { CreatorDraftPanel } from '@/components/creator/CreatorDraftPanel';
import { ToolCallCard } from '@/components/creator/ToolCallCard';
import { assembleSystemPrompt, DEFAULT_ACTIVE_SKILLS, SKILLS } from '@/lib/skills';
import { buildContextMessages, emptyCompressState } from '@/lib/plugin-creator/context-compress';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Markdown } from '@/components/markdown';

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
type TurnPart = QuestionPart | ToolPart;

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  /** 仅 assistant：本轮是否仍在流式输出中。 */
  streaming?: boolean;
  status?: 'generating' | 'done' | 'failed' | 'cancelled';
  /** 结构化片段：提问卡片 / 工具调用指示（R2/R1 复用）。 */
  parts?: TurnPart[];
}

interface CreatorConversation {
  id: string;
  title: string;
  turns: Turn[];
  createdAt: string;
  updatedAt: string;
}

const conversationKey = (userId: string | null, tenantId: string | null) => `lf:creator-conversations:${tenantId || userId || 'none'}`;
const selectedConversationKey = (userId: string | null, tenantId: string | null) => `lf:creator-selected:${tenantId || userId || 'none'}`;

function loadConversations(userId: string | null, tenantId: string | null): CreatorConversation[] {
  try {
    const raw = localStorage.getItem(conversationKey(userId, tenantId));
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((item) => item && typeof item.id === 'string' && Array.isArray(item.turns)) : [];
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

const SYSTEM_PROMPT = `你是灵坊平台的「插件生成 agent」。用户用自然语言描述需求，你通过调用工具自主完成插件的生成与打磨；用户预览满意后会自行点「提交」发布。

# 角色与目标
把模糊需求转成一个可运行、信息完整的插件草稿。你是 agent：能多步规划、主动调用工具、根据工具结果决定下一步，而不是一次性吐代码。

# 工作流程
1. 理解需求。信息不足、有歧义、或需在多方案间取舍时，**调用 ask_question** 结构化提问（能给 options 就给，减少用户打字），不要用纯文本提问。
2. 需要外部知识（最新 API、库用法、第三方服务、训练数据外的事实）时，**调用 web_search**，基于结果归纳后再动手。
3. 首次生成插件：**调用 stage_plugin** 暂存完整插件包为草稿（不要把代码作为普通文本输出）。
4. 后续修改：**优先用 patch_draft_file 增量改单个文件**，而不是 stage_plugin 整包重发——这样省 token、更精准，且保留用户已改的信息和未动的文件。
   - 改之前不确定结构/内容时，先 list_draft_files 看文件树，再 read_draft_file 读要改的文件。
   - 只有当插件要整体重构、或换成完全不同的插件时，才重新 stage_plugin。
5. 想避免重复造轮子或参考团队命名风格时，可调用 list_team_plugins。

# 工具一览
- ask_question(question, options?, allowFreeText?, multiSelect?) → { answer }
- web_search(query, limit?) → { ok, results:[{title,url,snippet,source}] }
- stage_plugin(id, name, version, description, runtime_type, entry, files) → { ok, message }
- list_draft_files() → { ok, files:[路径] }
- read_draft_file(path) → { ok, content }
- patch_draft_file(path, content) → { ok }（覆盖式写整文件，非 diff；自动刷新预览）
- list_team_plugins() → { ok, plugins:[{id,name,description,version,runtime_type}] }

# 插件包规范（stage_plugin）
- id：kebab-case，仅小写字母/数字/连字符。version 默认 0.1.0。
- runtime_type 与入口：
  - client → entry=ui/index.html（HTML 内联 CSS/JS）；
  - nodejs → entry=index.js，files 含 package.json（无依赖用 {}）与 index.js；
  - python → entry=main.py，files 含 requirements.txt（可空）与 main.py。
- entry 必须存在于 files。文件路径只能是相对路径，禁绝对路径/空段/../、禁隐藏段（. 开头）。
- 插件如需调用 AI，必须用灵坊平台 sdk.llm.chat / sdk.image.generate（见 relay-access skill），禁第三方接口。

# 回复风格
- 简洁。不复述工具已处理的完整文件内容（草稿已在右侧面板，用户看得到）。
- 工具失败时读 message 修正后重试，不要把原始报错堆给用户。
- 每完成一步用一两句话说清「做了什么、下一步建议」，把控制权交回用户。`;

/**
 * 上下文自动压缩见 lib/plugin-creator/context-compress.ts（超阈值时摘要早期对话轮，保留近期+插件包原文）。
 */
export function FloatingCreator({ onClose }: { onClose: () => void }) {
  const { session, recentPlugins, pendingAutoFix, setPendingAutoFix } = useApp();
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
  const [searchingQuery, setSearchingQuery] = useState<string | null>(null); // agent web_search 联网搜索中指示（展示关键词）
  const [compressedHint, setCompressedHint] = useState(0); // 上次压缩的轮数（UI 指示）
  const [publishedName, setPublishedName] = useState<string | null>(null); // 已发布插件名（用户提交成功后显示成功卡片）
  // 草稿态：AI stage_plugin 暂存的插件 + 用户的手动编辑（覆盖 AI 字段，跨重新生成保留）。
  // stagedDraft 是 AI 最新生成的原始草稿；userEdits 是用户在右侧面板改过的字段。
  // 二者合并成展示用 draft；AI 重新 stage 同一 id 时 userEdits 保留，换 id 则清空。
  const [stagedDraft, setStagedDraft] = useState<StagedPlugin | null>(null);
  const [userEdits, setUserEdits] = useState<Partial<StagedPlugin>>({});
  const [contextWindow, setContextWindow] = useState<number | null>(null); // 当前 tier 模型的上下文窗口（token）
  const [reasoning, setReasoning] = useState(''); // 当前轮思考内容流式累积（支持思考输出的模型）
  const compressRef = useRef(emptyCompressState());
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null); // 文件夹导入（webkitdirectory）
  const fileInputRef = useRef<HTMLInputElement>(null); // 文件导入（multiple）
  // R2：悬挂的 ask_question deferred —— 用户作答后 resolve（人在环）。
  // key=toolCallId，存 resolve/reject；切对话/取消/关窗时必须清掉防卡死。
  const pendingAnswersRef = useRef<Map<string, { resolve: (r: AskQuestionResult) => void; reject: (e: unknown) => void }>>(new Map());
  // 提问卡片的自由文本输入暂存（key=toolCallId）。
  const [answerDrafts, setAnswerDrafts] = useState<Record<string, string>>({});
  // 多选暂存（key=toolCallId → 已选 value 集合）。
  const [multiSelectDrafts, setMultiSelectDrafts] = useState<Record<string, string[]>>({});

  // R2：清理所有悬挂的提问 deferred（取消/切对话/关窗时调用），避免 streamText 卡死。
  function clearPendingAnswers() {
    for (const [, d] of pendingAnswersRef.current) {
      try { d.reject(new DOMException('cancelled', 'AbortError')); } catch { /* ignore */ }
    }
    pendingAnswersRef.current.clear();
  }

  // 展示用草稿 = AI 暂存的原始草稿叠加用户的手动编辑（用户改过的字段优先）。
  const draft: StagedPlugin | null = stagedDraft ? { ...stagedDraft, ...userEdits } : null;

  // stage_plugin 工具回调：AI 暂存草稿到右侧面板。
  // 同一插件 id 重新 stage（用户让 AI 改后再生成）保留用户已改的字段；换 id（新插件）则清空旧编辑。
  function onStagePlugin(next: StagedPlugin) {
    setStagedDraft((prev) => {
      if (prev && prev.id !== next.id) setUserEdits({});
      return next;
    });
  }

  // 用户在右侧面板编辑信息 → 累积到 userEdits（覆盖 AI 字段）。
  function patchDraft(patch: Partial<StagedPlugin>) {
    setUserEdits((prev) => ({ ...prev, ...patch }));
  }

  // 草稿 ref：供 agent 工具（read/list/patch_draft_file）读取最新草稿，避免 streamText 闭包读到旧值。
  const draftRef = useRef<StagedPlugin | null>(draft);
  useEffect(() => { draftRef.current = draft; }, [draft]);

  // patch_draft_file 工具回调：新增/覆盖草稿单个文件，合并进 stagedDraft 并刷新预览（保留其余文件与用户编辑）。
  function onPatchDraftFile(path: string, content: string) {
    setStagedDraft((prev) => {
      // 无 base 草稿不应发生（工具已校验），保险起见忽略。
      if (!prev) return prev;
      const files = prev.files.some((f) => f.path === path)
        ? prev.files.map((f) => (f.path === path ? { ...f, content } : f))
        : [...prev.files, { path, content }];
      return { ...prev, files };
    });
  }

  // 提交成功：清草稿态，显示成功卡片，刷新最近插件。
  function onDraftSubmitted(name: string) {
    setPublishedName(name);
    setStagedDraft(null);
    setUserEdits({});
    toast.success(`插件「${name}」已提交到团队空间`);
  }

  // 从本地文件/文件夹导入插件 → 转草稿进入预览/改信息/提交流程（移植已有插件）。
  async function handleImport(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    try {
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
  }, [session.userId, session.tenantId]);

  useEffect(() => {
    if (!activeConversationId || turns.length === 0) return;
    setConversations((prev) => {
      const now = new Date().toISOString();
      const next = prev.map((conversation) => conversation.id === activeConversationId ? { ...conversation, turns, updatedAt: now } : conversation);
      saveConversations(session.userId, session.tenantId, next);
      return next;
    });
  }, [activeConversationId, session.tenantId, session.userId, turns]);

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
    setStagedDraft(null);
    setUserEdits({});
    compressRef.current = emptyCompressState();
    try { localStorage.setItem(selectedConversationKey(session.userId, session.tenantId), conversation.id); } catch { /* ignore */ }
    setHistoryOpen(false);
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

  // 粗估当前对话 token 用量（≈ 全部 turns 字符数 / 3.5，中英文混合近似）。
  const usedTokens = Math.round(turns.reduce((s, t) => s + t.content.length, 0) / 3.5);
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
  // 必须 abort，否则关窗时若仍在 text-delta 流式中，底层 relay 请求会在后台续跑并继续按团队计费（费用泄漏）。
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

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    ensureConversation(text);
    const userTurn: Turn = { role: 'user', content: text };
    const assistantIdx = turns.length + 1;
    setTurns((prev) => [...prev, userTurn, { role: 'assistant', content: '', streaming: true, status: 'generating' }]);
    setBusy(true);

    const controller = new AbortController();
    abortRef.current = controller;

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
      // 当前草稿注入：stage_plugin 的文件全文不在对话历史里（只在工具参数中），多轮修改时 AI 看不到上一版代码。
      // 故把当前草稿（含用户在右侧改过的名字/信息）全文注入 systemPrompt，让 AI 基于它增量修改后再次 stage_plugin。
      const draftPrompt = draft?.files?.length
        ? `\n\n# 当前草稿（用户正在预览，要在此基础上修改）\n` +
          `id：${draft.id}\n名字：${draft.name}\n版本：${draft.version}\n描述：${draft.description}\n` +
          `runtime_type：${draft.runtime_type}\nentry：${draft.entry}\n` +
          `请基于以下文件按用户新需求做增量修改（保留未变部分），改完**再次调用 stage_plugin 更新草稿**。` +
          `若用户改了名字/描述等元信息（见上方），沿用这些值，不要擅自改回。\n\n当前文件：\n` +
          draft.files.map((f) => `--- ${f.path} ---\n${f.content}`).join('\n\n')
        : '';
      const systemPrompt = basePrompt + thinkPrompt + refPrompt + draftPrompt;
      // 上下文自动压缩：超阈值时摘要较早对话轮（保留近期 + 含插件包的轮）。
      setCompressing(true);
      const built = await buildContextMessages({
        turns: turns.map((t) => ({ role: t.role, content: t.content })),
        currentInput: text,
        systemPrompt,
        state: compressRef.current,
        tier,
        signal: controller.signal,
      });
      setCompressing(false);
      compressRef.current = built.state;
      setCompressedHint(built.compressedCount);

      // R2：ask_question 人在环回调——写提问卡片到当前 assistant 气泡的 parts，
      // 返回 deferred Promise；用户在卡片作答后 resolve，streamText 多步循环继续。
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
            next[assistantIdx] = { ...cur, parts: [...(cur.parts ?? []), part] };
          }
          return next;
        });
        return new Promise<AskQuestionResult>((resolve, reject) => {
          pendingAnswersRef.current.set(toolCallId, { resolve, reject });
        });
      };

      // Vercel AI SDK：streamText 走 relay，工具调用让模型自己调 stage_plugin 暂存草稿 / ask_question 提问。
      // 文本 delta 流式累积进 assistant 气泡；tool-call/result 用独立指示器或 parts 卡片。
      const result = streamText({
        model: relayProvider().chat(tier),
        messages: built.messages,
        tools: createCreatorTools({
          onStagePlugin,
          onAskQuestion,
          getDraft: () => draftRef.current,
          onPatchDraft: onPatchDraftFile,
        }),
        // 调大步数：留给「生成→提问→作答→继续生成→可能再问/再暂存→总结」的多步循环。
        stopWhen: stepCountIs(8),
        abortSignal: controller.signal,
      });

      let stagedName = '';
      let stageErrMsg = '';
      let sawToolCall = false; // R1：本轮是否有过工具调用（含 ask_question/stage）
      let reasoningText = ''; // 本轮思考累积（流末兜底判定用，避免读 reasoning state 的陈旧闭包）
      setReasoning('');
      for await (const part of result.fullStream) {
        if (part.type === 'reasoning-delta') {
          // #3 思考流式输出：部分模型支持 reasoning（Claude/OpenAI o-series），把思考增量单独累积展示。
          const delta = (part as { text?: string; delta?: string }).text ?? (part as { delta?: string }).delta ?? '';
          reasoningText += delta;
          setReasoning((prev) => prev + delta);
        } else if (part.type === 'reasoning-end') {
          // 思考结束：不自动清——保留供用户展开查看（下轮 send 时 setReasoning('') 清空）。
        } else if (part.type === 'text-delta') {
          const delta = part.text;
          setTurns((prev) => {
            const next = [...prev];
            const cur = next[assistantIdx];
            if (cur && cur.role === 'assistant') next[assistantIdx] = { ...cur, content: cur.content + delta, status: 'generating' };
            return next;
          });
        } else if (part.type === 'tool-call') {
          sawToolCall = true;
          // 记录工具调用卡片（ask_question 除外——它已由 onAskQuestion 写成提问卡片，避免重复）。
          if (part.toolName !== 'ask_question') {
            upsertToolPart(assistantIdx, { toolCallId: part.toolCallId, name: part.toolName, args: part.input, status: 'running' });
          }
          // 兼容旧的全局指示器（顶部状态条）。
          if (part.toolName === 'stage_plugin') setUploadingViaTool(true);
          else if (part.toolName === 'web_search') {
            const q = (part.input as { query?: string } | undefined)?.query ?? '';
            setSearchingQuery(q || '联网搜索中');
          }
        } else if (part.type === 'tool-result') {
          const output = part.output as { ok?: boolean } | undefined;
          if (part.toolName !== 'ask_question') {
            upsertToolPart(assistantIdx, { toolCallId: part.toolCallId, name: part.toolName, result: part.output, status: output?.ok === false ? 'error' : 'ok' });
          }
          if (part.toolName === 'stage_plugin') {
            setUploadingViaTool(false);
            const r = part.output as { ok: boolean; message: string; name?: string } | undefined;
            if (r?.ok && r.name) stagedName = r.name;
            else if (r && !r.ok) stageErrMsg = r.message;
          } else if (part.toolName === 'web_search') {
            setSearchingQuery(null);
          }
          // ask_question 的 tool-result：作答已由提交回调标记 answered，无需额外处理。
        }
      }
      // 流结束：清除流式标记（保留已累积的 delta 文本，不覆盖——result.text 是末步，会丢中间步骤）。
      // 多步 agent 的各步文本已通过 fullStream 累积进气泡；末步总结也已 delta 进来。
      // R1 前端兜底：流正常结束但 content 为空时，避免裸露「无内容」——按情形给友好提示。
      setTurns((prev) => {
        const next = [...prev];
        const cur = next[assistantIdx];
        if (!cur || cur.role !== 'assistant') return next;
        const hasContent = cur.content.trim().length > 0;
        const hasParts = (cur.parts?.length ?? 0) > 0; // 提问卡片等结构化内容也算「有内容」
        if (hasContent || hasParts) {
          next[assistantIdx] = { ...cur, streaming: false, status: 'done' };
        } else if (stagedName) {
          // 工具步可见化（H1）：只调了 stage 没说话 → 补占位文本，配合右侧草稿面板。
          next[assistantIdx] = { ...cur, content: '已为你生成插件草稿，可在右侧预览并修改信息后提交。', streaming: false, status: 'done' };
        } else if (reasoningText.trim().length > 0) {
          // reasoning 兜底（H2）：只输出了思考过程没有正文（用本轮累积的 reasoningText，非 state 闭包）。
          next[assistantIdx] = { ...cur, content: '模型仅输出了思考过程，可展开下方「思考过程」查看，或重试。', streaming: false, status: 'done' };
        } else {
          // 空响应安全网：无文本、无工具、无思考 → 友好提示并标记失败。
          next[assistantIdx] = {
            ...cur,
            content: sawToolCall ? '本轮未返回文字说明，请重试或换用高级版。' : '模型未返回内容，请重试或换用高级版。',
            streaming: false,
            status: 'failed',
          };
        }
        return next;
      });
      if (stagedName) toast.success(`草稿「${stagedName}」已生成，可在右侧预览并提交`);
      else if (stageErrMsg) toast.error(stageErrMsg);
    } catch (e) {
      const aborted = (e as Error).name === 'AbortError';
      setUploadingViaTool(false);
      setSearchingQuery(null);
      setCompressing(false);
      setTurns((prev) => {
        const next = [...prev];
        const cur = next[assistantIdx];
        if (cur && cur.role === 'assistant') next[assistantIdx] = { role: 'assistant', content: aborted ? '（已取消）' : `调用失败：${(e as Error).message}`, streaming: false, status: aborted ? 'cancelled' : 'failed' };
        return next;
      });
      if (!aborted) toast.error((e as ApiError).message || '生成失败');
    } finally {
      setBusy(false);
      setSearchingQuery(null);
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
    clearPendingAnswers();
  }

  function toggleSkill(id: string) {
    setActiveSkillIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  // R2：用户在提问卡片作答 → 标记 parts 的该 question 为 answered + 写 answer，并 resolve 悬挂的 deferred，
  // streamText 多步循环据此继续。turnIdx 用于定位气泡。
  // 工具调用卡片：按 toolCallId 写入/更新 assistant 气泡的 parts（tool-call 建卡，tool-result 补结果+状态）。
  function upsertToolPart(turnIdx: number, patch: { toolCallId: string; name: string; args?: unknown; result?: unknown; status: 'running' | 'ok' | 'error' }) {
    setTurns((prev) => {
      const next = [...prev];
      const cur = next[turnIdx];
      if (!cur || cur.role !== 'assistant') return next;
      const parts = [...(cur.parts ?? [])];
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

  function answerQuestion(turnIdx: number, toolCallId: string, answer: string) {
    const trimmed = answer.trim();
    if (!trimmed) return;
    setTurns((prev) => {
      const next = [...prev];
      const cur = next[turnIdx];
      if (cur && cur.role === 'assistant' && cur.parts) {
        next[turnIdx] = {
          ...cur,
          parts: cur.parts.map((p) =>
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

  return (
    <>
    {/* 隐藏文件输入：文件夹（webkitdirectory）+ 多文件。导入后转草稿。 */}
    <input
      ref={folderInputRef}
      type="file"
      // webkitdirectory 为非标准属性，React 不识别故用 ref 透传；选目录时浏览器给目录下全部文件。
      {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
      multiple
      className="hidden"
      onChange={(e) => { void handleImport(e.target.files); e.target.value = ''; }}
    />
    <input
      ref={fileInputRef}
      type="file"
      multiple
      className="hidden"
      onChange={(e) => { void handleImport(e.target.files); e.target.value = ''; }}
    />
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-md animate-in fade-in duration-[var(--lf-dur-base)] motion-reduce:animate-none">
      <div className={`flex h-[85vh] max-h-[800px] w-full ${draft ? 'max-w-[1540px]' : 'max-w-[1100px]'} min-h-[480px] flex-col overflow-hidden rounded-2xl border bg-background shadow-2xl transition-[max-width] duration-300 animate-in zoom-in-95 fade-in slide-in-from-bottom-2 motion-reduce:animate-none`}>
        {/* 标题栏 */}
        <div className="flex shrink-0 items-center justify-between border-b px-4 py-2.5">
          <div className="flex items-center gap-2">
            <SparklesIcon className="size-4 text-primary" />
            <span className="text-sm font-medium">AI 创建插件</span>
          </div>
          <div className="flex items-center gap-2">
            {/* 上下文自动压缩指示：超阈值时把早期对话轮摘要，保留近期+插件包。 */}
            {compressedHint > 0 && (
              <Badge variant="outline" className="gap-1 text-xs" title="早期对话已自动摘要为上下文，控制 token">
                已压缩 {compressedHint} 轮
              </Badge>
            )}
            {turns.length > 0 && (
              <Button variant="outline" size="sm" className="gap-1.5" title="新建对话" onClick={newConversation}>
                <PlusIcon className="size-3.5" />
                新建对话
              </Button>
            )}
            <Button variant="outline" size="sm" className="gap-1.5" title="对话历史" onClick={() => setHistoryOpen(true)}>
              <HistoryIcon className="size-3.5" />
              历史
            </Button>
            {/* 导入本地插件（移植）：文件夹 / 文件两种入口，读取后进草稿态预览/改信息/提交 */}
            <Popover>
              <PopoverTrigger render={<Button variant="outline" size="sm" className="gap-1.5" title="从电脑导入已有插件" />}>
                <FolderUpIcon className="size-3.5" />
                导入
              </PopoverTrigger>
              <PopoverContent className="w-52" align="end">
                <div className="text-xs font-medium text-muted-foreground">从电脑导入已有插件</div>
                <div className="mt-1.5 space-y-0.5">
                  <button
                    type="button"
                    onClick={() => folderInputRef.current?.click()}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted"
                  >
                    <FolderUpIcon className="size-3.5 shrink-0" />
                    选择文件夹
                  </button>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted"
                  >
                    <FileUpIcon className="size-3.5 shrink-0" />
                    选择文件
                  </button>
                </div>
                <div className="mt-1.5 text-[11px] text-muted-foreground">读取插件源码后可预览、改信息再提交。</div>
              </PopoverContent>
            </Popover>
            {/* 引用插件：选一个已有插件注入源码到上下文，让 agent 基于现有代码修改（#4） */}
            {recentPlugins.length > 0 && (
              <Popover>
                <PopoverTrigger render={<Button variant={referencedPlugin ? 'default' : 'outline'} size="sm" className="gap-1.5" title="引用已有插件做修改" />}>
                  <FileCode2Icon className="size-3.5" />
                  {referencedPlugin ? referencedPlugin.name.slice(0, 8) : '引用插件'}
                </PopoverTrigger>
                <PopoverContent className="w-64" align="end">
                  <div className="text-xs font-medium text-muted-foreground">引用已有插件（注入源码到上下文）</div>
                  <div className="mt-1.5 max-h-60 space-y-0.5 overflow-y-auto">
                    {recentPlugins.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => { setReferencedPlugin(referencedPlugin?.id === p.id ? null : p); }}
                        className={`block w-full truncate rounded px-2 py-1.5 text-left text-sm transition-colors ${referencedPlugin?.id === p.id ? 'bg-primary/10 text-primary' : 'hover:bg-muted'}`}
                        title={p.name}
                      >
                        {p.name}
                      </button>
                    ))}
                  </div>
                  {referencedPlugin && (
                    <button type="button" onClick={() => setReferencedPlugin(null)} className="mt-1.5 w-full rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted">取消引用</button>
                  )}
                </PopoverContent>
              </Popover>
            )}
            {/* 创建偏好（原 Skill）：改为居中悬浮窗（R3），去专业术语。 */}
            <Button variant="outline" size="sm" className="gap-1.5" title="创建偏好" onClick={() => setSkillDialogOpen(true)}>
              <WrenchIcon className="size-3.5" />
              创建偏好
              {activeSkillIds.length > 0 && <Badge variant="secondary" className="h-4 px-1 text-[10px]">{activeSkillIds.length}</Badge>}
            </Button>
            {/* 版本切换 */}
            <div className="flex rounded-md border p-0.5">
              {(['fast', 'premium'] as const).map((t) => (
                <button key={t} type="button" onClick={() => setTier(t)} disabled={busy} className={`rounded px-2 py-0.5 text-xs transition-colors ${tier === t ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}>
                  {t === 'fast' ? '⚡快速' : '✦高级'}
                </button>
              ))}
            </div>
            <button type="button" onClick={onClose} aria-label="关闭" className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
              <XIcon className="size-4" />
            </button>
          </div>
        </div>

        {/* 主体：左对话列 + 右草稿面板（有草稿时分栏） */}
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
        {/* 对话区 */}
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {turns.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <SparklesIcon className="size-8 text-primary" />
              <div className="text-sm text-muted-foreground">描述你想做的插件，AI 流式生成。多轮可追问修改。</div>
              <div className="flex flex-wrap justify-center gap-2">
                {['番茄钟插件', 'Markdown 速记', '配色生成器'].map((s) => (
                  <button key={s} type="button" onClick={() => setInput(s)} className="rounded-full border px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted">{s}</button>
                ))}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                或
                <button type="button" onClick={() => folderInputRef.current?.click()} className="mx-1 text-primary underline-offset-2 hover:underline">导入本地文件夹</button>
                /
                <button type="button" onClick={() => fileInputRef.current?.click()} className="mx-1 text-primary underline-offset-2 hover:underline">文件</button>
                移植已有插件
              </div>
            </div>
          ) : (
            <div className="mx-auto flex max-w-3xl flex-col gap-3">
              {turns.map((t, i) => (
                <div key={i} className={`flex ${t.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  {t.role === 'user' ? (
                    <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-primary px-3.5 py-2 text-sm text-primary-foreground">
                      {t.content}
                    </div>
                  ) : (
                    <div className="creator-assistant-bubble max-w-[85%] overflow-hidden rounded-2xl bg-muted px-3.5 py-2 text-sm text-foreground">
                      {t.content ? (
                        <Markdown>{t.content}</Markdown>
                      ) : (t.parts?.some((p) => p.type === 'question')) ? null : t.status === 'failed' ? (
                        <span className="text-destructive">调用失败</span>
                      ) : t.status === 'cancelled' ? (
                        <span className="text-muted-foreground">已取消</span>
                      ) : !t.streaming ? (
                        <span className="text-muted-foreground">无内容</span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-muted-foreground"><Loader2Icon className="size-3 animate-spin" />生成中…</span>
                      )}
                      {/* R2：提问卡片（Claude 风格）—— 渲染在文本之后，可作答并继续 agent 流程。 */}
                      {t.parts?.map((p) => {
                        if (p.type === 'tool') {
                          return <ToolCallCard key={p.toolCallId} data={p} />;
                        }
                        if (p.type !== 'question') return null;
                        const draft = answerDrafts[p.toolCallId] ?? '';
                        const selected = multiSelectDrafts[p.toolCallId] ?? [];
                        const submitMulti = () => {
                          if (!selected.length) return;
                          const labels = selected
                            .map((v) => p.options?.find((o) => o.value === v)?.label ?? v)
                            .join('、');
                          answerQuestion(i, p.toolCallId, labels);
                        };
                        return (
                          <div key={p.toolCallId} className="mt-2 rounded-xl border bg-background p-3">
                            <div className="text-sm font-medium">{p.question}</div>
                            {p.answered ? (
                              <div className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
                                <CheckCircle2Icon className="mt-0.5 size-3.5 shrink-0 text-green-600" />
                                <span>已回答：{p.answer}</span>
                              </div>
                            ) : (
                              <div className="mt-2 space-y-2">
                                {p.options && p.options.length > 0 && (
                                  <div className="flex flex-wrap gap-1.5">
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
                                              answerQuestion(i, p.toolCallId, o.label);
                                            }
                                          }}
                                          className={`rounded-full border px-3 py-1 text-xs transition-colors ${on ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted'}`}
                                        >
                                          {o.label}
                                        </button>
                                      );
                                    })}
                                  </div>
                                )}
                                {p.multiSelect && p.options && p.options.length > 0 && (
                                  <Button size="sm" className="h-7 px-3 text-xs" disabled={!selected.length} onClick={submitMulti}>
                                    确认选择
                                  </Button>
                                )}
                                {/* 兜底：allowFreeText 为真，或既无选项也不允许自由输入（防死锁——否则卡片无任何作答控件，deferred 永不 resolve）时，都给自由输入框。 */}
                                {(p.allowFreeText || !(p.options && p.options.length > 0)) && (
                                  <div className="flex items-end gap-1.5">
                                    <Textarea
                                      placeholder="或在此输入你的回答…"
                                      value={draft}
                                      onChange={(e) => setAnswerDrafts((prev) => ({ ...prev, [p.toolCallId]: e.target.value }))}
                                      onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); answerQuestion(i, p.toolCallId, draft); } }}
                                      rows={1}
                                      className="min-h-[32px] max-h-24 resize-none text-sm"
                                    />
                                    <Button size="sm" className="h-8 px-3 text-xs" disabled={!draft.trim()} onClick={() => answerQuestion(i, p.toolCallId, draft)}>
                                      提交
                                    </Button>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          {/* 提交成功卡片：用户在右侧面板点提交、发布成功后告知「已提交到团队空间」 */}
          {publishedName && (
            <div className="mx-auto mt-4 max-w-3xl">
              <div className="flex items-center gap-3 rounded-xl border border-green-300 bg-green-50 p-3 dark:border-green-800 dark:bg-green-950/30">
                <CheckCircle2Icon className="size-5 shrink-0 text-green-600" />
                <div className="flex-1 text-sm">
                  <div className="font-medium">插件「{publishedName}」已提交到团队空间</div>
                  <div className="text-xs text-muted-foreground">团队成员现可在插件中心看到并安装它。点「+」新建对话可继续创建下一个。</div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* #3 思考流式输出（支持思考的模型才显示，不支持时 reasoning 为空自动隐藏） */}
        {reasoning && (
          <div className="shrink-0 border-t bg-purple-50/50 px-4 py-2 dark:bg-purple-950/20">
            <details className="mx-auto max-w-3xl">
              <summary className="cursor-pointer text-xs font-medium text-purple-600 dark:text-purple-400">
                💭 思考过程（{reasoning.length} 字）{busy && <Loader2Icon className="ml-1 inline size-3 animate-spin" />}
              </summary>
              <div className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
                {reasoning}
              </div>
            </details>
          </div>
        )}

        {/* #1 上下文用量条（contextWindow 配好后显示百分比） */}
        {contextWindow && turns.length > 0 && (
          <div className="shrink-0 border-t px-4 py-1.5">
            <div className="mx-auto max-w-3xl">
              <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                <span>上下文用量</span>
                <span className="tabular-nums">{usedTokens.toLocaleString()} / {contextWindow.toLocaleString()} token（{usagePct}%）{usagePct > 80 && ' · 即将自动压缩'}</span>
              </div>
              <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-muted">
                <div className={`h-full rounded-full transition-all duration-300 ${usagePct > 80 ? 'bg-amber-500' : 'bg-primary'} `} style={{ width: `${usagePct}%` }} />
              </div>
            </div>
          </div>
        )}

        {/* 状态指示（压缩中 / 联网搜索中 / agent 工具上传中） */}
        {(compressing || searchingQuery != null || uploadingViaTool) && (
          <div className="shrink-0 border-t bg-muted/30 px-4 py-1.5">
            <div className="mx-auto flex max-w-3xl items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2Icon className="size-3 animate-spin" />
              {compressing
                ? '正在压缩对话上下文…'
                : searchingQuery != null
                  ? `正在联网搜索：${searchingQuery}…`
                  : 'AI 正在生成插件草稿…'}
            </div>
          </div>
        )}

        {/* 输入区：思考开关 + Textarea + 发送/停止，三者同高对齐 */}
        <div className="shrink-0 border-t px-4 py-3">
          <div className="mx-auto flex max-w-3xl items-end gap-2">
            {/* 思考开关：开启后模型做更深入推理（systemPrompt 追加思考引导） */}
            <Button
              type="button"
              variant={thinking ? 'default' : 'outline'}
              size="icon"
              onClick={() => setThinking((v) => !v)}
              disabled={busy}
              title={thinking ? '思考模式已开启（深入推理）' : '开启思考模式'}
              className="h-[40px] w-[40px] shrink-0"
            >
              <BrainIcon className="size-4" />
            </Button>
            <Textarea
              placeholder={thinking ? '思考模式：描述需求，模型会深入分析后生成…' : '描述插件需求，Enter 发送，Shift+Enter 换行'}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
              rows={1}
              className="min-h-[40px] max-h-32 resize-none"
              disabled={busy}
            />
            {busy ? (
              <Button variant="outline" size="icon" onClick={stop} title="停止" className="h-[40px] w-[40px] shrink-0"><XIcon className="size-4" /></Button>
            ) : (
              <Button size="icon" onClick={() => void send()} disabled={!input.trim()} title="发送" className="h-[40px] w-[40px] shrink-0"><SendIcon className="size-4" /></Button>
            )}
          </div>
        </div>
          </div>
          {/* 右侧草稿面板：AI 暂存草稿后出现，实时预览 + 改信息 + 提交 */}
          {draft && (
            <CreatorDraftPanel
              draft={draft}
              onChange={patchDraft}
              onSubmitted={onDraftSubmitted}
              busy={busy}
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
          <DialogTitle>创建偏好</DialogTitle>
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
    </>
  );
}
