import { useRef, useState, useEffect } from 'react';
import { toast } from 'sonner';
import { Loader2Icon, PlusIcon, RefreshCwIcon, MonitorIcon, SmartphoneIcon, ChevronDownIcon, StoreIcon } from 'lucide-react';
import { useApp } from '@/App';
import { api, type ApiError } from '@/lib/api';
import { streamGenerate } from '@/lib/stream';
import type { DraftTurn, DraftFile, PluginDraft } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogClose } from '@/components/ui/dialog';
import { LoadingButton } from '@/components/loading-button';
import { Markdown } from '@/components/markdown';
import { yuanToCents } from '@/lib/money';
import { cn } from '@/lib/utils';

const EXAMPLES = [
  '我要一个把视频脚本拆成分镜表的工具，有标题、分镜列表和标签',
  '做一个番茄钟计时器，可设置时长、开始暂停、到点提醒',
  '一个 Markdown 笔记本，左边写右边实时预览',
];

// 后端 create_draft 与 generate 各追加一次首条 user 描述，渲染前去重相邻同角色同内容。
function normalizeTurns(turns?: DraftTurn[]): DraftTurn[] {
  const out: DraftTurn[] = [];
  for (const t of turns || []) {
    const last = out[out.length - 1];
    if (last && last.role === t.role && last.content === t.content) continue;
    out.push(t);
  }
  return out;
}

const STATUS_LABEL: Record<string, string> = { ready: '可发布', invalid: '含校验问题', generating: '生成中', published: '已发布' };

function parseManifest(files: DraftFile[]): { name?: string; version?: string; entry: string } {
  const manifest = files.find((f) => f.path === 'manifest.json');
  try {
    const m = JSON.parse(manifest?.content || '{}');
    return { name: m.name, version: m.version, entry: m.entry || 'ui/index.html' };
  } catch {
    return { entry: 'ui/index.html' };
  }
}

function previewSrcDoc(files: DraftFile[]): string {
  const { entry } = parseManifest(files);
  const html = files.find((f) => f.path === entry)?.content || '<p>无预览入口</p>';
  const shim = `<script>
    window.sdk = {
      invoke: async (cap) => { alert('能力 ' + cap + ' 将在发布安装后由宿主网关提供'); },
      fs: { pick: async () => [], read: async () => '' },
      llm: { chat: async () => '（预览态：发布后经平台网关调用 LLM）' },
      ui: { render: (c) => { document.body.insertAdjacentHTML('beforeend', '<pre>' + (typeof c === 'string' ? c : JSON.stringify(c, null, 2)) + '</pre>'); } },
    };
  <\/script>`;
  return shim + html;
}

