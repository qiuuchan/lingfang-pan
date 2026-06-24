// FloatingCreator —— 悬浮窗 + 对话式 + 流式 AI 插件创建器（Vercel AI SDK agent）。
//
//  - 悬浮窗：App 渲染为全屏遮罩 + 居中面板（~85vh），不切 view，关窗即回原页。
//  - 对话式：多轮聊天（用户/助手气泡），输入框在底部，Enter 发送。
//  - 流式 + agent：Vercel AI SDK streamText 走 relay；模型生成插件后**自己调用 upload_plugin 工具**上传
//    （不再吐代码块让用户手动点）。fullStream 给文本增量 + 工具调用/结果事件，UI 实时反馈。
//  - 上下文自动压缩 + Skill 动态拼装系统提示词保留。
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { streamText, stepCountIs } from 'ai';
import { SparklesIcon, XIcon, SendIcon, Loader2Icon, WrenchIcon, BrainIcon, FileCode2Icon, PlusIcon, CheckCircle2Icon, HistoryIcon } from 'lucide-react';
import { useApp } from '@/App';
import type { LoadedPlugin } from '@/lib/types';
import { api, type ApiError } from '@/lib/api';
import { relayProvider } from '@/lib/relay-provider';
import { creatorTools } from '@/lib/plugin-creator/creator-tools';
import { assembleSystemPrompt, DEFAULT_ACTIVE_SKILLS, SKILLS } from '@/lib/skills';
import { buildContextMessages, emptyCompressState } from '@/lib/plugin-creator/context-compress';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Markdown } from '@/components/markdown';

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  /** 仅 assistant：本轮是否仍在流式输出中。 */
  streaming?: boolean;
  status?: 'generating' | 'done' | 'failed' | 'cancelled';
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

const SYSTEM_PROMPT = `你是灵坊平台的插件生成助手。用户用自然语言描述需求，你帮忙生成并上传插件。

工作方式（agent）：
- 信息不足时先简短提问澄清（不要调用工具）。
- 需求明确、信息足够时，**调用 upload_plugin 工具**上传完整插件包（不要把插件代码作为普通文本输出）。
- upload_plugin 的参数：id（kebab-case，仅小写字母/数字/连字符）、name、version（默认 0.1.0）、description、
  runtime_type（client/nodejs/python）、entry（入口文件路径）、files（[{path, content}] 全部文件全文）。
  - client → entry=ui/index.html（内联 CSS/JS）；
  - nodejs → entry=index.js，files 含 package.json（无依赖用 {}）与 index.js；
  - python → entry=main.py，files 含 requirements.txt（可空）与 main.py。
- 工具返回 {ok, message}：成功则告诉用户「已上传 <name>」；失败则据 message 修正后重试。
- 文件路径只能是相对路径，禁绝对/空段/..。
- 插件如需调 AI，必须用灵坊平台 sdk.llm.chat / sdk.image.generate（见 relay-access skill），禁第三方接口。
- 回复简短，不复述生成的全部文件内容（工具已上传）。`;

/**
 * 上下文自动压缩见 lib/plugin-creator/context-compress.ts（超阈值时摘要早期对话轮，保留近期+插件包原文）。
 */
