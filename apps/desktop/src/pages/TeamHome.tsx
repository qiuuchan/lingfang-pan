import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CoinsIcon, UsersIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { useApp } from '@/App';
import type { BalanceLedger, TeamInfo } from '@/lib/types';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { LoadingButton } from '@/components/loading-button';
import { centsToYuan } from '@/lib/money';
import { StaggerContainer, StaggerItem, Shimmer } from '@/lib/motion';

export function TeamHome() {
  const { session } = useApp();
  const [team, setTeam] = useState<TeamInfo | null>(null);
  const [balance, setBalance] = useState(0);
  const [ledger, setLedger] = useState<BalanceLedger[]>([]);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [teamResult, balanceResult, ledgerResult] = await Promise.all([
        api<{ team: TeamInfo }>('/api/teams/current'),
        api<{ balanceCents: number }>('/api/teams/current/balance'),
        api<{ ledger: BalanceLedger[] }>('/api/teams/current/balance-ledger'),
      ]);
      setTeam(teamResult.team);
      setBalance(balanceResult.balanceCents);
      setLedger(ledgerResult.ledger);
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
      {/* 指标卡片交错入场 + 悬停弹性（尊重 useReducedMotion）。
          团队名加载时显示「—」；余额/数量加载时用骨架占位，避免「0」误导。 */}
      <StaggerContainer className="grid gap-4 md:grid-cols-2" stagger={0.08}>
        <StaggerItem whileHover={{ y: -4, transition: { type: 'spring', stiffness: 300, damping: 18 } }}>
          <Metric icon={<UsersIcon />} label="团队" value={team?.name || '—'} desc={team?.slug || '团队标识'} />
        </StaggerItem>
        <StaggerItem whileHover={{ y: -4, transition: { type: 'spring', stiffness: 300, damping: 18 } }}>
          <Metric icon={<CoinsIcon />} label="共享余额" value={loading ? undefined : centsToYuan(balance)} desc="所有扣减均由系统记录" />
        </StaggerItem>
      </StaggerContainer>
      <Card>
        <CardHeader><CardTitle>最近余额流水</CardTitle><CardDescription>团队管理员只可查看，不能修改余额。</CardDescription></CardHeader>
        <CardContent>
          <div className="divide-y rounded-lg border">
            {loading ? (
              // 流水加载骨架：4 行占位。
              Array.from({ length: 4 }).map((_, i) => <Shimmer key={i} className="m-1 h-8 w-[calc(100%-0.5rem)]" />)
            ) : (
              <>
                {ledger.slice(0, 8).map((item) => <div key={item.id} className="flex items-center justify-between px-3 py-2 text-sm"><span>{item.reason}</span><span className={item.direction === 'CREDIT' ? 'text-emerald-600' : 'text-destructive'}>{item.direction === 'CREDIT' ? '+' : '-'}{centsToYuan(item.amountCents)}</span></div>)}
                {!ledger.length && <p className="p-3 text-center text-sm text-muted-foreground">还没有余额流水</p>}
              </>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Metric({ icon, label, value, desc }: { icon: React.ReactNode; label: string; value?: string; desc: string }) {
  return <Card><CardHeader><div className="mb-2 text-primary [&_svg]:size-5">{icon}</div><CardDescription>{label}</CardDescription>{value === undefined ? <Shimmer className="mt-1 h-7 w-24" /> : <CardTitle className="truncate text-2xl">{value}</CardTitle>}</CardHeader><CardContent className="text-sm text-muted-foreground">{desc}</CardContent></Card>;
}
