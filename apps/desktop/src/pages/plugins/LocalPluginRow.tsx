import { useState } from 'react';
import { toast } from 'sonner';
import { DownloadIcon, InfoIcon, RocketIcon, ServerIcon, StoreIcon, SquareIcon, Trash2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { LoadingButton } from '@/components/loading-button';
import { PluginManifestDialog } from '@/components/PluginManifestDialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { dragRegionProps } from '@/lib/window-drag';
import type { DraftFile } from '@/lib/types';
import { api, type ApiError } from '@/lib/api';
import { yuanToCents } from '@/lib/money';
import {
  deletePlugin,
  readLocalPluginFile,
  stopPlugin,
  STATUS_DISPLAY,
  STATUS_VARIANT,
  RUNTIME_DISPLAY,
  type LocalPluginStatus,
} from '@/lib/plugin-status';
import { loadLocalPluginAsStaged } from '@/lib/plugin-creator/local-upload';
import { submitStagedPlugin } from '@/lib/plugin-creator/creator-tools';
import { exportPluginToZip } from '@/lib/plugin-package-zip';
import { errorMessage } from '../plugins-runtime';

export function LocalPluginRow({
  item,
  onOpen,
  onDeleted,
  onPublished,
  selectMode,
  selected,
  onToggleSelect,
}: {
  item: LocalPluginStatus;
  onOpen: (item: LocalPluginStatus) => void;
  onDeleted: () => void;
  /** 发布到团队/市场成功后回调：父组件应同时刷新本地与团队列表（团队列表才会出现新发布项）。 */
  onPublished: () => void;
  /** 多选模式：true 时行首显示 checkbox，行内操作按钮隐藏。 */
  selectMode?: boolean;
  /** 当前是否被选中（仅 selectMode 时有意义）。 */
  selected?: boolean;
  /** 切换选中态（仅 selectMode 时调用）。 */
  onToggleSelect?: (id: string) => void;
}) {
  const row = useLocalPluginRow(item, onDeleted, onPublished);
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
      {!item.draft && <PublishToMarketDialog item={item} row={row} />}
    </div>
  );
}

