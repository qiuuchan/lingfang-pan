import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArchiveRestoreIcon,
  BanIcon,
  CheckCircleIcon,
  FileJsonIcon,
  FilesIcon,
  HistoryIcon,
  Loader2Icon,
  ShieldCheckIcon,
  XCircleIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { AsyncResource } from '@/components/ui/async-resource';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DetailSheet } from '@/components/ui/detail-sheet';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Pagination } from '@/components/ui/pagination';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { InfoGrid } from '@/components/shared';
import {
  approvePluginRelease,
  delistPluginRelease,
  loadPluginFiles,
  loadPluginManifest,
  loadPluginPackage,
  loadPluginRelease,
  loadPluginReleases,
  loadPluginReviews,
  rejectPluginRelease,
  relistPluginPackage,
} from '@/components/governance/api';
import {
  delistActorLabel,
  ingestChannelLabel,
  ListingBadge,
  PackageStatusBadge,
  ReleaseStatusBadge,
  ReviewBadge,
  sourceKindLabel,
} from '@/components/governance/status';
import type {
  Page,
  PluginFileSummary,
  PluginManifestDetail,
  PluginPackageDetail,
  PluginPackageSummary,
  PluginReleaseCore,
  PluginReleaseSummary,
  PluginReviewSummary,
} from '@/components/governance/types';
import { useAsyncResource } from '@/lib/async-resource';
import type { ApiError } from '@/lib/api';
import { useGuardedAction } from '@/lib/helpers';
import { formatTime } from '@/lib/types';

type ReleaseTab = 'overview' | 'manifest' | 'files' | 'reviews';
type ConfirmAction = 'reject' | 'delist' | 'relist' | null;

type ResourceCache = Map<string, unknown>;

const CONFIRMATION_COPY: Record<
  Exclude<ConfirmAction, null>,
  {
    title: string;
    description: string;
    placeholder: string;
    submitLabel: string;
  }
> = {
  reject: {
    title: '驳回发行版',
    description: '驳回只影响当前发行版，可由发布方修正后重新提交。',
    placeholder: '填写驳回原因（1-500 字）',
    submitLabel: '确认驳回',
  },
  delist: {
    title: '平台下架市场当前发行版',
    description: '下架仅允许作用于精确的市场当前版，制品、历史发行版和已有权益会保留。',
    placeholder: '填写平台下架原因（1-500 字）',
    submitLabel: '确认下架',
  },
  relist: {
    title: '恢复市场上架',
    description: '恢复后将继续使用下架期间保留的、已通过审核的当前发行版。',
    placeholder: '填写恢复上架原因（1-500 字）',
    submitLabel: '确认恢复',
  },
};

async function cached<T>(cache: ResourceCache, key: string, loader: () => Promise<T>): Promise<T> {
  if (cache.has(key)) return cache.get(key) as T;
  const value = await loader();
  cache.set(key, value);
  return value;
}

