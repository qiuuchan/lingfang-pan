import { useState } from 'react';
import { ClockIcon, RefreshCwIcon } from 'lucide-react';
import { AsyncResource } from '@/components/ui/async-resource';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableCellAction, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { PluginPackageSheet } from '@/components/governance/plugin-package-sheet';
import { loadPendingReleases } from '@/components/governance/api';
import { ReleaseStatusBadge, SOURCE_KIND_LABELS, ingestChannelLabel } from '@/components/governance/status';
import type { PendingReleaseItem, PluginPackageSummary } from '@/components/governance/types';
import { Section } from '@/components/shared';
import { useAsyncResource } from '@/lib/async-resource';
import { formatTime } from '@/lib/types';

/**
 * v4 待审核发行版直列页（release 视角）。
 * 消费 GET /api/admin/plugin-releases/review-pending，列出所有 marketReviewStatus=PENDING 的发行版，
 * 点行进入插件包抽屉并预选该 release，可直接 approve/reject。
 *
 * 与 PluginPackagesTab（包视角）互补：这里是跨包的审核队列。
 */
export function PendingReleasesTab() {
  const pending = useAsyncResource(
    (signal) => loadPendingReleases(signal),
    [],
    { isEmpty: (result) => result.items.length === 0 },
  );
  const [active, setActive] = useState<PendingReleaseItem | null>(null);

  return (
    <Section
      title="待审核发行版"
      description="所有提交市场审核的 v4 插件发行版（marketReviewStatus = PENDING）。点行进入审批。"
      actions={(
        <Button type="button" variant="outline" size="sm" onClick={pending.reload} disabled={pending.status === 'loading'}>
          <RefreshCwIcon className={pending.status === 'loading' ? 'animate-spin' : ''} />
          刷新
        </Button>
      )}
    >
      <AsyncResource
        status={pending.status}
        error={pending.error}
        retry={pending.reload}
        emptyFallback={(
          <div className="flex min-h-40 flex-col items-center justify-center gap-2 border-y py-8 text-sm text-muted-foreground">
            <ClockIcon className="size-6 opacity-60" />
            暂无待审核发行版
          </div>
        )}
      >
        {pending.data && (
          <Table className="min-w-[44rem]">
            <TableHeader>
              <TableRow>
                <TableHead>插件包</TableHead>
                <TableHead className="w-40">发行版本</TableHead>
                <TableHead className="hidden md:table-cell">发布来源</TableHead>
                <TableHead className="hidden lg:table-cell">AI 政策</TableHead>
                <TableHead className="hidden xl:table-cell">提交时间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pending.data.items.map((item) => (
                <TableRow key={`${item.package.id}:${item.release.id}`}>
                  <TableCell>
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <TableCellAction
                        aria-label={`审核插件包：${item.package.name} v${item.release.version}`}
                        aria-haspopup="dialog"
                        className="break-words"
                        onClick={() => setActive(item)}
                      >
                        {item.package.name}
                      </TableCellAction>
                    </div>
                    <div className="mt-0.5 max-w-72 truncate font-mono text-xs text-muted-foreground">
                      {item.package.manifestId}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      团队 {item.package.ownerTeamId.slice(0, 8)}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium">v{item.release.version}</span>
                      <ReleaseStatusBadge value={item.release.status} />
                    </div>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <div className="text-sm">{SOURCE_KIND_LABELS[item.release.sourceKind] ?? item.release.sourceKind}</div>
                    <div className="text-xs text-muted-foreground">{ingestChannelLabel(item.release.ingestChannel)}</div>
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
                    {item.release.aiPolicyStatus === 'PASSED' ? (
                      <Badge variant="secondary" className="gap-1">政策通过</Badge>
                    ) : (
                      <Badge variant="destructive">{item.release.aiPolicyStatus || '未检查'}</Badge>
                    )}
                  </TableCell>
                  <TableCell className="hidden whitespace-nowrap text-muted-foreground xl:table-cell">
                    {formatTime(item.release.createdAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </AsyncResource>

      <PluginPackageSheet
        summary={active ? ({ id: active.package.id, name: active.package.name, manifestId: active.package.manifestId } as unknown as PluginPackageSummary) : null}
        initialReleaseId={active?.release.id ?? null}
        open={Boolean(active)}
        onOpenChange={(open) => {
          if (!open) setActive(null);
        }}
        onChanged={pending.reload}
      />
    </Section>
  );
}
