// CreatorDraftPanel —— 创建器右侧分栏：草稿预览 + 信息编辑 + 保存本地。
//
// AI 通过 stage_plugin 暂存草稿后，这里实时预览效果并允许用户改信息（名字/描述、ID/版本、
// 运行类型/入口、能力/可见性），用户也可继续对话让 AI 迭代。点「保存草稿到本地」写入本地文件系统，
// 后续可在插件中心「我的草稿」查看、运行和发布到团队。
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Loader2Icon, SendIcon, FileCode2Icon, RefreshCwIcon, ChevronDownIcon } from 'lucide-react';
import { type CapabilityKind as CapabilityKindType } from '@lingfang/contract';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { submitStagedPlugin, type StagedPlugin } from '@/lib/plugin-creator/creator-tools';
import { saveDraftPlugin } from '@/lib/draft-plugin';

const RUNTIME_LABELS: Record<StagedPlugin['runtime_type'], string> = {
  client: '前端（软件内 iframe）',
  nodejs: 'Node.js（独立进程）',
  python: 'Python（独立进程）',
};

// 能力白名单：必须与后端 plugin-package.ts ALLOWED_CAPABILITIES 完全一致，否则勾选后端不认的能力会 400。
// 注意：契约 CapabilityKind 含 image.generate，但后端白名单没有——故这里不直接用 CapabilityKind.options。
const ALLOWED_CAPABILITY_KINDS: CapabilityKindType[] = [
  'ui.view', 'fs.pick', 'fs.read', 'fs.write', 'net.fetch',
  'clipboard', 'llm.chat', 'storage.kv',
  'system.info', 'system.screenshot', 'system.notify',
  'code-assistant.run', 'code-assistant.session', 'plugin.upload', 'plugin.submitMarketplace',
];

/** 构造预览 srcDoc：注入宿主设计令牌 + sdk shim，再拼接入口 HTML（与 manifest.previewSrcDoc 行为一致）。 */
function buildPreview(draft: StagedPlugin): string {
  const html = draft.files.find((f) => f.path === draft.entry)?.content || '<p style="padding:24px;font-family:system-ui">无预览入口</p>';
  const tokens = `<style data-lf-tokens>:root{--lf-color-primary:#2563eb;--lf-color-bg:#fafafa;--lf-color-text:#1a1a1a;--lf-color-border:#dddddd;--lf-radius-md:10px;--lf-spacing-md:14px;--lf-font-sans:system-ui,sans-serif;}</style>`;
  const shim = `<script>
    window.sdk = {
      invoke: async (cap) => { alert('能力 ' + cap + ' 将在发布后由宿主网关提供'); },
      llm: { chat: async () => '（预览态：发布后由灵坊平台执行）' },
      image: { generate: async () => '（预览态：发布后由灵坊平台执行）' },
      codeAssistant: { run: async () => '（预览态：发布后由本地代码助手执行）' },
      ui: { render: (c) => { document.body.insertAdjacentHTML('beforeend', '<pre>' + (typeof c === 'string' ? c : JSON.stringify(c, null, 2)) + '</pre>'); } },
    };
  <\/script>`;
  return tokens + shim + html;
}

