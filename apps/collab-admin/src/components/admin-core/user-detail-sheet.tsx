import { useEffect, useState } from 'react';
import { ActivityIcon, BanIcon, KeyRoundIcon, WalletIcon } from 'lucide-react';
import { toast } from 'sonner';
import { AsyncResource } from '@/components/ui/async-resource';
import { Button } from '@/components/ui/button';
import { DetailSheet } from '@/components/ui/detail-sheet';
import { Pagination } from '@/components/ui/pagination';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { InfoGrid, StatusBadge } from '@/components/shared';
import { adminCoreApi } from '@/components/admin-core/api';
import { usePageCorrection } from '@/components/admin-core/pagination';
import type { UserSummary } from '@/components/admin-core/types';
import { useAsyncResource } from '@/lib/async-resource';
import { api } from '@/lib/api';
import { run } from '@/lib/helpers';
import { actionLabel, formatTime, labelOf, targetLabel } from '@/lib/types';
import { money } from '@/lib/utils';

type UserDetailMode = 'user' | 'admin';
type UserDetailTab = 'overview' | 'teams' | 'wallet' | 'logins' | 'activity';
type VisitedUserTabs = { userId: string; tabs: Set<UserDetailTab> };

const PAGE_SIZE = 10;

export function UserDetailSheet({
  user,
  mode,
  onOpenChange,
  onChanged,
}: {
  user: UserSummary | null;
  mode: UserDetailMode;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  const userId = user?.id ?? '';
  const [tab, setTab] = useState<UserDetailTab>('overview');
  const [visitedState, setVisitedState] = useState<VisitedUserTabs>({ userId, tabs: new Set(['overview']) });
  const [teamsPage, setTeamsPage] = useState(1);
  const [walletPage, setWalletPage] = useState(1);
  const [loginsPage, setLoginsPage] = useState(1);
  const [activityPage, setActivityPage] = useState(1);
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [emailNotice, setEmailNotice] = useState<string | null>(null);

  useEffect(() => {
    setTab('overview');
    setVisitedState({ userId, tabs: new Set(['overview']) });
    setTeamsPage(1);
    setWalletPage(1);
    setLoginsPage(1);
    setActivityPage(1);
    setTempPassword(null);
    setEmailNotice(null);
  }, [userId, mode]);

  const overview = useAsyncResource(
    (signal) => adminCoreApi.userDetail(userId, signal),
    [userId],
    { enabled: !!userId },
  );
  const teams = useAsyncResource(
    (signal) => adminCoreApi.userTeams(userId, teamsPage, PAGE_SIZE, signal),
    [userId, teamsPage],
    {
      enabled: !!userId && mode === 'user' && visitedState.userId === userId && visitedState.tabs.has('teams'),
      isEmpty: (data) => data.items.length === 0,
    },
  );
  const wallet = useAsyncResource(
    (signal) => adminCoreApi.userWallet(userId, walletPage, PAGE_SIZE, signal),
    [userId, walletPage],
    {
      enabled: !!userId && mode === 'user' && visitedState.userId === userId && visitedState.tabs.has('wallet'),
      isEmpty: () => false,
    },
  );
  const logins = useAsyncResource(
    (signal) => adminCoreApi.userLogins(userId, loginsPage, PAGE_SIZE, signal),
    [userId, loginsPage],
    {
      enabled: !!userId && mode === 'user' && visitedState.userId === userId && visitedState.tabs.has('logins'),
      isEmpty: (data) => data.items.length === 0,
    },
  );
  const activity = useAsyncResource(
    (signal) => adminCoreApi.adminActivity(userId, activityPage, PAGE_SIZE, signal),
    [userId, activityPage],
    {
      enabled: !!userId && mode === 'admin' && visitedState.userId === userId && visitedState.tabs.has('activity'),
      isEmpty: (data) => data.items.length === 0,
    },
  );

  usePageCorrection(teams.data, teamsPage, PAGE_SIZE, setTeamsPage);
  usePageCorrection(wallet.data, walletPage, PAGE_SIZE, setWalletPage);
  usePageCorrection(logins.data, loginsPage, PAGE_SIZE, setLoginsPage);
  usePageCorrection(activity.data, activityPage, PAGE_SIZE, setActivityPage);

  const actionableUser = overview.data?.id === userId ? overview.data : null;

  function selectTab(value: string) {
    const nextTab = value as UserDetailTab;
    setTab(nextTab);
    setVisitedState((current) => {
      const currentTabs = current.userId === userId ? current.tabs : new Set<UserDetailTab>(['overview']);
      if (current.userId === userId && currentTabs.has(nextTab)) return current;
      const next = new Set(currentTabs);
      next.add(nextTab);
      return { userId, tabs: next };
    });
  }

  async function resetPassword() {
    if (!actionableUser) return;
    if (!window.confirm(`确认重置 ${actionableUser.email} 的密码？当前会话将失效。`)) return;
    try {
      const result = await api<{
        tempPassword: string;
        emailNotice?: { sent: boolean; message: string };
      }>(`/api/admin/users/${actionableUser.id}/reset-password`, { method: 'POST' });
      setTempPassword(result.tempPassword);
      setEmailNotice(result.emailNotice?.message ?? null);
      toast.success('密码已重置');
    } catch (error) {
      if ((error as { status?: number }).status !== 401) toast.error((error as Error).message);
    }
  }

  async function toggleStatus() {
    if (!actionableUser) return;
    const nextStatus = actionableUser.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
    if (nextStatus === 'DISABLED' && !window.confirm(`确认禁用 ${actionableUser.email}？`)) return;
    const ok = await run(
      () => api(`/api/admin/users/${actionableUser.id}`, {
        method: 'PATCH',
        body: { status: nextStatus },
      }),
      nextStatus === 'DISABLED' ? '账号已禁用' : '账号已启用',
    );
    if (!ok) return;
    onChanged();
    overview.reload();
  }

  return (
    <DetailSheet
      open={!!user}
      onOpenChange={onOpenChange}
      title={user?.displayName || user?.email || ''}
      description={user?.email}
      size="lg"
      footer={actionableUser ? (
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="button" variant="outline" className="flex-1" onClick={() => void resetPassword()}>
            <KeyRoundIcon className="size-4" />
            重置密码
          </Button>
          <Button
            type="button"
            variant={actionableUser.status === 'ACTIVE' ? 'destructive' : 'default'}
            className="flex-1"
            onClick={() => void toggleStatus()}
          >
            <BanIcon className="size-4" />
            {actionableUser.status === 'ACTIVE' ? '禁用账号' : '启用账号'}
          </Button>
        </div>
      ) : null}
    >
      {user ? (
        <Tabs value={tab} onValueChange={selectTab}>
          <TabsList className="flex w-full justify-start overflow-x-auto">
            <TabsTrigger value="overview">概览</TabsTrigger>
            {mode === 'user' ? (
              <>
                <TabsTrigger value="teams">团队</TabsTrigger>
                <TabsTrigger value="wallet">钱包</TabsTrigger>
                <TabsTrigger value="logins">登录记录</TabsTrigger>
              </>
            ) : (
              <TabsTrigger value="activity">操作记录</TabsTrigger>
            )}
          </TabsList>

          <TabsContent value="overview" className="space-y-4 pt-3">
            <AsyncResource status={overview.status} error={overview.error} retry={overview.reload}>
              {overview.data ? (
                <InfoGrid items={[
                  ['用户 ID', overview.data.id],
                  ['邮箱', overview.data.email],
                  ['显示名', overview.data.displayName || '—'],
                  ['状态', <StatusBadge key="status" value={overview.data.status} />],
                  ['平台角色', <StatusBadge key="role" value={overview.data.platformRole} />],
                  ['注册时间', formatTime(overview.data.createdAt)],
                  ['邮箱验证', overview.data.emailVerified ? '已验证' : '未验证'],
                ]} />
              ) : null}
            </AsyncResource>
            {tempPassword ? (
              <div className="rounded-lg border border-amber-300/60 bg-amber-50 p-3 text-sm dark:border-amber-900/60 dark:bg-amber-950">
                <div className="font-medium text-amber-800 dark:text-amber-200">临时密码</div>
                <div className="mt-2 break-all rounded-md bg-background px-3 py-2 font-mono text-base">{tempPassword}</div>
                {emailNotice ? <p className="mt-2 text-xs text-muted-foreground">{emailNotice}</p> : null}
              </div>
            ) : null}
          </TabsContent>

          {mode === 'user' ? (
            <>
              <TabsContent value="teams" className="pt-3">
                <AsyncResource status={teams.status} error={teams.error} retry={teams.reload}>
                  {teams.data ? (
                    <PagedStack
                      total={teams.data.total}
                      page={teamsPage}
                      setPage={setTeamsPage}
                      emptyLabel="该用户未加入团队"
                    >
                      {teams.data.items.map((membership) => (
                        <div key={membership.teamId} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-sm">
                          <div className="min-w-0">
                            <div className="truncate font-medium">{membership.team.name}</div>
                            <div className="truncate text-xs text-muted-foreground">{membership.team.slug} · {formatTime(membership.joinedAt)}</div>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <Badge variant="secondary">{labelOf(membership.role)}</Badge>
                            <span className="font-medium">{money(membership.team.balanceCents)}</span>
                          </div>
                        </div>
                      ))}
                    </PagedStack>
                  ) : null}
                </AsyncResource>
              </TabsContent>

              <TabsContent value="wallet" className="space-y-3 pt-3">
                <AsyncResource status={wallet.status} error={wallet.error} retry={wallet.reload}>
                  {wallet.data ? (
                    <>
                      <div className="flex items-center gap-2 rounded-lg border bg-muted/20 px-3 py-3 text-sm">
                        <WalletIcon className="size-4 text-muted-foreground" />
                        <span className="text-muted-foreground">钱包余额</span>
                        <span className="ml-auto font-semibold">{money(wallet.data.balanceCents)}</span>
                      </div>
                      <PagedStack
                        total={wallet.data.total}
                        page={walletPage}
                        setPage={setWalletPage}
                        emptyLabel="暂无钱包流水"
                      >
                        {wallet.data.items.map((entry) => (
                          <div key={entry.id} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-sm">
                            <div className="min-w-0">
                              <div className="truncate font-medium">{entry.reason}</div>
                              <div className="text-xs text-muted-foreground">{formatTime(entry.createdAt)}</div>
                            </div>
                            <Badge variant={entry.direction === 'CREDIT' ? 'success' : 'destructive'}>
                              {labelOf(entry.direction)} {money(entry.amountCents)}
                            </Badge>
                          </div>
                        ))}
                      </PagedStack>
                    </>
                  ) : null}
                </AsyncResource>
              </TabsContent>

              <TabsContent value="logins" className="pt-3">
                <AsyncResource status={logins.status} error={logins.error} retry={logins.reload}>
                  {logins.data ? (
                    <PagedStack
                      total={logins.data.total}
                      page={loginsPage}
                      setPage={setLoginsPage}
                      emptyLabel="暂无登录记录"
                    >
                      {logins.data.items.map((entry) => (
                        <div key={entry.id} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-sm">
                          <span className="font-medium">{actionLabel(entry.action)}</span>
                          <span className="shrink-0 text-xs text-muted-foreground">{formatTime(entry.createdAt)}</span>
                        </div>
                      ))}
                    </PagedStack>
                  ) : null}
                </AsyncResource>
              </TabsContent>
            </>
          ) : (
            <TabsContent value="activity" className="pt-3">
              <AsyncResource status={activity.status} error={activity.error} retry={activity.reload}>
                {activity.data ? (
                  <PagedStack
                    total={activity.data.total}
                    page={activityPage}
                    setPage={setActivityPage}
                    emptyLabel="暂无操作记录"
                  >
                    {activity.data.items.map((entry) => (
                      <div key={entry.id} className="rounded-lg border px-3 py-2.5 text-sm">
                        <div className="flex items-center justify-between gap-3">
                          <span className="flex min-w-0 items-center gap-1.5 font-medium">
                            <ActivityIcon className="size-3.5 shrink-0 text-muted-foreground" />
                            <span className="truncate">{actionLabel(entry.action)}</span>
                          </span>
                          <span className="shrink-0 text-xs text-muted-foreground">{formatTime(entry.createdAt)}</span>
                        </div>
                        {entry.targetType ? (
                          <div className="mt-1 text-xs text-muted-foreground">
                            {targetLabel(entry.targetType)}{entry.targetId ? ` · ${entry.targetId.slice(0, 8)}` : ''}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </PagedStack>
                ) : null}
              </AsyncResource>
            </TabsContent>
          )}
        </Tabs>
      ) : null}
    </DetailSheet>
  );
}

function PagedStack({
  total,
  page,
  setPage,
  emptyLabel,
  children,
}: {
  total: number;
  page: number;
  setPage: (page: number) => void;
  emptyLabel: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      {total > 0 ? children : <p className="py-8 text-center text-sm text-muted-foreground">{emptyLabel}</p>}
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
