import { useEffect, useState, type FormEvent } from 'react';
import {
  BanknoteIcon,
  LockIcon,
  PencilIcon,
  PlusIcon,
  PowerIcon,
  SearchIcon,
  Trash2Icon,
  UserPlusIcon,
} from 'lucide-react';
import { AsyncResource } from '@/components/ui/async-resource';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DetailSheet } from '@/components/ui/detail-sheet';
import { Input } from '@/components/ui/input';
import { Pagination } from '@/components/ui/pagination';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { InfoGrid, StatusBadge } from '@/components/shared';
import { adminCoreApi } from '@/components/admin-core/api';
import { LazyRoleEditor } from '@/components/admin-core/lazy-role-editor';
import { usePageCorrection } from '@/components/admin-core/pagination';
import {
  AssignTeamAdminDialog,
  BalanceAdjustmentDialog,
  EditTeamDialog,
} from '@/components/admin-core/team-dialogs';
import type { RoleSummary, TeamMemberEntry, TeamSummary } from '@/components/admin-core/types';
import { useAsyncResource } from '@/lib/async-resource';
import { api } from '@/lib/api';
import { run } from '@/lib/helpers';
import type { TeamStatus } from '@/lib/types';
import { formatTime, labelOf } from '@/lib/types';
import { money } from '@/lib/utils';

type TeamTab = 'overview' | 'members' | 'roles' | 'plugins' | 'purchases' | 'ledger';
type VisitedTeamTabs = { teamId: string; tabs: Set<TeamTab> };
type RoleEditorState = { teamId: string; role?: RoleSummary } | null;

const PAGE_SIZE = 10;

