import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { PinIcon, PinOffIcon, PencilIcon, PowerIcon, Trash2Icon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Pagination } from '@/components/pagination';
import { api, type ApiError } from '@/lib/api';
import { deletePlugin } from '@/lib/plugin-status';
import { fmtYuan, yuanToCents } from '@/lib/money';
import type { LoadedPlugin } from '@/lib/types';
import { StaggerContainer, StaggerItem } from '@/lib/motion';
import { dragRegionProps } from '@/lib/window-drag';

const SOURCE_LABEL: Record<NonNullable<LoadedPlugin['source']>, string> = {
  published: '已发布',
  installed: '已安装',
  builtin: '内置',
  platform: '平台',
  team: '团队共享',
  marketplace: '市场',
};

// 审核状态 → 中文 + Badge variant（仅作者自己能看到，列表卡片角标提示当前审核进度）。
const REVIEW_LABEL: Record<string, string> = {
  DRAFT: '草稿',
  PENDING: '审核中',
  APPROVED: '已通过',
  REJECTED: '已驳回',
};

type PluginListProps = {
  isPinned: (id: string) => boolean;
  items: LoadedPlugin[];
  onRun: (plugin: LoadedPlugin) => void;
  onTogglePin: (plugin: LoadedPlugin, pinned: boolean) => void;
  /** 作者改价/切状态成功后回调，触发外层重新 loadPlugins 刷新列表。 */
  onAuthorChanged?: () => void;
  page: number;
  setPage: (page: number) => void;
  totalPages: number;
};

function pluginSource(plugin: LoadedPlugin): NonNullable<LoadedPlugin['source']> {
  return plugin.source || (plugin.builtin ? 'builtin' : 'published');
}

// 作者是否可改价/切状态：仅 source==='team'（本团队上传、作者持有）的插件可操作。
// 内置/市场安装/平台插件不可改（无对应端点或非作者资产）。
function isAuthorManaged(plugin: LoadedPlugin): boolean {
  return plugin.source === 'team';
}

export function PluginList(props: PluginListProps) {
  const { isPinned, items, onRun, onTogglePin, page, setPage, totalPages } = props;
  return (
    <div className="flex flex-col gap-4">
      {/* 列表项交错入场（尊重 useReducedMotion），每项轻微悬停反馈。 */}
      <StaggerContainer className="flex flex-col divide-y rounded-lg border" stagger={0.05}>
        {items.map((plugin) => (
          <StaggerItem key={plugin.id} whileHover={{ x: 2, transition: { type: 'spring', stiffness: 300, damping: 20 } }}>
            <PluginListItem
              isPinned={isPinned(plugin.id)}
              onAuthorChanged={props.onAuthorChanged}
              onRun={onRun}
              onTogglePin={onTogglePin}
              plugin={plugin}
            />
          </StaggerItem>
        ))}
      </StaggerContainer>
      <Pagination page={page} totalPages={totalPages} onChange={setPage} />
    </div>
  );
}

function PluginListItem({
  isPinned,
  onAuthorChanged,
  onRun,
  onTogglePin,
  plugin,
}: {
  isPinned: boolean;
  onAuthorChanged?: () => void;
  onRun: (plugin: LoadedPlugin) => void;
  onTogglePin: (plugin: LoadedPlugin, pinned: boolean) => void;
  plugin: LoadedPlugin;
}) {
  const source = pluginSource(plugin);
  const authorManaged = isAuthorManaged(plugin);
  const isDisabled = plugin.status === 'DISABLED';
  return (
    <div className="group flex items-center justify-between gap-3 px-4 py-3.5 transition hover:bg-muted/60">
      <Button variant="ghost" className="flex min-w-0 flex-1 items-center justify-start gap-2 rounded-none px-0 text-left" onClick={() => onRun(plugin)}>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium">{plugin.name}</span>
            <Badge variant={source === 'builtin' ? 'secondary' : 'outline'} className="shrink-0">
              {SOURCE_LABEL[source]}
            </Badge>
            {/* 作者插件展示审核状态 + 价格 + 启用态，便于作者一眼看到当前进度。 */}
            {authorManaged && plugin.reviewStatus && (
              <Badge variant={plugin.reviewStatus === 'APPROVED' ? 'secondary' : 'outline'} className="shrink-0 text-xs">
                {REVIEW_LABEL[plugin.reviewStatus] || plugin.reviewStatus}
              </Badge>
            )}
            {authorManaged && typeof plugin.priceCents === 'number' && (
              <Badge variant={plugin.priceCents > 0 ? 'default' : 'secondary'} className="shrink-0 text-xs">
                {fmtYuan(plugin.priceCents)}
              </Badge>
            )}
            {authorManaged && isDisabled && (
              <Badge variant="destructive" className="shrink-0 text-xs">已禁用</Badge>
            )}
          </div>
          <div className="truncate text-sm text-muted-foreground">{plugin.description || '—'}</div>
        </div>
      </Button>
      <div className="flex shrink-0 items-center gap-2">
        {authorManaged && <PluginPriceEditDialog plugin={plugin} onSaved={onAuthorChanged} />}
        {authorManaged && <PluginStatusToggle plugin={plugin} onToggled={onAuthorChanged} />}
        {authorManaged && <PluginDeleteDialog plugin={plugin} onDeleted={onAuthorChanged} />}
        <span className="text-xs text-muted-foreground">v{plugin.version}</span>
        <Button
          variant={isPinned ? 'secondary' : 'ghost'}
          size="icon-sm"
          title={isPinned ? '已固定到侧边栏，点击取消' : '固定到侧边栏'}
          onClick={() => onTogglePin(plugin, isPinned)}
        >
          {isPinned ? <PinOffIcon className="size-4" /> : <PinIcon className="size-4" />}
        </Button>
      </div>
    </div>
  );
}

