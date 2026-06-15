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
import { DetailSheet } from '@/components/ui/detail-sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { PlusIcon, PencilIcon, ShieldCheckIcon, BanIcon, Trash2Icon, SearchIcon, ActivityIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { money } from '@/lib/utils';
import { useLoad, run } from '@/lib/helpers';
import { StatusBadge, Section, InfoGrid } from '@/components/shared';
import { usePagination, Pagination } from '@/components/ui/pagination';
import type { AuditLog, Team, User, UserStatus } from '@/lib/types';
import { labelOf, formatTime, actionLabel } from '@/lib/types';

type StatusFilter = 'ALL' | 'ACTIVE' | 'DISABLED';

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'ALL', label: '全部状态' },
  { value: 'ACTIVE', label: '正常' },
  { value: 'DISABLED', label: '已禁用' },
];

export function UsersView() {
  const [users, setUsers] = useState<User[]>([]);
  // teams 用于详情 Sheet 派生「用户所在团队 + 钱包余额」（后端无 user 详情端点，前端从团队成员关系派生）。
  const [teams, setTeams] = useState<Team[]>([]);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const [active, setActive] = useState<User | null>(null);

  const load = () =>
    Promise.all([
      api<{ users: User[] }>('/api/admin/users').then((r) => setUsers(r.users)),
      api<{ teams: Team[] }>('/api/admin/teams').then((r) => setTeams(r.teams)),
    ]);
  useLoad(load);

  // 详情 Sheet 打开期间，用户列表刷新（如 footer 封禁/解封）后同步 active 到最新对象，避免显示陈旧状态。
  useEffect(() => {
    if (!active) return;
    const latest = users.find((u) => u.id === active.id);
    if (latest && latest !== active) setActive(latest);
  }, [users, active]);

  // 前端过滤：搜索按 email/displayName（任务约束），状态筛选按 user.status。
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return users.filter((u) => {
      if (u.platformRole === 'PLATFORM_ADMIN') return false; // 仅普通用户，平台管理员在独立页管理。
      if (q && !u.email.toLowerCase().includes(q) && !(u.displayName || '').toLowerCase().includes(q)) return false;
      if (statusFilter !== 'ALL' && u.status !== statusFilter) return false;
      return true;
    });
  }, [users, query, statusFilter]);

  const { paginated, page, setPage, pageSize, setPageSize, totalItems } = usePagination(filtered);

  async function toggleBan(user: User) {
    const newStatus = user.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
    await run(
      () => api(`/api/admin/users/${user.id}`, { method: 'PATCH', body: { status: newStatus, platformRole: user.platformRole } }).then(load),
      newStatus === 'DISABLED' ? '用户已封禁' : '用户已解封',
    );
  }

  return (
    <div className="space-y-8">
      <Section title="用户管理" description="管理普通用户账号，平台管理员在独立页面管理。">
        <div className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-1 flex-col gap-2 sm:flex-row sm:items-center">
              <div className="relative max-w-xs flex-1">
                <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="搜索邮箱或昵称"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="pl-9"
                />
              </div>
              <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
                <SelectTrigger className="sm:w-[140px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_FILTERS.map((f) => (
                    <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="text-sm text-muted-foreground">{totalItems} 个用户</div>
            </div>
            <CreateUserDialog onRefresh={load}>
              <Button>
                <PlusIcon className="mr-1.5 size-4" />
                创建用户
              </Button>
            </CreateUserDialog>
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>邮箱</TableHead>
                <TableHead>显示名</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>角色</TableHead>
                <TableHead className="w-[180px]">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {paginated.length ? (
                paginated.map((user) => (
                  <TableRow key={user.id} className="cursor-pointer" onClick={() => setActive(user)}>
                    <TableCell className="font-medium">{user.email}</TableCell>
                    <TableCell>{user.displayName}</TableCell>
                    <TableCell><StatusBadge value={user.status} /></TableCell>
                    <TableCell><StatusBadge value={user.platformRole} /></TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center gap-2">
                        <EditUserDialog user={user} onRefresh={load} showPromote>
                          <Button variant="outline" size="sm">
                            <PencilIcon className="mr-1 size-3.5" />
                            编辑
                          </Button>
                        </EditUserDialog>
                        <Button
                          variant={user.status === 'ACTIVE' ? 'ghost' : 'outline'}
                          size="sm"
                          onClick={() => toggleBan(user)}
                        >
                          <BanIcon className="mr-1 size-3.5" />
                          {user.status === 'ACTIVE' ? '封禁' : '解封'}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                    {users.length ? '没有符合筛选条件的用户' : '暂无普通用户'}
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
      </Section>

      {/* 行点击打开的详情抽屉：用户信息 + 所在团队（含余额）+ 最近操作。 */}
      <UserDetailSheet user={active} teams={teams} onOpenChange={(o) => !o && setActive(null)} onRefresh={load} />
    </div>
  );
}

// 用户详情侧边抽屉。后端无 user 详情端点，团队从已加载的 teams 列表按成员匹配派生，
// 最近操作在打开时懒加载 /api/admin/audit-logs 并按 actorId 过滤（避免每次 mount 拉全量日志）。
function UserDetailSheet({
  user,
  teams,
  onOpenChange,
  onRefresh,
}: {
  user: User | null;
  teams: Team[];
  onOpenChange: (open: boolean) => void;
  onRefresh: () => void;
}) {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(false);

  const userTeams = useMemo(() => {
    if (!user) return [];
    return teams
      .filter((t) => (t.members || []).some((m) => m.userId === user.id))
      .map((t) => ({ id: t.id, name: t.name, slug: t.slug, status: t.status, balanceCents: t.balanceCents, role: t.members?.find((m) => m.userId === user.id)?.role }));
  }, [user, teams]);

  useEffect(() => {
    if (!user) {
      setLogs([]);
      return;
    }
    setLoadingLogs(true);
    api<{ logs: AuditLog[] }>('/api/admin/audit-logs')
      .then((r) => setLogs(r.logs.filter((l) => l.actor?.id === user.id).slice(0, 10)))
      .catch(() => setLogs([]))
      .finally(() => setLoadingLogs(false));
  }, [user]);

  return (
    <DetailSheet
      open={!!user}
      onOpenChange={onOpenChange}
      title={user?.displayName || user?.email || ''}
      description={user?.email}
      footer={
        user ? (
          <Button
            variant={user.status === 'ACTIVE' ? 'ghost' : 'outline'}
            className="w-full"
            onClick={() => {
              const newStatus = user.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
              void run(
                () => api(`/api/admin/users/${user.id}`, { method: 'PATCH', body: { status: newStatus, platformRole: user.platformRole } }).then(onRefresh),
                newStatus === 'DISABLED' ? '用户已封禁' : '用户已解封',
              );
            }}
          >
            <BanIcon className="mr-1.5 size-4" />
            {user.status === 'ACTIVE' ? '封禁用户' : '解封用户'}
          </Button>
        ) : null
      }
    >
      {user ? (
        <>
          <div>
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">账户信息</div>
            <InfoGrid
              items={[
                ['用户 ID', user.id],
                ['邮箱', user.email],
                ['显示名', user.displayName || '—'],
                ['状态', <StatusBadge key="s" value={user.status} />],
                ['角色', <StatusBadge key="r" value={user.platformRole} />],
              ]}
            />
          </div>

          <div>
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">所在团队</div>
            {userTeams.length ? (
              <div className="space-y-2">
                {userTeams.map((t) => (
                  <div key={t.id} className="flex items-center justify-between gap-3 rounded-xl border px-3 py-2 text-sm">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{t.name}</div>
                      <div className="truncate text-xs text-muted-foreground font-mono">{t.slug}</div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Badge variant="secondary">{labelOf(t.role)}</Badge>
                      <span className="font-medium">{money(t.balanceCents)}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">该用户未加入任何团队</p>
            )}
          </div>

          <div>
            <div className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <ActivityIcon className="size-3.5" />
              最近操作
            </div>
            {loadingLogs ? (
              <p className="text-sm text-muted-foreground">加载中…</p>
            ) : logs.length ? (
              <div className="space-y-1.5">
                {logs.map((log) => (
                  <div key={log.id} className="rounded-xl border px-3 py-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{actionLabel(log.action)}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">{formatTime(log.createdAt)}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">暂无操作记录</p>
            )}
          </div>
        </>
      ) : null}
    </DetailSheet>
  );
}

/** --- Create User Dialog --- */
function CreateUserDialog({ children, onRefresh }: { children: React.ReactNode; onRefresh: () => void }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('ChangeMe123!');

  async function create() {
    if (!email.trim()) return toast.error('输入邮箱');
    // ADMIN-VIEW-04 修复：仅成功才关闭对话框并清空表单。
    if (!(await run(
      () =>
        api('/api/admin/users', {
          method: 'POST',
          body: { email, password, displayName: displayName || email, platformRole: 'NONE' },
        }).then(onRefresh),
      '用户已创建',
    ))) return;
    setOpen(false);
    setEmail('');
    setDisplayName('');
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>创建用户</DialogTitle>
          <DialogDescription>默认密码可调整，平台角色固定为普通用户。</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>邮箱</Label>
            <Input placeholder="user@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>显示名</Label>
            <Input placeholder="默认使用邮箱" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>初始密码</Label>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={create}>创建</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** --- Edit User Dialog (edit + promote combined) --- */
function EditUserDialog({
  user,
  children,
  onRefresh,
  showPromote,
}: {
  user: User;
  children: React.ReactNode;
  onRefresh: () => void;
  showPromote?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('info');
  const [editEmail, setEditEmail] = useState(user.email);
  const [editName, setEditName] = useState(user.displayName);
  const [editStatus, setEditStatus] = useState<UserStatus>(user.status);
  const [editPassword, setEditPassword] = useState('');

  function handleOpen(open: boolean) {
    if (open) {
      setEditEmail(user.email);
      setEditName(user.displayName);
      setEditStatus(user.status);
      setEditPassword('');
      setTab('info');
    }
    setOpen(open);
  }

  async function save() {
    if (!editEmail.trim()) return toast.error('输入邮箱');
    const body: Record<string, unknown> = {
      email: editEmail.trim(),
      displayName: editName,
      status: editStatus,
      platformRole: user.platformRole,
    };
    if (editPassword.trim()) body.password = editPassword;
    // ADMIN-VIEW-04 修复：仅成功才关闭对话框，失败保留草稿。
    if (!(await run(
      () =>
        api(`/api/admin/users/${user.id}`, { method: 'PATCH', body }).then(onRefresh),
      '用户信息已更新',
    ))) return;
    setOpen(false);
  }

  async function promote() {
    if (!(await run(
      () =>
        api(`/api/admin/users/${user.id}`, {
          method: 'PATCH',
          body: { platformRole: 'PLATFORM_ADMIN' },
        }).then(onRefresh),
      '已提升为平台管理员',
    ))) return;
    setOpen(false);
  }

  async function deleteUser() {
    if (!window.confirm(`确认永久删除用户 ${user.email}？此操作不可恢复。`)) return;
    if (!(await run(
      () => api(`/api/admin/users/${user.id}`, { method: 'DELETE' }).then(onRefresh),
      '用户已删除',
    ))) return;
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>编辑用户</DialogTitle>
          <DialogDescription>{user.email}</DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="info">基本信息</TabsTrigger>
            <TabsTrigger value="role">角色管理</TabsTrigger>
          </TabsList>

          <TabsContent value="info" className="space-y-4">
            <InfoGrid
              items={[
                ['用户 ID', user.id],
                ['当前角色', labelOf(user.platformRole)],
              ]}
            />
            <div className="space-y-2">
              <Label>邮箱</Label>
              <Input
                type="email"
                placeholder="user@example.com"
                value={editEmail}
                onChange={(e) => setEditEmail(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>昵称</Label>
              <Input
                placeholder="显示名称"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>新密码（留空不修改）</Label>
              <Input
                type="password"
                placeholder="留空则不修改密码"
                value={editPassword}
                onChange={(e) => setEditPassword(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>状态</Label>
              <Select value={editStatus} onValueChange={(v) => setEditStatus(v as UserStatus)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ACTIVE">正常</SelectItem>
                  <SelectItem value="DISABLED">已禁用</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button onClick={save} className="w-full">保存修改</Button>
          </TabsContent>

          <TabsContent value="role" className="space-y-4">
            <InfoGrid
              items={[
                ['邮箱', user.email],
                ['当前角色', labelOf(user.platformRole)],
              ]}
            />
            {showPromote && user.platformRole !== 'PLATFORM_ADMIN' ? (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  将该用户提升为平台管理员，赋予全局管理权限。此操作不可逆。
                </p>
                <Button onClick={promote} className="w-full">
                  <ShieldCheckIcon className="mr-1.5 size-4" />
                  提升为平台管理员
                </Button>
              </div>
            ) : (
              <div className="py-4 text-center text-sm text-muted-foreground">
                该用户已是平台管理员，在管理员页面管理。
              </div>
            )}
            <div className="mt-4 space-y-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4">
              <p className="text-sm font-medium text-destructive">危险操作</p>
              <p className="text-xs text-muted-foreground">
                永久删除该用户及其所有关联数据，此操作不可恢复。
              </p>
              <Button variant="destructive" onClick={deleteUser} className="w-full">
                <Trash2Icon className="mr-1.5 size-4" />
                删除用户
              </Button>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
