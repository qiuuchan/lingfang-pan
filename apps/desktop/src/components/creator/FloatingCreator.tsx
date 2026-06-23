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
import { SparklesIcon, XIcon, SendIcon, Loader2Icon, WrenchIcon } from 'lucide-react';
import { useApp } from '@/App';
import { type ApiError } from '@/lib/api';
import { relayProvider } from '@/lib/relay-provider';
import { creatorTools } from '@/lib/plugin-creator/creator-tools';
import { assembleSystemPrompt, DEFAULT_ACTIVE_SKILLS, SKILLS } from '@/lib/skills';
import { buildContextMessages, emptyCompressState } from '@/lib/plugin-creator/context-compress';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  /** 仅 assistant：本轮是否仍在流式输出中。 */
  streaming?: boolean;
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
  const { session } = useApp();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [tier, setTier] = useState<'fast' | 'premium'>('fast');
  const [activeSkillIds, setActiveSkillIds] = useState<string[]>(DEFAULT_ACTIVE_SKILLS);
  const [busy, setBusy] = useState(false);
  const [compressedHint, setCompressedHint] = useState(0); // 上次压缩的轮数（UI 指示）
  const compressRef = useRef(emptyCompressState());
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 流式输出时自动滚到底。
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns]);

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
    const userTurn: Turn = { role: 'user', content: text };
    const assistantIdx = turns.length + 1;
    setTurns((prev) => [...prev, userTurn, { role: 'assistant', content: '', streaming: true }]);
    setBusy(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // 系统提示词 = 基础提示 + 激活的 skills；relay 服务端还会注入"必须用灵坊服务"规则。
      const systemPrompt = assembleSystemPrompt(SYSTEM_PROMPT, activeSkillIds);
      // 上下文自动压缩：超阈值时摘要较早对话轮（保留近期 + 含插件包的轮）。
      const built = await buildContextMessages({
        turns: turns.map((t) => ({ role: t.role, content: t.content })),
        currentInput: text,
        systemPrompt,
        state: compressRef.current,
        tier,
        signal: controller.signal,
      });
      compressRef.current = built.state;
      setCompressedHint(built.compressedCount);

      // Vercel AI SDK：streamText 走 relay，工具调用让模型自己调 upload_plugin 上传。
      // fullStream 同时给文本增量 + 工具调用/结果事件，实现 agent 闭环。
      const result = streamText({
        model: relayProvider().chat(tier),
        messages: built.messages,
        tools: creatorTools,
        stopWhen: stepCountIs(4), // 允许：生成 → 调 upload_plugin → 看结果 → 总结
        abortSignal: controller.signal,
      });

      let uploadedName = '';
      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') {
          const delta = part.text;
          setTurns((prev) => {
            const next = [...prev];
            const cur = next[assistantIdx];
            if (cur && cur.role === 'assistant') next[assistantIdx] = { ...cur, content: cur.content + delta };
            return next;
          });
        } else if (part.type === 'tool-call') {
          // 模型调用了工具：在气泡里显示调用态。
          if (part.toolName === 'upload_plugin') {
            setTurns((prev) => {
              const next = [...prev];
              const cur = next[assistantIdx];
              if (cur && cur.role === 'assistant') next[assistantIdx] = { ...cur, content: cur.content + '\n\n_[正在上传插件…]_' };
              return next;
            });
          }
        } else if (part.type === 'tool-result') {
          const r = part.output as { ok: boolean; message: string; name?: string };
          if (r?.ok && r.name) uploadedName = r.name;
        }
      }
      // 流结束：取完整文本，清除流式标记；若工具已上传，提示并保留对话。
      const full = await result.text;
      setTurns((prev) => {
        const next = [...prev];
        const cur = next[assistantIdx];
        if (cur && cur.role === 'assistant') next[assistantIdx] = { ...cur, content: full, streaming: false };
        return next;
      });
      if (uploadedName) toast.success(`插件「${uploadedName}」已上传到团队空间`);
    } catch (e) {
      const aborted = (e as Error).name === 'AbortError';
      setTurns((prev) => {
        const next = [...prev];
        const cur = next[assistantIdx];
        if (cur && cur.role === 'assistant') next[assistantIdx] = { role: 'assistant', content: aborted ? '（已取消）' : `⚠️ ${(e as Error).message}`, streaming: false };
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
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-background/40 backdrop-blur-xl">
      <div className="flex h-[85vh] w-[92vw] min-h-[480px] min-w-[720px] max-w-[1200px] flex-col overflow-hidden rounded-2xl border bg-background shadow-2xl">
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
                  <div className={`max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-sm ${t.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground'}`}>
                    {t.content || (t.streaming ? <span className="inline-flex items-center gap-1 text-muted-foreground"><Loader2Icon className="size-3 animate-spin" />生成中…</span> : '')}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 上传由 agent 工具调用（upload_plugin）驱动，无需手动预览/上传栏。 */}


        {/* 输入区 */}
        <div className="shrink-0 border-t px-4 py-3">
          <div className="mx-auto flex max-w-3xl items-end gap-2">
            <Textarea
              placeholder="描述插件需求，Enter 发送，Shift+Enter 换行"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
              rows={1}
              className="min-h-[40px] max-h-32 resize-none"
              disabled={busy}
            />
            {busy ? (
              <Button variant="outline" size="icon" onClick={stop} title="停止"><XIcon className="size-4" /></Button>
            ) : (
              <Button size="icon" onClick={() => void send()} disabled={!input.trim()} title="发送"><SendIcon className="size-4" /></Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
