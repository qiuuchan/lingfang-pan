import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { CheckCircleIcon, XCircleIcon, FileTextIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { useLoad, run } from '@/lib/helpers';
import { StatusBadge, Section, InfoGrid, ActionBar } from '@/components/shared';
import { usePagination, Pagination } from '@/components/ui/pagination';
import type { Application } from '@/lib/types';
import { labelOf, formatTime } from '@/lib/types';

export function ApplicationsView() {
  const [items, setItems] = useState<Application[]>([]);
  const load = () =>
    api<{ applications: Application[] }>('/api/admin/team-admin-applications').then((r) => setItems(r.applications));
  useLoad(load);
  const { paginated, page, setPage, pageSize, setPageSize, totalItems } = usePagination(items);

  async function approve(application: Application) {
    await run(
      () =>
        api(`/api/admin/team-admin-applications/${application.id}/approve`, { method: 'POST' }).then(load),
      '申请已通过',
    );
  }

  return (
    <Section title="审批管理" description="处理团队管理员申请，通过或驳回。">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>申请人</TableHead>
            <TableHead>团队</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>理由</TableHead>
            <TableHead className="w-[200px]">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {paginated.length ? (
            paginated.map((app) => (
              <TableRow key={app.id}>
                <TableCell className="font-medium">{app.user.email}</TableCell>
                <TableCell>{app.teamName}</TableCell>
                <TableCell><StatusBadge value={app.status} /></TableCell>
                <TableCell className="max-w-md truncate text-muted-foreground">
                  {app.reason || '—'}
                </TableCell>
                <TableCell>
                  <ActionBar>
                    <AppDetailDialog application={app} onRefresh={load} onApprove={approve}>
                      <Button variant="outline" size="sm">
                        <FileTextIcon className="mr-1 size-3.5" />
                        详情
                      </Button>
                    </AppDetailDialog>
                    {app.status === 'PENDING' && (
                      <Button onClick={() => approve(app)} size="sm">
                        <CheckCircleIcon className="mr-1 size-3.5" />
                        通过
                      </Button>
                    )}
                    {app.status !== 'REJECTED' && (
                      <RejectDialog application={app} onRefresh={load}>
                        <Button variant="destructive" size="sm">
                          <XCircleIcon className="mr-1 size-3.5" />
                          驳回
                        </Button>
                      </RejectDialog>
                    )}
                  </ActionBar>
                </TableCell>
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                暂无申请
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      <Pagination
        totalItems={totalItems}
        pageSize={pageSize}
        currentPage={page}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
      />
    </Section>
  );
}

function AppDetailDialog({
  application,
  children,
  onRefresh,
  onApprove,
}: {
  application: Application;
  children: React.ReactNode;
  onRefresh: () => void;
  onApprove: (app: Application) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>申请详情</DialogTitle>
          <DialogDescription>{application.user.email}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <InfoGrid
            items={[
              ['申请人', `${application.user.displayName}（${application.user.email}）`],
              ['团队名称', application.teamName],
              ['状态', labelOf(application.status)],
              ['提交时间', formatTime(application.createdAt)],
              ['处理时间', formatTime(application.reviewedAt)],
              ['处理人', application.reviewedBy?.email || '—'],
            ]}
          />
          <div className="space-y-2">
            <Label>申请理由</Label>
            <Textarea value={application.reason || '—'} readOnly />
          </div>
        </div>
        <DialogFooter>
          {application.status === 'PENDING' && (
            <Button
              onClick={() => {
                onApprove(application);
                setOpen(false);
              }}
            >
              <CheckCircleIcon className="mr-1 size-3.5" />
              通过
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RejectDialog({
  application,
  children,
  onRefresh,
}: {
  application: Application;
  children: React.ReactNode;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState(application.reviewReason || '');

  async function reject() {
    if (!reason.trim()) return toast.error('请输入驳回原因');
    await run(
      () =>
        api(`/api/admin/team-admin-applications/${application.id}/reject`, {
          method: 'POST',
          body: { reason: reason.trim() },
        }).then(onRefresh),
      '申请已驳回',
    );
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>驳回申请</DialogTitle>
          <DialogDescription>驳回 {application.user.email} 的团队管理员申请。</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <InfoGrid
            items={[
              ['申请人', application.user.email],
              ['团队', application.teamName],
              ['申请理由', application.reason || '—'],
            ]}
          />
          <div className="space-y-2">
            <Label>驳回原因</Label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="请输入驳回原因"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>取消</Button>
          <Button variant="destructive" onClick={reject}>确认驳回</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}