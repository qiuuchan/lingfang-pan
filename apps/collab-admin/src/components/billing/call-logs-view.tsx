// 调用日志视图：多维度筛选 + 详情。仿 audit-view.tsx。见 docs/billing-and-relay-design.md §11.5.1 ⑤。
import { useEffect, useState } from 'react';
import { RotateCwIcon, EyeIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { Section } from '@/components/shared';
import { InfoGrid } from '@/components/shared';
import { usePagination, Pagination } from '@/components/ui/pagination';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import type { LlmCallLog } from '@/lib/types';

function statusBadge(s: string) {
  if (s === 'success') return <Badge variant="success">成功</Badge>;
  if (s === 'insufficient_balance') return <Badge variant="destructive">余额不足</Badge>;
  if (s === 'upstream_error' || s === 'no_channel') return <Badge variant="destructive">失败</Badge>;
  return <Badge variant="secondary">{s}</Badge>;
}

export function CallLogsView() {
  const [logs, setLogs] = useState<LlmCallLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [teamId, setTeamId] = useState('ALL');
  const [capability, setCapability] = useState('ALL');
  const [status, setStatus] = useState('ALL');

  const params = new URLSearchParams();
  if (teamId !== 'ALL') params.set('teamId', teamId);
  if (capability !== 'ALL') params.set('capability', capability);
  if (status !== 'ALL') params.set('status', status);
  const qs = params.toString();

  useEffect(() => {
    let mounted = true; setLoading(true);
    api<{ logs: LlmCallLog[] }>(`/api/admin/billing/call-logs${qs ? `?${qs}` : ''}`).then((r) => mounted && setLogs(r.logs)).finally(() => mounted && setLoading(false));
    return () => { mounted = false; };
  }, [qs]);

  const { paginated, page, setPage, pageSize, setPageSize, totalItems } = usePagination(logs);
  const reload = () => { setLoading(true); api<{ logs: LlmCallLog[] }>(`/api/admin/billing/call-logs${qs ? `?${qs}` : ''}`).then((r) => setLogs(r.logs)).finally(() => setLoading(false)); };

  return (
    <Section title="调用日志" description="AI 调用全链路记录，支持多维度查询。">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input className="sm:w-48" placeholder="团队 ID（精确）" value={teamId === 'ALL' ? '' : teamId} onChange={(e) => setTeamId(e.target.value.trim() || 'ALL')} />
        <Select value={capability} onValueChange={setCapability}><SelectTrigger className="w-32"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="ALL">全部能力</SelectItem><SelectItem value="chat">对话</SelectItem><SelectItem value="image">生图</SelectItem><SelectItem value="action">动作</SelectItem></SelectContent></Select>
        <Select value={status} onValueChange={setStatus}><SelectTrigger className="w-32"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="ALL">全部状态</SelectItem><SelectItem value="success">成功</SelectItem><SelectItem value="upstream_error">失败</SelectItem><SelectItem value="insufficient_balance">余额不足</SelectItem></SelectContent></Select>
        <Button variant="outline" size="sm" onClick={reload} disabled={loading}><RotateCwIcon className={`size-4 ${loading ? 'animate-spin' : ''}`} />刷新</Button>
      </div>
      <Table>
        <TableHeader><TableRow><TableHead>时间</TableHead><TableHead>团队/用户</TableHead><TableHead>能力</TableHead><TableHead>模型</TableHead><TableHead>池子</TableHead><TableHead>灵石</TableHead><TableHead>耗时</TableHead><TableHead>状态</TableHead><TableHead className="w-[60px]">详情</TableHead></TableRow></TableHeader>
        <TableBody>
          {paginated.length ? paginated.map((l) => (
            <TableRow key={l.id}>
              <TableCell className="text-xs text-muted-foreground">{new Date(l.createdAt).toLocaleString('zh-CN', { hour12: false })}</TableCell>
              <TableCell><div className="text-sm">{l.team?.name ?? l.teamId.slice(0, 8)}</div><div className="text-xs text-muted-foreground">{l.user?.email ?? '—'}</div></TableCell>
              <TableCell className="text-muted-foreground">{l.capability}</TableCell>
              <TableCell className="font-mono text-xs">{l.model}</TableCell>
              <TableCell>{l.poolName ? <Badge variant="secondary">{l.poolName}</Badge> : <span className="text-xs text-muted-foreground">—</span>}</TableCell>
              <TableCell className="tabular-nums">{l.credits}</TableCell>
              <TableCell className="tabular-nums text-muted-foreground">{(l.durationMs / 1000).toFixed(1)}s</TableCell>
              <TableCell>{statusBadge(l.status)}</TableCell>
              <TableCell>
                <Dialog><DialogTrigger asChild><Button variant="ghost" size="icon" className="size-8"><EyeIcon className="size-4" /></Button></DialogTrigger><DialogContent className="sm:max-w-md"><DialogHeader><DialogTitle>调用详情</DialogTitle></DialogHeader>
                  <InfoGrid items={[
                    ['模型', l.model], ['能力', l.capability], ['版本', l.tier ?? '—'],
                    ['输入 token', l.inputTokens], ['输出 token', l.outputTokens], ['生图张数', l.images],
                    ['灵石', l.credits], ['耗时', `${(l.durationMs / 1000).toFixed(2)}s`], ['HTTP', l.httpStatus ?? '—'],
                    ['错误码', l.errorCode ?? '—'], ['渠道', l.channelName ?? l.channelId ?? '—'], ['池子', l.poolName ?? '—'], ['IP', l.clientIp ?? '—'],
                  ]} />
                  <div className="text-xs text-muted-foreground">请求摘要</div>
                  <pre className="max-h-40 overflow-auto rounded bg-muted p-2 text-xs">{JSON.stringify(l.requestSummary, null, 2)}</pre>
                </DialogContent></Dialog>
              </TableCell>
            </TableRow>
          )) : <TableRow><TableCell colSpan={9} className="py-8 text-center text-muted-foreground">{loading ? '加载中…' : '暂无调用日志'}</TableCell></TableRow>}
        </TableBody>
      </Table>
      <Pagination totalItems={totalItems} pageSize={pageSize} currentPage={page} onPageChange={setPage} onPageSizeChange={setPageSize} />
    </Section>
  );
}
