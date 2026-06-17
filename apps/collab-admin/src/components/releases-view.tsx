// releases-view.tsx — 平台 Admin 版本发布管理页。
//
// 职责：
// - 版本列表（含 DRAFT/PUBLISHED/ARCHIVED 全部状态，channel 筛选）。
// - 创建版本（DRAFT）→ 上传安装包（.exe + 可选 .sig，生成 /downloads/ 下载链接）→ 发布。
// - 登记外链产物（第三方托管场景，手填 url + signature）。
// - 归档 / 编辑 title·notes / 删除 asset。
//
// 后端契约（apps/collab-api/src/modules/admin.controller.ts + release.service.ts）：
// - GET /api/admin/releases（listAdmin，含全部状态）
// - POST /api/admin/releases（create DRAFT）
// - PATCH /api/admin/releases/:id（改 title/notes）
// - POST /api/admin/releases/:id/publish | /archive
// - POST /api/admin/releases/:id/assets（外链登记）
// - POST /api/admin/releases/:id/assets/upload（multipart：file + 可选 signature + platform + arch）
// - DELETE /api/admin/releases/:id/assets/:assetId
//
// UI 模式参考 plugins-view：Section + Table + Dialog + DetailSheet + Pagination。
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  RocketIcon,
  PlusIcon,
  UploadIcon,
  LinkIcon,
  PencilIcon,
  ArchiveIcon,
  SendIcon,
  Trash2Icon,
  CopyIcon,
  DownloadIcon,
} from 'lucide-react';
import { api } from '@/lib/api';
import { useLoad, run } from '@/lib/helpers';
import {
  listAdminReleases,
  createRelease,
  updateRelease,
  publishRelease,
  archiveRelease,
  addAsset,
  uploadAsset,
  deleteAsset,
  absoluteDownloadUrl,
  openDownload,
  type AdminRelease,
  type ReleaseCreateInput,
  type AssetCreateInput,
} from '@/lib/releases';
import { Section, Panel } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { usePagination, Pagination } from '@/components/ui/pagination';
import type { AssetPlatform, AssetArch, ReleaseChannel } from '@/lib/types';
import { formatTime } from '@/lib/types';

const CHANNEL_FILTERS: { value: 'ALL' | ReleaseChannel; label: string }[] = [
  { value: 'ALL', label: '全部通道' },
  { value: 'STABLE', label: '正式版' },
  { value: 'BETA', label: '测试版' },
];

const PLATFORM_OPTIONS: AssetPlatform[] = ['WINDOWS', 'DARWIN', 'LINUX'];
const ARCH_OPTIONS: AssetArch[] = ['X86_64', 'AARCH64', 'UNIVERSAL'];

const PLATFORM_LABEL: Record<AssetPlatform, string> = { WINDOWS: 'Windows', DARWIN: 'macOS', LINUX: 'Linux' };
const ARCH_LABEL: Record<AssetArch, string> = { X86_64: 'x64', AARCH64: 'ARM64', UNIVERSAL: '通用' };

/** 版本状态 Badge 变体映射（StatusBadge 无此三态，自定义）。 */
function statusBadge(status: AdminRelease['status']) {
  if (status === 'PUBLISHED') return <Badge variant="default">已发布</Badge>;
  if (status === 'DRAFT') return <Badge variant="secondary">草稿</Badge>;
  return <Badge variant="outline">已归档</Badge>;
}

