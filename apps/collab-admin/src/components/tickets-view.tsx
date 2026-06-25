// tickets-view.tsx — 平台 Admin 帮助与反馈工单管理页。
//
// 职责：
// - 工单列表（筛选 status/category/q + 服务端分页），显示提交人、团队、状态、优先级、最近更新。
// - 详情 DetailSheet：对话时间线 + 附件下载 + 管理员回复（带附件）+ 改状态/优先级。
//
// 后端契约（apps/collab-api/src/modules/ticket.controller.ts AdminTicketController）：
// - GET    /api/admin/tickets（listAdmin，筛选 + 分页）          权限 platform.ticket.view
// - GET    /api/admin/tickets/:id（详情）                         权限 platform.ticket.view
// - POST   /api/admin/tickets/:id/messages（multipart 回复）       权限 platform.ticket.manage
// - PATCH  /api/admin/tickets/:id（改 status/priority）            权限 platform.ticket.manage
// - GET    /api/admin/tickets/:id/attachments/:aid（鉴权下载）     权限 platform.ticket.view
//
// UI 模式参考 releases-view：Section + 筛选 + Table + Pagination + DetailSheet。
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  LifeBuoyIcon,
  SendIcon,
  PaperclipIcon,
  DownloadIcon,
  ImageIcon,
  FileTextIcon,
  FileIcon,
  XIcon,
  SearchIcon,
} from 'lucide-react';
import {
  listAdminTickets,
  getAdminTicket,
  replyAdminTicket,
  updateAdminTicket,
  downloadAttachment,
  formatBytes,
  CATEGORY_LABEL,
  STATUS_LABEL,
  PRIORITY_LABEL,
  type TicketSummary,
  type TicketDetail,
  type TicketStatus,
  type TicketCategory,
  type TicketPriority,
  type TicketAttachment,
} from '@/lib/tickets';
import { run } from '@/lib/helpers';
import { Section } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Pagination } from '@/components/ui/pagination';
import { DetailSheet } from '@/components/ui/detail-sheet';

const STATUS_FILTERS: { value: 'ALL' | TicketStatus; label: string }[] = [
  { value: 'ALL', label: '全部状态' },
  { value: 'OPEN', label: '待处理' },
  { value: 'IN_PROGRESS', label: '处理中' },
  { value: 'RESOLVED', label: '已解决' },
  { value: 'CLOSED', label: '已关闭' },
];

const CATEGORY_FILTERS: { value: 'ALL' | TicketCategory; label: string }[] = [
  { value: 'ALL', label: '全部分类' },
  { value: 'BUG', label: '问题反馈' },
  { value: 'FEATURE', label: '功能建议' },
  { value: 'ACCOUNT', label: '账号相关' },
  { value: 'OTHER', label: '其他' },
];

const STATUS_VARIANT: Record<TicketStatus, 'default' | 'secondary' | 'outline'> = {
  OPEN: 'default',
  IN_PROGRESS: 'default',
  RESOLVED: 'secondary',
  CLOSED: 'outline',
};

function fmtTime(iso: string | null): string {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('zh-CN', { year: '2-digit', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function AttachmentChip({ ticketId, attachment }: { ticketId: string; attachment: TicketAttachment }) {
  const [busy, setBusy] = useState(false);
  const Icon = attachment.kind === 'IMAGE' ? ImageIcon : attachment.kind === 'LOG' ? FileTextIcon : FileIcon;
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await downloadAttachment(ticketId, attachment);
        } catch {
          toast.error('附件下载失败');
        } finally {
          setBusy(false);
        }
      }}
      className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 text-xs hover:bg-muted"
    >
      <Icon className="size-3.5" />
      <span className="max-w-40 truncate">{attachment.filename}</span>
      <span className="text-muted-foreground">{formatBytes(attachment.sizeBytes)}</span>
      <DownloadIcon className="size-3 text-muted-foreground" />
    </button>
  );
}