export function TeamDetailSheet({
  team,
  onOpenChange,
  onChanged,
}: {
  team: TeamSummary | null;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  const teamId = team?.id ?? '';
  const [tab, setTab] = useState<TeamTab>('overview');
  const [visitedState, setVisitedState] = useState<VisitedTeamTabs>({
    teamId,
    tabs: new Set(['overview']),
  });
  const [membersPage, setMembersPage] = useState(1);
  const [membersDraftQuery, setMembersDraftQuery] = useState('');
  const [membersQuery, setMembersQuery] = useState('');
  const [rolesPage, setRolesPage] = useState(1);
  const [pluginsPage, setPluginsPage] = useState(1);
  const [purchasesPage, setPurchasesPage] = useState(1);
  const [ledgerPage, setLedgerPage] = useState(1);
  const [roleOptionsTeamId, setRoleOptionsTeamId] = useState('');
  const [roleEditor, setRoleEditor] = useState<RoleEditorState>(null);

  useEffect(() => {
    setTab('overview');
    setVisitedState({ teamId, tabs: new Set(['overview']) });
    setMembersPage(1);
    setMembersDraftQuery('');
    setMembersQuery('');
    setRolesPage(1);
    setPluginsPage(1);
    setPurchasesPage(1);
    setLedgerPage(1);
    setRoleOptionsTeamId('');
    setRoleEditor(null);
  }, [teamId]);

  const overview = useAsyncResource((signal) => adminCoreApi.teamDetail(teamId, signal), [teamId], {
    enabled: !!teamId,
  });
  const members = useAsyncResource(
    (signal) => adminCoreApi.teamMembers(teamId, membersPage, PAGE_SIZE, membersQuery, signal),
    [teamId, membersPage, membersQuery],
    {
      enabled: !!teamId && visitedState.teamId === teamId && visitedState.tabs.has('members'),
      isEmpty: (data) => data.items.length === 0,
    }
  );
  const roles = useAsyncResource(
    (signal) => adminCoreApi.teamRoles(teamId, rolesPage, PAGE_SIZE, signal),
    [teamId, rolesPage],
    {
      enabled: !!teamId && visitedState.teamId === teamId && visitedState.tabs.has('roles'),
      isEmpty: (data) => data.items.length === 0,
    }
  );
  const roleOptions = useAsyncResource(
    (signal) => adminCoreApi.teamRoles(teamId, 1, 50, signal),
    [teamId],
    {
      enabled: !!teamId && roleOptionsTeamId === teamId,
      isEmpty: (data) => data.items.length === 0,
    }
  );
  const plugins = useAsyncResource(
    (signal) => adminCoreApi.teamPlugins(teamId, pluginsPage, PAGE_SIZE, signal),
    [teamId, pluginsPage],
    {
      enabled: !!teamId && visitedState.teamId === teamId && visitedState.tabs.has('plugins'),
      isEmpty: (data) => data.items.length === 0,
    }
  );
  const purchases = useAsyncResource(
    (signal) => adminCoreApi.teamPurchases(teamId, purchasesPage, PAGE_SIZE, signal),
    [teamId, purchasesPage],
    {
      enabled: !!teamId && visitedState.teamId === teamId && visitedState.tabs.has('purchases'),
      isEmpty: (data) => data.items.length === 0,
    }
  );
  const ledger = useAsyncResource(
    (signal) => adminCoreApi.teamLedger(teamId, ledgerPage, PAGE_SIZE, signal),
    [teamId, ledgerPage],
    {
      enabled: !!teamId && visitedState.teamId === teamId && visitedState.tabs.has('ledger'),
      isEmpty: () => false,
    }
  );

  usePageCorrection(members.data, membersPage, PAGE_SIZE, setMembersPage);
  usePageCorrection(roles.data, rolesPage, PAGE_SIZE, setRolesPage);
  usePageCorrection(plugins.data, pluginsPage, PAGE_SIZE, setPluginsPage);
  usePageCorrection(purchases.data, purchasesPage, PAGE_SIZE, setPurchasesPage);
  usePageCorrection(ledger.data, ledgerPage, PAGE_SIZE, setLedgerPage);

  const currentTeam: TeamSummary | null =
    overview.data?.team.id === teamId
      ? {
          ...overview.data.team,
          memberCount: overview.data.memberCount,
          pluginCount: overview.data.pluginCount,
        }
      : null;

  function selectTab(value: string) {
    const nextTab = value as TeamTab;
    setTab(nextTab);
    setVisitedState((current) => {
      const currentTabs = current.teamId === teamId ? current.tabs : new Set<TeamTab>(['overview']);
      if (current.teamId === teamId && currentTabs.has(nextTab)) return current;
      const next = new Set(currentTabs);
      next.add(nextTab);
      return { teamId, tabs: next };
    });
  }

  function refreshCore() {
    onChanged();
    overview.reload();
  }

  function refreshMembers() {
    onChanged();
    members.reload();
    if (visitedState.teamId === teamId && visitedState.tabs.has('roles')) roles.reload();
    if (roleOptionsTeamId === teamId) roleOptions.reload();
    overview.reload();
  }

  function refreshBalance() {
    refreshCore();
    if (visitedState.teamId === teamId && visitedState.tabs.has('ledger')) ledger.reload();
  }

  async function toggleStatus() {
    if (!currentTeam) return;
    const status: TeamStatus = currentTeam.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE';
    if (status === 'SUSPENDED' && !window.confirm(`确认停用团队「${currentTeam.name}」？`)) return;
    const ok = await run(
      () => api(`/api/admin/teams/${currentTeam.id}/status`, { method: 'PATCH', body: { status } }),
      status === 'SUSPENDED' ? '团队已停用' : '团队已启用'
    );
    if (ok) refreshCore();
  }

  function searchMembers(event: FormEvent) {
    event.preventDefault();
    setMembersPage(1);
    setMembersQuery(membersDraftQuery.trim());
  }

  async function changeMemberRole(member: TeamMemberEntry, roleId: string) {
    if (member.status !== 'ACTIVE' || member.teamRoleId === roleId) return;
    const ok = await run(
      () =>
        api(`/api/admin/teams/${teamId}/members/${member.userId}/role`, {
          method: 'PATCH',
          body: { roleId },
        }),
      '成员角色已更新'
    );
    if (ok) refreshMembers();
  }

  async function revokeAdmin(member: TeamMemberEntry) {
    if (!window.confirm(`确认撤销 ${member.user.email} 的团队管理员权限？`)) return;
    const ok = await run(
      () => api(`/api/admin/teams/${teamId}/admins/${member.userId}`, { method: 'DELETE' }),
      '团队管理员已撤销'
    );
    if (ok) refreshMembers();
  }

  async function deleteRole(role: RoleSummary) {
    if (!window.confirm(`确认删除角色「${role.name}」？`)) return;
    const ok = await run(
      () => api(`/api/admin/teams/${teamId}/roles/${role.id}`, { method: 'DELETE' }),
      '角色已删除'
    );
    if (!ok) return;
    roles.reload();
    if (roleOptionsTeamId === teamId) roleOptions.reload();
    overview.reload();
  }

  return (
    <DetailSheet
      open={!!team}
      onOpenChange={onOpenChange}
      title={team?.name || ''}
      description={team?.slug}
      size="xl"
      footer={
        currentTeam ? (
          <div className="grid gap-2 sm:grid-cols-3">
            <EditTeamDialog team={currentTeam} onChanged={refreshCore}>
              <Button type="button" variant="outline" className="w-full">
                <PencilIcon className="size-4" />
                编辑资料
              </Button>
            </EditTeamDialog>
            <BalanceAdjustmentDialog team={currentTeam} onChanged={refreshBalance}>
              <Button type="button" variant="outline" className="w-full">
                <BanknoteIcon className="size-4" />
                调整余额
              </Button>
            </BalanceAdjustmentDialog>
            <Button
              type="button"
              variant={currentTeam.status === 'ACTIVE' ? 'destructive' : 'default'}
              onClick={() => void toggleStatus()}
            >
              <PowerIcon className="size-4" />
              {currentTeam.status === 'ACTIVE' ? '停用团队' : '启用团队'}
            </Button>
          </div>
        ) : null
      }
    >
      {team ? (
        <Tabs value={tab} onValueChange={selectTab}>
          <TabsList className="flex w-full justify-start overflow-x-auto">
            <TabsTrigger value="overview">概览</TabsTrigger>
            <TabsTrigger value="members">成员</TabsTrigger>
            <TabsTrigger value="roles">角色</TabsTrigger>
            <TabsTrigger value="plugins">插件</TabsTrigger>
            <TabsTrigger value="purchases">购买</TabsTrigger>
            <TabsTrigger value="ledger">流水</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="space-y-4 pt-3">
            <AsyncResource status={overview.status} error={overview.error} retry={overview.reload}>
              {overview.data ? (
                <>
                  <InfoGrid
                    items={[
                      ['团队 ID', overview.data.team.id],
                      ['Slug', overview.data.team.slug],
                      ['状态', <StatusBadge key="status" value={overview.data.team.status} />],
                      ['当前余额', money(overview.data.team.balanceCents)],
                      ['成员', String(overview.data.memberCount)],
                      ['角色', String(overview.data.roleCount)],
                      ['插件', String(overview.data.pluginCount)],
                      ['购买记录', String(overview.data.purchaseCount)],
                      ['创建时间', formatTime(overview.data.team.createdAt)],
                    ]}
                  />
                  <InfoGrid
                    items={[
                      ['累计入账', money(overview.data.ledgerSummary.totalCreditCents)],
                      ['累计扣减', money(overview.data.ledgerSummary.totalDebitCents)],
                      ['净流入', money(overview.data.ledgerSummary.netCents)],
                    ]}
                  />
                  {overview.data.team.description ? (
                    <div className="rounded-lg border px-3 py-3 text-sm whitespace-pre-wrap break-words">
                      {overview.data.team.description}
                    </div>
                  ) : null}
                </>
              ) : null}
            </AsyncResource>
          </TabsContent>

          <TabsContent value="members" className="space-y-3 pt-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <form className="flex min-w-0 flex-1 gap-2" onSubmit={searchMembers}>
                <div className="relative min-w-0 flex-1">
                  <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={membersDraftQuery}
                    onChange={(event) => setMembersDraftQuery(event.target.value)}
                    placeholder="搜索成员"
                    className="pl-9"
                  />
                </div>
                <Button type="submit" variant="outline">
                  搜索
                </Button>
              </form>
              {currentTeam ? (
                <AssignTeamAdminDialog team={currentTeam} onChanged={refreshMembers}>
                  <Button type="button" size="sm">
                    <UserPlusIcon className="size-4" />
                    指定管理员
                  </Button>
                </AssignTeamAdminDialog>
              ) : null}
            </div>
            <AsyncResource
              status={members.status}
              error={members.error}
              retry={members.reload}
              emptyFallback={<EmptyState label="暂无符合条件的成员" />}
            >
              {members.data ? (
                <PagedStack total={members.data.total} page={membersPage} setPage={setMembersPage}>
                  {members.data.items.map((member) => (
                    <div
                      key={member.userId}
                      className="flex flex-col gap-3 rounded-lg border px-3 py-2.5 text-sm sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0">
                        <div className="truncate font-medium">
                          {member.user.displayName || member.user.email}
                        </div>
                        <div className="truncate text-xs text-muted-foreground">
                          {member.user.email} · {formatTime(member.joinedAt)}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {member.status === 'ACTIVE' ? (
                          <Select
                            value={member.teamRoleId ?? undefined}
                            onOpenChange={(open) => {
                              if (open) setRoleOptionsTeamId(teamId);
                            }}
                            onValueChange={(roleId) => void changeMemberRole(member, roleId)}
                          >
                            <SelectTrigger
                              className="w-36"
                              aria-label={`调整 ${member.user.email} 的角色`}
                            >
                              <SelectValue
                                placeholder={member.teamRole?.name || labelOf(member.role)}
                              />
                            </SelectTrigger>
                            <SelectContent>
                              {roleOptions.data?.items.map((role) => (
                                <SelectItem key={role.id} value={role.id}>
                                  {role.name}
                                </SelectItem>
                              ))}
                              {roleOptions.status === 'loading' ? (
                                <SelectItem value="__loading" disabled>
                                  加载中…
                                </SelectItem>
                              ) : null}
                            </SelectContent>
                          </Select>
                        ) : (
                          <Badge variant="secondary">{labelOf(member.status)}</Badge>
                        )}
                        {member.role === 'TEAM_ADMIN' ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => void revokeAdmin(member)}
                          >
                            撤销管理员
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </PagedStack>
              ) : null}
            </AsyncResource>
          </TabsContent>

          <TabsContent value="roles" className="space-y-3 pt-3">
            <div className="flex justify-end">
              <Button type="button" size="sm" onClick={() => setRoleEditor({ teamId })}>
                <PlusIcon className="size-4" />
                创建角色
              </Button>
            </div>
            <AsyncResource
              status={roles.status}
              error={roles.error}
              retry={roles.reload}
              emptyFallback={<EmptyState label="该团队暂无角色" />}
            >
              {roles.data ? (
                <PagedStack total={roles.data.total} page={rolesPage} setPage={setRolesPage}>
                  {roles.data.items.map((role) => (
                    <div
                      key={role.id}
                      className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-sm"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          {role.isSystem ? (
                            <LockIcon className="size-3.5 shrink-0 text-muted-foreground" />
                          ) : null}
                          <span className="truncate font-medium">{role.name}</span>
                          <Badge variant={role.isSystem ? 'default' : 'secondary'}>
                            {role.isSystem ? '内置' : '自定义'}
                          </Badge>
                        </div>
                        <div className="truncate text-xs text-muted-foreground">
                          {role.code || '—'} · 权限 {role.permissionCount} · 成员 {role.memberCount}
                        </div>
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`编辑角色：${role.name}`}
                          onClick={() => setRoleEditor({ teamId, role })}
                        >
                          <PencilIcon className="size-4" />
                        </Button>
                        {!role.isSystem ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={`删除角色：${role.name}`}
                            onClick={() => void deleteRole(role)}
                          >
                            <Trash2Icon className="size-4" />
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </PagedStack>
              ) : null}
            </AsyncResource>
          </TabsContent>

          <TabsContent value="plugins" className="pt-3">
            <AsyncResource
              status={plugins.status}
              error={plugins.error}
              retry={plugins.reload}
              emptyFallback={<EmptyState label="该团队暂无插件" />}
            >
              {plugins.data ? (
                <PagedStack total={plugins.data.total} page={pluginsPage} setPage={setPluginsPage}>
                  {plugins.data.items.map((plugin) => (
                    <div
                      key={plugin.id}
                      className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-sm"
                    >
                      <div className="min-w-0">
                        <div className="truncate font-medium">{plugin.name}</div>
                        <div className="truncate text-xs text-muted-foreground">
                          {labelOf(plugin.visibility)} · {labelOf(plugin.reviewStatus)} · 安装{' '}
                          {plugin.installCount}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {plugin.marketplace ? <Badge variant="success">已上架</Badge> : null}
                        <StatusBadge value={plugin.status} />
                      </div>
                    </div>
                  ))}
                </PagedStack>
              ) : null}
            </AsyncResource>
          </TabsContent>

          <TabsContent value="purchases" className="pt-3">
            <AsyncResource
              status={purchases.status}
              error={purchases.error}
              retry={purchases.reload}
              emptyFallback={<EmptyState label="暂无购买记录" />}
            >
              {purchases.data ? (
                <PagedStack
                  total={purchases.data.total}
                  page={purchasesPage}
                  setPage={setPurchasesPage}
                >
                  {purchases.data.items.map((purchase) => (
                    <div
                      key={purchase.id}
                      className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-sm"
                    >
                      <div className="min-w-0">
                        <div className="truncate font-medium">{purchase.pluginName}</div>
                        <div className="text-xs text-muted-foreground">
                          {formatTime(purchase.createdAt)}
                        </div>
                      </div>
                      <span className="shrink-0 font-medium">{money(purchase.priceCents)}</span>
                    </div>
                  ))}
                </PagedStack>
              ) : null}
            </AsyncResource>
          </TabsContent>

          <TabsContent value="ledger" className="space-y-3 pt-3">
            <AsyncResource status={ledger.status} error={ledger.error} retry={ledger.reload}>
              {ledger.data ? (
                <>
                  <InfoGrid
                    items={[
                      ['累计入账', money(ledger.data.summary.totalCreditCents)],
                      ['累计扣减', money(ledger.data.summary.totalDebitCents)],
                      ['净流入', money(ledger.data.summary.netCents)],
                    ]}
                  />
                  {ledger.data.items.length ? (
                    <PagedStack total={ledger.data.total} page={ledgerPage} setPage={setLedgerPage}>
                      {ledger.data.items.map((entry) => (
                        <div
                          key={entry.id}
                          className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-sm"
                        >
                          <div className="min-w-0">
                            <div className="truncate font-medium">{entry.reason}</div>
                            <div className="truncate text-xs text-muted-foreground">
                              {formatTime(entry.createdAt)}
                              {entry.actor
                                ? ` · ${entry.actor.displayName || entry.actor.email}`
                                : ''}
                            </div>
                          </div>
                          <Badge variant={entry.direction === 'CREDIT' ? 'success' : 'destructive'}>
                            {labelOf(entry.direction)} {money(entry.amountCents)}
                          </Badge>
                        </div>
                      ))}
                    </PagedStack>
                  ) : (
                    <EmptyState label="暂无余额流水" />
                  )}
                </>
              ) : null}
            </AsyncResource>
          </TabsContent>
        </Tabs>
      ) : null}

      {roleEditor?.teamId === teamId && team ? (
        <LazyRoleEditor
          scope="team"
          teamId={team.id}
          roleId={roleEditor.role?.id}
          title={
            roleEditor.role ? `编辑团队角色：${roleEditor.role.name}` : `创建团队角色：${team.name}`
          }
          onClose={() => setRoleEditor(null)}
          onSubmit={async (body) => {
            const path = roleEditor.role
              ? `/api/admin/teams/${team.id}/roles/${roleEditor.role.id}`
              : `/api/admin/teams/${team.id}/roles`;
            const result = await api(path, { method: roleEditor.role ? 'PATCH' : 'POST', body });
            roles.reload();
            if (roleOptionsTeamId === teamId) roleOptions.reload();
            overview.reload();
            return result;
          }}
        />
      ) : null}
    </DetailSheet>
  );
}

function EmptyState({ label }: { label: string }) {
  return <div className="py-10 text-center text-sm text-muted-foreground">{label}</div>;
}

function PagedStack({
  total,
  page,
  setPage,
  children,
}: {
  total: number;
  page: number;
  setPage: (page: number) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      {children}
      {total > PAGE_SIZE ? (
        <Pagination
          totalItems={total}
          pageSize={PAGE_SIZE}
          currentPage={page}
          onPageChange={setPage}
          onPageSizeChange={() => undefined}
          pageSizeOptions={[PAGE_SIZE]}
        />
      ) : null}
    </div>
  );
}
