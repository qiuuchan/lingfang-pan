// TeamWallet.tsx — 团队钱包（整合原「团队空间」+「钱包」两页，团队成员共享）。
//
// 设计（见 task 06-24-billing-wallet design §4.5）：团队共享两类用途不同、互不换算的账户——
//  - 卡片 1「团队余额」（人民币，分）：插件市场购买/销售。GET /api/teams/current/balance + /balance-ledger。
//  - 卡片 2「团队灵石」（Float）：AI 对话/生图计费。GET /api/teams/current/credits + /credits/ledger。
// 两类账户明确区分用途、各自独立流水，不混显、不换算。
import { type ReactNode, useEffect, useState } from 'react';
import type { MarketplaceOrderListItem, MarketplaceOrderPage, MarketplaceStatementPage } from '@lingfang/contract';
import { toast } from 'sonner';
import { ArrowDownLeftIcon, ArrowUpRightIcon, CoinsIcon, HistoryIcon, ReceiptTextIcon, ShoppingBagIcon, SparklesIcon, StoreIcon, WalletIcon } from 'lucide-react';
import { api, type ApiError } from '@/lib/api';
import type { BalanceLedger } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { centsToYuan, formatCreditAmount } from '@/lib/money';
import { modelTierFromRecord, modelTierRequestLabel } from '@/lib/model-tier';
import { Shimmer, StaggerContainer, StaggerItem } from '@/lib/motion';

interface CreditData { teamId: string; balance: number; }
interface CreditLedgerRow { id: string; amount: number; direction: 'CREDIT' | 'DEBIT'; source: string; reason: string; createdAt: string; }
type MarketplaceOrderRow = MarketplaceOrderListItem;

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
  const [marketplaceView, setMarketplaceView] = useState<'buyer' | 'seller' | null>(null);
  const [buyerOrders, setBuyerOrders] = useState<MarketplaceOrderRow[]>([]);
  const [sellerOrders, setSellerOrders] = useState<MarketplaceOrderRow[]>([]);
  const [sellerPendingCents, setSellerPendingCents] = useState(0);
  const [marketplaceLoaded, setMarketplaceLoaded] = useState({ buyer: false, seller: false });

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

  const openMarketplace = async (view: 'buyer' | 'seller') => {
    setMarketplaceView(view);
    if (marketplaceLoaded[view]) return;
    try {
      if (view === 'buyer') {
        const result = await api<MarketplaceOrderPage>('/api/teams/current/plugin-purchases?pageSize=50');
        setBuyerOrders(result.items);
      } else {
        const result = await api<MarketplaceStatementPage>('/api/teams/current/marketplace-statement?pageSize=50&timezone=Asia%2FShanghai');
        setSellerOrders(result.items);
        setSellerPendingCents((result.summary.by_status?.PENDING_SETTLEMENT?.seller_cents ?? 0) + (result.summary.by_status?.REFUND_REQUESTED?.seller_cents ?? 0));
      }
      setMarketplaceLoaded((current) => ({ ...current, [view]: true }));
    } catch (e) { toast.error((e as ApiError).message); }
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
      <div className="grid gap-4 md:grid-cols-2">
        <AccountCard
          icon={<WalletIcon />}
          eyebrow="插件市场账户"
          title="团队余额"
          description="用于购买插件许可，销售收入也会进入此账户。"
          value={balanceCents === null ? null : centsToYuan(balanceCents)}
          loadingWidth="w-40"
          accent="primary"
          onLedger={() => void openBalanceLedger()}
        />
        <AccountCard
          icon={<CoinsIcon />}
          eyebrow="AI 计费账户"
          title="团队灵石"
          description="用于 AI 对话与生图调用，与人民币余额独立核算。"
          value={credit ? formatCreditAmount(credit.balance) : null}
          unit="灵石"
          loadingWidth="w-32"
          accent="violet"
          onLedger={() => void openCreditLedger()}
        />
      </div>

      <section className="overflow-hidden rounded-xl border bg-card shadow-sm">
        <div className="flex items-start gap-3 border-b bg-muted/25 p-4">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <ReceiptTextIcon className="size-5" />
          </span>
          <div>
            <h3 className="text-sm font-semibold">市场财务</h3>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">查看团队的插件订单、退款进度和卖家结算情况。</p>
          </div>
        </div>
        <div className="grid gap-px bg-border sm:grid-cols-2">
          <FinanceAction
            icon={<ShoppingBagIcon />}
            title="购买订单"
            description="查看许可费用、订单状态与退款期限"
            onClick={() => void openMarketplace('buyer')}
          />
          <FinanceAction
            icon={<StoreIcon />}
            title="卖家对账"
            description="查看销售收入、退款状态与待结算金额"
            onClick={() => void openMarketplace('seller')}
          />
        </div>
      </section>

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
      <MarketplaceOrdersDialog
        view={marketplaceView}
        onOpenChange={(open) => !open && setMarketplaceView(null)}
        loaded={marketplaceView ? marketplaceLoaded[marketplaceView] : false}
        rows={marketplaceView === 'seller' ? sellerOrders : buyerOrders}
        sellerPendingCents={sellerPendingCents}
      />
    </div>
  );
}