export function CreatorDraftPanel({
  draft,
  onChange,
  onSubmitted,
  busy,
  conversationId,
  turns,
}: {
  draft: StagedPlugin;
  onChange: (patch: Partial<StagedPlugin>) => void;
  onSubmitted: (name: string) => void;
  /** 对话流式进行中：提交禁用，避免改了一半又被 AI 重新 stage 覆盖。 */
  busy: boolean;
  /** 对话 ID（保存草稿时记录，供编辑时恢复）。 */
  conversationId?: string | null;
  /** 对话轮次（保存草稿时记录，供编辑时恢复）。 */
  turns?: unknown[];
}) {
  const [submitting, setSubmitting] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);
  const [infoOpen, setInfoOpen] = useState(true);

  const isClient = draft.runtime_type === 'client';
  const entryMissing = !draft.files.some((f) => f.path === draft.entry);
  const idValid = /^[a-z0-9-]+$/.test(draft.id);
  const srcDoc = useMemo(() => buildPreview(draft), [draft]);

  const capKinds = ALLOWED_CAPABILITY_KINDS;
  const activeCaps = new Set(draft.capabilities.map((c) => c.kind));

  function toggleCapability(kind: CapabilityKindType) {
    const next = activeCaps.has(kind)
      ? draft.capabilities.filter((c) => c.kind !== kind)
      : [...draft.capabilities, { kind, reason: '', risk: 'low' as const, requires_admin: false }];
    onChange({ capabilities: next });
  }

  async function handleSaveDraft() {
    if (!draft.name.trim()) { toast.error('请填写插件名字'); return; }
    if (!idValid) { toast.error('插件 ID 仅允许小写字母/数字/连字符'); return; }
    if (entryMissing) { toast.error(`入口文件 ${draft.entry} 不在文件列表中`); return; }
    setSubmitting(true);
    try {
      await saveDraftPlugin({
        id: draft.id,
        manifest: {
          id: draft.id,
          name: draft.name,
          version: draft.version,
          entry: draft.entry,
          description: draft.description,
          capabilities: draft.capabilities,
          visibility: draft.visibility,
          runtime_type: draft.runtime_type,
          draft: true,
        },
        files: draft.files.map(f => [f.path, f.content]),
        conversationId: conversationId ?? undefined,
        turns: turns && turns.length > 0 ? JSON.stringify(turns) : undefined,
      });
      toast.success(`草稿「${draft.name}」已保存到本地`);
      onSubmitted(draft.name);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex h-full w-[420px] shrink-0 flex-col border-l bg-muted/20">
      {/* 预览区 */}
      <div className="flex shrink-0 items-center justify-between border-b px-3 py-2">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <FileCode2Icon className="size-3.5" />
          草稿预览
        </div>
        {isClient && (
          <button
            type="button"
            onClick={() => setPreviewKey((k) => k + 1)}
            title="刷新预览"
            className="inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <RefreshCwIcon className="size-3.5" />
          </button>
        )}
      </div>
      <div className="min-h-[200px] flex-1 overflow-hidden bg-white">
        {isClient ? (
          entryMissing ? (
            <div className="flex h-full items-center justify-center p-4 text-center text-xs text-destructive">
              入口文件 {draft.entry} 不存在，无法预览。可在下方改入口，或让 AI 重新生成。
            </div>
          ) : (
            <iframe
              key={previewKey}
              title="草稿预览"
              sandbox="allow-scripts allow-forms allow-popups"
              srcDoc={srcDoc}
              className="h-full w-full border-0"
            />
          )
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-xs text-muted-foreground">
            <FileCode2Icon className="size-8 text-muted-foreground/40" />
            <p>{RUNTIME_LABELS[draft.runtime_type]}插件在独立进程运行，无法在此可视化预览。</p>
            <p>可核对下方信息与文件后提交，发布后在插件中心运行查看输出。</p>
          </div>
        )}
      </div>

      {/* 信息编辑区 */}
      <div className="flex max-h-[55%] shrink-0 flex-col border-t">
        <button
          type="button"
          onClick={() => setInfoOpen((v) => !v)}
          className="flex shrink-0 items-center justify-between px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-muted/50"
        >
          <span>插件信息（提交前可修改）</span>
          <ChevronDownIcon className={`size-3.5 transition-transform ${infoOpen ? '' : '-rotate-90'}`} />
        </button>
        {infoOpen && (
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 pb-3">
            <Field label="名字">
              <Input value={draft.name} onChange={(e) => onChange({ name: e.target.value })} placeholder="插件展示名" className="h-8 text-sm" />
            </Field>
            <Field label="描述">
              <Textarea value={draft.description} onChange={(e) => onChange({ description: e.target.value })} placeholder="一句话说明插件用途" rows={2} className="resize-none text-sm" />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="插件 ID" hint={idValid ? undefined : '仅小写字母/数字/连字符'}>
                <Input value={draft.id} onChange={(e) => onChange({ id: e.target.value })} className={`h-8 text-sm ${idValid ? '' : 'border-destructive'}`} />
              </Field>
              <Field label="版本号">
                <Input value={draft.version} onChange={(e) => onChange({ version: e.target.value })} className="h-8 text-sm" />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Field label="运行类型">
                <select
                  value={draft.runtime_type}
                  onChange={(e) => onChange({ runtime_type: e.target.value as StagedPlugin['runtime_type'] })}
                  className="h-8 w-full rounded-md border bg-background px-2 text-sm"
                >
                  <option value="client">前端 client</option>
                  <option value="nodejs">Node.js</option>
                  <option value="python">Python</option>
                </select>
              </Field>
              <Field label="入口文件" hint={entryMissing ? '该文件不存在' : undefined}>
                <Input value={draft.entry} onChange={(e) => onChange({ entry: e.target.value })} className={`h-8 text-sm ${entryMissing ? 'border-destructive' : ''}`} />
              </Field>
            </div>
            <Field label="可见性">
              <select
                value={draft.visibility}
                onChange={(e) => onChange({ visibility: e.target.value as StagedPlugin['visibility'] })}
                className="h-8 w-full rounded-md border bg-background px-2 text-sm"
              >
                <option value="tenant">团队可见</option>
                <option value="private">仅自己</option>
              </select>
            </Field>
            <Field label="能力声明">
              <div className="flex flex-wrap gap-1.5">
                {capKinds.map((kind) => {
                  const on = activeCaps.has(kind);
                  return (
                    <button
                      key={kind}
                      type="button"
                      onClick={() => toggleCapability(kind)}
                      className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${on ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted'}`}
                    >
                      {kind}
                    </button>
                  );
                })}
              </div>
            </Field>
            <div className="rounded-md border bg-background/60 px-2 py-1.5 text-[11px] text-muted-foreground">
              <div className="flex items-center gap-1.5">
                <Checkbox checked disabled className="size-3.5" />
                包含 {draft.files.length} 个文件
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 保存草稿栏 */}
      <div className="shrink-0 border-t p-3">
        <Button className="w-full gap-1.5" onClick={handleSaveDraft} disabled={submitting || busy}>
          {submitting ? <Loader2Icon className="size-4 animate-spin" /> : <SendIcon className="size-4" />}
          {submitting ? '保存中…' : busy ? 'AI 生成中，请稍候…' : '保存草稿到本地'}
        </Button>
        <p className="mt-1.5 text-center text-[11px] text-muted-foreground">
          保存后可在插件中心「我的草稿」查看、运行和发布。
        </p>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <label className="text-[11px] font-medium text-muted-foreground">{label}</label>
        {hint && <span className="text-[11px] text-destructive">{hint}</span>}
      </div>
      {children}
    </div>
  );
}
