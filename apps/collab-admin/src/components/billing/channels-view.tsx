import { getPresetModels } from '@/lib/preset-models';
// 渠道管理（资源池模型重构后）：聊天渠道 / 生图渠道 两类分开（同表 kind 字段）。
// 每个渠道：kind + tier（快速/高级）+ 归属资源池 + 多个轮询模型。
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { PlusIcon, PencilIcon, Trash2Icon, ZapIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { run } from '@/lib/helpers';
import { Section, ActionBar } from '@/components/shared';
import { Pagination } from '@/components/ui/pagination';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
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
import type {
  Channel,
  ChannelKind,
  ChannelProtocol,
  ChannelStatus,
  ModelPricing,
  ModelTier,
  Pool,
  PricingUnit,
} from '@/lib/types';
import { TestChannelDialog } from './test-channel-dialog';

const PROVIDER_OPTIONS = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'azure', label: 'Azure OpenAI' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'moonshot', label: 'Moonshot' },
  { value: 'qwen', label: 'Qwen' },
  { value: 'custom', label: '自定义' },
];

export function ChannelsView() {
  return (
    <Section
      title="模型接入"
      description="在同一视窗内接入上游模型、绑定资源池，并为模型配置灵石价格。聊天 / 生图按类型分开管理。"
    >
      <Tabs defaultValue="CHAT">
        <TabsList>
          <TabsTrigger value="CHAT">聊天渠道</TabsTrigger>
          <TabsTrigger value="IMAGE">生图渠道</TabsTrigger>
        </TabsList>
        <TabsContent value="CHAT" className="mt-4">
          <ChannelList kind="CHAT" />
        </TabsContent>
        <TabsContent value="IMAGE" className="mt-4">
          <ChannelList kind="IMAGE" />
        </TabsContent>
      </Tabs>
    </Section>
  );
}