function AccountCard({ icon, eyebrow, title, description, value, unit, loadingWidth, accent, onLedger }: {
  icon: ReactNode;
  eyebrow: string;
  title: string;
  description: string;
  value: string | null;
  unit?: string;
  loadingWidth: string;
  accent: 'primary' | 'violet';
  onLedger: () => void;
}) {
  const violet = accent === 'violet';
  return (
    <section className="relative overflow-hidden rounded-xl border bg-card p-5 shadow-sm">
      <div className={`absolute -right-10 -top-10 size-32 rounded-full blur-3xl ${violet ? 'bg-violet-500/10' : 'bg-primary/10'}`} />
      <div className="relative flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className={`flex size-10 items-center justify-center rounded-full ${violet ? 'bg-violet-500/10 text-violet-600 dark:text-violet-400' : 'bg-primary/10 text-primary'} [&_svg]:size-5`}>
            {icon}
          </span>
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{eyebrow}</p>
            <h3 className="text-sm font-semibold">{title}</h3>
          </div>
        </div>
        <SparklesIcon className={`size-4 ${violet ? 'text-violet-500/50' : 'text-primary/40'}`} />
      </div>
      <div className="relative mt-6 flex min-h-10 items-baseline">
        {value === null ? <Shimmer className={`h-9 ${loadingWidth}`} /> : <span className="text-3xl font-semibold tracking-tight tabular-nums">{value}</span>}
        {value !== null && unit && <span className="ml-1.5 text-sm text-muted-foreground">{unit}</span>}
      </div>
      <p className="relative mt-2 min-h-9 text-xs leading-relaxed text-muted-foreground">{description}</p>
      <Button variant="outline" size="sm" className="relative mt-4 w-full justify-between" onClick={onLedger}>
        <span className="inline-flex items-center gap-1.5"><HistoryIcon />查看账户流水</span>
        <ArrowUpRightIcon />
      </Button>
    </section>
  );
}

function FinanceAction({ icon, title, description, onClick }: { icon: ReactNode; title: string; description: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="group flex items-center gap-3 bg-card p-4 text-left transition-colors hover:bg-muted/35">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground transition-colors group-hover:bg-primary/10 group-hover:text-primary [&_svg]:size-4">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{description}</span>
      </span>
      <ArrowUpRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-primary" />
    </button>
  );
}

