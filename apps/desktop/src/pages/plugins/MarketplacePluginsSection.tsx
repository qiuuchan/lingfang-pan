import {
  ArrowLeftIcon,
  DownloadIcon,
  PackageSearchIcon,
  ShoppingCartIcon,
  StarIcon,
} from 'lucide-react';
import { useApp } from '@/App';
import { fmtYuan } from '@/lib/money';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { LoadingButton } from '@/components/loading-button';
import { Pagination } from '@/components/pagination';
import { Stars } from '@/components/stars';
import { Shimmer } from '@/lib/motion';
import { CATEGORY_TABS, categorizePlugin, categoryLabel } from '@/lib/marketplace-categories';
import { useMarketplaceDetail } from './use-marketplace-detail';
import { useMarketplaceCatalog } from './use-marketplace-catalog';
import { PluginIcon } from '@/components/plugins/author-actions';

const PAGE_SIZE = 6;

export interface MarketPlugin {
  id: string;
  name: string;
  description?: string;
  version?: string;
  icon?: string;
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

export function MarketplacePluginsSection({ active }: { active: boolean }) {
  const catalog = useMarketplaceCatalog(active);
  if (catalog.detail) {
    return <MarketplaceDetail plugin={catalog.detail} onBack={() => catalog.setDetail(null)} onReload={catalog.setDetail} />;
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold tracking-tight">市场插件</h2>
          <span className="text-xs text-muted-foreground">{catalog.total} 个</span>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Input placeholder="搜索插件名称或描述…" value={catalog.q} onChange={(e) => catalog.setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && catalog.search()} />
        <Select value={catalog.sort} onValueChange={(value) => catalog.setSort(value ?? 'installs')}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>{SORTS.map((item) => <SelectItem key={item.v} value={item.v}>{item.label}</SelectItem>)}</SelectContent>
        </Select>
        <Button onClick={catalog.search}>搜索</Button>
      </div>
      {/* Task 1：自动分类标签行。点击切换 category，客户端过滤已拉取列表。 */}
      <div className="flex flex-wrap items-center gap-1.5">
        {CATEGORY_TABS.map((tab) => {
          const active = catalog.category === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => catalog.setCategory(tab.key)}
              className={
                'rounded-full border px-3 py-1 text-xs transition-colors ' +
                (active
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground')
              }
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {catalog.plugins === null ? (
        <ListSkeleton />
      ) : catalog.total ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col divide-y rounded-lg border">
            {catalog.pageItems.map((plugin) => (
              <MarketplaceRow key={plugin.id} plugin={plugin} onOpen={() => { void catalog.openDetail(plugin.id); }} />
            ))}
          </div>
          <Pagination page={catalog.page} totalPages={catalog.totalPages} onChange={catalog.setPage} />
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
          <PackageSearchIcon className="size-8 text-muted-foreground/50" />
          <span>没有找到匹配的插件</span>
          <span className="text-xs">试试调整关键词，或切换排序方式重新搜索。</span>
        </div>
      )}
    </section>
  );
}

function MarketplaceRow({ plugin, onOpen }: { plugin: MarketPlugin; onOpen: () => void }) {
  // Task 1：展示自动分类标签（让「自动分类」结果可见，便于用户理解归类依据）。
  const catLabel = categoryLabel(categorizePlugin(plugin));
  return (
    <Button variant="ghost" className="flex h-auto w-full items-center justify-between gap-4 rounded-none px-4 py-3.5 text-left" onClick={onOpen}>
      <PluginIcon icon={plugin.icon} className="size-10 shrink-0 rounded-lg object-cover" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium">{plugin.name}</span>
          <Badge variant="outline" className="shrink-0 text-[10px] font-normal text-muted-foreground">{catLabel}</Badge>
          <Badge variant={plugin.is_free ? 'secondary' : 'default'} className="shrink-0">{fmtYuan(plugin.price_cents)}</Badge>
        </div>
        <div className="mt-0.5 line-clamp-1 text-sm text-muted-foreground">{plugin.description}</div>
      </div>
      <div className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1"><StarIcon className="size-3 fill-current text-yellow-500" />{plugin.avg_score || '—'} ({plugin.rating_count})</span>
        <span className="inline-flex items-center gap-1"><DownloadIcon className="size-3" />{plugin.install_count}</span>
      </div>
    </Button>
  );
}

function MarketplaceDetail({
  plugin,
  onBack,
  onReload,
}: {
  plugin: MarketPlugin;
  onBack: () => void;
  onReload: (plugin: MarketPlugin) => void;
}) {
  const { openAccountSettings } = useApp();
  const caps = (plugin.capabilities || []).map((cap) => (typeof cap === 'string' ? cap : cap.kind || ''));
  const reviews = plugin.reviews || [];
  const isFree = plugin.is_free ?? (plugin.price_cents ?? 0) === 0;
  const purchased = plugin.purchased ?? isFree;
  const installed = plugin.installed ?? false;
  const canRate = plugin.can_rate ?? (isFree ? installed : purchased);
  const rateHint = isFree ? '安装后即可评分' : '购买后即可评分';
  const detail = useMarketplaceDetail({ openWallet: () => openAccountSettings('team-wallet'), plugin, onReload });

  return (
    <section className="flex flex-col gap-4">
      <Button variant="ghost" size="sm" className="w-fit" onClick={onBack}>
        <ArrowLeftIcon className="size-4" />返回市场
      </Button>
      <MarketplaceOverview caps={caps} detail={detail} isFree={isFree} plugin={plugin} purchased={purchased} />
      <MarketplaceReviews canRate={canRate} detail={detail} rateHint={rateHint} reviews={reviews} />
    </section>
  );
}

function MarketplaceOverview({
  caps,
  detail,
  isFree,
  plugin,
  purchased,
}: {
  caps: string[];
  detail: ReturnType<typeof useMarketplaceDetail>;
  isFree: boolean;
  plugin: MarketPlugin;
  purchased: boolean;
}) {
  return (
    <div className="flex flex-col gap-4 rounded-lg border p-4">
      <MarketplaceTitle isFree={isFree} plugin={plugin} />
      <p className="text-sm">{plugin.description}</p>
      <MarketplaceStats plugin={plugin} />
      {caps.length > 0 && <div className="flex flex-wrap gap-1.5">{caps.map((cap, i) => <Badge key={`${cap}-${i}`} variant="secondary">{cap}</Badge>)}</div>}
      <MarketplacePrimaryAction detail={detail} isFree={isFree} plugin={plugin} purchased={purchased} />
    </div>
  );
}

function MarketplaceTitle({ isFree, plugin }: { isFree: boolean; plugin: MarketPlugin }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <h2 className="text-lg font-semibold tracking-tight">{plugin.name}</h2>
      <span className="text-sm text-muted-foreground">v{plugin.version}</span>
      <Badge variant={isFree ? 'secondary' : 'default'}>{fmtYuan(plugin.price_cents)}</Badge>
    </div>
  );
}

function MarketplaceStats({ plugin }: { plugin: MarketPlugin }) {
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="inline-flex items-center gap-1"><StarIcon className="size-4 fill-current text-yellow-500" />{plugin.avg_score || '—'}</span>
      <span className="inline-flex items-center gap-1 text-muted-foreground"><DownloadIcon className="size-4" />{plugin.install_count} 次安装</span>
    </div>
  );
}

function MarketplacePrimaryAction({
  detail,
  isFree,
  plugin,
  purchased,
}: {
  detail: ReturnType<typeof useMarketplaceDetail>;
  isFree: boolean;
  plugin: MarketPlugin;
  purchased: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      {!isFree && !purchased ? (
        <LoadingButton loading={detail.buying} onClick={detail.buy}><ShoppingCartIcon className="size-4" />购买 {fmtYuan(plugin.price_cents)}</LoadingButton>
      ) : (
        <LoadingButton loading={detail.installing} onClick={detail.install}>安装到本团队</LoadingButton>
      )}
      {!isFree && purchased && <span className="text-sm text-green-600">已购买</span>}
    </div>
  );
}

function MarketplaceReviews({
  canRate,
  detail,
  rateHint,
  reviews,
}: {
  canRate: boolean;
  detail: ReturnType<typeof useMarketplaceDetail>;
  rateHint: string;
  reviews: NonNullable<MarketPlugin['reviews']>;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4">
      <h3 className="text-sm font-semibold">评价</h3>
      <ReviewList reviews={reviews} />
      {canRate ? <RatingForm detail={detail} /> : <p className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">{rateHint}。</p>}
    </div>
  );
}

function ReviewList({ reviews }: { reviews: NonNullable<MarketPlugin['reviews']> }) {
  if (!reviews.length) return <span className="text-sm text-muted-foreground">还没有评价，安装后第一个来打分</span>;
  return reviews.map((review, i) => (
    <div key={i} className="flex items-center gap-2 text-sm">
      <Stars score={review.score} starClassName="size-3.5" />
      <span className="text-muted-foreground">{review.comment}</span>
    </div>
  ));
}

function RatingForm({ detail }: { detail: ReturnType<typeof useMarketplaceDetail> }) {
  return (
    <div className="flex items-center gap-2">
      <Select value={detail.score} onValueChange={(value) => detail.setScore(value ?? '5')}>
        <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
        <SelectContent>{[5, 4, 3, 2, 1].map((n) => <SelectItem key={n} value={String(n)}><Stars score={n} starClassName="size-3" /></SelectItem>)}</SelectContent>
      </Select>
      <Input placeholder="留下评价（可选）" value={detail.comment} onChange={(e) => detail.setComment(e.target.value)} />
      <LoadingButton loading={detail.rating} onClick={detail.rate}>提交评分</LoadingButton>
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
