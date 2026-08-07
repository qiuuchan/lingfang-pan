import { useEffect, useState, type FormEvent } from 'react';
import { PackageOpenIcon, RefreshCwIcon, SearchIcon } from 'lucide-react';
import { AsyncResource } from '@/components/ui/async-resource';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
  TableCellAction,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { PluginPackageSheet } from '@/components/governance/plugin-package-sheet';
import { loadPluginPackages } from '@/components/governance/api';
import {
  ListingBadge,
  PackageStatusBadge,
  PluginSourceSummary,
  ReleaseStatusBadge,
  ReviewBadge,
  SOURCE_KIND_LABELS,
} from '@/components/governance/status';
import type {
  PluginGovernanceStatus,
  PluginPackageSummary,
  PluginReviewStatus,
  PluginSourceKind,
} from '@/components/governance/types';
import { Section } from '@/components/shared';
import { useAsyncResource } from '@/lib/async-resource';
import { formatTime } from '@/lib/types';

type StatusFilter = PluginGovernanceStatus | 'ALL';
type ReviewFilter = PluginReviewStatus | 'ALL';
type SourceFilter = PluginSourceKind | 'ALL';

export function PluginPackagesTab({
  initialReviewStatus,
}: {
  initialReviewStatus?: PluginReviewStatus;
}) {
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusFilter>('ALL');
  const [reviewStatus, setReviewStatus] = useState<ReviewFilter>(initialReviewStatus ?? 'ALL');
  const [sourceKind, setSourceKind] = useState<SourceFilter>('ALL');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [active, setActive] = useState<PluginPackageSummary | null>(null);

  const packages = useAsyncResource(
    (signal) =>
      loadPluginPackages(
        {
          page,
          pageSize,
          search: search || undefined,
          status: status === 'ALL' ? undefined : status,
          reviewStatus: reviewStatus === 'ALL' ? undefined : reviewStatus,
          sourceKind: sourceKind === 'ALL' ? undefined : sourceKind,
        },
        signal
      ),
    [page, pageSize, search, status, reviewStatus, sourceKind],
    { isEmpty: (result) => result.items.length === 0 }
  );

  useEffect(() => {
    if (!packages.data || packages.data.page !== page || packages.data.pageSize !== pageSize)
      return;
    const totalPages = Math.max(1, Math.ceil(packages.data.total / pageSize));
    if (page > totalPages) setPage(totalPages);
  }, [packages.data, page, pageSize]);

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    setPage(1);
    setSearch(searchInput.trim());
  }

  return (
    <Section
      title="插件发行"
      description="按插件包核对发布来源与市场状态，处理审核、下架和恢复。"
      actions={
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={packages.reload}
          disabled={packages.status === 'loading'}
        >
          <RefreshCwIcon className={packages.status === 'loading' ? 'animate-spin' : ''} />
          刷新
        </Button>
      }
    >
      <div className="space-y-4">
        <form
          className="grid gap-2 sm:grid-cols-2 xl:grid-cols-[minmax(16rem,1fr)_10rem_10rem_12rem_auto]"
          onSubmit={submitSearch}
        >
          <div className="relative min-w-0 sm:col-span-2 xl:col-span-1">
            <SearchIcon className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="搜索包名或 Manifest ID"
              className="pl-9"
            />
          </div>
          <Select
            value={reviewStatus}
            onValueChange={(value) => {
              setReviewStatus(value as ReviewFilter);
              setPage(1);
            }}
          >
            <SelectTrigger aria-label="审核状态">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">全部审核状态</SelectItem>
              <SelectItem value="PENDING">待审核</SelectItem>
              <SelectItem value="APPROVED">已通过</SelectItem>
              <SelectItem value="REJECTED">已驳回</SelectItem>
              <SelectItem value="DRAFT">未提交</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={status}
            onValueChange={(value) => {
              setStatus(value as StatusFilter);
              setPage(1);
            }}
          >
            <SelectTrigger aria-label="插件包状态">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">全部包状态</SelectItem>
              <SelectItem value="ACTIVE">正常</SelectItem>
              <SelectItem value="ARCHIVED">已归档</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={sourceKind}
            onValueChange={(value) => {
              setSourceKind(value as SourceFilter);
              setPage(1);
            }}
          >
            <SelectTrigger aria-label="发布来源">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">全部发布来源</SelectItem>
              {Object.entries(SOURCE_KIND_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button type="submit" className="w-full xl:w-auto">
            <SearchIcon />
            查询
          </Button>
        </form>

        <AsyncResource
          status={packages.status}
          error={packages.error}
          retry={packages.reload}
          emptyFallback={
            <div className="flex min-h-40 flex-col items-center justify-center gap-2 border-y py-8 text-sm text-muted-foreground">
              <PackageOpenIcon className="size-6 opacity-60" />
              没有符合条件的插件包
            </div>
          }
        >
          {packages.data && (
            <>
              <Table className="min-w-[52rem]">
                <TableHeader>
                  <TableRow>
                    <TableHead>插件包</TableHead>
                    <TableHead className="hidden md:table-cell">所有者</TableHead>
                    <TableHead className="w-64">最新发行</TableHead>
                    <TableHead>审核</TableHead>
                    <TableHead className="w-44">市场</TableHead>
                    <TableHead className="hidden xl:table-cell">更新时间</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {packages.data.items.map((item: PluginPackageSummary) => (
                    <TableRow key={item.id}>
                      <TableCell>
                        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                          <TableCellAction
                            aria-label={`查看插件包详情：${item.name}`}
                            aria-haspopup="dialog"
                            className="break-words"
                            onClick={() => setActive(item)}
                          >
                            {item.name}
                          </TableCellAction>
                          <PackageStatusBadge value={item.governanceStatus} />
                        </div>
                        <div className="mt-0.5 max-w-72 truncate font-mono text-xs text-muted-foreground">
                          {item.manifestId}
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <div>{item.ownerTeam.name}</div>
                        <div className="text-xs text-muted-foreground">{item.ownerTeam.slug}</div>
                      </TableCell>
                      <TableCell>
                        {item.latestRelease ? (
                          <div className="min-w-0 space-y-1.5">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="font-medium">v{item.latestRelease.version}</span>
                              <ReleaseStatusBadge value={item.latestRelease.status} />
                            </div>
                            <PluginSourceSummary
                              sourceKind={item.latestRelease.sourceKind}
                              sourceLabel={item.latestRelease.sourceLabel}
                              ingestChannel={item.latestRelease.ingestChannel}
                              showPrefix
                            />
                            <div className="text-xs text-muted-foreground">
                              共 {item.releaseCount} 个版本
                            </div>
                          </div>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell>
                        {item.pendingReviewCount > 0 ? (
                          <span className="inline-flex rounded-md bg-amber-100 px-2 py-1 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-200">
                            {item.pendingReviewCount} 待审核
                          </span>
                        ) : item.latestRelease ? (
                          <ReviewBadge value={item.latestRelease.marketReviewStatus} />
                        ) : (
                          <Badge variant="secondary">无发行版</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="space-y-1.5">
                          <ListingBadge status={item.listing?.status ?? null} />
                          {item.listing?.status === 'ACTIVE' && item.marketplaceCurrentVersion ? (
                            <div className="text-xs font-medium text-emerald-700 dark:text-emerald-300">
                              市场当前 v{item.marketplaceCurrentVersion}
                            </div>
                          ) : item.listing?.status === 'DELISTED' &&
                            item.marketplaceCurrentVersion ? (
                            <div className="text-xs text-muted-foreground">
                              下架前版本 v{item.marketplaceCurrentVersion}
                            </div>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="hidden whitespace-nowrap text-muted-foreground xl:table-cell">
                        {formatTime(item.updatedAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <Pagination
                totalItems={packages.data.total}
                pageSize={pageSize}
                currentPage={packages.data.page}
                onPageChange={setPage}
                onPageSizeChange={(size) => {
                  setPageSize(size);
                  setPage(1);
                }}
              />
            </>
          )}
        </AsyncResource>
      </div>

      <PluginPackageSheet
        summary={active}
        open={Boolean(active)}
        onOpenChange={(open) => {
          if (!open) setActive(null);
        }}
        onChanged={packages.reload}
      />
    </Section>
  );
}
