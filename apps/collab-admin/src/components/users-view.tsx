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
import { PlusIcon, PencilIcon, ShieldCheckIcon, BanIcon, Trash2Icon, SearchIcon, ActivityIcon, KeyIcon, WalletIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { money } from '@/lib/utils';
import { useLoad, run } from '@/lib/helpers';
import { StatusBadge, Section, InfoGrid } from '@/components/shared';
import { usePagination, Pagination } from '@/components/ui/pagination';
import type { User, UserDetail, UserStatus } from '@/lib/types';
import { labelOf, formatTime, actionLabel } from '@/lib/types';

type StatusFilter = 'ALL' | 'ACTIVE' | 'DISABLED';

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'ALL', label: '全部状态' },
  { value: 'ACTIVE', label: '正常' },
  { value: 'DISABLED', label: '已禁用' },
];

export function UsersView() {
  const [users, setUsers] = useState<User[]>([]);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const [active, setActive] = useState<User | null>(null);

  // 仅加载用户列表；详情（团队/钱包/登录历史）由 UserDetailSheet 通过 detail 端点懒加载，避免列表 mount 拉全量。
  const load = () => api<{ users: User[] }>('/api/admin/users').then((r) => setUsers(r.users));
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

      {/* 行点击打开的详情抽屉：用户信息 + 钱包 + 所在团队 + 登录历史。 */}
      <UserDetailSheet user={active} onOpenChange={(o) => !o && setActive(null)} onRefresh={load} />
    </div>
  );
}

// 用户详情侧边抽屉。后端 /api/admin/users/:id/detail 一次性聚合：
// 登录历史（auth.* 审计）+ 钱包 + 团队 memberships + 钱包流水，避免前端从 teams 列表派生 + 拉全量审计日志再前端过滤。
function UserDetailSheet({
  user,
  onOpenChange,
  onRefresh,
}: {
  user: User | null;
  onOpenChange: (open: boolean) => void;
  onRefresh: () => void;
}) {
  const [detail, setDetail] = useState<UserDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [tempPassword, setTempPassword] = useState<string | null>(null);

  // 打开时懒加载用户详情（避免列表 mount 拉全量）。user 变 null（关闭）时清空。
  useEffect(() => {
    if (!user) {
      setDetail(null);
      setTempPassword(null);
      return;
    }
    setLoading(true);
    api<UserDetail>(`/api/admin/users/${user.id}/detail`)
      .then(setDetail)
      .catch(() => setDetail(null))
      .finally(() => setLoading(false));
  }, [user]);

  async function resetPassword() {
    if (!user) return;
    if (!window.confirm(`确认强制重置用户 ${user.email} 的密码？将生成临时密码并作废当前会话。`)) return;
    const result = await api<{ tempPassword: string }>(`/api/admin/users/${user.id}/reset-password`, { method: 'POST' });
    // 临时密码一次性展示，admin 需手动复制转交用户（不自动复制到剪贴板，避免泄漏到无关上下文）。
    setTempPassword(result.tempPassword);
    toast.success('密码已重置，请将临时密码安全转交用户');
  }

  return (
    <DetailSheet
      open={!!user}
      onOpenChange={onOpenChange}
      title={user?.displayName || user?.email || ''}
      description={user?.email}
      footer={
        user ? (
          <div className="flex flex-col gap-2">
            {tempPassword ? (
              <div className="rounded-xl border border-amber-300/60 bg-amber-50 p-3 text-sm dark:border-amber-900/60 dark:bg-amber-950">
                <div className="mb-1 font-medium text-amber-700 dark:text-amber-300">临时密码（仅显示一次，请立即转交用户）</div>
                <div className="break-all rounded bg-background px-2 py-1.5 font-mono text-base tracking-wider">{tempPassword}</div>
              </div>
            ) : null}
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => void resetPassword()}>
                <KeyIcon className="mr-1.5 size-4" />
                重置密码
              </Button>
              <Button
                variant={user.status === 'ACTIVE' ? 'ghost' : 'outline'}
                className="flex-1"
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
            </div>
          </div>
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
                ['注册时间', formatTime(detail?.user.createdAt)],
              ]}
            />
          </div>

          <div>
            <div className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <WalletIcon className="size-3.5" />
              钱包余额
            </div>
            <div className="rounded-xl border bg-muted/20 px-3 py-2 text-sm">
              <span className="font-medium">{money(detail?.wallet.balanceCents ?? 0)}</span>
            </div>
          </div>

          <div>
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">所在团队</div>
            {detail && detail.teams.length ? (
              <div className="space-y-2">
                {detail.teams.map((t) => (
                  <div key={t.teamId} className="flex items-center justify-between gap-3 rounded-xl border px-3 py-2 text-sm">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{t.team.name}</div>
                      <div className="truncate text-xs text-muted-foreground font-mono">{t.team.slug}</div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Badge variant="secondary">{labelOf(t.role)}</Badge>
                      <span className="font-medium">{money(t.team.balanceCents)}</span>
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
              登录历史
            </div>
            {loading ? (
              <p className="text-sm text-muted-foreground">加载中…</p>
            ) : detail && detail.loginHistory.length ? (
              <div className="space-y-1.5">
                {detail.loginHistory.map((log) => (
                  <div key={log.id} className="rounded-xl border px-3 py-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{actionLabel(log.action)}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">{formatTime(log.createdAt)}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">暂无登录记录</p>
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
    // 使用专用 platform-role 端点（仅改角色，禁止自改自身 + 独立审计 admin.user.role_changed）。
    if (!(await run(
      () =>
        api(`/api/admin/users/${user.id}/platform-role`, {
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