export function PluginPackageSheet({
  summary,
  open,
  onOpenChange,
  onChanged,
  initialReleaseId,
}: {
  summary: PluginPackageSummary | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
  /** 深链：打开抽屉时预选指定 release（如待审核队列跳入）。 */
  initialReleaseId?: string | null;
}) {
  const packageId = summary?.id ?? '';
  const cacheRef = useRef<ResourceCache>(new Map());
  const [releasePage, setReleasePage] = useState(1);
  const [releasePageSize, setReleasePageSize] = useState(10);
  const [selectedReleaseId, setSelectedReleaseId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ReleaseTab>('overview');
  const [filePage, setFilePage] = useState(1);
  const [reviewPage, setReviewPage] = useState(1);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const [reason, setReason] = useState('');
  const [busy, guard] = useGuardedAction();
  const confirmTriggerRef = useRef<HTMLButtonElement | null>(null);

  const packageDetail = useAsyncResource(
    (signal) => loadPluginPackage(packageId, signal),
    [packageId],
    { enabled: open && Boolean(packageId) }
  );
  const releases = useAsyncResource(
    (signal) =>
      loadPluginReleases(packageId, { page: releasePage, pageSize: releasePageSize }, signal),
    [packageId, releasePage, releasePageSize],
    { enabled: open && Boolean(packageId), isEmpty: (result) => result.items.length === 0 }
  );

  const releaseCore = useAsyncResource(
    (signal) =>
      cached(cacheRef.current, `core:${selectedReleaseId}`, () =>
        loadPluginRelease(selectedReleaseId!, signal)
      ),
    [selectedReleaseId],
    { enabled: open && Boolean(selectedReleaseId) }
  );
  const manifest = useAsyncResource(
    (signal) =>
      cached(cacheRef.current, `manifest:${selectedReleaseId}`, () =>
        loadPluginManifest(selectedReleaseId!, signal)
      ),
    [selectedReleaseId],
    { enabled: open && Boolean(selectedReleaseId) && activeTab === 'manifest' }
  );
  const files = useAsyncResource(
    (signal) =>
      cached(cacheRef.current, `files:${selectedReleaseId}:${filePage}`, () =>
        loadPluginFiles(selectedReleaseId!, { page: filePage, pageSize: 20 }, signal)
      ),
    [selectedReleaseId, filePage],
    {
      enabled: open && Boolean(selectedReleaseId) && activeTab === 'files',
      isEmpty: (result) => result.items.length === 0,
    }
  );
  const reviews = useAsyncResource(
    (signal) =>
      cached(cacheRef.current, `reviews:${selectedReleaseId}:${reviewPage}`, () =>
        loadPluginReviews(selectedReleaseId!, { page: reviewPage, pageSize: 10 }, signal)
      ),
    [selectedReleaseId, reviewPage],
    {
      enabled: open && Boolean(selectedReleaseId) && activeTab === 'reviews',
      isEmpty: (result) => result.items.length === 0,
    }
  );

  useEffect(() => {
    cacheRef.current.clear();
    setReleasePage(1);
    setSelectedReleaseId(initialReleaseId ?? null);
    setActiveTab('overview');
    setFilePage(1);
    setReviewPage(1);
    setConfirmAction(null);
    setReason('');
  }, [packageId, initialReleaseId]);

  useEffect(() => {
    if (!releases.data) return;
    const items = releases.data.items;
    if (!items.length) {
      setSelectedReleaseId(null);
      return;
    }
    setSelectedReleaseId((current) => {
      // 优先深链 initialReleaseId，其次保留已选，否则首个。
      const preferred =
        initialReleaseId &&
        items.some((release: PluginReleaseSummary) => release.id === initialReleaseId)
          ? initialReleaseId
          : null;
      if (preferred) return preferred;
      return current && items.some((release: PluginReleaseSummary) => release.id === current)
        ? current
        : items[0].id;
    });
  }, [releases.data, initialReleaseId]);

  useEffect(() => {
    setReason('');
  }, [confirmAction]);

  function invalidateCurrent() {
    for (const key of cacheRef.current.keys()) {
      if (key.startsWith('core:') || key.startsWith(`reviews:${selectedReleaseId}:`)) {
        cacheRef.current.delete(key);
      }
    }
    packageDetail.reload();
    releases.reload();
    releaseCore.reload();
    if (activeTab === 'reviews') reviews.reload();
    onChanged();
  }

  function refreshAfterConflict(error: unknown) {
    if ((error as ApiError)?.status === 409) invalidateCurrent();
  }

  async function approve() {
    if (!selectedReleaseId) return;
    await guard(async () => {
      try {
        await approvePluginRelease(selectedReleaseId);
        toast.success('发行版已通过审核');
        invalidateCurrent();
      } catch (error) {
        refreshAfterConflict(error);
        toast.error(error instanceof Error ? error.message : '审核失败');
      }
    });
  }

  async function confirm() {
    const normalized = reason.trim();
    if (!confirmAction || !normalized || normalized.length > 500) return;
    await guard(async () => {
      try {
        switch (confirmAction) {
          case 'reject':
            if (!selectedReleaseId) return;
            await rejectPluginRelease(selectedReleaseId, normalized);
            toast.success('发行版已驳回');
            break;
          case 'delist':
            if (!selectedReleaseId) return;
            await delistPluginRelease(selectedReleaseId, normalized);
            toast.success('市场当前发行版已由平台下架');
            break;
          case 'relist':
            await relistPluginPackage(packageId, normalized);
            toast.success('插件包已恢复市场上架');
            break;
        }
        setConfirmAction(null);
        setReason('');
        invalidateCurrent();
      } catch (error) {
        refreshAfterConflict(error);
        toast.error(error instanceof Error ? error.message : '操作失败');
      }
    });
  }

  const core = releaseCore.data?.release.id === selectedReleaseId ? releaseCore.data : null;
  const listing = packageDetail.data?.listing ?? summary?.listing ?? null;
  const canDelistCurrentRelease = core?.isMarketplaceCurrent === true;
  const canPlatformRelist = listing?.status === 'DELISTED' && listing.delistedBy === 'PLATFORM';
  const confirmationCopy = confirmAction ? CONFIRMATION_COPY[confirmAction] : null;

  return (
    <>
      <DetailSheet
        open={open}
        onOpenChange={onOpenChange}
        title={summary?.name ?? '插件包详情'}
        description={summary?.manifestId}
        size="xl"
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            {canPlatformRelist && (
              <Button
                type="button"
                variant="outline"
                onClick={(event) => {
                  confirmTriggerRef.current = event.currentTarget;
                  setConfirmAction('relist');
                }}
                disabled={busy}
              >
                <ArchiveRestoreIcon />
                恢复市场上架
              </Button>
            )}
            {canDelistCurrentRelease && (
              <Button
                type="button"
                variant="destructive"
                onClick={(event) => {
                  confirmTriggerRef.current = event.currentTarget;
                  setConfirmAction('delist');
                }}
                disabled={busy}
              >
                <BanIcon />
                平台下架当前版
              </Button>
            )}
            {core?.release.marketReviewStatus === 'PENDING' && (
              <>
                <Button
                  type="button"
                  variant="outline"
                  onClick={(event) => {
                    confirmTriggerRef.current = event.currentTarget;
                    setConfirmAction('reject');
                  }}
                  disabled={busy}
                >
                  <XCircleIcon />
                  驳回
                </Button>
                <Button type="button" onClick={() => void approve()} disabled={busy}>
                  {busy ? <Loader2Icon className="animate-spin" /> : <CheckCircleIcon />}
                  通过审核
                </Button>
              </>
            )}
          </div>
        }
      >
        <AsyncResource
          status={packageDetail.status}
          error={packageDetail.error}
          retry={packageDetail.reload}
        >
          {packageDetail.data && (
            <section className="space-y-2">
              <h3 className="text-sm font-semibold">插件包概览</h3>
              <PackageOverview detail={packageDetail.data} />
            </section>
          )}
        </AsyncResource>

        <section className="space-y-3 border-t pt-5">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="text-sm font-semibold">发行版</h3>
            </div>
            {releases.data?.items.length ? (
              <Select
                value={selectedReleaseId ?? ''}
                onValueChange={(nextReleaseId) => {
                  setActiveTab('overview');
                  setFilePage(1);
                  setReviewPage(1);
                  setSelectedReleaseId(nextReleaseId);
                }}
              >
                <SelectTrigger className="w-full sm:w-64" aria-label="选择发行版">
                  <SelectValue placeholder="选择发行版" />
                </SelectTrigger>
                <SelectContent>
                  {releases.data.items.map((release: PluginReleaseSummary) => (
                    <SelectItem key={release.id} value={release.id}>
                      v{release.version} · {reviewLabel(release.marketReviewStatus)}
                      {release.isMarketplaceCurrent ? ' · 市场当前版' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
          </div>

          <AsyncResource status={releases.status} error={releases.error} retry={releases.reload}>
            {releases.data && releases.data.items.length > 0 && (
              <>
                <Tabs
                  value={activeTab}
                  onValueChange={(value) => setActiveTab(value as ReleaseTab)}
                >
                  <div className="overflow-x-auto scrollbar-thin">
                    <TabsList className="min-w-max">
                      <TabsTrigger value="overview">
                        <ShieldCheckIcon className="mr-1.5 size-4" />
                        概览
                      </TabsTrigger>
                      <TabsTrigger value="manifest">
                        <FileJsonIcon className="mr-1.5 size-4" />
                        Manifest
                      </TabsTrigger>
                      <TabsTrigger value="files">
                        <FilesIcon className="mr-1.5 size-4" />
                        文件
                      </TabsTrigger>
                      <TabsTrigger value="reviews">
                        <HistoryIcon className="mr-1.5 size-4" />
                        审核记录
                      </TabsTrigger>
                    </TabsList>
                  </div>
                  <TabsContent value="overview">
                    <ReleaseOverview resource={releaseCore} />
                  </TabsContent>
                  <TabsContent value="manifest">
                    <ManifestView resource={manifest} />
                  </TabsContent>
                  <TabsContent value="files">
                    <FilesView resource={files} page={filePage} onPageChange={setFilePage} />
                  </TabsContent>
                  <TabsContent value="reviews">
                    <ReviewsView
                      resource={reviews}
                      page={reviewPage}
                      onPageChange={setReviewPage}
                    />
                  </TabsContent>
                </Tabs>

                <Pagination
                  totalItems={releases.data.total}
                  pageSize={releasePageSize}
                  currentPage={releases.data.page}
                  onPageChange={(nextPage) => {
                    setSelectedReleaseId(null);
                    setActiveTab('overview');
                    setFilePage(1);
                    setReviewPage(1);
                    setReleasePage(nextPage);
                  }}
                  onPageSizeChange={(size) => {
                    setSelectedReleaseId(null);
                    setActiveTab('overview');
                    setFilePage(1);
                    setReviewPage(1);
                    setReleasePageSize(size);
                    setReleasePage(1);
                  }}
                />
              </>
            )}
          </AsyncResource>
        </section>
      </DetailSheet>

      <Dialog
        open={Boolean(confirmAction)}
        onOpenChange={(next) => {
          if (!next && !busy) setConfirmAction(null);
        }}
      >
        <DialogContent
          className="sm:max-w-md"
          onCloseAutoFocus={(event) => {
            const trigger = confirmTriggerRef.current;
            if (!trigger?.isConnected) return;
            event.preventDefault();
            requestAnimationFrame(() => trigger.focus({ preventScroll: true }));
          }}
        >
          <DialogHeader>
            <DialogTitle>{confirmationCopy?.title ?? '确认治理操作'}</DialogTitle>
            <DialogDescription>{confirmationCopy?.description}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Textarea
              aria-label="治理操作原因"
              value={reason}
              disabled={busy}
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
              placeholder={confirmationCopy?.placeholder}
              rows={4}
            />
            <div className="text-right text-xs text-muted-foreground">{reason.length}/500</div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirmAction(null)}
              disabled={busy}
            >
              取消
            </Button>
            <Button
              type="button"
              variant={confirmAction === 'relist' ? 'default' : 'destructive'}
              onClick={() => void confirm()}
              disabled={busy || !reason.trim()}
            >
              {busy && <Loader2Icon className="animate-spin" />}
              {confirmationCopy?.submitLabel ?? '确认'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function PackageOverview({ detail }: { detail: PluginPackageDetail }) {
  const listing = detail.listing;
  const items: Array<[string, ReactNode]> = [
    ['所属团队', `${detail.ownerTeam.name} (${detail.ownerTeam.slug})`],
    ['包状态', <PackageStatusBadge value={detail.package.governanceStatus} />],
    ['发行版', `${detail.releaseCount} 个`],
    ['待审核', `${detail.pendingReviewCount} 个`],
    ['市场状态', <ListingBadge status={listing?.status ?? null} />],
    ['更新时间', formatTime(detail.package.updatedAt)],
  ];

  if (listing?.status === 'ACTIVE') {
    items.push([
      '市场当前发行版 ID',
      <span className="font-mono text-xs">{listing.currentReleaseId}</span>,
    ]);
  }
  if (listing?.status === 'DELISTED') {
    items.push(
      [
        '下架时保留的发行版 ID',
        listing.currentReleaseId ? (
          <span className="font-mono text-xs">{listing.currentReleaseId}</span>
        ) : (
          '未记录'
        ),
      ],
      ['下架方', delistActorLabel(listing.delistedBy)],
      ['下架原因', listing.delistReason || '未记录'],
      ['下架时间', listing.delistedAt ? formatTime(listing.delistedAt) : '未记录'],
      [
        '操作人 ID',
        listing.delistedByUserId ? (
          <span className="font-mono text-xs">{listing.delistedByUserId}</span>
        ) : (
          '系统或历史操作'
        ),
      ]
    );
  }

  return <InfoGrid items={items} />;
}

function ReleaseOverview({
  resource,
}: {
  resource: ReturnType<typeof useAsyncResource<PluginReleaseCore>>;
}) {
  const data = resource.data;
  const items: Array<[string, ReactNode]> = data
    ? [
        ['版本', `v${data.release.version}`],
        ['发行状态', <ReleaseStatusBadge value={data.release.status} />],
        ['审核状态', <ReviewBadge value={data.release.marketReviewStatus} />],
        ['市场状态', <ListingBadge status={data.listing?.status ?? null} />],
        ['发布来源', sourceKindLabel(data.release.sourceKind)],
        ['来源标记', data.release.sourceLabel || '未提供'],
        ['接入通道', ingestChannelLabel(data.release.ingestChannel)],
        ['目标平台', data.release.targetPlatform],
        ['制品大小', formatBytes(data.release.sizeBytes)],
        ['SHA-256', <span className="font-mono text-xs">{data.release.sha256}</span>],
        ['审核原因', data.release.reviewReason || '—'],
        ['发布时间', formatTime(data.release.createdAt)],
      ]
    : [];
  if (data?.isMarketplaceCurrent) {
    items.splice(4, 0, ['市场当前版', <Badge variant="success">是</Badge>]);
  }

  return (
    <AsyncResource status={resource.status} error={resource.error} retry={resource.reload}>
      {data && <InfoGrid items={items} />}
    </AsyncResource>
  );
}

function ManifestView({
  resource,
}: {
  resource: ReturnType<typeof useAsyncResource<PluginManifestDetail>>;
}) {
  return (
    <AsyncResource status={resource.status} error={resource.error} retry={resource.reload}>
      {resource.data && (
        <pre className="max-h-[28rem] overflow-auto rounded-lg border bg-muted/30 p-3 text-xs leading-5 scrollbar-thin">
          {JSON.stringify(resource.data.manifest, null, 2)}
        </pre>
      )}
    </AsyncResource>
  );
}

function FilesView({
  resource,
  page,
  onPageChange,
}: {
  resource: ReturnType<typeof useAsyncResource<Page<PluginFileSummary>>>;
  page: number;
  onPageChange: (page: number) => void;
}) {
  return (
    <AsyncResource status={resource.status} error={resource.error} retry={resource.reload}>
      {resource.data && (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>路径</TableHead>
                <TableHead className="w-28">大小</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {resource.data.items.map((file: PluginFileSummary) => (
                <TableRow key={file.path}>
                  <TableCell className="max-w-0 break-all font-mono text-xs">{file.path}</TableCell>
                  <TableCell>{formatBytes(file.sizeBytes)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Pagination
            totalItems={resource.data.total}
            pageSize={20}
            currentPage={page}
            onPageChange={onPageChange}
            onPageSizeChange={() => undefined}
            pageSizeOptions={[20]}
          />
        </>
      )}
    </AsyncResource>
  );
}

function ReviewsView({
  resource,
  page,
  onPageChange,
}: {
  resource: ReturnType<typeof useAsyncResource<Page<PluginReviewSummary>>>;
  page: number;
  onPageChange: (page: number) => void;
}) {
  return (
    <AsyncResource status={resource.status} error={resource.error} retry={resource.reload}>
      {resource.data && (
        <>
          <div className="divide-y rounded-lg border">
            {resource.data.items.map((review: PluginReviewSummary) => (
              <div
                key={review.id}
                className="grid gap-2 px-3 py-3 text-sm sm:grid-cols-[7rem_1fr_auto]"
              >
                <ReviewBadge value={review.status} />
                <div className="min-w-0 break-words">{review.reason || '无补充说明'}</div>
                <div className="text-xs text-muted-foreground sm:text-right">
                  <div>{review.reviewer?.displayName || review.reviewer?.email || '系统'}</div>
                  <div>{formatTime(review.createdAt)}</div>
                </div>
              </div>
            ))}
          </div>
          <Pagination
            totalItems={resource.data.total}
            pageSize={10}
            currentPage={page}
            onPageChange={onPageChange}
            onPageSizeChange={() => undefined}
            pageSizeOptions={[10]}
          />
        </>
      )}
    </AsyncResource>
  );
}

function reviewLabel(status: string) {
  return status === 'PENDING'
    ? '待审核'
    : status === 'APPROVED'
      ? '已通过'
      : status === 'REJECTED'
        ? '已驳回'
        : '未提交';
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
