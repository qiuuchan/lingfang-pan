// CreatorDraftPanel —— 创建器右侧分栏：信息编辑 + 提交/保存。
//
// AI 通过 CreatePlugin 写入 plugins_root 草稿后，这里允许用户改信息（名字/描述、ID/版本、
// 运行类型/入口、能力/可见性），用户也可继续对话让 AI 迭代。可直接提交到团队空间，
// 也可在桌面环境点「保存草稿到本地」写入本地文件系统。
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Loader2Icon, SendIcon, ChevronDownIcon, AlertTriangleIcon, XCircleIcon, UploadIcon, FileCode2Icon } from 'lucide-react';
import { type CapabilityKind as CapabilityKindType } from '@lingfang/contract';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { buildStagedManifest, validateStagedCompleteness, withSyncedStagedManifest, type StagedPlugin } from '@/lib/plugin-creator/creator-tools';
import type { UploadProgress } from '@/lib/plugin-upload';
import { UploadProgressDialog, type UploadStage } from '@/components/plugins/UploadProgressDialog';
import { validatePluginStructure } from '@/lib/plugin-draft/manifest';
import { cn } from '@/lib/utils';
import { persistDraftWorkspace, publishDraftWorkspace } from '@/lib/plugin-registry';

// 能力白名单：必须与后端 plugin-package.ts ALLOWED_CAPABILITIES 完全一致，否则勾选后端不认的能力会 400。
const ALLOWED_CAPABILITY_KINDS: CapabilityKindType[] = [
  'ui.view', 'fs.pick', 'fs.read', 'fs.write', 'net.fetch',
  'clipboard', 'llm.chat', 'image.generate', 'storage.kv',
  'system.info', 'system.screenshot', 'system.notify',
  'plugin.upload', 'plugin.submitMarketplace',
];

const CONTROL_BASE_CLASS = 'w-full rounded-lg border border-[#3a3a3c] bg-[#252528] px-3 py-2 text-sm text-[#e5e5e5] shadow-none transition-colors placeholder:text-[#6f7076] hover:bg-[#2a2a2c] focus-visible:border-[#4a4a4d] focus-visible:ring-0 dark:bg-[#252528]';
const INPUT_CLASS = cn(CONTROL_BASE_CLASS, 'h-9');
const TEXTAREA_CLASS = cn(CONTROL_BASE_CLASS, 'min-h-[72px] resize-none leading-5');
const SELECT_CLASS = cn(CONTROL_BASE_CLASS, 'h-9 appearance-none pr-9');

