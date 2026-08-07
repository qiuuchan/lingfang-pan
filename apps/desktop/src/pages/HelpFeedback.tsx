// HelpFeedback.tsx — 帮助与反馈工单中心（前台）。
//
// 三态单组件：列表（本人工单）/ 提交新工单 / 工单详情（对话时间线 + 追加回复）。
// 作为 PanelDialog 内容挂载（App.tsx），入口在 AvatarMenu「帮助与反馈」。
// 附件上传走 multipart，下载经鉴权 fetch+blob（见 lib/tickets）。
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  PlusIcon,
  ArrowLeftIcon,
  PaperclipIcon,
  SendIcon,
  DownloadIcon,
  ImageIcon,
  FileTextIcon,
  FileIcon,
  LifeBuoyIcon,
  XIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  submitTicket,
  listMyTickets,
  getMyTicket,
  replyTicket,
  downloadAttachment,
  formatBytes,
  CATEGORY_LABEL,
  STATUS_LABEL,
  type TicketSummary,
  type TicketDetail,
  type TicketCategory,
  type TicketStatus,
  type TicketAttachment,
} from '@/lib/tickets';

const STATUS_VARIANT: Record<TicketStatus, 'default' | 'secondary' | 'outline'> = {
  OPEN: 'default',
  IN_PROGRESS: 'default',
  RESOLVED: 'secondary',
  CLOSED: 'outline',
};

