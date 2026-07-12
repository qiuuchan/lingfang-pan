import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArchiveRestoreIcon,
  BoxIcon,
  DownloadIcon,
  FileEditIcon,
  HistoryIcon,
  Loader2Icon,
  PackageCheckIcon,
  RefreshCwIcon,
  ShoppingCartIcon,
  StoreIcon,
  Trash2Icon,
  UploadIcon,
  UsersIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { useApp } from '@/App';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, errorMessage } from '@/lib/api';
import type { LoadedPlugin } from '@/lib/types';
import {
  buyMarketplacePackage,
  copyInstallationToDraft,
  downloadRelease,
  importLocalArtifact,
  listInstallations,
  listMarketplaceRegistry,
  listTeamRegistry,
  loadInstalledPlugin,
  loadDraftWorkspacePlugin,
  rollbackInstallation,
  uninstallInstallation,
  type Installation,
  type RegistryCatalogItem,
  type RegistryPackage,
  type RegistryRelease,
  type TransferProgress,
} from '@/lib/plugin-registry';

export type PluginCenterTab = 'installed' | 'team' | 'market';

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
  const { setCurrentDraft, setPendingDraftEdit, setView } = useApp();
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
  const [importOpen, setImportOpen] = useState(false);
  const [importPath, setImportPath] = useState('');

  const reload = useCallback(async () => {
    setLocalLoading(true);
    setCatalogLoading(true);
    setError('');
    const errors: string[] = [];
    try {
      const nextInstallations = await listInstallations();
      setInstallations(nextInstallations);
      const loaded = await Promise.all(nextInstallations.map(async (installation) => {
        try {
          return [installation.installationId, await loadInstalledPlugin(installation.installationId)] as const;
        } catch {
          return null;
        }
      }));
      setInstalledPlugins(Object.fromEntries(loaded.filter((item): item is readonly [string, LoadedPlugin] => Boolean(item))));
    } catch (caught) {
      errors.push(errorMessage(caught, '本机安装项加载失败'));
    } finally {
      setLocalLoading(false);
    }
    try {
      const [nextTeam, nextMarket] = await Promise.all([listTeamRegistry(), listMarketplaceRegistry()]);
      setTeam(nextTeam);
      setMarket(nextMarket);
    } catch (caught) {
      errors.push(errorMessage(caught, '远端插件目录加载失败'));
    } finally {
      setCatalogLoading(false);
      setError(errors.join('；'));
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const byPackage = useMemo(() => new Map(installations.map((item) => [item.packageId, item])), [installations]);

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
      if (!item.entitled && (item.priceCents || 0) > 0) await buyMarketplacePackage(item.package.id);
      await installCatalogItem(item, 'marketplace');
    } catch (caught) {
      toast.error(errorMessage(caught, '购买失败'));
      setBusyKey('');
    }
  };

  const copyToDraft = async (installation: Installation) => {
    setBusyKey(installation.installationId);
    try {
      const workspace = await copyInstallationToDraft(installation.installationId);
      const plugin = await loadDraftWorkspacePlugin(workspace);
      setCurrentDraft({ id: plugin.id, status: 'ready', files: plugin.files || [], turns: [], diagnostics: [] });
      setPendingDraftEdit({ draft: plugin, turns: [] });
      setView('develop-plugins');
    } catch (caught) {
      toast.error(errorMessage(caught, '复制为草稿失败'));
    } finally {
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
            {tab === 'installed' && <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}><UploadIcon />导入</Button>}
            <Button variant="outline" size="sm" onClick={() => void reload()} disabled={localLoading || catalogLoading}>
              <RefreshCwIcon className={localLoading || catalogLoading ? 'animate-spin' : ''} />刷新
            </Button>
          </div>
        </div>

        {error && <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</div>}
        {progress && <TransferProgressBar progress={progress} />}

        <Tabs value={tab} onValueChange={(value) => onTabChange(value as PluginCenterTab)}>
          <TabsList className="grid w-full max-w-xl grid-cols-3">
            <TabsTrigger value="installed"><PackageCheckIcon />已安装</TabsTrigger>
            <TabsTrigger value="team"><UsersIcon />团队库</TabsTrigger>
            <TabsTrigger value="market"><StoreIcon />插件市场</TabsTrigger>
          </TabsList>

          <TabsContent value="installed" className="mt-4">
            <InstalledList
              installations={installations}
              plugins={installedPlugins}
              loading={localLoading}
              onRun={onRun}
              onRollback={async (installation) => {
                setBusyKey(installation.installationId);
                try {
                  await rollbackInstallation(installation.installationId);
                  toast.success('已切换到上一版本');
                  await reload();
                } catch (caught) { toast.error(errorMessage(caught, '回滚失败')); }
                finally { setBusyKey(''); }
              }}
              onUninstall={setUninstallTarget}
              onCopyDraft={(installation) => void copyToDraft(installation)}
              busyKey={busyKey}
            />
          </TabsContent>

          <TabsContent value="team" className="mt-4">
            <CatalogList
              items={team}
              loading={catalogLoading}
              installed={byPackage}
              busyKey={busyKey}
              onDownload={(item) => void installCatalogItem(item, 'team')}
              onHistory={(item) => setHistoryPackage(item.package)}
            />
          </TabsContent>

          <TabsContent value="market" className="mt-4">
            <CatalogList
              items={market}
              loading={catalogLoading}
              installed={byPackage}
              busyKey={busyKey}
              marketplace
              onDownload={(item) => void buyAndDownload(item)}
              onHistory={(item) => setHistoryPackage(item.package)}
            />
          </TabsContent>
        </Tabs>
      </div>

      <Dialog open={Boolean(uninstallTarget)} onOpenChange={(open) => !open && setUninstallTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>彻底卸载插件？</DialogTitle>
            <DialogDescription>将删除插件代码、运行环境和全部插件数据。此操作不可撤销。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUninstallTarget(null)}>取消</Button>
            <Button variant="destructive" onClick={async () => {
              if (!uninstallTarget) return;
              setBusyKey(uninstallTarget.installationId);
              try {
                await uninstallInstallation(uninstallTarget.installationId);
                toast.success('插件已卸载');
                setUninstallTarget(null);
                await reload();
              } catch (caught) { toast.error(errorMessage(caught, '卸载失败')); }
              finally { setBusyKey(''); }
            }}><Trash2Icon />确认卸载</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PackageHistoryDialog packageInfo={historyPackage} onClose={() => setHistoryPackage(null)} />
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>导入本地插件</DialogTitle><DialogDescription>导入 `.lfplugin` v4 压缩包并校验后登记为本机安装项。</DialogDescription></DialogHeader>
          <Input value={importPath} onChange={(event) => setImportPath(event.target.value)} placeholder="C:\\path\\plugin.lfplugin" />
          <DialogFooter><Button variant="outline" onClick={() => setImportOpen(false)}>取消</Button><Button disabled={!importPath.trim() || busyKey === 'local-import'} onClick={async () => {
            setBusyKey('local-import');
            try { await importLocalArtifact(importPath.trim()); toast.success('本地插件已导入'); setImportOpen(false); setImportPath(''); await reload(); }
            catch (caught) { toast.error(errorMessage(caught, '导入失败')); }
            finally { setBusyKey(''); }
          }}>{busyKey === 'local-import' ? <Loader2Icon className="animate-spin" /> : <UploadIcon />}导入</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function InstalledList({ installations, plugins, loading, onRun, onRollback, onUninstall, onCopyDraft, busyKey }: {
  installations: Installation[];
  plugins: Record<string, LoadedPlugin>;
  loading: boolean;
  onRun: (plugin: LoadedPlugin) => void;
  onRollback: (installation: Installation) => void;
  onUninstall: (installation: Installation) => void;
  onCopyDraft: (installation: Installation) => void;
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
          <div key={installation.installationId} className="flex min-h-20 items-center gap-4 px-4 py-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted"><BoxIcon className="size-4" /></div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate font-medium">{plugin?.name || installation.packageId}</span>
                <SourceBadge origin={installation.origin} />
                {installation.protected && <Badge variant="outline">受保护</Badge>}
              </div>
              <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                <span>活动版本 v{installation.activeRelease.version}</span>
                <span>依赖 {dependencyLabel(installation.activeRelease.dependencyStatus)}</span>
                {installation.pendingRelease && <span className="text-amber-600">待激活 v{installation.pendingRelease.version}</span>}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button size="sm" disabled={!plugin || busy} onClick={() => plugin && onRun(plugin)}>运行</Button>
              <Button variant="outline" size="icon-sm" title="复制为草稿后编辑" disabled={busy} onClick={() => onCopyDraft(installation)}><FileEditIcon /></Button>
              {installation.previousRelease && (
                <Button variant="outline" size="icon-sm" title="回滚到上一版本" disabled={busy} onClick={() => onRollback(installation)}>
                  <ArchiveRestoreIcon />
                </Button>
              )}
              <Button variant="ghost" size="icon-sm" title={installation.protected ? '内置插件不可卸载' : '卸载'} disabled={installation.protected || busy} onClick={() => onUninstall(installation)}>
                {busy ? <Loader2Icon className="animate-spin" /> : <Trash2Icon />}
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CatalogList({ items, installed, loading, busyKey, marketplace, onDownload, onHistory }: {
  items: RegistryCatalogItem[];
  installed: Map<string, Installation>;
  loading: boolean;
  busyKey: string;
  marketplace?: boolean;
  onDownload: (item: RegistryCatalogItem) => void;
  onHistory: (item: RegistryCatalogItem) => void;
}) {
  if (loading) return <ListLoading />;
  if (!items.length) return <EmptyState icon={marketplace ? StoreIcon : UsersIcon} text={marketplace ? '市场暂无可下载插件' : '团队库暂无已发布版本'} />;
  return (
    <div className="divide-y rounded-lg border">
      {items.map((item) => {
        const local = installed.get(item.package.id);
        const downloaded = local?.activeRelease.releaseId === item.latestRelease.id || local?.pendingRelease?.releaseId === item.latestRelease.id;
        const busy = busyKey === item.latestRelease.id || busyKey === item.package.id;
        const needsPurchase = marketplace && !item.entitled && (item.priceCents || 0) > 0;
        return (
          <div key={item.package.id} className="flex min-h-20 items-center gap-4 px-4 py-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">{marketplace ? <StoreIcon className="size-4" /> : <UsersIcon className="size-4" />}</div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate font-medium">{item.package.name}</span>
                <Badge variant="outline">v{item.latestRelease.version}</Badge>
                {marketplace && <Badge variant="secondary">{(item.priceCents || 0) === 0 ? '免费' : `¥${((item.priceCents || 0) / 100).toFixed(2)}`}</Badge>}
              </div>
              <p className="mt-1 line-clamp-1 text-sm text-muted-foreground">{item.package.description || '暂无描述'}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button variant="ghost" size="icon-sm" title="版本历史" onClick={() => onHistory(item)}><HistoryIcon /></Button>
              <Button size="sm" variant={downloaded ? 'secondary' : 'default'} disabled={downloaded || busy} onClick={() => onDownload(item)}>
                {busy ? <Loader2Icon className="animate-spin" /> : needsPurchase ? <ShoppingCartIcon /> : local ? <RefreshCwIcon /> : <DownloadIcon />}
                {downloaded ? '已下载' : needsPurchase ? '购买并下载' : local ? '更新' : '下载'}
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TransferProgressBar({ progress }: { progress: TransferProgress }) {
  const percent = progress.total ? Math.min(100, Math.round((progress.transferred / progress.total) * 100)) : null;
  return (
    <div className="mb-4 rounded-lg border bg-muted/20 px-3 py-2">
      <div className="flex items-center justify-between text-xs"><span>{progress.message || '正在处理插件制品'}</span><span>{percent == null ? '处理中' : `${percent}%`}</span></div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary transition-[width]" style={{ width: percent == null ? '35%' : `${percent}%` }} /></div>
    </div>
  );
}

function SourceBadge({ origin }: { origin: Installation['origin'] }) {
  return <Badge variant="secondary">{{ builtin: '内置', local: '本地导入', team: '团队', marketplace: '市场' }[origin]}</Badge>;
}

function dependencyLabel(status: Installation['activeRelease']['dependencyStatus']) {
  return { pending: '待准备', preparing: '准备中', ready: '已就绪', failed: '失败' }[status];
}

function ListLoading() {
  return <div className="flex h-32 items-center justify-center text-sm text-muted-foreground"><Loader2Icon className="mr-2 size-4 animate-spin" />正在加载</div>;
}

function EmptyState({ icon: Icon, text }: { icon: typeof BoxIcon; text: string }) {
  return <div className="flex h-40 flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-sm text-muted-foreground"><Icon className="size-5" />{text}</div>;
}

function PackageHistoryDialog({ packageInfo, onClose }: { packageInfo: RegistryPackage | null; onClose: () => void }) {
  const [releases, setReleases] = useState<RegistryRelease[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!packageInfo) return;
    setLoading(true);
    void api<{ releases: RegistryRelease[] }>(`/api/plugin-packages/${packageInfo.id}`)
      .then((response) => setReleases(response.releases))
      .catch((caught) => toast.error(errorMessage(caught, '版本历史加载失败')))
      .finally(() => setLoading(false));
  }, [packageInfo]);
  return (
    <Dialog open={Boolean(packageInfo)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{packageInfo?.name}版本历史</DialogTitle><DialogDescription>发行版不可覆盖，已撤回版本保留审计记录。</DialogDescription></DialogHeader>
        <div className="max-h-80 divide-y overflow-y-auto rounded-lg border">
          {loading ? <ListLoading /> : releases.map((release) => (
            <div key={release.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <div><div className="font-medium">v{release.version}</div><div className="font-mono text-xs text-muted-foreground">{release.sha256.slice(0, 16)}...</div></div>
              <Badge variant={release.status === 'PUBLISHED' ? 'secondary' : 'outline'}>{release.status === 'PUBLISHED' ? '可下载' : '已撤回'}</Badge>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
