// CreatorWorkspace —— 页面式插件 Agent 工作区（betav2：自建 agent 循环）。
//
//  - 页面式：左侧会话历史 + 中间单一对话流 + 右侧按需出现的插件产物 Inspector。
//  - 对话式：多轮聊天，紧凑输入框固定在主对话流底部，Enter 发送。
//  - 流式 + agent：自建轻量 agent 循环（loop.ts）走 relay；模型生成插件后调用 CreatePlugin 写入 plugins_root 草稿。
//    草稿在右侧分栏实时预览，用户可改名字/信息、继续对话打磨，点「提交」才真正发布。
//  - pluginId 单一真相源：经 PluginCreatorSession store（session/store.ts），消除旧 5 副本竞态。
//  - 上下文自动压缩 + Skill 动态拼装系统提示词保留。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { XIcon } from 'lucide-react';
import { toast } from 'sonner';
import { useApp } from '@/App';
import type { LoadedPlugin } from '@/lib/types';
import { tauriInvoke } from '@/lib/api';
import { chatComplete } from '@/lib/relay-chat-stream';
import { getPluginsRoot, openPluginDir, openPluginsRoot } from '@/lib/plugin-status';
import { withSyncedStagedManifest, type StagedPlugin } from '@/lib/plugin-creator/creator-tools';
import { runAgentLoop } from '@/lib/agent/loop';
import { createAgentTools } from '@/lib/agent/tools';
import type { HistoryPart } from '@/lib/agent/history';
import { estimateTokens, DEFAULT_OUTPUT_RESERVE } from '@/lib/agent/token-estimate';
import type { ChatMessage, LoopCallbacks } from '@/lib/agent/types';
import { usePluginCreatorStore } from '@/lib/agent/session/store';
import type { AskQuestionArgs, AskQuestionResult, TodoItem } from '@/lib/agent/tools';
import { readLocalFiles, filesToStagedPlugin } from '@/lib/plugin-creator/import-local';
import {
  buildPromptOptimizerMessages,
  composeModelInput,
  creatorModePrompt,
  formatAttachmentContext,
  summarizeAttachmentDisplay,
  type CreatorMode,
} from '@/lib/plugin-creator/creator-input';
import { CreatorDraftPanel } from '@/components/creator/CreatorDraftPanel';
import { ContextInspector } from '@/components/creator/ContextInspector';
import { CreatorWorkspaceSidebar } from '@/components/creator/CreatorWorkspaceChrome';
import { CreatorComposer } from '@/components/creator/CreatorComposer';
import { CreatorEmptyState } from '@/components/creator/CreatorEmptyState';
import { CreatorMessageList } from '@/components/creator/CreatorMessageList';
import { CreatorSkillsDialog } from '@/components/creator/CreatorSkillsDialog';
import { assembleSystemPrompt, DEFAULT_ACTIVE_SKILLS } from '@/lib/skills';
import { CREATOR_CONTEXT_PROMPT } from '@/lib/agent/prompts';
import { buildContextMessages, compressHistoryManually, emptyCompressState } from '@/lib/plugin-creator/context-compress';
import {
  cleanTurnParts,
  detectDuplicateOutput,
  loadConversations,
  makeConversationTitle,
  mergeStreamingText,
  saveConversations,
  selectedConversationKey,
  type CreatorConversation,
  type QuestionPart,
  type TextPart,
  type ToolPart,
  type Turn,
} from '@/lib/plugin-creator/creator-session';
import { fetchContextWindow } from '@/lib/relay-models';
import { readWorkspaceFiles } from '@/lib/plugin-registry';
import { capabilityRequiresAdmin } from '@/lib/plugin-capabilities';

// 历史还原改用 turnsToMessages（原生 function calling，见 agent/history.ts）。
// 旧的 partsToAgentMessageParts 文本化方案已删除（betav2 阶段3）。

type ContextBreakdown = {
  systemPrompt: string;
  summary: string;
  keptTurns: Array<{ role: string; content: string }>;
  currentInput: string;
  estimatedTokens: { system: number; summary: number; history: number; input: number; total: number };
  compressInfo: { threshold: number; currentTokens: number; remainingTokens: number; pct: number };
};

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { resultIndex?: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

const SYSTEM_PROMPT = CREATOR_CONTEXT_PROMPT;

function defaultEntryForRuntime(runtime: StagedPlugin['runtime_type']) {
  if (runtime === 'python') return 'main.py';
  if (runtime === 'nodejs') return 'index.js';
  return 'ui/index.html';
}

export function normalizeLoadedRuntime(runtime: LoadedPlugin['runtime_type']): StagedPlugin['runtime_type'] {
  return runtime === 'cloud' || runtime === 'python' || runtime === 'nodejs' ? runtime : 'client';
}

function recordFromMaybeJson(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

const KNOWN_CAPABILITY_KINDS = new Set([
  'ui.view',
  'fs.pick',
  'fs.read',
  'fs.write',
  'net.fetch',
  'clipboard',
  'llm.chat',
  'image.generate',
  'storage.kv',
  'system.info',
  'system.screenshot',
  'system.notify',
  'plugin.upload',
  'plugin.submitMarketplace',
]);

function normalizeCapabilities(value: unknown): StagedPlugin['capabilities'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const rawKind = typeof item === 'string'
      ? item.trim()
      : item && typeof item === 'object' && typeof (item as Record<string, unknown>).kind === 'string'
        ? String((item as Record<string, unknown>).kind).trim()
        : '';
    if (!KNOWN_CAPABILITY_KINDS.has(rawKind)) {
      return [];
    }
    const raw = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const risk = raw.risk === 'none' || raw.risk === 'medium' || raw.risk === 'high' ? raw.risk : 'low';
    return [{
      kind: rawKind,
      reason: typeof raw.reason === 'string' ? raw.reason : '',
      risk,
      requires_admin: capabilityRequiresAdmin(rawKind, raw.requires_admin),
    } as StagedPlugin['capabilities'][number]];
  });
}

