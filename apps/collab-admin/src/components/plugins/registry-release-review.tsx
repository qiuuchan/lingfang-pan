import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArchiveIcon, CheckCircleIcon, EyeIcon, Loader2Icon, RefreshCwIcon, SearchIcon, XCircleIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { Section } from '@/components/shared';
import { api } from '@/lib/api';

type PackageInfo = {
  id: string;
  ownerTeamId: string;
  manifestId: string;
  name: string;
  description: string;
  governanceStatus: 'ACTIVE' | 'ARCHIVED';
};

type ReleaseInfo = {
  id: string;
  packageId: string;
  version: string;
  manifest: Record<string, unknown>;
  sha256: string;
  sizeBytes: number;
  status: 'PUBLISHED' | 'YANKED';
  marketReviewStatus: 'DRAFT' | 'PENDING' | 'APPROVED' | 'REJECTED';
  targetPlatform: 'windows-x64';
  reviewReason?: string;
  createdAt: string;
};

type ReleaseRow = {
  package: PackageInfo;
  release: ReleaseInfo;
  listingStatus: 'DRAFT' | 'ACTIVE' | 'DELISTED' | null;
  priceCents: number | null;
};

type ReleaseDetail = {
  package: PackageInfo;
  release: ReleaseInfo;
  fileManifest: Array<{ path: string; sizeBytes: number }>;
  reviews: Array<{ id: string; status: string; reason: string; createdAt: string }>;
};

type ReviewFilter = 'ALL' | ReleaseInfo['marketReviewStatus'];

export function RegistryReleaseReview() {
  const [rows, setRows] = useState<ReleaseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ReviewFilter>('ALL');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ReleaseDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [action, setAction] = useState<'reject' | 'delist' | null>(null);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api<{ items: ReleaseRow[] }>('/api/admin/plugin-releases');
      setRows(response.items);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : '发行版加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (filter !== 'ALL' && row.release.marketReviewStatus !== filter) return false;
      return !keyword
        || row.package.name.toLowerCase().includes(keyword)
        || row.package.manifestId.toLowerCase().includes(keyword)
        || row.release.version.toLowerCase().includes(keyword);
    });
  }, [filter, query, rows]);

  const openDetail = async (releaseId: string) => {
    setActiveId(releaseId);
    setDetail(null);
    setDetailLoading(true);
    try { setDetail(await api<ReleaseDetail>(`/api/admin/plugin-releases/${releaseId}`)); }
    catch (caught) { toast.error(caught instanceof Error ? caught.message : '发行版详情加载失败'); }
    finally { setDetailLoading(false); }
  };

  const perform = async (kind: 'approve' | 'reject' | 'delist') => {
    if (!activeId) return;
    setSubmitting(true);
    try {
      await api(`/api/admin/plugin-releases/${activeId}/${kind}`, {
        method: 'POST',
        body: kind === 'approve' ? undefined : { reason },
      });
      toast.success(kind === 'approve' ? '发行版已通过审核并切换为市场最新版' : kind === 'reject' ? '发行版已驳回' : '插件包已下架');
      setAction(null);
      setReason('');
      setActiveId(null);
      setDetail(null);
      await load();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : '操作失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Section title="插件发行审核" description="审核绑定具体发行版；每个市场新版本都需要重新审核。">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-64 flex-1"><SearchIcon className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索包名、manifest ID 或版本" className="pl-9" /></div>
          <Select value={filter} onValueChange={(value) => setFilter(value as ReviewFilter)}><SelectTrigger className="w-40"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="ALL">全部状态</SelectItem><SelectItem value="PENDING">待审核</SelectItem><SelectItem value="APPROVED">已通过</SelectItem><SelectItem value="REJECTED">已驳回</SelectItem><SelectItem value="DRAFT">未提交</SelectItem></SelectContent></Select>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}><RefreshCwIcon className={loading ? 'animate-spin' : ''} />刷新</Button>
        </div>

        <Table>
          <TableHeader><TableRow><TableHead>插件包</TableHead><TableHead>版本</TableHead><TableHead>平台</TableHead><TableHead>大小</TableHead><TableHead>SHA-256</TableHead><TableHead>审核</TableHead><TableHead className="w-24">操作</TableHead></TableRow></TableHeader>
          <TableBody>
            {loading ? <TableRow><TableCell colSpan={7} className="h-28 text-center text-muted-foreground"><Loader2Icon className="mr-2 inline size-4 animate-spin" />正在加载</TableCell></TableRow> : filtered.length ? filtered.map((row) => (
              <TableRow key={row.release.id}>
                <TableCell><div className="font-medium">{row.package.name}</div><div className="text-xs text-muted-foreground">{row.package.manifestId}</div></TableCell>
                <TableCell>v{row.release.version}</TableCell><TableCell>Windows x64</TableCell><TableCell>{formatBytes(row.release.sizeBytes)}</TableCell>
                <TableCell className="font-mono text-xs">{row.release.sha256.slice(0, 16)}...</TableCell>
                <TableCell><ReviewBadge value={row.release.marketReviewStatus} />{row.listingStatus === 'ACTIVE' && <Badge variant="outline" className="ml-1">市场当前版</Badge>}</TableCell>
                <TableCell><Button variant="ghost" size="icon" className="size-8" title="查看发行版" onClick={() => void openDetail(row.release.id)}><EyeIcon /></Button></TableCell>
              </TableRow>
            )) : <TableRow><TableCell colSpan={7} className="h-28 text-center text-muted-foreground">没有符合条件的发行版</TableCell></TableRow>}
          </TableBody>
        </Table>
      </div>

      <Dialog open={Boolean(activeId)} onOpenChange={(open) => !open && setActiveId(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader><DialogTitle>{detail?.package.name || '发行版详情'}</DialogTitle><DialogDescription>{detail ? `${detail.package.manifestId} · v${detail.release.version}` : '正在读取发行版元数据'}</DialogDescription></DialogHeader>
          {detailLoading ? <div className="flex h-48 items-center justify-center text-muted-foreground"><Loader2Icon className="mr-2 animate-spin" />正在加载</div> : detail && <ReleaseDetailContent detail={detail} />}
          {detail && <DialogFooter>
            {detail.release.marketReviewStatus === 'PENDING' && <><Button variant="destructive" onClick={() => setAction('reject')}><XCircleIcon />驳回</Button><Button onClick={() => void perform('approve')} disabled={submitting}><CheckCircleIcon />通过</Button></>}
            {detail.release.marketReviewStatus === 'APPROVED' && <Button variant="destructive" onClick={() => setAction('delist')}><ArchiveIcon />下架</Button>}
          </DialogFooter>}
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(action)} onOpenChange={(open) => !open && setAction(null)}><DialogContent><DialogHeader><DialogTitle>{action === 'reject' ? '驳回发行版' : '下架插件包'}</DialogTitle><DialogDescription>{action === 'reject' ? '审核结果只影响当前发行版。' : '历史发行版和已购团队权益会继续保留。'}</DialogDescription></DialogHeader><Textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="填写原因" /><DialogFooter><Button variant="outline" onClick={() => setAction(null)}>取消</Button><Button variant="destructive" disabled={submitting} onClick={() => void perform(action!)}>{submitting && <Loader2Icon className="animate-spin" />}{action === 'reject' ? '确认驳回' : '确认下架'}</Button></DialogFooter></DialogContent></Dialog>
    </Section>
  );
}

