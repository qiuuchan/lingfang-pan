// DraftPluginsSection.tsx —— 我的草稿插件列表区域（task 06-25-local-draft-storage + 增强）。
//
// 显示 AI 创建器保存的本地草稿插件，支持：运行、编辑、版本管理、发布到团队、删除、导入/导出。
import { useState, useRef } from 'react';
import { toast } from 'sonner';
import { FileEditIcon, PlayIcon, UploadIcon, Trash2Icon, RefreshCwIcon, PlusIcon, Loader2Icon, EditIcon, HistoryIcon, DownloadIcon, FileUpIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useApp } from '@/App';
import type { LoadedPlugin, PendingDraftEdit } from '@/lib/types';
import {
  deleteDraftPlugin,
  loadDraftPlugin,
  listDraftVersions,
  restoreDraftVersion,
  exportDraftPlugin,
  parseDraftBundle,
  importDraftBundle,
  type DraftVersion,
} from '@/lib/draft-plugin';
import { submitStagedPlugin, type StagedPlugin } from '@/lib/plugin-creator/creator-tools';
import { formatTimestamp } from '@/lib/time';

export function DraftPluginsSection({
  items,
  loading,
  onRun,
  onRefresh,
  onCreate,
  onClose,
}: {
  items: LoadedPlugin[];
  loading: boolean;
  onRun: (plugin: LoadedPlugin) => void;
  onRefresh: () => void;
  onCreate: () => void;
  onClose: () => void; // 关闭插件中心对话框
}) {
  const { setPendingDraftEdit } = useApp();
  const [publishing, setPublishing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [loadingVersions, setLoadingVersions] = useState<string | null>(null);
  const [restoringVersion, setRestoringVersion] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  async function handleEdit(draft: LoadedPlugin) {
    try {
      const fullDraft = await loadDraftPlugin(draft.id);
      const turns = fullDraft._meta?.turns;
      const payload: PendingDraftEdit = {
        draft: fullDraft,
        turns: Array.isArray(turns) ? turns : [],
      };
      setPendingDraftEdit(payload);
      onClose(); // 关闭插件中心
      toast.success(`已加载草稿「${draft.name}」，点击右下角 + 按钮打开创建器继续编辑`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function handlePublish(draft: LoadedPlugin) {
    setPublishing(draft.id);
    try {
      const fullDraft = await loadDraftPlugin(draft.id);
      // load_draft_plugin 返回的对象把 manifest 字段平铺到顶层（含 capabilities/visibility）。
      const raw = fullDraft as LoadedPlugin & {
        capabilities?: StagedPlugin['capabilities'];
        visibility?: StagedPlugin['visibility'];
      };
      const result = await submitStagedPlugin({
        id: fullDraft.id,
        name: fullDraft.name,
        version: fullDraft.version,
        entry: fullDraft.entry,
        description: fullDraft.description || '',
        capabilities: raw.capabilities ?? [],
        visibility: raw.visibility ?? 'private',
        runtime_type: (fullDraft.runtime_type as StagedPlugin['runtime_type']) || 'client',
        files: (fullDraft.files || []).map(f => ({ path: f.path, content: f.content })),
      });
      if (result.ok) {
        toast.success(`插件「${draft.name}」已发布到团队`);
        onRefresh();
      } else {
        toast.error(result.message);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setPublishing(null);
    }
  }

  async function handleDelete(draftId: string, draftName: string) {
    if (!confirm(`确定删除草稿「${draftName}」吗？此操作不可撤销。`)) return;
    setDeleting(draftId);
    try {
      await deleteDraftPlugin(draftId);
      toast.success(`草稿「${draftName}」已删除`);
      onRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(null);
    }
  }

  async function handleExport(draft: LoadedPlugin) {
    setExporting(draft.id);
    try {
      await exportDraftPlugin(draft.id, new Date().toISOString());
      toast.success(`草稿「${draft.name}」已导出`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(null);
    }
  }

  async function handleImport(file: File) {
    setImporting(true);
    try {
      const bundle = await parseDraftBundle(file);
      const name = await importDraftBundle(bundle);
      toast.success(`草稿「${name}」已导入`);
      onRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  }

  async function handleRestoreVersion(draftId: string, draftName: string, version: string) {
    if (!confirm(`确定回退草稿「${draftName}」到版本 ${version} 吗？当前内容会备份为新版本。`)) return;
    setRestoringVersion(`${draftId}-${version}`);
    try {
      await restoreDraftVersion(draftId, version);
      toast.success(`草稿「${draftName}」已回退到 ${version}`);
      onRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setRestoringVersion(null);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[300px] items-center justify-center">
        <Loader2Icon className="size-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex min-h-[400px] flex-col items-center justify-center gap-4 rounded-lg border border-dashed p-8">
        <FileEditIcon className="size-12 text-muted-foreground/40" />
        <div className="text-center">
          <h3 className="text-lg font-semibold">还没有草稿插件</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            使用 AI 创建器生成插件后，点击「保存草稿到本地」即可保存到这里
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={onCreate} className="gap-1.5">
            <PlusIcon className="size-4" />
            打开 AI 创建器
          </Button>
          <Button variant="outline" onClick={() => importInputRef.current?.click()} className="gap-1.5">
            <FileUpIcon className="size-4" />
            导入草稿
          </Button>
        </div>
        <input
          ref={importInputRef}
          type="file"
          accept=".lfplugin"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleImport(file);
            e.target.value = '';
          }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          共 {items.length} 个草稿插件
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => importInputRef.current?.click()} className="gap-1.5" disabled={importing}>
            {importing ? <Loader2Icon className="size-3.5 animate-spin" /> : <FileUpIcon className="size-3.5" />}
            导入草稿
          </Button>
          <Button variant="outline" size="sm" onClick={onRefresh} className="gap-1.5">
            <RefreshCwIcon className="size-3.5" />
            刷新
          </Button>
        </div>
      </div>

      <input
        ref={importInputRef}
        type="file"
        accept=".lfplugin"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleImport(file);
          e.target.value = '';
        }}
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((draft) => (
          <DraftCard
            key={draft.id}
            draft={draft}
            onEdit={() => handleEdit(draft)}
            onRun={() => onRun(draft)}
            onPublish={() => handlePublish(draft)}
            onDelete={() => handleDelete(draft.id, draft.name)}
            onExport={() => handleExport(draft)}
            onRestoreVersion={(version) => handleRestoreVersion(draft.id, draft.name, version)}
            publishing={publishing === draft.id}
            deleting={deleting === draft.id}
            exporting={exporting === draft.id}
            loadingVersions={loadingVersions === draft.id}
            restoringVersion={restoringVersion}
            onLoadVersions={() => setLoadingVersions(draft.id)}
            onClearLoadingVersions={() => setLoadingVersions(null)}
          />
        ))}
      </div>
    </div>
  );
}

function DraftCard({
  draft,
  onEdit,
  onRun,
  onPublish,
  onDelete,
  onExport,
  onRestoreVersion,
  publishing,
  deleting,
  exporting,
  loadingVersions,
  restoringVersion,
  onLoadVersions,
  onClearLoadingVersions,
}: {
  draft: LoadedPlugin;
  onEdit: () => void;
  onRun: () => void;
  onPublish: () => void;
  onDelete: () => void;
  onExport: () => void;
  onRestoreVersion: (version: string) => void;
  publishing: boolean;
  deleting: boolean;
  exporting: boolean;
  loadingVersions: boolean;
  restoringVersion: string | null;
  onLoadVersions: () => void;
  onClearLoadingVersions: () => void;
}) {
  const [versions, setVersions] = useState<DraftVersion[]>([]);
  const [versionPopoverOpen, setVersionPopoverOpen] = useState(false);

  async function loadVersions() {
    onLoadVersions();
    try {
      const vers = await listDraftVersions(draft.id);
      setVersions(vers);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      setVersions([]);
    } finally {
      onClearLoadingVersions();
    }
  }

  const hasVersions = (draft.versionCount ?? 0) > 0;
  const restoring = restoringVersion?.startsWith(`${draft.id}-`) ?? false;

  return (
    <div className="group relative flex flex-col gap-3 rounded-lg border bg-card p-4 transition-all hover:shadow-md">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate font-semibold">{draft.name}</h3>
            <Badge variant="outline" className="shrink-0 text-xs">
              草稿
            </Badge>
            {hasVersions && (
              <Badge variant="secondary" className="shrink-0 text-xs">
                {draft.versionCount} 版本
              </Badge>
            )}
          </div>
          {draft.description && (
            <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
              {draft.description}
            </p>
          )}
        </div>
      </div>

      {draft._meta && (
        <div className="text-xs text-muted-foreground">
          创建于 {formatTimestamp(draft._meta.createdAt)}
        </div>
      )}

      <div className="flex flex-col gap-2">
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={onEdit}
            className="flex-1 gap-1.5"
          >
            <EditIcon className="size-3.5" />
            编辑
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onRun}
            className="flex-1 gap-1.5"
          >
            <PlayIcon className="size-3.5" />
            运行
          </Button>
        </div>

        <Button
          size="sm"
          variant="default"
          onClick={onPublish}
          disabled={publishing}
          className="gap-1.5"
        >
          {publishing ? (
            <Loader2Icon className="size-3.5 animate-spin" />
          ) : (
            <UploadIcon className="size-3.5" />
          )}
          发布到团队
        </Button>

        <div className="flex gap-2">
          {hasVersions && (
            <Popover open={versionPopoverOpen} onOpenChange={(open) => {
              setVersionPopoverOpen(open);
              if (open && versions.length === 0) void loadVersions();
            }}>
              <PopoverTrigger>
                <Button size="sm" variant="outline" className="flex-1 gap-1.5" type="button">
                  <HistoryIcon className="size-3.5" />
                  版本
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-64">
                <div className="space-y-2">
                  <h4 className="text-sm font-semibold">版本历史</h4>
                  {loadingVersions ? (
                    <div className="flex justify-center py-2">
                      <Loader2Icon className="size-4 animate-spin" />
                    </div>
                  ) : versions.length === 0 ? (
                    <p className="text-xs text-muted-foreground">无历史版本</p>
                  ) : (
                    <div className="space-y-1">
                      {versions.map((v) => (
                        <button
                          key={v.version}
                          type="button"
                          onClick={() => {
                            onRestoreVersion(v.version);
                            setVersionPopoverOpen(false);
                          }}
                          disabled={restoring}
                          className="flex w-full items-center justify-between rounded px-2 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
                        >
                          <span>{v.version} {v.manifest?.version && `(${v.manifest.version})`}</span>
                          {restoring && <Loader2Icon className="size-3 animate-spin" />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </PopoverContent>
            </Popover>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={onExport}
            disabled={exporting}
            className="flex-1 gap-1.5"
          >
            {exporting ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <DownloadIcon className="size-3.5" />
            )}
            导出
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onDelete}
            disabled={deleting}
            className="flex-1 gap-1.5 text-destructive hover:bg-destructive/10"
          >
            {deleting ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <Trash2Icon className="size-3.5" />
            )}
            删除
          </Button>
        </div>
      </div>
    </div>
  );
}
