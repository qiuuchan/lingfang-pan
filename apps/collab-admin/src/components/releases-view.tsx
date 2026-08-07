// releases-view.tsx — 平台 Admin 版本发布管理页。
//
// 职责：
// - 版本列表（含 DRAFT/PUBLISHED/ARCHIVED 全部状态，channel 筛选）。
// - 创建版本（DRAFT）→ 上传安装包（.exe + 可选 .sig，生成 /downloads/ 下载链接）→ 发布。
// - 登记外链产物（第三方托管场景，手填 url + signature）。
// - 归档 / 编辑 title·notes / 删除 asset。
//
// 后端契约（apps/collab-api/src/modules/admin.controller.ts + release.service.ts）：
// - GET /api/admin/releases（摘要分页 + channel/status/q 筛选）
// - GET /api/admin/releases/:id（完整说明与产物）
// - POST /api/admin/releases（create DRAFT）
// - PATCH /api/admin/releases/:id（改 title/notes）
// - POST /api/admin/releases/:id/publish | /archive
// - POST /api/admin/releases/:id/assets（外链登记）
// - POST /api/admin/releases/:id/assets/upload（multipart：file + 可选 signature + platform + arch）
// - DELETE /api/admin/releases/:id/assets/:assetId
//
// UI 模式参考治理中心：Section + Table + Dialog + DetailSheet + Pagination。
import { useEffect, useState, type FormEvent } from 'react';
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
  RefreshCwIcon,
  SearchIcon,
} from 'lucide-react';
import { api } from '@/lib/api';
import { run, useGuardedAction } from '@/lib/helpers';
import {
  createRelease,
  updateRelease,
  publishRelease,
  archiveRelease,
  deleteRelease,
  addAsset,
  uploadAsset,
  deleteAsset,
  absoluteDownloadUrl,
  openDownload,
  type AdminRelease,
  type ReleaseCreateInput,
  type AssetCreateInput,
} from '@/lib/releases';
import { Section } from '@/components/shared';
import { AsyncResource } from '@/components/ui/async-resource';
import { Button } from '@/components/ui/button';
import { DetailSheet } from '@/components/ui/detail-sheet';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
  TableCellAction,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Pagination } from '@/components/ui/pagination';
import { useAsyncResource } from '@/lib/async-resource';
import type { AssetPlatform, AssetArch, ReleaseChannel } from '@/lib/types';
import { formatTime } from '@/lib/types';

type ReleaseStatus = AdminRelease['status'];

interface ReleaseSummary {
  id: string;
  version: string;
  channel: ReleaseChannel;
  status: ReleaseStatus;
  title: string;
  isLatest: boolean;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  assetCount: number;
}

type AdminReleaseDetail = AdminRelease & {
  createdAt: string;
  updatedAt: string;
};

interface ReleasePage {
  items: ReleaseSummary[];
  total: number;
  page: number;
  pageSize: number;
}

interface ReleaseDetailResponse {
  release: AdminReleaseDetail;
}

const CHANNEL_FILTERS: { value: 'ALL' | ReleaseChannel; label: string }[] = [
  { value: 'ALL', label: '全部通道' },
  { value: 'STABLE', label: '正式版' },
  { value: 'BETA', label: '测试版' },
];

const STATUS_FILTERS: { value: 'ALL' | ReleaseStatus; label: string }[] = [
  { value: 'ALL', label: '全部状态' },
  { value: 'DRAFT', label: '草稿' },
  { value: 'PUBLISHED', label: '已发布' },
  { value: 'ARCHIVED', label: '已归档' },
];

const PLATFORM_OPTIONS: AssetPlatform[] = ['WINDOWS', 'DARWIN', 'LINUX'];
const ARCH_OPTIONS: AssetArch[] = ['X86_64', 'AARCH64', 'UNIVERSAL'];

