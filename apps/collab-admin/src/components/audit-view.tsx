import { useEffect, useState, type FormEvent } from 'react';
import { FileClockIcon, RefreshCwIcon, SearchIcon } from 'lucide-react';
import { AsyncResource } from '@/components/ui/async-resource';
import { Button } from '@/components/ui/button';
import { DetailSheet } from '@/components/ui/detail-sheet';
import { Input } from '@/components/ui/input';
import { Pagination } from '@/components/ui/pagination';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableCellAction,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { InfoGrid, Section } from '@/components/shared';
import { api } from '@/lib/api';
import { useAsyncResource } from '@/lib/async-resource';
import type { AuditCategoryKey } from '@/lib/types';
import {
  AUDIT_CATEGORIES,
  actionLabel,
  auditCategory,
  categoryLabel,
  formatTime,
  localizeMetadata,
  targetLabel,
} from '@/lib/types';

type CategoryFilter = AuditCategoryKey | 'ALL';

type AuditActorSummary = {
  id: string;
  email: string;
  displayName: string;
};

type AuditLogSummary = {
  id: string;
  action: string;
  targetType: string;
  targetId: string | null;
  createdAt: string;
  actor: AuditActorSummary | null;
};

type AuditLogDetail = AuditLogSummary & {
  metadata: unknown;
};

type AuditLogPage = {
  items: AuditLogSummary[];
  total: number;
  page: number;
  pageSize: number;
};

function auditListPath({
  page,
  pageSize,
  category,
  query,
}: {
  page: number;
  pageSize: number;
  category: CategoryFilter;
  query: string;
}) {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (category !== 'ALL') params.set('category', category);
  if (query) params.set('q', query);
  return `/api/admin/audit-logs?${params.toString()}`;
}

export function AuditView() {
  const [queryInput, setQueryInput] = useState('');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<CategoryFilter>('ALL');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [active, setActive] = useState<AuditLogSummary | null>(null);

  const logs = useAsyncResource(
    (signal) => api<AuditLogPage>(auditListPath({ page, pageSize, category, query }), { signal }),
    [page, pageSize, category, query],
    { isEmpty: (result) => result.items.length === 0 },
  );

  useEffect(() => {
    if (!logs.data || logs.data.page !== page || logs.data.pageSize !== pageSize) return;
    const totalPages = Math.max(1, Math.ceil(logs.data.total / pageSize));
    if (page > totalPages) setPage(totalPages);
  }, [logs.data, page, pageSize]);

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    setPage(1);
    setQuery(queryInput.trim());
  }

  return (
    <Section
      title="审计日志"
      description="平台级操作记录。列表保持轻量，完整元数据仅在打开单条记录后加载。"
      actions={(
        <Button type="button" variant="outline" size="sm" onClick={logs.reload} disabled={logs.status === 'loading'}>
          <RefreshCwIcon className={logs.status === 'loading' ? 'animate-spin' : ''} />
          刷新
        </Button>
      )}
    >
      <div className="space-y-4">
        <form className="grid gap-2 sm:grid-cols-[minmax(16rem,1fr)_11rem_auto]" onSubmit={submitSearch}>
          <div className="relative min-w-0">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={queryInput}
              onChange={(event) => setQueryInput(event.target.value)}
              placeholder="搜索动作、操作者邮箱或对象 ID"
              className="pl-9"
            />
          </div>
          <Select
            value={category}
            onValueChange={(value) => {
              setCategory(value as CategoryFilter);
              setPage(1);
            }}
          >
            <SelectTrigger aria-label="审计分类"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">全部分类</SelectItem>
              {AUDIT_CATEGORIES.map((item) => (
                <SelectItem key={item.key} value={item.key}>{item.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button type="submit"><SearchIcon />查询</Button>
        </form>

        <AsyncResource
          status={logs.status}
          error={logs.error}
          retry={logs.reload}
          emptyFallback={(
            <div className="flex min-h-40 flex-col items-center justify-center gap-2 border-y py-8 text-sm text-muted-foreground">
              <FileClockIcon className="size-6 opacity-60" />
              没有符合条件的审计记录
            </div>
          )}
        >
          {logs.data && (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>动作</TableHead>
                    <TableHead className="hidden sm:table-cell">分类</TableHead>
                    <TableHead>对象</TableHead>
                    <TableHead className="hidden md:table-cell">操作者</TableHead>
                    <TableHead className="hidden lg:table-cell">时间</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {logs.data.items.map((log) => (
                    <TableRow key={log.id}>
                      <TableCell>
                        <TableCellAction
                          aria-label={`查看审计详情：${actionLabel(log.action)}`}
                          aria-haspopup="dialog"
                          onClick={() => setActive(log)}
                        >
                          {actionLabel(log.action)}
                        </TableCellAction>
                        <div className="mt-0.5 max-w-72 truncate font-mono text-xs text-muted-foreground">{log.action}</div>
                      </TableCell>
                      <TableCell className="hidden text-muted-foreground sm:table-cell">
                        {categoryLabel(auditCategory(log.action))}
                      </TableCell>
                      <TableCell>
                        <div>{targetLabel(log.targetType)}</div>
                        <div className="max-w-48 truncate font-mono text-xs text-muted-foreground">{log.targetId || '—'}</div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">{log.actor?.email || '系统'}</TableCell>
                      <TableCell className="hidden whitespace-nowrap text-muted-foreground lg:table-cell">
                        {formatTime(log.createdAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <Pagination
                totalItems={logs.data.total}
                pageSize={pageSize}
                currentPage={logs.data.page}
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

      <AuditDetailSheet
        summary={active}
        open={Boolean(active)}
        onOpenChange={(open) => {
          if (!open) setActive(null);
        }}
      />
    </Section>
  );
}

function AuditDetailSheet({
  summary,
  open,
  onOpenChange,
}: {
  summary: AuditLogSummary | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const logId = summary?.id ?? '';
  const detail = useAsyncResource(
    (signal) => api<{ log: AuditLogDetail }>(`/api/admin/audit-logs/${encodeURIComponent(logId)}`, { signal }),
    [logId],
    { enabled: open && Boolean(logId) },
  );
  const log = detail.data?.log;

  return (
    <DetailSheet
      open={open}
      onOpenChange={onOpenChange}
      title={summary ? actionLabel(summary.action) : '审计详情'}
      description={summary?.action}
      size="lg"
    >
      <AsyncResource status={detail.status} error={detail.error} retry={detail.reload}>
        {log && (
          <div className="space-y-5">
            <section className="space-y-2">
              <h3 className="text-sm font-semibold">记录概览</h3>
              <InfoGrid items={[
                ['分类', categoryLabel(auditCategory(log.action))],
                ['对象', targetLabel(log.targetType)],
                ['对象 ID', <span className="font-mono text-xs">{log.targetId || '—'}</span>],
                ['操作者', log.actor ? `${log.actor.displayName} (${log.actor.email})` : '系统'],
                ['时间', formatTime(log.createdAt)],
              ]} />
            </section>
            <section className="space-y-2 border-t pt-5">
              <h3 className="text-sm font-semibold">元数据</h3>
              <pre className="max-h-[32rem] overflow-auto rounded-lg border bg-muted/30 p-3 text-xs leading-5 scrollbar-thin">
                {JSON.stringify(localizeMetadata(log.metadata), null, 2)}
              </pre>
            </section>
          </div>
        )}
      </AsyncResource>
    </DetailSheet>
  );
}