function useLocalPluginRow(item: LocalPluginStatus, onDeleted: () => void, onPublished: () => void) {
  return {
    ...useLocalManifestState(item),
    ...useLocalRunState(item, onDeleted),
    ...useLocalDeleteState(item, onDeleted),
    ...useLocalPublishState(item, onPublished),
    ...useLocalExportState(item),
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

function useLocalRunState(item: LocalPluginStatus, onStopped: () => void) {
  const [busy, setBusy] = useState(false);

  // 仅保留「停止」便捷入口（运行中的脚本）。启动统一走「打开」进 PluginRunner 中转页。
  async function stopRun() {
    setBusy(true);
    try {
      await stopPlugin(item.id);
      toast.success('插件已停止');
      // 刷新列表状态：stopPlugin 后端已清理进程表，但前端列表是 scanPluginStatus 缓存快照，
      // 不刷新会一直显示「运行中」（onStopped = 父组件的 reload/refresh）。
      onStopped();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return { busy, stopRun };
}

/**
 * 发布本地插件：两种目标。
 *
 * - publishLocalToTeam：复用 submitStagedPlugin（POST /api/plugins/upload）→ 团队插件（reviewStatus=DRAFT）。
 * - publishLocalToMarket：① upload 到团队（拿到 plugin.id）→ ② POST /api/plugins/:id/submit-marketplace
 *   一步进入市场审核队列（PENDING）。带定价弹窗（priceCents，默认免费）。
 *
 * upgraded=true：团队内已有同 manifest.id 插件，本次为版本升级覆盖（两种目标都支持升级路径）。
 * 成功后调 onPublished：父组件据此刷新本地 + 团队列表（团队列表才会出现新发布项）。
 *
 * - loadLocalPluginAsStaged 读磁盘 manifest + 全部源文件 → StagedPlugin。
 * - submitStagedPlugin 内含 validateStagedCompleteness（python 需 main.py + requirements.txt 等），
 *   不完整时直接报其 message。
 */
function useLocalPublishState(item: LocalPluginStatus, onPublished: () => void) {
  const [publishing, setPublishing] = useState(false);
  // Popover 发布菜单开关。
  const [menuOpen, setMenuOpen] = useState(false);
  // 「发布到市场」定价弹窗：用户填定价后确认才走 upload + submit-marketplace。
  const [marketOpen, setMarketOpen] = useState(false);
  const [priceYuan, setPriceYuan] = useState('');

  async function publishLocalToTeam() {
    setMenuOpen(false);
    setPublishing(true);
    try {
      const staged = await loadLocalPluginAsStaged(item.id);
      const result = await submitStagedPlugin(staged);
      if (result.ok) {
        // upgraded=true：团队内已有同 manifest.id 插件，本次为版本升级覆盖。
        if (result.upgraded) {
          toast.success(`插件「${item.name}」已升级到 v${staged.version}（团队内已有该插件，已覆盖旧版本）`);
        } else {
          toast.success(`插件「${item.name}」已发布到团队空间`);
        }
        onPublished();
      } else {
        toast.error(result.message);
      }
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPublishing(false);
    }
  }

  /** 打开「发布到市场」定价弹窗（从菜单触发，关闭菜单）。 */
  function openMarketDialog() {
    setMenuOpen(false);
    setPriceYuan('');
    setMarketOpen(true);
  }

  /** 确认发布到市场：upload 到团队 → 拿 plugin.id → submit-marketplace 进入审核队列。 */
  async function confirmPublishToMarket() {
    setPublishing(true);
    try {
      const staged = await loadLocalPluginAsStaged(item.id);
      const result = await submitStagedPlugin(staged);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      if (!result.id) {
        // 理论不应发生（upload 始终返回 plugin.id），兜底提示。
        toast.error('上传成功但未返回插件 ID，无法提交市场审核，请到「团队插件」手动提交');
        onPublished();
        return;
      }
      // 第二步：提交市场审核（priceCents，空=免费）。
      const priceCents = priceYuan.trim() ? yuanToCents(priceYuan) : 0;
      try {
        await api(`/api/plugins/${result.id}/submit-marketplace`, { method: 'POST', body: { priceCents } });
        if (result.upgraded) {
          toast.success(`插件「${item.name}」已升级到 v${staged.version} 并提交市场审核`);
        } else {
          toast.success(`插件「${item.name}」已发布并提交市场审核，审核通过后在公共市场可见`);
        }
        setMarketOpen(false);
        onPublished();
      } catch (e) {
        // upload 已成功但 submit 失败（如已在审核中）：提示去团队行手动提交，不回滚 upload。
        toast.error(`已上传到团队但提交审核失败：${(e as ApiError).message || String(e)}（可在「团队插件」重试）`);
        onPublished();
      }
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPublishing(false);
    }
  }

  return {
    publishing,
    menuOpen,
    setMenuOpen,
    marketOpen,
    setMarketOpen,
    priceYuan,
    setPriceYuan,
    publishLocalToTeam,
    openMarketDialog,
    confirmPublishToMarket,
  };
}

/**
 * 导出本地插件为 .lfplugin ZIP 包（浏览器下载）。
 *
 * 复用 exportPluginToZip：枚举源文件 + 读内容（跳过二进制占位）→ 打包 → 下载。
 * 成功提示文件数与跳过的二进制数。
 */
function useLocalExportState(item: LocalPluginStatus) {
  const [exporting, setExporting] = useState(false);

  async function exportLocal() {
    setExporting(true);
    try {
      const { name, fileCount, skipped } = await exportPluginToZip(item.id, 'local');
      const skipNote = skipped > 0 ? `，跳过 ${skipped} 个二进制文件` : '';
      toast.success(`已导出「${name}」（${fileCount} 个文件${skipNote}）`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setExporting(false);
    }
  }

  return { exporting, exportLocal };
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
      {/* 导出为 .lfplugin ZIP 包（浏览器下载）。 */}
      <Button
        variant="ghost"
        size="icon-sm"
        title="导出为 .lfplugin 压缩包"
        disabled={row.exporting}
        onClick={row.exportLocal}
      >
        <DownloadIcon className="size-3.5" />
      </Button>
      {/* 发布：Popover 菜单二选一——「发布到团队」/「发布到市场」（后者带定价，一步进入审核队列）。
          非草稿本地插件才有；草稿在「我的草稿」tab 有自己的发布流程。 */}
      {!item.draft && (
        <Popover open={row.menuOpen} onOpenChange={(v) => { if (!row.publishing) row.setMenuOpen(v); }}>
          <PopoverTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                title="发布到团队 / 市场"
                disabled={row.publishing}
              >
                <RocketIcon className="size-3.5" />
              </Button>
            }
          />
          <PopoverContent align="end" className="w-56 gap-0 p-1">
            <button
              type="button"
              disabled={row.publishing}
              onClick={() => { void row.publishLocalToTeam(); }}
              className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm hover:bg-muted disabled:opacity-50"
            >
              <ServerIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0">
                <span className="block">发布到团队</span>
                <span className="block text-xs text-muted-foreground">团队空间可见，后续可提交市场</span>
              </span>
            </button>
            <button
              type="button"
              disabled={row.publishing}
              onClick={() => row.openMarketDialog()}
              className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm hover:bg-muted disabled:opacity-50"
            >
              <StoreIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0">
                <span className="block">发布到市场</span>
                <span className="block text-xs text-muted-foreground">一步提交审核，通过后公共可见</span>
              </span>
            </button>
          </PopoverContent>
        </Popover>
      )}
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

/** 「发布到市场」定价弹窗：填定价 → 确认后 upload + submit-marketplace（一步进入审核队列）。 */
function PublishToMarketDialog({ item, row }: { item: LocalPluginStatus; row: LocalPluginRowState }) {
  return (
    <Dialog open={row.marketOpen} onOpenChange={(open) => { if (!row.publishing) row.setMarketOpen(open); }}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader {...dragRegionProps}>
          <DialogTitle data-tauri-drag-region>发布到市场</DialogTitle>
          <DialogDescription>
            将发布「{item.name}」并提交平台审核，通过后在公共市场可见。可在此设置定价。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="local-market-price">定价（元）</Label>
          <Input
            id="local-market-price"
            value={row.priceYuan}
            onChange={(e) => row.setPriceYuan(e.target.value)}
            placeholder="0 表示免费"
            inputMode="decimal"
            autoFocus
          />
          <p className="text-xs text-muted-foreground">提交后进入审核队列，审核期间不可改价或下架。</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => row.setMarketOpen(false)} disabled={row.publishing}>取消</Button>
          <LoadingButton loading={row.publishing} onClick={() => { void row.confirmPublishToMarket(); }}>
            发布并提交审核
          </LoadingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
