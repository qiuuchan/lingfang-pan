import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ChevronRightIcon,
  CircleSlash2Icon,
  Loader2Icon,
  PackageIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SendIcon,
  StoreIcon,
  Undo2Icon,
} from 'lucide-react';
import { toast } from 'sonner';
import { useApp } from '@/App';
import { LoadingButton } from '@/components/loading-button';
import { Pagination } from '@/components/pagination';
import { PluginSourceBadge } from '@/components/plugins/PluginSourceBadge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { errorMessage } from '@/lib/api';
import { DEFAULT_PAGE_SIZE, paginateItems } from '@/lib/pagination';
import { hasPermission } from '@/lib/permissions';
import {
  getPluginPackageDetail,
  listPluginManagement,
  submitReleaseToMarketplace,
  updateOwnerMarketplaceStatus,
  updatePluginPackageStatus,
  updatePluginReleaseStatus,
  withdrawMarketplaceSubmission,
  type RegistryManagementItem,
  type RegistryPackageDetail,
  type RegistryRelease,
} from '@/lib/plugin-registry';

export function PublishedPluginList({ refreshKey = 0 }: { refreshKey?: number }) {
  const { session } = useApp();
  const canEditPackage = hasPermission(session.permissions, 'team.plugin.edit_metadata');
  const canEditRelease = hasPermission(session.permissions, 'team.plugin.edit_draft');
  const canSubmitMarket = hasPermission(session.permissions, 'team.plugin.submit_marketplace');
  const [items, setItems] = useState<RegistryManagementItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busyKey, setBusyKey] = useState('');
  const [selected, setSelected] = useState<RegistryManagementItem | null>(null);
  const [detail, setDetail] = useState<RegistryPackageDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const paged = useMemo(() => paginateItems(items, page, pageSize), [items, page, pageSize]);
  const currentListingRelease = detail?.releases.find(
    (release) => release.id === detail.listing?.currentReleaseId
  );
  const ownerListingCanRelist =
    detail?.package.governanceStatus === 'ACTIVE' &&
    currentListingRelease?.status === 'PUBLISHED' &&
    currentListingRelease.marketReviewStatus === 'APPROVED';

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setItems(await listPluginManagement());
    } catch (caught) {
      setError(errorMessage(caught, '已发布插件加载失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (packageId: string) => {
    setDetailLoading(true);
    setActionError('');
    try {
      setDetail(await getPluginPackageDetail(packageId));
    } catch (caught) {
      setActionError(errorMessage(caught, '插件详情加载失败'));
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload, refreshKey]);
  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    void loadDetail(selected.package.id);
  }, [selected, loadDetail]);

  async function runAction(key: string, action: () => Promise<unknown>, success: string) {
    if (busyKey) return;
    setBusyKey(key);
    setActionError('');
    try {
      await action();
      toast.success(success);
      await reload();
      if (selected) await loadDetail(selected.package.id);
    } catch (caught) {
      const message = errorMessage(caught, '状态更新失败');
      setActionError(message);
      toast.error(message);
    } finally {
      setBusyKey('');
    }
  }

  if (loading) return <ListLoading label="正在加载已发布插件" />;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">
          管理团队版本、市场审核和上架状态。已归档或已撤回项目仍会保留在这里。
        </p>
        <Button
          className="shrink-0"
          variant="outline"
          size="icon-sm"
          title="刷新已发布插件"
          onClick={() => void reload()}
          disabled={loading}
        >
          <RefreshCwIcon />
        </Button>
      </div>
      {error && (
        <Alert
          variant="destructive"
          className="border-destructive/30 bg-destructive/5 text-destructive"
        >
          <AlertDescription className="text-destructive">{error}</AlertDescription>
        </Alert>
      )}
      {!items.length ? (
        <Empty className="h-44 rounded-lg border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <PackageIcon />
            </EmptyMedia>
            <EmptyTitle>团队还没有已发布插件</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="divide-y rounded-lg border">
          {paged.items.map((item) => {
            const archived = item.package.governanceStatus === 'ARCHIVED';
            const packageBusy = busyKey === `package:${item.package.id}`;
            const archiveBlocked = !archived && item.pendingReviewCount > 0;
            return (
              <div
                key={item.package.id}
                className="flex min-h-24 min-w-0 items-center gap-4 px-4 py-3"
              >
                <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted">
                  <PackageIcon className="size-4" />
                </div>
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => setSelected(item)}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-medium">{item.package.name}</span>
                    <Badge variant={archived ? 'outline' : 'secondary'}>
                      {archived ? '已归档' : '启用中'}
                    </Badge>
                    <ListingBadge status={item.listing?.status} />
                    {item.pendingReviewCount > 0 && (
                      <Badge variant="outline">{item.pendingReviewCount} 个待审核</Badge>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>{item.package.manifestId}</span>
                    <span>{item.releaseCount} 个版本</span>
                    {item.latestRelease && <span>最新 v{item.latestRelease.version}</span>}
                    {item.latestRelease && (
                      <PluginSourceBadge
                        sourceKind={item.latestRelease.sourceKind}
                        sourceLabel={item.latestRelease.sourceLabel}
                        ingestChannel={item.latestRelease.ingestChannel}
                      />
                    )}
                  </div>
                </button>
                <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                  {canEditPackage && (
                    <LoadingButton
                      variant="outline"
                      size="sm"
                      loading={packageBusy}
                      disabled={Boolean(busyKey) || archiveBlocked}
                      title={
                        archiveBlocked
                          ? '请先撤回待审核发行版'
                          : archived
                            ? '恢复 package'
                            : '归档 package'
                      }
                      onClick={() =>
                        void runAction(
                          `package:${item.package.id}`,
                          () =>
                            updatePluginPackageStatus(
                              item.package.id,
                              archived ? 'ACTIVE' : 'ARCHIVED'
                            ),
                          archived ? '插件已恢复' : '插件已归档'
                        )
                      }
                    >
                      {archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
                      {archived ? '恢复' : '归档'}
                    </LoadingButton>
                  )}
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    title="查看版本与状态"
                    onClick={() => setSelected(item)}
                  >
                    <ChevronRightIcon />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <Pagination
        page={paged.currentPage}
        totalPages={paged.totalPages}
        total={paged.total}
        pageSize={pageSize}
        onChange={setPage}
        onPageSizeChange={(size) => {
          setPageSize(size);
          setPage(1);
        }}
      />

      <Dialog open={Boolean(selected)} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{selected?.package.name || '插件详情'}</DialogTitle>
            <DialogDescription>
              package、发行版、审核和市场上架是独立状态；操作失败不会提前改变当前显示。
            </DialogDescription>
          </DialogHeader>
          {actionError && (
            <Alert
              variant="destructive"
              className="border-destructive/30 bg-destructive/5 text-destructive"
            >
              <AlertDescription className="text-destructive">{actionError}</AlertDescription>
            </Alert>
          )}
          {detailLoading ? (
            <ListLoading label="正在加载版本详情" />
          ) : detail ? (
            <div className="flex flex-col gap-4">
              <div className="rounded-lg border bg-muted/10 px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    variant={detail.package.governanceStatus === 'ACTIVE' ? 'secondary' : 'outline'}
                  >
                    {detail.package.governanceStatus === 'ACTIVE'
                      ? 'Package 启用中'
                      : 'Package 已归档'}
                  </Badge>
                  <ListingBadge status={detail.listing?.status} />
                  <div className="flex w-full min-w-0 flex-wrap items-center justify-end gap-2 sm:ml-auto sm:w-auto">
                    {canSubmitMarket && detail.listing?.status === 'ACTIVE' && (
                      <LoadingButton
                        variant="outline"
                        size="sm"
                        loading={busyKey === `listing:${detail.package.id}`}
                        disabled={Boolean(busyKey)}
                        onClick={() =>
                          void runAction(
                            `listing:${detail.package.id}`,
                            () =>
                              updateOwnerMarketplaceStatus(
                                detail.package.id,
                                'DELISTED',
                                '团队主动下架'
                              ),
                            '插件已从市场下架'
                          )
                        }
                      >
                        <CircleSlash2Icon />
                        下架市场
                      </LoadingButton>
                    )}
                    {canSubmitMarket &&
                      detail.listing?.status === 'DELISTED' &&
                      detail.listing.delistedBy === 'OWNER' && (
                        <LoadingButton
                          variant="outline"
                          size="sm"
                          loading={busyKey === `listing:${detail.package.id}`}
                          disabled={Boolean(busyKey) || !ownerListingCanRelist}
                          title={
                            !ownerListingCanRelist
                              ? detail.package.governanceStatus !== 'ACTIVE'
                                ? '请先恢复插件包'
                                : '请先恢复已通过审核的市场当前版本'
                              : undefined
                          }
                          onClick={() =>
                            void runAction(
                              `listing:${detail.package.id}`,
                              () => updateOwnerMarketplaceStatus(detail.package.id, 'ACTIVE'),
                              '插件已重新上架'
                            )
                          }
                        >
                          <StoreIcon />
                          重新上架
                        </LoadingButton>
                      )}
                  </div>
                </div>
                {detail.listing?.status === 'DELISTED' &&
                  (detail.listing.delistedBy || detail.listing.delistReason) && (
                    <div className="mt-2 flex min-w-0 flex-wrap gap-x-3 gap-y-1 border-t pt-2 text-xs text-muted-foreground">
                      {detail.listing.delistedBy && (
                        <span>
                          下架方：
                          {detail.listing.delistedBy === 'PLATFORM' ? '平台' : '团队'}
                        </span>
                      )}
                      {detail.listing.delistReason && (
                        <span className="min-w-0 break-words">
                          原因：{detail.listing.delistReason}
                        </span>
                      )}
                    </div>
                  )}
              </div>

              <div className="divide-y rounded-lg border">
                {detail.releases.map((release) => (
                  <ReleaseRow
                    key={release.id}
                    release={release}
                    packageActive={detail.package.governanceStatus === 'ACTIVE'}
                    isMarketplaceCurrent={
                      detail.listing?.status === 'ACTIVE' &&
                      detail.listing.currentReleaseId === release.id
                    }
                    listingPrice={detail.listing?.priceCents ?? 0}
                    busyKey={busyKey}
                    canEditRelease={canEditRelease}
                    canSubmitMarket={canSubmitMarket}
                    onAction={(key, action, success) => void runAction(key, action, success)}
                  />
                ))}
              </div>
            </div>
          ) : (
            <div className="py-10 text-center text-sm text-muted-foreground">详情不可用</div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ReleaseRow({
  release,
  packageActive,
  isMarketplaceCurrent,
  listingPrice,
  busyKey,
  canEditRelease,
  canSubmitMarket,
  onAction,
}: {
  release: RegistryRelease;
  packageActive: boolean;
  isMarketplaceCurrent: boolean;
  listingPrice: number;
  busyKey: string;
  canEditRelease: boolean;
  canSubmitMarket: boolean;
  onAction: (key: string, action: () => Promise<unknown>, success: string) => void;
}) {
  const yanked = release.status === 'YANKED';
  const pending = release.marketReviewStatus === 'PENDING';
  const isStableVersion = !release.version.split('+', 1)[0].includes('-');
  const canSubmit =
    packageActive &&
    !yanked &&
    isStableVersion &&
    (release.marketReviewStatus === 'DRAFT' || release.marketReviewStatus === 'REJECTED');
  return (
    <div className="flex flex-col items-stretch gap-3 px-3 py-3 sm:flex-row sm:items-start sm:gap-4">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">v{release.version}</span>
          <Badge variant={yanked ? 'outline' : 'secondary'}>{yanked ? '已撤回' : '可下载'}</Badge>
          <ReviewBadge status={release.marketReviewStatus} />
          {isMarketplaceCurrent && <Badge>市场当前版</Badge>}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <PluginSourceBadge
            sourceKind={release.sourceKind}
            sourceLabel={release.sourceLabel}
            ingestChannel={release.ingestChannel}
          />
          <span>{new Date(release.createdAt).toLocaleString()}</span>
          <span className="font-mono">{release.sha256.slice(0, 12)}...</span>
        </div>
      </div>
      <div className="flex w-full min-w-0 flex-wrap justify-end gap-1 sm:w-auto sm:shrink-0">
        {canSubmitMarket && canSubmit && (
          <LoadingButton
            size="sm"
            loading={busyKey === `submit:${release.id}`}
            disabled={Boolean(busyKey)}
            onClick={() =>
              onAction(
                `submit:${release.id}`,
                () => submitReleaseToMarketplace(release.id, listingPrice),
                '已提交市场审核'
              )
            }
          >
            <SendIcon />
            提交市场
          </LoadingButton>
        )}
        {canSubmitMarket && pending && (
          <LoadingButton
            variant="outline"
            size="sm"
            loading={busyKey === `withdraw:${release.id}`}
            disabled={Boolean(busyKey)}
            onClick={() =>
              onAction(
                `withdraw:${release.id}`,
                () => withdrawMarketplaceSubmission(release.id),
                '已撤回市场提审'
              )
            }
          >
            <Undo2Icon />
            撤回提审
          </LoadingButton>
        )}
        {canEditRelease && (
          <LoadingButton
            variant="outline"
            size="sm"
            loading={busyKey === `release:${release.id}`}
            disabled={Boolean(busyKey) || (yanked && !packageActive)}
            title={yanked && !packageActive ? '请先恢复插件包' : undefined}
            onClick={() =>
              onAction(
                `release:${release.id}`,
                () => updatePluginReleaseStatus(release.id, yanked ? 'PUBLISHED' : 'YANKED'),
                yanked ? '版本已恢复' : '版本已撤回'
              )
            }
          >
            {yanked ? <RotateCcwIcon /> : <CircleSlash2Icon />}
            {yanked ? '恢复版本' : '撤回版本'}
          </LoadingButton>
        )}
      </div>
    </div>
  );
}

function ListingBadge({ status }: { status?: 'DRAFT' | 'ACTIVE' | 'DELISTED' }) {
  if (!status) return <Badge variant="outline">未进入市场</Badge>;
  return (
    <Badge variant={status === 'ACTIVE' ? 'secondary' : 'outline'}>
      {{ DRAFT: '市场草稿', ACTIVE: '市场上架', DELISTED: '市场下架' }[status]}
    </Badge>
  );
}

function ReviewBadge({ status }: { status: RegistryRelease['marketReviewStatus'] }) {
  const label = {
    DRAFT: '未提审',
    PENDING: '审核中',
    APPROVED: '已通过',
    REJECTED: '已拒绝',
  }[status];
  return (
    <Badge
      variant={
        status === 'APPROVED' ? 'secondary' : status === 'REJECTED' ? 'destructive' : 'outline'
      }
    >
      {label}
    </Badge>
  );
}

function ListLoading({ label }: { label: string }) {
  return (
    <div className="flex h-36 items-center justify-center text-sm text-muted-foreground">
      <Loader2Icon className="mr-2 size-4 animate-spin" />
      {label}
    </div>
  );
}