export function FloatingCreator({ onClose }: { onClose: () => void }) {
  const { session, recentPlugins } = useApp();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [conversations, setConversations] = useState<CreatorConversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [tier, setTier] = useState<'fast' | 'premium'>('fast');
  const [activeSkillIds, setActiveSkillIds] = useState<string[]>(DEFAULT_ACTIVE_SKILLS);
  const [busy, setBusy] = useState(false);
  const [thinking, setThinking] = useState(true); // 「思考」模式默认开启：让模型更深入推理（systemPrompt 追加引导）
  const [historyOpen, setHistoryOpen] = useState(false);
  const [referencedPlugin, setReferencedPlugin] = useState<LoadedPlugin | null>(null); // 引用的现有插件（让 agent 基于其代码修改）
  const [compressing, setCompressing] = useState(false); // 压缩中指示
  const [uploadingViaTool, setUploadingViaTool] = useState(false); // agent 工具上传中指示
  const [compressedHint, setCompressedHint] = useState(0); // 上次压缩的轮数（UI 指示）
  const [publishedName, setPublishedName] = useState<string | null>(null); // 已发布插件名（agent upload 成功后显示成功卡片）
  const [contextWindow, setContextWindow] = useState<number | null>(null); // 当前 tier 模型的上下文窗口（token）
  const [reasoning, setReasoning] = useState(''); // 当前轮思考内容流式累积（支持思考输出的模型）
  const compressRef = useRef(emptyCompressState());
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

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
    setBusy(false);
    setUploadingViaTool(false);
    setCompressing(false);
    setActiveConversationId(conversation.id);
    setTurns(conversation.turns);
    setReasoning('');
    setPublishedName(null);
    compressRef.current = emptyCompressState();
    try { localStorage.setItem(selectedConversationKey(session.userId, session.tenantId), conversation.id); } catch { /* ignore */ }
    setHistoryOpen(false);
  }

  function newConversation() {
    abortRef.current?.abort();
    setBusy(false);
    setTurns([]);
    setActiveConversationId(null);
    setReasoning('');
    setReferencedPlugin(null);
    setPublishedName(null);
    compressRef.current = emptyCompressState();
    setCompressedHint(0);
    try { localStorage.removeItem(selectedConversationKey(session.userId, session.tenantId)); } catch { /* ignore */ }
    setHistoryOpen(false);
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

  // Esc 关窗（无内层 overlay 打开时）。
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const inner = document.querySelector('[role="dialog"][data-state="open"], [role="presentation"][data-state="open"]');
      if (inner) return; // 内层 overlay 优先
      abortRef.current?.abort();
      onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

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
      const systemPrompt = basePrompt + thinkPrompt + refPrompt;
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

      // Vercel AI SDK：streamText 走 relay，工具调用让模型自己调 upload_plugin 上传。
      // 文本 delta 流式累积进 assistant 气泡；tool-call/result 用独立指示器（不污染文本气泡）。
      const result = streamText({
        model: relayProvider().chat(tier),
        messages: built.messages,
        tools: creatorTools,
        stopWhen: stepCountIs(4), // 允许：生成 → 调 upload_plugin → 看结果 → 总结
        abortSignal: controller.signal,
      });

      let uploadedName = '';
      let uploadedMsg = '';
      setReasoning('');
      for await (const part of result.fullStream) {
        if (part.type === 'reasoning-delta') {
          // #3 思考流式输出：部分模型支持 reasoning（Claude/OpenAI o-series），把思考增量单独累积展示。
          const delta = (part as { text?: string; delta?: string }).text ?? (part as { delta?: string }).delta ?? '';
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
          // agent 工具调用：用独立指示器，不把文本塞进对话气泡（避免与后续 delta 混杂）。
          if (part.toolName === 'upload_plugin') setUploadingViaTool(true);
        } else if (part.type === 'tool-result') {
          setUploadingViaTool(false);
          const r = part.output as { ok: boolean; message: string; name?: string } | undefined;
          if (r?.ok && r.name) { uploadedName = r.name; setPublishedName(r.name); }
          else if (r && !r.ok) uploadedMsg = r.message;
        }
      }
      // 流结束：清除流式标记（保留已累积的 delta 文本，不覆盖——result.text 是末步，会丢中间步骤）。
      // 多步 agent 的各步文本已通过 fullStream 累积进气泡；末步总结也已 delta 进来。
      setTurns((prev) => {
        const next = [...prev];
        const cur = next[assistantIdx];
        if (cur && cur.role === 'assistant') next[assistantIdx] = { ...cur, streaming: false, status: 'done' };
        return next;
      });
      if (uploadedName) toast.success(`插件「${uploadedName}」已上传到团队空间`);
      else if (uploadedMsg) toast.error(uploadedMsg);
    } catch (e) {
      const aborted = (e as Error).name === 'AbortError';
      setUploadingViaTool(false);
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
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  function toggleSkill(id: string) {
    setActiveSkillIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  return (
    <>
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-md">
      <div className="flex h-[85vh] max-h-[800px] w-full max-w-[1100px] min-h-[480px] flex-col overflow-hidden rounded-2xl border bg-background shadow-2xl">
        {/* 标题栏 */}
        <div className="flex shrink-0 items-center justify-between border-b px-4 py-2.5">
          <div className="flex items-center gap-2">
            <SparklesIcon className="size-4 text-primary" />
            <span className="text-sm font-medium">AI 创建插件</span>
            <Badge variant="secondary" className="text-xs">{session.tenantName ?? '当前团队'}</Badge>
          </div>
          <div className="flex items-center gap-2">
            {/* 上下文自动压缩指示：超阈值时把早期对话轮摘要，保留近期+插件包。 */}
            {compressedHint > 0 && (
              <Badge variant="outline" className="gap-1 text-xs" title="早期对话已自动摘要为上下文，控制 token">
                已压缩 {compressedHint} 轮
              </Badge>
            )}
            <Button variant="outline" size="sm" className="gap-1.5" title="对话历史" onClick={() => setHistoryOpen(true)}>
              <HistoryIcon className="size-3.5" />
              历史
            </Button>
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
            {/* Skill 选择器：动态拼装系统提示词（输出精简 / 增量重构 等，可开关）。 */}
            <Popover>
              <PopoverTrigger render={<Button variant="outline" size="sm" className="gap-1.5" title="Skill" />}>
                <WrenchIcon className="size-3.5" />
                Skill
                {activeSkillIds.length > 0 && <Badge variant="secondary" className="h-4 px-1 text-[10px]">{activeSkillIds.length}</Badge>}
              </PopoverTrigger>
              <PopoverContent className="w-72" align="end">
                <div className="text-xs font-medium text-muted-foreground">Skill（拼入系统提示词）</div>
                <div className="mt-2 space-y-2">
                  {SKILLS.map((s) => (
                    <label key={s.id} className="flex cursor-pointer items-start gap-2 rounded-md p-1.5 hover:bg-muted">
                      <Checkbox checked={activeSkillIds.includes(s.id)} onCheckedChange={() => toggleSkill(s.id)} className="mt-0.5" />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium">{s.name}</div>
                        <div className="text-xs text-muted-foreground">{s.description}</div>
                      </div>
                    </label>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
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
            {turns.length > 0 && (
              <button type="button" onClick={newConversation} title="新建对话" className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
                <PlusIcon className="size-4" />
              </button>
            )}
          </div>
        </div>

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
                      ) : t.status === 'failed' ? (
                        <span className="text-destructive">调用失败</span>
                      ) : t.status === 'cancelled' ? (
                        <span className="text-muted-foreground">已取消</span>
                      ) : !t.streaming ? (
                        <span className="text-muted-foreground">无内容</span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-muted-foreground"><Loader2Icon className="size-3 animate-spin" />生成中…</span>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          {/* #4 发布成功卡片：agent upload_plugin 成功后明确告知用户「已发布到团队空间」 */}
          {publishedName && (
            <div className="mx-auto mt-4 max-w-3xl">
              <div className="flex items-center gap-3 rounded-xl border border-green-300 bg-green-50 p-3 dark:border-green-800 dark:bg-green-950/30">
                <CheckCircle2Icon className="size-5 shrink-0 text-green-600" />
                <div className="flex-1 text-sm">
                  <div className="font-medium">插件「{publishedName}」已发布到团队空间</div>
                  <div className="text-xs text-muted-foreground">团队成员现可在插件中心看到并安装它。点「+」新建对话可继续创建下一个。</div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* 上传由 agent 工具调用（upload_plugin）驱动，无需手动预览/上传栏。 */}

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

        {/* 状态指示（压缩中 / agent 工具上传中） */}
        {(compressing || uploadingViaTool) && (
          <div className="shrink-0 border-t bg-muted/30 px-4 py-1.5">
            <div className="mx-auto flex max-w-3xl items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2Icon className="size-3 animate-spin" />
              {compressing ? '正在压缩对话上下文…' : 'agent 正在上传插件…'}
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
          {conversations.length ? conversations.map((conversation) => (
            <button
              key={conversation.id}
              type="button"
              onClick={() => selectConversation(conversation)}
              className={`block w-full rounded-md border px-3 py-2 text-left transition-colors ${conversation.id === activeConversationId ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:bg-muted'}`}
              title={conversation.title}
            >
              <span className="block truncate text-sm font-medium">{conversation.title}</span>
              <span className="block text-xs text-muted-foreground">{new Date(conversation.updatedAt).toLocaleString('zh-CN', { hour12: false })}</span>
            </button>
          )) : <div className="py-8 text-center text-sm text-muted-foreground">暂无历史对话</div>}
        </div>
      </DialogContent>
    </Dialog>
    </>
  );
}
