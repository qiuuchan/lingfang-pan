import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2Icon,
  FileArchiveIcon,
  Loader2Icon,
  RefreshCwIcon,
  SendIcon,
  StoreIcon,
  UploadIcon,
  XCircleIcon,
} from 'lucide-react';
import { useApp } from '@/App';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
  selectPluginArtifact,
  type PluginPublishState,
  type RegistryPackage,
  type RegistryRelease,
  type TransferProgress,
  type Workspace,
} from '@/lib/plugin-registry';
import type { PluginReleaseSourceKind } from '@lingfang/contract';
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

type Stage =
  | 'idle'
  | 'inspecting'
  | 'uploading'
  | 'team_published'
  | 'submitting_market'
  | 'done'
  | 'market_failed'
  | 'error';

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
    manifest: {
      name: draft.name,
      id: draft.id,
      version: draft.version,
      runtime_type: draft.runtime_type,
      entry: draft.entry,
    },
  };
}

function normalizeInspection(value: unknown): ArtifactSummary {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const manifest =
    raw.manifest && typeof raw.manifest === 'object'
      ? (raw.manifest as Record<string, unknown>)
      : raw;
  const pick = (key: string, fallback: unknown = undefined) =>
    raw[key] ?? manifest[key] ?? fallback;
  return {
    name: typeof pick('name') === 'string' ? String(pick('name')) : undefined,
    id:
      typeof pick('id') === 'string'
        ? String(pick('id'))
        : typeof pick('manifestId') === 'string'
          ? String(pick('manifestId'))
          : undefined,
    version: typeof pick('version') === 'string' ? String(pick('version')) : undefined,
    runtime:
      typeof pick('runtime_type') === 'string'
        ? String(pick('runtime_type'))
        : typeof pick('runtime') === 'string'
          ? String(pick('runtime'))
          : undefined,
    entry: typeof pick('entry') === 'string' ? String(pick('entry')) : undefined,
    sizeBytes:
      typeof raw.sizeBytes === 'number'
        ? raw.sizeBytes
        : typeof raw.size_bytes === 'number'
          ? raw.size_bytes
          : undefined,
    fileCount: Array.isArray(raw.files)
      ? raw.files.length
      : typeof raw.fileCount === 'number'
        ? raw.fileCount
        : typeof raw.file_count === 'number'
          ? raw.file_count
          : undefined,
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
  const [inputMode, setInputMode] = useState<PublishInputMode>(
    initialArtifactPath ? 'artifact' : 'workspace'
  );
  const [target, setTarget] = useState<PublishTarget>(defaultTarget);
  const [artifactPath, setArtifactPath] = useState(initialArtifactPath || '');
  const [workspace, setWorkspace] = useState<Workspace | null>(initialWorkspace || null);
  const [sourceKind, setSourceKind] = useState<PluginReleaseSourceKind>(
    defaultSourceKind || (initialArtifactPath ? 'LOCAL_ARTIFACT' : 'LINGFANG_CREATOR')
  );
  const [sourceLabel, setSourceLabel] = useState(
    defaultSourceLabel ||
      DEFAULT_SOURCE_LABELS[
        defaultSourceKind || (initialArtifactPath ? 'LOCAL_ARTIFACT' : 'LINGFANG_CREATOR')
      ]
  );
  const [price, setPrice] = useState('0');
  const [stage, setStage] = useState<Stage>('idle');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [summary, setSummary] = useState<ArtifactSummary | null>(null);
  const [publishState, setPublishState] = useState<PluginPublishState>(() =>
    createPluginPublishState(defaultTarget === 'market' ? 'marketplace' : 'team')
  );
  const wasOpen = useRef(false);
  const notifiedReleaseId = useRef<string | null>(null);

  const artifactReady = inputMode !== 'artifact' || Boolean(summary);
  const canPublish = canUpload && artifactReady && (target !== 'market' || canSubmitMarket);
  const effectiveSummary =
    inputMode === 'artifact'
      ? summary
      : summaryFromDraft(draft) ||
        (workspace
          ? {
              id: workspace.manifestId,
              version: workspace.currentVersion,
              runtime: workspace.runtime,
              name: workspace.title,
            }
          : null);
  const percent = progress?.total
    ? Math.min(100, Math.round((progress.transferred / progress.total) * 100))
    : null;

  useEffect(() => {
    if (!open) {
      wasOpen.current = false;
      return;
    }
    if (wasOpen.current) return;
    wasOpen.current = true;
    setInputMode(
      initialArtifactPath ? 'artifact' : initialWorkspace || draft ? 'workspace' : 'artifact'
    );
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
    setPublishState(createPluginPublishState(defaultTarget === 'market' ? 'marketplace' : 'team'));
  }, [
    open,
    initialArtifactPath,
    initialWorkspace,
    draft,
    defaultSourceKind,
    defaultSourceLabel,
    defaultTarget,
  ]);

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
            return publishLocalArtifact(
              artifactPath.trim(),
              {
                sourceKind,
                sourceLabel: sourceLabel.trim(),
              },
              progressHandler
            );
          }
          const nextWorkspace =
            workspace || (onPrepareWorkspace ? await onPrepareWorkspace() : null);
          if (!nextWorkspace) throw new Error('当前没有可发布的草稿工作区');
          setWorkspace(nextWorkspace);
          return publishDraftWorkspace(nextWorkspace, progressHandler, {
            sourceKind,
            sourceLabel: sourceLabel.trim(),
          });
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
        }
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

  const stageText = useMemo(
    () =>
      (
        ({
          idle: '待发布',
          inspecting: '正在检查制品',
          uploading: '正在发布团队版本',
          team_published: '团队版本已发布',
          submitting_market: '正在提交市场审核',
          done: '发布完成',
          market_failed: '团队已发布，市场提审失败',
          error: '发布失败',
        }) satisfies Record<Stage, string>
      )[stage],
    [stage]
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy || stage === 'market_failed' || stage === 'done' || stage === 'error')
          onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UploadIcon className="size-4" />
            发布插件
          </DialogTitle>
          <DialogDescription>
            先发布不可覆盖的团队版本；选择市场时会在团队发布成功后单独提审。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <Tabs
            value={inputMode}
            onValueChange={(value) => setInputMode(value as PublishInputMode)}
          >
            <TabsList className="w-full">
              <TabsTrigger value="workspace" disabled={!workspace && !draft && !onPrepareWorkspace}>
                当前草稿工作区
              </TabsTrigger>
              <TabsTrigger value="artifact">本地 .lfplugin 制品</TabsTrigger>
            </TabsList>
            <TabsContent value="workspace" className="flex flex-col gap-2 pt-3">
              <div className="rounded-lg border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
                {workspace?.title || draft?.name || '发布前将保存当前草稿工作区'}
              </div>
            </TabsContent>
            <TabsContent value="artifact" className="flex flex-col gap-2 pt-3">
              <div className="flex gap-2">
                <Input
                  className="min-w-0"
                  value={artifactPath}
                  onChange={(event) => {
                    setArtifactPath(event.target.value);
                    setSummary(null);
                  }}
                  placeholder="选择 .lfplugin 文件（开发环境可输入路径）"
                />
                <Button
                  className="shrink-0"
                  type="button"
                  variant="outline"
                  size="icon"
                  title="选择插件制品"
                  onClick={() => void chooseArtifact()}
                  disabled={busy}
                >
                  <FileArchiveIcon />
                </Button>
                <Button
                  className="shrink-0"
                  type="button"
                  variant="outline"
                  size="icon"
                  title="检查制品"
                  onClick={() => void inspect()}
                  disabled={busy || !artifactPath.trim()}
                >
                  <RefreshCwIcon />
                </Button>
              </div>
            </TabsContent>
          </Tabs>

          <FieldGroup className="gap-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field className="gap-1.5">
                <FieldLabel
                  htmlFor="publish-target"
                  className="text-xs font-normal text-muted-foreground"
                >
                  发布目标
                </FieldLabel>
                <select
                  id="publish-target"
                  value={target}
                  onChange={(event) => setTarget(event.target.value as PublishTarget)}
                  className="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
                >
                  <option value="team">团队空间</option>
                  <option value="market" disabled={!canSubmitMarket}>
                    团队 + 市场提审
                  </option>
                </select>
              </Field>
              <Field className="gap-1.5">
                <FieldLabel
                  htmlFor="publish-source-kind"
                  className="text-xs font-normal text-muted-foreground"
                >
                  来源类型
                </FieldLabel>
                <select
                  id="publish-source-kind"
                  value={sourceKind}
                  onChange={(event) => {
                    const next = event.target.value as PluginReleaseSourceKind;
                    setSourceKind(next);
                    if (!sourceLabel || sourceLabel === DEFAULT_SOURCE_LABELS[sourceKind])
                      setSourceLabel(DEFAULT_SOURCE_LABELS[next]);
                  }}
                  className="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
                >
                  {SOURCE_OPTIONS.map((kind) => (
                    <option key={kind} value={kind}>
                      {DEFAULT_SOURCE_LABELS[kind]}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field className="gap-1.5">
              <FieldLabel
                htmlFor="publish-source-label"
                className="text-xs font-normal text-muted-foreground"
              >
                来源说明
              </FieldLabel>
              <Input
                id="publish-source-label"
                value={sourceLabel}
                maxLength={80}
                onChange={(event) => setSourceLabel(event.target.value)}
                placeholder="例如：VS Code 插件工程"
              />
            </Field>
            {target === 'market' && (
              <Field className="gap-1.5">
                <FieldLabel
                  htmlFor="publish-price"
                  className="text-xs font-normal text-muted-foreground"
                >
                  市场价格（分）
                </FieldLabel>
                <Input
                  id="publish-price"
                  inputMode="numeric"
                  value={price}
                  onChange={(event) => setPrice(event.target.value.replace(/[^0-9]/g, ''))}
                  placeholder="0 表示免费"
                />
              </Field>
            )}
          </FieldGroup>

          {effectiveSummary && (
            <div className="divide-y rounded-lg border bg-muted/10 text-sm">
              <div className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="font-medium">{effectiveSummary.name || '未命名插件'}</span>
                <Badge variant="outline">v{effectiveSummary.version || '—'}</Badge>
              </div>
              <div className="grid grid-cols-1 gap-x-4 gap-y-1 px-3 py-2 text-xs text-muted-foreground sm:grid-cols-2">
                <span className="break-all">ID：{effectiveSummary.id || '—'}</span>
                <span>运行时：{effectiveSummary.runtime || '—'}</span>
                <span className="break-all">入口：{effectiveSummary.entry || '—'}</span>
                <span>
                  文件：{effectiveSummary.fileCount ?? '—'} 个 ·{' '}
                  {formatBytes(effectiveSummary.sizeBytes)}
                </span>
              </div>
            </div>
          )}

          <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span
              className={
                stage === 'error' || stage === 'market_failed'
                  ? 'text-destructive'
                  : stage === 'done'
                    ? 'text-success'
                    : 'text-primary'
              }
            >
              {stage === 'error' || stage === 'market_failed' ? (
                <XCircleIcon className="inline size-3.5" />
              ) : stage === 'done' ? (
                <CheckCircle2Icon className="inline size-3.5" />
              ) : (
                <Loader2Icon
                  className={busy ? 'inline size-3.5 animate-spin' : 'inline size-3.5'}
                />
              )}
            </span>
            <span className="min-w-0 break-words">
              {stageText}
              {progress?.message ? ` · ${progress.message}` : ''}
              {percent != null ? ` ${percent}%` : ''}
            </span>
          </div>
          {error && (
            <Alert
              variant="destructive"
              className="border-destructive/30 bg-destructive/5 text-destructive"
            >
              <AlertDescription className="text-destructive">{error}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy && stage !== 'market_failed'}
          >
            关闭
          </Button>
          {stage === 'market_failed' ? (
            <Button
              onClick={() => void retryMarket()}
              disabled={busy || !publishState.result || !canSubmitMarket}
            >
              <RefreshCwIcon />
              只重试市场提审
            </Button>
          ) : stage === 'done' ? (
            <Button onClick={() => onOpenChange(false)}>完成</Button>
          ) : (
            <Button
              onClick={() => void publish()}
              disabled={!canPublish || busy || (inputMode === 'artifact' && !artifactPath.trim())}
            >
              {busy ? (
                <Loader2Icon className="animate-spin" />
              ) : target === 'market' ? (
                <StoreIcon />
              ) : (
                <SendIcon />
              )}
              {inputMode === 'artifact' && !summary
                ? '先检查制品'
                : target === 'market'
                  ? '发布并提审'
                  : '发布到团队'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function publishPhaseToStage(phase: PluginPublishState['phase']): Stage {
  if (phase === 'team_failed') return 'error';
  return phase;
}
