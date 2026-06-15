import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { WalletIcon, ArrowDownLeftIcon, ArrowUpRightIcon } from 'lucide-react';
import { api, type ApiError } from '@/lib/api';
import { centsToYuan } from '@/lib/money';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { StaggerContainer, StaggerItem, Shimmer } from '@/lib/motion';

interface WalletTx {
  id: string;
  amount_cents: number;
  direction: 'debit' | 'credit';
  reason: string;
  plugin_id?: string | null;
  at: string;
}

interface WalletData {
  balance_cents: number;
  transactions: WalletTx[];
}

// 流水原因 → 中文展示。
const REASON_LABEL: Record<string, string> = {
  signup_bonus: '注册赠送',
  purchase: '购买插件',
  sale: '插件销售收入',
};

function fmtTime(iso: string): string {
  try { return new Date(iso).toLocaleString('zh-CN', { hour12: false }); } catch { return iso; }
}

export function Wallet() {
  const [data, setData] = useState<WalletData | null>(null);
  const loading = data === null;

  useEffect(() => {
    (async () => {
      try {
        setData(await api<WalletData>('/api/wallet'));
      } catch (e) {
        toast.error((e as ApiError).message);
        setData({ balance_cents: 0, transactions: [] });
      }
    })();
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><WalletIcon className="size-5 text-primary" />我的钱包</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground">当前余额</div>
          {/* 余额加载中时用骨架占位，避免「…」突兀；加载完成直接显示金额。 */}
          <div className="mt-1 text-4xl font-semibold tabular-nums">
            {loading ? <Shimmer className="h-9 w-40" /> : centsToYuan(data.balance_cents)}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">交易流水</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-2">
              {/* 列表加载骨架：4 行占位，宽高贴近真实流水行，加载完成后淡出。 */}
              {Array.from({ length: 4 }).map((_, i) => <Shimmer key={i} className="h-10 w-full" />)}
            </div>
          ) : data.transactions.length ? (
            // 流水行交错入场（尊重 useReducedMotion），每行轻微悬停反馈。
            <StaggerContainer className="flex flex-col divide-y" stagger={0.05}>
              {data.transactions.map((t) => {
                const credit = t.direction === 'credit';
                return (
                  <StaggerItem key={t.id} whileHover={{ x: 2, transition: { type: 'spring', stiffness: 300, damping: 20 } }}>
                    <div className="flex items-center gap-3 py-2.5">
                      <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-full', credit ? 'bg-green-100 text-green-600' : 'bg-red-100 text-red-600')}>
                        {credit ? <ArrowDownLeftIcon className="size-4" /> : <ArrowUpRightIcon className="size-4" />}
                      </span>
                      <div className="flex-1">
                        <div className="text-sm font-medium">{REASON_LABEL[t.reason] || t.reason}</div>
                        <div className="text-xs text-muted-foreground">{fmtTime(t.at)}</div>
                      </div>
                      <span className={cn('text-sm font-semibold tabular-nums', credit ? 'text-green-600' : 'text-red-600')}>
                        {credit ? '+' : '-'}{centsToYuan(t.amount_cents)}
                      </span>
                    </div>
                  </StaggerItem>
                );
              })}
            </StaggerContainer>
          ) : (
            <div className="flex flex-col items-center gap-2 py-6 text-sm text-muted-foreground">
              <span>还没有交易记录</span>
              <span className="text-xs">去市场安装或购买插件后，消费与收入会显示在这里。</span>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