export function stagedPluginFromLoadedPlugin(plugin: LoadedPlugin, files = plugin.files ?? []): StagedPlugin {
  const manifestFile = files.find((file) => file.path === 'manifest.json' && !file.binary);
  const fileManifest = recordFromMaybeJson(manifestFile?.content);
  const pluginManifest = recordFromMaybeJson(plugin.manifest);
  const manifest = { ...pluginManifest, ...fileManifest };
  const runtime = normalizeLoadedRuntime((manifest.runtime_type as LoadedPlugin['runtime_type']) ?? plugin.runtime_type);
  const stringField = (key: string, fallback: string) => {
    const value = manifest[key];
    return typeof value === 'string' && value.trim() ? value : fallback;
  };
  return withSyncedStagedManifest({
    id: plugin.id,
    name: stringField('name', plugin.name || plugin.id),
    version: stringField('version', plugin.version || '0.1.0'),
    description: stringField('description', plugin.description || ''),
    runtime_type: runtime,
    entry: stringField('entry', plugin.entry || defaultEntryForRuntime(runtime)),
    visibility: manifest.visibility === 'private' ? 'private' : 'tenant',
    capabilities: normalizeCapabilities(manifest.capabilities ?? plugin.capabilities),
    files,
    sourceKind: plugin._meta?.sourceKind,
    sourceLabel: plugin._meta?.sourceLabel,
  });
}

export function referencedPluginPrompt(plugin: LoadedPlugin | null): string {
  const textFiles = plugin?.files?.filter((file) => !file.binary) ?? [];
  if (!plugin || textFiles.length === 0) return '';
  return `\n\n# 参考插件（用户要基于此修改）\n插件名：${plugin.name}\n请在此基础上按用户需求修改，保留未变文件，只改必要部分（增量重构）。\n\n当前文件：\n${textFiles.map((file) => `--- ${file.path} ---\n${file.content}`).join('\n\n')}`;
}

function joinDisplayPath(root: string | null, pluginId: string | null) {
  if (!root || !pluginId) return pluginId;
  return `${root.replace(/[\\/]+$/, '')}\\${pluginId}`;
}

const CREATOR_SIDEBAR_OPEN_KEY = 'lf:creator-sidebar-open';