export function Generator() {
  const { currentDraft, setCurrentDraft } = useApp();
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [pendingUser, setPendingUser] = useState<string | null>(null);
  const [liveText, setLiveText] = useState('');
  const [liveReasoning, setLiveReasoning] = useState('');
  const [liveStage, setLiveStage] = useState('');
  const [liveError, setLiveError] = useState<string | null>(null);
  const [activeFile, setActiveFile] = useState<string>('');
  // 预览控制：刷新计数（重置 iframe）、宽度模式。
  const [previewKey, setPreviewKey] = useState(0);
  const [previewMode, setPreviewMode] = useState<'desktop' | 'mobile'>('desktop');
  const chatRef = useRef<HTMLDivElement>(null);

  const turns = normalizeTurns(currentDraft?.turns);
  const files = currentDraft?.files || [];

  useEffect(() => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight });
  }, [turns.length, liveText, pendingUser]);

  useEffect(() => {
    if (files.length && !files.find((f) => f.path === activeFile)) setActiveFile(files[0].path);
  }, [files, activeFile]);

  async function send() {
    const text = input.trim();
    if (!text || streaming) return;
    setInput('');
    setPendingUser(text);
    setLiveText('');
    setLiveReasoning('');
    setLiveStage('');
    setLiveError(null);
    setStreaming(true);
    try {
      // 首条消息：仅取草稿 id 用于流式，不提前写入 currentDraft，避免与 pendingUser 重复显示首条 user 气泡。
      let draftId = currentDraft?.id;
      if (!draftId) {
        const created = await api<PluginDraft>('/drafts', { method: 'POST', body: { prompt: text } });
        draftId = created.id;
      }
      const full = await streamGenerate(draftId, text, {
        onToken: (acc) => setLiveText(acc),
        onReasoning: (acc) => setLiveReasoning(acc),
        onStage: (stage) => setLiveStage(stage),
      });
      setCurrentDraft(full);
      setPendingUser(null);
      setLiveText('');
      setLiveReasoning('');
      setLiveStage('');
      setPreviewKey((k) => k + 1);
      toast.success(full.status === 'ready' ? '生成完成 ✓' : '生成完成（含校验问题）');
    } catch (e) {
      const err = e as ApiError;
      // 错误详情（含模型实际输出）展示在对话气泡里，便于排查；toast 仅给一句简短提示，避免刷屏。
      setLiveError(`生成失败：${err.message}`);
      const toastMsg =
        err.code === 'llm_binding_missing' ? '尚未配置 LLM 网关，请到「设置」添加'
        : err.code === 'generation_invalid' ? '生成结果不合法，详情见对话区'
        : err.code === 'upstream_llm_error' ? 'LLM 网关返回错误，详情见对话区'
        : `生成失败：${err.message}`;
      toast.error(toastMsg);
    } finally {
      setStreaming(false);
    }
  }

  async function publish() {
    if (!currentDraft) return;
    try {
      const r = await api<{ plugin_id: string; version: string }>(`/drafts/${currentDraft.id}/publish`, { method: 'POST' });
      toast.success(`插件已发布：${r.plugin_id} v${r.version}`);
      setCurrentDraft({ ...currentDraft, status: 'published', plugin_id: r.plugin_id });
    } catch (e) {
      toast.error((e as ApiError).message);
    }
  }

  function newChat() {
    setCurrentDraft(null);
    setPendingUser(null);
    setLiveText('');
    setLiveReasoning('');
    setLiveStage('');
    setLiveError(null);
  }

  const status = currentDraft?.status;
  const diags = currentDraft?.diagnostics || [];
  const activeContent = files.find((f) => f.path === activeFile)?.content || '';
  const manifest = parseManifest(files);
  const publishedPluginId = (currentDraft?.plugin_id as string) || null;

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 md:grid-cols-[minmax(360px,1fr)_1.1fr]">
      {/* 左：对话 */}
      <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border bg-card">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-base font-semibold">造插件</h2>
          <Button variant="ghost" size="sm" onClick={newChat}>
            <PlusIcon className="size-4" />新对话
          </Button>
        </div>

        <div ref={chatRef} className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
          {!turns.length && !pendingUser ? (
            <div className="m-auto max-w-sm text-center text-muted-foreground">
              <p>描述你想要的功能，AI 会直接生成可运行的插件，右侧即时预览。满意后发布。</p>
              <div className="mt-4 flex flex-col gap-2">
                {EXAMPLES.map((x) => (
                  <button key={x} className="rounded-md border border-dashed px-3 py-2 text-left text-sm hover:border-primary hover:text-primary" onClick={() => setInput(x)}>
                    {x}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <>
              {turns.map((t, i) => <Bubble key={i} role={t.role} content={t.content} />)}
              {pendingUser && <Bubble role="user" content={pendingUser} />}
              {streaming && <LiveProcess stage={liveStage} text={liveText} reasoning={liveReasoning} />}
              {!streaming && liveError && <Bubble role="assistant" content={liveError} error />}
            </>
          )}
        </div>

        <div className="border-t p-3">
          <Textarea
            placeholder="用一句话描述你想要的插件，回车发送（Shift+Enter 换行）"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            className="max-h-40 min-h-14 resize-none"
          />
          <div className="mt-2 flex items-center justify-end gap-2">
            {streaming && <span className="mr-auto inline-flex items-center text-sm text-muted-foreground"><Loader2Icon className="mr-1 size-3.5 animate-spin" />生成中…</span>}
            <Button onClick={send} disabled={streaming || !input.trim()}>发送</Button>
          </div>
        </div>
      </div>

      {/* 右：预览 */}
      <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border bg-card">
        <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="shrink-0 text-base font-semibold">预览</h2>
            {manifest.name && <span className="truncate text-sm text-muted-foreground">{manifest.name}{manifest.version ? ` v${manifest.version}` : ''}</span>}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {status && <Badge variant={status === 'ready' ? 'default' : status === 'invalid' ? 'destructive' : 'secondary'}>{STATUS_LABEL[status] || status}</Badge>}
            {files.length > 0 && (
              <>
                <Button variant={previewMode === 'desktop' ? 'secondary' : 'ghost'} size="icon-sm" title="桌面宽度" onClick={() => setPreviewMode('desktop')}><MonitorIcon className="size-4" /></Button>
                <Button variant={previewMode === 'mobile' ? 'secondary' : 'ghost'} size="icon-sm" title="移动宽度" onClick={() => setPreviewMode('mobile')}><SmartphoneIcon className="size-4" /></Button>
                <Button variant="ghost" size="icon-sm" title="刷新预览" onClick={() => setPreviewKey((k) => k + 1)}><RefreshCwIcon className="size-4" /></Button>
              </>
            )}
          </div>
        </div>

        {!files.length ? (
          <div className="flex flex-1 items-center justify-center p-4 text-center text-muted-foreground">
            描述需求并发送后，<br />生成的插件会在这里即时预览。
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
            {/* iframe 预览：填满剩余高度，移动模式限宽居中 */}
            <div className={cn('flex min-h-0 flex-1 justify-center overflow-hidden rounded-md border bg-white', previewMode === 'mobile' && 'bg-muted')}>
              <iframe
                key={previewKey}
                title="preview"
                sandbox="allow-scripts"
                srcDoc={previewSrcDoc(files)}
                className={cn('h-full border-0 bg-white', previewMode === 'mobile' ? 'w-[390px] shadow-md' : 'w-full')}
              />
            </div>

            <div className="flex items-center gap-2">
              <LoadingButton disabled={status !== 'ready' && status !== 'published'} onClick={publish}>
                {status === 'published' ? '重新发布' : '发布插件'}
              </LoadingButton>
              {(status === 'published' || publishedPluginId) && (
                <PublishToMarketDialog pluginId={publishedPluginId} />
              )}
            </div>

            {/* 校验诊断 + 代码（折叠在下方，预览优先） */}
            <details className="rounded-md border">
              <summary className="flex cursor-pointer items-center gap-1.5 px-3 py-2 text-sm font-medium">
                <ChevronDownIcon className="size-4" />校验诊断与源码
              </summary>
              <div className="border-t p-3">
                <h3 className="mb-2 text-sm font-semibold">校验诊断</h3>
                {diags.length ? diags.map((d, i) => (
                  <div key={i} className={cn('text-sm', d.status === 'pass' ? 'text-green-600' : 'text-destructive')}>
                    [{d.stage}] {d.status} — {d.message}
                  </div>
                )) : <span className="text-sm text-muted-foreground">无</span>}

                <h3 className="mb-2 mt-3 text-sm font-semibold">生成的代码</h3>
                <Tabs value={activeFile} onValueChange={setActiveFile}>
                  <TabsList className="flex-wrap">
                    {files.map((f) => <TabsTrigger key={f.path} value={f.path}>{f.path}</TabsTrigger>)}
                  </TabsList>
                </Tabs>
                <pre className="mt-2 max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs">{activeContent}</pre>
              </div>
            </details>
          </div>
        )}
      </div>
    </div>
  );
}

// 发布到市场对话框：填价格（元）→ 转 cents → POST /marketplace/publish。
function PublishToMarketDialog({ pluginId }: { pluginId: string | null }) {
  const [open, setOpen] = useState(false);
  const [price, setPrice] = useState('0');
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (!pluginId) return toast.error('请先发布插件');
    const cents = yuanToCents(price);
    setSubmitting(true);
    try {
      await api('/marketplace/publish', { method: 'POST', body: { plugin_id: pluginId, price_cents: cents } });
      toast.success('已提交市场审核，通过后对其他团队可见');
      setOpen(false);
    } catch (e) {
      toast.error((e as ApiError).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline"><StoreIcon className="size-4" />发布到市场</Button>} />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>发布到市场</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">设置售价（填 0 即免费）。提交后需经平台审核，通过后其他团队可搜索、购买、安装。</p>
          <div className="flex items-center gap-2">
            <span className="text-sm">售价 ¥</span>
            <Input type="number" min="0" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} className="w-32" />
          </div>
        </div>
        <div className="mt-2 flex justify-end gap-2">
          <DialogClose render={<Button variant="ghost">取消</Button>} />
          <LoadingButton loading={submitting} onClick={submit}>提交审核</LoadingButton>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// 流式「生成过程」卡片：思考（reasoning）+ 阶段提示 + 实时正文。
// 有思考时优先展示「正在思考」与思考内容；正文开始后展示阶段与代码流。
function LiveProcess({ stage, text, reasoning }: { stage: string; text: string; reasoning: string }) {
  const thinking = !!reasoning && !text; // 仅思考、正文未开始 → 突出「正在思考」
  return (
    <div className="max-w-[86%] self-start rounded-xl rounded-bl-sm border bg-muted/60 px-3.5 py-2.5">
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-foreground/80">
        <Loader2Icon className="size-3.5 animate-spin text-primary" />
        <span>{thinking ? '正在思考…' : (stage || '生成中…')}</span>
      </div>
      {reasoning && (
        <details className="mb-1.5" open={thinking}>
          <summary className="cursor-pointer text-[11px] text-muted-foreground/80 select-none">💭 思考过程</summary>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words border-l-2 border-primary/30 pl-2 font-mono text-xs text-muted-foreground/90">{reasoning}</pre>
        </details>
      )}
      {text && <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">{text}</pre>}
      {!reasoning && !text && <pre className="font-mono text-xs text-muted-foreground">…</pre>}
    </div>
  );
}

function Bubble({ role, content, error }: { role: 'user' | 'assistant'; content: string; error?: boolean }) {
  const isUser = role === 'user';
  return (
    <div className={cn('max-w-[86%] rounded-xl px-3.5 py-2.5 text-sm break-words', isUser ? 'self-end rounded-br-sm bg-primary text-primary-foreground whitespace-pre-wrap' : 'self-start rounded-bl-sm bg-muted', error && 'whitespace-pre-wrap border border-destructive/30 bg-destructive/5 text-destructive')}>
      <span className="mb-1 block text-[11px] opacity-70">{isUser ? '你' : 'AI'}</span>
      {error ? <div className="max-h-72 overflow-auto">{content}</div> : isUser ? content : <Markdown>{content}</Markdown>}
    </div>
  );
}
