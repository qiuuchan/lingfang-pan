import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useApp } from '@/App';
import { api, type ApiError } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { LoadingButton } from '@/components/loading-button';

interface Tenant {
  id: string;
  name: string;
  slug: string;
  role: string;
}

export function TenantSelect() {
  const { applySession } = useApp();
  const [tenants, setTenants] = useState<Tenant[] | null>(null);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [creating, setCreating] = useState(false);
  const [enteringId, setEnteringId] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const { tenants } = await api<{ tenants: Tenant[] }>('/tenants/me');
        setTenants(tenants);
      } catch (e) {
        toast.error((e as ApiError).message);
        setTenants([]);
      }
    })();
  }, []);

  async function enter(id: string) {
    setEnteringId(id);
    try {
      const r = await api<{ token: string; tenant_id: string; tenant_name?: string; role: string; is_platform_admin?: boolean }>('/auth/switch-tenant', {
        method: 'POST', body: { tenant_id: id },
      });
      applySession({ token: r.token, tenantId: r.tenant_id, tenantName: r.tenant_name ?? null, role: r.role, isPlatformAdmin: !!r.is_platform_admin });
    } catch (e) {
      toast.error((e as ApiError).message);
      setEnteringId(null);
    }
  }

  async function create() {
    if (!name.trim()) return toast.error('请填写团队名');
    if (!/^[a-z0-9-]{2,}$/.test(slug.trim())) return toast.error('标识 slug 至少 2 位，仅限小写字母、数字、连字符');
    setCreating(true);
    try {
      const r = await api<{ token: string; tenant: { id: string; name: string }; tenant_name?: string; role: string }>('/tenants', {
        method: 'POST', body: { name: name.trim(), slug: slug.trim() },
      });
      applySession({ token: r.token, tenantId: r.tenant.id, tenantName: r.tenant_name ?? r.tenant.name, role: r.role });
      toast.success('团队已创建');
    } catch (e) {
      const err = e as ApiError;
      toast.error(/slug|重复/.test(err.message) ? '该标识 slug 已被占用，请换一个' : err.message);
      setCreating(false);
    }
  }

  return (
    <Card className="mx-auto w-full max-w-lg">
      <CardHeader>
        <CardTitle>选择或创建团队（租户）</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {tenants === null ? (
          <p className="text-sm text-muted-foreground">加载中…</p>
        ) : tenants.length ? (
          tenants.map((t) => (
            <div key={t.id} className="flex items-center justify-between rounded-md border px-3 py-2">
              <span className="text-sm font-medium">{t.name}</span>
              <LoadingButton size="sm" variant="outline" loading={enteringId === t.id} onClick={() => enter(t.id)}>
                进入
              </LoadingButton>
            </div>
          ))
        ) : (
          <p className="text-sm text-muted-foreground">还没有团队，先创建一个。</p>
        )}
        <Separator className="my-1" />
        <Input placeholder="团队名" value={name} onChange={(e) => setName(e.target.value)} />
        <Input placeholder="标识 slug（唯一，小写字母/数字/连字符）" value={slug} onChange={(e) => setSlug(e.target.value)} />
        <LoadingButton loading={creating} onClick={create}>创建团队</LoadingButton>
      </CardContent>
    </Card>
  );
}
