import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2Icon,
  FileArchiveIcon,
  FolderOpenIcon,
  Loader2Icon,
  RefreshCwIcon,
  SendIcon,
  ShieldCheckIcon,
  StoreIcon,
  UploadIcon,
  XCircleIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { useApp } from '@/App';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { errorMessage } from '@/lib/api';
import { hasPermission } from '@/lib/permissions';
import {
  DEFAULT_SOURCE_LABELS,
  inspectLocalArtifact,
  createPluginPublishState,
  publishDraftWorkspace,
  publishPluginRelease,
  publishLocalArtifact,
  retryMarketplaceSubmission,
  runPluginAdapt,
  selectPluginArtifact,
  selectPluginDirectory,
  stageAdaptationReport,
  type PluginAdaptationReport,
  type PluginPublishState,
  type RegistryPackage,
  type RegistryRelease,
  type TransferProgress,
  type Workspace,
} from '@/lib/plugin-registry';
import type { AdaptationStatus, PluginReleaseSourceKind } from '@lingfang/contract';
import type { StagedPlugin } from '@/lib/plugin-creator/creator-tools';

export type PublishTarget = 'team' | 'market';
export type PublishInputMode = 'workspace' | 'artifact';

type PublishResult = {
  package?: RegistryPackage;
  release?: RegistryRelease;
};

type ArtifactSummary = {
  name?: string;
  id?: string;
  version?: string;
  runtime?: string;
  entry?: string;
  sizeBytes?: number;
  fileCount?: number;
  manifest?: Record<string, unknown>;
};

const SOURCE_OPTIONS: PluginReleaseSourceKind[] = [
  'EXTERNAL_TOOL',
  'LOCAL_ARTIFACT',
  'LINGFANG_CREATOR',
  'COPIED_INSTALLATION',
];

type Stage = 'idle' | 'inspecting' | 'uploading' | 'team_published' | 'submitting_market' | 'done' | 'market_failed' | 'error';

export interface PublishPluginDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 直接发布一个已存在的草稿 workspace。 */
  workspace?: Workspace | null;
  /** Creator 传入 staged draft；未落盘时由 onPrepareWorkspace 创建 workspace。 */
  draft?: StagedPlugin | null;
  onPrepareWorkspace?: () => Promise<Workspace>;
  /** 从插件中心/草稿页打开时可直接指定本地制品。 */
  artifactPath?: string | null;
  defaultSourceKind?: PluginReleaseSourceKind;
  defaultSourceLabel?: string;
  defaultTarget?: PublishTarget;
  onPublished?: (result: PublishResult) => void;
}

function summaryFromDraft(draft?: StagedPlugin | null): ArtifactSummary | null {
  if (!draft) return null;
  return {
    name: draft.name,
    id: draft.id,
    version: draft.version,
    runtime: draft.runtime_type,
    entry: draft.entry,
    fileCount: draft.files.length,
    manifest: { name: draft.name, id: draft.id, version: draft.version, runtime_type: draft.runtime_type, entry: draft.entry },
  };
}

function normalizeInspection(value: unknown): ArtifactSummary {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const manifest = raw.manifest && typeof raw.manifest === 'object' ? raw.manifest as Record<string, unknown> : raw;
  const pick = (key: string, fallback: unknown = undefined) => raw[key] ?? manifest[key] ?? fallback;
  return {
    name: typeof pick('name') === 'string' ? String(pick('name')) : undefined,
    id: typeof pick('id') === 'string' ? String(pick('id')) : typeof pick('manifestId') === 'string' ? String(pick('manifestId')) : undefined,
    version: typeof pick('version') === 'string' ? String(pick('version')) : undefined,
    runtime: typeof pick('runtime_type') === 'string' ? String(pick('runtime_type')) : typeof pick('runtime') === 'string' ? String(pick('runtime')) : undefined,
    entry: typeof pick('entry') === 'string' ? String(pick('entry')) : undefined,
    sizeBytes: typeof raw.sizeBytes === 'number' ? raw.sizeBytes : typeof raw.size_bytes === 'number' ? raw.size_bytes : undefined,
    fileCount: Array.isArray(raw.files)
      ? raw.files.length
      : typeof raw.fileCount === 'number'
        ? raw.fileCount
        : typeof raw.file_count === 'number' ? raw.file_count : undefined,
    manifest,
  };
}

