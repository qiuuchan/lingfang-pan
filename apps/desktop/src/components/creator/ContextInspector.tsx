// ContextInspector —— 上下文详情面板（Claude Code TUI / OpenCode 风格）。
//
// 显示当前发给模型的 system 提示、压缩摘要、保留的历史轮、每部分 token 占比，
// 以及「距离下次压缩还有多少」指示，让用户看清"模型到底看到了什么"。
// 视觉参考：终端风格的 monospace 数字 + 堆叠条形图 + 压缩进度环。
import { useState } from 'react';
import {
  ArchiveIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  EyeIcon,
  FileTextIcon,
  ClockIcon,
  PencilIcon,
  GaugeIcon,
  LayersIcon,
} from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

interface ContextBreakdown {
  systemPrompt: string;
  summary: string;
  keptTurns: Array<{ role: string; content: string }>;
  currentInput: string;
  estimatedTokens: {
    system: number;
    summary: number;
    history: number;
    input: number;
    total: number;
  };
  compressInfo: { threshold: number; currentTokens: number; remainingTokens: number; pct: number };
}

export function ContextInspector({
  breakdown,
  open,
  onClose,
  modelTokens,
  contextWindow,
  canCompress,
  compressing,
  onCompress,
}: {
  breakdown: ContextBreakdown | null;
  open: boolean;
  onClose: () => void;
  /** 粗估当前对话总 token（含 system + history + input）。 */
  modelTokens?: number;
  /** 模型上下文窗口大小（token），null 表示未知。 */
  contextWindow?: number | null;
  /** 是否允许手动压缩（有历史且非 busy 时）。 */
  canCompress?: boolean;
  /** 压缩进行中（按钮显示 loading）。 */
  compressing?: boolean;
  /** 点击「立即压缩」回调。 */
  onCompress?: () => void;
}) {
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(['overview']));

  function toggle(key: string) {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  if (!breakdown) return null;
  const tok = breakdown.estimatedTokens;
  const ci = breakdown.compressInfo;

  // 模型窗口占比（若 contextWindow 已知）。
  const winPct =
    contextWindow && contextWindow > 0
      ? Math.min(100, Math.round(((modelTokens ?? tok.total) / contextWindow) * 100))
      : null;
  // 压缩进度状态：pct≥100 表示已达阈值下次将压缩；≥80 即将压缩。
  const compressStatus = ci.pct >= 100 ? 'critical' : ci.pct >= 80 ? 'warning' : 'ok';

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-h-[85vh] max-w-3xl gap-0 overflow-hidden border bg-popover p-0 text-popover-foreground shadow-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 border-b px-5 py-4 text-base">
            <span className="inline-flex size-7 items-center justify-center rounded-md bg-muted text-foreground">
              <EyeIcon className="size-4" />
            </span>
            <span>上下文详情</span>
            {onCompress && (
              <button
                type="button"
                onClick={onCompress}
                disabled={!canCompress || compressing}
                title={
                  compressing
                    ? '正在压缩…'
                    : '把早期对话轮摘要成一条，降低上下文占用（保留近期轮与插件包）'
                }
                className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-md border border-border/70 bg-background px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-45"
              >
                <ArchiveIcon className={cn('size-3.5', compressing && 'animate-pulse')} />
                <span>{compressing ? '压缩中…' : '立即压缩'}</span>
              </button>
            )}
          </DialogTitle>
        </DialogHeader>
        <ScrollArea className="max-h-[calc(85vh-64px)]">
          <div className="flex flex-col gap-4 p-5 pr-6">
            {/* === 总览仪表盘（Claude Code 风格：两个并排指标） === */}
            <div className="grid grid-cols-1 overflow-hidden rounded-lg border bg-card/40 sm:grid-cols-2 sm:divide-x">
              {/* 模型窗口占用 */}
              <div className="border-b p-3.5 sm:border-b-0">
                <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <GaugeIcon className="size-3.5" />
                  模型窗口
                </div>
                {winPct !== null ? (
                  <>
                    <div className="mb-1 flex items-baseline justify-between">
                      <span className="font-mono text-lg font-semibold tabular-nums text-foreground">
                        {winPct}%
                      </span>
                      <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                        {(modelTokens ?? tok.total).toLocaleString()} /{' '}
                        {contextWindow!.toLocaleString()}
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-muted">
                      <div
                        className={cn(
                          'h-full rounded-full transition-all',
                          winPct > 90
                            ? 'bg-destructive'
                            : winPct > 70
                              ? 'bg-amber-500'
                              : 'bg-primary'
                        )}
                        style={{ width: `${winPct}%` }}
                      />
                    </div>
                  </>
                ) : (
                  <div className="text-sm text-muted-foreground">
                    未知窗口大小
                    <br />
                    <span className="font-mono text-xs">
                      ~{(modelTokens ?? tok.total).toLocaleString()} tokens
                    </span>
                  </div>
                )}
              </div>

              {/* 压缩进度（OpenCode 风格：距离下次压缩） */}
              <div className="p-3.5">
                <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <LayersIcon className="size-3.5" />
                  压缩进度
                </div>
                <div className="mb-1 flex items-baseline justify-between">
                  <span className="font-mono text-lg font-semibold tabular-nums text-foreground">
                    {Math.min(100, ci.pct)}%
                  </span>
                  <span
                    className={cn(
                      'font-mono text-[11px] tabular-nums text-muted-foreground',
                      compressStatus === 'critical' && 'text-destructive',
                      compressStatus === 'warning' && 'text-warning'
                    )}
                  >
                    {ci.remainingTokens > 0
                      ? `还需 ${ci.remainingTokens.toLocaleString()} tokens 压缩`
                      : '已达阈值，下次将压缩'}
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      'h-full rounded-full transition-all',
                      compressStatus === 'critical'
                        ? 'bg-destructive'
                        : compressStatus === 'warning'
                          ? 'bg-amber-500'
                          : 'bg-primary'
                    )}
                    style={{ width: `${Math.min(100, ci.pct)}%` }}
                  />
                </div>
              </div>
            </div>

            <div className="overflow-hidden rounded-lg border bg-card/20">
              {/* === Token 堆叠条形图（OpenCode 风格：一段段彩色拼成总量） === */}
              <Section
                icon={LayersIcon}
                title="Token 构成"
                subtitle={`总计 ~${tok.total.toLocaleString()} tokens`}
                expanded={expandedSections.has('overview')}
                onToggle={() => toggle('overview')}
              >
                {/* 堆叠总条 */}
                {tok.total > 0 && (
                  <div className="mb-3 flex h-3 w-full overflow-hidden rounded-full bg-muted">
                    <SegPct value={tok.system} total={tok.total} className="bg-blue-500" />
                    {tok.summary > 0 && (
                      <SegPct value={tok.summary} total={tok.total} className="bg-purple-500" />
                    )}
                    <SegPct value={tok.history} total={tok.total} className="bg-emerald-500" />
                    <SegPct value={tok.input} total={tok.total} className="bg-orange-500" />
                  </div>
                )}
                {/* 分项明细 */}
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                  <TokenLegend
                    label="系统提示"
                    value={tok.system}
                    total={tok.total}
                    color="bg-blue-500"
                  />
                  {tok.summary > 0 && (
                    <TokenLegend
                      label="历史摘要"
                      value={tok.summary}
                      total={tok.total}
                      color="bg-purple-500"
                    />
                  )}
                  <TokenLegend
                    label="保留历史"
                    value={tok.history}
                    total={tok.total}
                    color="bg-emerald-500"
                  />
                  <TokenLegend
                    label="当前输入"
                    value={tok.input}
                    total={tok.total}
                    color="bg-orange-500"
                  />
                </div>
              </Section>

              {/* 系统提示 */}
              <Section
                icon={FileTextIcon}
                title="系统提示"
                subtitle={`${tok.system.toLocaleString()} tokens`}
                expanded={expandedSections.has('system')}
                onToggle={() => toggle('system')}
              >
                <pre className="whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 font-mono text-xs leading-relaxed text-foreground">
                  {breakdown.systemPrompt}
                </pre>
              </Section>

              {/* 历史摘要 */}
              {breakdown.summary && (
                <Section
                  icon={ClockIcon}
                  title="历史摘要"
                  subtitle={`${tok.summary.toLocaleString()} tokens`}
                  expanded={expandedSections.has('summary')}
                  onToggle={() => toggle('summary')}
                >
                  <pre className="whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 font-mono text-xs leading-relaxed text-foreground">
                    {breakdown.summary}
                  </pre>
                </Section>
              )}

              {/* 保留的历史轮 */}
              <Section
                icon={ClockIcon}
                title="保留的历史轮"
                subtitle={`${breakdown.keptTurns.length} 条，${tok.history.toLocaleString()} tokens`}
                expanded={expandedSections.has('history')}
                onToggle={() => toggle('history')}
              >
                <div className="divide-y rounded-md border bg-background/60">
                  {breakdown.keptTurns.map((t, i) => (
                    <div key={i} className="p-2.5">
                      <div className="mb-1 flex items-center gap-1.5">
                        <span
                          className={cn(
                            'inline-flex h-4 items-center rounded-sm px-1.5 text-[10px] font-medium',
                            t.role === 'user'
                              ? 'bg-primary/10 text-primary'
                              : 'bg-muted text-muted-foreground'
                          )}
                        >
                          {t.role === 'user' ? '用户' : 'AI'}
                        </span>
                        <span className="font-mono text-[10px] text-muted-foreground tabular-nums">
                          {t.content.length.toLocaleString()} 字符
                        </span>
                      </div>
                      <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground">
                        {t.content.slice(0, 500)}
                        {t.content.length > 500 ? '…' : ''}
                      </pre>
                    </div>
                  ))}
                </div>
              </Section>

              {/* 当前输入 */}
              <Section
                icon={PencilIcon}
                title="当前输入"
                subtitle={`${tok.input.toLocaleString()} tokens`}
                expanded={expandedSections.has('input')}
                onToggle={() => toggle('input')}
              >
                <pre className="whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 font-mono text-xs leading-relaxed text-foreground">
                  {breakdown.currentInput}
                </pre>
              </Section>
            </div>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