function FilePicker({ files, onChange }: { files: File[]; onChange: (next: File[]) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="space-y-2">
      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".log,.txt,.json,.csv,.yaml,.yml,image/*"
        className="hidden"
        onChange={(e) => {
          const incoming = Array.from(e.target.files ?? []);
          const tooBig = incoming.find((f) => f.size > 10 * 1024 * 1024);
          if (tooBig) toast.error(`「${tooBig.name}」超过 10MB，已忽略`);
          onChange([...files, ...incoming.filter((f) => f.size <= 10 * 1024 * 1024)].slice(0, 5));
          e.target.value = '';
        }}
      />
      <Button type="button" variant="outline" size="sm" onClick={() => inputRef.current?.click()}>
        <PaperclipIcon className="size-4" />
        添加附件
      </Button>
      {files.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {files.map((f, i) => (
            <span key={`${f.name}-${i}`} className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 text-xs">
              <span className="max-w-40 truncate">{f.name}</span>
              <button type="button" onClick={() => onChange(files.filter((_, j) => j !== i))}>
                <XIcon className="size-3 text-muted-foreground hover:text-foreground" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function TicketsView() {
  const [tickets, setTickets] = useState<TicketSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [statusFilter, setStatusFilter] = useState<'ALL' | TicketStatus>('ALL');
  const [categoryFilter, setCategoryFilter] = useState<'ALL' | TicketCategory>('ALL');
  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [loading, setLoading] = useState(true);

  const [detail, setDetail] = useState<TicketDetail | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listAdminTickets({
        status: statusFilter === 'ALL' ? undefined : statusFilter,
        category: categoryFilter === 'ALL' ? undefined : categoryFilter,
        q: appliedSearch || undefined,
        page,
        pageSize,
      });
      setTickets(result.tickets);
      setTotal(result.total);
    } catch (e) {
      if ((e as { status?: number }).status !== 401) toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, categoryFilter, appliedSearch, page, pageSize]);

  useEffect(() => {
    void load();
  }, [load]);

  const openDetail = async (id: string) => {
    try {
      const { ticket } = await getAdminTicket(id);
      setDetail(ticket);
      setDetailOpen(true);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const refreshDetail = async (id: string) => {
    const { ticket } = await getAdminTicket(id);
    setDetail(ticket);
    void load();
  };

  return (
    <Section title="帮助与反馈" description="处理用户提交的问题、建议与账号工单，可回复并变更状态。">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v as typeof statusFilter); setPage(1); }}>
          <SelectTrigger className="h-9 w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            {STATUS_FILTERS.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={categoryFilter} onValueChange={(v) => { setCategoryFilter(v as typeof categoryFilter); setPage(1); }}>
          <SelectTrigger className="h-9 w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            {CATEGORY_FILTERS.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-1">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { setAppliedSearch(search.trim()); setPage(1); } }}
            placeholder="搜索标题…"
            className="h-9 w-48"
          />
          <Button variant="outline" size="icon" className="size-9" onClick={() => { setAppliedSearch(search.trim()); setPage(1); }}>
            <SearchIcon className="size-4" />
          </Button>
        </div>
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>标题</TableHead>
              <TableHead>分类</TableHead>
              <TableHead>提交人</TableHead>
              <TableHead>团队</TableHead>
              <TableHead>优先级</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>最近更新</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow><TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">加载中…</TableCell></TableRow>
            ) : tickets.length === 0 ? (
              <TableRow><TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                <LifeBuoyIcon className="mx-auto mb-2 size-8 text-muted-foreground/50" />暂无工单
              </TableCell></TableRow>
            ) : (
              tickets.map((t) => (
                <TableRow key={t.id} className="cursor-pointer" onClick={() => openDetail(t.id)}>
                  <TableCell className="max-w-64 truncate font-medium">{t.title}</TableCell>
                  <TableCell><Badge variant="outline" className="text-xs">{CATEGORY_LABEL[t.category]}</Badge></TableCell>
                  <TableCell className="text-sm">{t.submitter?.displayName ?? '-'}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{t.team?.name ?? '-'}</TableCell>
                  <TableCell className="text-sm">{PRIORITY_LABEL[t.priority]}</TableCell>
                  <TableCell><Badge variant={STATUS_VARIANT[t.status]}>{STATUS_LABEL[t.status]}</Badge></TableCell>
                  <TableCell className="text-xs text-muted-foreground">{fmtTime(t.lastReplyAt)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Pagination
        totalItems={total}
        pageSize={pageSize}
        currentPage={page}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
      />

      {detail && (
        <TicketDetailSheet
          open={detailOpen}
          onOpenChange={setDetailOpen}
          ticket={detail}
          onChanged={() => refreshDetail(detail.id)}
        />
      )}
    </Section>
  );
}

function TicketDetailSheet({
  open,
  onOpenChange,
  ticket,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ticket: TicketDetail;
  onChanged: () => void | Promise<void>;
}) {
  const [replyBody, setReplyBody] = useState('');
  const [replyFiles, setReplyFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const closed = ticket.status === 'CLOSED';

  const send = async () => {
    if (!replyBody.trim() && replyFiles.length === 0) return toast.error('请填写内容或添加附件');
    setSending(true);
    const ok = await run(async () => {
      await replyAdminTicket(ticket.id, { body: replyBody.trim(), files: replyFiles });
    }, '回复已发送');
    setSending(false);
    if (ok) {
      setReplyBody('');
      setReplyFiles([]);
      await onChanged();
    }
  };

  const changeStatus = async (status: TicketStatus) => {
    if (await run(() => updateAdminTicket(ticket.id, { status }), '状态已更新')) await onChanged();
  };
  const changePriority = async (priority: TicketPriority) => {
    if (await run(() => updateAdminTicket(ticket.id, { priority }), '优先级已更新')) await onChanged();
  };

  return (
    <DetailSheet
      open={open}
      onOpenChange={onOpenChange}
      title={ticket.title}
      description={`${CATEGORY_LABEL[ticket.category]} · ${ticket.submitter?.displayName ?? '未知用户'}${ticket.team ? ` · ${ticket.team.name}` : ''}`}
    >
      <div className="flex flex-wrap gap-3">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">状态</label>
          <Select value={ticket.status} onValueChange={(v) => changeStatus(v as TicketStatus)} disabled={closed}>
            <SelectTrigger className="h-8 w-32"><SelectValue /></SelectTrigger>
            <SelectContent>
              {(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] as TicketStatus[]).map((s) => (
                <SelectItem key={s} value={s}>{STATUS_LABEL[s]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">优先级</label>
          <Select value={ticket.priority} onValueChange={(v) => changePriority(v as TicketPriority)}>
            <SelectTrigger className="h-8 w-28"><SelectValue /></SelectTrigger>
            <SelectContent>
              {(['LOW', 'NORMAL', 'HIGH'] as TicketPriority[]).map((p) => (
                <SelectItem key={p} value={p}>{PRIORITY_LABEL[p]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-3">
        {ticket.messages.map((m) => (
          <div key={m.id} className={`flex ${m.authorRole === 'ADMIN' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] rounded-lg px-3 py-2 ${m.authorRole === 'ADMIN' ? 'bg-primary text-primary-foreground' : 'border bg-muted/40'}`}>
              <div className="mb-1 flex items-center gap-2 text-xs opacity-70">
                <span>{m.authorRole === 'ADMIN' ? '客服' : '用户'}</span>
                <span>{fmtTime(m.createdAt)}</span>
              </div>
              {m.body && <p className="whitespace-pre-wrap text-sm">{m.body}</p>}
              {m.attachments.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {m.attachments.map((a) => <AttachmentChip key={a.id} ticketId={ticket.id} attachment={a} />)}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {closed ? (
        <p className="rounded-md border bg-muted/30 px-3 py-2 text-center text-xs text-muted-foreground">工单已关闭，无法继续回复。</p>
      ) : (
        <div className="space-y-2 border-t pt-3">
          <Textarea value={replyBody} onChange={(e) => setReplyBody(e.target.value)} placeholder="输入回复…" rows={3} maxLength={10000} />
          <FilePicker files={replyFiles} onChange={setReplyFiles} />
          <div className="flex justify-end">
            <Button onClick={send} disabled={sending}>
              <SendIcon className="size-4" />
              {sending ? '发送中…' : '发送回复'}
            </Button>
          </div>
        </div>
      )}
    </DetailSheet>
  );
}
