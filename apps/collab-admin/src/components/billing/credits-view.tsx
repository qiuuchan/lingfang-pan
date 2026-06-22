// 灵石账户视图：团队余额总览 + 调整 + 流水。见 docs/billing-and-relay-design.md §11.5.1 ④。
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useLoad, run } from '@/lib/helpers';
import { Section } from '@/components/shared';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';

type TeamRow = { id: string; name: string; balance: number; _count?: { memberships: number } };
type LedgerRow = { id: string; amount: number; direction: 'CREDIT' | 'DEBIT'; source: string; reason: string; actorUserId: string | null; createdAt: string };

function sourceLabel(s: string): string {
  return ({ signup_bonus: '注册赠送', llm_consume: 'AI 对话消费', image_consume: 'AI 生图消费', reserve: '预扣', refund: '冲销/退回', admin_adjust: '管理员调整', purchase: '充值' } as Record<string, string>)[s] ?? s;
}

export function CreditsView() {
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const load = async () => {
    const tr = await api<{ teams: TeamRow[] }>('/api/admin/teams');
    const withBal = await Promise.all(tr.teams.map(async (t: any) => {
      try { const b = await api<{ balance: number }>(`/api/admin/billing/credits/teams/${t.id}`); return { ...t, balance: b.balance }; }
      catch { return { ...t, balance: 0 }; }
    }));
    setTeams(withBal);
  };
  useLoad(load);

  return (
    <Section title="灵石账户" description="团队灵石（AI 用量计费货币，独立于人民币余额）总览与调整。">
      <Table>
        <TableHeader><TableRow><TableHead>团队</TableHead><TableHead>余额（灵石）</TableHead><TableHead>成员</TableHead><TableHead className="w-[260px]">操作</TableHead></TableRow></TableHeader>
        <TableBody>
          {teams.length ? teams.map((t) => (
            <TableRow key={t.id}>
              <TableCell className="font-medium">{t.name}</TableCell>
              <TableCell className="tabular-nums">{t.balance.toLocaleString()}</TableCell>
              <TableCell className="text-muted-foreground">{t._count?.memberships ?? '—'}</TableCell>
              <TableCell>
                <AdjustDialog team={t} onSaved={load}><Button variant="outline" size="sm">调整余额</Button></AdjustDialog>{' '}
                <LedgerDialog team={t}><Button variant="outline" size="sm">查看流水</Button></LedgerDialog>
              </TableCell>
            </TableRow>
          )) : <TableRow><TableCell colSpan={4} className="py-8 text-center text-muted-foreground">暂无团队</TableCell></TableRow>}
        </TableBody>
      </Table>
    </Section>
  );
}

function AdjustDialog({ team, children, onSaved }: { team: TeamRow; children: React.ReactNode; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [direction, setDirection] = useState<'CREDIT' | 'DEBIT'>('CREDIT');
  const [reason, setReason] = useState('');
  async function submit() {
    const body = { amount: Number(amount), direction, reason: reason.trim() };
    if (!body.amount || body.amount <= 0) return;
    if (!body.reason) return;
    if (!(await run(() => api(`/api/admin/billing/credits/teams/${team.id}/adjustments`, { method: 'POST', body }).then(onSaved), '灵石已调整'))) return;
    setOpen(false); setAmount(''); setReason('');
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}><DialogTrigger asChild>{children}</DialogTrigger><DialogContent className="sm:max-w-md"><DialogHeader><DialogTitle>调整灵石 · {team.name}</DialogTitle><DialogDescription>当前余额 {team.balance.toLocaleString()} 灵石</DialogDescription></DialogHeader>
      <div className="space-y-3">
        <div className="space-y-2"><Label>金额（灵石）</Label><Input type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
        <div className="space-y-2"><Label>方向</Label><Select value={direction} onValueChange={(v) => setDirection(v as 'CREDIT' | 'DEBIT')}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="CREDIT">加款</SelectItem><SelectItem value="DEBIT">扣款</SelectItem></SelectContent></Select></div>
        <div className="space-y-2"><Label>原因（必填）</Label><Input value={reason} onChange={(e) => setReason(e.target.value)} /></div>
      </div>
      <DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>取消</Button><Button onClick={submit}>确认</Button></DialogFooter></DialogContent>
  </Dialog>
  );
}

function LedgerDialog({ team, children }: { team: TeamRow; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<LedgerRow[]>([]);
  useEffect(() => {
    if (!open) return;
    let mounted = true;
    api<{ ledger: LedgerRow[] }>(`/api/admin/billing/credits/teams/${team.id}/ledger`).then((r) => mounted && setRows(r.ledger)).catch(() => undefined);
    return () => { mounted = false; };
  }, [open, team.id]);
  return (
    <Dialog open={open} onOpenChange={setOpen}><DialogTrigger asChild>{children}</DialogTrigger><DialogContent className="sm:max-w-lg"><DialogHeader><DialogTitle>灵石流水 · {team.name}</DialogTitle></DialogHeader>
      <div className="max-h-96 overflow-auto">
        <Table><TableHeader><TableRow><TableHead>时间</TableHead><TableHead>来源</TableHead><TableHead>金额</TableHead></TableRow></TableHeader>
          <TableBody>{rows.length ? rows.map((r) => (
            <TableRow key={r.id}><TableCell className="text-xs text-muted-foreground">{new Date(r.createdAt).toLocaleString('zh-CN', { hour12: false })}</TableCell><TableCell>{sourceLabel(r.source)}<div className="text-xs text-muted-foreground">{r.reason}</div></TableCell><TableCell className={r.direction === 'CREDIT' ? 'text-green-600 tabular-nums' : 'text-red-600 tabular-nums'}>{r.direction === 'CREDIT' ? '+' : '-'}{r.amount}</TableCell></TableRow>
          )) : <TableRow><TableCell colSpan={3} className="py-6 text-center text-muted-foreground">暂无流水</TableCell></TableRow>}</TableBody>
        </Table>
      </div>
      <DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>关闭</Button></DialogFooter></DialogContent>
    </Dialog>
  );
}
