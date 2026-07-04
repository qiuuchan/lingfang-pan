// ContextInspector —— 上下文窗口查看面板（Claude Code TUI / OpenCode 风格）。
//
// 显示当前发给模型的 system 提示、压缩摘要、保留的历史轮、每部分 token 占比，
// 以及「距离下次压缩还有多少」指示，让用户看清"模型到底看到了什么"。
// 视觉参考：终端风格的 monospace 数字 + 堆叠条形图 + 压缩进度环。
import { useState } from 'react';
import {
  ChevronDownIcon, ChevronUpIcon, EyeIcon, FileTextIcon, ClockIcon, PencilIcon,
  GaugeIcon, LayersIcon,
} from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

interface ContextBreakdown {
  systemPrompt: string;
  summary: string;
  keptTurns: Array<{ role: string; content: string }>;
  currentInput: string;
  estimatedTokens: { system: number; summary: number; history: number; input: number; total: number };
  compressInfo: { threshold: number; currentChars: number; remainingChars: number; pct: number };
}

export function ContextInspector({
  breakdown,
  open,
  onClose,
  modelTokens,
  contextWindow,
}: {
  breakdown: ContextBreakdown | null;
  open: boolean;
  onClose: () => void;
  /** 粗估当前对话总 token（含 system + history + input）。 */
  modelTokens?: number;
  /** 模型上下文窗口大小（token），null 表示未知。 */
  contextWindow?: number | null;
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
  const winPct = contextWindow && contextWindow > 0 ? Math.min(100, Math.round(((modelTokens ?? tok.total) / contextWindow) * 100)) : null;
  // 压缩进度状态：pct≥100 表示已达阈值下次将压缩；≥80 即将压缩。
  const compressStatus = ci.pct >= 100 ? 'critical' : ci.pct >= 80 ? 'warning' : 'ok';

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-h-[85vh] max-w-3xl border-[#2a2a2c] bg-[#101012] p-0 text-[#e5e5e5] shadow-[0_24px_80px_rgba(0,0,0,0.5)]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 border-b border-[#242426] px-5 py-4 text-base">
            <span className="inline-flex size-7 items-center justify-center rounded-lg bg-[#1c1c1e] text-[#d7d7db]">
              <EyeIcon className="size-4" />
            </span>
            <span>上下文窗口</span>
          </DialogTitle>
        </DialogHeader>
        <ScrollArea className="max-h-[calc(85vh-64px)]">
          <div className="space-y-3 p-5 pr-6">
            {/* === 总览仪表盘（Claude Code 风格：两个并排指标） === */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {/* 模型窗口占用 */}
              <div className="rounded-xl border border-[#2a2a2c] bg-[#18181a] p-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
                <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-[#a0a0a3]">
                  <GaugeIcon className="size-3.5" />
                  模型窗口
                </div>
                {winPct !== null ? (
                  <>
                    <div className="mb-1 flex items-baseline justify-between">
                      <span className="font-mono text-lg font-semibold tabular-nums text-[#f4f4f5]">{winPct}%</span>
                      <span className="font-mono text-[11px] text-[#8a8a8f] tabular-nums">{(modelTokens ?? tok.total).toLocaleString()} / {contextWindow!.toLocaleString()}</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-[#2a2a2c]">
                      <div
                        className={cn(
                          'h-full rounded-full transition-all',
                          winPct > 90 ? 'bg-red-500' : winPct > 70 ? 'bg-amber-500' : 'bg-emerald-500',
                        )}
                        style={{ width: `${winPct}%` }}
                      />
                    </div>
                  </>
                ) : (
                  <div className="text-sm text-[#8a8a8f]">未知窗口大小<br /><span className="font-mono text-xs">~{(modelTokens ?? tok.total).toLocaleString()} tokens</span></div>
                )}
              </div>

              {/* 压缩进度（OpenCode 风格：距离下次压缩） */}
              <div className="rounded-xl border border-[#2a2a2c] bg-[#18181a] p-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
                <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-[#a0a0a3]">
                  <LayersIcon className="size-3.5" />
                  压缩进度
                </div>
                <div className="mb-1 flex items-baseline justify-between">
                  <span className="font-mono text-lg font-semibold tabular-nums text-[#f4f4f5]">{Math.min(100, ci.pct)}%</span>
                  <span className={cn(
                    'font-mono text-[11px] tabular-nums text-[#8a8a8f]',
                    compressStatus === 'critical' && 'text-red-400',
                    compressStatus === 'warning' && 'text-amber-400',
                  )}>
                    {ci.remainingChars > 0
                      ? `还需 ${ci.remainingChars.toLocaleString()} 字符`
                      : '已达阈值，下次将压缩'}
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-[#2a2a2c]">
                  <div
                    className={cn(
                      'h-full rounded-full transition-all',
                      compressStatus === 'critical' ? 'bg-red-500'
                        : compressStatus === 'warning' ? 'bg-amber-500'
                          : 'bg-sky-500',
                    )}
                    style={{ width: `${Math.min(100, ci.pct)}%` }}
                  />
                </div>
              </div>
            </div>

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
                <div className="mb-3 flex h-3 w-full overflow-hidden rounded-full bg-[#2a2a2c]">
                  <SegPct value={tok.system} total={tok.total} className="bg-blue-500" />
                  {tok.summary > 0 && <SegPct value={tok.summary} total={tok.total} className="bg-purple-500" />}
                  <SegPct value={tok.history} total={tok.total} className="bg-emerald-500" />
                  <SegPct value={tok.input} total={tok.total} className="bg-orange-500" />
                </div>
              )}
              {/* 分项明细 */}
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                <TokenLegend label="系统提示" value={tok.system} total={tok.total} color="bg-blue-500" />
                {tok.summary > 0 && <TokenLegend label="历史摘要" value={tok.summary} total={tok.total} color="bg-purple-500" />}
                <TokenLegend label="保留历史" value={tok.history} total={tok.total} color="bg-emerald-500" />
                <TokenLegend label="当前输入" value={tok.input} total={tok.total} color="bg-orange-500" />
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
              <pre className="whitespace-pre-wrap break-words rounded-lg bg-[#101012] p-3 font-mono text-xs leading-relaxed text-[#d7d7db]">{breakdown.systemPrompt}</pre>
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
                <pre className="whitespace-pre-wrap break-words rounded-lg bg-[#101012] p-3 font-mono text-xs leading-relaxed text-[#d7d7db]">{breakdown.summary}</pre>
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
              <div className="space-y-2">
                {breakdown.keptTurns.map((t, i) => (
                  <div key={i} className="rounded-lg border border-[#2a2a2c] bg-[#101012] p-2.5">
                    <div className="mb-1 flex items-center gap-1.5">
                      <span className={cn(
                        'inline-flex h-4 items-center rounded px-1.5 text-[10px] font-medium',
                        t.role === 'user' ? 'bg-sky-500/10 text-sky-300' : 'bg-[#252528] text-[#a0a0a3]',
                      )}>{t.role === 'user' ? '用户' : 'AI'}</span>
                      <span className="font-mono text-[10px] text-[#6f7076] tabular-nums">{t.content.length.toLocaleString()} 字符</span>
                    </div>
                    <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-[#d7d7db]">{t.content.slice(0, 500)}{t.content.length > 500 ? '…' : ''}</pre>
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
              <pre className="whitespace-pre-wrap break-words rounded-lg bg-[#101012] p-3 font-mono text-xs leading-relaxed text-[#d7d7db]">{breakdown.currentInput}</pre>
            </Section>
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
  return <div className={cn('h-full', className)} style={{ width: `${pct}%` }} title={`${value.toLocaleString()} tokens (${pct.toFixed(1)}%)`} />;
}

/** Token 分项图例（色块 + 标签 + 数值）。 */
function TokenLegend({ label, value, total, color }: { label: string; value: number; total: number; color: string }) {
  const pct = total > 0 ? (value / total) * 100 : 0;
  return (
    <div className="flex items-center gap-1.5">
      <span className={cn('size-2.5 shrink-0 rounded-sm', color)} />
      <span className="text-[#a0a0a3]">{label}</span>
      <span className="ml-auto font-mono tabular-nums">{value.toLocaleString()}</span>
      <span className="font-mono text-[#6f7076] tabular-nums">{pct.toFixed(0)}%</span>
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
    <div className="overflow-hidden rounded-xl border border-[#2a2a2c] bg-[#18181a]">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3.5 py-3 text-left transition-colors hover:bg-[#202023]"
      >
        <Icon className="size-4 shrink-0 text-[#8a8a8f]" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-[#e5e5e5]">{title}</div>
          <div className="font-mono text-[11px] text-[#8a8a8f] tabular-nums">{subtitle}</div>
        </div>
        {expanded ? <ChevronUpIcon className="size-4 shrink-0 text-[#8a8a8f]" /> : <ChevronDownIcon className="size-4 shrink-0 text-[#8a8a8f]" />}
      </button>
      {expanded && <div className="border-t border-[#2a2a2c] px-3.5 py-3">{children}</div>}
    </div>
  );
}
