// 渠道管理视图（仿 providers-view.tsx）。维护上游渠道、范围绑定、路由策略、健康测试。
// 见 docs/billing-and-relay-design.md §11.5.1 ①。
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { PlusIcon, PencilIcon, Trash2Icon, Link2Icon, ZapIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { useLoad, run } from '@/lib/helpers';
import { Section, StatusBadge, ActionBar, InfoGrid } from '@/components/shared';
import { usePagination, Pagination } from '@/components/ui/pagination';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import type { Channel, ChannelProtocol, ChannelStatus, ModelTier, ChannelBinding, ChannelScopeKind } from '@/lib/types';

const PROVIDER_OPTIONS = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'azure', label: 'Azure OpenAI' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'moonshot', label: 'Moonshot' },
  { value: 'qwen', label: 'Qwen' },
  { value: 'custom', label: '自定义' },
];

type FormState = {
  name: string; protocol: ChannelProtocol; provider: string; baseUrl: string;
  upstreamKey: string; modelsText: string; tiers: ModelTier[];
  status: ChannelStatus; priority: number; weight: number; description: string;
};

function emptyForm(): FormState {
  return { name: '', protocol: 'OPENAI', provider: 'openai', baseUrl: '', upstreamKey: '', modelsText: '', tiers: [], status: 'ENABLED', priority: 100, weight: 1, description: '' };
}
function formFromChannel(c: Channel): FormState {
  return { name: c.name, protocol: c.protocol, provider: c.provider, baseUrl: c.baseUrl, upstreamKey: '', modelsText: c.supportedModels.join('\n'), tiers: c.supportedTiers, status: c.status, priority: c.priority, weight: c.weight, description: c.description };
}
function parseModels(text: string): string[] {
  return Array.from(new Set(text.split(/[\s,，]+/).map((s) => s.trim()).filter(Boolean)));
}
function bindingsLabel(bindings: ChannelBinding[]): string {
  if (!bindings.length) return '—';
  const team = bindings.filter((b) => b.scopeKind === 'TEAM').length;
  const role = bindings.filter((b) => b.scopeKind === 'ROLE').length;
  const global = bindings.some((b) => b.scopeKind === 'GLOBAL');
  const parts: string[] = [];
  if (global) parts.push('全局');
  if (team) parts.push(`团队×${team}`);
  if (role) parts.push(`角色×${role}`);
  return parts.join('、') || '—';
}

export function ChannelsView() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const load = () => api<{ channels: Channel[] }>('/api/admin/billing/channels').then((r) => setChannels(r.channels ?? []));
  useLoad(load);
  const { paginated, page, setPage, pageSize, setPageSize, totalItems } = usePagination(channels);

  async function test(c: Channel) {
    await run(() => api(`/api/admin/billing/channels/${c.id}/test`, { method: 'POST' }).then(load), undefined);
  }
  async function remove(c: Channel) {
    if (!window.confirm(`确认删除渠道「${c.name}」？此操作不可恢复。`)) return;
    await run(() => api(`/api/admin/billing/channels/${c.id}`, { method: 'DELETE' }).then(load), '渠道已删除');
  }

  return (
    <Section title="渠道管理" description="维护上游渠道、范围绑定与故障转移策略。前台/中转按范围+模型路由到候选渠道。">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm text-muted-foreground">{totalItems} 个渠道</div>
        <CreateChannelDialog onRefresh={load}><Button><PlusIcon className="mr-1.5 size-4" />新增渠道</Button></CreateChannelDialog>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>名称</TableHead><TableHead>协议</TableHead><TableHead>上游基址</TableHead>
            <TableHead>适用范围</TableHead><TableHead>优先级</TableHead><TableHead>健康</TableHead><TableHead className="w-[260px]">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {paginated.length ? paginated.map((c) => (
            <TableRow key={c.id}>
              <TableCell className="font-medium">{c.name}</TableCell>
              <TableCell className="text-muted-foreground">{c.protocol}</TableCell>
              <TableCell className="max-w-xs truncate text-muted-foreground" title={c.baseUrl}>{c.baseUrl}</TableCell>
              <TableCell className="text-muted-foreground">{bindingsLabel(c.bindings)}</TableCell>
              <TableCell className="tabular-nums">{c.priority}</TableCell>
              <TableCell>{c.lastHealthOk == null ? <span className="text-muted-foreground">未测</span> : c.lastHealthOk ? <Badge variant="success">通</Badge> : <Badge variant="destructive">异常</Badge>}</TableCell>
              <TableCell>
                <ActionBar>
                  <EditChannelDialog channel={c} onRefresh={load}><Button variant="outline" size="sm"><PencilIcon className="mr-1 size-3.5" />编辑</Button></EditChannelDialog>
                  <BindingsDialog channel={c} onRefresh={load}><Button variant="outline" size="sm"><Link2Icon className="mr-1 size-3.5" />绑定</Button></BindingsDialog>
                  <Button variant="outline" size="sm" onClick={() => test(c)}><ZapIcon className="mr-1 size-3.5" />测试</Button>
                  <Button variant="destructive" size="sm" onClick={() => remove(c)}><Trash2Icon className="mr-1 size-3.5" />删除</Button>
                </ActionBar>
              </TableCell>
            </TableRow>
          )) : (
            <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">暂无渠道，新增并绑定范围后即可被路由。</TableCell></TableRow>
          )}
        </TableBody>
      </Table>
      <Pagination totalItems={totalItems} pageSize={pageSize} currentPage={page} onPageChange={setPage} onPageSizeChange={setPageSize} />
    </Section>
  );
}

