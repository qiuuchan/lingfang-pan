// API Key 总览视图（平台管理员视角，仅吊销）。见 docs/billing-and-relay-design.md §11.5.1 ⑥。
import { useState } from 'react';
import { Trash2Icon } from 'lucide-react';
import { api } from '@/lib/api';
import { useLoad, run } from '@/lib/helpers';
import { Section, ActionBar } from '@/components/shared';
import { usePagination, Pagination } from '@/components/ui/pagination';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { PlatformApiKeyPublic } from '@/lib/types';

type Row = PlatformApiKeyPublic & { teamName?: string };

export function ApiKeysView() {
  const [keys, setKeys] = useState<Row[]>([]);
  const load = () => api<{ apiKeys: Row[] }>('/api/admin/billing/api-keys').then((r) => setKeys(r.apiKeys));
  useLoad(load);
  const { paginated, page, setPage, pageSize, setPageSize, totalItems } = usePagination(keys);

  async function revoke(k: Row) {
    if (!window.confirm(`吊销 API Key「${k.keyPrefix}…」（${k.name}）？吊销后立即失效。`)) return;
    await run(() => api(`/api/admin/billing/api-keys/${k.id}`, { method: 'DELETE' }).then(load), 'API Key 已吊销');
  }

  return (
    <Section title="API Key 总览" description="全平台 API Key（平台发放，用于调 /api/relay/*）。仅支持吊销；团队共享 Key 由团队管理员在桌面端轮换。">
      <Table>
        <TableHeader><TableRow><TableHead>Key 前缀</TableHead><TableHead>名称</TableHead><TableHead>团队</TableHead><TableHead>scopes</TableHead><TableHead>最近使用</TableHead><TableHead>状态</TableHead><TableHead className="w-[80px]">操作</TableHead></TableRow></TableHeader>
        <TableBody>
          {paginated.length ? paginated.map((k) => (
            <TableRow key={k.id}>
              <TableCell className="font-mono text-xs">{k.keyPrefix}…</TableCell>
              <TableCell className="font-medium">{k.name}</TableCell>
              <TableCell className="text-muted-foreground">{k.teamName ?? k.teamId.slice(0, 8)}</TableCell>
              <TableCell><div className="flex flex-wrap gap-1">{k.scopes.map((s) => <Badge key={s} variant="secondary" className="font-mono text-xs">{s}</Badge>)}</div></TableCell>
              <TableCell className="text-xs text-muted-foreground">{k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleDateString('zh-CN') : '—'}</TableCell>
              <TableCell>{k.status === 'ACTIVE' ? <Badge variant="success">启用</Badge> : <Badge variant="secondary">已吊销</Badge>}</TableCell>
              <TableCell>{k.status === 'ACTIVE' ? <ActionBar><Button variant="destructive" size="sm" onClick={() => revoke(k)}><Trash2Icon className="mr-1 size-3.5" />吊销</Button></ActionBar> : '—'}</TableCell>
            </TableRow>
          )) : <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">暂无 API Key</TableCell></TableRow>}
        </TableBody>
      </Table>
      <Pagination totalItems={totalItems} pageSize={pageSize} currentPage={page} onPageChange={setPage} onPageSizeChange={setPageSize} />
    </Section>
  );
}