function fmtTime(iso: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  return d.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
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

/** 附件选择器（受控 File[]，最多 5 个，单文件 10MB）。 */
function FilePicker({ files, onChange }: { files: File[]; onChange: (next: File[]) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const incoming = Array.from(list);
    const merged = [...files, ...incoming].slice(0, 5);
    const tooBig = incoming.find((f) => f.size > 10 * 1024 * 1024);
    if (tooBig) toast.error(`「${tooBig.name}」超过 10MB，已忽略`);
    onChange(merged.filter((f) => f.size <= 10 * 1024 * 1024));
  };
  return (
    <div className="flex flex-col gap-2">
      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".log,.txt,.json,.csv,.yaml,.yml,image/*"
        className="hidden"
        onChange={(e) => {
          addFiles(e.target.files);
          e.target.value = '';
        }}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() => inputRef.current?.click()}
      >
        <PaperclipIcon className="size-4" />
        添加附件（日志/图片，≤5 个）
      </Button>
      {files.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {files.map((f, i) => (
            <span
              key={`${f.name}-${i}`}
              className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 text-xs"
            >
              <span className="max-w-40 truncate">{f.name}</span>
              <span className="text-muted-foreground">{formatBytes(f.size)}</span>
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

type Screen = { mode: 'list' } | { mode: 'submit' } | { mode: 'detail'; id: string };

export function HelpFeedback() {
  const [screen, setScreen] = useState<Screen>({ mode: 'list' });

  if (screen.mode === 'submit')
    return (
      <SubmitView
        onDone={(id) => setScreen({ mode: 'detail', id })}
        onBack={() => setScreen({ mode: 'list' })}
      />
    );
  if (screen.mode === 'detail')
    return <DetailView id={screen.id} onBack={() => setScreen({ mode: 'list' })} />;
  return (
    <ListView
      onNew={() => setScreen({ mode: 'submit' })}
      onOpen={(id) => setScreen({ mode: 'detail', id })}
    />
  );
}

function ListView({ onNew, onOpen }: { onNew: () => void; onOpen: (id: string) => void }) {
  const [tickets, setTickets] = useState<TicketSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { tickets } = await listMyTickets();
      setTickets(tickets);
    } catch {
      toast.error('加载工单列表失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          提交问题、建议或账号相关工单，我们会尽快处理并回复。
        </p>
        <Button size="sm" onClick={onNew}>
          <PlusIcon className="size-4" />
          新建工单
        </Button>
      </div>

      {loading ? (
        <p className="py-12 text-center text-sm text-muted-foreground">加载中…</p>
      ) : tickets.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-12 text-center">
          <LifeBuoyIcon className="size-10 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">还没有提交过工单</p>
          <Button size="sm" variant="outline" onClick={onNew}>
            <PlusIcon className="size-4" />
            提交第一个工单
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {tickets.map((t) => (
            <button
              key={t.id}
              onClick={() => onOpen(t.id)}
              className="flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left hover:bg-muted/50"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{t.title}</span>
                  <Badge variant="outline" className="shrink-0 text-xs">
                    {CATEGORY_LABEL[t.category]}
                  </Badge>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {t.messageCount} 条对话 · 最近更新 {fmtTime(t.lastReplyAt)}
                </p>
              </div>
              <Badge variant={STATUS_VARIANT[t.status]} className="shrink-0">
                {STATUS_LABEL[t.status]}
              </Badge>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SubmitView({ onDone, onBack }: { onDone: (id: string) => void; onBack: () => void }) {
  const [category, setCategory] = useState<TicketCategory>('BUG');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!title.trim()) return toast.error('请填写标题');
    if (!body.trim()) return toast.error('请填写问题描述');
    setSubmitting(true);
    try {
      const { ticket } = await submitTicket({
        title: title.trim(),
        body: body.trim(),
        category,
        files,
      });
      toast.success('工单已提交');
      onDone(ticket.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '提交失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2 self-start">
        <ArrowLeftIcon className="size-4" />
        返回列表
      </Button>

      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="ticket-category">分类</FieldLabel>
          <Select value={category} onValueChange={(v) => setCategory(v as TicketCategory)}>
            <SelectTrigger id="ticket-category">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(CATEGORY_LABEL) as TicketCategory[]).map((c) => (
                <SelectItem key={c} value={c}>
                  {CATEGORY_LABEL[c]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field>
          <FieldLabel htmlFor="ticket-title">标题</FieldLabel>
          <Input
            id="ticket-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="简要描述你遇到的问题"
            maxLength={200}
          />
        </Field>

        <Field>
          <FieldLabel htmlFor="ticket-body">详细描述</FieldLabel>
          <Textarea
            id="ticket-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="请描述问题的复现步骤、预期与实际表现。可附上日志或截图帮助我们更快定位。"
            rows={6}
            maxLength={10000}
          />
        </Field>

        <Field>
          <FieldLabel>附件</FieldLabel>
          <FilePicker files={files} onChange={setFiles} />
        </Field>
      </FieldGroup>

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onBack} disabled={submitting}>
          取消
        </Button>
        <Button onClick={submit} disabled={submitting}>
          <SendIcon className="size-4" />
          {submitting ? '提交中…' : '提交工单'}
        </Button>
      </div>
    </div>
  );
}

function DetailView({ id, onBack }: { id: string; onBack: () => void }) {
  const [ticket, setTicket] = useState<TicketDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [replyBody, setReplyBody] = useState('');
  const [replyFiles, setReplyFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    try {
      const { ticket } = await getMyTicket(id);
      setTicket(ticket);
    } catch {
      toast.error('加载工单详情失败');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const send = async () => {
    if (!replyBody.trim() && replyFiles.length === 0) return toast.error('请填写内容或添加附件');
    setSending(true);
    try {
      const { ticket } = await replyTicket(id, { body: replyBody.trim(), files: replyFiles });
      setTicket(ticket);
      setReplyBody('');
      setReplyFiles([]);
      toast.success('回复已发送');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '发送失败');
    } finally {
      setSending(false);
    }
  };

  if (loading) return <p className="py-12 text-center text-sm text-muted-foreground">加载中…</p>;
  if (!ticket) return <p className="py-12 text-center text-sm text-muted-foreground">工单不存在</p>;

  const closed = ticket.status === 'CLOSED';

  return (
    <div className="flex flex-col gap-4">
      <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2 self-start">
        <ArrowLeftIcon className="size-4" />
        返回列表
      </Button>

      <div className="flex items-start justify-between gap-3 border-b pb-3">
        <div className="min-w-0">
          <h3 className="truncate font-semibold">{ticket.title}</h3>
          <div className="mt-1 flex items-center gap-2">
            <Badge variant="outline" className="text-xs">
              {CATEGORY_LABEL[ticket.category]}
            </Badge>
            <Badge variant={STATUS_VARIANT[ticket.status]}>{STATUS_LABEL[ticket.status]}</Badge>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        {ticket.messages.map((m) => (
          <div
            key={m.id}
            className={`flex ${m.authorRole === 'USER' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[80%] rounded-lg px-3 py-2 ${
                m.authorRole === 'USER'
                  ? 'bg-primary text-primary-foreground'
                  : 'border bg-muted/40'
              }`}
            >
              <div className="mb-1 flex items-center gap-2 text-xs opacity-70">
                <span>{m.authorRole === 'USER' ? '我' : '客服'}</span>
                <span>{fmtTime(m.createdAt)}</span>
              </div>
              {m.body && <p className="whitespace-pre-wrap text-sm">{m.body}</p>}
              {m.attachments.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {m.attachments.map((a) => (
                    <AttachmentChip key={a.id} ticketId={ticket.id} attachment={a} />
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {closed ? (
        <p className="rounded-md border bg-muted/30 px-3 py-2 text-center text-xs text-muted-foreground">
          工单已关闭。如需继续，请新建工单。
        </p>
      ) : (
        <div className="flex flex-col gap-2 border-t pt-3">
          <Textarea
            value={replyBody}
            onChange={(e) => setReplyBody(e.target.value)}
            placeholder="追加说明或补充信息…"
            rows={3}
            maxLength={10000}
          />
          <FilePicker files={replyFiles} onChange={setReplyFiles} />
          <div className="flex justify-end">
            <Button onClick={send} disabled={sending}>
              <SendIcon className="size-4" />
              {sending ? '发送中…' : '发送回复'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
