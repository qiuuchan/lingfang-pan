import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  BoxIcon,
  DownloadIcon,
  HistoryIcon,
  InfoIcon,
  Loader2Icon,
  PackageCheckIcon,
  RefreshCwIcon,
  ShoppingCartIcon,
  StoreIcon,
  Trash2Icon,
  UsersIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { MARKETPLACE_CATEGORY_LABELS } from '@lingfang/contract';
import { pluginSourceText, PluginSourceBadge } from '@/components/plugins/PluginSourceBadge';
import { Markdown } from '@/components/markdown';
import { Pagination } from '@/components/pagination';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { errorMessage } from '@/lib/api';
import { DEFAULT_PAGE_SIZE } from '@/lib/pagination';
import type { LoadedPlugin } from '@/lib/types';
import {
  buyMarketplacePackage,
  downloadRelease,
  getMarketplaceOwnerQuality,
  getPluginPackageDetail,
  getPluginReleaseDetail,
  listInstallations,
  listMarketplaceRegistry,
  listTeamRegistry,
  loadInstalledPlugin,
  submitMarketplaceQualityAppeal,
  uninstallInstallation,
  type Installation,
  type RegistryCatalogItem,
  type RegistryPackage,
  type RegistryOwnerQuality,
  type RegistryRelease,
  type TransferProgress,
} from '@/lib/plugin-registry';
import {
  catalogSourceKinds,
  filterCatalogItems,
  filterInstallations,
  paginateItems,
  type CatalogSourceFilter,
  type InstallationOriginFilter,
} from './plugin-center-list';

export type PluginCenterTab = 'installed' | 'team' | 'market';

/** 详情弹窗的数据源：已安装走 LoadedPlugin+Installation；团队/市场走 RegistryCatalogItem。
 *  两种来源字段不完全对称（已安装 activeRelease 无 sizeBytes/createdAt/sourceKind），弹窗按可用字段渲染。 */
type DetailTarget =
  | { kind: 'installed'; plugin: LoadedPlugin; installation: Installation }
  | { kind: 'catalog'; item: RegistryCatalogItem; marketplace: boolean };