/** 堆叠条形图的一段（按占比计算宽度）。 */
function SegPct({ value, total, className }: { value: number; total: number; className: string }) {
  const pct = total > 0 ? (value / total) * 100 : 0;
  if (pct <= 0) return null;
  return (
    <div
      className={cn('h-full', className)}
      style={{ width: `${pct}%` }}
      title={`${value.toLocaleString()} tokens (${pct.toFixed(1)}%)`}
    />
  );
}

/** Token 分项图例（色块 + 标签 + 数值）。 */
function TokenLegend({
  label,
  value,
  total,
  color,
}: {
  label: string;
  value: number;
  total: number;
  color: string;
}) {
  const pct = total > 0 ? (value / total) * 100 : 0;
  return (
    <div className="flex items-center gap-1.5">
      <span className={cn('size-2.5 shrink-0 rounded-sm', color)} />
      <span className="text-muted-foreground">{label}</span>
      <span className="ml-auto font-mono tabular-nums">{value.toLocaleString()}</span>
      <span className="font-mono text-muted-foreground tabular-nums">{pct.toFixed(0)}%</span>
    </div>
  );
}

function Section({
  icon: Icon,
  title,
  subtitle,
  expanded,
  onToggle,
  children,
}: {
  icon: typeof FileTextIcon;
  title: string;
  subtitle: string;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3.5 py-3 text-left transition-colors hover:bg-muted/50"
      >
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground">{title}</div>
          <div className="font-mono text-[11px] text-muted-foreground tabular-nums">{subtitle}</div>
        </div>
        {expanded ? (
          <ChevronUpIcon className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
        )}
      </button>
      {expanded && <div className="border-t bg-muted/20 px-3.5 py-3">{children}</div>}
    </div>
  );
}
