import { type ReactNode, useCallback, useState } from 'react';
import { toast } from 'sonner';
import {
  CheckSquareIcon, FolderOpenIcon, PackageIcon, RefreshCwIcon, Trash2Icon, XIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LoadingButton } from '@/components/loading-button';
import { Pagination } from '@/components/pagination';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Shimmer } from '@/lib/motion';
import { dragRegionProps } from '@/lib/window-drag';
import type { LocalPluginStatus } from '@/lib/plugin-status';
import { deletePlugin } from '@/lib/plugin-status';
import { LocalPluginRow } from './LocalPluginRow';

const PAGE_SIZE = 6;

export function LocalPluginsSection({
  items,
  loading,
  page,
  setPage,
  totalPages,
  onOpen,
  onOpenRoot,
  onRefresh,
}: {
  items: LocalPluginStatus[];
  loading: boolean;
  page: number;
  setPage: (page: number) => void;
  totalPages: number;
  onOpen: (item: LocalPluginStatus) => void;
  onOpenRoot: () => void;
  onRefresh: () => void;
}) {
  // 多选删除：selectMode 开启后行首出现 checkbox，header 切换为批量操作栏。
  const bulk = useBulkDelete(items, onRefresh);
  const pageItems = items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  return (
    <section className="flex flex-col gap-3">
      <SectionHeader
        count={items.length}
        loading={loading}
        selectMode={bulk.selectMode}
        selectedCount={bulk.selected.size}
        pageIds={pageItems.map((p) => p.id)}
        selected={bulk.selected}
        onToggle={bulk.toggle}
        onSelectAll={bulk.selectAll}
        onClearSelection={bulk.clear}
        onEnterSelect={bulk.enter}
        onExitSelect={bulk.exit}
        onBulkDelete={bulk.openDelete}
        onOpenRoot={onOpenRoot}
        onRefresh={onRefresh}
      />
      {loading ? (
        <ListSkeleton />
      ) : items.length ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col divide-y rounded-lg border">
            {pageItems.map((item) => (
              <LocalPluginRow
                key={item.id}
                item={item}
                onOpen={onOpen}
                onDeleted={onRefresh}
                selectMode={bulk.selectMode}
                selected={bulk.selected.has(item.id)}
                onToggleSelect={bulk.toggle}
              />
            ))}
          </div>
          {totalPages > 1 && <Pagination page={page} totalPages={totalPages} onChange={setPage} />}
        </div>
      ) : (
        <EmptyLocalPlugins />
      )}
      <BulkDeleteDialog
        open={bulk.deleteOpen}
        count={bulk.selected.size}
        deleting={bulk.deleting}
        onCancel={bulk.closeDelete}
        onConfirm={bulk.confirmDelete}
      />
    </section>
  );
}

/**
 * 多选删除状态机。
 * - selectMode：是否处于选择模式（开启后行首显示 checkbox，行内操作按钮隐藏）。
 * - selected：选中的插件 id 集合（跨页累积，切换分页不清空）。
 * - deleteOpen/deleting：批量删除确认对话框 + 删除中态。
 * 删除流程：逐个调 deletePlugin，部分失败不中断（继续删其余），最终汇总提示。
 */
function useBulkDelete(items: LocalPluginStatus[], onDeleted: () => void) {
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const enter = useCallback(() => { setSelectMode(true); }, []);
  const exit = useCallback(() => { setSelectMode(false); setSelected(new Set()); }, []);
  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  const selectAll = useCallback((ids: string[]) => {
    setSelected((prev) => {
      const next = new Set(prev);
      // 当前页全选则取消当前页，否则全选当前页（追加，不清已选）。
      const allOnPage = ids.every((id) => next.has(id));
      if (allOnPage) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => next.add(id));
      return next;
    });
  }, []);
  const clear = useCallback(() => setSelected(new Set()), []);
  const openDelete = useCallback(() => setDeleteOpen(true), []);
  const closeDelete = useCallback(() => { if (!deleting) setDeleteOpen(false); }, [deleting]);

  const confirmDelete = useCallback(async () => {
    setDeleting(true);
    let ok = 0;
    let fail = 0;
    for (const id of selected) {
      try { await deletePlugin(id); ok++; } catch { fail++; }
    }
    setDeleting(false);
    setDeleteOpen(false);
    setSelected(new Set());
    setSelectMode(false);
    if (fail === 0) toast.success(`已删除 ${ok} 个插件`);
    else toast.error(`删除完成：成功 ${ok}、失败 ${fail}`);
    onDeleted();
  }, [selected, onDeleted]);

  return { selectMode, selected, deleteOpen, deleting, enter, exit, toggle, selectAll, clear, openDelete, closeDelete, confirmDelete };
}