function formatBytes(value?: number) {
  if (!value || value < 1024) return value ? `${value} B` : '—';
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 统一的团队/市场发布入口。市场发布严格拆成「团队 release」和「提审」两步，
 * 因而提审失败时可以保留 releaseId，只重试第二步。
 */
export function PublishPluginDialog({
  open,
  onOpenChange,
  workspace: initialWorkspace,
  draft,
  onPrepareWorkspace,
  artifactPath: initialArtifactPath,
  defaultSourceKind,
  defaultSourceLabel,
  defaultTarget = 'team',
  onPublished,
}: PublishPluginDialogProps) {
  const { session } = useApp();
  const canUpload = hasPermission(session.permissions, 'team.plugin.upload');
  const canSubmitMarket = hasPermission(session.permissions, 'team.plugin.submit_marketplace');
  const [inputMode, setInputMode] = useState<PublishInputMode>(initialArtifactPath ? 'artifact' : 'workspace');
  const [target, setTarget] = useState<PublishTarget>(defaultTarget);
  const [artifactPath, setArtifactPath] = useState(initialArtifactPath || '');
  const [workspace, setWorkspace] = useState<Workspace | null>(initialWorkspace || null);
  const [sourceKind, setSourceKind] = useState<PluginReleaseSourceKind>(defaultSourceKind || (initialArtifactPath ? 'LOCAL_ARTIFACT' : 'LINGFANG_CREATOR'));
  const [sourceLabel, setSourceLabel] = useState(defaultSourceLabel || DEFAULT_SOURCE_LABELS[defaultSourceKind || (initialArtifactPath ? 'LOCAL_ARTIFACT' : 'LINGFANG_CREATOR')]);
  const [price, setPrice] = useState('0');
  const [stage, setStage] = useState<Stage>('idle');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [summary, setSummary] = useState<ArtifactSummary | null>(null);
  // 本地插件目录模式：原始目录路径 + 适配报告 + 暂存 id。
  const [folderPath, setFolderPath] = useState('');
  const [adaptReport, setAdaptReport] = useState<PluginAdaptationReport | null>(null);
  const [adaptReportId, setAdaptReportId] = useState<string | undefined>(undefined);
  const [adaptStage, setAdaptStage] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [adaptError, setAdaptError] = useState('');
  const [publishState, setPublishState] = useState<PluginPublishState>(() => createPluginPublishState(defaultTarget === 'market' ? 'marketplace' : 'team'));
  const wasOpen = useRef(false);
  const notifiedReleaseId = useRef<string | null>(null);

  const artifactReady = inputMode !== 'artifact' || Boolean(summary);
  const canPublish = canUpload && artifactReady && (target !== 'market' || canSubmitMarket);
  const effectiveSummary = inputMode === 'artifact'
    ? summary
    : summaryFromDraft(draft) || (workspace ? {
      id: workspace.manifestId,
      version: workspace.currentVersion,
      runtime: workspace.runtime,
      name: workspace.title,
    } : null);
  const percent = progress?.total ? Math.min(100, Math.round(progress.transferred / progress.total * 100)) : null;

  useEffect(() => {
    if (!open) {
      wasOpen.current = false;
      return;
    }
    if (wasOpen.current) return;
    wasOpen.current = true;
    setInputMode(initialArtifactPath ? 'artifact' : initialWorkspace || draft ? 'workspace' : 'artifact');
    setArtifactPath(initialArtifactPath || '');
    setWorkspace(initialWorkspace || null);
    setTarget(defaultTarget);
    const kind = defaultSourceKind || (initialArtifactPath ? 'LOCAL_ARTIFACT' : 'LINGFANG_CREATOR');
    setSourceKind(kind);
    setSourceLabel(defaultSourceLabel || DEFAULT_SOURCE_LABELS[kind]);
    setSummary(null);
    setStage('idle');
    setBusy(false);
    setError('');
    setProgress(null);
    notifiedReleaseId.current = null;
    setFolderPath('');
    setAdaptReport(null);
    setAdaptReportId(undefined);
    setAdaptStage('idle');
    setAdaptError('');
    setPublishState(createPluginPublishState(defaultTarget === 'market' ? 'marketplace' : 'team'));
  }, [open, initialArtifactPath, initialWorkspace, draft, defaultSourceKind, defaultSourceLabel, defaultTarget]);

  async function inspect() {
    if (inputMode !== 'artifact') return;
    if (!artifactPath.trim()) return;
    setSummary(null);
    setStage('inspecting');
    setBusy(true);
    setError('');
    try {
      setSummary(normalizeInspection(await inspectLocalArtifact(artifactPath.trim())));
      setStage('idle');
    } catch (caught) {
      setStage('error');
      setError(errorMessage(caught, '无法读取插件制品'));
    } finally {
      setBusy(false);
    }
  }

  async function chooseArtifact() {
    try {
      const path = await selectPluginArtifact();
      if (!path) return;
      setArtifactPath(path);
      setFolderPath('');
      setAdaptReport(null);
      setAdaptReportId(undefined);
      setAdaptStage('idle');
      setAdaptError('');
      setInputMode('artifact');
      setSummary(null);
      setStage('idle');
      setError('');
      setBusy(true);
      setStage('inspecting');
      setSummary(normalizeInspection(await inspectLocalArtifact(path)));
      setStage('idle');
    } catch (caught) {
      setStage('error');
      setError(errorMessage(caught, '选择或检查插件制品失败'));
    } finally {
      setBusy(false);
    }
  }

  async function chooseFolder() {
    try {
      const path = await selectPluginDirectory();
      if (!path) return;
      setFolderPath(path);
      setArtifactPath('');
      setSummary(null);
      setAdaptReport(null);
      setAdaptReportId(undefined);
      setAdaptStage('idle');
      setAdaptError('');
      setInputMode('artifact');
      setStage('idle');
      setError('');
    } catch (caught) {
      setStage('error');
      setError(errorMessage(caught, '选择插件目录失败'));
    }
  }

  /**
   * 在桌面端用内置 Node.js 跑确定性适配引擎：校验 + 改造 + 运行时确证，并重新打包成
   * .lfplugin。产物路径随报告回传，暂存报告换得 reportId，随发布请求提交服务端落库。
   */
  async function runAdapt() {
    if (!folderPath.trim() || busy) return;
    setBusy(true);
    setAdaptStage('running');
    setAdaptError('');
    setAdaptReport(null);
    setAdaptReportId(undefined);
    setArtifactPath('');
    setSummary(null);
    setStage('idle');
    setError('');
    try {
      const result = await runPluginAdapt({
        pluginDir: folderPath.trim(),
        mode: 'adapt',
        execute: true,
        repack: true,
      });
      if (!result.ok || !result.report) {
        setAdaptStage('error');
        setAdaptError(result.error || '适配校验未产出报告');
        return;
      }
      const report = result.report;
      setAdaptReport(report);
      setAdaptStage('done');
      if (report.artifactPath) {
        setArtifactPath(report.artifactPath);
        try {
          setSummary(normalizeInspection(await inspectLocalArtifact(report.artifactPath)));
        } catch {
          setSummary(null);
        }
      }
      // 报告暂存失败不阻断发布：报告原文仍会在发布请求体内附带，由服务端尽力解析。
      try {
        const staged = await stageAdaptationReport(report as unknown as Record<string, unknown>);
        setAdaptReportId(staged.reportId);
      } catch (caught) {
        toast.warning(errorMessage(caught, '适配报告暂存失败，将随发布请求附带'));
      }
    } catch (caught) {
      setAdaptStage('error');
      setAdaptError(errorMessage(caught, '适配校验失败'));
    } finally {
      setBusy(false);
    }
  }

  function progressHandler(next: TransferProgress) {
    setProgress(next);
  }

  function notifyTeamPublished(state: PluginPublishState) {
    const result = state.result;
    if (!result || notifiedReleaseId.current === result.release.id) return;
    notifiedReleaseId.current = result.release.id;
    onPublished?.(result);
  }

  async function publish() {
    if (!canPublish || busy) return;
    if (inputMode === 'artifact' && folderPath.trim() && !artifactPath.trim()) {
      setError('请先对插件目录执行「适配校验并打包」');
      return;
    }
    if (inputMode === 'artifact' && !artifactPath.trim()) {
      setError('请选择一个 .lfplugin 制品');
      return;
    }
    if (inputMode === 'artifact' && !summary) {
      setError('请先检查制品，确认名称、版本和运行时后再发布');
      return;
    }
    setBusy(true);
    setError('');
    setProgress(null);
    setStage('uploading');
    try {
      const nextState = await publishPluginRelease({
        target: target === 'market' ? 'marketplace' : 'team',
        priceCents: target === 'market' ? Number.parseInt(price, 10) || 0 : undefined,
        onState: (value) => {
          setPublishState(value);
          setStage(publishPhaseToStage(value.phase));
          setError(value.error || '');
        },
        publishTeam: async () => {
          if (inputMode === 'artifact') {
            return publishLocalArtifact(artifactPath.trim(), {
              sourceKind,
              sourceLabel: sourceLabel.trim(),
              adaptationReportId: adaptReportId,
            }, progressHandler);
          }
          const nextWorkspace = workspace || (onPrepareWorkspace ? await onPrepareWorkspace() : null);
          if (!nextWorkspace) throw new Error('当前没有可发布的草稿工作区');
          setWorkspace(nextWorkspace);
          return publishDraftWorkspace(nextWorkspace, progressHandler, { sourceKind, sourceLabel: sourceLabel.trim(), adaptationReportId: adaptReportId });
        },
      });
      setPublishState(nextState);
      setStage(publishPhaseToStage(nextState.phase));
      setError(nextState.error || '');
      notifyTeamPublished(nextState);
    } catch (caught) {
      setStage('error');
      setError(errorMessage(caught, '发布失败'));
    } finally {
      setBusy(false);
    }
  }

  async function retryMarket() {
    if (publishState.phase !== 'market_failed' || !publishState.result || busy) return;
    setBusy(true);
    setStage('submitting_market');
    setError('');
    try {
      const nextState = await retryMarketplaceSubmission(
        publishState,
        Number.parseInt(price, 10) || 0,
        (value) => {
          setPublishState(value);
          setStage(publishPhaseToStage(value.phase));
          setError(value.error || '');
        },
      );
      setPublishState(nextState);
      setStage(publishPhaseToStage(nextState.phase));
      setError(nextState.error || '');
      notifyTeamPublished(nextState);
    } catch (caught) {
      setStage('market_failed');
      setError(errorMessage(caught, '市场提审失败，可稍后重试'));
    } finally {
      setBusy(false);
    }
  }

  const stageText = useMemo(() => ({
    idle: '待发布', inspecting: '正在检查制品', uploading: '正在发布团队版本', team_published: '团队版本已发布', submitting_market: '正在提交市场审核', done: '发布完成', market_failed: '团队已发布，市场提审失败', error: '发布失败',
  } satisfies Record<Stage, string>)[stage], [stage]);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy || stage === 'market_failed' || stage === 'done' || stage === 'error') onOpenChange(next); }}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><UploadIcon className="size-4" />发布插件</DialogTitle>
          <DialogDescription>先发布不可覆盖的团队版本；选择市场时会在团队发布成功后单独提审。</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Tabs value={inputMode} onValueChange={(value) => setInputMode(value as PublishInputMode)}>
            <TabsList className="w-full">
              <TabsTrigger value="workspace" disabled={!workspace && !draft && !onPrepareWorkspace}>当前草稿工作区</TabsTrigger>
              <TabsTrigger value="artifact">本地 .lfplugin 制品</TabsTrigger>
            </TabsList>
            <TabsContent value="workspace" className="space-y-2 pt-3">
              <div className="rounded-lg border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">{workspace?.title || draft?.name || '发布前将保存当前草稿工作区'}</div>
            </TabsContent>
            <TabsContent value="artifact" className="space-y-2 pt-3">
              <div className="flex gap-2">
                <Input className="min-w-0" value={artifactPath} onChange={(event) => { setArtifactPath(event.target.value); setSummary(null); }} placeholder="选择 .lfplugin 制品，或选择插件目录后适配打包（开发环境可输入路径）" />
                <Button className="shrink-0" type="button" variant="outline" size="icon" title="选择插件目录" onClick={() => void chooseFolder()} disabled={busy}><FolderOpenIcon /></Button>
                <Button className="shrink-0" type="button" variant="outline" size="icon" title="选择插件制品" onClick={() => void chooseArtifact()} disabled={busy}><FileArchiveIcon /></Button>
                <Button className="shrink-0" type="button" variant="outline" size="icon" title="检查制品" onClick={() => void inspect()} disabled={busy || !artifactPath.trim()}><RefreshCwIcon /></Button>
              </div>
              {folderPath.trim() && !artifactPath.trim() && (
                <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/20 px-3 py-2 text-sm">
                  <FolderOpenIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 break-all text-muted-foreground">{folderPath}</span>
                  <Button type="button" size="sm" variant="secondary" onClick={() => void runAdapt()} disabled={busy}>
                    {adaptStage === 'running' ? <Loader2Icon className="animate-spin" /> : <ShieldCheckIcon />}
                    适配校验并打包
                  </Button>
                </div>
              )}
              {adaptReport && <AdaptReportPanel report={adaptReport} reportId={adaptReportId} />}
            </TabsContent>
          </Tabs>

          <FieldGroup className="gap-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field className="gap-1.5">
                <FieldLabel htmlFor="publish-target" className="text-xs font-normal text-muted-foreground">发布目标</FieldLabel>
                <select id="publish-target" value={target} onChange={(event) => setTarget(event.target.value as PublishTarget)} className="h-9 rounded-md border bg-background px-2 text-sm text-foreground">
                  <option value="team">团队空间</option>
                  <option value="market" disabled={!canSubmitMarket}>团队 + 市场提审</option>
                </select>
              </Field>
              <Field className="gap-1.5">
                <FieldLabel htmlFor="publish-source-kind" className="text-xs font-normal text-muted-foreground">来源类型</FieldLabel>
                <select id="publish-source-kind" value={sourceKind} onChange={(event) => { const next = event.target.value as PluginReleaseSourceKind; setSourceKind(next); if (!sourceLabel || sourceLabel === DEFAULT_SOURCE_LABELS[sourceKind]) setSourceLabel(DEFAULT_SOURCE_LABELS[next]); }} className="h-9 rounded-md border bg-background px-2 text-sm text-foreground">
                  {SOURCE_OPTIONS.map((kind) => <option key={kind} value={kind}>{DEFAULT_SOURCE_LABELS[kind]}</option>)}
                </select>
              </Field>
            </div>
            <Field className="gap-1.5">
              <FieldLabel htmlFor="publish-source-label" className="text-xs font-normal text-muted-foreground">来源说明</FieldLabel>
              <Input id="publish-source-label" value={sourceLabel} maxLength={80} onChange={(event) => setSourceLabel(event.target.value)} placeholder="例如：VS Code 插件工程" />
            </Field>
            {target === 'market' && (
              <Field className="gap-1.5">
                <FieldLabel htmlFor="publish-price" className="text-xs font-normal text-muted-foreground">市场价格（分）</FieldLabel>
                <Input id="publish-price" inputMode="numeric" value={price} onChange={(event) => setPrice(event.target.value.replace(/[^0-9]/g, ''))} placeholder="0 表示免费" />
              </Field>
            )}
          </FieldGroup>

          {effectiveSummary && (
            <div className="divide-y rounded-lg border bg-muted/10 text-sm">
              <div className="flex items-center justify-between gap-3 px-3 py-2"><span className="font-medium">{effectiveSummary.name || '未命名插件'}</span><Badge variant="outline">v{effectiveSummary.version || '—'}</Badge></div>
              <div className="grid grid-cols-1 gap-x-4 gap-y-1 px-3 py-2 text-xs text-muted-foreground sm:grid-cols-2"><span className="break-all">ID：{effectiveSummary.id || '—'}</span><span>运行时：{effectiveSummary.runtime || '—'}</span><span className="break-all">入口：{effectiveSummary.entry || '—'}</span><span>文件：{effectiveSummary.fileCount ?? '—'} 个 · {formatBytes(effectiveSummary.sizeBytes)}</span></div>
            </div>
          )}

          <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground"><span className={stage === 'error' || stage === 'market_failed' ? 'text-destructive' : stage === 'done' ? 'text-success' : 'text-primary'}>{stage === 'error' || stage === 'market_failed' ? <XCircleIcon className="inline size-3.5" /> : stage === 'done' ? <CheckCircle2Icon className="inline size-3.5" /> : <Loader2Icon className={busy ? 'inline size-3.5 animate-spin' : 'inline size-3.5'} />}</span><span className="min-w-0 break-words">{stageText}{progress?.message ? ` · ${progress.message}` : ''}{percent != null ? ` ${percent}%` : ''}</span></div>
          {error && <Alert variant="destructive" className="border-destructive/30 bg-destructive/5 text-destructive"><AlertDescription className="text-destructive">{error}</AlertDescription></Alert>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy && stage !== 'market_failed'}>关闭</Button>
          {stage === 'market_failed' ? <Button onClick={() => void retryMarket()} disabled={busy || !publishState.result || !canSubmitMarket}><RefreshCwIcon />只重试市场提审</Button> : stage === 'done' ? <Button onClick={() => onOpenChange(false)}>完成</Button> : <Button onClick={() => void publish()} disabled={!canPublish || busy || (inputMode === 'artifact' && !artifactPath.trim())}>{busy ? <Loader2Icon className="animate-spin" /> : target === 'market' ? <StoreIcon /> : <SendIcon />}{inputMode === 'artifact' && !summary ? (folderPath.trim() && !artifactPath.trim() ? '先适配校验' : '先检查制品') : target === 'market' ? '发布并提审' : '发布到团队'}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function publishPhaseToStage(phase: PluginPublishState['phase']): Stage {
  if (phase === 'team_failed') return 'error';
  return phase;
}

function adaptationStatusBadge(status: AdaptationStatus): { label: string; className: string } {
  switch (status) {
    case 'ADAPTED_PASSED':
      return { label: '适配通过', className: 'border-success/30 bg-success/10 text-success' };
    case 'NEEDS_HUMAN':
      return { label: '需人工处理', className: 'border-amber-500/40 bg-amber-500/10 text-amber-600' };
    case 'ADAPTED_FAILED':
      return { label: '适配失败', className: 'border-destructive/30 bg-destructive/5 text-destructive' };
    default:
      return { label: '未适配', className: 'border-border bg-muted/30 text-muted-foreground' };
  }
}

function AdaptReportPanel({
  report,
  reportId,
}: {
  report: PluginAdaptationReport;
  reportId?: string;
}) {
  const badge = adaptationStatusBadge(report.status);
  return (
    <div className="space-y-2 rounded-lg border bg-muted/10 p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">适配校验报告</span>
        <span className={`rounded-full border px-2 py-0.5 text-xs ${badge.className}`}>{badge.label}</span>
      </div>
      <p className="text-xs text-muted-foreground">{report.summary}</p>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>引擎 v{report.engineVersion}</span>
        {report.pluginId && <span className="break-all">ID：{report.pluginId}</span>}
        <span>运行时：{report.runtimeType || '—'}</span>
        <span>已自动修复：{report.fixesApplied.length}</span>
        <span>待人工：{report.remaining.length}</span>
        <span>运行确证：{report.canRun ? '通过' : '未做 / 未过'}</span>
      </div>
      {reportId ? (
        <p className="text-xs text-muted-foreground">报告已暂存（id：{reportId}），将随发布请求提交服务端落库。</p>
      ) : (
        <p className="text-xs text-muted-foreground">报告暂存未成功，将随发布请求体附带，由服务端尽力解析。</p>
      )}
    </div>
  );
}
