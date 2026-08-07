// 计费配置视图：全局灵石参数 + 模型定价 CRUD。见 docs/billing-and-relay-design.md §11.5.1 ②。
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { PlusIcon, PencilIcon, Trash2Icon } from 'lucide-react';
import { api } from '@/lib/api';
import { useLoad, run } from '@/lib/helpers';
import { Section, ActionBar } from '@/components/shared';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import type { ModelPricing, PricingUnit, ModelTier } from '@/lib/types';

const UNIT_LABEL: Record<PricingUnit, string> = {
  PER_TOKEN_INPUT: '每1M输入token',
  PER_TOKEN_OUTPUT: '每1M输出token',
  PER_CALL: '每次',
  PER_IMAGE: '每张',
  PER_SECOND: '每秒',
};
const CAPABILITIES = ['chat', 'image', 'action', 'video', 'audio'] as const;
const UNITS: PricingUnit[] = [
  'PER_TOKEN_INPUT',
  'PER_TOKEN_OUTPUT',
  'PER_CALL',
  'PER_IMAGE',
  'PER_SECOND',
];

function PricingFormFields({ form, setForm }: { form: any; setForm: (n: any) => void }) {
  const patch = (n: Partial<any>) => setForm({ ...form, ...n });
  // 按当前能力拉渠道模型列表（chat→聊天渠道模型；image→生图渠道模型；action 不拉，手输动作 key）。
  // 渠道是配置源——定价的下拉选项 = 渠道已配的 models（去重）。allowCustom 兜底手输不在列表的值。
  const [channelModels, setChannelModels] = useState<string[]>([]);
  useEffect(() => {
    if (
      form.capability === 'action' ||
      form.capability === 'video' ||
      form.capability === 'audio'
    ) {
      setChannelModels([]);
      return;
    }
    const kind = form.capability === 'chat' ? 'CHAT' : 'IMAGE';
    let mounted = true;
    api<{ channels: { models: string[] }[] }>(`/api/admin/billing/channels?kind=${kind}`)
      .then((r) => {
        if (mounted)
          setChannelModels(Array.from(new Set((r.channels ?? []).flatMap((c) => c.models ?? []))));
      })
      .catch(() => {
        if (mounted) setChannelModels([]);
      });
    return () => {
      mounted = false;
    };
  }, [form.capability]);
  // 模型字段：chat/image 用下拉（渠道模型集合）；action/video 用 Input（动作/视频 key 自由填）。
  const isModelSelect = form.capability === 'chat' || form.capability === 'image';
  // 当前值若不在列表（如编辑存量定价、或渠道未配该模型），加进去避免 Select 显示空。
  const modelOptions =
    isModelSelect && form.model && !channelModels.includes(form.model)
      ? [form.model, ...channelModels]
      : channelModels;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label>能力</Label>
          <Select
            value={form.capability}
            onValueChange={(v) => patch({ capability: v, model: '' })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CAPABILITIES.map((c) => (
                <SelectItem key={c} value={c}>
                  {c === 'chat'
                    ? '对话'
                    : c === 'image'
                      ? '生图'
                      : c === 'video'
                        ? '视频'
                        : c === 'audio'
                          ? '音频'
                          : '固定动作'}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>版本（可选）</Label>
          <Select
            value={form.tier ?? '__none__'}
            onValueChange={(v) => patch({ tier: v === '__none__' ? null : (v as ModelTier) })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">不限版本</SelectItem>
              <SelectItem value="FAST">快速版</SelectItem>
              <SelectItem value="PREMIUM">高级版</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label>模型/动作 key</Label>
          {isModelSelect ? (
            <Select value={form.model} onValueChange={(v) => patch({ model: v })}>
              <SelectTrigger>
                <SelectValue
                  placeholder={
                    modelOptions.length ? '选模型' : '（该类型接入未配模型，先在模型接入配模型）'
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {modelOptions.map((m) => (
                  <SelectItem key={m} value={m} className="font-mono text-xs">
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              placeholder={
                form.capability === 'video'
                  ? '视频 key，如 video_generate'
                  : form.capability === 'audio'
                    ? '音频 key，如 voice_clone'
                    : '动作 key，如 create_plugin_session'
              }
              value={form.model}
              onChange={(e) => patch({ model: e.target.value })}
            />
          )}
        </div>
        <div className="space-y-2">
          <Label>展示名</Label>
          <Input value={form.label} onChange={(e) => patch({ label: e.target.value })} />
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label>计费单位</Label>
          <Select value={form.unit} onValueChange={(v) => patch({ unit: v as PricingUnit })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {UNITS.map((u) => (
                <SelectItem key={u} value={u}>
                  {UNIT_LABEL[u]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>单价（灵石）</Label>
          <Input
            type="number"
            step="0.0001"
            min={0}
            value={form.pricePerUnit}
            onChange={(e) => patch({ pricePerUnit: Number(e.target.value) || 0 })}
          />
        </div>
        <div className="space-y-2">
          <Label>上下文窗口（token，可选）</Label>
          <Input
            type="number"
            min={0}
            placeholder="如 128000"
            value={form.contextWindow ?? ''}
            onChange={(e) =>
              patch({ contextWindow: e.target.value ? Number(e.target.value) : undefined })
            }
          />
        </div>
      </div>
      <div className="space-y-2">
        <Label>启用</Label>
        <Select
          value={form.enabled ? 'true' : 'false'}
          onValueChange={(v) => patch({ enabled: v === 'true' })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="true">启用</SelectItem>
            <SelectItem value="false">禁用</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

export function BillingView() {
  const [pricing, setPricing] = useState<ModelPricing[]>([]);
  const load = () =>
    api<{ items: ModelPricing[]; pricing?: ModelPricing[] }>('/api/admin/billing/pricing').then(
      (r) => setPricing(r.items ?? r.pricing ?? [])
    );
  useLoad(load);

  async function remove(p: ModelPricing) {
    if (!window.confirm(`删除定价「${p.label || p.model}」？`)) return;
    await run(
      () => api(`/api/admin/billing/pricing/${p.id}`, { method: 'DELETE' }).then(load),
      '定价已删除'
    );
  }

  return (
    <Section
      title="模型价格"
      description="模型灵石单价（后台可动态调整）。新的模型价格也可以在「模型接入」弹窗内配置。"
    >
      <CreatePricingDialog onRefresh={load}>
        <Button>
          <PlusIcon className="mr-1.5 size-4" />
          新增定价
        </Button>
      </CreatePricingDialog>
      <div className="mt-3">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>能力</TableHead>
              <TableHead>版本</TableHead>
              <TableHead>模型/动作</TableHead>
              <TableHead>计费单位</TableHead>
              <TableHead>单价（灵石）</TableHead>
              <TableHead>启用</TableHead>
              <TableHead className="w-[120px]">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pricing.length ? (
              pricing.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="text-muted-foreground">{p.capability}</TableCell>
                  <TableCell className="text-muted-foreground">{p.tier ?? '—'}</TableCell>
                  <TableCell className="font-medium">
                    {p.label || p.model}
                    <div className="font-mono text-xs text-muted-foreground">{p.model}</div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{UNIT_LABEL[p.unit]}</TableCell>
                  <TableCell className="tabular-nums">{p.pricePerUnit}</TableCell>
                  <TableCell>
                    {p.enabled ? (
                      <Badge variant="success" className="gap-1.5">
                        <span className="size-2 rounded-full bg-emerald-500" />
                        已启用
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="gap-1.5">
                        <span className="size-2 rounded-full bg-muted-foreground/60" />
                        已禁用
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <ActionBar>
                      <EditPricingDialog pricing={p} onRefresh={load}>
                        <Button variant="outline" size="sm">
                          <PencilIcon className="size-3.5" />
                        </Button>
                      </EditPricingDialog>
                      <Button variant="destructive" size="sm" onClick={() => remove(p)}>
                        <Trash2Icon className="size-3.5" />
                      </Button>
                    </ActionBar>
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                  暂无定价
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </Section>
  );
}

function emptyPricingForm() {
  return {
    capability: 'chat',
    model: '',
    label: '',
    unit: 'PER_TOKEN_INPUT' as PricingUnit,
    pricePerUnit: 1,
    contextWindow: undefined as number | undefined,
    tier: null as ModelTier | null,
    enabled: true,
  };
}

function CreatePricingDialog({
  children,
  onRefresh,
}: {
  children: React.ReactNode;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(emptyPricingForm());
  async function create() {
    if (!form.model.trim()) return toast.error('输入模型/动作 key');
    const body = { ...form, model: form.model.trim(), label: form.label.trim() };
    if (
      !(await run(
        () => api('/api/admin/billing/pricing', { method: 'POST', body }).then(onRefresh),
        '定价已保存'
      ))
    )
      return;
    setOpen(false);
    setForm(emptyPricingForm());
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>新增/更新定价</DialogTitle>
          <DialogDescription>同能力+模型+版本将更新而非新建</DialogDescription>
        </DialogHeader>
        <PricingFormFields form={form} setForm={setForm} />
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button onClick={create}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditPricingDialog({
  pricing,
  children,
  onRefresh,
}: {
  pricing: ModelPricing;
  children: React.ReactNode;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    capability: pricing.capability,
    model: pricing.model,
    label: pricing.label,
    unit: pricing.unit,
    pricePerUnit: pricing.pricePerUnit,
    contextWindow: (pricing as any).contextWindow,
    tier: pricing.tier,
    enabled: pricing.enabled,
  });
  useEffect(() => {
    if (open)
      setForm({
        capability: pricing.capability,
        model: pricing.model,
        label: pricing.label,
        unit: pricing.unit,
        pricePerUnit: pricing.pricePerUnit,
        contextWindow: (pricing as any).contextWindow,
        tier: pricing.tier,
        enabled: pricing.enabled,
      });
  }, [open, pricing]);
  async function save() {
    const body = { ...form, model: form.model.trim() };
    if (
      !(await run(
        () =>
          api(`/api/admin/billing/pricing/${pricing.id}`, { method: 'PATCH', body }).then(
            onRefresh
          ),
        '定价已更新'
      ))
    )
      return;
    setOpen(false);
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>编辑定价</DialogTitle>
          <DialogDescription>{pricing.label || pricing.model}</DialogDescription>
        </DialogHeader>
        <PricingFormFields form={form} setForm={setForm} />
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button onClick={save}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