function ChannelFormFields({ form, setForm }: { form: FormState; setForm: (n: FormState) => void }) {
  const patch = (n: Partial<FormState>) => setForm({ ...form, ...n });
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2"><Label>名称</Label><Input placeholder="OpenAI 官方" value={form.name} onChange={(e) => patch({ name: e.target.value })} /></div>
        <div className="space-y-2"><Label>协议</Label>
          <Select value={form.protocol} onValueChange={(v) => patch({ protocol: v as ChannelProtocol })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="OPENAI">OpenAI</SelectItem><SelectItem value="ANTHROPIC">Anthropic</SelectItem></SelectContent></Select>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2"><Label>提供方</Label>
          <Select value={form.provider} onValueChange={(v) => patch({ provider: v })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{PROVIDER_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent></Select>
        </div>
        <div className="space-y-2"><Label>上游基址</Label><Input placeholder="https://api.openai.com/v1" value={form.baseUrl} onChange={(e) => patch({ baseUrl: e.target.value })} /></div>
      </div>
      <div className="space-y-2"><Label>上游 API Key</Label><Input type="password" placeholder="sk-..." value={form.upstreamKey} onChange={(e) => patch({ upstreamKey: e.target.value })} /></div>
      <div className="space-y-2"><Label>支持模型（一行一个）</Label><Textarea placeholder={'gpt-4o\ngpt-4o-mini'} value={form.modelsText} onChange={(e) => patch({ modelsText: e.target.value })} /></div>
      <div className="space-y-2"><Label>支持版本</Label>
        <div className="flex gap-4">
          {(['FAST', 'PREMIUM'] as ModelTier[]).map((t) => (
            <label key={t} className="flex items-center gap-2 text-sm"><Checkbox checked={form.tiers.includes(t)} onCheckedChange={(v) => patch({ tiers: v ? [...form.tiers, t] : form.tiers.filter((x) => x !== t) })} />{t === 'FAST' ? '快速版' : '高级版'}</label>
          ))}
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2"><Label>优先级（小优先）</Label><Input type="number" min={0} value={form.priority} onChange={(e) => patch({ priority: Number(e.target.value) || 0 })} /></div>
        <div className="space-y-2"><Label>权重（同优先级）</Label><Input type="number" min={1} value={form.weight} onChange={(e) => patch({ weight: Number(e.target.value) || 1 })} /></div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2"><Label>状态</Label>
          <Select value={form.status} onValueChange={(v) => patch({ status: v as ChannelStatus })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="ENABLED">已启用</SelectItem><SelectItem value="DISABLED">已禁用</SelectItem></SelectContent></Select>
        </div>
        <div className="space-y-2"><Label>说明</Label><Input value={form.description} onChange={(e) => patch({ description: e.target.value })} /></div>
      </div>
    </div>
  );
}

function CreateChannelDialog({ children, onRefresh }: { children: React.ReactNode; onRefresh: () => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(emptyForm());
  async function create() {
    if (!form.name.trim()) return toast.error('输入名称');
    if (!form.baseUrl.trim()) return toast.error('输入上游基址');
    if (!form.upstreamKey.trim()) return toast.error('输入上游 API Key');
    const body = { name: form.name.trim(), protocol: form.protocol, provider: form.provider, baseUrl: form.baseUrl.trim(), upstreamKey: form.upstreamKey, supportedModels: parseModels(form.modelsText), supportedTiers: form.tiers, status: form.status, priority: form.priority, weight: form.weight, description: form.description };
    if (!(await run(() => api('/api/admin/billing/channels', { method: 'POST', body }).then(onRefresh), '渠道已创建'))) return;
    setOpen(false); setForm(emptyForm());
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-lg"><DialogHeader><DialogTitle>新增渠道</DialogTitle><DialogDescription>创建后需绑定范围（全局/团队/角色）才会被路由。</DialogDescription></DialogHeader><ChannelFormFields form={form} setForm={setForm} /><DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>取消</Button><Button onClick={create}>创建</Button></DialogFooter></DialogContent>
    </Dialog>
  );
}

function EditChannelDialog({ channel, children, onRefresh }: { channel: Channel; children: React.ReactNode; onRefresh: () => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(formFromChannel(channel));
  useEffect(() => { if (open) setForm(formFromChannel(channel)); }, [open, channel]);
  async function save() {
    if (!form.name.trim()) return toast.error('输入名称');
    if (!form.baseUrl.trim()) return toast.error('输入上游基址');
    const body: Record<string, unknown> = { name: form.name.trim(), protocol: form.protocol, provider: form.provider, baseUrl: form.baseUrl.trim(), supportedModels: parseModels(form.modelsText), supportedTiers: form.tiers, status: form.status, priority: form.priority, weight: form.weight, description: form.description };
    if (form.upstreamKey.trim()) body.upstreamKey = form.upstreamKey;
    if (!(await run(() => api(`/api/admin/billing/channels/${channel.id}`, { method: 'PATCH', body }).then(onRefresh), '渠道已更新'))) return;
    setOpen(false);
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-lg"><DialogHeader><DialogTitle>编辑渠道</DialogTitle><DialogDescription>{channel.name}</DialogDescription></DialogHeader>
        <InfoGrid items={[['Key', channel.upstreamKeyHint || '—'], ['健康', channel.lastHealthOk == null ? '未测' : channel.lastHealthOk ? '通' : '异常']]} />
        <ChannelFormFields form={form} setForm={setForm} />
        <DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>取消</Button><Button onClick={save}>保存</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BindingsDialog({ channel, children, onRefresh }: { channel: Channel; children: React.ReactNode; onRefresh: () => void }) {
  const [open, setOpen] = useState(false);
  const [scopeKind, setScopeKind] = useState<ChannelScopeKind>('GLOBAL');
  const [scopeId, setScopeId] = useState('');
  async function add() {
    const body = { scopeKind, scopeId: scopeKind === 'GLOBAL' ? '' : scopeId.trim() };
    if (scopeKind !== 'GLOBAL' && !body.scopeId) return toast.error('请填写 scopeId');
    if (!(await run(() => api(`/api/admin/billing/channels/${channel.id}/bindings`, { method: 'POST', body }).then(onRefresh), '已添加绑定'))) return;
    setScopeId('');
  }
  async function removeBinding(b: ChannelBinding) {
    await run(() => api(`/api/admin/billing/channels/${channel.id}/bindings/${b.id}`, { method: 'DELETE' }).then(onRefresh), '已删除绑定');
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-lg"><DialogHeader><DialogTitle>渠道范围绑定</DialogTitle><DialogDescription>{channel.name} —— 满足「单主体可配单/多渠道」</DialogDescription></DialogHeader>
        <div className="space-y-2 text-sm">
          {channel.bindings.length ? channel.bindings.map((b) => (
            <div key={b.id} className="flex items-center justify-between rounded border px-3 py-1.5"><span>{b.scopeKind === 'GLOBAL' ? '全局' : `${b.scopeKind}: ${b.scopeId}`}</span><Button variant="ghost" size="sm" onClick={() => removeBinding(b)}><Trash2Icon className="size-3.5" /></Button></div>
          )) : <div className="text-muted-foreground">尚无绑定（此渠道不会被路由）</div>}
        </div>
        <div className="grid gap-2 sm:grid-cols-[120px_1fr_auto]">
          <Select value={scopeKind} onValueChange={(v) => setScopeKind(v as ChannelScopeKind)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="GLOBAL">全局</SelectItem><SelectItem value="TEAM">团队</SelectItem><SelectItem value="ROLE">角色</SelectItem></SelectContent></Select>
          <Input placeholder={scopeKind === 'GLOBAL' ? '全局无需填' : 'teamId / roleId'} value={scopeId} disabled={scopeKind === 'GLOBAL'} onChange={(e) => setScopeId(e.target.value)} />
          <Button onClick={add}><PlusIcon className="mr-1 size-4" />添加</Button>
        </div>
        <DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>完成</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
