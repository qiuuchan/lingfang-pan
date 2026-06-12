import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { BalanceLedger, InvitationCode, TeamMember } from '@/lib/types';
import { centsToYuan } from '@/lib/money';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Table as STable, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { LoadingButton } from '@/components/loading-button';
import { Button } from '@/components/ui/button';

export function TeamManage() {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [invitations, setInvitations] = useState<InvitationCode[]>([]);
  const [ledger, setLedger] = useState<BalanceLedger[]>([]);
  const [maxUses, setMaxUses] = useState('5');
  const [newCode, setNewCode] = useState('');
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [memberResult, inviteResult, ledgerResult] = await Promise.all([
        api<{ members: TeamMember[] }>('/api/teams/current/members'),
        api<{ invitations: InvitationCode[] }>('/api/teams/current/invitations'),
        api<{ ledger: BalanceLedger[] }>('/api/teams/current/balance-ledger'),
      ]);
      setMembers(memberResult.members);
      setInvitations(inviteResult.invitations);
      setLedger(ledgerResult.ledger);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function createInvitation() {
    setLoading(true);
    try {
      const result = await api<{ invitation: InvitationCode }>('/api/teams/current/invitations', { method: 'POST', body: { maxUses: Number(maxUses) || 1 } });
      setNewCode(result.invitation.code || '');
      await load();
      toast.success('邀请码已生成');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function removeMember(userId: string) {
    await run(() => api(`/api/teams/current/members/${userId}`, { method: 'DELETE' }).then(load));
  }

  async function disableInvitation(id: string) {
    await run(() => api(`/api/teams/current/invitations/${id}/disable`, { method: 'PATCH' }).then(load));
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between"><div><h1 className="text-2xl font-semibold tracking-tight">团队管理</h1><p className="text-sm text-muted-foreground">团队管理员可管理成员与邀请码，余额只读。</p></div><LoadingButton loading={loading} onClick={load}>刷新</LoadingButton></div>
      <Card>
        <CardHeader><CardTitle>生成邀请码</CardTitle><CardDescription>普通用户注册后必须凭有效邀请码加入团队。</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex max-w-sm gap-2"><Input value={maxUses} onChange={(e) => setMaxUses(e.target.value)} placeholder="最大使用次数" /><LoadingButton loading={loading} onClick={createInvitation}>生成</LoadingButton></div>
          {newCode && <div className="rounded-md border bg-muted/50 p-3 font-mono text-sm">{newCode}</div>}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>成员列表</CardTitle></CardHeader>
        <CardContent><DataTable headers={['成员', '邮箱', '角色', '操作']} rows={members.map((m) => [m.user.displayName, m.user.email, m.role, m.role === 'MEMBER' ? <Button key={m.userId} variant="destructive" onClick={() => removeMember(m.userId)}>移除</Button> : '团队管理员'])} /></CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>邀请码</CardTitle></CardHeader>
        <CardContent><DataTable headers={['前缀', '状态', '使用次数', '操作']} rows={invitations.map((i) => [i.displayCodePrefix, i.status, `${i.usedCount}/${i.maxUses}`, i.status === 'ACTIVE' ? <Button key={i.id} variant="outline" onClick={() => disableInvitation(i.id)}>禁用</Button> : '—'])} /></CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>余额流水</CardTitle><CardDescription>团队管理员不可调整余额。</CardDescription></CardHeader>
        <CardContent><DataTable headers={['原因', '方向', '金额', '时间']} rows={ledger.map((l) => [l.reason, l.direction, centsToYuan(l.amountCents), new Date(l.createdAt).toLocaleString()])} /></CardContent>
      </Card>
    </div>
  );
}

function DataTable({ headers, rows }: { headers: string[]; rows: React.ReactNode[][] }) {
  return (
    <STable className="rounded-lg border">
      <TableHeader>
        <TableRow>
          {headers.map((h) => <TableHead key={h} className="px-3 py-2">{h}</TableHead>)}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, i) => (
          <TableRow key={i}>
            {row.map((cell, j) => <TableCell key={j} className="px-3 py-2">{cell}</TableCell>)}
          </TableRow>
        ))}
      </TableBody>
    </STable>
  );
}

async function run(fn: () => Promise<unknown>) {
  try { await fn(); toast.success('操作成功'); }
  catch (e) { toast.error((e as Error).message); }
}