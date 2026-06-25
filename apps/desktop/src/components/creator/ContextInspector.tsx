// ContextInspector —— 上下文查看面板：显示当前发给模型的 system 提示、压缩摘要、保留的历史轮、
// 草稿文件清单、每部分 token 占比，让用户看清"模型到底看到了什么"。
//
// 从 FloatingCreator 接收 buildContextMessages 返回的 breakdown 结构，渲染成可折叠的分段面板。
import { useState } from 'react';
import { ChevronDownIcon, ChevronUpIcon, EyeIcon, FileTextIcon, ClockIcon, PencilIcon, ZapIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';

interface ContextBreakdown {
  systemPrompt: string;
  summary: string;
  keptTurns: Array<{ role: string; content: string }>;
  currentInput: string;
  estimatedTokens: { system: number; summary: number; history: number; input: number; total: number };
}

export function ContextInspector({ breakdown, open, onClose }: { breakdown: ContextBreakdown | null; open: boolean; onClose: () => void }) {
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(['tokens']));

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

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-h-[85vh] max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <EyeIcon className="size-4" />
            上下文查看
          </DialogTitle>
        </DialogHeader>
        <ScrollArea className="max-h-[calc(85vh-80px)]">
          <div className="space-y-3 pr-4">
            {/* Token 占比总览 */}
            <Section
              icon={ZapIcon}
              title="Token 占比"
              subtitle={`总计 ~${tok.total.toLocaleString()} tokens`}
              expanded={expandedSections.has('tokens')}
              onToggle={() => toggle('tokens')}
            >
              <div className="space-y-1.5 text-sm">
                <TokenBar label="系统提示" value={tok.system} total={tok.total} color="bg-blue-500" />
                {tok.summary > 0 && <TokenBar label="历史摘要" value={tok.summary} total={tok.total} color="bg-purple-500" />}
                <TokenBar label="保留历史" value={tok.history} total={tok.total} color="bg-green-500" />
                <TokenBar label="当前输入" value={tok.input} total={tok.total} color="bg-orange-500" />
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
              <pre className="whitespace-pre-wrap break-words rounded bg-muted p-3 text-xs leading-relaxed">{breakdown.systemPrompt}</pre>
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
                <pre className="whitespace-pre-wrap break-words rounded bg-muted p-3 text-xs leading-relaxed">{breakdown.summary}</pre>
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
                  <div key={i} className="rounded border bg-background p-2">
                    <div className="mb-1 text-xs font-medium text-muted-foreground">{t.role === 'user' ? '用户' : 'AI'}</div>
                    <pre className="whitespace-pre-wrap break-words text-xs leading-relaxed">{t.content.slice(0, 500)}{t.content.length > 500 ? '…' : ''}</pre>
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
              <pre className="whitespace-pre-wrap break-words rounded bg-muted p-3 text-xs leading-relaxed">{breakdown.currentInput}</pre>
            </Section>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
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
    <div className="overflow-hidden rounded-lg border bg-card">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-muted/50"
      >
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="font-medium">{title}</div>
          <div className="text-xs text-muted-foreground">{subtitle}</div>
        </div>
        {expanded ? <ChevronUpIcon className="size-4 shrink-0" /> : <ChevronDownIcon className="size-4 shrink-0" />}
      </button>
      {expanded && <div className="border-t px-3 py-3">{children}</div>}
    </div>
  );
}

function TokenBar({ label, value, total, color }: { label: string; value: number; total: number; color: string }) {
  const pct = total > 0 ? (value / total) * 100 : 0;
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono">{value.toLocaleString()} ({pct.toFixed(1)}%)</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
