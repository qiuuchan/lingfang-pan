// 资源池管理：SHARED 共享 / DEDICATED 单团队。渠道归属池；relay 按团队可用池路由。
import { useState } from 'react';
import { toast } from 'sonner';
import { PlusIcon, Trash2Icon, PencilIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { useLoad, run } from '@/lib/helpers';
import { Section, ActionBar } from '@/components/shared';
import { usePagination, Pagination } from '@/components/ui/pagination';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import type { Pool, PoolScope } from '@/lib/types';

export function PoolsView() {
  const [pools, setPools] = useState<Pool[]>([]);
  const load = () => api<{ pools: Pool[] }>('/api/admin/billing/pools').then((r) => setPools(r.pools ?? []));
  useLoad(load);
  const { paginated, page, setPage, pageSize, setPageSize, totalItems } = usePagination(pools);

  async function remove(p: Pool) {
    if (!window.confirm(`确认删除资源池「${p.name}」？池内渠道一并删除。`)) return;
    await run(() => api(`/api/admin/billing/pools/${p.id}`, { method: 'DELETE' }).then(load), '资源池已删除');
  }

  return (
    <Section title="资源池" description="渠道的访问范围容器。SHARED 池所有团队可用；DEDICATED 池仅指定团队可用。团队调用时在「可用池」的渠道中按 kind+tier 轮询。">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm text-muted-foreground">{totalItems} 个资源池</div>
        <PoolDialog onRefresh={load}><Button><PlusIcon className="mr-1.5 size-4" />新建资源池</Button></PoolDialog>
      </div>
      <Table>
        <TableHeader><TableRow><TableHead>名称</TableHead><TableHead>范围</TableHead><TableHead>团队</TableHead><TableHead>渠道数</TableHead><TableHead className="w-[160px]">操作</TableHead></TableRow></TableHeader>
        <TableBody>
          {paginated.length ? paginated.map((p) => (
            <TableRow key={p.id}>
              <TableCell className="font-medium">{p.name}</TableCell>
              <TableCell>{p.scope === 'SHARED' ? <Badge variant="success">共享</Badge> : <Badge variant="secondary">单团队</Badge>}</TableCell>
              <TableCell className="text-muted-foreground">{p.scope === 'DEDICATED' ? (p.teamId?.slice(0, 8) ?? '—') : '全部团队'}</TableCell>
              <TableCell className="tabular-nums">{p.channelCount}</TableCell>
              <TableCell>
                <ActionBar>
                  <PoolDialog pool={p} onRefresh={load}><Button variant="outline" size="sm"><PencilIcon className="mr-1 size-3.5" />编辑</Button></PoolDialog>
                  <Button variant="destructive" size="sm" onClick={() => remove(p)}><Trash2Icon className="mr-1 size-3.5" />删除</Button>
                </ActionBar>
              </TableCell>
            </TableRow>
          )) : <TableRow><TableCell colSpan={5} className="py-8 text-center text-muted-foreground">暂无资源池，新建一个后即可在其中创建渠道</TableCell></TableRow>}
        </TableBody>
      </Table>
      <Pagination totalItems={totalItems} pageSize={pageSize} currentPage={page} onPageChange={setPage} onPageSizeChange={setPageSize} />
    </Section>
  );
}

function PoolDialog({ pool, children, onRefresh }: { pool?: Pool; children: React.ReactNode; onRefresh: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(pool?.name ?? '');
  const [scope, setScope] = useState<PoolScope>(pool?.scope ?? 'SHARED');
  const [teamId, setTeamId] = useState(pool?.teamId ?? '');
  const [description, setDescription] = useState(pool?.description ?? '');

  async function submit() {
    if (!name.trim()) return toast.error('输入名称');
    const body = { name: name.trim(), scope, teamId: scope === 'DEDICATED' ? teamId.trim() : undefined, description: description.trim() };
    const ok = pool
      ? await run(() => api(`/api/admin/billing/pools/${pool.id}`, { method: 'PATCH', body: { name: body.name, description: body.description } }).then(onRefresh), '资源池已更新')
      : await run(() => api('/api/admin/billing/pools', { method: 'POST', body }).then(onRefresh), '资源池已创建');
    if (!ok) return;
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>{pool ? '编辑资源池' : '新建资源池'}</DialogTitle>
          <DialogDescription>{pool ? '范围与团队创建后不可改' : 'SHARED 池全团队共享；DEDICATED 池仅指定团队可用'}</DialogDescription></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2"><Label>名称</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：默认池 / A 企业专用池" /></div>
          <div className="space-y-2"><Label>范围</Label>
            <Select value={scope} onValueChange={(v) => setScope(v as PoolScope)} disabled={!!pool}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="SHARED">共享（全部团队）</SelectItem><SelectItem value="DEDICATED">单团队</SelectItem></SelectContent>
            </Select>
          </div>
          {scope === 'DEDICATED' && <div className="space-y-2"><Label>团队 ID</Label><Input value={teamId} onChange={(e) => setTeamId(e.target.value)} placeholder="绑定团队的 id" disabled={!!pool} /></div>}
          <div className="space-y-2"><Label>说明</Label><Input value={description} onChange={(e) => setDescription(e.target.value)} /></div>
        </div>
        <DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>取消</Button><Button onClick={submit}>{pool ? '保存' : '创建'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
