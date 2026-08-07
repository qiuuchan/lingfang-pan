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

export function UsersView() {
  const [draftQuery, setDraftQuery] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('ALL');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [selected, setSelected] = useState<UserSummary | null>(null);

  const users = useAsyncResource(
    (signal) =>
      adminCoreApi.users(
        {
          page,
          pageSize,
          q: query || undefined,
          status: status === 'ALL' ? undefined : status,
          platformRole: 'NONE',
        },
        signal
      ),
    [page, pageSize, query, status],
    { isEmpty: (data) => data.items.length === 0 }
  );

  usePageCorrection(users.data, page, pageSize, setPage);

  useEffect(() => {
    if (!selected || !users.data) return;
    const latest = users.data.items.find((user) => user.id === selected.id);
    if (latest) setSelected(latest);
  }, [users.data, selected?.id]);

  function applySearch(event: FormEvent) {
    event.preventDefault();
    setPage(1);
    setQuery(draftQuery.trim());
  }

  return (
    <Section
      title="用户管理"
      description="普通用户账号与访问状态。"
      actions={
        <CreateAccountDialog kind="user" onChanged={users.reload}>
          <Button type="button">
            <PlusIcon className="size-4" />
            创建用户
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
            <SelectTrigger className="w-full sm:w-36" aria-label="用户状态">
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
          status={users.status}
          error={users.error}
          retry={users.reload}
          emptyFallback={
            <div className="py-12 text-center text-sm text-muted-foreground">
              暂无符合条件的普通用户
            </div>
          }
        >
          {users.data ? (
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
                  {users.data.items.map((user) => (
                    <TableRow key={user.id}>
                      <TableCell>
                        <TableCellAction
                          aria-label={`查看用户详情：${user.email}`}
                          aria-haspopup="dialog"
                          onClick={() => setSelected(user)}
                        >
                          <span className="block max-w-48 truncate">{user.email}</span>
                          <span className="mt-0.5 block max-w-48 truncate text-xs font-normal text-muted-foreground sm:hidden">
                            {user.displayName || '—'}
                          </span>
                        </TableCellAction>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        {user.displayName || '—'}
                      </TableCell>
                      <TableCell>
                        <StatusBadge value={user.status} />
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <StatusBadge value={user.platformRole} />
                      </TableCell>
                      <TableCell className="text-right">
                        <EditAccountDialog user={user} kind="user" onChanged={users.reload}>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={`编辑用户：${user.email}`}
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
                totalItems={users.data.total}
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
        mode="user"
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        onChanged={users.reload}
      />
    </Section>
  );
}