function SectionHeader({
  count,
  loading,
  selectMode,
  selectedCount,
  pageIds,
  selected,
  onToggle,
  onSelectAll,
  onClearSelection,
  onEnterSelect,
  onExitSelect,
  onBulkDelete,
  onOpenRoot,
  onRefresh,
}: {
  count: number;
  loading: boolean;
  selectMode: boolean;
  selectedCount: number;
  pageIds: string[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onSelectAll: (ids: string[]) => void;
  onClearSelection: () => void;
  onEnterSelect: () => void;
  onExitSelect: () => void;
  onBulkDelete: () => void;
  onOpenRoot: () => void;
  onRefresh: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        {selectMode ? (
          <>
            <h2 className="text-lg font-semibold tracking-tight">选择要删除的插件</h2>
            <span className="text-xs text-muted-foreground">已选 {selectedCount} 个</span>
          </>
        ) : (
          <>
            <h2 className="text-lg font-semibold tracking-tight">本地插件</h2>
            <span className="text-xs text-muted-foreground">{count} 个</span>
          </>
        )}
      </div>
      <div className="flex items-center gap-1">
        {selectMode ? (
          <>
            <Button variant="ghost" size="sm" onClick={() => onSelectAll(pageIds)} disabled={!pageIds.length}>
              {pageIds.length && pageIds.every((id) => selected.has(id)) ? '取消本页' : '本页全选'}
            </Button>
            <Button variant="ghost" size="sm" onClick={onClearSelection} disabled={selectedCount === 0}>清空选择</Button>
            <Button variant="destructive" size="sm" onClick={onBulkDelete} disabled={selectedCount === 0}>
              <Trash2Icon className="size-3.5" />删除{selectedCount > 0 ? ` (${selectedCount})` : ''}
            </Button>
            <Button variant="ghost" size="icon-sm" title="退出选择" onClick={onExitSelect}>
              <XIcon className="size-4" />
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={onEnterSelect} disabled={loading || count === 0} title="多选删除">
              <CheckSquareIcon className="size-3.5" />选择
            </Button>
            <Button variant="ghost" size="icon-sm" title="打开插件存储目录" onClick={onOpenRoot}>
              <FolderOpenIcon className="size-4" />
            </Button>
            <Button variant="ghost" size="icon-sm" title="重新扫描本地插件状态" onClick={onRefresh}>
              <RefreshCwIcon className={`size-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/** 批量删除确认对话框。 */
function BulkDeleteDialog({
  open,
  count,
  deleting,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  count: number;
  deleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onCancel(); }}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader {...dragRegionProps}>
          <DialogTitle data-tauri-drag-region>批量删除本地插件</DialogTitle>
          <DialogDescription>
            将删除选中的 {count} 个本地插件目录及其所有文件（含 venv/依赖/数据）。此操作不可撤销。
            已上传云端的插件记录不受影响，可重新安装恢复。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={deleting}>取消</Button>
          <LoadingButton variant="destructive" loading={deleting} onClick={() => { void onConfirm(); }}>
            确认删除 {count} 个
          </LoadingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EmptyLocalPlugins() {
  return (
    <EmptyState
      icon={<PackageIcon className="size-8 text-muted-foreground/50" />}
      title="还没有本地插件"
      description="创建器生成或市场安装的插件会保存在这里，重启后仍可用。"
    />
  );
}

function EmptyState({
  icon,
  title,
  description,
}: {
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
      {icon}
      <span>{title}</span>
      <span className="text-xs">{description}</span>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="flex flex-col divide-y rounded-lg border">
      {Array.from({ length: PAGE_SIZE }).map((_, i) => (
        <Shimmer key={i} className="h-14 w-full rounded-none" />
      ))}
    </div>
  );
}