export function PluginCenterBody({
  tab,
  onTabChange,
  onRun,
}: {
  tab: PluginCenterTab;
  onTabChange: (tab: PluginCenterTab) => void;
  onRun: (plugin: LoadedPlugin) => void;
  onCreate: () => void;
  onClose: () => void;
}) {
  const [installations, setInstallations] = useState<Installation[]>([]);
  const [installedPlugins, setInstalledPlugins] = useState<Record<string, LoadedPlugin>>({});
  const [team, setTeam] = useState<RegistryCatalogItem[]>([]);
  const [market, setMarket] = useState<RegistryCatalogItem[]>([]);
  const [localLoading, setLocalLoading] = useState(true);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyKey, setBusyKey] = useState('');
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [uninstallTarget, setUninstallTarget] = useState<Installation | null>(null);
  const [historyPackage, setHistoryPackage] = useState<RegistryPackage | null>(null);
  const [detailTarget, setDetailTarget] = useState<DetailTarget | null>(null);
  const [installedOrigin, setInstalledOrigin] = useState<InstallationOriginFilter>('all');
  const [teamSource, setTeamSource] = useState<CatalogSourceFilter>('all');
  const [marketSource, setMarketSource] = useState<CatalogSourceFilter>('all');
  const [installedPage, setInstalledPage] = useState(1);
  const [teamPage, setTeamPage] = useState(1);
  const [marketPage, setMarketPage] = useState(1);
  const [installedPageSize, setInstalledPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [teamPageSize, setTeamPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [marketPageSize, setMarketPageSize] = useState(DEFAULT_PAGE_SIZE);

  const reload = useCallback(async () => {
    setLocalLoading(true);
    setCatalogLoading(true);
    setError('');
    const errors: string[] = [];
    try {
      const nextInstallations = await listInstallations();
      setInstallations(nextInstallations);
      const loaded = await Promise.all(
        nextInstallations.map(async (installation) => {
          try {
            return [
              installation.installationId,
              await loadInstalledPlugin(installation.installationId),
            ] as const;
          } catch {
            return null;
          }
        })
      );
      setInstalledPlugins(
        Object.fromEntries(
          loaded.filter((item): item is readonly [string, LoadedPlugin] => Boolean(item))
        )
      );
    } catch (caught) {
      errors.push(errorMessage(caught, '本机安装项加载失败'));
    } finally {
      setLocalLoading(false);
    }
    try {
      const [nextTeam, nextMarket] = await Promise.all([
        listTeamRegistry(),
        listMarketplaceRegistry(),
      ]);
      setTeam(nextTeam);
      setMarket(nextMarket);
    } catch (caught) {
      errors.push(errorMessage(caught, '远端插件目录加载失败'));
    } finally {
      setCatalogLoading(false);
      setError(errors.join('；'));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const byPackage = useMemo(
    () => new Map(installations.map((item) => [item.packageId, item])),
    [installations]
  );
  const teamSources = useMemo(() => catalogSourceKinds(team), [team]);
  const marketSources = useMemo(() => catalogSourceKinds(market), [market]);
  const installedResult = useMemo(
    () =>
      paginateItems(
        filterInstallations(installations, installedOrigin),
        installedPage,
        installedPageSize
      ),
    [installations, installedOrigin, installedPage, installedPageSize]
  );
  const teamResult = useMemo(
    () => paginateItems(filterCatalogItems(team, teamSource), teamPage, teamPageSize),
    [team, teamSource, teamPage, teamPageSize]
  );
  const marketResult = useMemo(
    () => paginateItems(filterCatalogItems(market, marketSource), marketPage, marketPageSize),
    [market, marketSource, marketPage, marketPageSize]
  );

  useEffect(() => {
    if (teamSource !== 'all' && !teamSources.includes(teamSource)) {
      setTeamSource('all');
      setTeamPage(1);
    }
  }, [teamSource, teamSources]);

  useEffect(() => {
    if (marketSource !== 'all' && !marketSources.includes(marketSource)) {
      setMarketSource('all');
      setMarketPage(1);
    }
  }, [marketSource, marketSources]);

  const installCatalogItem = async (item: RegistryCatalogItem, origin: 'team' | 'marketplace') => {
    setBusyKey(item.latestRelease.id);
    setProgress(null);
    try {
      await downloadRelease(item, origin, setProgress);
      toast.success(`已下载「${item.package.name}」v${item.latestRelease.version}`);
      await reload();
    } catch (caught) {
      toast.error(errorMessage(caught, '下载失败'));
    } finally {
      setBusyKey('');
      setProgress(null);
    }
  };

  const buyAndDownload = async (item: RegistryCatalogItem) => {
    setBusyKey(item.package.id);
    try {
      if (!item.entitled && (item.priceCents || 0) > 0) {
        if (!item.priceVersion) throw new Error('市场价格信息已过期，请刷新后重试');
        await buyMarketplacePackage(item.package.id, item.priceVersion);
      }
      await installCatalogItem(item, 'marketplace');
    } catch (caught) {
      toast.error(errorMessage(caught, '购买失败'));
      setBusyKey('');
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
      <div className="mx-auto max-w-6xl">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold">插件</h1>
            <p className="text-sm text-muted-foreground">本机安装项是唯一运行入口</p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void reload()}
              disabled={localLoading || catalogLoading}
            >
              <RefreshCwIcon className={localLoading || catalogLoading ? 'animate-spin' : ''} />
              刷新
            </Button>
          </div>
        </div>

        {error && (
          <Alert
            variant="destructive"
            className="mb-4 border-destructive/40 bg-destructive/5 text-destructive"
          >
            <AlertDescription className="text-destructive">{error}</AlertDescription>
          </Alert>
        )}
        {progress && <TransferProgressBar progress={progress} />}

        <Tabs
          value={tab}
          onValueChange={(value) => {
            const nextTab = value as PluginCenterTab;
            if (nextTab === 'installed') setInstalledPage(1);
            if (nextTab === 'team') setTeamPage(1);
            if (nextTab === 'market') setMarketPage(1);
            onTabChange(nextTab);
          }}
        >
          <TabsList className="flex w-full max-w-xl">
            <TabsTrigger value="installed">
              <PackageCheckIcon />
              已安装
            </TabsTrigger>
            <TabsTrigger value="team">
              <UsersIcon />
              团队库
            </TabsTrigger>
            <TabsTrigger value="market">
              <StoreIcon />
              插件市场
            </TabsTrigger>
          </TabsList>

          <TabsContent value="installed" className="mt-4">
            <SourceFilter
              value={installedOrigin}
              onChange={(value) => {
                setInstalledOrigin(value as InstallationOriginFilter);
                setInstalledPage(1);
              }}
              options={[
                { value: 'builtin', label: '内置' },
                { value: 'local', label: '本地导入' },
                { value: 'team', label: '团队' },
                { value: 'marketplace', label: '市场' },
              ]}
            />
            <InstalledList
              installations={installedResult.items}
              plugins={installedPlugins}
              loading={localLoading}
              onRun={onRun}
              onDetail={(plugin, installation) =>
                setDetailTarget({ kind: 'installed', plugin, installation })
              }
              onUninstall={setUninstallTarget}
              busyKey={busyKey}
            />
            <Pagination
              page={installedResult.currentPage}
              totalPages={installedResult.totalPages}
              total={installedResult.total}
              pageSize={installedPageSize}
              onChange={setInstalledPage}
              onPageSizeChange={(size) => {
                setInstalledPageSize(size);
                setInstalledPage(1);
              }}
            />
          </TabsContent>

          <TabsContent value="team" className="mt-4">
            <SourceFilter
              value={teamSource}
              onChange={(value) => {
                setTeamSource(value as CatalogSourceFilter);
                setTeamPage(1);
              }}
              options={teamSources.map((source) => ({
                value: source,
                label: pluginSourceText(source),
              }))}
            />
            <CatalogList
              items={teamResult.items}
              loading={catalogLoading}
              installed={byPackage}
              busyKey={busyKey}
              onDownload={(item) => void installCatalogItem(item, 'team')}
              onDetail={(item) => setDetailTarget({ kind: 'catalog', item, marketplace: false })}
              onHistory={(item) => setHistoryPackage(item.package)}
            />
            <Pagination
              page={teamResult.currentPage}
              totalPages={teamResult.totalPages}
              total={teamResult.total}
              pageSize={teamPageSize}
              onChange={setTeamPage}
              onPageSizeChange={(size) => {
                setTeamPageSize(size);
                setTeamPage(1);
              }}
            />
          </TabsContent>

          <TabsContent value="market" className="mt-4">
            <SourceFilter
              value={marketSource}
              onChange={(value) => {
                setMarketSource(value as CatalogSourceFilter);
                setMarketPage(1);
              }}
              options={marketSources.map((source) => ({
                value: source,
                label: pluginSourceText(source),
              }))}
            />
            <CatalogList
              items={marketResult.items}
              loading={catalogLoading}
              installed={byPackage}
              busyKey={busyKey}
              marketplace
              onDownload={(item) => void buyAndDownload(item)}
              onDetail={(item) => setDetailTarget({ kind: 'catalog', item, marketplace: true })}
              onHistory={(item) => setHistoryPackage(item.package)}
            />
            <Pagination
              page={marketResult.currentPage}
              totalPages={marketResult.totalPages}
              total={marketResult.total}
              pageSize={marketPageSize}
              onChange={setMarketPage}
              onPageSizeChange={(size) => {
                setMarketPageSize(size);
                setMarketPage(1);
              }}
            />
          </TabsContent>
        </Tabs>
      </div>

      <Dialog
        open={Boolean(uninstallTarget)}
        onOpenChange={(open) => !open && setUninstallTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>彻底卸载插件？</DialogTitle>
            <DialogDescription>
              将删除插件代码、运行环境和全部插件数据。此操作不可撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUninstallTarget(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                if (!uninstallTarget) return;
                setBusyKey(uninstallTarget.installationId);
                try {
                  await uninstallInstallation(uninstallTarget.installationId);
                  toast.success('插件已卸载');
                  setUninstallTarget(null);
                  await reload();
                } catch (caught) {
                  toast.error(errorMessage(caught, '卸载失败'));
                } finally {
                  setBusyKey('');
                }
              }}
            >
              <Trash2Icon />
              确认卸载
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PackageHistoryDialog packageInfo={historyPackage} onClose={() => setHistoryPackage(null)} />
      <PluginDetailDialog
        target={detailTarget}
        onClose={() => setDetailTarget(null)}
        onRun={onRun}
      />
    </div>
  );
}

function SourceFilter({
  value,
  options,
  onChange,
}: {
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <div className="mb-3 flex justify-end">
      <Select value={value} onValueChange={(next) => next && onChange(next)}>
        <SelectTrigger className="w-44" aria-label="筛选插件来源">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">全部来源</SelectItem>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function InstalledList({
  installations,
  plugins,
  loading,
  onRun,
  onDetail,
  onUninstall,
  busyKey,
}: {
  installations: Installation[];
  plugins: Record<string, LoadedPlugin>;
  loading: boolean;
  onRun: (plugin: LoadedPlugin) => void;
  onDetail: (plugin: LoadedPlugin, installation: Installation) => void;
  onUninstall: (installation: Installation) => void;
  busyKey: string;
}) {
  if (loading) return <ListLoading />;
  if (!installations.length) return <EmptyState icon={BoxIcon} text="本机还没有安装插件" />;
  return (
    <div className="divide-y rounded-lg border">
      {installations.map((installation) => {
        const plugin = plugins[installation.installationId];
        const busy = busyKey === installation.installationId;
        return (
          <div
            key={installation.installationId}
            className="flex min-h-20 items-center gap-4 px-4 py-3"
          >
            <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
              <BoxIcon className="size-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate font-medium">
                  {plugin?.name || installation.packageId}
                </span>
                <SourceBadge origin={installation.origin} />
                {installation.protected && <Badge variant="outline">受保护</Badge>}
              </div>
              <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                <span>活动版本 v{installation.activeRelease.version}</span>
                <span>依赖 {dependencyLabel(installation.activeRelease.dependencyStatus)}</span>
                {installation.pendingRelease && (
                  <span className="text-warning">
                    待激活 v{installation.pendingRelease.version}
                  </span>
                )}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button size="sm" disabled={!plugin || busy} onClick={() => plugin && onRun(plugin)}>
                运行
              </Button>
              <Button
                variant="outline"
                size="icon-sm"
                title="插件详情"
                disabled={!plugin || busy}
                onClick={() => plugin && onDetail(plugin, installation)}
              >
                <InfoIcon />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                title={installation.protected ? '内置插件不可卸载' : '卸载'}
                disabled={installation.protected || busy}
                onClick={() => onUninstall(installation)}
              >
                {busy ? <Loader2Icon className="animate-spin" /> : <Trash2Icon />}
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CatalogList({
  items,
  installed,
  loading,
  busyKey,
  marketplace,
  onDownload,
  onDetail,
  onHistory,
}: {
  items: RegistryCatalogItem[];
  installed: Map<string, Installation>;
  loading: boolean;
  busyKey: string;
  marketplace?: boolean;
  onDownload: (item: RegistryCatalogItem) => void;
  onDetail: (item: RegistryCatalogItem) => void;
  onHistory: (item: RegistryCatalogItem) => void;
}) {
  if (loading) return <ListLoading />;
  if (!items.length)
    return (
      <EmptyState
        icon={marketplace ? StoreIcon : UsersIcon}
        text={marketplace ? '市场暂无可下载插件' : '团队库暂无已发布版本'}
      />
    );
  return (
    <div className="divide-y rounded-lg border">
      {items.map((item) => {
        const local = installed.get(item.package.id);
        const downloaded =
          local?.activeRelease.releaseId === item.latestRelease.id ||
          local?.pendingRelease?.releaseId === item.latestRelease.id;
        const busy = busyKey === item.latestRelease.id || busyKey === item.package.id;
        const needsPurchase = marketplace && !item.entitled && (item.priceCents || 0) > 0;
        return (
          <div key={item.package.id} className="flex min-h-20 items-center gap-4 px-4 py-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
              {marketplace ? <StoreIcon className="size-4" /> : <UsersIcon className="size-4" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate font-medium">{item.package.name}</span>
                <Badge variant="outline">v{item.latestRelease.version}</Badge>
                <PluginSourceBadge
                  sourceKind={item.latestRelease.sourceKind}
                  sourceLabel={item.latestRelease.sourceLabel}
                  ingestChannel={item.latestRelease.ingestChannel}
                />
                {marketplace && (
                  <Badge variant="secondary">
                    {(item.priceCents || 0) === 0
                      ? '免费'
                      : `¥${((item.priceCents || 0) / 100).toFixed(2)}`}
                  </Badge>
                )}
                {marketplace && <QualityTierBadge tier={item.qualityTier} />}
                {marketplace && item.category && (
                  <Badge variant="outline">{MARKETPLACE_CATEGORY_LABELS[item.category]}</Badge>
                )}
              </div>
              <p className="mt-1 line-clamp-1 text-sm text-muted-foreground">
                {item.package.description || '暂无描述'}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                variant="ghost"
                size="icon-sm"
                title="插件详情"
                onClick={() => onDetail(item)}
              >
                <InfoIcon />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                title="版本历史"
                onClick={() => onHistory(item)}
              >
                <HistoryIcon />
              </Button>
              <Button
                size="sm"
                variant={downloaded ? 'secondary' : 'default'}
                disabled={downloaded || busy}
                onClick={() => onDownload(item)}
              >
                {busy ? (
                  <Loader2Icon className="animate-spin" />
                ) : needsPurchase ? (
                  <ShoppingCartIcon />
                ) : local ? (
                  <RefreshCwIcon />
                ) : (
                  <DownloadIcon />
                )}
                {downloaded ? '已下载' : needsPurchase ? '购买并下载' : local ? '更新' : '下载'}
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function QualityTierBadge({ tier }: { tier?: RegistryCatalogItem['qualityTier'] }) {
  const value = tier ?? 'LISTED';
  return (
    <Badge
      variant={value === 'FEATURED' ? 'default' : value === 'QUALITY' ? 'secondary' : 'outline'}
    >
      {{ LISTED: '已上架', QUALITY: '优质', FEATURED: '精选' }[value]}
    </Badge>
  );
}

function TransferProgressBar({ progress }: { progress: TransferProgress }) {
  const percent = progress.total
    ? Math.min(100, Math.round((progress.transferred / progress.total) * 100))
    : null;
  return (
    <div className="mb-4 rounded-lg border bg-muted/20 px-3 py-2">
      <div className="flex items-center justify-between text-xs">
        <span>{progress.message || '正在处理插件制品'}</span>
        <span>{percent == null ? '处理中' : `${percent}%`}</span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full bg-primary transition-[width]"
          style={{ width: percent == null ? '35%' : `${percent}%` }}
        />
      </div>
    </div>
  );
}

function SourceBadge({ origin }: { origin: Installation['origin'] }) {
  return (
    <Badge variant="secondary">
      安装来源：
      {
        {
          builtin: '内置',
          local: '本地导入',
          team: '团队',
          marketplace: '市场',
        }[origin]
      }
    </Badge>
  );
}

function dependencyLabel(status: Installation['activeRelease']['dependencyStatus']) {
  return {
    pending: '待准备',
    preparing: '准备中',
    ready: '已就绪',
    failed: '失败',
  }[status];
}

function ListLoading() {
  return (
    <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
      <Loader2Icon className="mr-2 size-4 animate-spin" />
      正在加载
    </div>
  );
}

function EmptyState({ icon: Icon, text }: { icon: typeof BoxIcon; text: string }) {
  return (
    <div className="flex h-40 flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-sm text-muted-foreground">
      <Icon className="size-5" />
      {text}
    </div>
  );
}

function PackageHistoryDialog({
  packageInfo,
  onClose,
}: {
  packageInfo: RegistryPackage | null;
  onClose: () => void;
}) {
  const [releases, setReleases] = useState<RegistryRelease[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!packageInfo) return;
    setLoading(true);
    void getPluginPackageDetail(packageInfo.id)
      .then((response) => setReleases(response.releases))
      .catch((caught) => toast.error(errorMessage(caught, '版本历史加载失败')))
      .finally(() => setLoading(false));
  }, [packageInfo]);
  return (
    <Dialog open={Boolean(packageInfo)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{packageInfo?.name}版本历史</DialogTitle>
          <DialogDescription>发行版不可覆盖，已撤回版本保留审计记录。</DialogDescription>
        </DialogHeader>
        <div className="max-h-80 divide-y overflow-y-auto rounded-lg border">
          {loading ? (
            <ListLoading />
          ) : (
            releases.map((release) => (
              <div
                key={release.id}
                className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">v{release.version}</span>
                    <PluginSourceBadge
                      sourceKind={release.sourceKind}
                      sourceLabel={release.sourceLabel}
                      ingestChannel={release.ingestChannel}
                    />
                  </div>
                  <div className="mt-1 font-mono text-xs text-muted-foreground">
                    {release.sha256.slice(0, 16)}...
                  </div>
                </div>
                <Badge variant={release.status === 'PUBLISHED' ? 'secondary' : 'outline'}>
                  {release.status === 'PUBLISHED' ? '可下载' : '已撤回'}
                </Badge>
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** 插件详情弹窗：显示插件介绍（description 全文）+ 关键元信息。
 *  两种来源（已安装 / 团队市场）字段不完全对称：
 *  - 已安装 activeRelease 是 LocalPluginReleaseRef（无 sizeBytes/createdAt/sourceKind，有 dependencyStatus）。
 *  - 团队市场 latestRelease 是 PluginReleaseSummary（有 sizeBytes/createdAt/sourceKind/manifest，无 dependencyStatus）。
 *  弹窗按各来源可用字段渲染，缺失字段直接不显示。 */
function PluginDetailDialog({
  target,
  onClose,
  onRun,
}: {
  target: DetailTarget | null;
  onClose: () => void;
  onRun: (plugin: LoadedPlugin) => void;
}) {
  const [remoteReadme, setRemoteReadme] = useState<{
    releaseId: string;
    markdown: string;
  } | null>(null);
  const [readmeLoading, setReadmeLoading] = useState(false);
  const [readmeError, setReadmeError] = useState('');
  const [ownerQuality, setOwnerQuality] = useState<RegistryOwnerQuality | null>(null);
  const [qualityLoading, setQualityLoading] = useState(false);
  useEffect(() => {
    if (!target || target.kind !== 'catalog') {
      setRemoteReadme(null);
      setReadmeError('');
      return;
    }
    let active = true;
    setReadmeLoading(true);
    setReadmeError('');
    void getPluginReleaseDetail(target.item.latestRelease.id)
      .then(({ release }) => {
        if (!active) return;
        setRemoteReadme({
          releaseId: release.id,
          markdown: release.readme_markdown || '',
        });
      })
      .catch((caught) => active && setReadmeError(errorMessage(caught, '插件详情加载失败')))
      .finally(() => active && setReadmeLoading(false));
    return () => {
      active = false;
    };
  }, [target]);

  useEffect(() => {
    if (!target || target.kind !== 'catalog' || target.marketplace) {
      setOwnerQuality(null);
      setQualityLoading(false);
      return;
    }
    let active = true;
    setQualityLoading(true);
    void getMarketplaceOwnerQuality(target.item.package.id)
      .then((value) => active && setOwnerQuality(value))
      .catch((caught) => active && toast.error(errorMessage(caught, '质量快照加载失败')))
      .finally(() => active && setQualityLoading(false));
    return () => {
      active = false;
    };
  }, [target]);

  // 字段抽取：把两种来源统一成 { name, description, version, runtimeType, origin, meta } 便于渲染。
  const view = useMemo(() => {
    if (!target) return null;
    if (target.kind === 'installed') {
      const { plugin, installation } = target;
      const release = installation.activeRelease;
      return {
        name: plugin.name,
        description: plugin.description,
        readmeMarkdown: plugin.readmeMarkdown,
        version: release.version,
        runtimeType: plugin.runtime_type,
        origin: <SourceBadge origin={installation.origin} />,
        meta: {
          依赖: dependencyLabel(release.dependencyStatus),
          ...(installation.protected ? { 受保护: '是' } : {}),
          ...(release.sha256 ? { 指纹: `${release.sha256.slice(0, 16)}...` } : {}),
        } as Record<string, string>,
        onRunPlugin: plugin,
      };
    }
    const { item, marketplace } = target;
    const release = item.latestRelease;
    const priceCents = item.priceCents ?? 0;
    return {
      name: item.package.name,
      description: item.package.description,
      readmeMarkdown: remoteReadme?.releaseId === release.id ? remoteReadme.markdown : '',
      version: release.version,
      runtimeType: release.manifest?.runtime_type,
      origin: (
        <PluginSourceBadge
          sourceKind={release.sourceKind}
          sourceLabel={release.sourceLabel}
          ingestChannel={release.ingestChannel}
        />
      ),
      meta: {
        ...(marketplace
          ? {
              价格: priceCents === 0 ? '免费' : `¥${(priceCents / 100).toFixed(2)}`,
            }
          : {}),
        ...(release.sizeBytes ? { 大小: formatBytes(release.sizeBytes) } : {}),
        ...(release.sha256 ? { 指纹: `${release.sha256.slice(0, 16)}...` } : {}),
        ...(item.package.updatedAt ? { 更新时间: formatDate(item.package.updatedAt) } : {}),
      } as Record<string, string>,
      onRunPlugin: null as LoadedPlugin | null,
    };
  }, [remoteReadme, target]);

  return (
    <Dialog open={Boolean(target)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex h-[85vh] max-h-[85vh] w-[94vw] max-w-5xl flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl">
        <DialogHeader className="border-b px-6 py-5">
          <div className="flex flex-wrap items-center gap-2">
            <DialogTitle className="text-xl">{view?.name ?? '插件详情'}</DialogTitle>
            {view && <Badge variant="secondary">v{view.version}</Badge>}
            {view?.origin}
          </div>
          <DialogDescription>
            {view?.description?.trim() || '查看插件功能、权限与版本信息。'}
          </DialogDescription>
        </DialogHeader>
        {view && (
          <div className="grid min-h-0 flex-1 md:grid-cols-[minmax(0,1fr)_16rem]">
            <div className="min-h-0 overflow-y-auto px-6 py-5">
              <div className="mb-4 text-sm font-semibold">详情</div>
              {readmeLoading && target?.kind === 'catalog' ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2Icon className="size-4 animate-spin" />
                  正在加载插件说明…
                </div>
              ) : readmeError ? (
                <Alert
                  variant="destructive"
                  className="border-destructive/30 bg-destructive/5 text-destructive"
                >
                  <AlertDescription className="text-destructive">{readmeError}</AlertDescription>
                </Alert>
              ) : view.readmeMarkdown?.trim() ? (
                <Markdown pluginReadme>{view.readmeMarkdown}</Markdown>
              ) : (
                <p className="whitespace-pre-wrap break-words text-sm">
                  {view.description?.trim() || (
                    <span className="text-muted-foreground">暂无描述</span>
                  )}
                </p>
              )}
              {target?.kind === 'catalog' && !target.marketplace && (
                <div className="mt-6 border-t pt-5">
                  {qualityLoading ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2Icon className="size-4 animate-spin" />
                      正在加载质量快照…
                    </div>
                  ) : ownerQuality ? (
                    <DesktopOwnerQuality
                      quality={ownerQuality}
                      onSubmitted={() =>
                        getMarketplaceOwnerQuality(target.item.package.id).then(setOwnerQuality)
                      }
                    />
                  ) : (
                    <p className="text-sm text-muted-foreground">该插件尚无可用的作者质量投影。</p>
                  )}
                </div>
              )}
            </div>
            <aside className="overflow-y-auto border-t bg-muted/20 p-5 md:border-l md:border-t-0">
              <div className="mb-3 text-sm font-semibold">更多信息</div>
              <div className="divide-y rounded-lg border bg-background">
                <DetailRow label="版本">{view.version}</DetailRow>
                {view.runtimeType && (
                  <DetailRow label="运行时">{runtimeTypeLabel(view.runtimeType)}</DetailRow>
                )}
                <DetailRow label="来源">{view.origin}</DetailRow>
                {Object.entries(view.meta).map(([label, value]) => (
                  <DetailRow key={label} label={label}>
                    {value}
                  </DetailRow>
                ))}
              </div>
            </aside>
          </div>
        )}
        <DialogFooter className="border-t px-6 py-4">
          {view?.onRunPlugin && (
            <Button
              variant="default"
              onClick={() => {
                onClose();
                onRun(view.onRunPlugin!);
              }}
            >
              运行
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const QUALITY_REASON_LABELS: Record<string, string> = {
  hard_gate_failed: '当前上架、审核或安全门禁未通过',
  listing_age_insufficient: '连续上架时间不足',
  release_age_insufficient: '当前发行版观察时间不足',
  insufficient_active_teams: '近 30 天活跃团队不足',
  insufficient_observed_runs: '近 30 天可观测运行样本不足',
  failure_rate_high: '插件归因失败率过高',
  insufficient_rating_teams: '合格评分团队不足',
  average_rating_low: '平均评分未达标',
  refund_data_unavailable: '退款数据暂不可用',
  insufficient_matured_paid_orders: '成熟付费订单样本不足',
  refund_rate_high: '获批退款率过高',
  security_blocked: '存在未解决的安全问题',
  anomaly_review_required: '指标异常，等待人工复核',
  quality_blocked: '平台已暂停自动晋级',
};

function DesktopOwnerQuality({
  quality,
  onSubmitted,
}: {
  quality: RegistryOwnerQuality;
  onSubmitted: () => Promise<unknown>;
}) {
  const [appeal, setAppeal] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const snapshot = quality.snapshot;
  const metrics = snapshot?.metrics;
  return (
    <section className="flex flex-col gap-4">
      <div>
        <h3 className="font-semibold">作者质量视图</h3>
        <p className="text-xs text-muted-foreground">
          等级 {{ LISTED: '已上架', QUALITY: '优质', FEATURED: '精选' }[quality.tier]}
          {snapshot ? ` · 计算于 ${new Date(snapshot.computed_at).toLocaleString()}` : ''}
        </p>
      </div>
      {!snapshot ? (
        <p className="text-sm text-muted-foreground">尚无质量快照。</p>
      ) : (
        <>
          <div className="grid gap-2 text-sm sm:grid-cols-2">
            <QualityMetric label="连续上架" value={`${metrics!.listing_age_days} 天`} />
            <QualityMetric label="发行版观察" value={`${metrics!.current_release_age_days} 天`} />
            <QualityMetric label="30 天活跃团队" value={metrics!.active_teams_30d} />
            <QualityMetric
              label="30 天运行 / 失败"
              value={`${metrics!.observed_runs_30d} / ${metrics!.failed_runs_30d}`}
            />
            <QualityMetric label="失败率" value={qualityPercent(metrics!.failure_rate_bps)} />
            <QualityMetric
              label="评分团队 / 平均分"
              value={`${metrics!.rating_teams} / ${metrics!.average_rating_tenths == null ? '数据不足' : (metrics!.average_rating_tenths / 10).toFixed(1)}`}
            />
            <QualityMetric
              label="90 天成熟订单 / 退款"
              value={`${metrics!.matured_paid_orders_90d} / ${metrics!.approved_refunds_90d}`}
            />
            <QualityMetric
              label="退款率"
              value={
                metrics!.refund_metric_state === 'NOT_APPLICABLE'
                  ? '不适用'
                  : qualityPercent(metrics!.refund_rate_bps)
              }
            />
          </div>
          <div>
            <div className="text-sm font-medium">未达标原因</div>
            {snapshot.reasons.length ? (
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                {snapshot.reasons.map((reason) => (
                  <li key={reason.code}>
                    {QUALITY_REASON_LABELS[reason.code] ?? reason.code}
                    {reason.actual == null
                      ? ''
                      : `（${reason.actual}${reason.threshold == null ? '' : ` / ${reason.threshold}`}）`}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">当前快照已满足自动优质规则。</p>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <Textarea
              rows={4}
              maxLength={10000}
              value={appeal}
              onChange={(event) => setAppeal(event.target.value)}
              placeholder="说明指标或排除原因异常的具体依据"
            />
            <Button
              size="sm"
              className="self-start"
              disabled={!appeal.trim() || submitting}
              onClick={async () => {
                setSubmitting(true);
                try {
                  await submitMarketplaceQualityAppeal(quality.packageId, appeal.trim());
                  setAppeal('');
                  toast.success('申诉工单已创建');
                  await onSubmitted();
                } catch (caught) {
                  toast.error(errorMessage(caught, '申诉提交失败'));
                } finally {
                  setSubmitting(false);
                }
              }}
            >
              {submitting && <Loader2Icon className="animate-spin" />}提交申诉
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

function QualityMetric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-lg border bg-muted/20 p-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 font-medium">{value}</div>
    </div>
  );
}

function qualityPercent(value: number | null) {
  return value == null ? '数据不足' : `${(value / 100).toFixed(2)}%`;
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right">{children}</span>
    </div>
  );
}

function runtimeTypeLabel(type: string): string {
  return (
    {
      client: '软件内（iframe）',
      nodejs: 'Node.js 独立进程',
      python: 'Python 独立进程',
      cloud: '云端',
      workflow: '工作流',
    }[type] ?? type
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString('zh-CN');
}
