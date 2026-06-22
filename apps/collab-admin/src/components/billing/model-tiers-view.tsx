// 模型版本视图：快速版/高级版底层模型 + 参数配置。见 docs/billing-and-relay-design.md §11.5.1 ③。
import { useState } from 'react';
import { api } from '@/lib/api';
import { useLoad, run } from '@/lib/helpers';
import { Section } from '@/components/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { ModelTierConfig, ModelTier } from '@/lib/types';

function TierCard({ tier, cfg, onSaved }: { tier: ModelTier; cfg: ModelTierConfig | null; onSaved: () => void }) {
  const labelDefault = tier === 'FAST' ? '快速版' : '高级版';
  const [form, setForm] = useState({
    label: cfg?.label ?? labelDefault,
    chatModel: cfg?.chatModel ?? '',
    imageModel: cfg?.imageModel ?? '',
    temperature: cfg?.temperature ?? '',
    maxTokens: cfg?.maxTokens ?? '',
  });
  const patch = (n: Partial<typeof form>) => setForm({ ...form, ...n });
  async function save() {
    if (!form.chatModel.trim()) return;
    const body = {
      label: form.label.trim(),
      chatModel: form.chatModel.trim(),
      imageModel: form.imageModel.trim() || null,
      temperature: form.temperature === '' ? undefined : Number(form.temperature),
      maxTokens: form.maxTokens === '' ? undefined : Number(form.maxTokens),
    };
    await run(() => api(`/api/admin/billing/tiers/${tier}`, { method: 'PUT', body }).then(onSaved), `${labelDefault}已保存`);
  }
  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2">{tier === 'FAST' ? '⚡' : '✦'} {labelDefault}</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-2"><Label>展示名</Label><Input value={form.label} onChange={(e) => patch({ label: e.target.value })} /></div>
        <div className="space-y-2"><Label>聊天模型（上游 id）</Label><Input placeholder="gpt-4o-mini" value={form.chatModel} onChange={(e) => patch({ chatModel: e.target.value })} /></div>
        <div className="space-y-2"><Label>生图模型（可空）</Label><Input placeholder="dall-e-3" value={form.imageModel} onChange={(e) => patch({ imageModel: e.target.value })} /></div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2"><Label>temperature</Label><Input type="number" step="0.1" value={form.temperature} onChange={(e) => patch({ temperature: e.target.value })} /></div>
          <div className="space-y-2"><Label>max_tokens</Label><Input type="number" value={form.maxTokens} onChange={(e) => patch({ maxTokens: e.target.value })} /></div>
        </div>
        <Button onClick={save} className="w-full">保存</Button>
      </CardContent>
    </Card>
  );
}

export function ModelTiersView() {
  const [tiers, setTiers] = useState<ModelTierConfig[]>([]);
  const load = () => api<{ tiers: ModelTierConfig[] }>('/api/admin/billing/tiers').then((r) => setTiers(r.tiers));
  useLoad(load);
  const fast = tiers.find((t) => t.tier === 'FAST') ?? null;
  const premium = tiers.find((t) => t.tier === 'PREMIUM') ?? null;
  return (
    <Section title="模型版本" description="前台仅显示「快速版/高级版」两个选项，底层模型与参数在此配置。">
      <div className="grid gap-4 sm:grid-cols-2">
        <TierCard tier="FAST" cfg={fast} onSaved={load} />
        <TierCard tier="PREMIUM" cfg={premium} onSaved={load} />
      </div>
    </Section>
  );
}
