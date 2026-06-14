import { useEffect, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { ArrowLeftIcon, DownloadIcon, StarIcon, ShoppingCartIcon } from 'lucide-react';
import { api, type ApiError } from '@/lib/api';
import { useApp } from '@/App';
import { fmtYuan } from '@/lib/money';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { LoadingButton } from '@/components/loading-button';
import { Pagination } from '@/components/pagination';
import { Stars } from '@/components/stars';

const PAGE_SIZE = 6;

interface MarketPlugin {
  id: string;
  name: string;
  description?: string;
  version?: string;
  avg_score?: number;
  rating_count?: number;
  install_count?: number;
  price_cents?: number;
  is_free?: boolean;
  purchased?: boolean;
  installed?: boolean;
  can_rate?: boolean;
  capabilities?: ({ kind?: string } | string)[];
  reviews?: { score: number; comment?: string }[];
}

const SORTS = [
  { v: 'installs', label: '按安装量' },
  { v: 'rating', label: '按评分' },
  { v: 'recent', label: '最新' },
];

// 购买/安装的错误码 → 友好提示。
function friendlyError(e: ApiError): string {
  if (e.code === 'insufficient_balance') return '余额不足，去「钱包」查看余额';
  if (e.code === 'payment_required') return '该插件为付费插件，请先购买';
  return e.message;
}

export function Market() {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('installs');
  const [plugins, setPlugins] = useState<MarketPlugin[] | null>(null);
  const [detail, setDetail] = useState<MarketPlugin | null>(null);
  const [page, setPage] = useState(1);

  const search = useCallback(async () => {
    try {
      const data = await api<{ plugins: MarketPlugin[] }>(`/api/marketplace/search?q=${encodeURIComponent(q)}&sort=${sort}`);
      setPlugins(data.plugins);
      setPage(1);
    } catch (e) {
      toast.error((e as ApiError).message);
      setPlugins([]);
    }
  }, [q, sort]);

  useEffect(() => { search(); }, [sort]); // eslint-disable-line react-hooks/exhaustive-deps

  if (detail) return <Detail plugin={detail} onBack={() => setDetail(null)} onReload={(p) => setDetail(p)} />;

  const total = plugins?.length ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageItems = (plugins ?? []).slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  async function openDetail(id: string) {
    try { setDetail(await api<MarketPlugin>(`/api/marketplace/plugins/${id}`)); } catch (e) { toast.error((e as ApiError).message); }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>插件市场</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-2">
          <Input placeholder="搜索插件名称或描述…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()} />
          <Select value={sort} onValueChange={(v) => setSort(v ?? 'installs')}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>{SORTS.map((s) => <SelectItem key={s.v} value={s.v}>{s.label}</SelectItem>)}</SelectContent>
          </Select>
          <Button onClick={search}>搜索</Button>
        </div>
        <div className="mt-4 flex flex-col gap-4">
          {plugins === null ? (
            <span className="text-sm text-muted-foreground">加载中…</span>
          ) : total ? (
            <>
              <div className="flex flex-col divide-y rounded-lg border">
                {pageItems.map((p) => (
                  <Button key={p.id} variant="ghost" className="flex h-auto items-center justify-between gap-4 rounded-none px-4 py-3.5 text-left" onClick={() => openDetail(p.id)}>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium">{p.name}</span>
                        <Badge variant={p.is_free ? 'secondary' : 'default'} className="shrink-0">{fmtYuan(p.price_cents)}</Badge>
                      </div>
                      <div className="mt-0.5 line-clamp-1 text-sm text-muted-foreground">{p.description}</div>
                    </div>
                    <div className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1"><StarIcon className="size-3 fill-current text-yellow-500" />{p.avg_score || '—'} ({p.rating_count})</span>
                      <span className="inline-flex items-center gap-1"><DownloadIcon className="size-3" />{p.install_count}</span>
                    </div>
                  </Button>
                ))}
              </div>
              <Pagination page={page} totalPages={totalPages} onChange={setPage} />
            </>
          ) : <span className="text-sm text-muted-foreground">没有找到匹配的插件。</span>}
        </div>
      </CardContent>
    </Card>
  );
}

function Detail({ plugin, onBack, onReload }: { plugin: MarketPlugin; onBack: () => void; onReload: (p: MarketPlugin) => void }) {
  const { setView } = useApp();
  const [installing, setInstalling] = useState(false);
  const [buying, setBuying] = useState(false);
  const [rating, setRating] = useState(false);
  const [score, setScore] = useState('5');
  const [comment, setComment] = useState('');

  const caps = (plugin.capabilities || []).map((c) => (typeof c === 'string' ? c : c.kind || ''));
  const reviews = plugin.reviews || [];
  const isFree = plugin.is_free ?? (plugin.price_cents ?? 0) === 0;
  const purchased = plugin.purchased ?? isFree;
  const installed = plugin.installed ?? false;
  // 可评分：付费看是否购买，免费看是否安装（与后端 rate 前置条件一致）。
  const canRate = plugin.can_rate ?? (isFree ? installed : purchased);
  const rateHint = isFree ? '安装后即可评分' : '购买后即可评分';

  async function reload() {
    onReload(await api<MarketPlugin>(`/api/marketplace/plugins/${plugin.id}`));
  }

  async function buy() {
    setBuying(true);
    try {
      await api('/api/wallet/purchase', { method: 'POST', body: { plugin_id: plugin.id } });
      toast.success('购买成功 ✓');
      await reload();
    } catch (e) {
      const err = e as ApiError;
      if (err.code === 'insufficient_balance') {
        toast.error('余额不足', { action: { label: '去钱包', onClick: () => setView('wallet') } });
      } else {
        toast.error(friendlyError(err));
      }
    }
    finally { setBuying(false); }
  }

  async function install() {
    setInstalling(true);
    try { await api('/api/marketplace/install', { method: 'POST', body: { plugin_id: plugin.id } }); toast.success('已安装 ✓（可在「我的插件」运行）');
      // 修复 DESK-MARKET-01：install 成功后此前不 reload，导致免费插件 detail 对象 installed 仍为旧值 false，
      // canRate（免费依赖 installed）不刷新，用户必须返回市场列表再重新点进详情才能看到评分入口。
      // 与 buy() 行为对齐，install 成功后也 reload detail。
      await reload();
    }
    catch (e) { toast.error(friendlyError(e as ApiError)); }
    finally { setInstalling(false); }
  }

  async function rate() {
    setRating(true);
    try {
      await api('/api/marketplace/rate', { method: 'POST', body: { plugin_id: plugin.id, score: parseInt(score), comment } });
      setComment('');
      await reload();
      toast.success('评分已提交');
    } catch (e) { toast.error((e as ApiError).message); }
    finally { setRating(false); }
  }

  return (
    <Card>
      <CardHeader>
        <Button variant="ghost" size="sm" className="w-fit" onClick={onBack}><ArrowLeftIcon className="size-4" />返回市场</Button>
        <CardTitle className="flex items-center gap-2 pt-2">
          {plugin.name} <span className="text-sm font-normal text-muted-foreground">v{plugin.version}</span>
          <Badge variant={isFree ? 'secondary' : 'default'}>{fmtYuan(plugin.price_cents)}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm">{plugin.description}</p>
        <div className="flex items-center gap-3 text-sm">
          <span className="inline-flex items-center gap-1"><StarIcon className="size-4 fill-current text-yellow-500" />{plugin.avg_score || '—'}</span>
          <span className="inline-flex items-center gap-1 text-muted-foreground"><DownloadIcon className="size-4" />{plugin.install_count} 次安装</span>
        </div>
        {caps.length > 0 && <div className="flex flex-wrap gap-1.5">{caps.map((c, i) => <Badge key={i} variant="secondary">{c}</Badge>)}</div>}

        {/* 付费未购买 → 购买；免费或已购 → 安装 */}
        <div className="flex items-center gap-2">
          {!isFree && !purchased ? (
            <LoadingButton loading={buying} onClick={buy}><ShoppingCartIcon className="size-4" />购买 {fmtYuan(plugin.price_cents)}</LoadingButton>
          ) : (
            <LoadingButton loading={installing} onClick={install}>安装到本团队</LoadingButton>
          )}
          {!isFree && purchased && <span className="text-sm text-green-600">已购买</span>}
        </div>

        <div>
          <h3 className="mb-2 text-sm font-semibold">评价</h3>
          {reviews.length ? reviews.map((r, i) => (
            <div key={i} className="flex items-center gap-2 py-1 text-sm">
              <Stars score={r.score} starClassName="size-3.5" />
              <span className="text-muted-foreground">{r.comment}</span>
            </div>
          )) : <span className="text-sm text-muted-foreground">暂无评价</span>}
        </div>

        {canRate ? (
          <div className="flex items-center gap-2">
            <Select value={score} onValueChange={(v) => setScore(v ?? '5')}>
              <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
              <SelectContent>{[5, 4, 3, 2, 1].map((n) => <SelectItem key={n} value={String(n)}><Stars score={n} starClassName="size-3" /></SelectItem>)}</SelectContent>
            </Select>
            <Input placeholder="留下评价（可选）" value={comment} onChange={(e) => setComment(e.target.value)} />
            <LoadingButton loading={rating} onClick={rate}>提交评分</LoadingButton>
          </div>
        ) : (
          <p className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">{rateHint}。</p>
        )}
      </CardContent>
    </Card>
  );
}
