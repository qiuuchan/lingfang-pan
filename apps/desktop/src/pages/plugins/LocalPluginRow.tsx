import { useState } from 'react';
import { toast } from 'sonner';
import { InfoIcon, SquareIcon, Trash2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { LoadingButton } from '@/components/loading-button';
import { PluginManifestDialog } from '@/components/PluginManifestDialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { dragRegionProps } from '@/lib/window-drag';
import type { DraftFile } from '@/lib/types';
import {
  deletePlugin,
  readLocalPluginFile,
  stopPlugin,
  STATUS_DISPLAY,
  STATUS_VARIANT,
  RUNTIME_DISPLAY,
  type LocalPluginStatus,
} from '@/lib/plugin-status';
import { errorMessage } from '../plugins-runtime';

export function LocalPluginRow({
  item,
  onOpen,
  onDeleted,
  selectMode,
  selected,
  onToggleSelect,
}: {
  item: LocalPluginStatus;
  onOpen: (item: LocalPluginStatus) => void;
  onDeleted: () => void;
  /** 多选模式：true 时行首显示 checkbox，行内操作按钮隐藏。 */
  selectMode?: boolean;
  /** 当前是否被选中（仅 selectMode 时有意义）。 */
  selected?: boolean;
  /** 切换选中态（仅 selectMode 时调用）。 */
  onToggleSelect?: (id: string) => void;
}) {
  const row = useLocalPluginRow(item, onDeleted);
  return (
    <div className="group flex items-center justify-between gap-3 px-4 py-3.5 transition hover:bg-muted/60">
      {selectMode && (
        <Checkbox
          checked={selected}
          onCheckedChange={() => onToggleSelect?.(item.id)}
          className="shrink-0"
          aria-label={`选择 ${item.name}`}
        />
      )}
      <LocalPluginSummary item={item} />
      {!selectMode && <LocalPluginActions item={item} row={row} onOpen={onOpen} />}
      <LocalManifestDialog item={item} row={row} />
      <DeleteLocalPluginDialog item={item} row={row} />
    </div>
  );
}

function useLocalPluginRow(item: LocalPluginStatus, onDeleted: () => void) {
  return {
    ...useLocalManifestState(item),
    ...useLocalRunState(item),
    ...useLocalDeleteState(item, onDeleted),
  };
}

type LocalPluginRowState = ReturnType<typeof useLocalPluginRow>;

function useLocalManifestState(item: LocalPluginStatus) {
  const [manifestOpen, setManifestOpen] = useState(false);
  const [manifestFiles, setManifestFiles] = useState<DraftFile[]>([]);

  async function openManifest() {
    if (!manifestFiles.length) {
      try {
        const content = await readLocalPluginFile(item.id, 'manifest.json');
        setManifestFiles([{ path: 'manifest.json', content }]);
      } catch {
        setManifestFiles([]);
      }
    }
    setManifestOpen(true);
  }

  return { manifestFiles, manifestOpen, openManifest, setManifestOpen };
}

function useLocalRunState(item: LocalPluginStatus) {
  const [busy, setBusy] = useState(false);

  // 仅保留「停止」便捷入口（运行中的脚本）。启动统一走「打开」进 PluginRunner 中转页。
  async function stopRun() {
    setBusy(true);
    try {
      await stopPlugin(item.id);
      toast.success('插件已停止');
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return { busy, stopRun };
}

function useLocalDeleteState(item: LocalPluginStatus, onDeleted: () => void) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function deleteLocalPlugin() {
    setDeleting(true);
    try {
      await deletePlugin(item.id);
      toast.success('插件已删除');
      setDeleteOpen(false);
      onDeleted();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setDeleting(false);
    }
  }

  return { deleting, deleteLocalPlugin, deleteOpen, setDeleteOpen };
}

function LocalPluginSummary({ item }: { item: LocalPluginStatus }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium">{item.name}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{RUNTIME_DISPLAY[item.runtime]}</span>
          <StatusPill status={item.status} />
        </div>
        <div className="truncate text-sm text-muted-foreground">
          {item.detail || item.description || '—'}
        </div>
      </div>
    </div>
  );
}

function LocalPluginActions({
  item,
  row,
  onOpen,
}: {
  item: LocalPluginStatus;
  row: LocalPluginRowState;
  onOpen: (item: LocalPluginStatus) => void;
}) {
  const isRunning = item.status === 'running';
  // 统一启动：所有运行时都通过「打开」进 PluginRunner 中转页（client→iframe，脚本→分阶段启动）。
  // status==='error'/'incomplete' 也允许打开——中转页会显示具体错误 + 「让 AI 修复」，比禁用更有用。
  return (
    <div className="flex shrink-0 items-center gap-2">
      <span className="text-xs text-muted-foreground">v{item.version}</span>
      <Button variant="ghost" size="icon-sm" onClick={row.openManifest} title="查看插件信息">
        <InfoIcon className="size-3.5" />
      </Button>
      <Button variant="ghost" size="icon-sm" onClick={() => row.setDeleteOpen(true)} title="删除本地插件">
        <Trash2Icon className="size-3.5" />
      </Button>
      {/* 运行中的脚本：便捷「停止」（无需进 Runner）。 */}
      {isRunning && (
        <LoadingButton variant="destructive" size="sm" loading={row.busy} onClick={row.stopRun}>
          <SquareIcon className="size-3.5" />停止
        </LoadingButton>
      )}
      <Button variant="default" size="sm" onClick={() => onOpen(item)}>打开</Button>
    </div>
  );
}

function StatusPill({ status }: { status: LocalPluginStatus['status'] }) {
  const variant = STATUS_VARIANT[status];
  const className = variant === 'default'
    ? 'bg-primary text-primary-foreground'
    : variant === 'destructive'
      ? 'bg-destructive/10 text-destructive dark:bg-destructive/20'
      : variant === 'secondary'
        ? 'bg-secondary text-secondary-foreground'
        : 'border border-border text-foreground';
  return (
    <span className={`inline-flex h-5 items-center rounded-full px-2 text-xs font-medium ${className}`}>
      {STATUS_DISPLAY[status]}
    </span>
  );
}

function LocalManifestDialog({ item, row }: { item: LocalPluginStatus; row: LocalPluginRowState }) {
  return (
    <PluginManifestDialog
      open={row.manifestOpen}
      onOpenChange={row.setManifestOpen}
      pluginName={item.name}
      files={row.manifestFiles}
      fallback={{
        id: item.id,
        name: item.name,
        version: item.version,
        runtime_type: item.runtime,
        entry: item.entry,
        description: item.description,
      }}
    />
  );
}

function DeleteLocalPluginDialog({ item, row }: { item: LocalPluginStatus; row: LocalPluginRowState }) {
  return (
    <Dialog open={row.deleteOpen} onOpenChange={(open) => { if (!row.deleting) row.setDeleteOpen(open); }}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader {...dragRegionProps}>
          <DialogTitle data-tauri-drag-region>删除本地插件</DialogTitle>
          <DialogDescription>
            将删除本地插件目录「{item.name}」及其所有文件（含 venv/依赖/数据）。此操作不可撤销。
            若该插件已上传云端，云端记录不受影响，可重新安装恢复。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => row.setDeleteOpen(false)} disabled={row.deleting}>取消</Button>
          <LoadingButton variant="destructive" loading={row.deleting} onClick={() => { void row.deleteLocalPlugin(); }}>
            确认删除
          </LoadingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
