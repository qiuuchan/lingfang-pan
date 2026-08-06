import { useState, type ReactNode } from 'react';
import { ShieldCheckIcon, ShieldOffIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { InfoGrid } from '@/components/shared';
import { api } from '@/lib/api';
import { run } from '@/lib/helpers';
import { labelOf } from '@/lib/types';
import type { PlatformRole } from '@/lib/types';
import type { UserSummary } from '@/components/admin-core/types';

type AccountKind = 'user' | 'admin';

// 邮箱格式校验（前端 UX 层；真正的强制校验仍由后端负责）。
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function CreateAccountDialog({
  children,
  kind,
  onChanged,
}: {
  children: ReactNode;
  kind: AccountKind;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');

  async function create() {
    if (!EMAIL_RE.test(email.trim())) return toast.error('请输入有效的邮箱地址');
    if (password.length < 8) return toast.error('初始密码至少 8 位');
    const platformRole: PlatformRole = kind === 'admin' ? 'PLATFORM_ADMIN' : 'NONE';
    const ok = await run(
      () => api('/api/admin/users', {
        method: 'POST',
        body: {
          email: email.trim(),
          password,
          displayName: displayName.trim() || email.trim(),
          platformRole,
        },
      }),
      kind === 'admin' ? '平台管理员已创建' : '用户已创建',
    );
    if (!ok) return;
    setOpen(false);
    setEmail('');
    setDisplayName('');
    setPassword('');
    onChanged();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{kind === 'admin' ? '创建平台管理员' : '创建用户'}</DialogTitle>
          <DialogDescription>
            {kind === 'admin' ? '账号创建后立即具备平台管理权限。' : '创建普通用户账号。'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor={`${kind}-create-email`}>邮箱</Label>
            <Input
              id={`${kind}-create-email`}
              type="email"
              autoComplete="off"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="user@example.com"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${kind}-create-name`}>显示名</Label>
            <Input
              id={`${kind}-create-name`}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="默认使用邮箱"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${kind}-create-password`}>初始密码</Label>
            <Input
              id={`${kind}-create-password`}
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>取消</Button>
          <Button type="button" onClick={() => void create()}>创建</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function EditAccountDialog({
  user,
  kind,
  children,
  onChanged,
}: {
  user: UserSummary;
  kind: AccountKind;
  children: ReactNode;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState(user.email);
  const [displayName, setDisplayName] = useState(user.displayName);
  const [password, setPassword] = useState('');

  function handleOpenChange(nextOpen: boolean) {
    if (nextOpen) {
      setEmail(user.email);
      setDisplayName(user.displayName);
      setPassword('');
    }
    setOpen(nextOpen);
  }

  async function save() {
    if (!email.trim()) return toast.error('请输入邮箱');
    const body: Record<string, unknown> = {
      email: email.trim(),
      displayName: displayName.trim(),
    };
    if (password.trim()) body.password = password;
    const ok = await run(
      () => api(`/api/admin/users/${user.id}`, { method: 'PATCH', body }),
      kind === 'admin' ? '管理员信息已更新' : '用户信息已更新',
    );
    if (!ok) return;
    setOpen(false);
    onChanged();
  }

  async function changePlatformRole() {
    const platformRole: PlatformRole = kind === 'admin' ? 'NONE' : 'PLATFORM_ADMIN';
    const ok = await run(
      () => api(`/api/admin/users/${user.id}/platform-role`, {
        method: 'PATCH',
        body: { platformRole },
      }),
      kind === 'admin' ? '已降级为普通用户' : '已提升为平台管理员',
    );
    if (!ok) return;
    setOpen(false);
    onChanged();
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{kind === 'admin' ? '编辑管理员' : '编辑用户'}</DialogTitle>
          <DialogDescription>{user.email}</DialogDescription>
        </DialogHeader>
        <InfoGrid items={[
          ['账号 ID', user.id],
          ['当前角色', labelOf(user.platformRole)],
        ]} />
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor={`edit-email-${user.id}`}>邮箱</Label>
            <Input
              id={`edit-email-${user.id}`}
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`edit-name-${user.id}`}>显示名</Label>
            <Input
              id={`edit-name-${user.id}`}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`edit-password-${user.id}`}>新密码</Label>
            <Input
              id={`edit-password-${user.id}`}
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="留空则不修改"
            />
          </div>
        </div>
        <div className="rounded-lg border bg-muted/20 p-3">
          <div className="mb-2 text-sm font-medium">平台角色</div>
          <Button
            type="button"
            variant={kind === 'admin' ? 'destructive' : 'outline'}
            className="w-full"
            onClick={() => void changePlatformRole()}
          >
            {kind === 'admin' ? <ShieldOffIcon className="size-4" /> : <ShieldCheckIcon className="size-4" />}
            {kind === 'admin' ? '降级为普通用户' : '提升为平台管理员'}
          </Button>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>取消</Button>
          <Button type="button" onClick={() => void save()}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
