import { useEffect, useRef, useState, type FormEvent } from 'react';
import { CheckCircleIcon, FileTextIcon, Loader2Icon, RefreshCwIcon, SearchIcon, XCircleIcon } from 'lucide-react';
import { toast } from 'sonner';
import { AsyncResource } from '@/components/ui/async-resource';
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
import { Input } from '@/components/ui/input';
import { Pagination } from '@/components/ui/pagination';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableCellAction, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { InfoGrid, Section, StatusBadge } from '@/components/shared';
import {
  approveApplication,
  loadApplication,
  loadApplications,
  rejectApplication,
} from '@/components/governance/api';
import type {
  ApplicationStatus,
  TeamAdminApplicationSummary,
} from '@/components/governance/types';
import { useAsyncResource } from '@/lib/async-resource';
import { useGuardedAction } from '@/lib/helpers';
import { formatTime } from '@/lib/types';

type StatusFilter = ApplicationStatus | 'ALL';

export function ApplicationsTab({ initialStatus }: { initialStatus?: ApplicationStatus }) {
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusFilter>(initialStatus ?? 'ALL');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [active, setActive] = useState<TeamAdminApplicationSummary | null>(null);

  const applications = useAsyncResource(
    (signal) => loadApplications({
      page,
      pageSize,
      q: search || undefined,
      status: status === 'ALL' ? undefined : status,
    }, signal),
    [page, pageSize, search, status],
    { isEmpty: (result) => result.items.length === 0 },
  );

  useEffect(() => {
    if (!applications.data || applications.data.page !== page || applications.data.pageSize !== pageSize) return;
    const totalPages = Math.max(1, Math.ceil(applications.data.total / pageSize));
    if (page > totalPages) setPage(totalPages);
  }, [applications.data, page, pageSize]);

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    setPage(1);
    setSearch(searchInput.trim());
  }

  return (
    <Section
      title="团队管理员申请"
      description="审核团队管理员资格与建团申请。"
      actions={(
        <Button type="button" variant="outline" size="sm" onClick={applications.reload} disabled={applications.status === 'loading'}>
          <RefreshCwIcon className={applications.status === 'loading' ? 'animate-spin' : ''} />
          刷新
        </Button>
      )}
    >
      <div className="space-y-4">
        <form className="grid gap-2 md:grid-cols-[minmax(16rem,1fr)_12rem_auto]" onSubmit={submitSearch}>
          <div className="relative min-w-0">
            <SearchIcon className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="搜索申请人或团队名称"
              className="pl-9"
            />
          </div>
          <Select
            value={status}
            onValueChange={(value) => {
              setStatus(value as StatusFilter);
              setPage(1);
            }}
          >
            <SelectTrigger aria-label="申请状态"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">全部申请状态</SelectItem>
              <SelectItem value="PENDING">待审批</SelectItem>
              <SelectItem value="APPROVED">已通过</SelectItem>
              <SelectItem value="REJECTED">已驳回</SelectItem>
            </SelectContent>
          </Select>
          <Button type="submit"><SearchIcon />查询</Button>
        </form>

        <AsyncResource
          status={applications.status}
          error={applications.error}
          retry={applications.reload}
          emptyFallback={(
            <div className="flex min-h-40 flex-col items-center justify-center gap-2 border-y py-8 text-sm text-muted-foreground">
              <FileTextIcon className="size-6 opacity-60" />
              没有符合条件的申请
            </div>
          )}
        >
          {applications.data && (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>申请人</TableHead>
                    <TableHead>团队</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead className="hidden md:table-cell">提交时间</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {applications.data.items.map((application) => (
                    <TableRow key={application.id}>
                      <TableCell>
                        <TableCellAction
                          aria-label={`查看团队管理员申请：${application.user.email}`}
                          aria-haspopup="dialog"
                          onClick={() => setActive(application)}
                        >
                          {application.user.displayName || application.user.email}
                        </TableCellAction>
                        <div className="mt-0.5 max-w-64 truncate text-xs text-muted-foreground">{application.user.email}</div>
                      </TableCell>
                      <TableCell className="font-medium">{application.teamName}</TableCell>
                      <TableCell><StatusBadge value={application.status} /></TableCell>
                      <TableCell className="hidden whitespace-nowrap text-muted-foreground md:table-cell">
                        {formatTime(application.createdAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <Pagination
                totalItems={applications.data.total}
                pageSize={pageSize}
                currentPage={applications.data.page}
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

      <ApplicationSheet
        summary={active}
        open={Boolean(active)}
        onOpenChange={(open) => {
          if (!open) setActive(null);
        }}
        onChanged={applications.reload}
      />
    </Section>
  );
}

function ApplicationSheet({
  summary,
  open,
  onOpenChange,
  onChanged,
}: {
  summary: TeamAdminApplicationSummary | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  const applicationId = summary?.id ?? '';
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, guard] = useGuardedAction();
  const rejectTriggerRef = useRef<HTMLButtonElement | null>(null);
  const detail = useAsyncResource(
    (signal) => loadApplication(applicationId, signal),
    [applicationId],
    { enabled: open && Boolean(applicationId) },
  );
  const application = detail.data?.application;

  useEffect(() => {
    setRejectOpen(false);
    setReason('');
  }, [applicationId]);

  function refresh() {
    detail.reload();
    onChanged();
  }

  async function approve() {
    await guard(async () => {
      try {
        await approveApplication(applicationId);
        toast.success('申请已通过');
        refresh();
      } catch (error) {
        if ((error as { status?: number })?.status === 409) {
          detail.reload();
          onChanged();
        }
        toast.error(error instanceof Error ? error.message : '审批失败');
      }
    });
  }

  async function reject() {
    const normalized = reason.trim();
    if (!normalized || normalized.length > 500) return;
    await guard(async () => {
      try {
        await rejectApplication(applicationId, normalized);
        toast.success('申请已驳回');
        setRejectOpen(false);
        setReason('');
        refresh();
      } catch (error) {
        if ((error as { status?: number })?.status === 409) {
          detail.reload();
          onChanged();
        }
        toast.error(error instanceof Error ? error.message : '审批失败');
      }
    });
  }

  return (
    <>
      <DetailSheet
        open={open}
        onOpenChange={onOpenChange}
        title={summary?.teamName ?? '申请详情'}
        description={summary?.user.email}
        size="lg"
        footer={application?.status === 'PENDING' ? (
          <div className="flex flex-wrap justify-end gap-2">
            <Button ref={rejectTriggerRef} type="button" variant="outline" onClick={() => setRejectOpen(true)} disabled={busy}>
              <XCircleIcon />驳回
            </Button>
            <Button type="button" onClick={() => void approve()} disabled={busy}>
              {busy ? <Loader2Icon className="animate-spin" /> : <CheckCircleIcon />}
              通过申请
            </Button>
          </div>
        ) : undefined}
      >
        <AsyncResource status={detail.status} error={detail.error} retry={detail.reload}>
          {application && (
            <div className="space-y-5">
              <section className="space-y-2">
                <h3 className="text-sm font-semibold">申请概览</h3>
                <InfoGrid items={[
                  ['申请人', `${application.user.displayName} (${application.user.email})`],
                  ['团队名称', application.teamName],
                  ['状态', <StatusBadge value={application.status} />],
                  ['提交时间', formatTime(application.createdAt)],
                  ['处理时间', formatTime(application.reviewedAt)],
                  ['处理人', application.reviewedBy?.email || '—'],
                ]} />
              </section>
              <section className="space-y-2 border-t pt-5">
                <h3 className="text-sm font-semibold">申请理由</h3>
                <p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground">
                  {application.reason || '未填写'}
                </p>
              </section>
              {application.reviewReason && (
                <section className="space-y-2 border-t pt-5">
                  <h3 className="text-sm font-semibold">处理说明</h3>
                  <p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground">{application.reviewReason}</p>
                </section>
              )}
            </div>
          )}
        </AsyncResource>
      </DetailSheet>

      <Dialog
        open={rejectOpen}
        onOpenChange={(next) => {
          if (!next && !busy) {
            setRejectOpen(false);
            setReason('');
          }
        }}
      >
        <DialogContent
          className="sm:max-w-md"
          onCloseAutoFocus={(event) => {
            const trigger = rejectTriggerRef.current;
            if (!trigger?.isConnected) return;
            event.preventDefault();
            requestAnimationFrame(() => trigger.focus({ preventScroll: true }));
          }}
        >
          <DialogHeader>
            <DialogTitle>驳回申请</DialogTitle>
            <DialogDescription>填写未通过原因。失败时内容会保留，便于修正后重试。</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Textarea
              aria-label="申请驳回原因"
              value={reason}
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
              placeholder="填写原因（1-500 字）"
              rows={4}
            />
            <div className="text-right text-xs text-muted-foreground">{reason.length}/500</div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setRejectOpen(false);
                setReason('');
              }}
              disabled={busy}
            >
              取消
            </Button>
            <Button type="button" variant="destructive" onClick={() => void reject()} disabled={busy || !reason.trim()}>
              {busy && <Loader2Icon className="animate-spin" />}
              确认驳回
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
