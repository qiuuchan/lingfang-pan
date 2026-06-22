// FloatingCreator —— 悬浮窗 + 对话式 + 流式的 AI 插件创建器（v4 形态，relay 后端）。
//
// 设计（对照旧 v4 创建器，去掉 code_assistant CLI 依赖）：
//  - 悬浮窗：App 渲染为全屏遮罩 + 居中面板（~85vh），不切 view，关窗即回原页。
//  - 对话式：多轮聊天（用户/助手气泡），输入框在底部，Enter 发送。
//  - 流式：调 relay SSE（streamChat），助手回复逐 token 流入末条助手气泡。
//  - 产物：助手完整回复若含 ```lingfang-plugin JSON 块，解析为插件包 → 显示预览 + 上传。
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { SparklesIcon, XIcon, SendIcon, UploadIcon, Loader2Icon, WrenchIcon } from 'lucide-react';
import { useApp } from '@/App';
import { type ApiError } from '@/lib/api';
import { streamChat, type ChatMessage } from '@/lib/relay-chat-stream';
import { parsePackageBlock, uploadCreatedPlugin, type CreatedPluginPackage } from '@/lib/plugin-creator/relay-creator';
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

const SYSTEM_PROMPT = `你是灵坊平台的插件生成助手。用户会用自然语言描述需求，你帮忙生成插件。

当需求明确、信息足够时，输出**一个** \`\`\`lingfang-plugin JSON 代码块（前后不要额外解释），结构：
{
  "manifest": {
    "id": "<kebab-case>",
    "name": "<展示名>",
    "version": "0.1.0",
    "description": "<一句话>",
    "runtime_type": "client" | "nodejs" | "python",
    "entry": "<client: ui/index.html; nodejs: index.js; python: main.py>",
    "visibility": "team",
    "capabilities": [{ "kind": "ui.view", "reason": "<为何>", "risk": "low" }]
  },
  "files": [{ "path": "<相对路径>", "content": "<文件全文>" }]
}
约束：client 入口 ui/index.html（内联 CSS/JS）；nodejs 含 package.json+index.js；python 含 main.py+requirements.txt。文件路径禁绝对/空段/../。代码完整可运行。插件如需调 AI 必须用灵坊平台 sdk.llm.chat / sdk.image.generate。

需求信息不够时，先用简短对话提问澄清（不要输出代码块）。每次只产出一个插件包。`;

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
  const [pkg, setPkg] = useState<CreatedPluginPackage | null>(null);
  const [uploading, setUploading] = useState(false);
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
    setPkg(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // 系统提示词 = 基础提示 + 激活的 skills；relay 服务端还会注入"必须用灵坊服务"规则。
      const systemPrompt = assembleSystemPrompt(SYSTEM_PROMPT, activeSkillIds);
      // 上下文自动压缩：超阈值时把较早的纯对话轮摘要成一条（保留近期原文 + 含插件包的轮）。
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
      const full = await streamChat({
        messages: built.messages,
        tier,
        signal: controller.signal,
        onDelta: (delta) => {
          setTurns((prev) => {
            const next = [...prev];
            const cur = next[assistantIdx];
            if (cur && cur.role === 'assistant') next[assistantIdx] = { ...cur, content: cur.content + delta };
            return next;
          });
        },
      });
      // 结束流式标记；检测插件包。
      setTurns((prev) => {
        const next = [...prev];
        const cur = next[assistantIdx];
        if (cur && cur.role === 'assistant') next[assistantIdx] = { ...cur, content: full, streaming: false };
        return next;
      });
      const detected = parsePackageBlock(full);
      if (detected) setPkg(detected);
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

  async function upload() {
    if (!pkg) return;
    setUploading(true);
    try {
      await uploadCreatedPlugin(pkg);
      toast.success(`插件「${pkg.manifest.name}」已上传到团队空间`);
      setPkg(null);
      onClose();
    } catch (e) {
      toast.error((e as ApiError).message || '上传失败');
    } finally {
      setUploading(false);
    }
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

        {/* 产物预览 + 上传 */}
        {pkg && (
          <div className="shrink-0 border-t bg-muted/30 px-4 py-2.5">
            <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
              <div className="min-w-0 flex-1 text-sm">
                <span className="font-medium">已生成插件：{pkg.manifest.name}</span>
                <span className="ml-2 text-xs text-muted-foreground">{pkg.manifest.runtime_type} · {pkg.files.length} 文件</span>
              </div>
              <Button size="sm" onClick={upload} disabled={uploading}>
                {uploading ? <Loader2Icon className="mr-1 size-3.5 animate-spin" /> : <UploadIcon className="mr-1 size-3.5" />}
                上传到团队
              </Button>
            </div>
          </div>
        )}

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
