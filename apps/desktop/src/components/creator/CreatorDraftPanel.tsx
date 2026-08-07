// CreatorDraftPanel —— 创建器右侧分栏：信息编辑 + 提交/保存。
//
// AI 通过 CreatePlugin 写入 plugins_root 草稿后，这里允许用户改信息（名字/描述、ID/版本、
// 运行类型/入口、能力/可见性），用户也可继续对话让 AI 迭代。可直接提交到团队空间，
// 也可在桌面环境点「保存草稿到本地」写入本地文件系统。
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  Loader2Icon,
  SendIcon,
  ChevronDownIcon,
  AlertTriangleIcon,
  XCircleIcon,
  UploadIcon,
  FileCode2Icon,
} from 'lucide-react';
import { type CapabilityKind as CapabilityKindType } from '@lingfang/contract';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  buildStagedManifest,
  validateStagedCompleteness,
  withSyncedStagedManifest,
  type StagedPlugin,
} from '@/lib/plugin-creator/creator-tools';
import { PublishPluginDialog } from '@/components/plugins/PublishPluginDialog';
import { validatePluginStructure } from '@/lib/plugin-draft/manifest';
import { cn } from '@/lib/utils';
import { persistDraftWorkspace } from '@/lib/plugin-registry';

// 能力白名单：必须与后端 plugin-package.ts ALLOWED_CAPABILITIES 完全一致，否则勾选后端不认的能力会 400。
const ALLOWED_CAPABILITY_KINDS: CapabilityKindType[] = [
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
];

const CONTROL_BASE_CLASS =
  'w-full rounded-md border-input bg-background px-3 py-2 text-sm text-foreground shadow-none transition-colors placeholder:text-muted-foreground hover:bg-muted/30 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 dark:bg-input/20';
const INPUT_CLASS = cn(CONTROL_BASE_CLASS, 'h-9');
const TEXTAREA_CLASS = cn(CONTROL_BASE_CLASS, 'min-h-[72px] resize-none leading-5');
const SELECT_CLASS = cn(CONTROL_BASE_CLASS, 'h-9 appearance-none pr-9');
// 字段标签/错误文案沿用原面板的紧凑排版（xs 号字），避免迁移到 Field 后字号变大。
const FIELD_LABEL_CLASS = 'text-xs font-medium text-muted-foreground';
const FIELD_ERROR_CLASS = 'text-[11px]';

type InspectorTab = 'overview' | 'files';

