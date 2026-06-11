import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EyeIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { useLoad } from '@/lib/helpers';
import { Section } from '@/components/shared';
import { usePagination, Pagination } from '@/components/ui/pagination';
import type { AuditLog } from '@/lib/types';
import { actionLabel, targetLabel, formatTime, localizeMetadata } from '@/lib/types';

export function AuditView() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  useLoad(() => api<{ logs: AuditLog[] }>('/api/admin/audit-logs').then((r) => setLogs(r.logs)));
  const { paginated, page, setPage, pageSize, setPageSize, totalItems } = usePagination(logs, 20);

  return (
    <Section title="审计日志" description="平台级操作记录，含中文动作和对象展示。">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>动作</TableHead>
            <TableHead>对象</TableHead>
            <TableHead>操作者</TableHead>
            <TableHead>时间</TableHead>
            <TableHead className="w-[100px]">详情</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {paginated.length ? (
            paginated.map((log) => (
              <TableRow key={log.id}>
                <TableCell>{actionLabel(log.action)}</TableCell>
                <TableCell>{targetLabel(log.targetType)}</TableCell>
                <TableCell>{log.actor?.email || '系统'}</TableCell>
                <TableCell>{formatTime(log.createdAt)}</TableCell>
                <TableCell>
                  <AuditDetailDialog log={log}>
                    <Button variant="ghost" size="icon" className="size-8">
                      <EyeIcon className="size-4" />
                    </Button>
                  </AuditDetailDialog>
                </TableCell>
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                暂无审计日志
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

function AuditDetailDialog({ log, children }: { log: AuditLog; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>审计详情</DialogTitle>
          <DialogDescription>{actionLabel(log.action)}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid gap-1 rounded-xl border bg-muted/20 p-3 text-sm">
            <div className="grid gap-1 sm:grid-cols-[80px_1fr]">
              <span className="text-muted-foreground">动作码</span>
              <span className="font-mono text-xs text-foreground">{log.action}</span>
            </div>
            <div className="grid gap-1 sm:grid-cols-[80px_1fr]">
              <span className="text-muted-foreground">对象</span>
              <span className="text-foreground">{targetLabel(log.targetType)}</span>
            </div>
            <div className="grid gap-1 sm:grid-cols-[80px_1fr]">
              <span className="text-muted-foreground">ID</span>
              <span className="font-mono text-xs text-foreground">{log.targetId || '—'}</span>
            </div>
            <div className="grid gap-1 sm:grid-cols-[80px_1fr]">
              <span className="text-muted-foreground">操作者</span>
              <span className="text-foreground">{log.actor?.email || '系统'}</span>
            </div>
            <div className="grid gap-1 sm:grid-cols-[80px_1fr]">
              <span className="text-muted-foreground">时间</span>
              <span className="text-foreground">{formatTime(log.createdAt)}</span>
            </div>
          </div>
          <div className="space-y-2">
            <div className="text-sm font-medium">元数据</div>
            <pre className="max-h-60 overflow-auto rounded-xl bg-muted p-3 text-xs text-muted-foreground">
              {JSON.stringify(localizeMetadata(log.metadata), null, 2)}
            </pre>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}