export function CreatorDraftPanel({
  draft,
  onChange,
  onSubmitted,
  busy,
  conversationId,
  turns,
  workspaceId,
  onWorkspacePersisted,
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
  /** 当前编辑的 DraftWorkspace UUID；保存和发布必须复用它。 */
  workspaceId?: string | null;
  onWorkspacePersisted: (workspaceId: string) => void;
}) {
  const [savingDraft, setSavingDraft] = useState(false);
  const [publishingTeam, setPublishingTeam] = useState(false);
  const [infoOpen, setInfoOpen] = useState(true);
  const [filesOpen, setFilesOpen] = useState(true);
  // 上传进度弹窗状态。
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadStage, setUploadStage] = useState<UploadStage>('uploading');
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [uploadError, setUploadError] = useState<string | undefined>(undefined);

  const preparedDraft = useMemo(() => withSyncedStagedManifest(draft), [draft]);
  const entryMissing = !preparedDraft.files.some((f) => f.path === preparedDraft.entry);
  const idValid = /^[a-z0-9-]+$/.test(preparedDraft.id);
  // 结构诊断：检测 manifest/入口/命名规范等结构问题，显式提示用户（fail 红 / warn 黄）。
  const diagnostics = useMemo(() => validatePluginStructure(preparedDraft.files), [preparedDraft.files]);
  const hasFail = diagnostics.some((d) => d.status === 'fail');

  const capKinds = ALLOWED_CAPABILITY_KINDS;
  const activeCaps = new Set(draft.capabilities.map((c) => c.kind));

  function toggleCapability(kind: CapabilityKindType) {
    const next = activeCaps.has(kind)
      ? draft.capabilities.filter((c) => c.kind !== kind)
      : [...draft.capabilities, { kind, reason: '', risk: 'low' as const, requires_admin: false }];
    onChange({ capabilities: next });
  }

  function validateDraftReady() {
    if (!draft.name.trim()) { toast.error('请填写插件名字'); return; }
    if (!idValid) { toast.error('插件 ID 仅允许小写字母/数字/连字符'); return; }
    if (entryMissing) { toast.error(`入口文件 ${preparedDraft.entry} 不在文件列表中`); return; }
    // 完整性关卡：按 runtime 校验必需文件与入口命名，阻止把不完整草稿落盘（与 stage/submit 同一份校验）。
    const completenessErr = validateStagedCompleteness(preparedDraft.runtime_type, preparedDraft.entry, preparedDraft.files);
    if (completenessErr) { toast.error(completenessErr); return; }
    return true;
  }

  async function handleSubmitToTeam() {
    if (!validateDraftReady()) return;
    setPublishingTeam(true);
    setUploadOpen(true);
    setUploadStage('uploading');
    setUploadProgress(null);
    setUploadError(undefined);
    try {
      const workspace = await persistPreparedWorkspace(preparedDraft, workspaceId ?? undefined, conversationId);
      onWorkspacePersisted(workspace.workspaceId);
      const result = await publishDraftWorkspace(workspace, (info) => setUploadProgress({
        uploaded: info.transferred,
        total: info.total || 0,
        speed: 0,
      }));
      setUploadStage('done');
      toast.success(`插件「${preparedDraft.name}」已发布团队版本 v${result.release.version}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setUploadStage('error');
      setUploadError(msg);
      toast.error(msg);
    } finally {
      setPublishingTeam(false);
    }
  }

  async function handleSaveDraft() {
    if (!validateDraftReady()) return;
    setSavingDraft(true);
    try {
      const workspace = await persistPreparedWorkspace(preparedDraft, workspaceId ?? undefined, conversationId);
      onWorkspacePersisted(workspace.workspaceId);
      toast.success(`草稿「${draft.name}」已保存到工作区`);
      onSubmitted(draft.name);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingDraft(false);
    }
  }

  const actionDisabled = publishingTeam || savingDraft || busy || hasFail;

  return (
    <aside className="flex h-full w-[444px] shrink-0 border-l border-[#2a2a2c] bg-[#0d0d0d] p-3 pl-4">
      <div className="flex min-h-0 w-full flex-col overflow-hidden rounded-xl border border-[#2a2a2c] bg-[#161618] shadow-[0_18px_48px_rgba(0,0,0,0.28)]">
        <button
          type="button"
          onClick={() => setInfoOpen((v) => !v)}
          className="flex shrink-0 items-center justify-between border-b border-[#2a2a2c] px-5 py-4 text-left text-sm font-medium text-[#e5e5e5] transition-colors hover:bg-[#1c1c1e]"
        >
          <span>插件信息（提交前可修改）</span>
          <ChevronDownIcon className={cn('size-4 text-[#8a8a8f] transition-transform', !infoOpen && '-rotate-90')} />
        </button>
        {infoOpen && (
          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            <div className="flex flex-col gap-6">
              <PanelSection title="基础信息">
                <Field label="名字">
                  <Input
                    value={draft.name}
                    onChange={(e) => onChange({ name: e.target.value })}
                    placeholder="插件展示名"
                    className={INPUT_CLASS}
                  />
                </Field>
                <Field label="描述">
                  <Textarea
                    value={draft.description}
                    onChange={(e) => onChange({ description: e.target.value })}
                    placeholder="一句话说明插件用途"
                    rows={2}
                    className={TEXTAREA_CLASS}
                  />
                </Field>
              </PanelSection>

              <PanelSection title="元数据">
                <div className="grid grid-cols-2 gap-3">
                  <Field label="插件 ID" hint={idValid ? undefined : '仅小写字母/数字/连字符'}>
                    <Input
                      value={draft.id}
                      onChange={(e) => onChange({ id: e.target.value })}
                      aria-invalid={!idValid || undefined}
                      className={cn(INPUT_CLASS, !idValid && 'border-destructive')}
                    />
                  </Field>
                  <Field label="版本号">
                    <Input value={draft.version} onChange={(e) => onChange({ version: e.target.value })} className={INPUT_CLASS} />
                  </Field>
                </div>
              </PanelSection>

              <PanelSection title="运行配置">
                <div className="grid grid-cols-2 gap-3">
                  <Field label="运行类型">
                    <SelectWrapper>
                      <select
                        value={draft.runtime_type}
                        onChange={(e) => onChange({ runtime_type: e.target.value as StagedPlugin['runtime_type'] })}
                        className={SELECT_CLASS}
                      >
                        <option value="client">前端 client</option>
                        <option value="nodejs">Node.js</option>
                        <option value="python">Python</option>
                      </select>
                    </SelectWrapper>
                  </Field>
                  <Field label="入口文件" hint={entryMissing ? '该文件不存在' : undefined}>
                    <Input
                      value={draft.entry}
                      onChange={(e) => onChange({ entry: e.target.value })}
                      aria-invalid={entryMissing || undefined}
                      className={cn(INPUT_CLASS, entryMissing && 'border-destructive')}
                    />
                  </Field>
                </div>
                <Field label="可见性">
                  <SelectWrapper>
                    <select
                      value={draft.visibility}
                      onChange={(e) => onChange({ visibility: e.target.value as StagedPlugin['visibility'] })}
                      className={SELECT_CLASS}
                    >
                      <option value="tenant">团队可见</option>
                      <option value="private">仅自己</option>
                    </select>
                  </SelectWrapper>
                </Field>
              </PanelSection>

              <PanelSection title="能力声明">
                <div className="flex flex-wrap gap-2">
                  {capKinds.map((kind) => {
                    const on = activeCaps.has(kind);
                    return (
                      <button
                        key={kind}
                        type="button"
                        onClick={() => toggleCapability(kind)}
                        className={capabilityPillClass(kind, on)}
                      >
                        {kind}
                      </button>
                    );
                  })}
                </div>
              </PanelSection>

              <PanelSection title="文件列表" withDivider={false}>
                <div className="overflow-hidden rounded-lg border border-[#2a2a2c] bg-[#1c1c1e]">
                  <button
                    type="button"
                    onClick={() => setFilesOpen((v) => !v)}
                    className="flex w-full items-center justify-between px-3 py-2 text-left text-[12px] font-medium text-[#a0a0a3] transition-colors hover:bg-[#252528]"
                  >
                    <span>包含 {preparedDraft.files.length} 个文件</span>
                    <ChevronDownIcon className={cn('size-3.5 text-[#8a8a8f] transition-transform', !filesOpen && '-rotate-90')} />
                  </button>
                  {filesOpen && (
                    <div className="max-h-40 overflow-y-auto border-t border-[#2a2a2c] p-1">
                      {preparedDraft.files.map((file) => (
                        <div
                          key={file.path}
                          title={file.path}
                          className="flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-[#252528]"
                        >
                          <FileCode2Icon className="size-3.5 shrink-0 text-[#8a8a8f]" />
                          <span className="truncate font-mono text-[11px] text-[#a0a0a3]">{file.path}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </PanelSection>
            </div>
          </div>
        )}
        {!infoOpen && <div className="min-h-0 flex-1" />}

        {/* 检查结果：结构诊断（缺 manifest/入口/命名不规范等），让用户即时看到缺漏。 */}
        {diagnostics.length > 0 && (
          <div className="flex shrink-0 flex-col gap-2 border-t border-[#2a2a2c] bg-[#1c1c1e] p-5">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-[#c4c4c8]">
              <AlertTriangleIcon className="size-3.5" />
              检查结果
            </div>
            {diagnostics.map((d, i) => (
              <div
                key={i}
                className={cn(
                  'flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-[11px] leading-relaxed',
                  d.status === 'fail'
                    ? 'border-destructive/30 bg-destructive/10 text-destructive'
                    : 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
                )}
              >
                {d.status === 'fail'
                  ? <XCircleIcon className="mt-0.5 size-3.5 shrink-0" />
                  : <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />}
                <span>{d.message}</span>
              </div>
            ))}
          </div>
        )}

        {/* 提交/保存草稿栏 */}
        <div className="flex shrink-0 flex-col gap-3 border-t border-[#2a2a2c] bg-[#161618] p-5">
          <div className="flex flex-col gap-3">
            <Button
              className="h-10 w-full rounded-lg bg-[#3b82f6] px-6 text-sm font-medium text-white shadow-none hover:bg-[#2563eb] disabled:bg-[#252528] disabled:text-[#7f8086]"
              onClick={() => { void handleSubmitToTeam(); }}
              disabled={actionDisabled}
            >
              {publishingTeam ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : hasFail ? <XCircleIcon data-icon="inline-start" /> : <UploadIcon data-icon="inline-start" />}
              {publishingTeam ? '提交中…' : busy ? 'AI 生成中，请稍候…' : hasFail ? '请先修复检查结果中的问题' : '提交到团队空间'}
            </Button>
            <Button
              variant="outline"
              className="h-10 w-full rounded-lg border-[#2a2a2c] bg-[#2a2a2c] px-6 text-sm font-medium text-[#e5e5e5] shadow-none hover:bg-[#3a3a3c] hover:text-white disabled:bg-[#1c1c1e] disabled:text-[#7f8086]"
              onClick={() => { void handleSaveDraft(); }}
              disabled={actionDisabled}
            >
              {savingDraft ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <SendIcon data-icon="inline-start" />}
              {savingDraft ? '保存中…' : '保存草稿到本地'}
            </Button>
          </div>
          <p className="text-center text-[11px] leading-5 text-[#7f8086]">
            提交后可在插件中心「团队插件」运行；保存本地需要桌面环境。
          </p>
        </div>
      </div>
      <UploadProgressDialog
        open={uploadOpen}
        stage={uploadStage}
        progress={uploadProgress}
        pluginName={draft.name}
        errorMessage={uploadError}
        onClose={() => setUploadOpen(false)}
      />
    </aside>
  );
}

async function persistPreparedWorkspace(
  draft: StagedPlugin,
  preferredWorkspaceId?: string,
  conversationId?: string | null,
) {
  const manifest = buildStagedManifest(draft);
  return persistDraftWorkspace({
    preferredWorkspaceId,
    title: draft.name,
    manifestId: draft.id,
    version: draft.version,
    runtime: draft.runtime_type,
    conversationId,
    files: [
      { path: 'manifest.json', content: `${JSON.stringify(manifest, null, 2)}\n` },
      ...draft.files.filter((file) => file.path !== 'manifest.json'),
    ],
  });
}

function PanelSection({ title, children, withDivider = true }: { title: string; children: React.ReactNode; withDivider?: boolean }) {
  return (
    <section className={cn('flex flex-col gap-3', withDivider && 'border-b border-[#2a2a2c] pb-6')}>
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#e5e5e5]">{title}</h3>
      {children}
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <label className="text-[11px] font-medium uppercase tracking-[0.08em] text-[#8a8a8f]">{label}</label>
        {hint && <span className="text-[11px] text-destructive">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function SelectWrapper({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative">
      {children}
      <ChevronDownIcon className="pointer-events-none absolute right-3 top-1/2 size-3.5 -translate-y-1/2 text-[#8a8a8f]" />
    </div>
  );
}

function capabilityPillClass(kind: CapabilityKindType, active: boolean) {
  const base = 'rounded-full border px-2.5 py-1 font-mono text-[12px] leading-none transition-colors';
  if (!active) {
    return cn(base, 'border-[#2a2a2c] bg-[#252528] text-[#a0a0a3] hover:border-[#3a3a3c] hover:bg-[#2a2a2c] hover:text-[#e5e5e5]');
  }
  if (kind.startsWith('net.')) return cn(base, 'border-blue-400/30 bg-blue-500/10 text-blue-300');
  if (kind.startsWith('fs.')) return cn(base, 'border-emerald-400/30 bg-emerald-500/10 text-emerald-300');
  if (kind.startsWith('llm.') || kind.startsWith('image.')) return cn(base, 'border-violet-400/30 bg-violet-500/10 text-violet-300');
  if (kind.startsWith('system.')) return cn(base, 'border-amber-400/30 bg-amber-500/10 text-amber-300');
  if (kind.startsWith('plugin.')) return cn(base, 'border-sky-400/30 bg-sky-500/10 text-sky-300');
  return cn(base, 'border-[#4a4a4d] bg-[#2a2a2c] text-[#f0f0f2]');
}