export function ReleasesView() {
  const [releases, setReleases] = useState<AdminRelease[]>([]);
  const [channelFilter, setChannelFilter] = useState<'ALL' | ReleaseChannel>('ALL');

  const load = () =>
    listAdminReleases(channelFilter === 'ALL' ? undefined : channelFilter)
      .then(setReleases)
      .catch((e: Error) => toast.error(e.message));
  useLoad(load);
  // channelFilter 变化时重新加载。
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [channelFilter]);

  const { paginated, page, setPage, pageSize, setPageSize, totalItems } = usePagination(releases);

  // 详情 Sheet 当前版本。
  const [active, setActive] = useState<AdminRelease | null>(null);
  // 列表刷新后同步 active 指向最新对象（详情面板不显示陈旧状态）。
  useEffect(() => {
    if (!active) return;
    const latest = releases.find((r) => r.id === active.id);
    if (latest && latest !== active) setActive(latest);
  }, [releases, active]);

  // 创建版本 Dialog。
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState<ReleaseCreateInput>({ version: '', channel: 'STABLE', title: '', notes: '' });

  // 编辑 Dialog。
  const [editTarget, setEditTarget] = useState<AdminRelease | null>(null);
  const [editForm, setEditForm] = useState({ title: '', notes: '' });

  // 发布/归档/删除 asset 二次确认。
  const [confirmPublish, setConfirmPublish] = useState<AdminRelease | null>(null);
  const [confirmArchive, setConfirmArchive] = useState<AdminRelease | null>(null);
  const [confirmDeleteAsset, setConfirmDeleteAsset] = useState<{ release: AdminRelease; assetId: string } | null>(null);

  async function handleCreate() {
    if (!createForm.version.trim()) {
      toast.error('请填写版本号');
      return;
    }
    const ok = await run(
      () => createRelease(createForm).then(load),
      '版本已创建（草稿）',
    );
    if (ok) {
      setCreateOpen(false);
      setCreateForm({ version: '', channel: 'STABLE', title: '', notes: '' });
    }
  }

  function openEdit(r: AdminRelease) {
    setEditTarget(r);
    setEditForm({ title: r.title ?? '', notes: r.notes ?? '' });
  }
  async function handleEdit() {
    if (!editTarget) return;
    const ok = await run(
      () => updateRelease(editTarget.id, editForm).then(load),
      '已保存',
    );
    if (ok) setEditTarget(null);
  }

  async function handlePublish() {
    if (!confirmPublish) return;
    const ok = await run(
      () => publishRelease(confirmPublish.id).then(load),
      '版本已发布',
    );
    if (ok) setConfirmPublish(null);
  }
  async function handleArchive() {
    if (!confirmArchive) return;
    const ok = await run(
      () => archiveRelease(confirmArchive.id).then(load),
      '版本已归档',
    );
    if (ok) setConfirmArchive(null);
  }
  async function handleDeleteAsset() {
    if (!confirmDeleteAsset) return;
    const ok = await run(
      () => deleteAsset(confirmDeleteAsset.release.id, confirmDeleteAsset.assetId).then(load),
      '产物已删除',
    );
    if (ok) setConfirmDeleteAsset(null);
  }

  return (
    <Section title="版本发布" description="管理应用版本：创建草稿、上传安装包（生成下载链接）、发布到官网与桌面端更新检查。">
      <div className="space-y-4">
        {/* 工具栏：channel 筛选 + 创建按钮 */}
        <div className="flex items-center justify-between gap-3">
          <Select value={channelFilter} onValueChange={(v) => setChannelFilter(v as 'ALL' | ReleaseChannel)}>
            <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {CHANNEL_FILTERS.map((f) => (
                <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={() => setCreateOpen(true)}>
            <PlusIcon className="mr-1 size-4" />
            创建版本
          </Button>
        </div>

        {/* 版本列表 */}
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>版本</TableHead>
                <TableHead>通道</TableHead>
                <TableHead>标题</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>产物</TableHead>
                <TableHead>发布时间</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {paginated.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-sm text-muted-foreground">
                    暂无版本，点「创建版本」发布第一个。
                  </TableCell>
                </TableRow>
              ) : (
                paginated.map((r) => (
                  <TableRow key={r.id} className="cursor-pointer" onClick={() => setActive(r)}>
                    <TableCell className="font-mono">
                      v{r.version}
                      {r.isLatest && <Badge variant="default" className="ml-2">最新</Badge>}
                    </TableCell>
                    <TableCell>{r.channel === 'STABLE' ? '正式版' : '测试版'}</TableCell>
                    <TableCell className="max-w-[200px] truncate">{r.title || '—'}</TableCell>
                    <TableCell>{statusBadge(r.status)}</TableCell>
                    <TableCell>{r.assets.length}</TableCell>
                    <TableCell className="text-muted-foreground">{r.publishedAt ? formatTime(r.publishedAt) : '—'}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                        <Button variant="ghost" size="sm" onClick={() => openEdit(r)} title="编辑标题/说明">
                          <PencilIcon className="size-3.5" />
                        </Button>
                        {r.status === 'DRAFT' && (
                          <Button variant="ghost" size="sm" onClick={() => setConfirmPublish(r)} title="发布">
                            <SendIcon className="size-3.5" />
                          </Button>
                        )}
                        {r.status === 'ARCHIVED' && (
                          <Button variant="ghost" size="sm" onClick={() => setConfirmPublish(r)} title="重新发布（取消归档）">
                            <SendIcon className="size-3.5" />
                          </Button>
                        )}
                        {r.status === 'PUBLISHED' && (
                          <Button variant="ghost" size="sm" onClick={() => setConfirmArchive(r)} title="归档">
                            <ArchiveIcon className="size-3.5" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        <Pagination
          currentPage={page}
          pageSize={pageSize}
          totalItems={totalItems}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
        />

        {/* 版本详情：产物管理（上传/外链/删除） */}
        {active && (
          <ReleaseDetail
            release={active}
            onUploaded={async () => { await load(); }}
            onDeleteAsset={(assetId) => setConfirmDeleteAsset({ release: active, assetId })}
            onClose={() => setActive(null)}
          />
        )}

        {/* 创建版本 Dialog */}
        <Dialog open={createOpen} onOpenChange={(o) => setCreateOpen(o)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>创建版本</DialogTitle>
              <DialogDescription>创建为草稿，上传安装包后再发布。版本号需符合 semver（如 0.0.2）。</DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>版本号</Label>
                <Input
                  placeholder="0.0.2"
                  value={createForm.version}
                  onChange={(e) => setCreateForm({ ...createForm, version: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label>通道</Label>
                <Select value={createForm.channel ?? 'STABLE'} onValueChange={(v) => setCreateForm({ ...createForm, channel: v as ReleaseChannel })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="STABLE">正式版</SelectItem>
                    <SelectItem value="BETA">测试版</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>标题（可选）</Label>
                <Input
                  placeholder="如：v0.0.2 更新"
                  value={createForm.title}
                  onChange={(e) => setCreateForm({ ...createForm, title: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label>更新说明（markdown）</Label>
                <Textarea
                  rows={5}
                  placeholder="## 新功能&#10;- ..."
                  value={createForm.notes}
                  onChange={(e) => setCreateForm({ ...createForm, notes: e.target.value })}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCreateOpen(false)}>取消</Button>
              <Button onClick={() => { void handleCreate(); }}>创建草稿</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* 编辑 Dialog */}
        <Dialog open={!!editTarget} onOpenChange={(o) => { if (!o) setEditTarget(null); }}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>编辑版本 v{editTarget?.version}</DialogTitle>
              <DialogDescription>修改标题与更新说明。</DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>标题</Label>
                <Input value={editForm.title} onChange={(e) => setEditForm({ ...editForm, title: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label>更新说明（markdown）</Label>
                <Textarea rows={6} value={editForm.notes} onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })} />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditTarget(null)}>取消</Button>
              <Button onClick={() => { void handleEdit(); }}>保存</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* 发布确认 */}
        <Dialog open={!!confirmPublish} onOpenChange={(o) => { if (!o) setConfirmPublish(null); }}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>发布版本 v{confirmPublish?.version}</DialogTitle>
              <DialogDescription>发布后立即对官网下载页与桌面端更新检查可见，且标记为该通道最新版本。确定发布？</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmPublish(null)}>取消</Button>
              <Button onClick={() => { void handlePublish(); }}>确认发布</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* 归档确认 */}
        <Dialog open={!!confirmArchive} onOpenChange={(o) => { if (!o) setConfirmArchive(null); }}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>归档版本 v{confirmArchive?.version}</DialogTitle>
              <DialogDescription>归档后不再作为最新版本，官网与更新检查不再展示。确定归档？</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmArchive(null)}>取消</Button>
              <Button variant="outline" onClick={() => { void handleArchive(); }}>确认归档</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* 删除 asset 确认 */}
        <Dialog open={!!confirmDeleteAsset} onOpenChange={(o) => { if (!o) setConfirmDeleteAsset(null); }}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>删除产物</DialogTitle>
              <DialogDescription>删除后该下载链接立即失效，已下载的安装包不受影响。确定删除？</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmDeleteAsset(null)}>取消</Button>
              <Button variant="destructive" onClick={() => { void handleDeleteAsset(); }}>确认删除</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </Section>
  );
}

/** 版本详情面板：产物列表 + 上传安装包 + 登记外链。 */
function ReleaseDetail({
  release,
  onUploaded,
  onDeleteAsset,
  onClose,
}: {
  release: AdminRelease;
  onUploaded: () => Promise<void> | void;
  onDeleteAsset: (assetId: string) => void;
  onClose: () => void;
}) {
  // 上传安装包表单。
  const [uploadPlatform, setUploadPlatform] = useState<AssetPlatform>('WINDOWS');
  const [uploadArch, setUploadArch] = useState<AssetArch>('X86_64');
  const [file, setFile] = useState<File | null>(null);
  const [sigFile, setSigFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  // 外链登记表单。
  const [linkPlatform, setLinkPlatform] = useState<AssetPlatform>('WINDOWS');
  const [linkArch, setLinkArch] = useState<AssetArch>('X86_64');
  const [linkUrl, setLinkUrl] = useState('');
  const [linkFilename, setLinkFilename] = useState('');
  const [linkSignature, setLinkSignature] = useState('');
  const [linking, setLinking] = useState(false);

  // 选安装包文件。.sig 需用户单独选（浏览器沙箱无法自动读同名 .sig），文件选择器有两个 input。
  function pickFile(f: File | null) {
    setFile(f);
  }

  async function handleUpload() {
    if (!file) {
      toast.error('请选择安装包文件');
      return;
    }
    setUploading(true);
    try {
      await uploadAsset(release.id, file, uploadPlatform, uploadArch, sigFile ?? undefined);
      toast.success('安装包已上传，下载链接已生成');
      setFile(null);
      setSigFile(null);
      await onUploaded();
    } catch (e) {
      toast.error((e as Error).message || '上传失败');
    } finally {
      setUploading(false);
    }
  }

  async function handleAddLink() {
    if (!linkUrl.trim()) {
      toast.error('请填写下载链接');
      return;
    }
    setLinking(true);
    try {
      const input: AssetCreateInput = {
        platform: linkPlatform,
        arch: linkArch,
        url: linkUrl.trim(),
        filename: linkFilename.trim() || undefined,
        signature: linkSignature.trim() || undefined,
      };
      await addAsset(release.id, input);
      toast.success('外链产物已登记');
      setLinkUrl('');
      setLinkFilename('');
      setLinkSignature('');
      await onUploaded();
    } catch (e) {
      toast.error((e as Error).message || '登记失败');
    } finally {
      setLinking(false);
    }
  }

  function copyUrl(url: string) {
    const abs = absoluteDownloadUrl(url);
    navigator.clipboard?.writeText(abs).then(
      () => toast.success('下载链接已复制'),
      () => toast.error('复制失败，请手动复制'),
    );
  }

  return (
    <Panel title={`版本 v${release.version} · 产物管理`} description={`${release.assets.length} 个产物 · ${statusBadge(release.status)}`}>
      <div className="space-y-4">
        {/* 产物列表 */}
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>平台</TableHead>
                <TableHead>架构</TableHead>
                <TableHead>文件</TableHead>
                <TableHead>签名</TableHead>
                <TableHead>下载链接</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {release.assets.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-6 text-center text-sm text-muted-foreground">
                    暂无产物，上传安装包或登记外链。
                  </TableCell>
                </TableRow>
              ) : (
                release.assets.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell>{PLATFORM_LABEL[a.platform]}</TableCell>
                    <TableCell>{ARCH_LABEL[a.arch]}</TableCell>
                    <TableCell className="max-w-[180px] truncate font-mono text-xs">{a.filename}</TableCell>
                    <TableCell>{a.signature ? <Badge variant="default">已签</Badge> : <Badge variant="outline">无</Badge>}</TableCell>
                    <TableCell className="max-w-[200px] truncate font-mono text-xs text-muted-foreground">{a.url}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => openDownload(a.url)} title="下载">
                          <DownloadIcon className="size-3.5" />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => copyUrl(a.url)} title="复制链接">
                          <CopyIcon className="size-3.5" />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => onDeleteAsset(a.id)} title="删除">
                          <Trash2Icon className="size-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        {/* 上传安装包 */}
        <div className="rounded-lg border border-dashed p-4">
          <div className="mb-3 flex items-center gap-2 text-sm font-medium">
            <UploadIcon className="size-4" />
            上传安装包（生成 /downloads/ 下载链接）
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>平台</Label>
              <Select value={uploadPlatform} onValueChange={(v) => setUploadPlatform(v as AssetPlatform)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PLATFORM_OPTIONS.map((p) => <SelectItem key={p} value={p}>{PLATFORM_LABEL[p]}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>架构</Label>
              <Select value={uploadArch} onValueChange={(v) => setUploadArch(v as AssetArch)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ARCH_OPTIONS.map((a) => <SelectItem key={a} value={a}>{ARCH_LABEL[a]}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label>安装包文件（.exe / .dmg / .AppImage）</Label>
              <Input type="file" onChange={(e) => pickFile(e.target.files?.[0] ?? null)} />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label>签名文件（.sig，可选，updater 验签用）</Label>
              <Input type="file" onChange={(e) => setSigFile(e.target.files?.[0] ?? null)} />
            </div>
          </div>
          <div className="mt-3 flex justify-end">
            <Button disabled={!file || uploading} onClick={() => { void handleUpload(); }}>
              <UploadIcon className="mr-1 size-4" />
              上传
            </Button>
          </div>
        </div>

        {/* 登记外链产物 */}
        <div className="rounded-lg border border-dashed p-4">
          <div className="mb-3 flex items-center gap-2 text-sm font-medium">
            <LinkIcon className="size-4" />
            登记外链产物（安装包托管在第三方时用）
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>平台</Label>
              <Select value={linkPlatform} onValueChange={(v) => setLinkPlatform(v as AssetPlatform)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PLATFORM_OPTIONS.map((p) => <SelectItem key={p} value={p}>{PLATFORM_LABEL[p]}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>架构</Label>
              <Select value={linkArch} onValueChange={(v) => setLinkArch(v as AssetArch)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ARCH_OPTIONS.map((a) => <SelectItem key={a} value={a}>{ARCH_LABEL[a]}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label>下载直链</Label>
              <Input placeholder="https://github.com/.../LingFang_0.0.2_x64-setup.exe" value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>文件名（可选）</Label>
              <Input placeholder="LingFang_0.0.2_x64-setup.exe" value={linkFilename} onChange={(e) => setLinkFilename(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>签名（可选，base64）</Label>
              <Input placeholder="dW50cnVzdGVk..." value={linkSignature} onChange={(e) => setLinkSignature(e.target.value)} />
            </div>
          </div>
          <div className="mt-3 flex justify-end">
            <Button variant="outline" disabled={!linkUrl.trim() || linking} onClick={() => { void handleAddLink(); }}>
              <LinkIcon className="mr-1 size-4" />
              登记外链
            </Button>
          </div>
        </div>

        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>关闭详情</Button>
        </div>
      </div>
    </Panel>
  );
}
