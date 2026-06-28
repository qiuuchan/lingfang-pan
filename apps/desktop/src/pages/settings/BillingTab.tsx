// BillingTab —— 设置页「模型与计费」Tab（替代旧 ModelGatewayTab 的 BYOK）。
//
// 设计（见 docs/billing-and-relay-design.md §11.5.2 ①）：
//  - 我的 API Key 管理（GET/POST/DELETE /api/me/api-keys），明文仅创建时返回一次。
//  - 模型版本只读展示（GET /api/relay/v1/models）。
//  - 不再有「填 apiKey」输入框（需求 #4：不支持用户自定义接口）。
//  - 团队灵石余额改在「团队钱包」页查看，本 Tab 不再展示。
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { KeyRoundIcon, InfoIcon, PlusIcon, CopyIcon, Trash2Icon } from 'lucide-react';
import { api, type ApiError } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { modelTierLabel, normalizeModelTier } from '@/lib/model-tier';

interface ApiKeyRow {
  id: string; name: string; keyPrefix: string; scopes: string[];
  status: 'ACTIVE' | 'DISABLED'; lastUsedAt: string | null; expiresAt: string | null; createdAt: string;
}
interface ApiKeyCreated extends ApiKeyRow { plaintextKey: string; }
interface RelayModel { id: string; label?: string; resourcePools?: Array<{ id: string; name: string; scope: string; teamId: string | null }> }

const SCOPE_OPTIONS = [
  { value: 'chat', label: '对话' },
  { value: 'image', label: '生图' },
  { value: 'tier:fast', label: modelTierLabel('fast') },
  { value: 'tier:premium', label: modelTierLabel('premium') },
];

function fmtTime(iso?: string | null): string {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('zh-CN', { hour12: false }); } catch { return iso; }
}

export function BillingTab() {
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [models, setModels] = useState<RelayModel[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['chat', 'tier:fast']);
  const [created, setCreated] = useState<ApiKeyCreated | null>(null);

  const loadAll = async () => {
    try {
      const [k, m] = await Promise.all([
        api<{ apiKeys: ApiKeyRow[] }>('/api/me/api-keys').catch(() => ({ apiKeys: [] })),
        api<{ data: RelayModel[] }>('/api/relay/v1/models').catch(() => ({ data: [] })),
      ]);
      setKeys(k.apiKeys);
      setModels(m.data);
    } catch { /* 401 由全局处理 */ }
  };
  useEffect(() => { void loadAll(); }, []);

  return (
    <div className="flex flex-col gap-4">
      {/* 我的 API Key */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span className="flex items-center gap-2"><KeyRoundIcon className="size-5 text-primary" />我的 API Key</span>
            <Button size="sm" onClick={() => setCreateOpen(true)}><PlusIcon className="mr-1 size-4" />新建 API Key</Button>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-3 text-xs text-muted-foreground">调用平台 AI 服务用的密钥（外部脚本/插件接入）。明文仅创建时显示一次，请妥善保管。</p>
          <div className="space-y-2">
            {keys.length ? keys.map((k) => (
              <div key={k.id} className="flex items-center gap-3 rounded-lg border p-2.5">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm">{k.keyPrefix}…</span>
                    <span className="text-sm">{k.name}</span>
                    {k.status === 'DISABLED' && <Badge variant="secondary">已吊销</Badge>}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {k.scopes.map((s) => <Badge key={s} variant="outline" className="font-mono text-xs">{s}</Badge>)}
                  </div>
                  <div className="text-xs text-muted-foreground">创建 {fmtTime(k.createdAt)} · 最近使用 {fmtTime(k.lastUsedAt)}</div>
                </div>
                {k.status === 'ACTIVE' && (
                  <Button variant="ghost" size="icon" className="size-8 text-destructive" onClick={() => void revokeKey(k.id, () => loadAll())}>
                    <Trash2Icon className="size-4" />
                  </Button>
                )}
              </div>
            )) : <div className="py-4 text-center text-sm text-muted-foreground">还没有 API Key</div>}
          </div>
        </CardContent>
      </Card>

      {/* 模型版本（只读） */}
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><InfoIcon className="size-5 text-primary" />模型版本</CardTitle></CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {models.length ? models.map((m) => {
              const tier = normalizeModelTier(m.id);
              return (
                <Badge key={m.id} variant="secondary" className="text-sm">
                  {m.label ?? (tier ? modelTierLabel(tier) : m.id)}
                  {m.resourcePools?.length ? ` · ${m.resourcePools.map((pool) => pool.name).join('、')}` : ' · 暂无可用资源池'}
                </Badge>
              );
            }) : <span className="text-sm text-muted-foreground">连接平台后显示</span>}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">底层模型由平台统一配置与管理。</p>
        </CardContent>
      </Card>

      <CreateKeyDialog
        open={createOpen}
        onOpenChange={(o) => { setCreateOpen(o); if (!o) { setName(''); setScopes(['chat', 'tier:fast']); setCreated(null); } }}
        name={name}
        scopes={scopes}
        setName={setName}
        setScopes={setScopes}
        created={created}
        onSubmit={() => void submitCreate(name, scopes, (k) => { setCreated(k); setKeys([k, ...keys]); })}
      />
    </div>
  );
}

async function submitCreate(name: string, scopes: string[], onCreated: (k: ApiKeyCreated) => void) {
  try {
    const k = await api<ApiKeyCreated>('/api/me/api-keys', { method: 'POST', body: { name: name.trim() || '默认', scopes } });
    onCreated(k);
  } catch (e) { toast.error((e as ApiError).message); }
}

function CreateKeyDialog({
  open, onOpenChange, name, scopes, setName, setScopes, created, onSubmit,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  name: string;
  scopes: string[];
  setName: (n: string) => void;
  setScopes: (s: string[]) => void;
  created: ApiKeyCreated | null;
  onSubmit: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{created ? 'API Key 已创建' : '新建 API Key'}</DialogTitle>
          {created ? <DialogDescription>请立即复制并妥善保管，明文仅显示这一次。</DialogDescription> : <DialogDescription>归属当前团队，消费扣团队灵石。</DialogDescription>}
        </DialogHeader>
        {created ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Input readOnly value={created.plaintextKey} className="font-mono text-xs" />
              <Button size="icon" onClick={() => { void navigator.clipboard?.writeText(created.plaintextKey); toast.success('已复制'); }}><CopyIcon className="size-4" /></Button>
            </div>
            <DialogFooter><Button onClick={() => onOpenChange(false)}>我已保管</Button></DialogFooter>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-2"><Label>名称</Label><Input placeholder="如：测试 key" value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div className="space-y-2"><Label>能力范围</Label>
              <div className="flex flex-wrap gap-3">
                {SCOPE_OPTIONS.map((o) => (
                  <label key={o.value} className="flex items-center gap-2 text-sm">
                    <Checkbox checked={scopes.includes(o.value)} onCheckedChange={(v) => setScopes(v ? [...scopes, o.value] : scopes.filter((s) => s !== o.value))} />
                    {o.label}
                  </label>
                ))}
              </div>
            </div>
            <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button onClick={onSubmit}>创建</Button></DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

async function revokeKey(id: string, onDone: () => void) {
  if (!window.confirm('确认吊销此 API Key？吊销后立即失效，不可恢复。')) return;
  try {
    await api(`/api/me/api-keys/${id}`, { method: 'DELETE' });
    toast.success('API Key 已吊销');
    onDone();
  } catch (e) { toast.error((e as ApiError).message); }
}
