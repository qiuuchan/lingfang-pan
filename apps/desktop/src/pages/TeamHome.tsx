import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CoinsIcon, PlugIcon, UsersIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { useApp } from '@/App';
import type { BalanceLedger, LoadedPlugin, TeamInfo } from '@/lib/types';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { LoadingButton } from '@/components/loading-button';
import { Button } from '@/components/ui/button';
import { centsToYuan } from '@/lib/money';

export function TeamHome() {
  const { session, setView } = useApp();
  const [team, setTeam] = useState<TeamInfo | null>(null);
  const [balance, setBalance] = useState(0);
  const [ledger, setLedger] = useState<BalanceLedger[]>([]);
  const [plugins, setPlugins] = useState<LoadedPlugin[]>([]);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [teamResult, balanceResult, ledgerResult, pluginResult] = await Promise.all([
        api<{ team: TeamInfo }>('/api/teams/current'),
        api<{ balanceCents: number }>('/api/teams/current/balance'),
        api<{ ledger: BalanceLedger[] }>('/api/teams/current/balance-ledger'),
        api<{ plugins: LoadedPlugin[] }>('/api/plugins/available'),
      ]);
      setTeam(teamResult.team);
      setBalance(balanceResult.balanceCents);
      setLedger(ledgerResult.ledger);
      setPlugins(pluginResult.plugins);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div><h1 className="text-2xl font-semibold tracking-tight">团队空间</h1><p className="text-sm text-muted-foreground">{team?.name || session.tenantName || '当前团队'} · {session.role === 'TEAM_ADMIN' ? '团队管理员' : '成员'}</p></div>
        <LoadingButton loading={loading} onClick={load}>刷新</LoadingButton>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <Metric icon={<UsersIcon />} label="团队" value={team?.name || '—'} desc={team?.slug || '团队标识'} />
        <Metric icon={<CoinsIcon />} label="共享余额" value={centsToYuan(balance)} desc="所有扣减均由系统记录" />
        <Metric icon={<PlugIcon />} label="可用插件" value={String(plugins.length)} desc="平台禁用插件不会显示" />
      </div>
      <Card>
        <CardHeader><CardTitle>可用插件</CardTitle><CardDescription>由平台管理员启用后，本地客户端才会展示。</CardDescription></CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          {plugins.length ? plugins.map((p) => <div key={p.id} className="rounded-lg border p-3"><div className="font-medium">{p.name}</div><p className="text-sm text-muted-foreground">{p.description || '暂无说明'}</p></div>) : <p className="text-sm text-muted-foreground">暂无启用插件。</p>}
          <Button variant="outline" onClick={() => setView('plugins')}>进入插件页</Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>最近余额流水</CardTitle><CardDescription>团队管理员只可查看，不能修改余额。</CardDescription></CardHeader>
        <CardContent className="divide-y rounded-lg border">
          {ledger.slice(0, 8).map((item) => <div key={item.id} className="flex items-center justify-between px-3 py-2 text-sm"><span>{item.reason}</span><span className={item.direction === 'CREDIT' ? 'text-emerald-600' : 'text-destructive'}>{item.direction === 'CREDIT' ? '+' : '-'}{centsToYuan(item.amountCents)}</span></div>)}
          {!ledger.length && <p className="p-3 text-sm text-muted-foreground">暂无流水。</p>}
        </CardContent>
      </Card>
    </div>
  );
}

function Metric({ icon, label, value, desc }: { icon: React.ReactNode; label: string; value: string; desc: string }) {
  return <Card><CardHeader><div className="mb-2 text-primary [&_svg]:size-5">{icon}</div><CardDescription>{label}</CardDescription><CardTitle className="truncate text-2xl">{value}</CardTitle></CardHeader><CardContent className="text-sm text-muted-foreground">{desc}</CardContent></Card>;
}