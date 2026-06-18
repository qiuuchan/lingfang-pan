import { useEffect, useState } from 'react';
import { PencilIcon, PowerIcon, Trash2Icon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
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
import { api, type ApiError } from '@/lib/api';
import { fmtYuan, yuanToCents } from '@/lib/money';
import { deletePlugin } from '@/lib/plugin-status';
import type { LoadedPlugin } from '@/lib/types';
import { dragRegionProps } from '@/lib/window-drag';

export function PluginPriceEditDialog({ plugin, onSaved }: { plugin: LoadedPlugin; onSaved?: () => void }) {
  const [open, setOpen] = useState(false);
  const [priceYuan, setPriceYuan] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open && typeof plugin.priceCents === 'number') {
      setPriceYuan(plugin.priceCents > 0 ? (plugin.priceCents / 100).toString() : '');
    }
  }, [open, plugin.priceCents]);

  async function save() {
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

export function PluginDeleteDialog({ plugin, onDeleted }: { plugin: LoadedPlugin; onDeleted?: () => void }) {
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function del() {
    setDeleting(true);
    try {
      await api(`/api/plugins/${plugin.id}`, { method: 'DELETE' });
      try { await deletePlugin(plugin.id); } catch { /* 本地无目录，忽略 */ }
      toast.success('插件已删除');
      setOpen(false);
      onDeleted?.();
    } catch (e) {
      toast.error((e as ApiError).message || '删除失败');
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
          <Button variant="destructive" onClick={() => { void del(); }} disabled={deleting}>
            {deleting ? '删除中…' : '确认删除'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PluginStatusToggle({ plugin, onToggled }: { plugin: LoadedPlugin; onToggled?: () => void }) {
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
