import { useEffect, useState, type FormEvent } from 'react';
import { PencilIcon, PlusIcon, SearchIcon } from 'lucide-react';
import { AsyncResource } from '@/components/ui/async-resource';
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
import { Section, StatusBadge } from '@/components/shared';
import { adminCoreApi } from '@/components/admin-core/api';
import { usePageCorrection } from '@/components/admin-core/pagination';
import {
  CreateAccountDialog,
  EditAccountDialog,
} from '@/components/admin-core/user-account-dialogs';
import { UserDetailSheet } from '@/components/admin-core/user-detail-sheet';
import type { UserSummary } from '@/components/admin-core/types';
import { useAsyncResource } from '@/lib/async-resource';
import type { UserStatus } from '@/lib/types';

type StatusFilter = 'ALL' | UserStatus;

export function AdminsView() {
  const [draftQuery, setDraftQuery] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('ALL');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [selected, setSelected] = useState<UserSummary | null>(null);

  const admins = useAsyncResource(
    (signal) =>
      adminCoreApi.users(
        {
          page,
          pageSize,
          q: query || undefined,
          status: status === 'ALL' ? undefined : status,
          platformRole: 'PLATFORM_ADMIN',
        },
        signal
      ),
    [page, pageSize, query, status],
    { isEmpty: (data) => data.items.length === 0 }
  );

  usePageCorrection(admins.data, page, pageSize, setPage);

  useEffect(() => {
    if (!selected || !admins.data) return;
    const latest = admins.data.items.find((admin) => admin.id === selected.id);
    if (latest) setSelected(latest);
  }, [admins.data, selected?.id]);

  function applySearch(event: FormEvent) {
    event.preventDefault();
    setPage(1);
    setQuery(draftQuery.trim());
  }

  return (
    <Section
      title="平台管理员"
      description="平台管理员账号与操作记录。"
      actions={
        <CreateAccountDialog kind="admin" onChanged={admins.reload}>
          <Button type="button">
            <PlusIcon className="size-4" />
            创建管理员
          </Button>
        </CreateAccountDialog>
      }
    >
      <div className="space-y-4">
        <form className="flex flex-col gap-2 sm:flex-row" onSubmit={applySearch}>
          <div className="relative min-w-0 flex-1 sm:max-w-sm">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={draftQuery}
              onChange={(event) => setDraftQuery(event.target.value)}
              placeholder="搜索邮箱或显示名"
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
            <SelectTrigger className="w-full sm:w-36" aria-label="管理员状态">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">全部状态</SelectItem>
              <SelectItem value="ACTIVE">正常</SelectItem>
              <SelectItem value="DISABLED">已禁用</SelectItem>
            </SelectContent>
          </Select>
          <Button type="submit" variant="outline">
            <SearchIcon className="size-4" />
            搜索
          </Button>
        </form>

        <AsyncResource
          status={admins.status}
          error={admins.error}
          retry={admins.reload}
          emptyFallback={
            <div className="py-12 text-center text-sm text-muted-foreground">
              暂无符合条件的平台管理员
            </div>
          }
        >
          {admins.data ? (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>邮箱</TableHead>
                    <TableHead className="hidden sm:table-cell">显示名</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead className="hidden md:table-cell">角色</TableHead>
                    <TableHead className="w-24 text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {admins.data.items.map((admin) => (
                    <TableRow key={admin.id}>
                      <TableCell>
                        <TableCellAction
                          aria-label={`查看管理员详情：${admin.email}`}
                          aria-haspopup="dialog"
                          onClick={() => setSelected(admin)}
                        >
                          <span className="block max-w-48 truncate">{admin.email}</span>
                          <span className="mt-0.5 block max-w-48 truncate text-xs font-normal text-muted-foreground sm:hidden">
                            {admin.displayName || '—'}
                          </span>
                        </TableCellAction>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        {admin.displayName || '—'}
                      </TableCell>
                      <TableCell>
                        <StatusBadge value={admin.status} />
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <StatusBadge value={admin.platformRole} />
                      </TableCell>
                      <TableCell className="text-right">
                        <EditAccountDialog user={admin} kind="admin" onChanged={admins.reload}>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={`编辑管理员：${admin.email}`}
                          >
                            <PencilIcon className="size-4" />
                          </Button>
                        </EditAccountDialog>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <Pagination
                totalItems={admins.data.total}
                pageSize={pageSize}
                currentPage={page}
                onPageChange={setPage}
                onPageSizeChange={setPageSize}
              />
            </>
          ) : null}
        </AsyncResource>
      </div>

      <UserDetailSheet
        user={selected}
        mode="admin"
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        onChanged={admins.reload}
      />
    </Section>
  );
}
