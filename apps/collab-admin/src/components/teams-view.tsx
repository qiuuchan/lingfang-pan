import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DetailSheet } from '@/components/ui/detail-sheet';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { PlusIcon, PencilIcon, UserPlusIcon, DollarSignIcon, Trash2Icon, SearchIcon, PowerIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { money } from '@/lib/utils';
import { useLoad, run, useGuardedAction } from '@/lib/helpers';
import { StatusBadge, Section, InfoGrid } from '@/components/shared';
import { usePagination, Pagination } from '@/components/ui/pagination';
import type { Team, TeamDetail, TeamMember, TeamRole, TeamStatus, User, LedgerDirection } from '@/lib/types';
import { yuanToCents, activeMembers, teamAdmins, adminNames, labelOf, formatTime } from '@/lib/types';

export function TeamsView() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<Team | null>(null);

  const load = () =>
    Promise.all([
      api<{ teams: Team[] }>('/api/admin/teams').then((r) => setTeams(r.teams)),
      api<{ users: User[] }>('/api/admin/users').then((r) => setUsers(r.users)),
    ]);

  useLoad(load);

  // 详情 Sheet 打开期间，团队列表刷新（如「管理」对话框内改名/调余额）后同步 active 到最新对象。
  useEffect(() => {
    if (!active) return;
    const latest = teams.find((t) => t.id === active.id);
    if (latest && latest !== active) setActive(latest);
  }, [teams, active]);

  const activeUsers = users.filter((u) => u.status === 'ACTIVE');

  // 前端过滤：搜索按 name/slug（任务约束「搜索框」）。
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return teams;
    return teams.filter((t) => t.name.toLowerCase().includes(q) || t.slug.toLowerCase().includes(q));
  }, [teams, query]);

  const { paginated, page, setPage, pageSize, setPageSize, totalItems } = usePagination(filtered);

  return (
    <Section title="团队管理" description="团队信息维护、余额调整和管理员分配。">
      <div className="space-y-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative max-w-xs flex-1">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="搜索团队名称或 Slug"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-9"
            />
          </div>
          <CreateTeamDialog onRefresh={load}>
            <Button>
              <PlusIcon className="mr-1.5 size-4" />
              创建团队
            </Button>
          </CreateTeamDialog>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>团队</TableHead>
              <TableHead>Slug</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>余额</TableHead>
              <TableHead>成员</TableHead>
              <TableHead>管理员</TableHead>
              <TableHead className="w-[100px]">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {paginated.length ? (
              paginated.map((team) => (
                <TableRow key={team.id} className="cursor-pointer" onClick={() => setActive(team)}>
                  <TableCell className="font-medium">{team.name}</TableCell>
                  <TableCell className="font-mono text-xs">{team.slug}</TableCell>
                  <TableCell><StatusBadge value={team.status} /></TableCell>
                  <TableCell className="font-medium">{money(team.balanceCents)}</TableCell>
                  <TableCell>{team.memberCount ?? activeMembers(team).length}</TableCell>
                  <TableCell>{adminNames(team)}</TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <TeamDetailDialog team={team} activeUsers={activeUsers} onRefresh={load}>
                      <Button variant="outline" size="sm">
                        <PencilIcon className="mr-1 size-3.5" />
                        管理
                      </Button>
                    </TeamDetailDialog>
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                  {teams.length ? '没有符合搜索条件的团队' : '暂无团队'}
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
      </div>

      {/* 行点击打开的详情抽屉：概览 + 成员（角色切换）+ 插件 + 购买 + 流水，footer 含停用/启用。 */}
      <TeamOverviewSheet team={active} onOpenChange={(o) => !o && setActive(null)} onRefresh={load} />
    </Section>
  );
}

// 团队概览侧边抽屉：行点击查看，含 Tabs（概览/成员/插件/购买/流水）+ footer 停用/启用按钮。
// 区别于「管理」按钮打开的 TeamDetailDialog（编辑信息/余额调整/管理员分配）。
function TeamOverviewSheet({
  team,
  onOpenChange,
  onRefresh,
}: {
  team: Team | null;
  onOpenChange: (open: boolean) => void;
  onRefresh: () => void;
}) {
  const [tab, setTab] = useState('overview');
  const [detail, setDetail] = useState<TeamDetail | null>(null);
  const [members, setMembers] = useState<TeamMember[]>([]);

  // 详情打开时加载聚合视图 + 成员列表。team 变化（列表刷新同步 active）时重载。
  useEffect(() => {
    if (!team) {
      setDetail(null);
      setMembers([]);
      return;
    }
    setTab('overview');
    let mounted = true;
    Promise.all([
      api<TeamDetail>(`/api/admin/teams/${team.id}/detail`),
      api<{ members: TeamMember[] }>(`/api/admin/teams/${team.id}/members`).then((r) => r.members),
    ])
      .then(([d, m]) => {
        if (!mounted) return;
        setDetail(d);
        setMembers(m);
      })
      .catch((e: Error & { status?: number }) => {
        if (!mounted) return;
        if (e.status === 401) return; // 401 由全局 UNAUTHORIZED 事件统一处理。
        toast.error(e.message);
      });
    return () => {
      mounted = false;
    };
  }, [team]);

  // 切换团队成员角色：调用 PATCH /api/admin/teams/:id/members/:userId/role。
  // 仅 ACTIVE 成员可切换（REMOVED 成员无意义），且无变更（同角色）时后端已幂等不写审计。
  async function changeRole(member: TeamMember, role: TeamRole) {
    if (member.status !== 'ACTIVE') return toast.error('仅活跃成员可调整角色');
    if (member.role === role) return;
    if (!(await run(
      () =>
        api(`/api/admin/teams/${team!.id}/members/${member.userId}/role`, {
          method: 'PATCH',
          body: { role },
        }).then(() =>
          // 成员角色切换后刷新成员列表 + 团队列表（adminNames 列展示依赖 members）。
          api<{ members: TeamMember[] }>(`/api/admin/teams/${team!.id}/members`).then((r) => setMembers(r.members)),
        ),
      '成员角色已更新',
    ))) return;
    onRefresh();
  }

  // 团队启用/停用：调用 PATCH /api/admin/teams/:id/status。
  async function toggleStatus() {
    const next: TeamStatus = team!.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE';
    if (team!.status === 'ACTIVE' && !window.confirm(`确认停用团队「${team!.name}」？停用后团队成员将无法继续操作。`)) return;
    if (!(await run(
      () =>
        api(`/api/admin/teams/${team!.id}/status`, {
          method: 'PATCH',
          body: { status: next },
        }).then(onRefresh),
      next === 'SUSPENDED' ? '团队已停用' : '团队已启用',
    ))) return;
  }

  return (
    <DetailSheet
      open={!!team}
      onOpenChange={onOpenChange}
      title={team?.name || ''}
      description={team?.slug}
      footer={
        team ? (
          <Button
            variant={team.status === 'ACTIVE' ? 'destructive' : 'default'}
            className="w-full"
            onClick={toggleStatus}
          >
            {team.status === 'ACTIVE' ? (
              <>
                <PowerIcon className="mr-1.5 size-4" />
                停用团队
              </>
            ) : (
              <>
                <PowerIcon className="mr-1.5 size-4" />
                启用团队
              </>
            )}
          </Button>
        ) : null
      }
    >
      {team ? (
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="grid w-full grid-cols-5">
            <TabsTrigger value="overview">概览</TabsTrigger>
            <TabsTrigger value="members">成员</TabsTrigger>
            <TabsTrigger value="plugins">插件</TabsTrigger>
            <TabsTrigger value="purchases">购买</TabsTrigger>
            <TabsTrigger value="ledger">流水</TabsTrigger>
          </TabsList>

          {/* 概览：团队基础信息 + 余额流水摘要 + 活跃度画像。 */}
          <TabsContent value="overview" className="space-y-4 pt-4">
            <InfoGrid
              items={[
                ['团队 ID', team.id],
                ['状态', <StatusBadge key="s" value={team.status} />],
                ['当前余额', money(team.balanceCents)],
                ['活跃成员', String(detail?.memberCount ?? team.memberCount ?? activeMembers(team).length)],
                ['插件数量', String(detail?.pluginCount ?? '—')],
                ['公开加入', team.allowPublicJoin ? <Badge key="pj" variant="success">已开放</Badge> : <Badge key="pj" variant="secondary">关闭</Badge>],
                ['创建时间', formatTime(team.createdAt)],
              ]}
            />
            {detail ? (
              <InfoGrid
                items={[
                  ['累计入账', money(detail.ledgerSummary.totalCreditCents)],
                  ['累计扣减', money(detail.ledgerSummary.totalDebitCents)],
                  ['净流入', money(detail.ledgerSummary.netCents)],
                ]}
              />
            ) : null}
            {team.description ? (
              <div>
                <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">团队简介</div>
                <p className="whitespace-pre-wrap break-all text-sm text-foreground">{team.description}</p>
              </div>
            ) : null}
          </TabsContent>

          {/* 成员：列表 + 角色升级/降级（下拉切换 TEAM_ADMIN/MEMBER）。 */}
          <TabsContent value="members" className="space-y-3 pt-4">
            {members.length ? (
              <div className="space-y-2">
                {members.map((member) => (
                  <div key={member.userId} className="flex items-center justify-between gap-3 rounded-xl border px-3 py-2 text-sm">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{member.user.displayName || member.user.email}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {member.user.email} · 加入于 {formatTime(member.joinedAt)}
                        {member.status !== 'ACTIVE' ? ` · ${labelOf(member.status)}` : ''}
                      </div>
                    </div>
                    {member.status === 'ACTIVE' ? (
                      <Select value={member.role} onValueChange={(v) => changeRole(member, v as TeamRole)}>
                        <SelectTrigger className="w-32 shrink-0"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="TEAM_ADMIN">团队管理员</SelectItem>
                          <SelectItem value="MEMBER">普通成员</SelectItem>
                        </SelectContent>
                      </Select>
                    ) : (
                      <Badge variant="secondary">{labelOf(member.status)}</Badge>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">暂无成员</p>
            )}
          </TabsContent>

          {/* 插件：团队拥有的插件列表（治理字段，不含文件清单）。 */}
          <TabsContent value="plugins" className="space-y-3 pt-4">
            {detail && detail.plugins.length ? (
              <div className="space-y-2">
                {detail.plugins.map((plugin) => (
                  <div key={plugin.id} className="flex items-center justify-between gap-3 rounded-xl border px-3 py-2 text-sm">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{plugin.name}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {labelOf(plugin.visibility)} · {labelOf(plugin.reviewStatus)} · 安装 {plugin.installCount} 次
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {plugin.marketplace ? <Badge variant="success">已上架</Badge> : null}
                      <StatusBadge value={plugin.status} />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">该团队暂无插件</p>
            )}
          </TabsContent>

          {/* 购买：团队作为买方的最近交易记录。 */}
          <TabsContent value="purchases" className="space-y-3 pt-4">
            {detail && detail.purchases.length ? (
              <div className="space-y-2">
                {detail.purchases.map((purchase) => (
                  <div key={purchase.id} className="flex items-center justify-between gap-3 rounded-xl border px-3 py-2 text-sm">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{purchase.pluginName}</div>
                      <div className="truncate text-xs text-muted-foreground">{formatTime(purchase.createdAt)}</div>
                    </div>
                    <div className="shrink-0 font-medium">{money(purchase.priceCents)}</div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">暂无购买记录</p>
            )}
          </TabsContent>

          {/* 流水：余额变动明细（含入账/扣减 + 原因）。 */}
          <TabsContent value="ledger" className="space-y-3 pt-4">
            {detail ? (
              <>
                <InfoGrid
                  items={[
                    ['累计入账', money(detail.ledgerSummary.totalCreditCents)],
                    ['累计扣减', money(detail.ledgerSummary.totalDebitCents)],
                    ['净流入', money(detail.ledgerSummary.netCents)],
                    ['当前余额', money(team.balanceCents)],
                  ]}
                />
                {detail.recentLedger.length ? (
                  <div className="space-y-2">
                    {detail.recentLedger.map((entry, idx) => (
                      <div key={entry.id ?? idx} className="flex items-center justify-between gap-3 rounded-xl border px-3 py-2 text-sm">
                        <div className="min-w-0">
                          <div className="truncate font-medium">{entry.reason}</div>
                          <div className="truncate text-xs text-muted-foreground">{formatTime(entry.createdAt)}</div>
                        </div>
                        <Badge variant={entry.direction === 'CREDIT' ? 'success' : 'destructive'}>
                          {labelOf(entry.direction)} {money(entry.amountCents)}
                        </Badge>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">暂无流水记录</p>
                )}
              </>
            ) : null}
          </TabsContent>
        </Tabs>
      ) : null}
    </DetailSheet>
  );
}

function CreateTeamDialog({ children, onRefresh }: { children: React.ReactNode; onRefresh: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [initialBalance, setInitialBalance] = useState('100');

  async function create() {
    if (!name.trim()) return toast.error('输入团队名称');
    // ADMIN-VIEW-04 修复：仅成功才关闭对话框并清空表单，失败时保留草稿供用户修正。
    if (!(await run(
      () =>
        api('/api/admin/teams', {
          method: 'POST',
          body: { name, balanceCents: yuanToCents(initialBalance) },
        }).then(onRefresh),
      '团队已创建',
    ))) return;
    setOpen(false);
    setName('');
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>创建团队</DialogTitle>
          <DialogDescription>创建后可在管理里指定管理员和调整余额。</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>团队名称</Label>
            <Input placeholder="团队名称" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>初始余额（元）</Label>
            <Input value={initialBalance} onChange={(e) => setInitialBalance(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={create}>创建</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TeamDetailDialog({
  team,
  activeUsers,
  children,
  onRefresh,
}: {
  team: Team;
  activeUsers: User[];
  children: React.ReactNode;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('info');

  // Basic info
  const [editName, setEditName] = useState(team.name);
  const [editStatus, setEditStatus] = useState<TeamStatus>(team.status);

  // Balance
  const [balanceAmount, setBalanceAmount] = useState('100');
  const [balanceDirection, setBalanceDirection] = useState<LedgerDirection>('CREDIT');
  const [balanceReason, setBalanceReason] = useState('平台管理员调整');

  // Admin
  const [adminUserId, setAdminUserId] = useState('');

  function handleOpen(open: boolean) {
    if (open) {
      setEditName(team.name);
      setEditStatus(team.status);
      setAdminUserId('');
      setTab('info');
    }
    setOpen(open);
  }

  async function save() {
    // ADMIN-VIEW-04 修复：仅成功才关闭/重置，失败保留草稿。
    if (!(await run(
      () =>
        api(`/api/admin/teams/${team.id}`, {
          method: 'PATCH',
          body: { name: editName, status: editStatus },
        }).then(onRefresh),
      '团队信息已更新',
    ))) return;
  }

  async function deleteTeam() {
    if (!window.confirm(`确认永久删除团队「${team.name}」及其所有成员、数据？此操作不可恢复。`)) return;
    // ADMIN-VIEW-04：仅成功才关闭。
    if (!(await run(
      () => api(`/api/admin/teams/${team.id}`, { method: 'DELETE' }).then(onRefresh),
      '团队已删除',
    ))) return;
    setOpen(false);
  }

  async function assignAdmin() {
    if (!adminUserId) return toast.error('选择用户');
    // ADMIN-VIEW-04：仅成功才清空选择。
    if (!(await run(
      () =>
        api(`/api/admin/teams/${team.id}/admins`, {
          method: 'POST',
          body: { userId: adminUserId },
        }).then(onRefresh),
      '团队管理员已指定',
    ))) return;
    setAdminUserId('');
  }

  async function revokeAdmin(member: TeamMember) {
    if (!window.confirm(`确认撤销 ${member.user.email} 的团队管理员权限？`)) return;
    await run(
      () =>
        api(`/api/admin/teams/${team.id}/admins/${member.userId}`, { method: 'DELETE' }).then(onRefresh),
      '团队管理员已撤销',
    );
  }

  // ADMIN-VIEW-01 修复：余额调整是资金类操作，无后端幂等键。
  // 加防重入守卫（in-flight 期间重复点击直接返回）+ 按钮 disabled/loading 态，防双击导致资金双倍变动。
  const [balanceBusy, guardBalance] = useGuardedAction();

  async function adjustBalance() {
    await guardBalance(() =>
      // 失败也保留对话框（不关闭），用户可修正重试。
      run(
        () =>
          api(`/api/admin/teams/${team.id}/balance-adjustments`, {
            method: 'POST',
            body: { amountCents: yuanToCents(balanceAmount), direction: balanceDirection, reason: balanceReason },
          }).then(onRefresh),
        '团队余额已调整',
      ),
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{team.name}</DialogTitle>
          <DialogDescription>团队管理</DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="info">基本信息</TabsTrigger>
            <TabsTrigger value="balance">余额调整</TabsTrigger>
            <TabsTrigger value="admins">管理员</TabsTrigger>
          </TabsList>

          <TabsContent value="info" className="space-y-4">
            <InfoGrid
              items={[
                ['团队 ID', team.id],
                ['Slug', team.slug],
                ['当前余额', money(team.balanceCents)],
                ['活跃成员', String(team.memberCount ?? activeMembers(team).length)],
              ]}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>团队名称</Label>
                <Input value={editName} onChange={(e) => setEditName(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>状态</Label>
                <Select value={editStatus} onValueChange={(v) => setEditStatus(v as TeamStatus)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ACTIVE">正常</SelectItem>
                    <SelectItem value="SUSPENDED">已停用</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <Button onClick={save} className="w-full">保存团队信息</Button>
            <div className="mt-4 space-y-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4">
              <p className="text-sm font-medium text-destructive">危险操作</p>
              <p className="text-xs text-muted-foreground">
                永久删除该团队及其所有成员、余额数据。此操作不可恢复。
              </p>
              <Button variant="destructive" onClick={deleteTeam} className="w-full">
                <Trash2Icon className="mr-1.5 size-4" />
                删除团队
              </Button>
            </div>
          </TabsContent>

          <TabsContent value="balance" className="space-y-4">
            <InfoGrid items={[['当前余额', money(team.balanceCents)]]} />
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>方向</Label>
                <Select value={balanceDirection} onValueChange={(v) => setBalanceDirection(v as LedgerDirection)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="CREDIT">入账</SelectItem>
                    <SelectItem value="DEBIT">扣减</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>金额（元）</Label>
                <Input value={balanceAmount} onChange={(e) => setBalanceAmount(e.target.value)} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>原因</Label>
              <Input value={balanceReason} onChange={(e) => setBalanceReason(e.target.value)} />
            </div>
            <Button onClick={adjustBalance} disabled={balanceBusy} className="w-full">
              <DollarSignIcon className="mr-1.5 size-4" />
              {balanceBusy ? '提交中…' : '提交余额调整'}
            </Button>
          </TabsContent>

          <TabsContent value="admins" className="space-y-4">
            <div className="flex gap-2">
              <Select value={adminUserId} onValueChange={setAdminUserId}>
                <SelectTrigger className="flex-1"><SelectValue placeholder="选择用户" /></SelectTrigger>
                <SelectContent>
                  {activeUsers.map((u) => (
                    <SelectItem key={u.id} value={u.id}>{u.email}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button onClick={assignAdmin} className="shrink-0">
                <UserPlusIcon className="mr-1.5 size-4" />
                指定为管理员
              </Button>
            </div>
            <div className="space-y-2">
              {teamAdmins(team).length ? (
                teamAdmins(team).map((member) => (
                  <div
                    key={member.userId}
                    className="flex items-center justify-between gap-3 rounded-xl border px-3 py-2 text-sm"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-medium">{member.user.displayName}</div>
                      <div className="truncate text-xs text-muted-foreground">{member.user.email}</div>
                    </div>
                    <Button variant="destructive" onClick={() => revokeAdmin(member)}>撤销</Button>
                  </div>
                ))
              ) : (
                <div className="text-sm text-muted-foreground">暂无团队管理员</div>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}