import { useEffect, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { ShieldCheckIcon, ClipboardCheckIcon } from 'lucide-react';
import { api, errorMessage } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { LoadingButton } from '@/components/loading-button';
import { StaggerContainer, StaggerItem, Shimmer } from '@/lib/motion';

interface PendingRelease {
  package: {
    id: string;
    manifestId: string;
    name: string;
    description: string;
  };
  release: {
    id: string;
    version: string;
    sha256: string;
    sizeBytes: number;
    targetPlatform: 'windows-x64';
  };
  fileManifest: Array<{ path: string; sizeBytes: number }>;
}

export function Review() {
  const [list, setList] = useState<PendingRelease[] | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { items } = await api<{ items: PendingRelease[] }>('/api/admin/plugin-releases/review-pending');
      setList(items);
    } catch (e) {
      toast.error(errorMessage(e, '待审核发行版加载失败'));
      setList([]);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function approve(id: string) {
    setBusy(id);
    try {
      await api(`/api/admin/plugin-releases/${id}/approve`, { method: 'POST' });
      toast.success('已通过审核');
      await load();
    } catch (e) { toast.error(errorMessage(e, '审核操作失败')); }
    finally { setBusy(null); }
  }

  async function reject(id: string) {
    const reason = (reasons[id] || '').trim();
    if (!reason) return toast.error('填写未通过原因');
    setBusy(id);
    try {
      await api(`/api/admin/plugin-releases/${id}/reject`, { method: 'POST', body: { reason } });
      toast.success('已驳回');
      await load();
    } catch (e) { toast.error(errorMessage(e, '审核操作失败')); }
    finally { setBusy(null); }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><ShieldCheckIcon className="size-5 text-primary" />插件审核</CardTitle>
      </CardHeader>
      <CardContent>
        {list === null ? (
          // 加载骨架：3 行占位（待审核通常不多），替代「加载中…」。
          <div className="flex flex-col gap-3">
            {Array.from({ length: 3 }).map((_, i) => <Shimmer key={i} className="h-24 w-full" />)}
          </div>
        ) : list.length ? (
          <StaggerContainer className="flex flex-col gap-3" stagger={0.06}>
            {list.map((item) => (
              <StaggerItem key={item.release.id} whileHover={{ y: -2, transition: { type: 'spring', stiffness: 300, damping: 18 } }}>
                <div className="rounded-lg border p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-medium">{item.package.name} <span className="text-sm font-normal text-muted-foreground">v{item.release.version}</span></div>
                      <div className="mt-0.5 text-sm text-muted-foreground">{item.package.description || '作者未填写描述'}</div>
                      <div className="mt-1 font-mono text-xs text-muted-foreground">{item.package.manifestId} · {item.release.sha256.slice(0, 16)}...</div>
                    </div>
                    <Badge variant="secondary">{formatBytes(item.release.sizeBytes)} · {item.fileManifest.length} 个文件</Badge>
                  </div>
                  <div className="mt-3 flex items-center gap-2">
                    <Input
                      placeholder="未通过原因（驳回时必填）"
                      value={reasons[item.release.id] || ''}
                      onChange={(e) => setReasons((r) => ({ ...r, [item.release.id]: e.target.value }))}
                      className="flex-1"
                    />
                    <LoadingButton loading={busy === item.release.id} onClick={() => approve(item.release.id)}>通过</LoadingButton>
                    <LoadingButton variant="destructive" loading={busy === item.release.id} onClick={() => reject(item.release.id)}>驳回</LoadingButton>
                  </div>
                </div>
              </StaggerItem>
            ))}
          </StaggerContainer>
        ) : (
          <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
            <ClipboardCheckIcon className="size-8 text-muted-foreground/50" />
            <span>暂无待审核插件</span>
            <span className="text-xs">团队提交到市场的插件审核请求会出现在这里。</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