function ReleaseDetailContent({ detail }: { detail: ReleaseDetail }) {
  const capabilities = Array.isArray(detail.release.manifest.capabilities) ? detail.release.manifest.capabilities : [];
  return <div className="grid max-h-[60vh] gap-4 overflow-y-auto">
    <div className="grid grid-cols-2 gap-x-6 gap-y-2 rounded-lg border px-3 py-2 text-sm"><div><span className="text-muted-foreground">制品大小：</span>{formatBytes(detail.release.sizeBytes)}</div><div><span className="text-muted-foreground">目标平台：</span>Windows x64</div><div className="col-span-2 break-all font-mono text-xs"><span className="font-sans text-muted-foreground">SHA-256：</span>{detail.release.sha256}</div></div>
    <div><h3 className="mb-2 text-sm font-medium">Manifest</h3><pre className="max-h-48 overflow-auto rounded-lg border bg-muted/30 p-3 text-xs">{JSON.stringify(detail.release.manifest, null, 2)}</pre></div>
    <div><h3 className="mb-2 text-sm font-medium">能力</h3><div className="flex flex-wrap gap-1.5">{capabilities.length ? capabilities.map((capability, index) => <Badge key={index} variant="outline">{typeof capability === 'string' ? capability : String((capability as { kind?: unknown }).kind || 'unknown')}</Badge>) : <span className="text-sm text-muted-foreground">未声明能力</span>}</div></div>
    <div><h3 className="mb-2 text-sm font-medium">文件清单</h3><div className="max-h-52 divide-y overflow-y-auto rounded-lg border">{detail.fileManifest.map((file) => <div key={file.path} className="flex items-center justify-between gap-3 px-3 py-1.5 text-xs"><span className="truncate font-mono">{file.path}</span><span className="shrink-0 text-muted-foreground">{formatBytes(file.sizeBytes)}</span></div>)}</div></div>
  </div>;
}

function ReviewBadge({ value }: { value: ReleaseInfo['marketReviewStatus'] }) {
  const labels = { DRAFT: '未提交', PENDING: '待审核', APPROVED: '已通过', REJECTED: '已驳回' };
  return <Badge variant={value === 'APPROVED' ? 'secondary' : value === 'REJECTED' ? 'destructive' : 'outline'}>{labels[value]}</Badge>;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