const PLATFORM_LABEL: Record<AssetPlatform, string> = {
  WINDOWS: 'Windows',
  DARWIN: 'macOS',
  LINUX: 'Linux',
};
const ARCH_LABEL: Record<AssetArch, string> = {
  X86_64: 'x64',
  AARCH64: 'ARM64',
  UNIVERSAL: '通用',
};
const RELEASE_CHANNEL_LABEL: Record<ReleaseChannel, string> = {
  STABLE: '正式版',
  BETA: 'beta 测试版',
};

/** 版本状态 Badge 变体映射（StatusBadge 无此三态，自定义）。 */
function statusBadge(status: ReleaseStatus) {
  if (status === 'PUBLISHED') return <Badge variant="default">已发布</Badge>;
  if (status === 'DRAFT') return <Badge variant="secondary">草稿</Badge>;
  return <Badge variant="outline">已归档</Badge>;
}

function loadReleasePage(
  query: {
    page: number;
    pageSize: number;
    channel?: ReleaseChannel;
    status?: ReleaseStatus;
    q?: string;
  },
  signal: AbortSignal
) {
  const params = new URLSearchParams({
    page: String(query.page),
    pageSize: String(query.pageSize),
  });
  if (query.channel) params.set('channel', query.channel);
  if (query.status) params.set('status', query.status);
  if (query.q) params.set('q', query.q);
  return api<ReleasePage>(`/api/admin/releases?${params.toString()}`, { signal });
}

function loadReleaseDetail(id: string, signal: AbortSignal) {
  return api<ReleaseDetailResponse>(`/api/admin/releases/${id}`, { signal });
}

