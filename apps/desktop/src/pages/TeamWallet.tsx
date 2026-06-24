// TeamWallet.tsx — 团队钱包（整合原「团队空间」+「钱包」两页，团队成员共享）。
//
// 设计（见 task 06-24-billing-wallet design §4.5）：团队共享两类用途不同、互不换算的账户——
//  - 卡片 1「团队余额」（人民币，分）：插件市场购买/销售。GET /api/teams/current/balance + /balance-ledger。
//  - 卡片 2「团队灵石」（Float）：AI 对话/生图计费。GET /api/teams/current/credits + /credits/ledger。
// 两类账户明确区分用途、各自独立流水，不混显、不换算。
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CoinsIcon, WalletIcon } from 'lucide-react';
import { api, type ApiError } from '@/lib/api';
import type { BalanceLedger } from '@/lib/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { centsToYuan } from '@/lib/money';
import { Shimmer, StaggerContainer, StaggerItem } from '@/lib/motion';

interface CreditData { teamId: string; balance: number; }
interface CreditLedgerRow { id: string; amount: number; direction: 'CREDIT' | 'DEBIT'; source: string; reason: string; createdAt: string; }

// 灵石流水来源 → 中文。
const CREDIT_SOURCE_LABEL: Record<string, string> = {
  signup_bonus: '注册赠送', llm_consume: 'AI 对话消费', image_consume: 'AI 生图消费',
  reserve: '预扣', refund: '冲销/退回', admin_adjust: '管理员调整', purchase: '充值',
};
// 余额流水原因 → 中文。
const BALANCE_REASON_LABEL: Record<string, string> = {
  initial_balance: '初始余额', admin_adjust: '管理员调整', admin_credit: '管理员充值',
  plugin_purchase: '购买插件', plugin_sale: '插件销售收入', consume: '消费',
};

function fmtTime(iso?: string | null): string {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('zh-CN', { hour12: false }); } catch { return iso; }
}

export function TeamWallet() {
  // 团队余额（人民币分）。
  const [balanceCents, setBalanceCents] = useState<number | null>(null);
  const [balanceLedger, setBalanceLedger] = useState<BalanceLedger[]>([]);
  const [showBalanceLedger, setShowBalanceLedger] = useState(false);
  // 团队灵石。
  const [credit, setCredit] = useState<CreditData | null>(null);
  const [creditLedger, setCreditLedger] = useState<CreditLedgerRow[]>([]);
  const [showCreditLedger, setShowCreditLedger] = useState(false);

  useEffect(() => {
    void (async () => {
      const [b, c] = await Promise.all([
        api<{ balanceCents: number }>('/api/teams/current/balance').catch(() => null),
        api<CreditData>('/api/teams/current/credits').catch(() => null),
      ]);
      setBalanceCents(b?.balanceCents ?? 0);
      setCredit(c);
    })();
  }, []);

  const toggleBalanceLedger = async () => {
    if (!showBalanceLedger && balanceLedger.length === 0) {
      try {
        const r = await api<{ ledger: BalanceLedger[] }>('/api/teams/current/balance-ledger');
        setBalanceLedger(r.ledger);
      } catch (e) { toast.error((e as ApiError).message); }
    }
    setShowBalanceLedger(!showBalanceLedger);
  };

  const toggleCreditLedger = async () => {
    if (!showCreditLedger && creditLedger.length === 0) {
      try {
        const r = await api<{ ledger: CreditLedgerRow[] }>('/api/teams/current/credits/ledger');
        setCreditLedger(r.ledger);
      } catch (e) { toast.error((e as ApiError).message); }
    }
    setShowCreditLedger(!showCreditLedger);
  };

  return (
    <div className="flex flex-col gap-4">
      {/* 卡片 1：团队余额（人民币）——插件市场购买/销售。 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><WalletIcon className="size-5 text-primary" />团队余额</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground">团队共享余额 · 插件市场购买</div>
          <div className="mt-1 text-4xl font-semibold tabular-nums">
            {balanceCents === null ? <Shimmer className="h-9 w-40" /> : centsToYuan(balanceCents)}
          </div>
          <div className="mt-3">
            <Button variant="outline" size="sm" onClick={() => void toggleBalanceLedger()}>
              {showBalanceLedger ? '隐藏流水' : '查看流水'}
            </Button>
          </div>
          {showBalanceLedger && (
            <StaggerContainer className="mt-3 flex flex-col divide-y" stagger={0.04}>
              {balanceLedger.length ? balanceLedger.map((t) => {
                const credit_ = t.direction === 'CREDIT';
                return (
                  <StaggerItem key={t.id}>
                    <div className="flex items-center gap-3 py-2">
                      <div className="flex-1">
                        <div className="text-sm font-medium">{BALANCE_REASON_LABEL[t.reason] ?? t.reason}</div>
                        <div className="text-xs text-muted-foreground">{fmtTime(t.createdAt)}</div>
                      </div>
                      <span className={`text-sm font-semibold tabular-nums ${credit_ ? 'text-green-600' : 'text-red-600'}`}>
                        {credit_ ? '+' : '-'}{centsToYuan(t.amountCents)}
                      </span>
                    </div>
                  </StaggerItem>
                );
              }) : <div className="py-3 text-sm text-muted-foreground">暂无流水</div>}
            </StaggerContainer>
          )}
        </CardContent>
      </Card>

      {/* 卡片 2：团队灵石——AI 对话/生图计费。 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><CoinsIcon className="size-5 text-primary" />团队灵石</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground">团队共享灵石 · AI 对话计费</div>
          <div className="mt-1 text-4xl font-semibold tabular-nums">
            {credit ? credit.balance.toLocaleString() : <Shimmer className="h-9 w-32" />}
            <span className="ml-1 text-base font-normal text-muted-foreground">灵石</span>
          </div>
          <div className="mt-3">
            <Button variant="outline" size="sm" onClick={() => void toggleCreditLedger()}>
              {showCreditLedger ? '隐藏流水' : '查看流水'}
            </Button>
          </div>
          {showCreditLedger && (
            <StaggerContainer className="mt-3 flex flex-col divide-y" stagger={0.04}>
              {creditLedger.length ? creditLedger.map((t) => {
                const credit_ = t.direction === 'CREDIT';
                return (
                  <StaggerItem key={t.id}>
                    <div className="flex items-center gap-3 py-2">
                      <div className="flex-1">
                        <div className="text-sm font-medium">{CREDIT_SOURCE_LABEL[t.source] ?? t.source}</div>
                        <div className="text-xs text-muted-foreground">{fmtTime(t.createdAt)}</div>
                      </div>
                      <span className={`text-sm font-semibold tabular-nums ${credit_ ? 'text-green-600' : 'text-red-600'}`}>
                        {credit_ ? '+' : '-'}{t.amount}
                      </span>
                    </div>
                  </StaggerItem>
                );
              }) : <div className="py-3 text-sm text-muted-foreground">暂无流水</div>}
            </StaggerContainer>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
