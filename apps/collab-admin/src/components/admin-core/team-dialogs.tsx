import { useState, type FormEvent, type ReactNode } from 'react';
import { SearchIcon } from 'lucide-react';
import { toast } from 'sonner';
import { AsyncResource } from '@/components/ui/async-resource';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { adminCoreApi } from '@/components/admin-core/api';
import type { TeamSummary } from '@/components/admin-core/types';
import { useAsyncResource } from '@/lib/async-resource';
import { api } from '@/lib/api';
import { run, useGuardedAction } from '@/lib/helpers';
import type { LedgerDirection } from '@/lib/types';
import { yuanToCents } from '@/lib/types';

export function CreateTeamDialog({
  children,
  onChanged,
}: {
  children: ReactNode;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [initialBalance, setInitialBalance] = useState('100');

  async function create() {
    if (!name.trim()) return toast.error('请输入团队名称');
    const ok = await run(
      () =>
        api('/api/admin/teams', {
          method: 'POST',
          body: { name: name.trim(), balanceCents: yuanToCents(initialBalance) },
        }),
      '团队已创建'
    );
    if (!ok) return;
    setOpen(false);
    setName('');
    setInitialBalance('100');
    onChanged();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>创建团队</DialogTitle>
          <DialogDescription>创建团队并设置初始共享余额。</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="create-team-name">团队名称</Label>
            <Input
              id="create-team-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="create-team-balance">初始余额（元）</Label>
            <Input
              id="create-team-balance"
              inputMode="decimal"
              value={initialBalance}
              onChange={(event) => setInitialBalance(event.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button type="button" onClick={() => void create()}>
            创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function EditTeamDialog({
  team,
  children,
  onChanged,
}: {
  team: TeamSummary;
  children: ReactNode;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(team.name);

  function handleOpenChange(nextOpen: boolean) {
    if (nextOpen) setName(team.name);
    setOpen(nextOpen);
  }

  async function save() {
    if (!name.trim()) return toast.error('请输入团队名称');
    const ok = await run(
      () => api(`/api/admin/teams/${team.id}`, { method: 'PATCH', body: { name: name.trim() } }),
      '团队信息已更新'
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
          <DialogTitle>编辑团队</DialogTitle>
          <DialogDescription>{team.slug}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor={`team-name-${team.id}`}>团队名称</Label>
          <Input
            id={`team-name-${team.id}`}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button type="button" onClick={() => void save()}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function BalanceAdjustmentDialog({
  team,
  children,
  onChanged,
}: {
  team: TeamSummary;
  children: ReactNode;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('100');
  const [direction, setDirection] = useState<LedgerDirection>('CREDIT');
  const [reason, setReason] = useState('平台管理员调整');
  const [busy, guard] = useGuardedAction();

  async function submit() {
    await guard(async () => {
      const ok = await run(
        () =>
          api(`/api/admin/teams/${team.id}/balance-adjustments`, {
            method: 'POST',
            body: { amountCents: yuanToCents(amount), direction, reason: reason.trim() },
          }),
        '团队余额已调整'
      );
      if (!ok) return;
      setOpen(false);
      setAmount('100');
      setReason('平台管理员调整');
      onChanged();
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>调整团队余额</DialogTitle>
          <DialogDescription>{team.name}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>方向</Label>
            <Select
              value={direction}
              onValueChange={(value) => setDirection(value as LedgerDirection)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="CREDIT">入账</SelectItem>
                <SelectItem value="DEBIT">扣减</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor={`team-balance-${team.id}`}>金额（元）</Label>
            <Input
              id={`team-balance-${team.id}`}
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`team-balance-reason-${team.id}`}>原因</Label>
          <Input
            id={`team-balance-reason-${team.id}`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button type="button" disabled={busy} onClick={() => void submit()}>
            {busy ? '提交中…' : '提交'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AssignTeamAdminDialog({
  team,
  children,
  onChanged,
}: {
  team: TeamSummary;
  children: ReactNode;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [draftQuery, setDraftQuery] = useState('');
  const [query, setQuery] = useState('');
  const [userId, setUserId] = useState('');

  const options = useAsyncResource((signal) => adminCoreApi.userOptions(query, signal), [query], {
    enabled: open,
    isEmpty: (data) => data.items.length === 0,
  });

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (!nextOpen) {
      setDraftQuery('');
      setQuery('');
      setUserId('');
    }
  }

  function search(event: FormEvent) {
    event.preventDefault();
    setUserId('');
    setQuery(draftQuery.trim());
  }

  async function assign() {
    if (!userId) return toast.error('请选择用户');
    const ok = await run(
      () => api(`/api/admin/teams/${team.id}/admins`, { method: 'POST', body: { userId } }),
      '团队管理员已指定'
    );
    if (!ok) return;
    setOpen(false);
    setDraftQuery('');
    setQuery('');
    setUserId('');
    onChanged();
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>指定团队管理员</DialogTitle>
          <DialogDescription>{team.name}</DialogDescription>
        </DialogHeader>
        <form className="flex gap-2" onSubmit={search}>
          <div className="relative min-w-0 flex-1">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={draftQuery}
              onChange={(event) => setDraftQuery(event.target.value)}
              placeholder="搜索邮箱或显示名"
              className="pl-9"
            />
          </div>
          <Button type="submit" variant="outline">
            搜索
          </Button>
        </form>
        <AsyncResource status={options.status} error={options.error} retry={options.reload}>
          {options.data ? (
            <Select value={userId} onValueChange={setUserId}>
              <SelectTrigger>
                <SelectValue placeholder="选择用户" />
              </SelectTrigger>
              <SelectContent>
                {options.data.items.map((user) => (
                  <SelectItem key={user.id} value={user.id}>
                    {user.displayName || user.email} · {user.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
        </AsyncResource>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button type="button" onClick={() => void assign()}>
            指定
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
