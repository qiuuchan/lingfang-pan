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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { centsToYuan, formatCreditAmount } from '@/lib/money';
import { modelTierFromRecord, modelTierRequestLabel } from '@/lib/model-tier';
import { Shimmer, StaggerContainer, StaggerItem } from '@/lib/motion';

interface CreditData { teamId: string; balance: number; }
interface CreditLedgerRow { id: string; amount: number; direction: 'CREDIT' | 'DEBIT'; source: string; reason: string; createdAt: string; }

// 流水统一行：悬浮窗内复用（余额/灵石两类各自格式化金额）。
interface LedgerRow { id: string; label: string; createdAt: string; direction: 'CREDIT' | 'DEBIT'; amountText: string; tierText?: string; }

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
  const [balanceLedgerOpen, setBalanceLedgerOpen] = useState(false);
  const [balanceLedgerLoaded, setBalanceLedgerLoaded] = useState(false);
  // 团队灵石。
  const [credit, setCredit] = useState<CreditData | null>(null);
  const [creditLedger, setCreditLedger] = useState<CreditLedgerRow[]>([]);
  const [creditLedgerOpen, setCreditLedgerOpen] = useState(false);
  const [creditLedgerLoaded, setCreditLedgerLoaded] = useState(false);

  useEffect(() => {
    void (async () => {
      const [b, c] = await Promise.all([
        api<{ balanceCents: number }>('/api/teams/current/balance').catch((e) => { toast.error(`团队余额加载失败：${(e as ApiError).message}`); return null; }),
        api<CreditData>('/api/teams/current/credits').catch((e) => { toast.error(`团队灵石加载失败：${(e as ApiError).message}`); return null; }),
      ]);
      // 失败保持 null（继续显示 Shimmer + 已 toast 报错），不要回退成 ¥0 误导用户以为余额为零。
      if (b) setBalanceCents(b.balanceCents);
      if (c) setCredit(c);
    })();
  }, []);

  // 打开余额流水悬浮窗（首次打开时按需拉取）。
  const openBalanceLedger = async () => {
    setBalanceLedgerOpen(true);
    if (!balanceLedgerLoaded) {
      try {
        const r = await api<{ ledger: BalanceLedger[] }>('/api/teams/current/balance-ledger');
        setBalanceLedger(r.ledger);
        setBalanceLedgerLoaded(true);
      } catch (e) { toast.error((e as ApiError).message); }
    }
  };

  // 打开灵石流水悬浮窗（首次打开时按需拉取）。
  const openCreditLedger = async () => {
    setCreditLedgerOpen(true);
    if (!creditLedgerLoaded) {
      try {
        const r = await api<{ ledger: CreditLedgerRow[] }>('/api/teams/current/credits/ledger');
        setCreditLedger(r.ledger);
        setCreditLedgerLoaded(true);
      } catch (e) { toast.error((e as ApiError).message); }
    }
  };

  const balanceRows: LedgerRow[] = balanceLedger.map((t) => ({
    id: t.id,
    label: BALANCE_REASON_LABEL[t.reason] ?? t.reason,
    createdAt: t.createdAt,
    direction: t.direction,
    amountText: `${t.direction === 'CREDIT' ? '+' : '-'}${centsToYuan(t.amountCents)}`,
  }));
  const creditRows: LedgerRow[] = creditLedger.map((t) => {
    const tier = modelTierFromRecord(t);
    return {
      id: t.id,
      label: CREDIT_SOURCE_LABEL[t.source] ?? t.source,
      createdAt: t.createdAt,
      direction: t.direction,
      amountText: `${t.direction === 'CREDIT' ? '+' : '-'}${formatCreditAmount(t.amount)}`,
      tierText: tier ? modelTierRequestLabel(tier) : undefined,
    };
  });

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
            <Button variant="outline" size="sm" onClick={() => void openBalanceLedger()}>查看流水</Button>
          </div>
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
            {credit ? formatCreditAmount(credit.balance) : <Shimmer className="h-9 w-32" />}
            <span className="ml-1 text-base font-normal text-muted-foreground">灵石</span>
          </div>
          <div className="mt-3">
            <Button variant="outline" size="sm" onClick={() => void openCreditLedger()}>查看流水</Button>
          </div>
        </CardContent>
      </Card>

      {/* 流水悬浮窗：余额 / 灵石各一。 */}
      <LedgerDialog
        open={balanceLedgerOpen}
        onOpenChange={setBalanceLedgerOpen}
        title="团队余额流水"
        description="插件市场购买与销售收入的明细。"
        loaded={balanceLedgerLoaded}
        rows={balanceRows}
      />
      <LedgerDialog
        open={creditLedgerOpen}
        onOpenChange={setCreditLedgerOpen}
        title="团队灵石流水"
        description="AI 对话与生图计费的明细。"
        loaded={creditLedgerLoaded}
        rows={creditRows}
      />
    </div>
  );
}

// 流水悬浮窗：居中 Dialog 展示一类账户的流水明细。
function LedgerDialog({
  open,
  onOpenChange,
  title,
  description,
  loaded,
  rows,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  loaded: boolean;
  rows: LedgerRow[];
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[56vh] overflow-y-auto">
          {!loaded ? (
            <div className="flex flex-col gap-2 py-2">
              {Array.from({ length: 4 }).map((_, i) => <Shimmer key={i} className="h-10 w-full" />)}
            </div>
          ) : rows.length ? (
            <StaggerContainer className="flex flex-col divide-y" stagger={0.04}>
              {rows.map((t) => {
                const credit_ = t.direction === 'CREDIT';
                return (
                  <StaggerItem key={t.id}>
                    <div className="flex items-center gap-3 py-2">
                      <div className="flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="text-sm font-medium">{t.label}</div>
                          {t.tierText ? <Badge variant="outline" className="h-5 px-1.5 text-[11px]">{t.tierText}</Badge> : null}
                        </div>
                        <div className="text-xs text-muted-foreground">{fmtTime(t.createdAt)}</div>
                      </div>
                      <span className={`text-sm font-semibold tabular-nums ${credit_ ? 'text-green-600' : 'text-red-600'}`}>
                        {t.amountText}
                      </span>
                    </div>
                  </StaggerItem>
                );
              })}
            </StaggerContainer>
          ) : (
            <div className="py-8 text-center text-sm text-muted-foreground">暂无流水</div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