function loadCreatorSidebarOpen() {
  try {
    return localStorage.getItem(CREATOR_SIDEBAR_OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * 上下文自动压缩见 lib/plugin-creator/context-compress.ts（超阈值时摘要早期对话轮，保留近期+插件包原文）。
 */
export function CreatorWorkspace({ onClose }: { onClose: () => void }) {
  const { session, recentPlugins, pendingAutoFix, setPendingAutoFix, pendingDraftEdit, setPendingDraftEdit } = useApp();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [conversations, setConversations] = useState<CreatorConversation[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(loadCreatorSidebarOpen);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [tier, setTier] = useState<'fast' | 'premium'>('fast');
  const [creatorMode, setCreatorMode] = useState<CreatorMode>('agent');
  const [activeSkillIds, setActiveSkillIds] = useState<string[]>(DEFAULT_ACTIVE_SKILLS);
  const [busy, setBusy] = useState(false);
  const [optimizingPrompt, setOptimizingPrompt] = useState(false);
  const [voiceListening, setVoiceListening] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null); // R3：行内删除二次确认态
  const [skillDialogOpen, setSkillDialogOpen] = useState(false); // Skill 居中悬浮窗开关（R3：由小 Popover 改为居中 Dialog + 背景模糊）
  const [referencedPlugin, setReferencedPlugin] = useState<LoadedPlugin | null>(null); // 引用的现有插件（让 agent 基于其代码修改）
  const [workspacePluginId, setWorkspacePluginId] = useState<string | null>(null); // 当前对话绑定的插件工作目录 id。
  const [pluginsRoot, setPluginsRoot] = useState<string | null>(null); // 展示工作目录路径用，真相源仍在 Rust。
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
  const [contextBreakdown, setContextBreakdown] = useState<ContextBreakdown | null>(null); // 上下文查看面板数据
  const [contextInspectorOpen, setContextInspectorOpen] = useState(false); // 上下文查看面板开关
  const [todos, setTodos] = useState<TodoItem[]>([]); // 当前会话的 TodoWrite 任务清单（随会话持久化）
  const compressRef = useRef(emptyCompressState());
  const abortRef = useRef<AbortController | null>(null);
  const speechRef = useRef<SpeechRecognitionLike | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null); // 文件选择（支持多次累积）
  const folderInputRef = useRef<HTMLInputElement>(null); // 文件夹选择（webkitdirectory）。
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

  function toggleSidebar() {
    setSidebarOpen((current) => {
      const next = !current;
      try { localStorage.setItem(CREATOR_SIDEBAR_OPEN_KEY, next ? '1' : '0'); } catch { /* 忽略配额/禁用 */ }
      return next;
    });
  }

  // 展示用草稿 = AI 暂存的原始草稿叠加用户的手动编辑（用户改过的字段优先），并始终同步 manifest.json。
  const draft: StagedPlugin | null = stagedDraft ? withSyncedStagedManifest({ ...stagedDraft, ...userEdits }) : null;

  // CreatePlugin 工具回调：工具已写入 workspaces/{workspaceId}/，这里同步右侧草稿预览状态。
  // 同一插件 id 继续修改时保留用户已改字段；换 id（新插件）则清空旧编辑。
  function onPluginCreated(pluginId: string, next: StagedPlugin) {
    const synced = withSyncedStagedManifest(next);
    draftRef.current = synced;
    currentPluginIdRef.current = pluginId;
    setWorkspacePluginId(pluginId);
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
    currentPluginIdRef.current = workspacePluginId ?? draft?.id ?? null;
  }, [draft, workspacePluginId]);

  // 稳定回调所需 refs：TurnBubble 已 memo，流式期间回调必须保持引用稳定，
  // 否则父级每次重渲染都会重建闭包导致 memo 失效、所有气泡重新解析 Markdown。
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const turnsRef = useRef(turns);
  turnsRef.current = turns;
  const activeConversationIdRef = useRef(activeConversationId);
  activeConversationIdRef.current = activeConversationId;
  const runAgentTurnRef = useRef(runAgentTurn);
  runAgentTurnRef.current = runAgentTurn;

  // Write/Edit 工具直接改 plugins_root，需要从真实目录重载文件刷新右侧预览。
  async function refreshDraftFromRoot(pluginId = currentPluginIdRef.current): Promise<boolean> {
    if (!pluginId) return false;
    try {
      const files = await readWorkspaceFiles(pluginId);
      const manifestRaw = files.find((f) => f.path === 'manifest.json' && !f.binary)?.content ?? '{}';
      const manifest = JSON.parse(manifestRaw) as Partial<StagedPlugin> & { id?: string };
      const runtime = normalizeLoadedRuntime(manifest.runtime_type);
      const next: StagedPlugin = withSyncedStagedManifest({
        id: manifest.id || pluginId,
        name: manifest.name || pluginId,
        version: manifest.version || '0.1.0',
        description: manifest.description || '',
        runtime_type: runtime,
        entry: manifest.entry || defaultEntryForRuntime(runtime),
        visibility: manifest.visibility || 'tenant',
        capabilities: normalizeCapabilities(manifest.capabilities),
        files,
        sourceKind: draftRef.current?.sourceKind,
        sourceLabel: draftRef.current?.sourceLabel,
      });
      draftRef.current = next;
      currentPluginIdRef.current = pluginId;
      setWorkspacePluginId(pluginId);
      setStagedDraft(next);
      return true;
    } catch (e) {
      console.error('刷新草稿失败:', e);
      return false;
    }
  }

  // 保存草稿成功后继续停留在同一 workspace，后续编辑不能创建第二条草稿。
  function onDraftSubmitted(name: string) {
    setPublishedName(name);
  }

  function onWorkspacePersisted(workspaceId: string) {
    currentPluginIdRef.current = workspaceId;
    setWorkspacePluginId(workspaceId);
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
    const activeWorkspaceId = active?.workspacePluginId ?? active?.stagedDraft?.id ?? null;
    setWorkspacePluginId(activeWorkspaceId);
    currentPluginIdRef.current = activeWorkspaceId;
    usePluginCreatorStore.getState().clearDraft();
    if (activeWorkspaceId && active?.stagedDraft) {
      usePluginCreatorStore.getState().createPlugin(activeWorkspaceId, active.stagedDraft);
    }
    setUserEdits(active?.userEdits ?? {});
    setTodos(active?.todos ?? []);
  }, [session.userId, session.tenantId]);

  useEffect(() => {
    let cancelled = false;
    void getPluginsRoot()
      .then((root) => {
        if (!cancelled) setPluginsRoot(root);
      })
      .catch(() => {
        if (!cancelled) setPluginsRoot(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // turns 为空但有草稿（如刚导入未对话）也应持久化，故放宽空判定为「两者皆空才跳过」。
    if (!activeConversationId || (turns.length === 0 && !stagedDraft && !workspacePluginId)) return;
    // 流式期间每 token 都触发一次 effect：对 turn 快照做尾沿防抖（500ms），
    // 流式 chunk 密集到达时只在停顿/结束时落盘一次，避免每次 delta 都全量 JSON.stringify + 写 localStorage。
    let cancelled = false;
    const handle = setTimeout(() => {
      if (cancelled) return;
      setConversations((prev) => {
        const now = new Date().toISOString();
        const next = prev.map((conversation) => conversation.id === activeConversationId
          ? { ...conversation, turns, stagedDraft, workspacePluginId, userEdits, todos: todos.length ? todos : undefined, updatedAt: now }
          : conversation);
        saveConversations(session.userId, session.tenantId, next);
        return next;
      });
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [activeConversationId, session.tenantId, session.userId, turns, stagedDraft, workspacePluginId, userEdits, todos]);

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
    setInput('');
    setSelectedFiles([]);
    setReferencedPlugin(null);
    setContextBreakdown(null);
    setContextInspectorOpen(false);
    setAnswerDrafts({});
    setMultiSelectDrafts({});
    setPublishedName(null);
    // 切回该会话时恢复其暂存草稿与用户编辑（右侧栏随之重现）。
    setStagedDraft(conversation.stagedDraft ?? null);
    const conversationWorkspaceId = conversation.workspacePluginId ?? conversation.stagedDraft?.id ?? null;
    setWorkspacePluginId(conversationWorkspaceId);
    currentPluginIdRef.current = conversationWorkspaceId;
    usePluginCreatorStore.getState().clearDraft();
    if (conversationWorkspaceId && conversation.stagedDraft) {
      usePluginCreatorStore.getState().createPlugin(conversationWorkspaceId, conversation.stagedDraft);
    }
    setUserEdits(conversation.userEdits ?? {});
    setTodos(conversation.todos ?? []);
    compressRef.current = emptyCompressState();
    try { localStorage.setItem(selectedConversationKey(session.userId, session.tenantId), conversation.id); } catch { /* ignore */ }
  }

  function selectConversationById(id: string) {
    if (busy) return;
    const conversation = conversations.find((item) => item.id === id);
    if (conversation) selectConversation(conversation);
  }

  function newConversation() {
    abortRef.current?.abort();
    clearPendingAnswers();
    setBusy(false);
    setTurns([]);
    setActiveConversationId(null);
    setInput('');
    setSelectedFiles([]);
    setReferencedPlugin(null);
    setContextBreakdown(null);
    setContextInspectorOpen(false);
    setAnswerDrafts({});
    setMultiSelectDrafts({});
    setPublishedName(null);
    setStagedDraft(null);
    setWorkspacePluginId(null);
    currentPluginIdRef.current = null;
    usePluginCreatorStore.getState().clearDraft();
    setUserEdits({});
    setTodos([]);
    compressRef.current = emptyCompressState();
    setCompressedHint(0);
    try { localStorage.removeItem(selectedConversationKey(session.userId, session.tenantId)); } catch { /* ignore */ }
  }

  // R3：删除单条历史对话。删的是当前会话时重置为新对话。
  function deleteConversation(id: string) {
    if (busy) return;
    setConversations((prev) => {
      const next = prev.filter((c) => c.id !== id);
      saveConversations(session.userId, session.tenantId, next);
      return next;
    });
    setConfirmDeleteId(null);
    if (id === activeConversationId) newConversation();
  }

  // betav2 阶段5：从 relay /models 拉 contextWindow（普通用户可访问，取代旧 admin pricing 端点）。
  // 供用量条 + 上下文压缩阈值参考。失败走保守默认（fetchContextWindow 内部处理）。
  useEffect(() => {
    let mounted = true;
    void fetchContextWindow().then((cw) => {
      if (!mounted) return;
      setContextWindow(tier === 'fast' ? cw.fast : cw.premium);
    });
    return () => { mounted = false; };
  }, [tier]);

  // Composer 始终使用实时对话估算，避免打开过一次 ContextInspector 后沿用旧 breakdown。
  // 用 token-estimate 的 CJK/拉丁加权估算（替代旧的 chars/1.5）。
  // 附件文件用 file.size（字节数）按拉丁系数估——附件多为代码/文本（拉丁为主），
  // 字节数 ≈ 字符数，按 /4 估偏保守（宁可高估早压缩，不要低估撞上游硬限）。
  // useMemo：流式每 token 都在重渲染，整段会话估算放这里避免每次全量 O(n) 扫描。
  const usedTokens = useMemo(
    () =>
      estimateTokens(buildSystemPrompt())
      + estimateTokens(turns.reduce((sum, turn) => sum + (turn.modelContent ?? turn.content), ''))
      + estimateTokens(input)
      + selectedFiles.reduce((sum, item) => sum + Math.ceil(item.file.size / 4), 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [turns, input, selectedFiles, activeSkillIds, creatorMode, referencedPlugin, draft],
  );
  const inspectorTokens = contextBreakdown?.estimatedTokens.total ?? usedTokens;
  const usagePct = contextWindow ? Math.min(100, Math.round((usedTokens / contextWindow) * 100)) : 0;
  const compressInfo = contextBreakdown?.compressInfo;
  const compressHint = compressInfo
    ? (compressInfo.remainingTokens > 0
      ? `还差 ${compressInfo.remainingTokens.toLocaleString()} tokens 压缩`
      : '下次将压缩')
    : undefined;

  function buildContextPreviewBreakdown(args: {
    historyTurns: Array<{ role: 'user' | 'assistant'; content: string }>;
    currentInput: string;
    systemPrompt: string;
  }): ContextBreakdown {
    // 阈值与 buildContextMessages 同源（contextWindow × 0.7，token 维度）。
    const threshold = contextWindow
      ? Math.floor(contextWindow * 0.7)
      : 8_000;
    const summary = compressRef.current.summary;
    const historyText = args.historyTurns.reduce((sum, turn) => sum + turn.content, '');
    const systemTok = estimateTokens(args.systemPrompt);
    const summaryTok = estimateTokens(summary);
    const historyTok = estimateTokens(historyText);
    const inputTok = estimateTokens(args.currentInput);
    return {
      systemPrompt: args.systemPrompt,
      summary,
      keptTurns: args.historyTurns,
      currentInput: args.currentInput,
      estimatedTokens: {
        system: systemTok,
        summary: summaryTok,
        history: historyTok,
        input: inputTok,
        total: systemTok + summaryTok + historyTok + inputTok,
      },
      compressInfo: {
        threshold,
        currentTokens: historyTok,
        remainingTokens: threshold - historyTok,
        pct: threshold > 0 ? Math.round((historyTok / threshold) * 100) : 0,
      },
    };
  }

  function buildSystemPrompt() {
    const basePrompt = assembleSystemPrompt(SYSTEM_PROMPT, activeSkillIds);
    const modePrompt = creatorModePrompt(creatorMode);
    const thinkPrompt = `\n\n# 深度思考\n请先拆解需求、权衡实现方案，再生成严谨完整的代码；保证边界处理与可验证性。`;
    const refPrompt = referencedPluginPrompt(referencedPlugin);
    const draftPrompt = draft?.files?.length
      ? `\n\n# 当前草稿（用户正在编辑）\n` +
        `插件名：${draft.name}\n版本：${draft.version}\n运行时：${draft.runtime_type}\n入口：${draft.entry}\n描述：${draft.description || '无'}\n` +
        `请基于以下文件按用户新需求做增量修改（保留未变部分）。需要查看某文件当前内容时用 Read 读取，再用 Edit/Write 改写；整体重构时才再次调用 CreatePlugin。` +
        `若用户改了名字/描述等元信息（见上方），沿用这些值，不要擅自改回。\n\n当前文件（按需 Read 查看）：\n` +
        draft.files.map((f) => `- ${f.path}`).join('\n')
      : '';
    return basePrompt + modePrompt + thinkPrompt + refPrompt + draftPrompt;
  }

  async function buildAttachmentContextFromSelection() {
    if (selectedFiles.length === 0) return { context: '', fileCount: 0, skippedCount: 0 };
    const result = await readLocalFiles(selectedFiles.map((item) => item.file));
    return {
      context: formatAttachmentContext(result.files, result.skipped),
      fileCount: result.files.length,
      skippedCount: result.skipped.length,
    };
  }

  // betav2：bindPlugin 委托给 store（原子操作：串行 await 写盘+refresh，消除竞态）。
  // store 内部统一维护 pluginId 单一真相源 + aiDraft；此处同步本地视图（兼容过渡期）。
  // 阶段4c 完整迁移后，本地 stagedDraft/workspacePluginId/currentPluginIdRef 将删除。
  async function bindPluginWorkspace(plugin: LoadedPlugin, options: { showToast?: boolean } = {}) {
    setReferencedPlugin(plugin);
    setPublishedName(null);

    await usePluginCreatorStore.getState().bindPlugin(plugin);

    // 从 store 同步到本地视图（过渡期兼容）。
    const storeState = usePluginCreatorStore.getState();
    currentPluginIdRef.current = storeState.pluginId;
    setWorkspacePluginId(storeState.pluginId);
    if (storeState.aiDraft) {
      setStagedDraft(storeState.aiDraft);
    }
    setUserEdits({});

    if (storeState.bindError) {
      toast.error(storeState.bindError);
    } else if (options.showToast !== false) {
      toast.success(`已绑定插件工作文件夹：${plugin.name}`);
    }
  }

  function handleSelectReferencedPlugin(plugin: LoadedPlugin | null) {
    if (!plugin) {
      setReferencedPlugin(null);
      if (!draftRef.current) {
        setWorkspacePluginId(null);
        currentPluginIdRef.current = null;
      }
      return;
    }
    void bindPluginWorkspace(plugin);
  }

  async function openWorkspaceFolder() {
    const pluginId = currentPluginIdRef.current;
    try {
      if (pluginId) await openPluginDir(pluginId);
      else await openPluginsRoot();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '打开工作文件夹失败');
    }
  }

  async function refreshWorkspaceFolder() {
    const pluginId = currentPluginIdRef.current;
    if (!pluginId) {
      toast.error('当前还没有绑定插件工作文件夹');
      return;
    }
    const ok = await refreshDraftFromRoot(pluginId);
    if (ok) toast.success('已从工作文件夹刷新源码');
    else toast.error('刷新工作文件夹失败');
  }

  async function openContextInspector() {
    try {
      const attachment = await buildAttachmentContextFromSelection();
      const currentInput = composeModelInput(input, attachment.context);
      const historyTurns = turns.map((t) => ({
        role: t.role,
        content: t.modelContent ?? t.content,
      }));
      setContextBreakdown(buildContextPreviewBreakdown({
        historyTurns,
        currentInput,
        systemPrompt: buildSystemPrompt(),
      }));
      setContextInspectorOpen(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '上下文预览失败');
    }
  }

  /**
   * 手动压缩上下文：用户在 ContextInspector 面板点「立即压缩」时调用。
   * 把早期可压缩轮摘要成一条 assistant 轮，真实删除原早期轮（持久化进会话），
   * 保留最近 N 轮 + 含插件包的轮原文。压缩后立即刷新占用估算，让用户看到数字下降。
   * busy 时禁用（此时无 generating 轮，无需处理进行中的轮）。
   */
  async function handleManualCompress() {
    if (busy) return;
    // 构建参与压缩的轮：user + status==='done' 的 assistant（排除 generating/failed/cancelled）。
    // 保留与原 turns 的下标映射，以便压缩后按 keptTurnIndices 重建。
    const compressible = turns
      .map((t, idx) => ({ t, idx }))
      .filter(({ t }) => t.role === 'user' || (t.role === 'assistant' && t.status === 'done'));
    if (compressible.length === 0) {
      toast.info('暂无历史可压缩');
      return;
    }

    setCompressing(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const result = await compressHistoryManually({
        turns: compressible.map(({ t }) => ({
          role: t.role,
          content: t.modelContent ?? t.content,
          parts: t.parts as unknown as HistoryPart[] | undefined,
        })),
        state: compressRef.current,
        tier,
        signal: controller.signal,
      });

      if (result.compressedCount === 0) {
        toast.info('当前历史较短，无需压缩');
        return;
      }

      // 重建 turns：把可压缩区里被摘要的轮删掉，在最前面插一条摘要轮。
      // 保留：keptTurnIndices 指向的轮（近窗口 + 包轮）+ 不参与压缩的轮（generating/failed 等）。
      const summaryText = `[已压缩 ${result.compressedCount} 轮历史]\n${result.summary}`;
      const summaryTurn: Turn = {
        role: 'assistant',
        content: summaryText,
        status: 'done',
        parts: [{ type: 'text', content: summaryText } as TextPart],
      };
      const keptOriginalIdx = new Set(result.keptTurnIndices.map((i) => compressible[i]?.idx).filter((x): x is number => x != null));
      // 被摘要的轮（在 compressible 里但不在 kept 里）的原 idx，这些要删除。
      const removedOriginalIdx = new Set(
        compressible.filter(({ idx }) => !keptOriginalIdx.has(idx)).map(({ idx }) => idx),
      );
      // 保留原序：摘要轮置顶，其余未删除的轮按原序跟在后面。
      const nextTurns: Turn[] = [summaryTurn, ...turns.filter((_, idx) => !removedOriginalIdx.has(idx))];

      setTurns(nextTurns);
      compressRef.current = result.state;
      setCompressedHint(result.compressedCount);
      // 刷新 breakdown（反映压缩后的占用）。
      setContextBreakdown(buildContextPreviewBreakdown({
        historyTurns: nextTurns.map((t) => ({ role: t.role, content: t.modelContent ?? t.content })),
        currentInput: input,
        systemPrompt: buildSystemPrompt(),
      }));
      toast.success(`已压缩 ${result.compressedCount} 轮历史，上下文占用已降低`);
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') return;
      toast.error(`压缩失败：${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      setCompressing(false);
    }
  }

  // 流式输出时自动滚到底。
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns, uploadingViaTool, compressing]);

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
  useEffect(() => () => {
    abortRef.current?.abort();
    speechRef.current?.stop();
    clearPendingAnswers();
  }, []);

  // 一键 AI 修复消费：插件启动/运行报错跳创建器时，pendingAutoFix 携带提示词 + 出错插件。
  // 此处预填提示词到输入框 + 引用该插件源码（注入上下文），但不自动发送——用户确认后点发送即修。
  // 消费即清（setPendingAutoFix(null)），避免下次打开创建器又被重复预填。
  useEffect(() => {
    if (!pendingAutoFix) return;
    setInput(pendingAutoFix.prompt);
    void bindPluginWorkspace(pendingAutoFix.plugin, { showToast: false });
    setPendingAutoFix(null);
  }, [pendingAutoFix, setPendingAutoFix]);

  // 草稿编辑消费（task 06-25 增强）：草稿列表点「编辑」跳创建器时，pendingDraftEdit 携带草稿 + 对话历史。
  // 此处恢复对话轮次 + 引用草稿源码，让用户继续上次对话修改草稿。消费即清。
  useEffect(() => {
    if (!pendingDraftEdit) return;
    const { draft, turns: restoredTurns } = pendingDraftEdit;
    const conversationId = draft._meta?.conversationId;
    const storedConversation = conversationId
      ? conversations.find((conversation) => conversation.id === conversationId)
      : undefined;
    // 工作区 conversationId 是首选真相；旧草稿载荷仍兼容直接携带 turns。
    if (storedConversation) {
      selectConversation(storedConversation);
    } else if (Array.isArray(restoredTurns) && restoredTurns.length > 0) {
      setTurns(restoredTurns as Turn[]);
    }
    // 绑定草稿工作区，后续 Read/Write 直接操作 workspaces/{workspaceId}/。
    void bindPluginWorkspace(draft, { showToast: false });
    // 恢复草稿到右侧面板（若 draft.files 存在且含 manifest 信息）。
    if (draft.files && draft.files.length > 0) {
      setStagedDraft(stagedPluginFromLoadedPlugin(draft, draft.files));
      setUserEdits({});
    }
    setPendingDraftEdit(null);
  }, [conversations, pendingDraftEdit, setPendingDraftEdit]);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    stopVoiceInput();
    setInput('');
    const conversationId = ensureConversation(text);
    let modelText = text;
    let displayText = text;
    try {
      const attachment = await buildAttachmentContextFromSelection();
      modelText = composeModelInput(text, attachment.context);
      const attachmentSummary = summarizeAttachmentDisplay(attachment.fileCount, attachment.skippedCount);
      if (attachmentSummary) {
        displayText = `${text}\n\n[${attachmentSummary}]`;
        setSelectedFiles([]);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '附件读取失败');
      setInput(text);
      return;
    }
    const userTurn: Turn = { role: 'user', content: displayText, modelContent: modelText };
    const assistantIdx = turns.length + 1;
    setTurns((prev) => [...prev, userTurn, { role: 'assistant', content: '', streaming: true, status: 'generating' }]);
    await runAgentTurn(assistantIdx, modelText, { conversationId });
  }

  /**
   * 重试最后一条失败的/已取消的 assistant 轮：复用其上一条 user 轮的输入，
   * 清空失败轮的 parts 后重新发起 agent run。不新增 user 气泡，保持对话结构不变。
   */
  const retry = useCallback(async () => {
    if (busyRef.current) return;
    // 找到最后一条 assistant 轮（失败/取消态），其上一条应为对应 user 轮。
    // 用倒序 for 循环（避免 findLastIndex 在低 lib target 下不可用）。
    const curTurns = turnsRef.current;
    let lastAssistantIdx = -1;
    for (let i = curTurns.length - 1; i >= 0; i--) {
      if (curTurns[i].role === 'assistant') { lastAssistantIdx = i; break; }
    }
    if (lastAssistantIdx < 0) return;
    const cur = curTurns[lastAssistantIdx];
    if (cur.status !== 'failed' && cur.status !== 'cancelled') return;
    // 取上一条 user 轮的输入作为重跑文本；找不到则放弃。
    const userTurn = curTurns.slice(0, lastAssistantIdx).reverse().find((t) => t.role === 'user');
    const userText = userTurn?.modelContent ?? userTurn?.content ?? '';
    if (!userText.trim()) return;
    // 重置该轮：清空旧 parts 与 content，回到生成中态。
    setTurns((prev) => {
      const next = [...prev];
      next[lastAssistantIdx] = { role: 'assistant', content: '', streaming: true, status: 'generating', parts: [] };
      return next;
    });
    // 重试模式：turns 里已含上一条 user 轮（紧邻被重置的 assistant 轮之前），
    // 所以不应再追加 currentInput（否则用户消息重复）。传 isRetry=true 让 runAgentTurn 跳过追加。
    await runAgentTurnRef.current(lastAssistantIdx, userText, { isRetry: true, conversationId: activeConversationIdRef.current });
  }, []);

  /**
   * 执行一次 agent run，把流式输出写回指定 assistant turn（runPluginCreatorAgent 的 UI 编排）。
   * send() 新建 turn 后调用；retry() 复用既有 turn 后调用。二者共用此函数，避免逻辑重复。
   * @param assistantIdx 要写入的 assistant 轮下标
   * @param text 本轮用户输入（用于压缩与 currentInput）
   * @param opts.isRetry 重试模式：turns 已含对应 user 轮，不重复追加 currentInput
   */
  async function runAgentTurn(
    assistantIdx: number,
    text: string,
    opts: { isRetry?: boolean; conversationId?: string | null } = {},
  ) {
    setBusy(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const systemPrompt = buildSystemPrompt();
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
        // parts 透传给 buildContextMessages：内部用 turnsToMessages 还原原生 function calling 历史
        // （tool_calls + role:'tool' 配对），并据此判断哪些轮可压缩。
        turns: historyTurns.map((t) => {
          const content = t.modelContent ?? t.content;
          if (t.role === 'assistant' && t.status === 'done') {
            return { role: t.role, content, parts: t.parts as unknown as HistoryPart[] | undefined };
          }
          return { role: t.role, content };
        }),
        currentInput: opts.isRetry ? '' : text,
        skipAppendCurrent: opts.isRetry,
        systemPrompt,
        state: compressRef.current,
        tier,
        contextWindow: contextWindow ?? undefined, // 真实窗口推算压缩阈值
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

      // betav2：自建 agent 循环（loop.ts），替代旧 runPluginCreatorAgent（creator-adapter）。
      // 关键修复：直接使用 buildContextMessages 的压缩产物。
      // 此前这里手工拼 loopMessages（system + 摘要 + turnsToMessages(完整历史)），导致压缩完全失效——
      // 早期轮被摘要后又全量塞回，历史只增不减，最终撞上游 256K token 硬限。
      // 现在 buildContextMessages 内部已用 turnsToMessages 还原近期区（保留 tool_calls + role:'tool' 配对），
      // 早期可压缩轮进摘要文本，含插件包的轮原文保留。loopMessages 即压缩后的最终入参。
      const loopMessages: ChatMessage[] = built.messages;
      // 输入预算：contextWindow 扣除输出预留，供 agent 循环做运行时护栏（超限则就地压缩/截断）。
      const contextBudget = contextWindow ? contextWindow - DEFAULT_OUTPUT_RESERVE : undefined;

      const { tools, resetReadTracking } = createAgentTools({
        getPluginId: () => currentPluginIdRef.current,
        getConversationId: () => opts.conversationId ?? activeConversationId,
        onPluginCreated: (pluginId, nextDraft) => {
          stagedName = nextDraft.name;
          setUploadingViaTool(false);
          usePluginCreatorStore.getState().createPlugin(pluginId, nextDraft);
          // 同步本地 stagedDraft（persist effect 等仍读它，阶段4c 完整迁移后删除）
          setStagedDraft(nextDraft);
          setWorkspacePluginId(pluginId);
          currentPluginIdRef.current = pluginId;
        },
        onFilesChanged: () => {
          void usePluginCreatorStore.getState().refreshDraft().then(() => {
            // 同步本地草稿视图
            const storeDraft = usePluginCreatorStore.getState().aiDraft;
            if (storeDraft) setStagedDraft(storeDraft);
          });
        },
        onAskQuestion,
        getTodos: () => todos,
        onTodoUpdate: (next) => setTodos(next.map((t) => ({ ...t }))),
      });
      resetReadTracking();

      const loopCallbacks: LoopCallbacks = {
        onTextDelta: (delta) => appendTextDelta(assistantIdx, delta),
        onReasoningDelta: (delta) => {
          reasoningText += delta;
          appendReasoningDelta(assistantIdx, delta);
        },
        onReasoningEnd: () => endReasoning(assistantIdx),
        onToolCall: (call) => {
          sawToolCall = true;
          upsertToolPart(assistantIdx, {
            toolCallId: call.toolCallId,
            name: call.name,
            args: call.args,
            status: 'running',
          });
          // 兼容旧 onToolStart 行为（顶部状态条提示）
          if (call.name === 'CreatePlugin') setUploadingViaTool(true);
          else if (call.name === 'WebSearch') {
            const q = (call.args as { query?: string } | undefined)?.query ?? '';
            setSearchingQuery(q || '联网搜索中');
          }
        },
        onToolOutput: (output) => {
          upsertToolPart(assistantIdx, {
            toolCallId: output.toolCallId,
            name: output.name,
            result: output.result,
            status: output.ok ? 'ok' : 'error',
          });
          // 兼容旧 onToolResult 行为
          if (output.name === 'CreatePlugin') {
            setUploadingViaTool(false);
            if (!output.ok && typeof output.result === 'string' && output.result.startsWith('错误')) {
              stageErrMsg = output.result;
            }
          } else if (output.name === 'WebSearch') {
            setSearchingQuery(null);
          }
        },
      };

      const agentResult = await runAgentLoop({
        messages: loopMessages,
        tools,
        tier,
        contextBudget,
        signal: controller.signal,
        callbacks: loopCallbacks,
      });
      if (agentResult.error) streamError = agentResult.error;
      // betav2：runAgentLoop 返回 status，aborted（用户取消）不算错误，走 cancelled 终态。
      const wasAborted = agentResult.status === 'aborted';
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
        } else if (wasAborted) {
          // 用户取消：保留已生成的 parts（部分输出仍可见），标记 cancelled。
          next[assistantIdx] = { ...cur, streaming: false, status: 'cancelled' };
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
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
    clearPendingAnswers();
  }

  async function optimizePrompt() {
    const text = input.trim();
    if (!text || optimizingPrompt || busy) return;
    setOptimizingPrompt(true);
    try {
      const optimized = await chatComplete(buildPromptOptimizerMessages(text), tier);
      const next = optimized.trim();
      if (!next) {
        toast.error('提示词优化未返回内容');
        return;
      }
      setInput(next);
      toast.success('已优化提示词');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '提示词优化失败');
    } finally {
      setOptimizingPrompt(false);
    }
  }

  function toggleVoiceInput() {
    if (voiceListening) {
      stopVoiceInput();
      return;
    }

    const SpeechCtor = (window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    }).SpeechRecognition ?? (window as unknown as {
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    }).webkitSpeechRecognition;

    if (!SpeechCtor) {
      toast.error('当前环境暂不支持本地语音输入');
      return;
    }

    try {
      const recognition = new SpeechCtor();
      speechRef.current = recognition;
      recognition.lang = 'zh-CN';
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.onresult = (event) => {
        const transcripts: string[] = [];
        for (let i = event.resultIndex ?? 0; i < event.results.length; i += 1) {
          const item = event.results[i];
          const text = item?.[0]?.transcript?.trim();
          if (item?.isFinal && text) transcripts.push(text);
        }
        if (transcripts.length > 0) {
          setInput((prev) => `${prev}${prev.trim() ? '\n' : ''}${transcripts.join('\n')}`);
        }
      };
      recognition.onerror = (event) => {
        setVoiceListening(false);
        toast.error(event.error ? `语音输入失败：${event.error}` : '语音输入失败');
      };
      recognition.onend = () => setVoiceListening(false);
      recognition.start();
      setVoiceListening(true);
    } catch (error) {
      setVoiceListening(false);
      toast.error(error instanceof Error ? error.message : '语音输入启动失败');
    }
  }

  function stopVoiceInput() {
    const recognition = speechRef.current;
    if (recognition) {
      recognition.onresult = null;
      recognition.stop();
      speechRef.current = null;
    }
    setVoiceListening(false);
  }

  function renderComposer() {
    const hasInspectableContext = turns.length > 0 || input.trim().length > 0 || selectedFiles.length > 0 || referencedPlugin != null || draft != null;
    const contextUsageLabel = contextWindow
      ? `${usedTokens.toLocaleString()} / ${contextWindow.toLocaleString()} tokens${compressedHint > 0 ? ` · 已压缩 ${compressedHint} 轮` : ''}`
      : `约 ${usedTokens.toLocaleString()} tokens${compressedHint > 0 ? ` · 已压缩 ${compressedHint} 轮` : ''}`;
    return (
      <CreatorComposer
        activeSkillCount={activeSkillIds.length}
        busy={busy}
        canInspectContext={hasInspectableContext}
        compressHint={compressHint}
        contextUsagePct={hasInspectableContext ? usagePct : null}
        contextUsageLabel={contextUsageLabel}
        input={input}
        mode={creatorMode}
        onClearFiles={() => setSelectedFiles([])}
        onImportFiles={() => { void importFromSelectedFiles(); }}
        onOpenContext={() => { void openContextInspector(); }}
        onOpenSkills={() => setSkillDialogOpen(true)}
        onOpenWorkspace={() => { void openWorkspaceFolder(); }}
        onInputChange={setInput}
        onModeChange={setCreatorMode}
        onOptimizePrompt={() => { void optimizePrompt(); }}
        onPickFiles={() => fileInputRef.current?.click()}
        onPickFolder={() => folderInputRef.current?.click()}
        onRefreshWorkspace={() => { void refreshWorkspaceFolder(); }}
        onRemoveFile={removeFile}
        onSend={() => { void send(); }}
        onSelectReferencedPlugin={handleSelectReferencedPlugin}
        onSelectTier={setTier}
        onStop={stop}
        onToggleVoice={toggleVoiceInput}
        recentPlugins={recentPlugins}
        selectedFiles={selectedFiles}
        optimizingPrompt={optimizingPrompt}
        tier={tier}
        referencedPlugin={referencedPlugin}
        voiceListening={voiceListening}
        workspacePath={joinDisplayPath(pluginsRoot, workspacePluginId)}
        workspacePluginId={workspacePluginId}
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

      // 整段重复检测：上游模型在多轮工具调用后会整段复述之前的总结/分析。
      // 检查当前 turn 的所有 text parts（不只末尾的），delta 已存在则跳过。
      // 这解决"几百字总结重复 5-6 次"的问题（跨 tool turn 的 text part 重复）。
      const allText = parts.filter((p): p is TextPart => p.type === 'text').map((p) => p.content).join('\n');
      if (last && last.type === 'text') {
        const deduped = detectDuplicateOutput(allText, delta);
        if (deduped === null) return next; // 判定为重复，跳过
        parts[parts.length - 1] = { ...last, content: mergeStreamingText(last.content, deduped) };
      } else {
        // 新建 text part 前也检查（跨 part 重复）
        if (detectDuplicateOutput(allText, delta) === null) return next;
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

  const answerQuestion = useCallback((turnIdx: number, toolCallId: string, answer: string) => {
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
  }, []);

  const handleAnswerDraftChange = useCallback((toolCallId: string, text: string) => {
    setAnswerDrafts((prev) => ({ ...prev, [toolCallId]: text }));
  }, []);

  const handleToggleMultiSelect = useCallback((toolCallId: string, value: string) => {
    setMultiSelectDrafts((prev) => {
      const cur = prev[toolCallId] ?? [];
      return { ...prev, [toolCallId]: cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value] };
    });
  }, []);


  return (
    <>
    {/* 隐藏输入：普通文件与文件夹分开，避免 webkitdirectory 阻断单文件选择。 */}
    <input
      ref={fileInputRef}
      type="file"
      multiple
      className="hidden"
      onChange={(e) => { handleFileSelect(e.target.files); e.target.value = ''; }}
    />
    <input
      ref={folderInputRef}
      type="file"
      // webkitdirectory 为非标准属性，React 不识别故用属性透传；选目录时浏览器给目录下全部文件。
      {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
      multiple
      className="hidden"
      onChange={(e) => { handleFileSelect(e.target.files); e.target.value = ''; }}
    />
    <div className="relative flex h-full min-h-0 w-full overflow-hidden bg-background">
      {/* 关闭/退出创建器：浮窗（替代 Dialog 默认 X）与全屏模式共用，浅色/深色均可见（z-50 防被内容遮挡）。 */}
      <button
        type="button"
        onClick={onClose}
        aria-label="关闭创建插件"
        title="关闭创建插件"
        className="absolute right-3 top-3 z-50 inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <XIcon className="size-4" />
      </button>
      <CreatorWorkspaceSidebar
            activeConversationId={activeConversationId}
            busy={busy}
            collapsed={!sidebarOpen}
            confirmDeleteId={confirmDeleteId}
            conversations={conversations}
            onCancelDeleteConversation={() => setConfirmDeleteId(null)}
            onConfirmDeleteConversation={deleteConversation}
            onDeleteConversation={setConfirmDeleteId}
            onNewConversation={newConversation}
            onSelectConversation={selectConversationById}
            onToggleCollapsed={toggleSidebar}
      />
      <div className="flex min-w-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
        {turns.length === 0 ? (
          <CreatorEmptyState onSelectPreset={setInput} />
        ) : (
          <CreatorMessageList
            turns={turns}
            busy={busy}
            scrollRef={scrollRef}
            answerDrafts={answerDrafts}
            multiSelectDrafts={multiSelectDrafts}
            todos={todos}
            publishedName={publishedName}
            compressing={compressing}
            searchingQuery={searchingQuery}
            uploadingViaTool={uploadingViaTool}
            onAnswer={answerQuestion}
            onAnswerDraftChange={handleAnswerDraftChange}
            onToggleMultiSelect={handleToggleMultiSelect}
            onRetry={retry}
          />
        )}
        {renderComposer()}
        </div>
        {draft && (
          <CreatorDraftPanel
            draft={draft}
            onChange={patchDraft}
            onSubmitted={onDraftSubmitted}
            busy={busy}
            conversationId={activeConversationId}
            turns={turns}
            workspaceId={workspacePluginId}
            onWorkspacePersisted={onWorkspacePersisted}
          />
        )}
      </div>
    </div>
    <CreatorSkillsDialog
      open={skillDialogOpen}
      onOpenChange={setSkillDialogOpen}
      activeSkillIds={activeSkillIds}
      onToggle={toggleSkill}
    />

    {/* 上下文查看面板 */}
    <ContextInspector
      breakdown={contextBreakdown}
      open={contextInspectorOpen}
      onClose={() => setContextInspectorOpen(false)}
      modelTokens={inspectorTokens}
      contextWindow={contextWindow}
      canCompress={!busy && turns.length > 0}
      compressing={compressing}
      onCompress={() => { void handleManualCompress(); }}
    />
    </>
  );
}
