import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2Icon, AlertTriangleIcon, UsersIcon } from 'lucide-react';
import { useApp } from '@/App';
import { api, type ApiError } from '@/lib/api';
import type { GatewayConfig } from '@/lib/types';
import { loadModelCatalog, modelLabel } from '@/lib/models';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { LoadingButton } from '@/components/loading-button';

interface Binding {
  name: string;
  base_url: string;
  api_key_masked: string;
  models: string[];
}

export function Settings() {
  const [config, setConfig] = useState<GatewayConfig | null>(null);
  const [configError, setConfigError] = useState(false);
  const [binding, setBinding] = useState<Binding | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState('');
  const [catalogReady, setCatalogReady] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  async function refreshBinding() {
    try {
      const { bindings } = await api<{ bindings: Binding[] }>('/llm-bindings');
      const b = bindings[0] ?? null;
      setBinding(b);
      // 已配置：带出已保存的模型，便于直接测试/切换，无需重新获取。
      if (b && b.models?.length) {
        setModels(b.models);
        setModel((cur) => cur || b.models[0]);
      }
    } catch {
      /* 忽略 */
    }
  }

  useEffect(() => {
    loadModelCatalog().then(() => setCatalogReady(true));
    (async () => {
      try {
        const res = await fetch('gateway.config.json', { cache: 'no-store' });
        const cfg = (await res.json()) as GatewayConfig;
        setConfig(cfg);
        setConfigError(!cfg.base_url || cfg.base_url.includes('example.com'));
        if (Array.isArray(cfg.models) && cfg.models.length) {
          setModels(cfg.models);
          setModel((cur) => cur || cfg.models![0]);
        }
      } catch {
        setConfigError(true);
      }
      await refreshBinding();
    })();
  }, []);

  const baseUrl = config?.base_url || '';
  // 未填 key 时回退用已保存绑定（后端 resolve_creds 支持）。
  const creds = () => (apiKey.trim() ? { base_url: baseUrl, api_key: apiKey.trim() } : {});
  const canUseSaved = !!binding;

  async function fetchModels() {
    if (!baseUrl && !canUseSaved) return toast.error('网关地址未配置');
    if (!apiKey.trim() && !canUseSaved) return toast.error('请先填入 API Key');
    setFetching(true);
    try {
      const { models: list } = await api<{ models: string[] }>('/llm/models', { method: 'POST', body: creds() });
      if (!list.length) return toast.error('网关未返回任何模型');
      setModels(list);
      setModel(list[0]);
      toast.success(`连接成功，已获取 ${list.length} 个模型`);
    } catch (e) {
      const err = e as ApiError;
      toast.error(err.code === 'forbidden' ? '仅团队 owner/admin 可配置网关' : `连接失败：${err.message}`);
    } finally {
      setFetching(false);
    }
  }

  async function testModel() {
    if (!model) return toast.error('请先选择模型');
    if (!apiKey.trim() && !canUseSaved) return toast.error('请先填入 API Key');
    setTesting(true);
    try {
      await api('/llm/test', { method: 'POST', body: { ...creds(), model } });
      toast.success(`模型 ${modelLabel(model).label} 测试通过 ✓`);
    } catch (e) {
      toast.error(`测试失败：${(e as ApiError).message}`);
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    if (!baseUrl) return toast.error('网关地址未配置');
    // 已配置过：允许留空 key（仅切换模型/改名），后端复用已保存密文；首次保存才强制填 key。
    if (!apiKey.trim() && !binding) return toast.error('请填入 API Key');
    if (!model || !models.length) return toast.error('请先获取并选择模型');
    const ordered = [model, ...models.filter((m) => m !== model)];
    setSaving(true);
    try {
      await api('/llm-bindings', {
        method: 'POST',
        body: { name: config?.name || '默认网关', base_url: baseUrl, api_key: apiKey.trim(), models: ordered },
      });
      toast.success(apiKey.trim() ? '网关已保存（key 已加密落库）' : '已更新默认模型（沿用已保存的 Key）');
      setApiKey('');
      await refreshBinding();
    } catch (e) {
      const err = e as ApiError;
      toast.error(err.code === 'forbidden' ? '仅团队 owner/admin 可配置网关' : err.message);
    } finally {
      setSaving(false);
    }
  }

  const hasModels = models.length > 0;
  void catalogReady; // 触发 catalog 加载后重渲，刷新下拉显示名

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
    <Card className="w-full">
      <CardHeader>
        <CardTitle>LLM 网关</CardTitle>
        <CardDescription>
          网关地址已随应用预置，你只需填入自己的 API Key。生成插件与插件运行时调 LLM 都经它，key 仅服务端持有、不回显。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {configError ? (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
            <span>网关地址未配置。分发者需编辑 <code className="font-mono">apps/desktop/public/gateway.config.json</code> 填入真实 base_url。</span>
          </div>
        ) : (
          <div className="text-sm">
            网关：<span className="font-medium">{config?.name || '默认网关'}</span>{' '}
            <span className="text-muted-foreground">{baseUrl}</span>
          </div>
        )}

        <div className="text-sm">
          {binding ? (
            <span className="inline-flex items-center gap-2">
              <Badge variant="secondary" className="gap-1 text-green-700"><CheckCircle2Icon className="size-3.5" />已配置</Badge>
              默认模型 <span className="font-medium">{modelLabel(binding.models?.[0] || '').label || '—'}</span>
              <span className="text-muted-foreground">· key {binding.api_key_masked}</span>
            </span>
          ) : (
            <span className="text-muted-foreground">尚未配置。填入 Key → 获取模型 → 选择 → 保存。</span>
          )}
        </div>

        <Separator />

        <div className="flex flex-col gap-2">
          <Label htmlFor="apiKey">API Key{binding && <span className="ml-2 text-xs font-normal text-muted-foreground">（已保存，测试/获取可留空复用）</span>}</Label>
          <Input id="apiKey" type="password" placeholder={binding ? '留空则使用已保存的 Key' : '在此填入你的 API Key'} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
        </div>

        <div className="flex items-center gap-2">
          <LoadingButton variant="outline" loading={fetching} onClick={fetchModels}>获取模型</LoadingButton>
          <Select value={model} onValueChange={(v) => setModel(v ?? '')} disabled={!hasModels}>
            <SelectTrigger className="flex-1">
              <SelectValue placeholder="请先「获取模型」">
                {model ? modelLabel(model).label : null}
              </SelectValue>
            </SelectTrigger>
            <SelectContent className="max-h-80">
              {models.map((m) => {
                const { label, meta } = modelLabel(m);
                return (
                  <SelectItem key={m} value={m}>
                    <span className="flex flex-col items-start gap-0.5">
                      <span className="font-medium">{label}</span>
                      {meta.length > 0 && <span className="text-xs text-muted-foreground">{meta.join(' · ')}</span>}
                    </span>
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-2">
          <LoadingButton variant="outline" loading={testing} disabled={!hasModels} onClick={testModel}>测试所选模型</LoadingButton>
          <LoadingButton loading={saving} disabled={!hasModels} onClick={save}>保存</LoadingButton>
        </div>
        {binding && (
          <p className="text-xs text-muted-foreground">已配置网关：切换上方默认模型后点「保存」即可生效，无需重填 API Key。</p>
        )}
      </CardContent>
    </Card>
    <MembersCard />
    </div>
  );
}

interface Member {
  user_id: string;
  email: string;
  display_name: string;
  role: string;
}

const ROLE_LABEL: Record<string, string> = { owner: '团队所有者', admin: '管理员', member: '成员' };
// 可分配的角色（owner 归属唯一，通过转让而非邀请变更，这里不提供选 owner）。
const ASSIGNABLE_ROLES = [
  { v: 'member', label: '成员' },
  { v: 'admin', label: '管理员' },
];

// 团队成员管理：owner/admin 可邀请已注册用户、调整成员角色；普通成员只读查看名单。
function MembersCard() {
  const { session } = useApp();
  const canManage = session.role === 'owner' || session.role === 'admin';
  const [members, setMembers] = useState<Member[] | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  const [inviting, setInviting] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);

  async function refresh() {
    try {
      const { members } = await api<{ members: Member[] }>('/members');
      setMembers(members);
    } catch (e) {
      toast.error((e as ApiError).message);
      setMembers([]);
    }
  }

  useEffect(() => { refresh(); }, []);

  async function invite() {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return toast.error('请输入有效的成员邮箱');
    setInviting(true);
    try {
      await api('/members', { method: 'POST', body: { email: email.trim(), role } });
      toast.success('已添加/更新成员');
      setEmail('');
      await refresh();
    } catch (e) {
      const err = e as ApiError;
      toast.error(err.code === 'forbidden' ? '仅团队 owner/admin 可管理成员' : /尚未注册/.test(err.message) ? '该邮箱尚未注册，请对方先注册账号' : err.message);
    } finally {
      setInviting(false);
    }
  }

  // 调整成员角色：复用邀请接口（按 email upsert 角色）。owner 行不可改。
  async function changeRole(m: Member, next: string) {
    if (next === m.role) return;
    setSavingId(m.user_id);
    try {
      await api('/members', { method: 'POST', body: { email: m.email, role: next } });
      toast.success(`已将 ${m.display_name} 设为${ROLE_LABEL[next] || next}`);
      await refresh();
    } catch (e) {
      toast.error((e as ApiError).message);
    } finally {
      setSavingId(null);
    }
  }

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><UsersIcon className="size-5 text-primary" />团队成员</CardTitle>
        <CardDescription>
          {canManage ? '邀请已注册用户加入本团队并分配角色；管理员可配置网关、管理成员。' : '查看团队成员与角色。仅团队所有者 / 管理员可邀请与调整。'}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {canManage && (
          <div className="flex items-center gap-2">
            <Input placeholder="成员邮箱（须已注册）" value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && invite()} />
            <Select value={role} onValueChange={(v) => setRole(v ?? 'member')}>
              <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
              <SelectContent>{ASSIGNABLE_ROLES.map((r) => <SelectItem key={r.v} value={r.v}>{r.label}</SelectItem>)}</SelectContent>
            </Select>
            <LoadingButton loading={inviting} onClick={invite}>邀请</LoadingButton>
          </div>
        )}

        {members === null ? (
          <p className="text-sm text-muted-foreground">加载中…</p>
        ) : members.length ? (
          <div className="flex flex-col divide-y rounded-lg border">
            {members.map((m) => {
              const isOwner = m.role === 'owner';
              const isSelf = m.user_id === session.userId;
              return (
                <div key={m.user_id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{m.display_name}</span>
                      {isSelf && <Badge variant="secondary" className="shrink-0">我</Badge>}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">{m.email}</div>
                  </div>
                  {canManage && !isOwner ? (
                    <Select value={m.role} onValueChange={(v) => changeRole(m, v ?? m.role)} disabled={savingId === m.user_id}>
                      <SelectTrigger className="w-28 shrink-0"><SelectValue /></SelectTrigger>
                      <SelectContent>{ASSIGNABLE_ROLES.map((r) => <SelectItem key={r.v} value={r.v}>{r.label}</SelectItem>)}</SelectContent>
                    </Select>
                  ) : (
                    <Badge variant={isOwner ? 'default' : 'secondary'} className="shrink-0">{ROLE_LABEL[m.role] || m.role}</Badge>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">暂无成员。</p>
        )}
      </CardContent>
    </Card>
  );
}