export function CreatorDraftPanel({
  draft,
  onChange,
  onSubmitted,
  busy,
  conversationId,
  turns: _turns,
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
  /**
   * 对话轮次（保存草稿时记录，供编辑时恢复）。
   * 注意：目前只是接住了父组件传下来的值 —— persistDraftWorkspace 的入参里
   * 根本没有 turns 字段，所以这份轮次从没被写盘过，注释里承诺的“编辑时恢复”
   * 还没接上。留着 prop 以免改动调用方，接线时从这里往下走。
   */
  turns?: unknown[];
  /** 当前编辑的 DraftWorkspace UUID；保存和发布必须复用它。 */
  workspaceId?: string | null;
  onWorkspacePersisted: (workspaceId: string) => void;
}) {
  const [savingDraft, setSavingDraft] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<InspectorTab>('overview');

  const preparedDraft = useMemo(() => withSyncedStagedManifest(draft), [draft]);
  const entryMissing = !preparedDraft.files.some((f) => f.path === preparedDraft.entry);
  const idValid = /^[a-z0-9-]+$/.test(preparedDraft.id);
  // 结构诊断：检测 manifest/入口/命名规范等结构问题，显式提示用户（fail 红 / warn 黄）。
  const diagnostics = useMemo(
    () => validatePluginStructure(preparedDraft.files),
    [preparedDraft.files]
  );
  const hasFail = diagnostics.some((d) => d.status === 'fail');

  const capKinds = ALLOWED_CAPABILITY_KINDS;
  const activeCaps = new Set(draft.capabilities.map((c) => c.kind));

  function toggleCapability(kind: CapabilityKindType) {
    const next = activeCaps.has(kind)
      ? draft.capabilities.filter((c) => c.kind !== kind)
      : [...draft.capabilities, { kind, reason: '', risk: 'low' as const, requires_admin: false }];
    onChange({ capabilities: next });
  }

  // ToggleGroup 回传全量选中列表，这里换算回「变动的那一项」再走原来的逐项切换：
  // 白名单外的已声明能力（CapabilityKind 比白名单多几项）不在组里渲染，按列表重建会把它们丢掉。
  function handleCapabilityChange(nextKinds: string[]) {
    const selected = new Set(nextKinds);
    const changed = capKinds.find((kind) => selected.has(kind) !== activeCaps.has(kind));
    if (changed) toggleCapability(changed);
  }

  function validateDraftReady() {
    if (!draft.name.trim()) {
      toast.error('请填写插件名字');
      return;
    }
    if (!idValid) {
      toast.error('插件 ID 仅允许小写字母/数字/连字符');
      return;
    }
    if (entryMissing) {
      toast.error(`入口文件 ${preparedDraft.entry} 不在文件列表中`);
      return;
    }
    // 完整性关卡：按 runtime 校验必需文件与入口命名，阻止把不完整草稿落盘（与 stage/submit 同一份校验）。
    const completenessErr = validateStagedCompleteness(
      preparedDraft.runtime_type,
      preparedDraft.entry,
      preparedDraft.files
    );
    if (completenessErr) {
      toast.error(completenessErr);
      return;
    }
    return true;
  }

  function handleOpenPublish() {
    if (!validateDraftReady()) return;
    setPublishOpen(true);
  }

  async function handleSaveDraft() {
    if (!validateDraftReady()) return;
    setSavingDraft(true);
    try {
      const workspace = await persistPreparedWorkspace(
        preparedDraft,
        workspaceId ?? undefined,
        conversationId
      );
      onWorkspacePersisted(workspace.workspaceId);
      toast.success(`草稿「${draft.name}」已保存到工作区`);
      onSubmitted(draft.name);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingDraft(false);
    }
  }

  const actionDisabled = savingDraft || busy || hasFail;

  return (
    <aside className="flex h-full w-[clamp(360px,30vw,420px)] shrink-0 flex-col border-l bg-card text-card-foreground">
      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as InspectorTab)}
        className="min-h-0 flex-1 gap-0"
      >
        <header className="shrink-0 border-b bg-card">
          <div className="flex items-center gap-3 px-4 py-4">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted text-foreground">
              <FileCode2Icon className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h2 className="truncate text-sm font-semibold text-foreground">插件草稿</h2>
                <Badge variant="secondary">产物</Badge>
              </div>
              <p className="mt-0.5 truncate text-xs text-muted-foreground" title={draft.name}>
                {draft.name || '未命名插件'} · {preparedDraft.files.length} 个文件
              </p>
            </div>
          </div>
          <TabsList variant="line" className="h-9 w-full justify-start gap-4 px-4">
            <TabsTrigger value="overview" className="flex-none px-1">
              概览
            </TabsTrigger>
            <TabsTrigger value="files" className="flex-none px-1">
              文件
            </TabsTrigger>
          </TabsList>
        </header>

        <TabsContent value="overview" className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
          <div className="flex flex-col gap-5">
            <PanelSection title="基础信息">
              <FieldGroup className="gap-3">
                <Field className="gap-1.5">
                  <FieldLabel htmlFor="creator-draft-name" className={FIELD_LABEL_CLASS}>
                    名字
                  </FieldLabel>
                  <Input
                    id="creator-draft-name"
                    aria-label="插件名字"
                    value={draft.name}
                    onChange={(e) => onChange({ name: e.target.value })}
                    placeholder="插件展示名"
                    className={INPUT_CLASS}
                  />
                </Field>
                <Field className="gap-1.5">
                  <FieldLabel htmlFor="creator-draft-description" className={FIELD_LABEL_CLASS}>
                    描述
                  </FieldLabel>
                  <Textarea
                    id="creator-draft-description"
                    aria-label="插件描述"
                    value={draft.description}
                    onChange={(e) => onChange({ description: e.target.value })}
                    placeholder="一句话说明插件用途"
                    rows={2}
                    className={TEXTAREA_CLASS}
                  />
                </Field>
              </FieldGroup>
            </PanelSection>

            <PanelSection title="元数据">
              <div className="grid grid-cols-2 gap-3">
                <Field className="gap-1.5">
                  <FieldLabel htmlFor="creator-draft-id" className={FIELD_LABEL_CLASS}>
                    插件 ID
                  </FieldLabel>
                  <Input
                    id="creator-draft-id"
                    aria-label="插件 ID"
                    value={draft.id}
                    onChange={(e) => onChange({ id: e.target.value })}
                    aria-invalid={!idValid || undefined}
                    className={cn(INPUT_CLASS, !idValid && 'border-destructive')}
                  />
                  {!idValid && (
                    <FieldError className={FIELD_ERROR_CLASS}>仅小写字母/数字/连字符</FieldError>
                  )}
                </Field>
                <Field className="gap-1.5">
                  <FieldLabel htmlFor="creator-draft-version" className={FIELD_LABEL_CLASS}>
                    版本号
                  </FieldLabel>
                  <Input
                    id="creator-draft-version"
                    aria-label="版本号"
                    value={draft.version}
                    onChange={(e) => onChange({ version: e.target.value })}
                    className={INPUT_CLASS}
                  />
                </Field>
              </div>
            </PanelSection>

            <PanelSection title="运行配置">
              <div className="grid grid-cols-2 gap-3">
                <Field className="gap-1.5">
                  <FieldLabel htmlFor="creator-draft-runtime" className={FIELD_LABEL_CLASS}>
                    运行类型
                  </FieldLabel>
                  <SelectWrapper>
                    <select
                      id="creator-draft-runtime"
                      aria-label="运行类型"
                      value={draft.runtime_type}
                      onChange={(e) =>
                        onChange({ runtime_type: e.target.value as StagedPlugin['runtime_type'] })
                      }
                      className={SELECT_CLASS}
                    >
                      <option value="client">前端 client</option>
                      <option value="nodejs">Node.js</option>
                      <option value="python">Python</option>
                    </select>
                  </SelectWrapper>
                </Field>
                <Field className="gap-1.5">
                  <FieldLabel htmlFor="creator-draft-entry" className={FIELD_LABEL_CLASS}>
                    入口文件
                  </FieldLabel>
                  <Input
                    id="creator-draft-entry"
                    aria-label="入口文件"
                    value={draft.entry}
                    onChange={(e) => onChange({ entry: e.target.value })}
                    aria-invalid={entryMissing || undefined}
                    className={cn(INPUT_CLASS, entryMissing && 'border-destructive')}
                  />
                  {entryMissing && (
                    <FieldError className={FIELD_ERROR_CLASS}>该文件不存在</FieldError>
                  )}
                </Field>
              </div>
              <Field className="gap-1.5">
                <FieldLabel htmlFor="creator-draft-visibility" className={FIELD_LABEL_CLASS}>
                  可见性
                </FieldLabel>
                <SelectWrapper>
                  <select
                    id="creator-draft-visibility"
                    aria-label="可见性"
                    value={draft.visibility}
                    onChange={(e) =>
                      onChange({ visibility: e.target.value as StagedPlugin['visibility'] })
                    }
                    className={SELECT_CLASS}
                  >
                    <option value="tenant">团队可见</option>
                    <option value="private">仅自己</option>
                  </select>
                </SelectWrapper>
              </Field>
            </PanelSection>

            {/* 能力声明是一组多选项，用 fieldset/legend 承载组语义（legend 在 flex fieldset 中不参与
                gap 计算，用 mb-3 复现原来的 gap-3 间距）。 */}
            <FieldSet className="gap-3 border-b pb-5">
              <FieldLegend variant="label" className="mb-3 text-xs font-semibold text-foreground">
                能力声明
              </FieldLegend>
              <ToggleGroup
                multiple
                variant="outline"
                size="sm"
                value={capKinds.filter((kind) => activeCaps.has(kind))}
                onValueChange={handleCapabilityChange}
                className="w-full flex-wrap"
              >
                {capKinds.map((kind) => (
                  <ToggleGroupItem
                    key={kind}
                    value={kind}
                    className="h-auto rounded-md border-border bg-muted/40 px-2.5 py-1.5 font-mono text-[11px] leading-none text-muted-foreground hover:bg-muted hover:text-foreground aria-pressed:border-primary/40 aria-pressed:bg-primary/10 aria-pressed:text-primary aria-pressed:hover:bg-primary/15"
                  >
                    {kind}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </FieldSet>

            {diagnostics.length > 0 && (
              <PanelSection title="检查结果" withDivider={false}>
                <div className="flex flex-col gap-2">
                  {diagnostics.map((d, i) => (
                    <Alert
                      key={i}
                      variant={d.status === 'fail' ? 'destructive' : 'default'}
                      className={cn(
                        'text-xs leading-relaxed',
                        d.status === 'fail'
                          ? 'border-destructive/30 bg-destructive/10 text-destructive'
                          : 'border-warning/30 bg-warning/10 text-warning'
                      )}
                    >
                      {d.status === 'fail' ? (
                        <XCircleIcon className="size-3.5 shrink-0" />
                      ) : (
                        <AlertTriangleIcon className="size-3.5 shrink-0" />
                      )}
                      <AlertDescription className="text-xs text-current">
                        {d.message}
                      </AlertDescription>
                    </Alert>
                  ))}
                </div>
              </PanelSection>
            )}
          </div>
        </TabsContent>

        <TabsContent value="files" className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-foreground">文件产物</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                当前草稿包含 {preparedDraft.files.length} 个文件
              </p>
            </div>
            <Badge variant="secondary" className="font-mono">
              {preparedDraft.runtime_type}
            </Badge>
          </div>
          <div className="divide-y overflow-hidden rounded-lg border bg-background">
            {preparedDraft.files.map((file) => (
              <div
                key={file.path}
                title={file.path}
                className="flex items-center gap-2.5 px-3 py-2.5 transition-colors hover:bg-muted/50"
              >
                <FileCode2Icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                  {file.path}
                </span>
                {file.path === preparedDraft.entry && <Badge variant="secondary">入口</Badge>}
              </div>
            ))}
          </div>
        </TabsContent>
      </Tabs>

      {/* 提交/保存草稿栏：保持发布与落盘行为不变。 */}
      <div className="flex shrink-0 flex-col gap-3 border-t bg-card p-4">
        <div className="flex flex-col gap-2.5">
          <Button
            className="h-10 w-full rounded-lg px-6 text-sm font-medium shadow-none"
            onClick={handleOpenPublish}
            disabled={actionDisabled}
          >
            {hasFail ? (
              <XCircleIcon data-icon="inline-start" />
            ) : (
              <UploadIcon data-icon="inline-start" />
            )}
            {busy ? 'AI 生成中，请稍候…' : hasFail ? '请先修复检查结果中的问题' : '发布插件'}
          </Button>
          <Button
            variant="outline"
            className="h-10 w-full rounded-lg px-6 text-sm font-medium shadow-none"
            onClick={() => {
              void handleSaveDraft();
            }}
            disabled={actionDisabled}
          >
            {savingDraft ? (
              <Loader2Icon data-icon="inline-start" className="animate-spin" />
            ) : (
              <SendIcon data-icon="inline-start" />
            )}
            {savingDraft ? '保存中…' : '保存草稿到本地'}
          </Button>
        </div>
        <p className="text-center text-[11px] leading-5 text-muted-foreground">
          提交后可在插件中心「团队插件」运行；保存本地需要桌面环境。
        </p>
      </div>
      <PublishPluginDialog
        open={publishOpen}
        onOpenChange={setPublishOpen}
        draft={preparedDraft}
        defaultSourceKind={preparedDraft.sourceKind || 'LINGFANG_CREATOR'}
        defaultSourceLabel={preparedDraft.sourceLabel || '灵枋创建器'}
        onPrepareWorkspace={async () => {
          const workspace = await persistPreparedWorkspace(
            preparedDraft,
            workspaceId ?? undefined,
            conversationId
          );
          onWorkspacePersisted(workspace.workspaceId);
          return workspace;
        }}
        onPublished={(result) => {
          toast.success(
            `插件「${preparedDraft.name}」已发布 v${result.release?.version || preparedDraft.version}`
          );
          onSubmitted(preparedDraft.name);
        }}
      />
    </aside>
  );
}

async function persistPreparedWorkspace(
  draft: StagedPlugin,
  preferredWorkspaceId?: string,
  conversationId?: string | null
) {
  const manifest = buildStagedManifest(draft);
  return persistDraftWorkspace({
    preferredWorkspaceId,
    title: draft.name,
    manifestId: draft.id,
    version: draft.version,
    runtime: draft.runtime_type,
    conversationId,
    sourceKind: draft.sourceKind || 'LINGFANG_CREATOR',
    sourceLabel: draft.sourceLabel || '灵枋创建器',
    files: [
      { path: 'manifest.json', content: `${JSON.stringify(manifest, null, 2)}\n` },
      ...draft.files.filter((file) => file.path !== 'manifest.json'),
    ],
  });
}

function PanelSection({
  title,
  children,
  withDivider = true,
}: {
  title: string;
  children: React.ReactNode;
  withDivider?: boolean;
}) {
  return (
    <section className={cn('flex flex-col gap-3', withDivider && 'border-b pb-5')}>
      <h3 className="text-xs font-semibold text-foreground">{title}</h3>
      {children}
    </section>
  );
}

function SelectWrapper({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative">
      {children}
      <ChevronDownIcon className="pointer-events-none absolute right-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}
