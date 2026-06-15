import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DetailSheet } from '@/components/ui/detail-sheet';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { SearchIcon, SettingsIcon, ToggleLeftIcon, ToggleRightIcon, LayersIcon, PencilIcon, ArchiveIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { useGuardedAction, useLoad, run } from '@/lib/helpers';
import { StatusBadge, Section, InfoGrid, ActionBar } from '@/components/shared';
import { usePagination, Pagination } from '@/components/ui/pagination';
import type { Plugin, PluginFileEntry, PluginStatus, PluginVisibility } from '@/lib/types';
import { labelOf, formatTime, yuanToCents } from '@/lib/types';
import { money } from '@/lib/utils';

type ReviewFilter = 'ALL' | 'APPROVED' | 'PENDING' | 'REJECTED';

const REVIEW_FILTERS: { value: ReviewFilter; label: string }[] = [
  { value: 'ALL', label: '全部审核状态' },
  { value: 'APPROVED', label: '已通过' },
  { value: 'PENDING', label: '待审核' },
  { value: 'REJECTED', label: '已驳回' },
];

export function PluginsView() {
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [query, setQuery] = useState('');
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>('ALL');
  // 批量选择集合：当前过滤后的全量列表内被勾选的插件 id。
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // 详情 Sheet 当前打开的插件。
  const [active, setActive] = useState<Plugin | null>(null);

  const load = () => api<{ plugins: Plugin[] }>('/api/admin/plugins').then((r) => setPlugins(r.plugins));
  useLoad(load);

  // 详情 Sheet 打开期间，若列表刷新（如 footer 内禁用/启用），同步 active 指向最新对象，
  // 避免详情面板与 footer 按钮显示陈旧状态。
  useEffect(() => {
    if (!active) return;
    const latest = plugins.find((p) => p.id === active.id);
    if (latest && latest !== active) setActive(latest);
  }, [plugins, active]);

  // 前端过滤：搜索按 name（任务约束「按 name 搜」），状态筛选按 reviewStatus。
  // 后端 /api/admin/plugins 无 query 参数支持，故纯前端过滤。
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return plugins.filter((p) => {
      if (q && !p.name.toLowerCase().includes(q)) return false;
      if (reviewFilter !== 'ALL' && p.reviewStatus !== reviewFilter) return false;
      return true;
    });
  }, [plugins, query, reviewFilter]);

  const { paginated, page, setPage, pageSize, setPageSize, totalItems } = usePagination(filtered);

  // 过滤条件变化时清空已选集合：避免选中项已不在当前视图导致的「幽灵选中」。
  useEffect(() => {
    setSelectedIds(new Set());
  }, [query, reviewFilter]);

  const pageIds = useMemo(() => new Set(paginated.map((p) => p.id)), [paginated]);
  const allOnPageSelected = pageIds.size > 0 && [...pageIds].every((id) => selectedIds.has(id));

  function togglePage(checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) pageIds.forEach((id) => next.add(id));
      else pageIds.forEach((id) => next.delete(id));
      return next;
    });
  }

  function toggleRow(id: string, checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function toggle(plugin: Plugin) {
    await run(
      () =>
        api(`/api/admin/plugins/${plugin.id}`, {
          method: 'PATCH',
          body: { status: plugin.status === 'ENABLED' ? 'DISABLED' : 'ENABLED' },
        }).then(load),
      plugin.status === 'ENABLED' ? '插件已禁用' : '插件已启用',
    );
  }

  // 批量启用/禁用：逐条 PATCH（后端无批量端点），用 Promise.all 并发，成功后统一刷新 + 清空选择。
  async function bulkSetStatus(status: PluginStatus) {
    const targets = filtered.filter((p) => selectedIds.has(p.id));
    if (!targets.length) return;
    const ok = await run(
      () =>
        Promise.all(
          targets.map((p) =>
            api(`/api/admin/plugins/${p.id}`, { method: 'PATCH', body: { status } }),
          ),
        ).then(load),
      status === 'ENABLED' ? `已批量启用 ${targets.length} 个插件` : `已批量禁用 ${targets.length} 个插件`,
    );
    if (ok) setSelectedIds(new Set());
  }

  return (
    <Section title="插件管理" description="管理端只做平台治理，插件创建在本地客户端完成。">
      <div className="space-y-4">
        {/* 搜索 + 筛选 + 批量操作工具栏 */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-1 flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative max-w-xs flex-1">
              <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="按名称搜索插件"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select value={reviewFilter} onValueChange={(v) => setReviewFilter(v as ReviewFilter)}>
              <SelectTrigger className="sm:w-[160px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REVIEW_FILTERS.map((f) => (
                  <SelectItem key={f.value} value={f.value}>
                    {f.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {selectedIds.size > 0 ? (
            <div className="flex items-center gap-2 rounded-xl border bg-muted/40 px-3 py-1.5">
              <span className="text-xs text-muted-foreground">已选 {selectedIds.size} 个</span>
              <Button variant="outline" size="sm" onClick={() => bulkSetStatus('ENABLED')}>
                <ToggleRightIcon className="mr-1 size-3.5" />
                批量启用
              </Button>
              <Button variant="destructive" size="sm" onClick={() => bulkSetStatus('DISABLED')}>
                <ToggleLeftIcon className="mr-1 size-3.5" />
                批量禁用
              </Button>
            </div>
          ) : null}
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[44px]">
                <Checkbox checked={allOnPageSelected} onCheckedChange={togglePage} aria-label="全选本页" />
              </TableHead>
              <TableHead>插件</TableHead>
              <TableHead>说明</TableHead>
              <TableHead>治理</TableHead>
              <TableHead>审核</TableHead>
              <TableHead className="w-[180px]">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {paginated.length ? (
              paginated.map((plugin) => {
                const selected = selectedIds.has(plugin.id);
                return (
                  <TableRow
                    key={plugin.id}
                    data-state={selected ? 'selected' : undefined}
                    className="cursor-pointer"
                    onClick={() => setActive(plugin)}
                  >
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={selected}
                        onCheckedChange={(c) => toggleRow(plugin.id, c)}
                        aria-label={`选择 ${plugin.name}`}
                      />
                    </TableCell>
                    <TableCell className="font-medium">{plugin.name}</TableCell>
                    <TableCell className="max-w-md truncate text-muted-foreground">
                      {plugin.description || '—'}
                    </TableCell>
                    <TableCell><StatusBadge value={plugin.status} /></TableCell>
                    <TableCell>{plugin.reviewStatus ? <ReviewBadge status={plugin.reviewStatus} /> : '—'}</TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <ActionBar>
                        <PluginEditDialog plugin={plugin} onRefresh={load}>
                          <Button variant="outline" size="sm">
                            <SettingsIcon className="mr-1 size-3.5" />
                            治理
                          </Button>
                        </PluginEditDialog>
                        <Button
                          variant={plugin.status === 'ENABLED' ? 'destructive' : 'outline'}
                          size="sm"
                          onClick={() => toggle(plugin)}
                        >
                          {plugin.status === 'ENABLED' ? (
                            <ToggleLeftIcon className="mr-1 size-3.5" />
                          ) : (
                            <ToggleRightIcon className="mr-1 size-3.5" />
                          )}
                          {plugin.status === 'ENABLED' ? '禁用' : '启用'}
                        </Button>
                      </ActionBar>
                    </TableCell>
                  </TableRow>
                );
              })
            ) : (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                  {plugins.length ? '没有符合筛选条件的插件' : '暂无平台插件'}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        <Pagination
          totalItems={totalItems}
          pageSize={pageSize}
          currentPage={page}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
        />
      </div>

      {/* 行点击打开的详情抽屉：完整字段 + 文件列表预览 + capabilities。 */}
      <PluginDetailSheet plugin={active} onOpenChange={(o) => !o && setActive(null)} onRefresh={load} />
    </Section>
  );
}

// 审核状态徽章：reviewStatus 映射到语义色（与 StatusBadge 风格一致但独立，避免 DRAFT 等新增态污染通用映射）。
// status 接受任意 string：列表行传入 Plugin['reviewStatus']，审核历史传入后端 PluginReview.status（同为枚举串）。
function ReviewBadge({ status }: { status: string }) {
  const map: Record<string, 'success' | 'warning' | 'destructive' | 'secondary'> = {
    APPROVED: 'success',
    PENDING: 'warning',
    REJECTED: 'destructive',
    DRAFT: 'secondary',
  };
  return <Badge variant={map[status] || 'secondary'}>{labelOf(status)}</Badge>;
}

// 插件详情侧边抽屉：展示后端 publicPlugin 全字段，含 capabilities 与文件清单。
function PluginDetailSheet({
  plugin,
  onOpenChange,
  onRefresh,
}: {
  plugin: Plugin | null;
  onOpenChange: (open: boolean) => void;
  onRefresh: () => void;
}) {
  const fileList = normalizeFiles(plugin?.files);
  const capabilities = normalizeCapabilities(plugin?.capabilities);
  // 下架为资金/上架状态类操作，前端用防重入守卫避免双击重复触发（与余额调整同模式）。
  const [delistBusy, delistGuard] = useGuardedAction();

  return (
    <DetailSheet
      open={!!plugin}
      onOpenChange={onOpenChange}
      title={plugin?.name || ''}
      description={plugin?.version ? `v${plugin.version}` : undefined}
      footer={
        plugin ? (
          <div className="flex flex-wrap items-center gap-2">
            <PluginInfoEditDialog plugin={plugin} onRefresh={onRefresh}>
              <Button variant="outline" className="flex-1">
                <PencilIcon className="mr-1 size-4" />
                编辑信息
              </Button>
            </PluginInfoEditDialog>
            <Button
              variant={plugin.status === 'ENABLED' ? 'destructive' : 'outline'}
              className="flex-1"
              onClick={() => {
                void run(
                  () =>
                    api(`/api/admin/plugins/${plugin.id}`, {
                      method: 'PATCH',
                      body: { status: plugin.status === 'ENABLED' ? 'DISABLED' : 'ENABLED' },
                    }).then(onRefresh),
                  plugin.status === 'ENABLED' ? '插件已禁用' : '插件已启用',
                );
              }}
            >
              {plugin.status === 'ENABLED' ? (
                <ToggleLeftIcon className="mr-1 size-4" />
              ) : (
                <ToggleRightIcon className="mr-1 size-4" />
              )}
              {plugin.status === 'ENABLED' ? '禁用插件' : '启用插件'}
            </Button>
            {plugin.marketplace ? (
              <PluginDelistDialog plugin={plugin} busy={delistBusy} onConfirm={delistGuard} onRefresh={onRefresh} />
            ) : null}
          </div>
        ) : null
      }
    >
      {plugin ? (
        <>
          <div>
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">基本信息</div>
            <InfoGrid
              items={[
                ['插件 ID', plugin.id],
                ['运行时', labelOf(plugin.runtimeType || plugin.runtime_type)],
                ['入口', plugin.entry || '—'],
                ['可见性', labelOf(plugin.visibility)],
                ['治理状态', labelOf(plugin.status)],
                ['审核状态', plugin.reviewStatus ? labelOf(plugin.reviewStatus) : '—'],
                ['市场价格', plugin.priceCents ? money(plugin.priceCents) : '免费'],
                ['上架市场', plugin.marketplace ? '是' : '否'],
                ['安装次数', String(plugin.installCount ?? 0)],
                ['评分', plugin.ratingCount ? `${(plugin.ratingSum ?? 0) / plugin.ratingCount}（${plugin.ratingCount} 人）` : '—'],
                ['创建时间', formatTime(plugin.createdAt)],
                ['更新时间', formatTime(plugin.updatedAt)],
              ]}
            />
          </div>

          {plugin.description ? (
            <div>
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">插件说明</div>
              <p className="whitespace-pre-wrap break-all text-sm text-foreground">{plugin.description}</p>
            </div>
          ) : null}

          <div>
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">能力声明 (capabilities)</div>
            {capabilities.length ? (
              <div className="flex flex-wrap gap-1.5">
                {capabilities.map((c, i) => (
                  <Badge key={`${c}-${i}`} variant="secondary">{c}</Badge>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">未声明能力</p>
            )}
          </div>

          <div>
            <div className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <LayersIcon className="size-3.5" />
              文件清单
            </div>
            {fileList.length ? (
              <div className="overflow-hidden rounded-xl border">
                {fileList.map((file, i) => (
                  <div key={`${file.path || ''}-${i}`} className="flex items-center justify-between gap-3 border-b px-3 py-2 text-sm last:border-0">
                    <span className="min-w-0 truncate font-mono text-xs text-foreground">{file.path || `文件 ${i + 1}`}</span>
                    {typeof file.size === 'number' ? (
                      <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(file.size)}</span>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">无文件记录</p>
            )}
          </div>

          {plugin.contentHash ? (
            <div>
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">内容哈希</div>
              <code className="block break-all rounded-xl bg-muted p-3 font-mono text-xs text-muted-foreground">{plugin.contentHash}</code>
            </div>
          ) : null}

          {plugin.reviewReason ? (
            <div>
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">审核备注</div>
              <p className="whitespace-pre-wrap break-all text-sm text-foreground">{plugin.reviewReason}</p>
            </div>
          ) : null}

          <PluginReviewTimeline pluginId={plugin.id} />
        </>
      ) : null}
    </DetailSheet>
  );
}

function PluginEditDialog({
  plugin,
  children,
  onRefresh,
}: {
  plugin: Plugin;
  children: React.ReactNode;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState(plugin.description || '');
  const [status, setStatus] = useState<PluginStatus>(plugin.status);

  useEffect(() => {
    setDescription(plugin.description || '');
    setStatus(plugin.status);
  }, [plugin]);

  async function save() {
    // ADMIN-VIEW-04 修复：仅成功才关闭对话框，失败保留已编辑的描述/状态。
    if (!(await run(
      () =>
        api(`/api/admin/plugins/${plugin.id}`, {
          method: 'PATCH',
          body: { description, status },
        }).then(onRefresh),
      '插件治理信息已更新',
    ))) return;
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>插件治理</DialogTitle>
          <DialogDescription>{plugin.name}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <InfoGrid
            items={[
              ['插件 ID', plugin.id],
              ['插件名称', plugin.name],
              ['当前状态', labelOf(plugin.status)],
              ['更新时间', formatTime(plugin.updatedAt)],
            ]}
          />
          <div className="space-y-2">
            <Label>插件说明</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>治理状态</Label>
            <Select value={status} onValueChange={(v) => setStatus(v as PluginStatus)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ENABLED">已启用</SelectItem>
                <SelectItem value="DISABLED">已禁用</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={save}>保存治理信息</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// 详情抽屉的「编辑信息」对话框：改 name/description/version/priceCents/visibility。
// 与行内 PluginEditDialog（描述+治理状态）互补：此弹窗聚焦展示信息与可见性，不含 status（status 由独立切换按钮维护）。
// 仅成功才关闭：失败保留草稿供修正（与 PluginEditDialog.save 同约定）。
function PluginInfoEditDialog({
  plugin,
  children,
  onRefresh,
}: {
  plugin: Plugin;
  children: React.ReactNode;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(plugin.name);
  const [description, setDescription] = useState(plugin.description || '');
  const [version, setVersion] = useState(plugin.version || '');
  // 价格以元为输入单位（cents 不便阅读），保存时用 yuanToCents 转回分。
  const [priceYuan, setPriceYuan] = useState(plugin.priceCents ? (plugin.priceCents / 100).toString() : '');
  const [visibility, setVisibility] = useState<PluginVisibility>(plugin.visibility || 'TEAM');

  useEffect(() => {
    setName(plugin.name);
    setDescription(plugin.description || '');
    setVersion(plugin.version || '');
    setPriceYuan(plugin.priceCents ? (plugin.priceCents / 100).toString() : '');
    setVisibility(plugin.visibility || 'TEAM');
  }, [plugin]);

  async function save() {
    // 价格空串视为免费（0 分）；非空串用 yuanToCents 校验并转换（非法格式抛错，run 会 toast）。
    let priceCents = 0;
    if (priceYuan.trim()) {
      priceCents = yuanToCents(priceYuan);
    }
    if (!(await run(
      () =>
        api(`/api/admin/plugins/${plugin.id}`, {
          method: 'PATCH',
          body: { name: name.trim(), description, version: version.trim(), priceCents, visibility },
        }).then(onRefresh),
      '插件信息已更新',
    ))) return;
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>编辑插件信息</DialogTitle>
          <DialogDescription>{plugin.name}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>插件名称</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={128} />
          </div>
          <div className="space-y-2">
            <Label>插件说明</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>版本</Label>
              <Input value={version} onChange={(e) => setVersion(e.target.value)} maxLength={32} placeholder="0.1.0" />
            </div>
            <div className="space-y-2">
              <Label>定价（元）</Label>
              <Input value={priceYuan} onChange={(e) => setPriceYuan(e.target.value)} placeholder="0 表示免费" inputMode="decimal" />
            </div>
          </div>
          <div className="space-y-2">
            <Label>可见性</Label>
            <Select value={visibility} onValueChange={(v) => setVisibility(v as PluginVisibility)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="PRIVATE">私有</SelectItem>
                <SelectItem value="TEAM">团队</SelectItem>
                <SelectItem value="PUBLIC">公开</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={save}>保存信息</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// 详情抽屉的「下架」按钮 + 二次确认对话框：调 POST /api/admin/plugins/:id/delist。
// 仅在插件已上架市场（marketplace=true）时渲染。下架会通知作者，操作不可逆（需作者重新提交审核）。
function PluginDelistDialog({
  plugin,
  busy,
  onConfirm,
  onRefresh,
}: {
  plugin: Plugin;
  busy: boolean;
  onConfirm: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (!open) setReason('');
  }, [open]);

  async function confirm() {
    // 用防重入守卫包裹：避免双击重复触发下架（资金/上架状态类操作无后端幂等键）。
    const result = await onConfirm(() =>
      api(`/api/admin/plugins/${plugin.id}/delist`, {
        method: 'POST',
        body: reason.trim() ? { reason: reason.trim() } : {},
      }).then((r) => {
        onRefresh();
        return r;
      }),
    );
    if (result) setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="destructive" className="flex-1">
          <ArchiveIcon className="mr-1 size-4" />
          下架市场
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>下架插件</DialogTitle>
          <DialogDescription>{plugin.name}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            下架后该插件将退出市场（marketplace=false，审核状态回到草稿），已安装用户不受影响但无法被新用户安装。作者会收到下架通知，可重新编辑后再次提交审核。
          </p>
          <div className="space-y-2">
            <Label>下架原因（可选，写入通知）</Label>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="如：违反平台规范" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>取消</Button>
          <Button variant="destructive" disabled={busy} onClick={confirm}>
            {busy ? '下架中…' : '确认下架'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// 审核历史时间线：拉取 GET /api/admin/plugins/:id/audit-history，按时间倒序渲染 PluginReview 列表。
// 每项展示审核状态（语义色徽章）、原因、审核人、时间。无记录时显示空态。
type PluginReviewEntry = {
  id: string;
  status: string;
  reason: string;
  reviewer: { id: string; email: string; displayName: string } | null;
  createdAt: string;
};

function PluginReviewTimeline({ pluginId }: { pluginId: string }) {
  const [reviews, setReviews] = useState<PluginReviewEntry[] | null>(null);

  // 依赖 pluginId：DetailSheet 在切换不同插件时不会重挂载 PluginReviewTimeline（同 key），
  // 故不能用 mount-once 的 useLoad，必须用 useEffect 监听 pluginId 变化重新拉取。
  useEffect(() => {
    let mounted = true;
    setReviews(null);
    api<{ reviews: PluginReviewEntry[] }>(`/api/admin/plugins/${pluginId}/audit-history`)
      .then((r) => {
        if (mounted) setReviews(r.reviews);
      })
      .catch((e: Error & { status?: number }) => {
        // 卸载后或 401 不弹 toast（与 useLoad 约定一致）。
        if (!mounted || e.status === 401) return;
        setReviews([]);
      });
    return () => {
      mounted = false;
    };
  }, [pluginId]);

  return (
    <div>
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">审核历史</div>
      {reviews === null ? (
        <p className="text-sm text-muted-foreground">加载中…</p>
      ) : reviews.length ? (
        <div className="space-y-2">
          {reviews.map((r) => (
            <div key={r.id} className="rounded-xl border bg-muted/20 p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <ReviewBadge status={r.status} />
                <span className="text-xs text-muted-foreground">{formatTime(r.createdAt)}</span>
              </div>
              <div className="mt-1.5 text-xs text-muted-foreground">
                审核人：{r.reviewer?.displayName || r.reviewer?.email || '系统'}
              </div>
              {r.reason ? (
                <p className="mt-1 break-all text-foreground">{r.reason}</p>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">暂无审核记录</p>
      )}
    </div>
  );
}

// files 字段后端为 Json：可能是数组（标准结构）或对象。归一为 { path, size } 数组供列表渲染。
function normalizeFiles(files: Plugin['files']): PluginFileEntry[] {
  if (Array.isArray(files)) return files as PluginFileEntry[];
  if (files && typeof files === 'object' && 'entries' in (files as Record<string, unknown>)) {
    const entries = (files as { entries?: unknown }).entries;
    if (Array.isArray(entries)) return entries as PluginFileEntry[];
  }
  return [];
}

// capabilities 后端为 Json：可能是 string[] 或 { name: string }[]。归一为字符串数组。
function normalizeCapabilities(caps: Plugin['capabilities']): string[] {
  if (Array.isArray(caps)) {
    return caps
      .map((c) => {
        if (typeof c === 'string') return c;
        if (c && typeof c === 'object' && 'name' in c && typeof (c as { name?: unknown }).name === 'string') {
          return (c as { name: string }).name;
        }
        return null;
      })
      .filter((c): c is string => !!c);
  }
  return [];
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
