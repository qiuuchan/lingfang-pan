// 渠道管理（资源池模型重构后）：聊天渠道 / 生图渠道 两类分开（同表 kind 字段）。
// 每个渠道：kind + tier（快速/高级）+ 归属资源池 + 多个轮询模型。
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { PlusIcon, PencilIcon, Trash2Icon, ZapIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { useLoad, run } from '@/lib/helpers';
import { Section, StatusBadge, ActionBar } from '@/components/shared';
import { usePagination, Pagination } from '@/components/ui/pagination';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import type { Channel, ChannelKind, ChannelProtocol, ChannelStatus, ModelTier, Pool } from '@/lib/types';
import { TestChannelDialog } from './test-channel-dialog';

const PROVIDER_OPTIONS = [
  { value: 'openai', label: 'OpenAI' }, { value: 'anthropic', label: 'Anthropic' }, { value: 'azure', label: 'Azure OpenAI' },
  { value: 'deepseek', label: 'DeepSeek' }, { value: 'moonshot', label: 'Moonshot' }, { value: 'qwen', label: 'Qwen' }, { value: 'custom', label: '自定义' },
];

export function ChannelsView() {
  const [chat, setChat] = useState<Channel[]>([]);
  const [image, setImage] = useState<Channel[]>([]);
  const [pools, setPools] = useState<Pool[]>([]);
  const loadAll = async () => {
    const [c, i, p] = await Promise.all([
      api<{ channels: Channel[] }>('/api/admin/billing/channels?kind=CHAT').catch(() => ({ channels: [] })),
      api<{ channels: Channel[] }>('/api/admin/billing/channels?kind=IMAGE').catch(() => ({ channels: [] })),
      api<{ pools: Pool[] }>('/api/admin/billing/pools').catch(() => ({ pools: [] })),
    ]);
    setChat(c.channels ?? []); setImage(i.channels ?? []); setPools(p.pools ?? []);
  };
  useLoad(loadAll);

  return (
    <Section title="渠道管理" description="聊天渠道 / 生图渠道 分开管理。每个渠道归属一个资源池、标记版本（快速/高级）、可配多个模型轮询。">
      <Tabs defaultValue="CHAT">
        <TabsList><TabsTrigger value="CHAT">聊天渠道</TabsTrigger><TabsTrigger value="IMAGE">生图渠道</TabsTrigger></TabsList>
        <TabsContent value="CHAT" className="mt-4"><ChannelList kind="CHAT" list={chat} pools={pools} onRefresh={loadAll} /></TabsContent>
        <TabsContent value="IMAGE" className="mt-4"><ChannelList kind="IMAGE" list={image} pools={pools} onRefresh={loadAll} /></TabsContent>
      </Tabs>
    </Section>
  );
}

function ChannelList({ kind, list, pools, onRefresh }: { kind: ChannelKind; list: Channel[]; pools: Pool[]; onRefresh: () => void }) {
  const { paginated, page, setPage, pageSize, setPageSize, totalItems } = usePagination(list);
  const [testing, setTesting] = useState<Channel | null>(null);

  async function remove(ch: Channel) {
    if (!window.confirm(`确认删除渠道「${ch.name}」？`)) return;
    await run(() => api(`/api/admin/billing/channels/${ch.id}`, { method: 'DELETE' }).then(onRefresh), '渠道已删除');
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm text-muted-foreground">{totalItems} 个{kind === 'CHAT' ? '聊天' : '生图'}渠道</div>
        <ChannelDialog kind={kind} pools={pools} onRefresh={onRefresh}><Button><PlusIcon className="mr-1.5 size-4" />新增{kind === 'CHAT' ? '聊天' : '生图'}渠道</Button></ChannelDialog>
      </div>
      <Table>
        <TableHeader><TableRow><TableHead>名称</TableHead><TableHead>版本</TableHead><TableHead>所属池</TableHead><TableHead>模型数</TableHead><TableHead>健康</TableHead><TableHead className="w-[280px]">操作</TableHead></TableRow></TableHeader>
        <TableBody>
          {paginated.length ? paginated.map((ch) => (
            <TableRow key={ch.id}>
              <TableCell className="font-medium">{ch.name}<div className="font-mono text-xs text-muted-foreground">{ch.protocol} · {ch.provider}</div></TableCell>
              <TableCell><Badge variant="outline">{ch.tier === 'FAST' ? '快速' : '高级'}</Badge></TableCell>
              <TableCell className="text-muted-foreground">{ch.pool?.name ?? ch.poolId.slice(0, 8)}</TableCell>
              <TableCell className="tabular-nums">{ch.models.length}</TableCell>
              <TableCell>{ch.lastHealthOk == null ? <span className="text-muted-foreground">未测</span> : ch.lastHealthOk ? <Badge variant="success">通</Badge> : <Badge variant="destructive">异常</Badge>}</TableCell>
              <TableCell>
                <ActionBar>
                  <ChannelDialog channel={ch} kind={kind} pools={pools} onRefresh={onRefresh}><Button variant="outline" size="sm"><PencilIcon className="mr-1 size-3.5" />编辑</Button></ChannelDialog>
                  <Button variant="outline" size="sm" onClick={() => setTesting(ch)}><ZapIcon className="mr-1 size-3.5" />测试</Button>
                  <Button variant="destructive" size="sm" onClick={() => remove(ch)}><Trash2Icon className="mr-1 size-3.5" /></Button>
                </ActionBar>
              </TableCell>
            </TableRow>
          )) : <TableRow><TableCell colSpan={6} className="py-8 text-center text-muted-foreground">暂无{kind === 'CHAT' ? '聊天' : '生图'}渠道</TableCell></TableRow>}
        </TableBody>
      </Table>
      <Pagination totalItems={totalItems} pageSize={pageSize} currentPage={page} onPageChange={setPage} onPageSizeChange={setPageSize} />
      {testing && <TestChannelDialog channel={testing} onDone={onRefresh} onClose={() => setTesting(null)} />}
    </div>
  );
}

type FormState = {
  name: string; protocol: ChannelProtocol; provider: string; tier: ModelTier; poolId: string;
  baseUrl: string; upstreamKey: string; modelsText: string; status: ChannelStatus; description: string;
};

function emptyForm(kind: ChannelKind, pools: Pool[]): FormState {
  const proto: ChannelProtocol = kind === 'IMAGE' ? 'OPENAI' : 'OPENAI';
  return { name: '', protocol: proto, provider: 'openai', tier: 'FAST', poolId: pools[0]?.id ?? '', baseUrl: '', upstreamKey: '', modelsText: '', status: 'ENABLED', description: '' };
}

function formFromChannel(c: Channel): FormState {
  return { name: c.name, protocol: c.protocol, provider: c.provider, tier: c.tier, poolId: c.poolId, baseUrl: c.baseUrl, upstreamKey: '', modelsText: c.models.join('\n'), status: c.status, description: c.description };
}

function parseModels(text: string): string[] {
  return Array.from(new Set(text.split(/[\s,，]+/).map((s) => s.trim()).filter(Boolean)));
}

function ChannelDialog({ channel, kind, pools, children, onRefresh }: { channel?: Channel; kind: ChannelKind; pools: Pool[]; children: React.ReactNode; onRefresh: () => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(channel ? formFromChannel(channel) : emptyForm(kind, pools));
  useEffect(() => { if (open) setForm(channel ? formFromChannel(channel) : emptyForm(kind, pools)); }, [open, channel, kind, pools]);
  const patch = (n: Partial<FormState>) => setForm((f) => ({ ...f, ...n }));

  async function submit() {
    if (!form.name.trim()) return toast.error('输入名称');
    if (!form.poolId) return toast.error('请先创建资源池');
    if (!form.baseUrl.trim()) return toast.error('输入上游基址');
    const body: Record<string, unknown> = {
      name: form.name.trim(), kind, tier: form.tier, protocol: form.protocol, provider: form.provider,
      poolId: form.poolId, baseUrl: form.baseUrl.trim(), models: parseModels(form.modelsText), status: form.status, description: form.description,
    };
    if (form.upstreamKey.trim()) body.upstreamKey = form.upstreamKey;
    const ok = channel
      ? await run(() => api(`/api/admin/billing/channels/${channel.id}`, { method: 'PATCH', body }).then(onRefresh), '渠道已更新')
      : await run(() => api('/api/admin/billing/channels', { method: 'POST', body: { ...body, upstreamKey: form.upstreamKey } }).then(onRefresh), '渠道已创建');
    if (!ok) return;
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>{channel ? '编辑渠道' : `新增${kind === 'CHAT' ? '聊天' : '生图'}渠道`}</DialogTitle>
          <DialogDescription>{kind === 'CHAT' ? '聊天渠道服务 /chat/completions、/messages' : '生图渠道服务 /images/generations、/images/edits（仅 OpenAI 协议）'}</DialogDescription></DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2"><Label>名称</Label><Input value={form.name} onChange={(e) => patch({ name: e.target.value })} /></div>
            <div className="space-y-2"><Label>版本</Label>
              <Select value={form.tier} onValueChange={(v) => patch({ tier: v as ModelTier })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="FAST">快速</SelectItem><SelectItem value="PREMIUM">高级</SelectItem></SelectContent></Select>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2"><Label>所属资源池</Label>
              <Select value={form.poolId} onValueChange={(v) => patch({ poolId: v })}><SelectTrigger><SelectValue placeholder="选池" /></SelectTrigger><SelectContent>{pools.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}{p.scope === 'SHARED' ? '（共享）' : '（单团队）'}</SelectItem>)}</SelectContent></Select>
            </div>
            <div className="space-y-2"><Label>协议</Label>
              <Select value={form.protocol} onValueChange={(v) => patch({ protocol: v as ChannelProtocol })} disabled={kind === 'IMAGE'}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="OPENAI">OpenAI</SelectItem><SelectItem value="ANTHROPIC" disabled={kind === 'IMAGE'}>Anthropic</SelectItem></SelectContent></Select>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2"><Label>提供方</Label>
              <Select value={form.provider} onValueChange={(v) => patch({ provider: v })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{PROVIDER_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent></Select>
            </div>
            <div className="space-y-2"><Label>上游基址</Label><Input value={form.baseUrl} onChange={(e) => patch({ baseUrl: e.target.value })} placeholder="https://api.openai.com/v1" /></div>
          </div>
          <div className="space-y-2"><Label>上游 API Key</Label><Input type="password" value={form.upstreamKey} onChange={(e) => patch({ upstreamKey: e.target.value })} placeholder={channel ? '（不改则保留原 key）' : 'sk-...'} /></div>
          <div className="space-y-2"><Label>可调用模型（多个，一行一个，轮询）</Label><Textarea value={form.modelsText} onChange={(e) => patch({ modelsText: e.target.value })} placeholder={'gpt-4o\ngpt-4o-mini'} /></div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2"><Label>状态</Label>
              <Select value={form.status} onValueChange={(v) => patch({ status: v as ChannelStatus })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="ENABLED">已启用</SelectItem><SelectItem value="DISABLED">已禁用</SelectItem></SelectContent></Select>
            </div>
            <div className="space-y-2"><Label>说明</Label><Input value={form.description} onChange={(e) => patch({ description: e.target.value })} /></div>
          </div>
        </div>
        <DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>取消</Button><Button onClick={submit}>{channel ? '保存' : '创建'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
