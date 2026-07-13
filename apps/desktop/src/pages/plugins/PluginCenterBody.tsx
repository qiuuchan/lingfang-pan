import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ArchiveRestoreIcon,
  BoxIcon,
  DownloadIcon,
  FileArchiveIcon,
  FileEditIcon,
  HistoryIcon,
  InfoIcon,
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
import { PluginSourceBadge } from '@/components/plugins/PluginSourceBadge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { errorMessage } from '@/lib/api';
import type { LoadedPlugin } from '@/lib/types';
import {
  buyMarketplacePackage,
  copyInstallationToDraft,
  downloadRelease,
  importLocalArtifact,
  getPluginPackageDetail,
  listInstallations,
  listMarketplaceRegistry,
  listTeamRegistry,
  loadInstalledPlugin,
  loadDraftWorkspacePlugin,
  rollbackInstallation,
  selectPluginArtifact,
  uninstallInstallation,
  type Installation,
  type RegistryCatalogItem,
  type RegistryPackage,
  type RegistryRelease,
  type TransferProgress,
} from '@/lib/plugin-registry';

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
  const [detailTarget, setDetailTarget] = useState<DetailTarget | null>(null);
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

  const chooseImportArtifact = async () => {
    try {
      const selected = await selectPluginArtifact();
      if (selected) setImportPath(selected);
    } catch (caught) {
      toast.error(errorMessage(caught, '选择插件制品失败'));
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
              onDetail={(plugin, installation) => setDetailTarget({ kind: 'installed', plugin, installation })}
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
              onDetail={(item) => setDetailTarget({ kind: 'catalog', item, marketplace: false })}
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
              onDetail={(item) => setDetailTarget({ kind: 'catalog', item, marketplace: true })}
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
      <PluginDetailDialog target={detailTarget} onClose={() => setDetailTarget(null)} onRun={onRun} />
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>导入本地插件</DialogTitle><DialogDescription>导入 `.lfplugin` v4 压缩包并校验后登记为本机安装项。</DialogDescription></DialogHeader>
          <div className="flex gap-2"><Input value={importPath} onChange={(event) => setImportPath(event.target.value)} placeholder="选择 .lfplugin 文件（开发环境可输入路径）" /><Button variant="outline" size="icon" title="选择插件制品" onClick={() => void chooseImportArtifact()}><FileArchiveIcon /></Button></div>
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

function InstalledList({ installations, plugins, loading, onRun, onDetail, onRollback, onUninstall, onCopyDraft, busyKey }: {
  installations: Installation[];
  plugins: Record<string, LoadedPlugin>;
  loading: boolean;
  onRun: (plugin: LoadedPlugin) => void;
  onDetail: (plugin: LoadedPlugin, installation: Installation) => void;
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
              <Button variant="outline" size="icon-sm" title="插件详情" disabled={!plugin || busy} onClick={() => plugin && onDetail(plugin, installation)}><InfoIcon /></Button>
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

function CatalogList({ items, installed, loading, busyKey, marketplace, onDownload, onDetail, onHistory }: {
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
                <PluginSourceBadge sourceKind={item.latestRelease.sourceKind} sourceLabel={item.latestRelease.sourceLabel} ingestChannel={item.latestRelease.ingestChannel} />
                {marketplace && <Badge variant="secondary">{(item.priceCents || 0) === 0 ? '免费' : `¥${((item.priceCents || 0) / 100).toFixed(2)}`}</Badge>}
              </div>
              <p className="mt-1 line-clamp-1 text-sm text-muted-foreground">{item.package.description || '暂无描述'}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button variant="ghost" size="icon-sm" title="插件详情" onClick={() => onDetail(item)}><InfoIcon /></Button>
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
  return <Badge variant="secondary">安装来源：{{ builtin: '内置', local: '本地导入', team: '团队', marketplace: '市场' }[origin]}</Badge>;
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
    void getPluginPackageDetail(packageInfo.id)
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
              <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="font-medium">v{release.version}</span><PluginSourceBadge sourceKind={release.sourceKind} sourceLabel={release.sourceLabel} ingestChannel={release.ingestChannel} /></div><div className="mt-1 font-mono text-xs text-muted-foreground">{release.sha256.slice(0, 16)}...</div></div>
              <Badge variant={release.status === 'PUBLISHED' ? 'secondary' : 'outline'}>{release.status === 'PUBLISHED' ? '可下载' : '已撤回'}</Badge>
            </div>
          ))}
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
function PluginDetailDialog({ target, onClose, onRun }: {
  target: DetailTarget | null;
  onClose: () => void;
  onRun: (plugin: LoadedPlugin) => void;
}) {
  // 字段抽取：把两种来源统一成 { name, description, version, runtimeType, origin, meta } 便于渲染。
  const view = useMemo(() => {
    if (!target) return null;
    if (target.kind === 'installed') {
      const { plugin, installation } = target;
      const release = installation.activeRelease;
      return {
        name: plugin.name,
        description: plugin.description,
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
      version: release.version,
      runtimeType: release.manifest?.runtime_type,
      origin: <PluginSourceBadge sourceKind={release.sourceKind} sourceLabel={release.sourceLabel} ingestChannel={release.ingestChannel} />,
      meta: {
        ...(marketplace ? { 价格: priceCents === 0 ? '免费' : `¥${(priceCents / 100).toFixed(2)}` } : {}),
        ...(release.sizeBytes ? { 大小: formatBytes(release.sizeBytes) } : {}),
        ...(release.sha256 ? { 指纹: `${release.sha256.slice(0, 16)}...` } : {}),
        ...(item.package.updatedAt ? { 更新时间: formatDate(item.package.updatedAt) } : {}),
      } as Record<string, string>,
      onRunPlugin: null as LoadedPlugin | null,
    };
  }, [target]);

  return (
    <Dialog open={Boolean(target)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{view?.name ?? '插件详情'}</DialogTitle>
          <DialogDescription>插件介绍与版本信息。</DialogDescription>
        </DialogHeader>
        {view && (
          <div className="space-y-4">
            {/* 介绍（核心）：whitespace-pre-wrap 保留 manifest 里可能的多行 */}
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-muted-foreground">插件介绍</div>
              <p className="whitespace-pre-wrap break-words text-sm">
                {view.description?.trim() ? view.description : <span className="text-muted-foreground">暂无描述</span>}
              </p>
            </div>
            {/* 元信息：版本/运行时/来源 + 各来源特有字段 */}
            <div className="divide-y rounded-lg border">
              <DetailRow label="版本">{view.version}</DetailRow>
              {view.runtimeType && <DetailRow label="运行时">{runtimeTypeLabel(view.runtimeType)}</DetailRow>}
              <DetailRow label="来源">{view.origin}</DetailRow>
              {Object.entries(view.meta).map(([label, value]) => (
                <DetailRow key={label} label={label}>{value}</DetailRow>
              ))}
            </div>
          </div>
        )}
        <DialogFooter>
          {view?.onRunPlugin && (
            <Button variant="default" onClick={() => { onClose(); onRun(view.onRunPlugin!); }}>运行</Button>
          )}
          <Button variant="outline" onClick={onClose}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
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
  return { client: '软件内（iframe）', nodejs: 'Node.js 独立进程', python: 'Python 独立进程', cloud: '云端' }[type] ?? type;
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