function ChannelList({ kind }: { kind: ChannelKind }) {
  const [list, setList] = useState<Array<Channel & { modelCount?: number }>>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [totalItems, setTotalItems] = useState(0);
  const [testing, setTesting] = useState<Channel | null>(null);
  const load = async () => {
    const result = await api<{ items?: Array<Channel & { modelCount?: number }>; total?: number }>(
      `/api/admin/billing/channels?kind=${kind}&page=${page}&pageSize=${pageSize}`
    );
    // 后端正常返回 { items, total }；但 api() 会把非 JSON 的 200 响应体兜底成 {}（见 api.ts），
    // 此时 result.items 为 undefined，若直接 setList(undefined) 会让下面的 list.length 抛
    // "Cannot read properties of undefined (reading 'length')" 导致整个渠道页白屏。
    // 用 ?? 兜底为空列表/0，让异常响应降级为「暂无渠道」而非崩溃。
    setList(result?.items ?? []);
    setTotalItems(result?.total ?? 0);
  };
  useEffect(() => {
    void load();
  }, [kind, page, pageSize]);

  async function remove(ch: Channel) {
    if (!window.confirm(`确认删除渠道「${ch.name}」？`)) return;
    await run(
      () => api(`/api/admin/billing/channels/${ch.id}`, { method: 'DELETE' }).then(load),
      '渠道已删除'
    );
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          {totalItems} 个{kind === 'CHAT' ? '聊天' : '生图'}渠道
        </div>
        <ChannelDialog kind={kind} pools={[]} onRefresh={load}>
          <Button>
            <PlusIcon className="mr-1.5 size-4" />
            新增{kind === 'CHAT' ? '聊天' : '生图'}渠道
          </Button>
        </ChannelDialog>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>名称</TableHead>
            <TableHead>版本</TableHead>
            <TableHead>所属池</TableHead>
            <TableHead>模型数</TableHead>
            <TableHead>健康</TableHead>
            <TableHead className="w-[280px]">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {list.length ? (
            list.map((ch) => (
              <TableRow key={ch.id}>
                <TableCell className="font-medium">
                  {ch.name}
                  <div className="font-mono text-xs text-muted-foreground">
                    {ch.protocol} · {ch.provider}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{ch.tier === 'FAST' ? '快速' : '高级'}</Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {ch.pool?.name ?? ch.poolId.slice(0, 8)}
                </TableCell>
                <TableCell className="tabular-nums">
                  {ch.modelCount ?? ch.models?.length ?? 0}
                </TableCell>
                <TableCell>
                  {ch.lastHealthOk == null ? (
                    <span className="text-muted-foreground">未测</span>
                  ) : ch.lastHealthOk ? (
                    <Badge variant="success">通</Badge>
                  ) : (
                    <Badge variant="destructive">异常</Badge>
                  )}
                </TableCell>
                <TableCell>
                  <ActionBar>
                    <ChannelDialog channel={ch} kind={kind} pools={[]} onRefresh={load}>
                      <Button variant="outline" size="sm">
                        <PencilIcon className="mr-1 size-3.5" />
                        编辑
                      </Button>
                    </ChannelDialog>
                    <Button variant="outline" size="sm" onClick={() => setTesting(ch)}>
                      <ZapIcon className="mr-1 size-3.5" />
                      测试
                    </Button>
                    <Button variant="destructive" size="sm" onClick={() => remove(ch)}>
                      <Trash2Icon className="mr-1 size-3.5" />
                    </Button>
                  </ActionBar>
                </TableCell>
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                暂无{kind === 'CHAT' ? '聊天' : '生图'}渠道
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      <Pagination
        totalItems={totalItems}
        pageSize={pageSize}
        currentPage={page}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
      />
      {testing && (
        <TestChannelDialog channel={testing} onDone={load} onClose={() => setTesting(null)} />
      )}
    </div>
  );
}

type FormState = {
  name: string;
  protocol: ChannelProtocol;
  provider: string;
  tier: ModelTier;
  poolId: string;
  baseUrl: string;
  upstreamKey: string;
  modelsText: string;
  status: ChannelStatus;
  description: string;
  pricingModel: string;
  pricingUnit: PricingUnit;
  pricePerUnit: number;
  contextWindow?: number;
};

function emptyForm(kind: ChannelKind, pools: Pool[]): FormState {
  const proto: ChannelProtocol = kind === 'IMAGE' ? 'OPENAI' : 'OPENAI';
  return {
    name: '',
    protocol: proto,
    provider: 'openai',
    tier: 'FAST',
    poolId: pools[0]?.id ?? '',
    baseUrl: '',
    upstreamKey: '',
    modelsText: '',
    status: 'ENABLED',
    description: '',
    pricingModel: '',
    pricingUnit: kind === 'IMAGE' ? 'PER_IMAGE' : 'PER_TOKEN_INPUT',
    pricePerUnit: 1,
    contextWindow: undefined,
  };
}

function formFromChannel(c: Channel): FormState {
  const models = Array.isArray(c.models) ? c.models : [];
  return {
    name: c.name,
    protocol: c.protocol,
    provider: c.provider,
    tier: c.tier,
    poolId: c.poolId,
    baseUrl: c.baseUrl,
    upstreamKey: '',
    modelsText: models.join('\n'),
    status: c.status,
    description: c.description,
    pricingModel: models[0] ?? '',
    pricingUnit: c.kind === 'IMAGE' ? 'PER_IMAGE' : 'PER_TOKEN_INPUT',
    pricePerUnit: 1,
    contextWindow: undefined,
  };
}

function parseModels(text: string): string[] {
  return Array.from(
    new Set(
      text
        .split(/[\s,，]+/)
        .map((s) => s.trim())
        .filter(Boolean)
    )
  );
}

function ChannelDialog({
  channel,
  kind,
  pools,
  children,
  onRefresh,
}: {
  channel?: Channel;
  kind: ChannelKind;
  pools: Pool[];
  children: React.ReactNode;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(
    channel ? formFromChannel(channel) : emptyForm(kind, pools)
  );
  const [pricingRows, setPricingRows] = useState<ModelPricing[]>([]);
  const [availablePools, setAvailablePools] = useState(pools);
  useEffect(() => {
    if (!open) return;
    let mounted = true;
    void Promise.all([
      api<{ items: Pool[] }>('/api/admin/billing/pools?page=1&pageSize=50'),
      api<{ items: ModelPricing[] }>('/api/admin/billing/pricing?page=1&pageSize=100'),
      channel
        ? api<{ channel: Channel }>(`/api/admin/billing/channels/${channel.id}`)
        : Promise.resolve({ channel: null }),
    ]).then(([poolResult, pricingResult, detailResult]) => {
      if (!mounted) return;
      setAvailablePools(poolResult.items);
      setPricingRows(pricingResult.items);
      setForm(
        detailResult.channel
          ? formFromChannel(detailResult.channel)
          : emptyForm(kind, poolResult.items)
      );
    });
    return () => {
      mounted = false;
    };
  }, [open, channel, kind]);
  const patch = (n: Partial<FormState>) => setForm((f) => ({ ...f, ...n }));
  const modelOptions = parseModels(form.modelsText);

  useEffect(() => {
    if (!open || form.pricingModel || modelOptions.length === 0) return;
    patch({ pricingModel: modelOptions[0] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, modelOptions.join('\n')]);

  useEffect(() => {
    if (!open || !form.pricingModel) return;
    const existing = pricingRows.find(
      (p) =>
        p.capability === (kind === 'CHAT' ? 'chat' : 'image') &&
        p.model === form.pricingModel &&
        (p.tier ?? null) === form.tier
    );
    if (existing) {
      patch({
        pricingUnit: existing.unit,
        // 后端以整数分存储；表单展示「灵石」，故 ÷100。
        pricePerUnit: existing.pricePerUnit / 100,
        contextWindow: existing.contextWindow ?? undefined,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pricingRows, form.pricingModel, form.tier, kind]);

  async function submit() {
    if (!form.name.trim()) return toast.error('输入名称');
    if (!form.poolId) return toast.error('请先创建资源池');
    if (!form.baseUrl.trim()) return toast.error('输入上游基址');
    const body: Record<string, unknown> = {
      name: form.name.trim(),
      kind,
      tier: form.tier,
      protocol: form.protocol,
      provider: form.provider,
      poolId: form.poolId,
      baseUrl: form.baseUrl.trim(),
      models: parseModels(form.modelsText),
      status: form.status,
      description: form.description,
    };
    if (form.upstreamKey.trim()) body.upstreamKey = form.upstreamKey;
    const ok = channel
      ? await run(
          () =>
            api(`/api/admin/billing/channels/${channel.id}`, { method: 'PATCH', body }).then(
              onRefresh
            ),
          '渠道已更新'
        )
      : await run(
          () =>
            api('/api/admin/billing/channels', {
              method: 'POST',
              body: { ...body, upstreamKey: form.upstreamKey },
            }).then(onRefresh),
          '渠道已创建'
        );
    if (!ok) return;
    if (form.pricingModel.trim()) await savePricing(false);
    setOpen(false);
  }

  async function savePricing(showToast = true) {
    const model = form.pricingModel.trim();
    if (!model) {
      if (showToast) toast.error('请选择要定价的模型');
      return false;
    }
    const body = {
      capability: kind === 'CHAT' ? 'chat' : 'image',
      model,
      label: model,
      unit: form.pricingUnit,
      // 表单输入为「灵石」，提交时 ×100 转整数分（后端单位）。
      pricePerUnit: Math.round(form.pricePerUnit * 100),
      contextWindow: form.contextWindow,
      tier: form.tier,
      enabled: true,
    };
    const existing = pricingRows.find(
      (p) => p.capability === body.capability && p.model === model && (p.tier ?? null) === form.tier
    );
    const ok = existing
      ? await run(
          () =>
            api(`/api/admin/billing/pricing/${existing.id}`, { method: 'PATCH', body }).then(
              async () => {
                const r = await api<{ items: ModelPricing[] }>(
                  '/api/admin/billing/pricing?page=1&pageSize=100'
                );
                setPricingRows(r.items);
              }
            ),
          showToast ? '价格已保存' : '模型接入与价格已保存'
        )
      : await run(
          () =>
            api('/api/admin/billing/pricing', { method: 'POST', body }).then(async () => {
              const r = await api<{ items: ModelPricing[] }>(
                '/api/admin/billing/pricing?page=1&pageSize=100'
              );
              setPricingRows(r.items);
            }),
          showToast ? '价格已保存' : '模型接入与价格已保存'
        );
    return ok;
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {channel ? '编辑渠道' : `新增${kind === 'CHAT' ? '聊天' : '生图'}渠道`}
          </DialogTitle>
          <DialogDescription>
            {kind === 'CHAT'
              ? '聊天模型服务 /chat/completions、/messages'
              : '生图模型服务 /images/generations、/images/edits（仅 OpenAI 协议）'}
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="access" className="space-y-4">
          <TabsList>
            <TabsTrigger value="access">接入配置</TabsTrigger>
            <TabsTrigger value="pricing">价格配置</TabsTrigger>
          </TabsList>
          <TabsContent value="access" className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>名称</Label>
                <Input value={form.name} onChange={(e) => patch({ name: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label>版本</Label>
                <Select value={form.tier} onValueChange={(v) => patch({ tier: v as ModelTier })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="FAST">快速</SelectItem>
                    <SelectItem value="PREMIUM">高级</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>所属资源池</Label>
                <Select value={form.poolId} onValueChange={(v) => patch({ poolId: v })}>
                  <SelectTrigger>
                    <SelectValue placeholder="选池" />
                  </SelectTrigger>
                  <SelectContent>
                    {availablePools.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                        {p.scope === 'SHARED' ? '（共享）' : `（${p.team?.name ?? '单团队'}）`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>协议</Label>
                <Select
                  value={form.protocol}
                  onValueChange={(v) => patch({ protocol: v as ChannelProtocol })}
                  disabled={kind === 'IMAGE'}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="OPENAI">OpenAI</SelectItem>
                    <SelectItem value="ANTHROPIC" disabled={kind === 'IMAGE'}>
                      Anthropic
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>提供方</Label>
                <Select value={form.provider} onValueChange={(v) => patch({ provider: v })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PROVIDER_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>上游基址</Label>
                <Input
                  value={form.baseUrl}
                  onChange={(e) => patch({ baseUrl: e.target.value })}
                  placeholder="https://api.openai.com/v1"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>上游 API Key</Label>
              <Input
                type="password"
                value={form.upstreamKey}
                onChange={(e) => patch({ upstreamKey: e.target.value })}
                placeholder={channel ? '（不改则保留原 key）' : 'sk-...'}
              />
            </div>
            <div className="space-y-2">
              <Label>可调用模型（轮询；从预设勾选或手输，一行一个）</Label>
              {(() => {
                const presets = getPresetModels(form.provider, kind);
                const current = parseModels(form.modelsText);
                return (
                  presets.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {presets.map((m) => {
                        const checked = current.includes(m.id);
                        return (
                          <button
                            key={m.id}
                            type="button"
                            onClick={() => {
                              const next = checked
                                ? current.filter((x) => x !== m.id)
                                : [...current, m.id];
                              patch({ modelsText: next.join('\n'), pricingModel: next[0] ?? '' });
                            }}
                            className={`rounded-md border px-2 py-0.5 text-xs transition-colors ${checked ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted'}`}
                            title={`${m.label} · ${m.contextWindow ? m.contextWindow / 1000 + 'K' : '生图'}${m.supportsReasoning ? ' · 支持思考' : ''}`}
                          >
                            {m.id}
                            {m.supportsReasoning && ' 思考'}
                          </button>
                        );
                      })}
                    </div>
                  )
                );
              })()}
              <Textarea
                value={form.modelsText}
                onChange={(e) => patch({ modelsText: e.target.value })}
                placeholder={'gpt-4o\ngpt-4o-mini'}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>状态</Label>
                <Select
                  value={form.status}
                  onValueChange={(v) => patch({ status: v as ChannelStatus })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ENABLED">已启用</SelectItem>
                    <SelectItem value="DISABLED">已禁用</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>说明</Label>
                <Input
                  value={form.description}
                  onChange={(e) => patch({ description: e.target.value })}
                />
              </div>
            </div>
          </TabsContent>
          <TabsContent value="pricing" className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>模型</Label>
                <Select
                  value={form.pricingModel}
                  onValueChange={(v) => patch({ pricingModel: v })}
                  disabled={modelOptions.length === 0}
                >
                  <SelectTrigger>
                    <SelectValue
                      placeholder={modelOptions.length ? '选择模型' : '先填写可调用模型'}
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
              </div>
              <div className="space-y-2">
                <Label>计费单位</Label>
                <Select
                  value={form.pricingUnit}
                  onValueChange={(v) => patch({ pricingUnit: v as PricingUnit })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PER_TOKEN_INPUT">每1M输入token</SelectItem>
                    <SelectItem value="PER_TOKEN_OUTPUT">每1M输出token</SelectItem>
                    <SelectItem value="PER_CALL">每次</SelectItem>
                    <SelectItem value="PER_IMAGE">每张</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>单价（灵石）</Label>
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={form.pricePerUnit}
                  onChange={(e) => patch({ pricePerUnit: Number(e.target.value) || 0 })}
                />
              </div>
              <div className="space-y-2">
                <Label>上下文窗口（token，可选）</Label>
                <Input
                  type="number"
                  min={0}
                  value={form.contextWindow ?? ''}
                  onChange={(e) =>
                    patch({ contextWindow: e.target.value ? Number(e.target.value) : undefined })
                  }
                />
              </div>
            </div>
            <div className="flex justify-end">
              <Button
                variant="outline"
                onClick={() => {
                  void savePricing(true);
                }}
              >
                仅保存价格
              </Button>
            </div>
          </TabsContent>
        </Tabs>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button onClick={submit}>{channel ? '保存' : '创建'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
