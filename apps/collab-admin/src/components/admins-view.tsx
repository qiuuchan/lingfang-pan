import { useEffect, useMemo, useState } from 'react';
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
import { PlusIcon, PencilIcon, ShieldOffIcon, BanIcon, Trash2Icon } from 'lucide-react';
import { api } from '@/lib/api';
import { useLoad, run } from '@/lib/helpers';
import { StatusBadge, Section, InfoGrid } from '@/components/shared';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { usePagination, Pagination } from '@/components/ui/pagination';
import type { User, UserStatus } from '@/lib/types';
import { labelOf } from '@/lib/types';

export function AdminsView() {
  const [users, setUsers] = useState<User[]>([]);
  const load = () => api<{ users: User[] }>('/api/admin/users').then((r) => setUsers(r.users));
  useLoad(load);

  const admins = useMemo(() => users.filter((u) => u.platformRole === 'PLATFORM_ADMIN'), [users]);
  const { paginated, page, setPage, pageSize, setPageSize, totalItems } = usePagination(admins);

  async function toggleBan(user: User) {
    const newStatus = user.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
    await run(
      () => api(`/api/admin/users/${user.id}`, { method: 'PATCH', body: { status: newStatus, platformRole: 'PLATFORM_ADMIN' } }).then(load),
      newStatus === 'DISABLED' ? '管理员已封禁' : '管理员已解封',
    );
  }

  return (
    <div className="space-y-8">
      <Section title="平台管理员" description="平台管理员拥有全局管理权限，在此页面管理。">
        <div>
          <div className="mb-3 flex items-center justify-between">
            <div>
              <div className="text-sm text-muted-foreground">{totalItems} 个管理员</div>
            </div>
            <CreateAdminDialog onRefresh={load}>
              <Button>
                <PlusIcon className="mr-1.5 size-4" />
                创建平台管理员
              </Button>
            </CreateAdminDialog>
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
                        <EditAdminDialog user={user} onRefresh={load}>
                          <Button variant="outline" size="sm">
                            <PencilIcon className="mr-1 size-3.5" />
                            编辑
                          </Button>
                        </EditAdminDialog>
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
                    暂无平台管理员
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

/** --- Create Admin Dialog --- */
function CreateAdminDialog({ children, onRefresh }: { children: React.ReactNode; onRefresh: () => void }) {
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
          body: { email, password, displayName: displayName || email, platformRole: 'PLATFORM_ADMIN' },
        }).then(onRefresh),
      '平台管理员已创建',
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
          <DialogTitle>创建平台管理员</DialogTitle>
          <DialogDescription>创建的账号直接拥有平台级管理权限。</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>邮箱</Label>
            <Input placeholder="admin@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
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

/** --- Edit Admin Dialog (edit + demote combined) --- */
function EditAdminDialog({
  user,
  children,
  onRefresh,
}: {
  user: User;
  children: React.ReactNode;
  onRefresh: () => void;
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
      platformRole: 'PLATFORM_ADMIN',
    };
    if (editPassword.trim()) body.password = editPassword;
    // ADMIN-VIEW-04 修复：仅成功才关闭对话框，失败保留草稿。
    if (!(await run(
      () =>
        api(`/api/admin/users/${user.id}`, { method: 'PATCH', body }).then(onRefresh),
      '平台管理员信息已更新',
    ))) return;
    setOpen(false);
  }

  async function demote() {
    if (!(await run(
      () =>
        api(`/api/admin/users/${user.id}`, {
          method: 'PATCH',
          body: { platformRole: 'NONE' },
        }).then(onRefresh),
      '已降级为普通用户',
    ))) return;
    setOpen(false);
  }

  async function deleteUser() {
    if (!window.confirm(`确认永久删除管理员 ${user.email}？此操作不可恢复。`)) return;
    if (!(await run(
      () => api(`/api/admin/users/${user.id}`, { method: 'DELETE' }).then(onRefresh),
      '管理员已删除',
    ))) return;
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>编辑管理员</DialogTitle>
          <DialogDescription>{user.email}</DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="info">基本信息</TabsTrigger>
            <TabsTrigger value="role">权限管理</TabsTrigger>
          </TabsList>

          <TabsContent value="info" className="space-y-4">
            <InfoGrid
              items={[
                ['管理员 ID', user.id],
                ['当前角色', labelOf(user.platformRole)],
              ]}
            />
            <div className="space-y-2">
              <Label>邮箱</Label>
              <Input
                type="email"
                placeholder="admin@example.com"
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
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                降级后该用户将失去所有平台管理权限，变为普通用户。
              </p>
              <Button variant="destructive" onClick={demote} className="w-full">
                <ShieldOffIcon className="mr-1.5 size-4" />
                降级为普通用户
              </Button>
            </div>
            <div className="mt-4 space-y-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4">
              <p className="text-sm font-medium text-destructive">危险操作</p>
              <p className="text-xs text-muted-foreground">
                永久删除该管理员及其所有关联数据，此操作不可恢复。
              </p>
              <Button variant="destructive" onClick={deleteUser} className="w-full">
                <Trash2Icon className="mr-1.5 size-4" />
                删除管理员
              </Button>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}