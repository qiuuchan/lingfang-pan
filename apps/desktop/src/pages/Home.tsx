import { useCallback, useEffect, useState } from 'react';
import { SearchIcon, StarIcon } from 'lucide-react';
import { toast } from 'sonner';
import { useApp } from '@/App';
import { api, type ApiError } from '@/lib/api';
import { installMarketplacePluginPackage } from '@/lib/plugin-installation';
import { friendlyMarketplaceError } from './plugins/use-marketplace-detail';
import { marketplaceSearchPath, pluginActionLabel, pluginNeedsPurchase } from '@/lib/home-marketplace';
import type { AccountSettingsTab, SettingsTab } from '@/lib/types';
import type { MarketPlugin } from './plugins/MarketplacePluginsSection';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LoadingButton } from '@/components/loading-button';
import { Shimmer, StaggerContainer, StaggerItem } from '@/lib/motion';

const RECOMMENDED_COUNT = 8;

export function Home() {
  const app = useApp();
  const [query, setQuery] = useState('');
  const [plugins, setPlugins] = useState<MarketPlugin[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [usingId, setUsingId] = useState<string | null>(null);

  const search = useCallback(async (nextQuery: string) => {
    setLoading(true);
    try {
      const data = await api<{ plugins: MarketPlugin[] }>(marketplaceSearchPath(nextQuery));
      setPlugins(data.plugins.slice(0, RECOMMENDED_COUNT));
    } catch (error) {
      toast.error((error as ApiError).message);
      setPlugins([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void search('');
  }, [search]);

  async function usePlugin(plugin: MarketPlugin) {
    setUsingId(plugin.id);
    try {
      await purchaseIfNeeded(plugin);
      const installed = await installMarketplacePluginPackage(plugin.id);
      app.setRunningPlugin(installed);
      app.setView('plugins');
    } catch (error) {
      handleUseError(error as ApiError, app.openAccountSettings);
    } finally {
      setUsingId(null);
    }
  }

  const hasQuery = query.trim().length > 0;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 py-3">
      <form
        className="relative"
        onSubmit={(event) => {
          event.preventDefault();
          void search(query);
        }}
      >
        <SearchIcon className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-muted-foreground" />
        <Input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索插件"
          className="h-14 rounded-xl pl-12 pr-24 text-base"
        />
        <Button type="submit" className="absolute right-2 top-1/2 h-10 -translate-y-1/2 px-4" disabled={loading}>
          搜索
        </Button>
      </form>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h1 className="text-base font-semibold tracking-tight">{hasQuery ? '搜索结果' : '推荐插件'}</h1>
          <Button variant="ghost" size="sm" onClick={() => app.setView('market')}>查看市场</Button>
        </div>
        <PluginResults plugins={plugins} loading={loading} usingId={usingId} onUse={(plugin) => { void usePlugin(plugin); }} />
      </section>
    </div>
  );
}

async function purchaseIfNeeded(plugin: MarketPlugin) {
  if (!pluginNeedsPurchase(plugin)) return;
  await api('/api/wallet/purchase', { method: 'POST', body: { plugin_id: plugin.id } });
}

function handleUseError(
  error: ApiError,
  openAccountSettings: (tab?: AccountSettingsTab, settingsTab?: SettingsTab) => void,
) {
  if (error.code === 'insufficient_balance') {
    toast.error('余额不足', { action: { label: '去钱包', onClick: () => openAccountSettings('wallet') } });
    return;
  }
  toast.error(friendlyMarketplaceError(error));
}

function PluginResults({
  loading,
  plugins,
  usingId,
  onUse,
}: {
  loading: boolean;
  plugins: MarketPlugin[] | null;
  usingId: string | null;
  onUse: (plugin: MarketPlugin) => void;
}) {
  if (loading || plugins === null) return <ResultSkeleton />;
  if (!plugins.length) {
    return (
      <div className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
        没有找到匹配的插件
      </div>
    );
  }
  return (
    <StaggerContainer className="flex flex-col divide-y rounded-lg border" stagger={0.04}>
      {plugins.map((plugin) => (
        <StaggerItem key={plugin.id} whileHover={{ x: 2, transition: { type: 'spring', stiffness: 300, damping: 20 } }}>
          <PluginResultRow plugin={plugin} using={usingId === plugin.id} onUse={onUse} />
        </StaggerItem>
      ))}
    </StaggerContainer>
  );
}

function PluginResultRow({ plugin, using, onUse }: { plugin: MarketPlugin; using: boolean; onUse: (plugin: MarketPlugin) => void }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{plugin.name}</span>
          <Badge variant={pluginNeedsPurchase(plugin) ? 'default' : 'secondary'}>{pluginActionLabel(plugin).replace('购买并使用 ', '')}</Badge>
        </div>
        <p className="mt-0.5 line-clamp-1 text-sm text-muted-foreground">{plugin.description || '作者未填写说明'}</p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <StarIcon className="size-3 fill-current text-yellow-500" />{plugin.avg_score || '—'}
        </span>
        <LoadingButton size="sm" loading={using} onClick={() => onUse(plugin)}>
          {pluginActionLabel(plugin)}
        </LoadingButton>
      </div>
    </div>
  );
}

function ResultSkeleton() {
  return (
    <div className="flex flex-col divide-y rounded-lg border">
      {Array.from({ length: 4 }).map((_, index) => (
        <Shimmer key={index} className="h-[68px] w-full rounded-none" />
      ))}
    </div>
  );
}