// 作者改价对话框：调 POST /api/plugins/:id/set-price（不改源码、不触发审核流程）。
// 价格以元为输入单位（cents 不便阅读），保存时 yuanToCents 转回分。仅 source==='team' 渲染。
function PluginPriceEditDialog({ plugin, onSaved }: { plugin: LoadedPlugin; onSaved?: () => void }) {
  const [open, setOpen] = useState(false);
  const [priceYuan, setPriceYuan] = useState('');
  const [saving, setSaving] = useState(false);

  // 对话框打开时预填当前价格（分→元）；0 分显示空串（提示「留空=保持免费」）。
  useEffect(() => {
    if (open && typeof plugin.priceCents === 'number') {
      setPriceYuan(plugin.priceCents > 0 ? (plugin.priceCents / 100).toString() : '');
    }
  }, [open, plugin.priceCents]);

  async function save() {
    // 空串视为免费（0 分）；非空串用 yuanToCents 校验并转换。
    const priceCents = priceYuan.trim() ? yuanToCents(priceYuan) : 0;
    setSaving(true);
    try {
      await api(`/api/plugins/${plugin.id}/set-price`, { method: 'POST', body: { priceCents } });
      toast.success('价格已更新');
      setOpen(false);
      onSaved?.();
    } catch (e) {
      toast.error((e as ApiError).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="ghost" size="icon-sm" title="编辑价格" onClick={() => setOpen(true)}>
        <PencilIcon className="size-4" />
      </Button>
      <DialogContent>
        <DialogHeader {...dragRegionProps}>
          <DialogTitle data-tauri-drag-region>编辑价格</DialogTitle>
          <DialogDescription>{plugin.name}（修改后立即生效，不触发审核流程）</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="plugin-price">定价（元）</Label>
          <Input
            id="plugin-price"
            value={priceYuan}
            onChange={(e) => setPriceYuan(e.target.value)}
            placeholder="0 表示免费"
            inputMode="decimal"
            onKeyDown={(e) => e.key === 'Enter' && save()}
          />
          <p className="text-xs text-muted-foreground">
            当前：{typeof plugin.priceCents === 'number' ? fmtYuan(plugin.priceCents) : '—'}。审核中或已上架市场的插件需先下架/完成审核。
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>取消</Button>
          <Button onClick={save} disabled={saving}>{saving ? '保存中…' : '保存'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// 作者删除插件：调 DELETE /api/plugins/:id（仅未上架可删；已上架后端返 conflict）。
// 删云端成功后同步删本地目录（若有），再 onDeleted 刷新列表。
function PluginDeleteDialog({ plugin, onDeleted }: { plugin: LoadedPlugin; onDeleted?: () => void }) {
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function del() {
    setDeleting(true);
    try {
      await api(`/api/plugins/${plugin.id}`, { method: 'DELETE' });
      // 云端删成功后，同步清本地目录（忽略错误：本地可能无此插件）。
      try { await deletePlugin(plugin.id); } catch { /* 本地无目录，忽略 */ }
      toast.success('插件已删除');
      setOpen(false);
      onDeleted?.();
    } catch (e) {
      const msg = (e as ApiError).message || '删除失败';
      toast.error(msg);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!deleting) setOpen(o); }}>
      <Button variant="ghost" size="icon-sm" title="删除插件" onClick={() => setOpen(true)}>
        <Trash2Icon className="size-4" />
      </Button>
      <DialogContent>
        <DialogHeader {...dragRegionProps}>
          <DialogTitle data-tauri-drag-region>删除插件</DialogTitle>
          <DialogDescription>
            将永久删除「{plugin.name}」的云端记录与本地目录。已上架市场的插件需先联系管理员下架。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={deleting}>取消</Button>
          <Button variant="destructive" onClick={() => { void del(); }} disabled={deleting}>{deleting ? '删除中…' : '确认删除'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// 作者启用/禁用切换：调 POST /api/plugins/:id/set-status。仅 source==='team' 渲染。
// 图标按钮 + title 提示当前态（已启用点禁用 / 已禁用点启用）。
function PluginStatusToggle({ plugin, onToggled }: { plugin: LoadedPlugin; onToggled?: () => void }) {
  const [busy, setBusy] = useState(false);
  const isDisabled = plugin.status === 'DISABLED';
  const nextStatus = isDisabled ? 'ENABLED' : 'DISABLED';

  async function toggle() {
    setBusy(true);
    try {
      await api(`/api/plugins/${plugin.id}/set-status`, { method: 'POST', body: { status: nextStatus } });
      toast.success(nextStatus === 'ENABLED' ? '插件已启用' : '插件已禁用');
      onToggled?.();
    } catch (e) {
      toast.error((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      variant={isDisabled ? 'outline' : 'ghost'}
      size="icon-sm"
      title={isDisabled ? '启用插件' : '禁用插件'}
      disabled={busy}
      onClick={toggle}
    >
      <PowerIcon className={`size-4 ${isDisabled ? 'text-muted-foreground' : ''}`} />
    </Button>
  );
}
