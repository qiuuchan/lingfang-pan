import { useEffect, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { ShieldCheckIcon } from 'lucide-react';
import { api, type ApiError } from '@/lib/api';
import { fmtYuan } from '@/lib/money';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { LoadingButton } from '@/components/loading-button';

interface PendingPlugin {
  id: string;
  name: string;
  version: string;
  description?: string;
  price_cents: number;
  is_free: boolean;
  at: string;
}

export function Review() {
  const [list, setList] = useState<PendingPlugin[] | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { plugins } = await api<{ plugins: PendingPlugin[] }>('/admin/review/pending');
      setList(plugins);
    } catch (e) {
      toast.error((e as ApiError).message);
      setList([]);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function approve(id: string) {
    setBusy(id);
    try {
      await api('/admin/review/approve', { method: 'POST', body: { plugin_id: id } });
      toast.success('已通过审核 ✓');
      await load();
    } catch (e) { toast.error((e as ApiError).message); }
    finally { setBusy(null); }
  }

  async function reject(id: string) {
    const reason = (reasons[id] || '').trim();
    if (!reason) return toast.error('请填写驳回理由');
    setBusy(id);
    try {
      await api('/admin/review/reject', { method: 'POST', body: { plugin_id: id, reason } });
      toast.success('已驳回');
      await load();
    } catch (e) { toast.error((e as ApiError).message); }
    finally { setBusy(null); }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><ShieldCheckIcon className="size-5 text-primary" />插件审核</CardTitle>
      </CardHeader>
      <CardContent>
        {list === null ? (
          <p className="text-sm text-muted-foreground">加载中…</p>
        ) : list.length ? (
          <div className="flex flex-col gap-3">
            {list.map((p) => (
              <div key={p.id} className="rounded-lg border p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-medium">{p.name} <span className="text-sm font-normal text-muted-foreground">v{p.version}</span></div>
                    <div className="mt-0.5 text-sm text-muted-foreground">{p.description || '（无描述）'}</div>
                    <div className="mt-1 font-mono text-xs text-muted-foreground">{p.id}</div>
                  </div>
                  <Badge variant={p.is_free ? 'secondary' : 'default'}>{fmtYuan(p.price_cents)}</Badge>
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <Input
                    placeholder="驳回理由（驳回时必填）"
                    value={reasons[p.id] || ''}
                    onChange={(e) => setReasons((r) => ({ ...r, [p.id]: e.target.value }))}
                    className="flex-1"
                  />
                  <LoadingButton loading={busy === p.id} onClick={() => approve(p.id)}>通过</LoadingButton>
                  <LoadingButton variant="destructive" loading={busy === p.id} onClick={() => reject(p.id)}>驳回</LoadingButton>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">暂无待审核插件。</p>
        )}
      </CardContent>
    </Card>
  );
}
