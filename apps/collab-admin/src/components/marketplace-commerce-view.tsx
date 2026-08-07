import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Section } from '@/components/shared';

type Refund = {
  id: string;
  purchase_id?: string;
  package_name?: string;
  buyer_team_name?: string;
  reason?: string;
  status: string;
  price_cents?: number;
  requested_at?: string;
};
type Settlement = {
  state: { writerMode?: string; writerGeneration?: number } | null;
  job: unknown;
  scheduler_started: boolean;
};
type CampaignReport = {
  campaign: { id: string; name: string; status: string };
  attributed: {
    attributed_order_count: number;
    refunded_order_count: number;
    net_order_count: number;
    net_gross_cents: number;
  };
  items: Array<{ package_name: string; attributed_order_count: number; net_order_count: number }>;
};
type CampaignItemDraft = { packageId: string; rank: number };

export function MarketplaceCommerceView() {
  return (
    <Section title="市场财务与营销" description="处理退款、观察结算任务，并管理市场 Campaign。">
      <Tabs defaultValue="refunds">
        <TabsList>
          <TabsTrigger value="refunds">退款审核</TabsTrigger>
          <TabsTrigger value="settlement">结算控制</TabsTrigger>
          <TabsTrigger value="campaigns">Campaign</TabsTrigger>
        </TabsList>
        <TabsContent value="refunds" className="pt-4">
          <Refunds />
        </TabsContent>
        <TabsContent value="settlement" className="pt-4">
          <SettlementPanel />
        </TabsContent>
        <TabsContent value="campaigns" className="pt-4">
          <Campaigns />
        </TabsContent>
      </Tabs>
    </Section>
  );
}