export function ReleasesView() {
  const [channelFilter, setChannelFilter] = useState<'ALL' | ReleaseChannel>('ALL');
  const [statusFilter, setStatusFilter] = useState<'ALL' | ReleaseStatus>('ALL');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const releases = useAsyncResource(
    (signal) =>
      loadReleasePage(
        {
          page,
          pageSize,
          channel: channelFilter === 'ALL' ? undefined : channelFilter,
          status: statusFilter === 'ALL' ? undefined : statusFilter,
          q: search || undefined,
        },
        signal
      ),
    [page, pageSize, channelFilter, statusFilter, search],
    { isEmpty: (result) => result.items.length === 0 }
  );

  useEffect(() => {
    if (!releases.data || releases.data.page !== page || releases.data.pageSize !== pageSize)
      return;
    const totalPages = Math.max(1, Math.ceil(releases.data.total / pageSize));
    if (page > totalPages) setPage(totalPages);
  }, [releases.data, page, pageSize]);

  const [active, setActive] = useState<ReleaseSummary | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const activeId = active?.id ?? '';
  const activeDetail = useAsyncResource(
    (signal) => loadReleaseDetail(activeId, signal),
    [activeId],
    { enabled: detailOpen && Boolean(activeId) }
  );

  useEffect(() => {
    if (!active || !releases.data) return;
    const latest = releases.data.items.find((release) => release.id === active.id);
    if (latest && latest !== active) setActive(latest);
  }, [active, releases.data]);

  // 创建版本 Dialog。
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState<ReleaseCreateInput>({
    version: '',
    channel: 'STABLE',
    title: '',
    notes: '',
  });

  // 编辑 Dialog。
  const [editTarget, setEditTarget] = useState<ReleaseSummary | null>(null);
  const [editForm, setEditForm] = useState({
    title: '',
    notes: '',
    channel: 'STABLE' as 'STABLE' | 'BETA',
    publishedAt: '',
  });
  const editTargetId = editTarget?.id ?? '';
  const editDetail = useAsyncResource(
    (signal) => loadReleaseDetail(editTargetId, signal),
    [editTargetId],
    { enabled: Boolean(editTargetId) }
  );

  useEffect(() => {
    const release = editDetail.data?.release;
    if (!release || release.id !== editTargetId) return;
    setEditForm({
      title: release.title ?? '',
      notes: release.notes ?? '',
      channel: release.channel,
      publishedAt: release.publishedAt ? release.publishedAt.slice(0, 16) : '',
    });
  }, [editDetail.data, editTargetId]);

  // 发布/归档/删除 asset 二次确认。
  const [confirmPublish, setConfirmPublish] = useState<ReleaseSummary | null>(null);
  const [confirmArchive, setConfirmArchive] = useState<ReleaseSummary | null>(null);
  const [confirmDeleteRelease, setConfirmDeleteRelease] = useState<ReleaseSummary | null>(null);
  const [confirmDeleteAsset, setConfirmDeleteAsset] = useState<{
    releaseId: string;
    assetId: string;
  } | null>(null);
  const [mutationBusy, guardMutation] = useGuardedAction();

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    setPage(1);
    setSearch(searchInput.trim());
  }

  function openDetail(release: ReleaseSummary) {
    setActive(release);
    setDetailOpen(true);
  }

  function refreshRelease(id: string) {
    releases.reload();
    if (detailOpen && active?.id === id) activeDetail.reload();
  }

  async function handleCreate() {
    if (!createForm.version.trim()) {
      toast.error('请填写版本号');
      return;
    }
    await guardMutation(async () => {
      const ok = await run(async () => {
        await createRelease(createForm);
        releases.reload();
      }, '版本已创建（草稿）');
      if (ok) {
        setCreateOpen(false);
        setCreateForm({ version: '', channel: 'STABLE', title: '', notes: '' });
      }
    });
  }

  function openEdit(r: ReleaseSummary) {
    setEditTarget(r);
  }
  async function handleEdit() {
    const release = editDetail.data?.release;
    if (!editTarget || !release || release.id !== editTarget.id) return;
    await guardMutation(async () => {
      const ok = await run(async () => {
        await updateRelease(editTarget.id, {
          title: editForm.title,
          notes: editForm.notes,
          channel: editForm.channel,
          publishedAt: editForm.publishedAt ? new Date(editForm.publishedAt).toISOString() : null,
        });
        refreshRelease(editTarget.id);
      }, '已保存');
      if (ok) setEditTarget(null);
    });
  }

  async function handlePublish() {
    if (!confirmPublish) return;
    const id = confirmPublish.id;
    await guardMutation(async () => {
      const ok = await run(async () => {
        await publishRelease(id);
        refreshRelease(id);
      }, '版本已发布');
      if (ok) setConfirmPublish(null);
    });
  }
  async function handleArchive() {
    if (!confirmArchive) return;
    const id = confirmArchive.id;
    await guardMutation(async () => {
      const ok = await run(async () => {
        await archiveRelease(id);
        refreshRelease(id);
      }, '版本已归档');
      if (ok) setConfirmArchive(null);
    });
  }
  async function handleDeleteRelease() {
    if (!confirmDeleteRelease) return;
    const id = confirmDeleteRelease.id;
    await guardMutation(async () => {
      const ok = await run(async () => {
        await deleteRelease(id);
        releases.reload();
      }, '版本已删除');
      if (ok) {
        if (active?.id === id) {
          setDetailOpen(false);
          setActive(null);
        }
        setConfirmDeleteRelease(null);
      }
    });
  }
  async function handleDeleteAsset() {
    if (!confirmDeleteAsset) return;
    const { releaseId, assetId } = confirmDeleteAsset;
    await guardMutation(async () => {
      const ok = await run(async () => {
        await deleteAsset(releaseId, assetId);
        refreshRelease(releaseId);
      }, '产物已删除');
      if (ok) setConfirmDeleteAsset(null);
    });
  }

  return (
    <Section
      title="版本发布"
      description="管理应用版本：创建草稿、上传安装包（生成下载链接）、发布到官网与桌面端更新检查。"
    >
      <div className="space-y-4">
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
          <form
            className="grid min-w-0 flex-1 gap-2 sm:grid-cols-[minmax(12rem,1fr)_10rem_10rem_auto]"
            onSubmit={submitSearch}
          >
            <div className="relative min-w-0">
              <SearchIcon className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder="搜索版本号或标题"
                className="pl-9"
              />
            </div>
            <Select
              value={channelFilter}
              onValueChange={(value) => {
                setChannelFilter(value as 'ALL' | ReleaseChannel);
                setPage(1);
              }}
            >
              <SelectTrigger aria-label="版本通道">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CHANNEL_FILTERS.map((f) => (
                  <SelectItem key={f.value} value={f.value}>
                    {f.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={statusFilter}
              onValueChange={(value) => {
                setStatusFilter(value as 'ALL' | ReleaseStatus);
                setPage(1);
              }}
            >
              <SelectTrigger aria-label="版本状态">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_FILTERS.map((filter) => (
                  <SelectItem key={filter.value} value={filter.value}>
                    {filter.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button type="submit">
              <SearchIcon />
              查询
            </Button>
          </form>
          <div className="flex shrink-0 gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={releases.reload}
              disabled={releases.status === 'loading'}
            >
              <RefreshCwIcon className={releases.status === 'loading' ? 'animate-spin' : ''} />
              刷新
            </Button>
            <Button type="button" onClick={() => setCreateOpen(true)}>
              <PlusIcon />
              创建版本
            </Button>
          </div>
        </div>

        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          正式版与 beta 测试版独立推送；发布 beta 不会影响正式版
          latest。创建或发布前请确认当前通道。
        </div>

        <AsyncResource
          status={releases.status}
          error={releases.error}
          retry={releases.reload}
          emptyFallback={
            <div className="flex min-h-40 flex-col items-center justify-center gap-2 border-y py-8 text-sm text-muted-foreground">
              <RocketIcon className="size-6 opacity-60" />
              没有符合条件的版本
            </div>
          }
        >
          {releases.data && (
            <>
              <div className="overflow-x-auto rounded-lg border">
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
                    {releases.data.items.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="font-mono">
                          <TableCellAction
                            aria-label={`查看版本 v${r.version} 详情`}
                            aria-expanded={detailOpen && active?.id === r.id}
                            aria-haspopup="dialog"
                            className="font-mono"
                            onClick={() => openDetail(r)}
                          >
                            v{r.version}
                          </TableCellAction>
                          {r.isLatest && (
                            <Badge variant="default" className="ml-2">
                              最新
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>{RELEASE_CHANNEL_LABEL[r.channel]}</TableCell>
                        <TableCell className="max-w-[200px] truncate">{r.title || '—'}</TableCell>
                        <TableCell>{statusBadge(r.status)}</TableCell>
                        <TableCell>{r.assetCount}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {r.publishedAt ? formatTime(r.publishedAt) : '—'}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => openEdit(r)}
                              title="编辑标题/说明"
                              aria-label={`编辑版本 v${r.version}`}
                            >
                              <PencilIcon className="size-3.5" />
                            </Button>
                            {r.status === 'DRAFT' && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setConfirmPublish(r)}
                                title="发布"
                                aria-label={`发布版本 v${r.version}`}
                              >
                                <SendIcon className="size-3.5" />
                              </Button>
                            )}
                            {r.status === 'ARCHIVED' && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setConfirmPublish(r)}
                                title="重新发布（取消归档）"
                                aria-label={`重新发布版本 v${r.version}`}
                              >
                                <SendIcon className="size-3.5" />
                              </Button>
                            )}
                            {r.status === 'PUBLISHED' && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setConfirmArchive(r)}
                                title="归档"
                                aria-label={`归档版本 v${r.version}`}
                              >
                                <ArchiveIcon className="size-3.5" />
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setConfirmDeleteRelease(r)}
                              title="删除版本"
                              aria-label={`删除版本 v${r.version}`}
                            >
                              <Trash2Icon className="size-3.5" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <Pagination
                currentPage={page}
                pageSize={pageSize}
                totalItems={releases.data.total}
                onPageChange={setPage}
                onPageSizeChange={setPageSize}
              />
            </>
          )}
        </AsyncResource>

        <ReleaseDetailSheet
          key={active?.id ?? 'release-detail'}
          summary={active}
          open={detailOpen && Boolean(active)}
          onOpenChange={setDetailOpen}
          resource={activeDetail}
          onChanged={() => {
            if (!active) return;
            refreshRelease(active.id);
          }}
          onDeleteAsset={(assetId) => {
            if (active) setConfirmDeleteAsset({ releaseId: active.id, assetId });
          }}
        />

        {/* 创建版本 Dialog */}
        <Dialog open={createOpen} onOpenChange={(o) => setCreateOpen(o)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>创建版本</DialogTitle>
              <DialogDescription>
                创建为草稿，上传安装包后再发布。版本号需符合 semver（如 0.0.2）。
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="release-create-version">版本号</Label>
                <Input
                  id="release-create-version"
                  placeholder="0.0.2"
                  value={createForm.version}
                  onChange={(e) => setCreateForm({ ...createForm, version: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="release-create-channel">通道</Label>
                <Select
                  value={createForm.channel ?? 'STABLE'}
                  onValueChange={(v) =>
                    setCreateForm({ ...createForm, channel: v as ReleaseChannel })
                  }
                >
                  <SelectTrigger id="release-create-channel">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="STABLE">正式版</SelectItem>
                    <SelectItem value="BETA">测试版</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="release-create-title">标题（可选）</Label>
                <Input
                  id="release-create-title"
                  placeholder="如：v0.0.2 更新"
                  value={createForm.title}
                  onChange={(e) => setCreateForm({ ...createForm, title: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="release-create-notes">更新说明（markdown）</Label>
                <Textarea
                  id="release-create-notes"
                  rows={5}
                  placeholder="## 新功能&#10;- ..."
                  value={createForm.notes}
                  onChange={(e) => setCreateForm({ ...createForm, notes: e.target.value })}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCreateOpen(false)}>
                取消
              </Button>
              <Button
                disabled={mutationBusy}
                onClick={() => {
                  void handleCreate();
                }}
              >
                {mutationBusy ? '创建中…' : '创建草稿'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* 编辑 Dialog */}
        <Dialog
          open={!!editTarget}
          onOpenChange={(o) => {
            if (!o) setEditTarget(null);
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>编辑版本 v{editTarget?.version}</DialogTitle>
              <DialogDescription>修改标题、说明、通道、首发时间。</DialogDescription>
            </DialogHeader>
            <AsyncResource
              status={editDetail.status}
              error={editDetail.error}
              retry={editDetail.reload}
            >
              {editDetail.data?.release.id === editTarget?.id && (
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="release-edit-title">标题</Label>
                    <Input
                      id="release-edit-title"
                      value={editForm.title}
                      onChange={(e) => setEditForm({ ...editForm, title: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="release-edit-notes">更新说明（markdown）</Label>
                    <Textarea
                      id="release-edit-notes"
                      rows={6}
                      value={editForm.notes}
                      onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
                    />
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="release-edit-channel">通道</Label>
                      <Select
                        value={editForm.channel}
                        onValueChange={(v) =>
                          setEditForm({ ...editForm, channel: v as 'STABLE' | 'BETA' })
                        }
                      >
                        <SelectTrigger id="release-edit-channel">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="STABLE">正式版</SelectItem>
                          <SelectItem value="BETA">测试版</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="release-edit-published-at">首发时间（留空清空）</Label>
                      <Input
                        id="release-edit-published-at"
                        type="datetime-local"
                        value={editForm.publishedAt}
                        onChange={(e) => setEditForm({ ...editForm, publishedAt: e.target.value })}
                      />
                    </div>
                  </div>
                </div>
              )}
            </AsyncResource>
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditTarget(null)}>
                取消
              </Button>
              <Button
                onClick={() => {
                  void handleEdit();
                }}
                disabled={
                  mutationBusy ||
                  editDetail.status !== 'ready' ||
                  editDetail.data?.release.id !== editTarget?.id
                }
              >
                保存
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* 发布确认 */}
        <Dialog
          open={!!confirmPublish}
          onOpenChange={(o) => {
            if (!o) setConfirmPublish(null);
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>发布版本 v{confirmPublish?.version}</DialogTitle>
              <DialogDescription>
                发布后立即对「{RELEASE_CHANNEL_LABEL[confirmPublish?.channel ?? 'STABLE']}
                」通道可见，并标记为该通道最新版本。
                {confirmPublish?.channel === 'BETA'
                  ? '不会影响正式版用户。'
                  : '正式版会影响默认更新用户。'}
                确定发布？
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmPublish(null)}>
                取消
              </Button>
              <Button
                disabled={mutationBusy}
                onClick={() => {
                  void handlePublish();
                }}
              >
                确认发布
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* 归档确认 */}
        <Dialog
          open={!!confirmArchive}
          onOpenChange={(o) => {
            if (!o) setConfirmArchive(null);
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>归档版本 v{confirmArchive?.version}</DialogTitle>
              <DialogDescription>
                归档后不再作为「{RELEASE_CHANNEL_LABEL[confirmArchive?.channel ?? 'STABLE']}
                」通道最新版本，官网与更新检查不再展示。确定归档？
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmArchive(null)}>
                取消
              </Button>
              <Button
                variant="outline"
                disabled={mutationBusy}
                onClick={() => {
                  void handleArchive();
                }}
              >
                确认归档
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* 删除版本确认 */}
        <Dialog
          open={!!confirmDeleteRelease}
          onOpenChange={(o) => {
            if (!o) setConfirmDeleteRelease(null);
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>删除版本 v{confirmDeleteRelease?.version}</DialogTitle>
              <DialogDescription>
                物理删除该版本及其全部产物（下载链接），不可恢复。官网与更新检查立即不再展示。确定删除？
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmDeleteRelease(null)}>
                取消
              </Button>
              <Button
                variant="destructive"
                disabled={mutationBusy}
                onClick={() => {
                  void handleDeleteRelease();
                }}
              >
                确认删除
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* 删除 asset 确认 */}
        <Dialog
          open={!!confirmDeleteAsset}
          onOpenChange={(o) => {
            if (!o) setConfirmDeleteAsset(null);
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>删除产物</DialogTitle>
              <DialogDescription>
                删除后该下载链接立即失效，已下载的安装包不受影响。确定删除？
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmDeleteAsset(null)}>
                取消
              </Button>
              <Button
                variant="destructive"
                disabled={mutationBusy}
                onClick={() => {
                  void handleDeleteAsset();
                }}
              >
                确认删除
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </Section>
  );
}

/** 版本详情 Sheet：打开后才加载说明与产物。 */
function ReleaseDetailSheet({
  summary,
  open,
  onOpenChange,
  resource,
  onChanged,
  onDeleteAsset,
}: {
  summary: ReleaseSummary | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resource: ReturnType<typeof useAsyncResource<ReleaseDetailResponse>>;
  onChanged: () => Promise<void> | void;
  onDeleteAsset: (assetId: string) => void;
}) {
  const [uploadPlatform, setUploadPlatform] = useState<AssetPlatform>('WINDOWS');
  const [uploadArch, setUploadArch] = useState<AssetArch>('X86_64');
  const [file, setFile] = useState<File | null>(null);
  const [linkPlatform, setLinkPlatform] = useState<AssetPlatform>('WINDOWS');
  const [linkArch, setLinkArch] = useState<AssetArch>('X86_64');
  const [linkUrl, setLinkUrl] = useState('');
  const [linkFilename, setLinkFilename] = useState('');
  const [assetBusy, guardAsset] = useGuardedAction();
  const loadedRelease = resource.data?.release;
  const release = loadedRelease?.id === summary?.id ? loadedRelease : null;

  useEffect(() => {
    if (open) return;
    setFile(null);
    setLinkUrl('');
    setLinkFilename('');
  }, [open]);

  function pickFile(f: File | null) {
    setFile(f);
  }

  async function handleUpload() {
    if (!release || !file) {
      toast.error('请选择安装包文件');
      return;
    }
    await guardAsset(async () => {
      try {
        await uploadAsset(release.id, file, uploadPlatform, uploadArch);
        toast.success('安装包已上传，下载链接与 SHA-256 已生成');
        setFile(null);
        await onChanged();
      } catch (e) {
        toast.error((e as Error).message || '上传失败');
      }
    });
  }

  async function handleAddLink() {
    if (!release || !linkUrl.trim()) {
      toast.error('请填写下载链接');
      return;
    }
    await guardAsset(async () => {
      try {
        const input: AssetCreateInput = {
          platform: linkPlatform,
          arch: linkArch,
          url: linkUrl.trim(),
          filename: linkFilename.trim() || undefined,
        };
        await addAsset(release.id, input);
        toast.success('外链产物已登记');
        setLinkUrl('');
        setLinkFilename('');
        await onChanged();
      } catch (e) {
        toast.error((e as Error).message || '登记失败');
      }
    });
  }

  function copyUrl(url: string) {
    const abs = absoluteDownloadUrl(url);
    navigator.clipboard?.writeText(abs).then(
      () => toast.success('下载链接已复制'),
      () => toast.error('复制失败，请手动复制')
    );
  }

  return (
    <DetailSheet
      open={open}
      onOpenChange={onOpenChange}
      title={summary ? `版本 v${summary.version}` : '版本详情'}
      description={
        summary
          ? `${RELEASE_CHANNEL_LABEL[summary.channel]} · ${summary.assetCount} 个产物`
          : undefined
      }
      size="xl"
    >
      <AsyncResource status={resource.status} error={resource.error} retry={resource.reload}>
        {release && (
          <div className="space-y-5">
            <section className="space-y-3">
              <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <div className="text-xs text-muted-foreground">状态</div>
                  <div className="mt-1">{statusBadge(release.status)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">通道</div>
                  <div className="mt-1">{RELEASE_CHANNEL_LABEL[release.channel]}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">首发时间</div>
                  <div className="mt-1">
                    {release.publishedAt ? formatTime(release.publishedAt) : '—'}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">更新时间</div>
                  <div className="mt-1">{formatTime(release.updatedAt)}</div>
                </div>
              </div>
              <div className="space-y-1 border-t pt-3">
                <h3 className="text-sm font-semibold">更新说明</h3>
                <p className="whitespace-pre-wrap break-words text-sm leading-6 text-muted-foreground">
                  {release.notes || '未填写'}
                </p>
              </div>
            </section>

            <section className="space-y-3 border-t pt-5">
              <div>
                <h3 className="text-sm font-semibold">版本产物</h3>
                <p className="text-xs text-muted-foreground">
                  安装包与外链仅在打开当前版本详情后加载。
                </p>
              </div>
              <div className="overflow-x-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>平台</TableHead>
                      <TableHead>架构</TableHead>
                      <TableHead>文件</TableHead>
                      <TableHead>SHA-256</TableHead>
                      <TableHead>下载链接</TableHead>
                      <TableHead className="text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {release.assets.length === 0 ? (
                      <TableRow>
                        <TableCell
                          colSpan={6}
                          className="py-6 text-center text-sm text-muted-foreground"
                        >
                          暂无产物，上传安装包或登记外链。
                        </TableCell>
                      </TableRow>
                    ) : (
                      release.assets.map((asset) => (
                        <TableRow key={asset.id}>
                          <TableCell>{PLATFORM_LABEL[asset.platform]}</TableCell>
                          <TableCell>{ARCH_LABEL[asset.arch]}</TableCell>
                          <TableCell className="max-w-[180px] truncate font-mono text-xs">
                            {asset.filename}
                          </TableCell>
                          <TableCell>
                            {asset.sha256 ? (
                              <span
                                className="font-mono text-xs text-muted-foreground"
                                title={asset.sha256}
                              >
                                {asset.sha256.slice(0, 12)}…
                              </span>
                            ) : (
                              <Badge variant="outline">无</Badge>
                            )}
                          </TableCell>
                          <TableCell className="max-w-[200px] truncate font-mono text-xs text-muted-foreground">
                            {asset.url}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => openDownload(asset.url)}
                                title="下载"
                                aria-label={`下载 ${asset.filename}`}
                              >
                                <DownloadIcon className="size-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => copyUrl(asset.url)}
                                title="复制链接"
                                aria-label={`复制 ${asset.filename} 下载链接`}
                              >
                                <CopyIcon className="size-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => onDeleteAsset(asset.id)}
                                title="删除"
                                aria-label={`删除产物 ${asset.filename}`}
                              >
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
            </section>

            <section className="space-y-3 border-t pt-5">
              <div className="flex items-center gap-2 text-sm font-medium">
                <UploadIcon className="size-4" />
                上传安装包
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="release-upload-platform">平台</Label>
                  <Select
                    value={uploadPlatform}
                    onValueChange={(v) => setUploadPlatform(v as AssetPlatform)}
                  >
                    <SelectTrigger id="release-upload-platform">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PLATFORM_OPTIONS.map((platform) => (
                        <SelectItem key={platform} value={platform}>
                          {PLATFORM_LABEL[platform]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="release-upload-arch">架构</Label>
                  <Select value={uploadArch} onValueChange={(v) => setUploadArch(v as AssetArch)}>
                    <SelectTrigger id="release-upload-arch">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ARCH_OPTIONS.map((arch) => (
                        <SelectItem key={arch} value={arch}>
                          {ARCH_LABEL[arch]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="release-upload-file">安装包文件（.exe / .dmg / .AppImage）</Label>
                  <label
                    htmlFor="release-upload-file"
                    className="flex cursor-pointer items-center gap-2 rounded-md border border-dashed p-3 transition hover:bg-muted/50"
                  >
                    <UploadIcon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">点击选择文件</span>
                    {file && (
                      <span className="ml-auto max-w-[50%] truncate text-xs font-medium">
                        {file.name}
                      </span>
                    )}
                    <input
                      id="release-upload-file"
                      type="file"
                      className="hidden"
                      onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
                    />
                  </label>
                  <p className="text-xs text-muted-foreground">
                    上传后自动计算 SHA-256，并生成 /downloads/ 下载链接。
                  </p>
                </div>
              </div>
              <div className="flex justify-end">
                <Button
                  disabled={!file || assetBusy}
                  onClick={() => {
                    void handleUpload();
                  }}
                >
                  <UploadIcon />
                  {assetBusy ? '处理中…' : '上传'}
                </Button>
              </div>
            </section>

            <section className="space-y-3 border-t pt-5">
              <div className="flex items-center gap-2 text-sm font-medium">
                <LinkIcon className="size-4" />
                登记外链产物
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="release-link-platform">平台</Label>
                  <Select
                    value={linkPlatform}
                    onValueChange={(v) => setLinkPlatform(v as AssetPlatform)}
                  >
                    <SelectTrigger id="release-link-platform">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PLATFORM_OPTIONS.map((platform) => (
                        <SelectItem key={platform} value={platform}>
                          {PLATFORM_LABEL[platform]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="release-link-arch">架构</Label>
                  <Select value={linkArch} onValueChange={(v) => setLinkArch(v as AssetArch)}>
                    <SelectTrigger id="release-link-arch">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ARCH_OPTIONS.map((arch) => (
                        <SelectItem key={arch} value={arch}>
                          {ARCH_LABEL[arch]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="release-link-url">下载直链</Label>
                  <Input
                    id="release-link-url"
                    placeholder="https://github.com/.../LingFang_0.0.2_x64-setup.exe"
                    value={linkUrl}
                    onChange={(e) => setLinkUrl(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="release-link-filename">文件名（可选）</Label>
                  <Input
                    id="release-link-filename"
                    placeholder="LingFang_0.0.2_x64-setup.exe"
                    value={linkFilename}
                    onChange={(e) => setLinkFilename(e.target.value)}
                  />
                </div>
              </div>
              <div className="flex justify-end">
                <Button
                  variant="outline"
                  disabled={!linkUrl.trim() || assetBusy}
                  onClick={() => {
                    void handleAddLink();
                  }}
                >
                  <LinkIcon />
                  {assetBusy ? '处理中…' : '登记外链'}
                </Button>
              </div>
            </section>
          </div>
        )}
      </AsyncResource>
    </DetailSheet>
  );
}
