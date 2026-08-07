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
import { useEffect, useRef, useState } from 'react';
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
import { api } from '@/lib/api';
import { useGuardedAction } from '@/lib/helpers';
import { useAsyncResource } from '@/lib/async-resource';
import { Section } from '@/components/shared';
import { AsyncResource } from '@/components/ui/async-resource';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
  Table,
  TableBody,
  TableCell,
  TableCellAction,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
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
  return new Date(iso).toLocaleString('zh-CN', {
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function loadTicketDetail(id: string, signal: AbortSignal): Promise<TicketDetail> {
  const result = await api<{ ticket: TicketDetail }>(`/api/admin/tickets/${id}`, { signal });
  return result.ticket;
}

function AttachmentChip({
  ticketId,
  attachment,
}: {
  ticketId: string;
  attachment: TicketAttachment;
}) {
  const [busy, setBusy] = useState(false);
  const Icon =
    attachment.kind === 'IMAGE' ? ImageIcon : attachment.kind === 'LOG' ? FileTextIcon : FileIcon;
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

function FilePicker({
  files,
  onChange,
  disabled = false,
}: {
  files: File[];
  onChange: (next: File[]) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="space-y-2">
      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".log,.txt,.json,.csv,.yaml,.yml,image/*"
        disabled={disabled}
        className="hidden"
        onChange={(e) => {
          const incoming = Array.from(e.target.files ?? []);
          const tooBig = incoming.find((f) => f.size > 10 * 1024 * 1024);
          if (tooBig) toast.error(`「${tooBig.name}」超过 10MB，已忽略`);
          onChange([...files, ...incoming.filter((f) => f.size <= 10 * 1024 * 1024)].slice(0, 5));
          e.target.value = '';
        }}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        <PaperclipIcon className="size-4" />
        添加附件
      </Button>
      {files.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {files.map((f, i) => (
            <span
              key={`${f.name}-${i}`}
              className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 text-xs"
            >
              <span className="max-w-40 truncate">{f.name}</span>
              <button
                type="button"
                disabled={disabled}
                aria-label={`移除附件：${f.name}`}
                onClick={() => onChange(files.filter((_, j) => j !== i))}
              >
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
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [statusFilter, setStatusFilter] = useState<'ALL' | TicketStatus>('ALL');
  const [categoryFilter, setCategoryFilter] = useState<'ALL' | TicketCategory>('ALL');
  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');

  const ticketList = useAsyncResource(
    (signal) =>
      listAdminTickets(
        {
          status: statusFilter === 'ALL' ? undefined : statusFilter,
          category: categoryFilter === 'ALL' ? undefined : categoryFilter,
          q: appliedSearch || undefined,
          page,
          pageSize,
        },
        signal
      ),
    [statusFilter, categoryFilter, appliedSearch, page, pageSize],
    { isEmpty: (result) => result.items.length === 0 }
  );

  useEffect(() => {
    if (!ticketList.data || ticketList.data.page !== page || ticketList.data.pageSize !== pageSize)
      return;
    const totalPages = Math.max(1, Math.ceil(ticketList.data.total / pageSize));
    if (page > totalPages) setPage(totalPages);
  }, [ticketList.data, page, pageSize]);

  const [active, setActive] = useState<TicketSummary | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const activeId = active?.id ?? '';
  const detail = useAsyncResource((signal) => loadTicketDetail(activeId, signal), [activeId], {
    enabled: detailOpen && Boolean(activeId),
  });
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  const openDetail = (ticket: TicketSummary) => {
    setActive(ticket);
    setDetailOpen(true);
  };

  const applyTicketMutation = (ticket: TicketDetail) => {
    if (activeIdRef.current === ticket.id) detail.setData(ticket);
    ticketList.reload();
  };

  return (
    <Section
      title="帮助与反馈"
      description="处理用户提交的问题、建议与账号工单，可回复并变更状态。"
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Select
          value={statusFilter}
          onValueChange={(v) => {
            setStatusFilter(v as typeof statusFilter);
            setPage(1);
          }}
        >
          <SelectTrigger className="h-9 w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_FILTERS.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={categoryFilter}
          onValueChange={(v) => {
            setCategoryFilter(v as typeof categoryFilter);
            setPage(1);
          }}
        >
          <SelectTrigger className="h-9 w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CATEGORY_FILTERS.map((c) => (
              <SelectItem key={c.value} value={c.value}>
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-1">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                setAppliedSearch(search.trim());
                setPage(1);
              }
            }}
            placeholder="搜索标题…"
            className="h-9 w-48"
          />
          <Button
            variant="outline"
            size="icon"
            className="size-9"
            aria-label="搜索工单"
            onClick={() => {
              setAppliedSearch(search.trim());
              setPage(1);
            }}
          >
            <SearchIcon className="size-4" />
          </Button>
        </div>
      </div>

      <AsyncResource
        status={ticketList.status}
        error={ticketList.error}
        retry={ticketList.reload}
        emptyFallback={
          <div className="flex min-h-40 flex-col items-center justify-center gap-2 border-y py-8 text-sm text-muted-foreground">
            <LifeBuoyIcon className="size-7 opacity-50" />
            暂无工单
          </div>
        }
      >
        {ticketList.data && (
          <>
            <div className="overflow-x-auto rounded-lg border">
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
                  {ticketList.data.items.map((ticket) => (
                    <TableRow key={ticket.id}>
                      <TableCell className="max-w-64">
                        <TableCellAction
                          aria-label={`查看工单详情：${ticket.title}`}
                          aria-expanded={detailOpen && active?.id === ticket.id}
                          aria-haspopup="dialog"
                          className="max-w-64 truncate align-middle"
                          onClick={() => openDetail(ticket)}
                        >
                          {ticket.title}
                        </TableCellAction>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs">
                          {CATEGORY_LABEL[ticket.category]}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm">
                        {ticket.submitter?.displayName ?? '-'}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {ticket.team?.name ?? '-'}
                      </TableCell>
                      <TableCell className="text-sm">{PRIORITY_LABEL[ticket.priority]}</TableCell>
                      <TableCell>
                        <Badge variant={STATUS_VARIANT[ticket.status]}>
                          {STATUS_LABEL[ticket.status]}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {fmtTime(ticket.lastReplyAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <Pagination
              totalItems={ticketList.data.total}
              pageSize={pageSize}
              currentPage={page}
              onPageChange={setPage}
              onPageSizeChange={setPageSize}
            />
          </>
        )}
      </AsyncResource>

      <TicketDetailSheet
        key={active?.id ?? 'ticket-detail'}
        open={detailOpen && Boolean(active)}
        onOpenChange={setDetailOpen}
        summary={active}
        resource={detail}
        onChanged={applyTicketMutation}
      />
    </Section>
  );
}

function TicketDetailSheet({
  open,
  onOpenChange,
  summary,
  resource,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  summary: TicketSummary | null;
  resource: ReturnType<typeof useAsyncResource<TicketDetail>>;
  onChanged: (ticket: TicketDetail) => void;
}) {
  const [replyBody, setReplyBody] = useState('');
  const [replyFiles, setReplyFiles] = useState<File[]>([]);
  const [mutating, guardMutation] = useGuardedAction();
  const ticket = resource.data?.id === summary?.id ? resource.data : null;
  const closed = ticket?.status === 'CLOSED';

  useEffect(() => {
    if (open) return;
    setReplyBody('');
    setReplyFiles([]);
  }, [open]);

  const send = async () => {
    if (!ticket) return;
    if (!replyBody.trim() && replyFiles.length === 0) return toast.error('请填写内容或添加附件');
    await guardMutation(async () => {
      try {
        const result = await replyAdminTicket(ticket.id, {
          body: replyBody.trim(),
          files: replyFiles,
        });
        onChanged(result.ticket);
        setReplyBody('');
        setReplyFiles([]);
        toast.success('回复已发送');
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '回复失败');
      }
    });
  };

  async function updateTicket(
    body: { status?: TicketStatus; priority?: TicketPriority },
    message: string
  ) {
    if (!ticket) return;
    await guardMutation(async () => {
      try {
        const result = await updateAdminTicket(ticket.id, body);
        onChanged(result.ticket);
        toast.success(message);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '更新失败');
      }
    });
  }

  return (
    <DetailSheet
      open={open}
      onOpenChange={onOpenChange}
      title={summary?.title ?? '工单详情'}
      description={
        summary
          ? `${CATEGORY_LABEL[summary.category]} · ${summary.submitter?.displayName ?? '未知用户'}${summary.team ? ` · ${summary.team.name}` : ''}`
          : undefined
      }
    >
      <AsyncResource status={resource.status} error={resource.error} retry={resource.reload}>
        {ticket && (
          <div className="space-y-5">
            <div className="flex flex-wrap gap-3">
              <div className="space-y-1">
                <label htmlFor="ticket-status" className="text-xs text-muted-foreground">
                  状态
                </label>
                <Select
                  value={ticket.status}
                  onValueChange={(value) => {
                    void updateTicket({ status: value as TicketStatus }, '状态已更新');
                  }}
                  disabled={closed || mutating}
                >
                  <SelectTrigger id="ticket-status" className="h-8 w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] as TicketStatus[]).map(
                      (status) => (
                        <SelectItem key={status} value={status}>
                          {STATUS_LABEL[status]}
                        </SelectItem>
                      )
                    )}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <label htmlFor="ticket-priority" className="text-xs text-muted-foreground">
                  优先级
                </label>
                <Select
                  value={ticket.priority}
                  onValueChange={(value) => {
                    void updateTicket({ priority: value as TicketPriority }, '优先级已更新');
                  }}
                  disabled={mutating}
                >
                  <SelectTrigger id="ticket-priority" className="h-8 w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(['LOW', 'NORMAL', 'HIGH'] as TicketPriority[]).map((priority) => (
                      <SelectItem key={priority} value={priority}>
                        {PRIORITY_LABEL[priority]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-3">
              {ticket.messages.map((message) => (
                <div
                  key={message.id}
                  className={`flex ${message.authorRole === 'ADMIN' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[85%] rounded-lg px-3 py-2 ${message.authorRole === 'ADMIN' ? 'bg-primary text-primary-foreground' : 'border bg-muted/40'}`}
                  >
                    <div className="mb-1 flex items-center gap-2 text-xs opacity-70">
                      <span>{message.authorRole === 'ADMIN' ? '客服' : '用户'}</span>
                      <span>{fmtTime(message.createdAt)}</span>
                    </div>
                    {message.body && (
                      <p className="whitespace-pre-wrap break-words text-sm">{message.body}</p>
                    )}
                    {message.attachments.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {message.attachments.map((attachment) => (
                          <AttachmentChip
                            key={attachment.id}
                            ticketId={ticket.id}
                            attachment={attachment}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {closed ? (
              <p className="rounded-md border bg-muted/30 px-3 py-2 text-center text-xs text-muted-foreground">
                工单已关闭，无法继续回复。
              </p>
            ) : (
              <div className="space-y-2 border-t pt-3">
                <Textarea
                  aria-label="回复内容"
                  disabled={mutating}
                  value={replyBody}
                  onChange={(e) => setReplyBody(e.target.value)}
                  placeholder="输入回复…"
                  rows={3}
                  maxLength={10000}
                />
                <FilePicker files={replyFiles} onChange={setReplyFiles} disabled={mutating} />
                <div className="flex justify-end">
                  <Button
                    onClick={() => {
                      void send();
                    }}
                    disabled={mutating}
                  >
                    <SendIcon className="size-4" />
                    {mutating ? '处理中…' : '发送回复'}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </AsyncResource>
    </DetailSheet>
  );
}