function Refunds() {
  const [items, setItems] = useState<Refund[]>([]);
  const [selected, setSelected] = useState<Refund | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const load = async () => {
    const result = await api<{ items: Refund[] }>(
      '/api/admin/marketplace/refund-requests?page=1&pageSize=100'
    );
    setItems(result.items);
  };
  useEffect(() => {
    load().catch((e) => toast.error((e as Error).message));
  }, []);
  async function open(id: string) {
    try {
      setSelected(await api<Refund>(`/api/admin/marketplace/refund-requests/${id}`));
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  async function review(action: 'approve' | 'reject') {
    if (!selected) return;
    setBusy(true);
    try {
      await api(`/api/admin/marketplace/refund-requests/${selected.id}/${action}`, {
        method: 'POST',
        body: { reason },
      });
      toast.success(action === 'approve' ? '退款已批准' : '退款已拒绝');
      setSelected(null);
      setReason('');
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
      <div className="divide-y rounded-lg border">
        {items.length === 0 && (
          <div className="p-4 text-sm text-muted-foreground">暂无退款申请</div>
        )}
        {items.map((r) => (
          <button
            key={r.id}
            className="flex w-full items-center justify-between p-3 text-left hover:bg-muted/40"
            onClick={() => open(r.id)}
          >
            <div>
              <div className="font-medium">{r.package_name ?? r.purchase_id ?? r.id}</div>
              <div className="text-xs text-muted-foreground">
                {r.buyer_team_name ?? '未知团队'} · {r.reason ?? '无原因'}
              </div>
            </div>
            <Badge variant={r.status === 'PENDING' ? 'warning' : 'secondary'}>{r.status}</Badge>
          </button>
        ))}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>审核详情</CardTitle>
          <CardDescription>选择左侧申请后批准或拒绝。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {selected ? (
            <>
              <div className="text-sm">{selected.reason ?? '无退款原因'}</div>
              <Textarea
                placeholder="审核意见"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <div className="flex gap-2">
                <Button disabled={busy} onClick={() => review('approve')}>
                  批准退款
                </Button>
                <Button variant="destructive" disabled={busy} onClick={() => review('reject')}>
                  拒绝
                </Button>
              </div>
            </>
          ) : (
            <div className="text-sm text-muted-foreground">尚未选择申请</div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SettlementPanel() {
  const [status, setStatus] = useState<Settlement | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async () =>
    setStatus(await api<Settlement>('/api/admin/marketplace/settlement/cutover/status'));
  useEffect(() => {
    load().catch((e) => toast.error((e as Error).message));
  }, []);
  async function action(path: string, body: unknown = {}) {
    setBusy(true);
    try {
      const result = await api(path, { method: 'POST', body });
      toast.success('操作已完成');
      if (path.endsWith('/reconcile')) toast.info(`对账结果：${JSON.stringify(result)}`);
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const generation = status?.state?.writerGeneration ?? 0;
  const mode = status?.state?.writerMode ?? 'UNKNOWN';
  return (
    <Card>
      <CardHeader>
        <CardTitle>Settlement V2</CardTitle>
        <CardDescription>
          当前 writer mode：{mode} · generation {generation}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <Button
          disabled={busy}
          onClick={() => action('/api/admin/marketplace/settlement/trigger', { limit: 100 })}
        >
          运行结算 Job
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => action('/api/admin/marketplace/settlement/reconcile')}
        >
          运行对账
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() =>
            action('/api/admin/marketplace/settlement/backfill', { dryRun: true, limit: 100 })
          }
        >
          预览 Backfill
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() =>
            action('/api/admin/marketplace/settlement/cutover/drain', {
              expectedGeneration: generation,
            })
          }
        >
          进入 Drain
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() =>
            action('/api/admin/marketplace/settlement/cutover/activate', {
              expectedGeneration: generation,
            })
          }
        >
          激活 V2
        </Button>
        <Button
          variant="destructive"
          disabled={busy}
          onClick={() =>
            action('/api/admin/marketplace/settlement/cutover/pause', {
              expectedGeneration: generation,
              reason: '管理员手动暂停',
            })
          }
        >
          暂停
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() =>
            action('/api/admin/marketplace/settlement/cutover/resume', {
              expectedGeneration: generation,
            })
          }
        >
          恢复
        </Button>
      </CardContent>
    </Card>
  );
}

function Campaigns() {
  const [campaignId, setCampaignId] = useState('');
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [items, setItems] = useState<CampaignItemDraft[]>([{ packageId: '', rank: 0 }]);
  const [report, setReport] = useState<CampaignReport | null>(null);
  const [busy, setBusy] = useState(false);

  const normalizedPackageIds = items.map((item) => item.packageId.trim());
  // 去重判断用 Set 保持 O(n)（indexOf-in-filter 是 O(n²)），上限虽 100 项但顺手消除重复扫描。
  const seenPackageIds = new Set<string>();
  const duplicatePackageIds = new Set(
    normalizedPackageIds.filter((packageId) => {
      if (!packageId) return false;
      if (seenPackageIds.has(packageId)) return true;
      seenPackageIds.add(packageId);
      return false;
    })
  );
  const hasBlankPackage = normalizedPackageIds.some((packageId) => !packageId);
  const hasInvalidRank = items.some(
    (item) => !Number.isInteger(item.rank) || item.rank < 0 || item.rank > 99
  );
  const hasInvalidItems = hasBlankPackage || duplicatePackageIds.size > 0 || hasInvalidRank;

  function updateItem(index: number, patch: Partial<CampaignItemDraft>) {
    setItems((current) =>
      current.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item))
    );
  }

  function addItem() {
    setItems((current) =>
      current.length >= 100
        ? current
        : [...current, { packageId: '', rank: Math.min(current.length, 99) }]
    );
  }

  function removeItem(index: number) {
    setItems((current) =>
      current.length === 1 ? current : current.filter((_, itemIndex) => itemIndex !== index)
    );
  }

  async function create() {
    if (hasInvalidItems) {
      toast.error('请填写有效且不重复的 Package ID，并将排序设为 0–99 的整数');
      return;
    }
    setBusy(true);
    try {
      const now = Date.now();
      const result = await api<{ id: string }>('/api/admin/marketplace/campaigns', {
        method: 'POST',
        body: {
          slug,
          name,
          description: '',
          startsAt: new Date(now).toISOString(),
          endsAt: new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString(),
          items: items.map((item) => ({ packageId: item.packageId.trim(), rank: item.rank })),
        },
      });
      setCampaignId(result.id);
      toast.success('Campaign 已创建');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function act(action: 'publish' | 'cancel') {
    if (!campaignId) return;
    setBusy(true);
    try {
      await api(`/api/admin/marketplace/campaigns/${campaignId}/${action}`, { method: 'POST' });
      toast.success(action === 'publish' ? 'Campaign 已发布' : 'Campaign 已取消');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function loadReport() {
    try {
      setReport(await api<CampaignReport>(`/api/admin/marketplace/campaigns/${campaignId}/report`));
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>创建与发布</CardTitle>
          <CardDescription>按顺序添加多个插件，创建后可直接发布 Campaign。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input placeholder="Slug" value={slug} onChange={(e) => setSlug(e.target.value)} />
          <Input
            placeholder="Campaign 名称"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm font-medium">Campaign 商品</div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy || items.length >= 100}
                onClick={addItem}
              >
                添加商品
              </Button>
            </div>
            {items.map((item, index) => {
              const packageId = normalizedPackageIds[index];
              const duplicate = Boolean(packageId && duplicatePackageIds.has(packageId));
              return (
                <div
                  key={index}
                  className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[minmax(0,1fr)_96px_auto]"
                >
                  <div>
                    <Input
                      aria-label={`商品 ${index + 1} Package ID`}
                      aria-invalid={!packageId || duplicate}
                      placeholder="Package ID"
                      value={item.packageId}
                      onChange={(e) => updateItem(index, { packageId: e.target.value })}
                    />
                    {duplicate ? (
                      <div className="mt-1 text-xs text-destructive">Package ID 不能重复</div>
                    ) : null}
                  </div>
                  <Input
                    aria-label={`商品 ${index + 1} 排序`}
                    aria-invalid={!Number.isInteger(item.rank) || item.rank < 0 || item.rank > 99}
                    type="number"
                    min={0}
                    max={99}
                    step={1}
                    value={item.rank}
                    onChange={(e) => updateItem(index, { rank: Number(e.target.value) })}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy || items.length === 1}
                    onClick={() => removeItem(index)}
                  >
                    删除
                  </Button>
                </div>
              );
            })}
            <div className="text-xs text-muted-foreground">
              排序值范围 0–99；Package ID 不可为空或重复。
            </div>
          </div>
          <Button
            disabled={busy || !slug.trim() || !name.trim() || hasInvalidItems}
            onClick={create}
          >
            创建
          </Button>
          <Input
            placeholder="Campaign ID"
            value={campaignId}
            onChange={(e) => setCampaignId(e.target.value)}
          />
          <div className="flex gap-2">
            <Button disabled={busy || !campaignId} onClick={() => act('publish')}>
              发布
            </Button>
            <Button
              variant="destructive"
              disabled={busy || !campaignId}
              onClick={() => act('cancel')}
            >
              取消
            </Button>
            <Button variant="outline" disabled={!campaignId} onClick={loadReport}>
              报表
            </Button>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>归因报表</CardTitle>
          <CardDescription>仅统计通过有效 Campaign token 冻结归因的订单。</CardDescription>
        </CardHeader>
        <CardContent>
          {report ? (
            <div className="space-y-3">
              <div className="font-medium">
                {report.campaign.name} · {report.campaign.status}
              </div>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div>归因订单 {report.attributed.attributed_order_count}</div>
                <div>退款 {report.attributed.refunded_order_count}</div>
                <div>净订单 {report.attributed.net_order_count}</div>
                <div>净成交 ¥{(report.attributed.net_gross_cents / 100).toFixed(2)}</div>
              </div>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">输入 Campaign ID 后查看报表</div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
