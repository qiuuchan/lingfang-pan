import { useEffect, useState, type FormEvent } from 'react';
import { PlusIcon, SearchIcon } from 'lucide-react';
import { AsyncResource } from '@/components/ui/async-resource';
import { Button } from '@/components/ui/button';
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
import { Section, StatusBadge } from '@/components/shared';
import { adminCoreApi } from '@/components/admin-core/api';
import { usePageCorrection } from '@/components/admin-core/pagination';
import { CreateTeamDialog } from '@/components/admin-core/team-dialogs';
import { TeamDetailSheet } from '@/components/admin-core/team-detail-sheet';
import type { TeamSummary } from '@/components/admin-core/types';
import { useAsyncResource } from '@/lib/async-resource';
import type { TeamStatus } from '@/lib/types';
import { money } from '@/lib/utils';

type StatusFilter = 'ALL' | TeamStatus;

export function TeamsView() {
  const [draftQuery, setDraftQuery] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('ALL');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [selected, setSelected] = useState<TeamSummary | null>(null);

  const teams = useAsyncResource(
    (signal) => adminCoreApi.teams({
      page,
      pageSize,
      q: query || undefined,
      status: status === 'ALL' ? undefined : status,
    }, signal),
    [page, pageSize, query, status],
    { isEmpty: (data) => data.items.length === 0 },
  );

  usePageCorrection(teams.data, page, pageSize, setPage);

  useEffect(() => {
    if (!selected || !teams.data) return;
    const latest = teams.data.items.find((team) => team.id === selected.id);
    if (latest) setSelected(latest);
  }, [teams.data, selected?.id]);

  function applySearch(event: FormEvent) {
    event.preventDefault();
    setPage(1);
    setQuery(draftQuery.trim());
  }

  return (
    <Section
      title="团队管理"
      description="团队资料、成员、角色和余额。"
      actions={(
        <CreateTeamDialog onChanged={teams.reload}>
          <Button type="button">
            <PlusIcon className="size-4" />
            创建团队
          </Button>
        </CreateTeamDialog>
      )}
    >
      <div className="space-y-4">
        <form className="flex flex-col gap-2 sm:flex-row" onSubmit={applySearch}>
          <div className="relative min-w-0 flex-1 sm:max-w-sm">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={draftQuery}
              onChange={(event) => setDraftQuery(event.target.value)}
              placeholder="搜索团队名称或 Slug"
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
            <SelectTrigger className="w-full sm:w-36" aria-label="团队状态">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">全部状态</SelectItem>
              <SelectItem value="ACTIVE">正常</SelectItem>
              <SelectItem value="SUSPENDED">已停用</SelectItem>
            </SelectContent>
          </Select>
          <Button type="submit" variant="outline">
            <SearchIcon className="size-4" />
            搜索
          </Button>
        </form>

        <AsyncResource
          status={teams.status}
          error={teams.error}
          retry={teams.reload}
          emptyFallback={<div className="py-12 text-center text-sm text-muted-foreground">暂无符合条件的团队</div>}
        >
          {teams.data ? (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="whitespace-nowrap">团队</TableHead>
                    <TableHead className="hidden sm:table-cell">Slug</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead className="hidden md:table-cell">余额</TableHead>
                    <TableHead className="hidden md:table-cell">成员</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {teams.data.items.map((team) => (
                    <TableRow key={team.id}>
                      <TableCell>
                        <TableCellAction
                          aria-label={`查看团队详情：${team.name}`}
                          aria-haspopup="dialog"
                          onClick={() => setSelected(team)}
                        >
                          <span className="block whitespace-nowrap">{team.name}</span>
                          <span className="mt-0.5 block max-w-44 truncate font-mono text-xs font-normal text-muted-foreground sm:hidden">
                            {team.slug}
                          </span>
                        </TableCellAction>
                      </TableCell>
                      <TableCell className="hidden font-mono text-xs sm:table-cell">{team.slug}</TableCell>
                      <TableCell><StatusBadge value={team.status} /></TableCell>
                      <TableCell className="hidden font-medium md:table-cell">{money(team.balanceCents)}</TableCell>
                      <TableCell className="hidden md:table-cell">{team.memberCount}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <Pagination
                totalItems={teams.data.total}
                pageSize={pageSize}
                currentPage={page}
                onPageChange={setPage}
                onPageSizeChange={setPageSize}
              />
            </>
          ) : null}
        </AsyncResource>
      </div>

      <TeamDetailSheet
        team={selected}
        onOpenChange={(open) => { if (!open) setSelected(null); }}
        onChanged={teams.reload}
      />
    </Section>
  );
}
