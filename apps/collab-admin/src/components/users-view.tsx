import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PlusIcon, PencilIcon, ShieldCheckIcon, BanIcon, Trash2Icon } from 'lucide-react';
import { api } from '@/lib/api';
import { useLoad, run } from '@/lib/helpers';
import { StatusBadge, Section, InfoGrid } from '@/components/shared';
import { usePagination, Pagination } from '@/components/ui/pagination';
import type { User, UserStatus } from '@/lib/types';
import { labelOf } from '@/lib/types';

export function UsersView() {
  const [users, setUsers] = useState<User[]>([]);
  const load = () => api<{ users: User[] }>('/api/admin/users').then((r) => setUsers(r.users));
  useLoad(load);

  const regularUsers = useMemo(() => users.filter((u) => u.platformRole !== 'PLATFORM_ADMIN'), [users]);
  const { paginated, page, setPage, pageSize, setPageSize, totalItems } = usePagination(regularUsers);

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
        <div>
          <div className="mb-3 flex items-center justify-between">
            <div>
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
                  <TableRow key={user.id}>
                    <TableCell className="font-medium">{user.email}</TableCell>
                    <TableCell>{user.displayName}</TableCell>
                    <TableCell><StatusBadge value={user.status} /></TableCell>
                    <TableCell><StatusBadge value={user.platformRole} /></TableCell>
                    <TableCell>
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
                    暂无普通用户
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
    </div>
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