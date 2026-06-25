import { useEffect, useState } from 'react';
import { RocketIcon, PencilIcon } from 'lucide-react';
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
import { Textarea } from '@/components/ui/textarea';
import { api, type ApiError } from '@/lib/api';
import { yuanToCents } from '@/lib/money';
import type { LoadedPlugin } from '@/lib/types';
import { dragRegionProps } from '@/lib/window-drag';
import { readPluginIcon } from './shared';

export function PluginMetaEditDialog({ plugin, onSaved }: { plugin: LoadedPlugin; onSaved?: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  // 去图标 UI 后仍保留 icon 值原样回写，避免编辑名称/描述时清空已有 manifest.icon。
  const [icon, setIcon] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName(plugin.name || '');
      setDescription(plugin.description || '');
      setIcon(readPluginIcon(plugin) || '');
    }
  }, [open, plugin]);

  async function save() {
    const trimmedName = name.trim();
    if (!trimmedName) return toast.error('插件名称不能为空');
    setSaving(true);
    try {
      await api(`/api/plugins/${plugin.id}/edit-meta`, {
        method: 'POST',
        body: { name: trimmedName, description, icon },
      });
      toast.success('插件信息已更新');
      setOpen(false);
      onSaved?.();
    } catch (e) {
      toast.error((e as ApiError).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!saving) setOpen(o); }}>
      <Button variant="ghost" size="icon-sm" title="编辑插件信息" onClick={() => setOpen(true)}>
        <PencilIcon className="size-4" />
      </Button>
      <DialogContent>
        <DialogHeader {...dragRegionProps}>
          <DialogTitle data-tauri-drag-region>编辑插件信息</DialogTitle>
          <DialogDescription>修改名称与描述，不影响源码与审核状态。</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="plugin-meta-name">名称</Label>
            <Input id="plugin-meta-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="插件名称" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="plugin-meta-desc">描述</Label>
            <Textarea id="plugin-meta-desc" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} placeholder="一句话说明插件功能" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>取消</Button>
          <Button onClick={() => { void save(); }} disabled={saving}>{saving ? '保存中…' : '保存'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PluginSubmitDialog({ plugin, onSubmitted }: { plugin: LoadedPlugin; onSubmitted?: () => void }) {
  const [open, setOpen] = useState(false);
  const [priceYuan, setPriceYuan] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open && typeof plugin.priceCents === 'number') {
      setPriceYuan(plugin.priceCents > 0 ? (plugin.priceCents / 100).toString() : '');
    }
  }, [open, plugin.priceCents]);

  const isPending = plugin.reviewStatus === 'PENDING';
  const isListed = plugin.reviewStatus === 'APPROVED' && plugin.marketplace;
  const disabled = isPending || isListed;

  async function submit() {
    const priceCents = priceYuan.trim() ? yuanToCents(priceYuan) : 0;
    setSubmitting(true);
    try {
      await api(`/api/plugins/${plugin.id}/submit-marketplace`, { method: 'POST', body: { priceCents } });
      toast.success('已提交市场审核');
      setOpen(false);
      onSubmitted?.();
    } catch (e) {
      toast.error((e as ApiError).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        variant="ghost"
        size="icon-sm"
        title={isPending ? '审核中' : isListed ? '已上架市场' : '提交市场审核'}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <RocketIcon className="size-4" />
      </Button>
      <DialogContent>
        <DialogHeader {...dragRegionProps}>
          <DialogTitle data-tauri-drag-region>提交市场审核</DialogTitle>
          <DialogDescription>{plugin.name} 将提交平台审核，通过后在公共市场可见。</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="plugin-submit-price">定价（元）</Label>
          <Input
            id="plugin-submit-price"
            value={priceYuan}
            onChange={(e) => setPriceYuan(e.target.value)}
            placeholder="0 表示免费"
            inputMode="decimal"
          />
          <p className="text-xs text-muted-foreground">提交后进入审核队列，审核期间不可改价或下架。</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={submitting}>取消</Button>
          <Button onClick={() => { void submit(); }} disabled={submitting}>{submitting ? '提交中…' : '提交审核'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