function MarketplaceOrdersDialog({ view, onOpenChange, loaded, rows, sellerPendingCents }: {
  view: 'buyer' | 'seller' | null;
  onOpenChange: (open: boolean) => void;
  loaded: boolean;
  rows: MarketplaceOrderRow[];
  sellerPendingCents: number;
}) {
  const seller = view === 'seller';
  return <Dialog open={Boolean(view)} onOpenChange={onOpenChange}>
    <DialogContent className="overflow-hidden p-0 sm:max-w-2xl">
      <div className="border-b bg-muted/25 px-5 py-4">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">{seller ? <StoreIcon className="size-4 text-primary" /> : <ShoppingBagIcon className="size-4 text-primary" />}{seller ? '卖家市场对账' : '插件购买订单'}</DialogTitle>
        <DialogDescription>{seller ? `待结算卖家金额 ${centsToYuan(sellerPendingCents)}，以订单状态实时聚合。` : '许可费用使用团队人民币余额；AI 调用产生的灵石费用不随许可退款返还。'}</DialogDescription>
      </DialogHeader>
      </div>
      <div className="max-h-[60vh] overflow-y-auto p-4">
        {!loaded ? <div className="flex flex-col gap-2">{Array.from({ length: 4 }).map((_, index) => <Shimmer className="h-16 w-full rounded-lg" key={index} />)}</div>
          : rows.length === 0 ? <EmptyFinanceState icon={seller ? <StoreIcon /> : <ShoppingBagIcon />} text="暂无订单记录" />
            : <div className="divide-y overflow-hidden rounded-xl border">{rows.map((row) => <div className="flex items-start justify-between gap-4 bg-card p-3.5" key={row.id}>
              <div><div className="text-sm font-medium">{row.package_name}</div><div className="text-xs text-muted-foreground">{fmtTime(row.created_at)}{row.refundable_until && !seller ? ` · 退款申请截止 ${fmtTime(row.refundable_until)}` : ''}</div></div>
              <div className="text-right"><div className="text-sm font-semibold tabular-nums">{centsToYuan(seller ? row.seller_cents : row.price_cents)}</div><Badge variant="outline">{marketplaceStatus(row.status)}</Badge></div>
            </div>)}</div>}
      </div>
    </DialogContent>
  </Dialog>;
}

function marketplaceStatus(status: string) {
  return ({ PENDING_SETTLEMENT: '待结算', REFUND_REQUESTED: '退款审核中', SETTLED: '已结算', REFUNDED: '已退款' } as Record<string, string>)[status] ?? status;
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
      <DialogContent className="overflow-hidden p-0 sm:max-w-lg">
        <div className="border-b bg-muted/25 px-5 py-4">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><HistoryIcon className="size-4 text-primary" />{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        </div>
        <div className="max-h-[56vh] overflow-y-auto p-4">
          {!loaded ? (
            <div className="flex flex-col gap-2 py-2">
              {Array.from({ length: 4 }).map((_, i) => <Shimmer key={i} className="h-12 w-full rounded-lg" />)}
            </div>
          ) : rows.length ? (
            <StaggerContainer className="flex flex-col divide-y overflow-hidden rounded-xl border" stagger={0.04}>
              {rows.map((t) => {
                const credit_ = t.direction === 'CREDIT';
                return (
                  <StaggerItem key={t.id}>
                    <div className="flex items-center gap-3 bg-card p-3.5">
                      <span className={`flex size-8 shrink-0 items-center justify-center rounded-full ${credit_ ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-destructive/10 text-destructive'}`}>
                        {credit_ ? <ArrowDownLeftIcon className="size-4" /> : <ArrowUpRightIcon className="size-4" />}
                      </span>
                      <div className="flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="text-sm font-medium">{t.label}</div>
                          {t.tierText ? <Badge variant="outline" className="h-5 px-1.5 text-[11px]">{t.tierText}</Badge> : null}
                        </div>
                        <div className="text-xs text-muted-foreground">{fmtTime(t.createdAt)}</div>
                      </div>
                      <span className={`text-sm font-semibold tabular-nums ${credit_ ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'}`}>
                        {t.amountText}
                      </span>
                    </div>
                  </StaggerItem>
                );
              })}
            </StaggerContainer>
          ) : (
            <EmptyFinanceState icon={<HistoryIcon />} text="暂无流水记录" />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function EmptyFinanceState({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-10 text-center text-sm text-muted-foreground">
      <span className="flex size-11 items-center justify-center rounded-full bg-muted [&_svg]:size-5">{icon}</span>
      <span className="mt-3">{text}</span>
    </div>
  );
}
