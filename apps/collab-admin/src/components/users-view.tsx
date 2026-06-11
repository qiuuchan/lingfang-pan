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
import { PlusIcon, PencilIcon, ShieldCheckIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { useLoad, run } from '@/lib/helpers';
import { StatusBadge, Section, InfoGrid } from '@/components/shared';
import type { User, UserStatus } from '@/lib/types';
import { labelOf } from '@/lib/types';

export function UsersView() {
  const [users, setUsers] = useState<User[]>([]);
  const load = () => api<{ users: User[] }>('/api/admin/users').then((r) => setUsers(r.users));
  useLoad(load);

  const regularUsers = useMemo(() => users.filter((u) => u.platformRole !== 'PLATFORM_ADMIN'), [users]);

  return (
    <div className="space-y-8">
      <Section title="用户管理" description="管理普通用户账号。平台管理员请到独立页面管理。">
        <div>
          <div className="mb-3 flex items-center justify-between">
            <div>
              <div className="text-sm text-muted-foreground">{regularUsers.length} 个用户</div>
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
                <TableHead className="w-[100px]">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {regularUsers.length ? (
                regularUsers.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell className="font-medium">{user.email}</TableCell>
                    <TableCell>{user.displayName}</TableCell>
                    <TableCell><StatusBadge value={user.status} /></TableCell>
                    <TableCell><StatusBadge value={user.platformRole} /></TableCell>
                    <TableCell>
                      <EditUserDialog user={user} onRefresh={load} showPromote>
                        <Button variant="outline" size="sm">
                          <PencilIcon className="mr-1 size-3.5" />
                          编辑
                        </Button>
                      </EditUserDialog>
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
    if (!email.trim()) return toast.error('请输入邮箱');
    await run(
      () =>
        api('/api/admin/users', {
          method: 'POST',
          body: { email, password, displayName: displayName || email, platformRole: 'NONE' },
        }).then(onRefresh),
      '用户已创建',
    );
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
            <Input value={password} onChange={(e) => setPassword(e.target.value)} />
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
  const [editName, setEditName] = useState(user.displayName);
  const [editStatus, setEditStatus] = useState<UserStatus>(user.status);

  // Reset when user changes
  const [prevUser, setPrevUser] = useState(user.id);
  if (user.id !== prevUser) {
    setPrevUser(user.id);
    // Will be re-initialized on next render
  }

  // re-init on open
  function handleOpen(open: boolean) {
    if (open) {
      setEditName(user.displayName);
      setEditStatus(user.status);
    }
    setOpen(open);
  }

  async function save() {
    await run(
      () =>
        api(`/api/admin/users/${user.id}`, {
          method: 'PATCH',
          body: { displayName: editName, status: editStatus, platformRole: user.platformRole },
        }).then(onRefresh),
      '用户信息已更新',
    );
    setOpen(false);
  }

  async function promote() {
    await run(
      () =>
        api(`/api/admin/users/${user.id}`, {
          method: 'PATCH',
          body: { platformRole: 'PLATFORM_ADMIN' },
        }).then(onRefresh),
      '已提升为平台管理员',
    );
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
        <div className="space-y-4">
          <InfoGrid
            items={[
              ['邮箱', user.email],
              ['用户 ID', user.id],
              ['当前角色', labelOf(user.platformRole)],
            ]}
          />
          <div className="space-y-2">
            <Label>显示名</Label>
            <Input value={editName} onChange={(e) => setEditName(e.target.value)} />
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
        </div>
        <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => setEditStatus(editStatus === 'ACTIVE' ? 'DISABLED' : 'ACTIVE')}
            >
              {editStatus === 'ACTIVE' ? '标记禁用' : '标记恢复'}
            </Button>
            {showPromote && (
              <Button variant="ghost" onClick={promote}>
                <ShieldCheckIcon className="mr-1 size-3.5" />
                提升为管理员
              </Button>
            )}
          </div>
          <Button onClick={save}>保存修改</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}